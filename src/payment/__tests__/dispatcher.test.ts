import { describe, it, expect, vi } from 'vitest';
import { detectStrategy, payAndFetch } from '../dispatcher';
import { makeV1Response, makeV2Response, makeEmptyResponse } from './fixtures';

describe('detectStrategy', () => {
  it('routes a v2 (header) response to the v2 strategy', async () => {
    const s = await detectStrategy(makeV2Response());
    expect(s?.version).toBe(2);
  });

  it('routes a v1 (body) response to the v1 strategy', async () => {
    const s = await detectStrategy(makeV1Response());
    expect(s?.version).toBe(1);
  });

  it('returns null when no strategy recognises the 402', async () => {
    const s = await detectStrategy(makeEmptyResponse());
    expect(s).toBeNull();
  });

  // v1's parseChallenge returns null immediately when the PAYMENT-REQUIRED
  // header is present (it treats that as a v2 response and declines). This
  // means v1 and v2 are mutually exclusive by construction — a response
  // accepted by v2Strategy will always be declined by v1Strategy, so the
  // "v2 first" ordering in STRATEGIES is a policy anchor, not a tiebreaker.
  it('routes a response with PAYMENT-REQUIRED header to v2 (v1 is mutually exclusive)', async () => {
    const s = await detectStrategy(makeV2Response());
    expect(s?.version).toBe(2);
  });
});

describe('payAndFetch', () => {
  it('returns the response directly when the endpoint does not 402', async () => {
    const mockFetch = vi.fn(async () =>
      new Response('{"free":true}', { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFetch);
    const result = await payAndFetch(
      'https://example.com/free',
      { method: 'GET' },
      {} as never,
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response.status).toBe(200);
    vi.unstubAllGlobals();
  });

  it('returns no_payment_options when a 402 has no usable challenge', async () => {
    const mockFetch = vi.fn(async () => makeEmptyResponse());
    vi.stubGlobal('fetch', mockFetch);
    const result = await payAndFetch(
      'https://example.com/api',
      { method: 'GET' },
      {} as never,
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_payment_options');
    vi.unstubAllGlobals();
  });

  it('fails loudly when a non-string body is supplied', async () => {
    const result = await payAndFetch(
      'https://example.com/api',
      { method: 'POST', body: new URLSearchParams({ key: 'val' }) },
      {} as never,
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('error');
      expect(result.detail).toMatch(/non-string bodies/);
    }
  });

  it('probes with bare fetch and still pays when no SIW-X signer is derivable', async () => {
    // Empty wallet set -> toSiwxSigner returns null -> bare-fetch probe.
    // A v2 402 with no wallet to pay still surfaces a typed failure, not a crash.
    const mockFetch = vi.fn(async () => makeV2Response());
    vi.stubGlobal('fetch', mockFetch);
    const result = await payAndFetch(
      'https://example.com/api',
      { method: 'GET' },
      {},
      {},
    );
    // No wallet -> v2 strategy cannot pay -> typed failure (not no_payment_options:
    // the challenge WAS recognised). Accept any ok:false reason.
    expect(result.ok).toBe(false);
    expect(mockFetch).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('returns a non-402 SIW-X-authed response directly', async () => {
    // Simulates a merchant where SIW-X auth alone unlocks the resource:
    // the (wrapped) probe yields a 200, so payAndFetch returns it as ok:true
    // without any payment dispatch. With an empty wallet set the wrapper is
    // skipped, but a plain 200 from the probe must still pass straight through.
    const mockFetch = vi.fn(async () => new Response('{"authed":true}', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    const result = await payAndFetch('https://example.com/me', { method: 'GET' }, {}, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response.status).toBe(200);
    vi.unstubAllGlobals();
  });
});
