// src/payment/__tests__/v2-strategy.test.ts
import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { v2Strategy } from '../v2-strategy';
import { makeV2Response, makeV1Response } from './fixtures';

describe('v2Strategy.parseChallenge', () => {
  it('parses a v2 PAYMENT-REQUIRED header challenge', async () => {
    const c = await v2Strategy.parseChallenge(makeV2Response());
    expect(c).not.toBeNull();
    expect(c!.x402Version).toBe(2);
    expect(c!.options).toHaveLength(1);
    expect(c!.options[0].amount).toBe('2000');
    expect(c!.options[0].network.caip2).toBe('eip155:8453');
    expect(c!.options[0].network.bare).toBe('base');
  });

  it('returns null for a v1 (body-only) response — not its version', async () => {
    const c = await v2Strategy.parseChallenge(makeV1Response());
    expect(c).toBeNull();
  });

  it('exposes version 2', () => {
    expect(v2Strategy.version).toBe(2);
  });
});

describe('v2Strategy.pay', () => {
  it('returns a typed PayResult, never throws, on a paid call attempt', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn(async (_url: string | URL | Request) => {
      calls.push('call');
      if (calls.length === 1) {
        const { makeV2Response } = await import('./fixtures');
        return makeV2Response();
      }
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const { v2Strategy } = await import('../v2-strategy');
    const challenge = await v2Strategy.parseChallenge(
      (await import('./fixtures')).makeV2Response(),
    );
    const { createEvmKeypairWallet } = await import('../../client/evm-wallet');
    const wallets = {
      evm: await createEvmKeypairWallet(
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      ),
    } as never;

    const result = await v2Strategy.pay(
      'https://example.com/api',
      { method: 'GET' },
      challenge!,
      wallets,
      { maxAmountAtomic: '100000' },
    );

    // pay() must return a typed PayResult — never throw. The mock
    // merchant does not verify signatures, so the result may be ok:true
    // OR ok:false (merchant_rejected) — assert the SHAPE only.
    expect(result).toHaveProperty('ok');
    expect((result as { detail?: string }).detail).not.toBe('pay not yet implemented');
    vi.unstubAllGlobals();
  });

  it('reports timeout (not payment_unconfirmed) when the unpaid PROBE hangs', async () => {
    // Pre-payment phase: the probe never returns. No PAYMENT-SIGNATURE is
    // ever sent, so no money moves — the honest result is a plain timeout,
    // and the caller is free to retry.
    const mockFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        // Hang until the caller's abort signal fires, then reject as fetch does.
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const { v2Strategy } = await import('../v2-strategy');
    const challenge = await v2Strategy.parseChallenge(
      (await import('./fixtures')).makeV2Response(),
    );
    const { createEvmKeypairWallet } = await import('../../client/evm-wallet');
    const wallets = {
      evm: await createEvmKeypairWallet(
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      ),
    } as never;

    const result = await v2Strategy.pay(
      'https://example.com/api',
      { method: 'GET' },
      challenge!,
      wallets,
      { timeoutMs: 50, responseTimeoutMs: 5000 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timeout');
    vi.unstubAllGlobals();
  });

  it('reports payment_unconfirmed (not timeout) when the merchant hangs AFTER payment is sent', async () => {
    // Post-payment phase: the probe returns a 402, the SDK signs and sends
    // the PAYMENT-SIGNATURE header, then the merchant never responds. The
    // facilitator may have settled — the result must be payment_unconfirmed,
    // never 'timeout', so a consumer does not read it as "safe to retry".
    //
    // The mock distinguishes three fetch kinds: the unpaid probe (→ 402),
    // the EVM balance-check eth_call RPC (→ a healthy balance), and the
    // paid retry that carries PAYMENT-SIGNATURE (→ hang until aborted).
    let paidRetrySeen = false;
    const mockFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers ?? undefined);
        const body = typeof init?.body === 'string' ? init.body : '';

        // The paid retry — the request carrying the signed authorization.
        if (headers.has('PAYMENT-SIGNATURE')) {
          paidRetrySeen = true;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          });
        }

        // The EVM balance-check eth_call — answer with a healthy balance
        // (~$1 in 6-decimal USDC atomic units) so the pre-payment check passes.
        if (body.includes('eth_call')) {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000).toString(16) }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        // Otherwise: the unpaid probe → 402 challenge.
        return (await import('./fixtures')).makeV2Response();
      },
    );
    vi.stubGlobal('fetch', mockFetch);

    const { v2Strategy } = await import('../v2-strategy');
    const challenge = await v2Strategy.parseChallenge(
      (await import('./fixtures')).makeV2Response(),
    );
    const { createEvmKeypairWallet } = await import('../../client/evm-wallet');
    const wallets = {
      evm: await createEvmKeypairWallet(
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      ),
    } as never;

    const result = await v2Strategy.pay(
      'https://example.com/api',
      { method: 'GET' },
      challenge!,
      wallets,
      // Long pre-payment budget so build/sign + probe finish; short
      // post-payment budget so the hung retry aborts fast.
      { timeoutMs: 5000, responseTimeoutMs: 50 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('payment_unconfirmed');
      // The detail must steer a consumer AWAY from a blind retry.
      expect(result.detail).toMatch(/do not retry/i);
    }
    expect(paidRetrySeen).toBe(true); // the PAYMENT-SIGNATURE request was sent
    vi.unstubAllGlobals();
  });
});
