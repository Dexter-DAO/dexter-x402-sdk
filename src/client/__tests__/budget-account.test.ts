import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createBudgetAccount, type BudgetAccountConfig } from '../budget-account';
import type { ChainAdapter } from '../../adapters/types';
import type { PaymentAccept } from '../../types';

const { buildTransaction } = vi.hoisted(() => ({
  buildTransaction: vi.fn<ChainAdapter['buildTransaction']>(),
}));

// Keep the real wallet initialization and client payment flow. Only signing
// and balance RPC are replaced; the native Request/Response types are used.
vi.mock('../../adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('../../adapters')>();
  return {
    ...actual,
    createSolanaAdapter: (): ChainAdapter => ({
      name: 'Solana',
      networks: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
      canHandle: network => network.startsWith('solana:'),
      isConnected: () => true,
      getAddress: () => 'test-wallet',
      getDefaultRpcUrl: () => 'https://rpc.example',
      getBalance: async () => 100,
      buildTransaction,
    }),
  };
});

const network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const walletPrivateKey = Keypair.fromSeed(new Uint8Array(32).fill(7)).secretKey;
let merchant: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function challenge(amount: number | string, accessPass = false, decimals = 6): Response {
  const accept: PaymentAccept = {
    scheme: 'exact', network, amount: typeof amount === 'string' ? amount : String(Math.round(amount * 1e6)),
    asset: 'test-mint', payTo: 'test-recipient', maxTimeoutSeconds: 60,
    extra: { decimals, feePayer: 'test-fee-payer' },
  };
  return new Response(null, {
    status: 402,
    headers: {
      'PAYMENT-REQUIRED': btoa(JSON.stringify({ x402Version: 2, accepts: [accept] })),
      ...(accessPass ? {
        'X-ACCESS-PASS-TIERS': btoa(JSON.stringify({ tiers: [{ id: '1h', price: String(amount) }] })),
      } : {}),
    },
  });
}

function account(options: Partial<BudgetAccountConfig> = {}) {
  return createBudgetAccount({ walletPrivateKey, budget: { total: '1.00' }, ...options });
}

function servePayments(paid?: (request: Request) => Promise<Response>, accessPass = false) {
  merchant.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    if (request.headers.has('PAYMENT-SIGNATURE')) {
      return paid ? paid(request) : new Response('paid');
    }
    const amount = new URL(request.url).searchParams.get('amount');
    return amount === null ? new Response('free') : challenge(Number(amount), accessPass);
  });
}

beforeEach(() => {
  buildTransaction.mockReset();
  buildTransaction.mockResolvedValue({ serialized: 'test-signed-transaction' });
  merchant = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', merchant);
  servePayments();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('budget account concurrency', () => {
  it.each([
    { amount: 'not-an-integer', decimals: 6 },
    { amount: '-900000', decimals: 6 },
    { amount: '-Infinity', decimals: 6 },
    { amount: '0', decimals: -400 },
    { amount: '0', decimals: 400 },
    { amount: '1', decimals: 1.5 },
  ])('rejects invalid amounts before approval/reservation (%o)', async ({ amount, decimals }) => {
    const approval = deferred<boolean>();
    const onPaymentRequired = vi.fn((accept: PaymentAccept) => accept.amount === '600000' ? true : approval.promise);
    const agent = account({ budget: { total: '1', perHour: '1' }, onPaymentRequired });
    merchant.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.headers.has('PAYMENT-SIGNATURE')) return new Response('paid');
      return new URL(request.url).pathname === '/invalid' ? challenge(amount, false, decimals) : challenge(0.6);
    });
    const pending = agent.fetch('https://test.example/invalid');
    try {
      await expect(pending).rejects.toMatchObject({ code: 'invalid_payment_required' });
      expect(onPaymentRequired).not.toHaveBeenCalled();
      expect(buildTransaction).not.toHaveBeenCalled();
      expect(agent.payments).toBe(0);
      expect(agent.spentAmount).toBe(0);
      await agent.fetch('https://test.example/valid');
      await expect(agent.fetch('https://test.example/valid')).rejects.toMatchObject({ code: 'amount_exceeds_max' });
      expect(agent.spentAmount).toBe(0.6);
      expect(agent.payments).toBe(1);
    } finally {
      approval.resolve(false);
      await pending.catch(() => {});
    }
  });

  it('accepts a zero payment amount without corrupting later budget checks', async () => {
    const agent = account();
    await agent.fetch('https://test.example/data?amount=0');
    await agent.fetch('https://test.example/data?amount=0.6');
    await expect(agent.fetch('https://test.example/data?amount=0.6')).rejects.toMatchObject({ code: 'amount_exceeds_max' });
    expect(agent.spentAmount).toBe(0.6);
    expect(agent.payments).toBe(2);
  });

  it.each([
    { name: 'total', budget: { total: '1.00' } },
    { name: 'hourly', budget: { total: '10.00', perHour: '1.00' } },
  ])('reserves the $name budget before awaiting user approval', async ({ budget }) => {
    const inspecting = deferred<void>();
    const approval = deferred<boolean>();
    const agent = account({
      budget,
      onPaymentRequired: accept => {
        if (accept.amount === '600000') {
          inspecting.resolve();
          return approval.promise;
        }
        return true;
      },
    });
    const first = agent.fetch('https://first.example/data?amount=0.6');
    await inspecting.promise;
    try {
      expect(agent.reservedAmount).toBe(0.6);
      expect(agent.remainingAmount).toBe(Number(budget.total));
      expect(agent.remaining).toBe(`$${Number(budget.total).toFixed(2)}`);
      await expect(agent.fetch('https://second.example/data?amount=0.7'))
        .rejects.toMatchObject({ code: 'amount_exceeds_max' });
    } finally {
      approval.resolve(true);
      await first;
    }
    expect(buildTransaction).toHaveBeenCalledTimes(1);
    expect(agent.spentAmount).toBe(0.6);
    expect(agent.reservedAmount).toBe(0);
    expect(agent.payments).toBe(1);
  });

  it('records both concurrent payments against their own domains', async () => {
    const dispatched = deferred<void>();
    const finishFirst = deferred<Response>();
    servePayments(async request => {
      if (new URL(request.url).hostname === 'first.example') {
        dispatched.resolve();
        return finishFirst.promise;
      }
      return new Response('paid');
    });
    const agent = account();
    const first = agent.fetch('https://first.example/data?amount=0.2');
    await dispatched.promise;
    try {
      await agent.fetch('https://second.example/data?amount=0.7');
    } finally {
      finishFirst.resolve(new Response('paid'));
      await first;
    }
    expect(agent.spentAmount).toBeCloseTo(0.9);
    expect(agent.hourlySpend).toBeCloseTo(0.9);
    expect(agent.payments).toBe(2);
    expect(agent.ledger).toEqual([
      expect.objectContaining({ amount: 0.2, domain: 'first.example', network }),
      expect.objectContaining({ amount: 0.7, domain: 'second.example', network }),
    ]);
  });

  it('does not let a free request clear an in-flight payment', async () => {
    const dispatched = deferred<void>();
    const finishPaid = deferred<Response>();
    servePayments(async () => { dispatched.resolve(); return finishPaid.promise; });
    const agent = account();
    const paid = agent.fetch('https://paid.example/data?amount=0.6');
    await dispatched.promise;
    try {
      expect((await agent.fetch('https://free.example/data')).status).toBe(200);
    } finally {
      finishPaid.resolve(new Response('paid'));
      await paid;
    }
    expect(agent.payments).toBe(1);
    expect(agent.ledger[0]).toMatchObject({ amount: 0.6, domain: 'paid.example', network });
  });

  it.each(['reject', 'throw'] as const)('releases a reservation when user approval %ss', async outcome => {
    const agent = account({
      onPaymentRequired: accept => {
        if (accept.amount !== '600000') return true;
        if (outcome === 'throw') throw new Error('approval failed');
        return false;
      },
    });
    await expect(agent.fetch('https://example.com/data?amount=0.6')).rejects.toThrow();
    expect(agent.payments).toBe(0);
    await agent.fetch('https://example.com/data?amount=0.7');
    expect(agent.spentAmount).toBe(0.7);
    expect(buildTransaction).toHaveBeenCalledTimes(1);
  });

  it('releases a reservation when signing fails', async () => {
    buildTransaction.mockRejectedValueOnce(new Error('signing failed'));
    const agent = account();
    await expect(agent.fetch('https://example.com/data?amount=0.6')).rejects.toThrow('signing failed');
    await agent.fetch('https://example.com/data?amount=0.7');
    expect(agent.spentAmount).toBe(0.7);
    expect(agent.payments).toBe(1);
  });

  it('keeps a dispatched authorization counted when the paid response fails', async () => {
    servePayments(async () => { throw new Error('response lost'); });
    const agent = account();
    await expect(agent.fetch('https://example.com/data?amount=0.6')).rejects.toThrow('response lost');
    await expect(agent.fetch('https://example.com/data?amount=0.7'))
      .rejects.toMatchObject({ code: 'amount_exceeds_max' });
    expect(agent.spentAmount).toBe(0.6);
    expect(agent.payments).toBe(1);
  });

  it.each([false, true])('releases a cancelled approval without dispatch (access pass: %s)', async accessPass => {
    servePayments(undefined, accessPass);
    const inspecting = deferred<void>();
    const approval = deferred<boolean>();
    const controller = new AbortController();
    const agent = account({
      ...(accessPass ? { accessPass: { preferTier: '1h' } } : {}),
      onPaymentRequired: accept => {
        if (accept.amount !== '600000') return true;
        inspecting.resolve();
        return approval.promise;
      },
    });
    const pending = agent.fetch('https://example.com/data?amount=0.6', { signal: controller.signal });
    await inspecting.promise;
    controller.abort();
    approval.resolve(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(agent.spentAmount).toBe(0);
    expect(agent.payments).toBe(0);
    expect(merchant).toHaveBeenCalledTimes(1);
    expect(buildTransaction).not.toHaveBeenCalled();

    await agent.fetch('https://example.com/data?amount=0.7');
    expect(agent.spentAmount).toBe(0.7);
    expect(agent.payments).toBe(1);
  });

  it.each([false, true])('releases a cancelled signing without dispatch or fallback (access pass: %s)', async accessPass => {
    servePayments(undefined, accessPass);
    const signing = deferred<void>();
    const signed = deferred<Awaited<ReturnType<ChainAdapter['buildTransaction']>>>();
    buildTransaction.mockImplementationOnce(() => { signing.resolve(); return signed.promise; });
    const controller = new AbortController();
    const agent = account({ ...(accessPass ? { accessPass: { preferTier: '1h' } } : {}) });
    const pending = agent.fetch('https://example.com/data?amount=0.6', { signal: controller.signal });
    await signing.promise;
    controller.abort();
    signed.resolve({ serialized: 'test-signed-transaction' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(agent.spentAmount).toBe(0);
    expect(agent.payments).toBe(0);
    expect(merchant).toHaveBeenCalledTimes(1);
    expect(buildTransaction).toHaveBeenCalledTimes(1);

    await agent.fetch('https://example.com/data?amount=0.7');
    expect(agent.spentAmount).toBe(0.7);
    expect(agent.payments).toBe(1);
  });

  it('enforces the per-request limit without reserving or signing', async () => {
    const agent = account({ budget: { total: '1.00', perRequest: '0.50' } });
    await expect(agent.fetch('https://example.com/data?amount=0.6'))
      .rejects.toMatchObject({ code: 'amount_exceeds_max' });
    await agent.fetch('https://example.com/data?amount=0.4');
    expect(agent.spentAmount).toBe(0.4);
    expect(buildTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps in-flight reservations when spend history is reset', async () => {
    const inspecting = deferred<void>();
    const approval = deferred<boolean>();
    const agent = account({ onPaymentRequired: accept => {
      if (accept.amount !== '600000') return true;
      inspecting.resolve();
      return approval.promise;
    } });
    const first = agent.fetch('https://example.com/data?amount=0.6');
    await inspecting.promise;
    agent.reset();
    try {
      await expect(agent.fetch('https://example.com/data?amount=0.7'))
        .rejects.toMatchObject({ code: 'amount_exceeds_max' });
    } finally {
      approval.resolve(true);
      await first;
    }
    expect(agent.spentAmount).toBe(0.6);
  });

  it('allows another payment after the hourly window expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const agent = account({ budget: { total: '10.00', perHour: '1.00' } });
    await agent.fetch('https://example.com/data?amount=0.6');
    vi.setSystemTime(new Date('2026-01-01T01:00:01Z'));
    await agent.fetch('https://example.com/data?amount=0.7');
    expect(agent.spentAmount).toBeCloseTo(1.3);
    expect(agent.hourlySpend).toBe(0.7);
  });

  it('counts an access-pass purchase once and reuses its cached pass', async () => {
    const jwt = ['header', btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })), 'signature'].join('.');
    merchant.mockImplementation(async (input, init) => {
      const headers = new Request(input, init).headers;
      if (headers.has('Authorization')) return new Response('cached pass');
      if (headers.has('PAYMENT-SIGNATURE')) return new Response('purchased', { headers: { 'ACCESS-PASS': jwt } });
      return challenge(0.6, true);
    });
    const agent = account({ accessPass: { preferTier: '1h' } });
    await agent.fetch('https://example.com/data');
    await agent.fetch('https://example.com/data');
    expect(agent.spentAmount).toBe(0.6);
    expect(agent.payments).toBe(1);
    expect(buildTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(['reject', 'throw'] as const)('does not retry a pass approval that %ss', async outcome => {
    merchant.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.headers.has('PAYMENT-SIGNATURE')) return new Response('purchased');
      return challenge(Number(new URL(request.url).searchParams.get('amount')), true);
    });
    const approve = vi.fn((accept: PaymentAccept) => {
      if (accept.amount !== '600000') return true;
      if (outcome === 'throw') throw new Error('approval failed');
      return false;
    });
    const agent = account({ accessPass: { preferTier: '1h' }, onPaymentRequired: approve });
    await expect(agent.fetch('https://example.com/data?amount=0.6')).rejects.toThrow(
      outcome === 'throw' ? 'approval failed' : 'Payment rejected',
    );
    expect(approve).toHaveBeenCalledTimes(1);
    expect(buildTransaction).not.toHaveBeenCalled();
    await agent.fetch('https://example.com/data?amount=0.7');
    expect(agent.spentAmount).toBe(0.7);
    expect(agent.payments).toBe(1);
  });

  it('does not ask for pass approval again after a budget rejection', async () => {
    merchant.mockImplementation(async () => challenge(0.6, true));
    const approve = vi.fn(() => true);
    const agent = account({
      budget: { total: '1.00', perRequest: '0.50' },
      accessPass: { preferTier: '1h' }, onPaymentRequired: approve,
    });
    await expect(agent.fetch('https://example.com/data')).rejects.toMatchObject({ code: 'amount_exceeds_max' });
    expect(approve).not.toHaveBeenCalled();
    expect(merchant).toHaveBeenCalledTimes(1);
    expect(buildTransaction).not.toHaveBeenCalled();
    expect(agent.payments).toBe(0);
  });

  it('releases the unsigned pass reservation before falling back after a signing failure', async () => {
    merchant.mockImplementation(async (input, init) => {
      if (new Request(input, init).headers.has('PAYMENT-SIGNATURE')) return new Response('paid');
      return challenge(0.6, true);
    });
    buildTransaction.mockRejectedValueOnce(new Error('pass signing failed'));
    const agent = account({ accessPass: { preferTier: '1h' } });
    await agent.fetch('https://example.com/data');
    expect(buildTransaction).toHaveBeenCalledTimes(2);
    expect(agent.payments).toBe(1);
    expect(agent.spentAmount).toBe(0.6);
  });

  it('checks the budget again when a failed pass purchase falls back to payment', async () => {
    merchant.mockImplementation(async (input, init) => {
      if (new Request(input, init).headers.has('PAYMENT-SIGNATURE')) return new Response('unavailable', { status: 503 });
      return challenge(0.6, true);
    });
    const agent = account({ accessPass: { preferTier: '1h' } });
    await expect(agent.fetch('https://example.com/data')).rejects.toMatchObject({ code: 'amount_exceeds_max' });
    expect(agent.spentAmount).toBe(0.6);
    expect(buildTransaction).toHaveBeenCalledTimes(1);
  });
});
