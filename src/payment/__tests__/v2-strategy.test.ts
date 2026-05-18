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
});
