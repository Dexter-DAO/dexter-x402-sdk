// src/payment/__tests__/v1-strategy.test.ts
import { describe, it, expect } from 'vitest';
import { v1Strategy } from '../v1-strategy';
import { makeV1Response, makeV2Response, makeEmptyResponse } from './fixtures';

describe('v1Strategy.parseChallenge', () => {
  it('parses a v1 body challenge', async () => {
    const c = await v1Strategy.parseChallenge(makeV1Response());
    expect(c).not.toBeNull();
    expect(c!.x402Version).toBe(1);
    expect(c!.options[0].amount).toBe('10000'); // from maxAmountRequired
    expect(c!.options[0].network.bare).toBe('base');
    expect(c!.options[0].network.caip2).toBe('eip155:8453');
  });

  it('returns null for a v2 response — handled by v2Strategy', async () => {
    // A v2 response has a PAYMENT-REQUIRED header; v1 should decline it
    // so the dispatcher picks v2 first regardless of body contents.
    const c = await v1Strategy.parseChallenge(makeV2Response());
    expect(c).toBeNull();
  });

  it('returns null for a 402 with no usable challenge', async () => {
    const c = await v1Strategy.parseChallenge(makeEmptyResponse());
    expect(c).toBeNull();
  });

  it('exposes version 1', () => {
    expect(v1Strategy.version).toBe(1);
  });
});

import { vi } from 'vitest';

describe('v1Strategy.pay', () => {
  it('preserves the merchant network in the signed payload', async () => {
    // The merchant advertised bare "base". The signed X-PAYMENT payload
    // sent on the retry must carry "base" — NOT a rewritten value.
    let sentPaymentHeader: string | null = null;
    const calls: number[] = [];
    const mockFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push(1);
      // pay() receives an already-parsed challenge, so the request it makes
      // carries an X-PAYMENT header — the paid retry. A request without one
      // is an un-paid probe and gets the 402 challenge back.
      const rawHeaders = init?.headers;
      const h =
        rawHeaders instanceof Headers
          ? Object.fromEntries(rawHeaders.entries())
          : ((rawHeaders ?? {}) as Record<string, string>);
      sentPaymentHeader = h['X-PAYMENT'] ?? h['x-payment'] ?? null;
      if (!sentPaymentHeader) {
        const { makeV1Response } = await import('./fixtures');
        return makeV1Response();
      }
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const { v1Strategy } = await import('../v1-strategy');
    const challenge = await v1Strategy.parseChallenge(
      (await import('./fixtures')).makeV1Response(),
    );
    // The fixture's v1 accepts entry has no `extra`. Inject a valid
    // EIP-712 domain so pay can sign — without this the new fail-safe
    // (merchant_rejected on a missing domain) would trip and the
    // network-preservation assertion below would never run.
    challenge!.options[0].extra = { name: 'USD Coin', version: '2' };
    const { createEvmKeypairWallet } = await import('../../client/evm-wallet');
    const wallets = {
      evm: createEvmKeypairWallet(
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      ),
    } as never;

    const result = await v1Strategy.pay(
      'https://example.com/api',
      { method: 'GET' },
      challenge!,
      wallets,
      { maxAmountAtomic: '100000' },
    );

    // pay() must return a typed result, never throw.
    expect(result).toHaveProperty('ok');
    // pay() must actually build and send a payment — the merchant retry
    // must have happened with an X-PAYMENT header.
    expect(result.ok).toBe(true);
    // pay() makes exactly one request — the paid retry.
    expect(calls.length).toBe(1);
    expect(sentPaymentHeader).not.toBeNull();
    // The decoded payload's network MUST be the merchant's advertised
    // bare name "base" — NOT a rewritten value.
    const decoded = JSON.parse(
      Buffer.from(sentPaymentHeader!, 'base64').toString('utf8'),
    );
    const net = String(decoded.network ?? decoded.payload?.network ?? '');
    expect(net).toBe('base');
    vi.unstubAllGlobals();
  });

  it('fails with merchant_rejected when the v1 challenge omits the EIP-712 domain', async () => {
    // A wrong EIP-712 domain (name/version) produces a cryptographically
    // unspendable signature. When the merchant omits extra.name /
    // extra.version pay must NOT guess the domain — it fails fast.
    const mockFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const { v1Strategy } = await import('../v1-strategy');
    const challenge = await v1Strategy.parseChallenge(
      (await import('./fixtures')).makeV1Response(),
    );
    // Leave `extra` undefined — the fixture provides no EIP-712 domain.
    const { createEvmKeypairWallet } = await import('../../client/evm-wallet');
    const wallets = {
      evm: createEvmKeypairWallet(
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      ),
    } as never;

    const result = await v1Strategy.pay(
      'https://example.com/api',
      { method: 'GET' },
      challenge!,
      wallets,
      { maxAmountAtomic: '100000' },
    );

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('merchant_rejected');
    expect((result as { detail?: string }).detail).toMatch(/EIP-712 domain/);
    // pay must never reach the merchant retry with a bad payload.
    expect(mockFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
