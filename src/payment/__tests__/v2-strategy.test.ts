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

  /**
   * Build a mock fetch for the post-payment-hang scenario. The merchant's
   * paid retry hangs until aborted; the unpaid probe returns a 402; EVM RPC
   * `eth_call`s are answered. `authorizationStateResult` controls what the
   * post-timeout `confirmSettlement` check sees: a non-zero word means the
   * EIP-3009 authorization was consumed (settled), `0x0` means it was not.
   */
  function makePostPaymentHangFetch(authorizationStateResult: string) {
    let paidRetrySeen = false;
    const fn = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers ?? undefined);
        const body = typeof init?.body === 'string' ? init.body : '';

        // The paid retry — carries the signed authorization. Hang until abort.
        if (headers.has('PAYMENT-SIGNATURE')) {
          paidRetrySeen = true;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          });
        }

        // EVM RPC eth_call — distinguish by the function selector in `data`.
        if (body.includes('eth_call')) {
          const selector = body.includes('0xe94a0102')
            ? 'authorizationState'
            : body.includes('0x70a08231')
              ? 'balanceOf'
              : 'other';
          if (selector === 'authorizationState') {
            // The post-timeout settlement check.
            return new Response(
              JSON.stringify({ jsonrpc: '2.0', id: 1, result: authorizationStateResult }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          // balanceOf — a healthy balance so the pre-payment check passes.
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000).toString(16) }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        // Otherwise: the unpaid probe → 402 challenge.
        return (await import('./fixtures')).makeV2Response();
      },
    );
    return { fn, seen: () => paidRetrySeen };
  }

  it('reports payment_unconfirmed when the merchant hangs and the chain shows NO settlement', async () => {
    // Post-payment hang + authorizationState returns 0x0 (nonce NOT consumed):
    // the payment did not settle, so the honest result is payment_unconfirmed.
    const mock = makePostPaymentHangFetch('0x' + '0'.repeat(64));
    vi.stubGlobal('fetch', mock.fn);

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
      { timeoutMs: 5000, responseTimeoutMs: 50 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('payment_unconfirmed');
      expect(result.detail).toMatch(/do not retry/i);
    }
    expect(mock.seen()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('upgrades to paid:true when the merchant hangs but the chain CONFIRMS settlement', async () => {
    // Post-payment hang + authorizationState returns a non-zero word (nonce
    // consumed): the payment settled on-chain. The result must be a confirmed
    // paid:true with no response body — never 'timeout', never a failure.
    const mock = makePostPaymentHangFetch('0x' + '0'.repeat(63) + '1');
    vi.stubGlobal('fetch', mock.fn);

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
      { timeoutMs: 5000, responseTimeoutMs: 50 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paid).toBe(true);
      if (result.paid) {
        // A confirmed-but-unanswered payment: no merchant response body.
        expect(result.response).toBeUndefined();
        expect(result.amountPaid).toBe('2000'); // the fixture's challenge amount
      }
    }
    expect(mock.seen()).toBe(true);
    vi.unstubAllGlobals();
  });
});
