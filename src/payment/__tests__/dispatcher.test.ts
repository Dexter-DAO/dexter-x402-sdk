import { describe, it, expect, vi } from 'vitest';
import { detectStrategy, payAndFetch } from '../dispatcher';
import { makeV1Response, makeV2Response, makeEmptyResponse } from './fixtures';
import { createEvmKeypairWallet } from '../../client/evm-wallet';

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

  it('falls back to bare fetch and warns when @x402/extensions fails to load', async () => {
    // Force the dynamic import of the SIW-X extension to throw, simulating
    // a broken/missing @x402/extensions install. buildProbeFetch must catch
    // it, warn loudly, and fall back to bare fetch so payment still works.
    vi.resetModules();
    vi.doMock('@x402/extensions/sign-in-with-x', () => {
      throw new Error('simulated broken extension');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    // Re-import so the fresh module graph sees the doMock.
    const { payAndFetch: freshPayAndFetch } = await import('../dispatcher');
    const { createEvmKeypairWallet } = await import('../../client/evm-wallet');
    const wallet = await createEvmKeypairWallet(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    );

    const result = await freshPayAndFetch(
      'https://example.com/data',
      { method: 'GET' },
      { evm: wallet },
      {},
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalled(); // bare-fetch fallback was used
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[x402] SIW-X unavailable'),
    );

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.doUnmock('@x402/extensions/sign-in-with-x');
    vi.resetModules();
  });

  it('probes through the real SIW-X wrapper when a signer is derivable (pass-through on a non-SIW-X 200)', async () => {
    // Coverage target: buildProbeFetch's non-null-signer branch.
    //
    // The previous tests all supply an EMPTY wallet set, so toSiwxSigner returns
    // null and the `await import('@x402/extensions/sign-in-with-x')` +
    // `wrapFetchWithSIWx(fetch, signer)` call inside buildProbeFetch is NEVER
    // reached. This test supplies a real EVM keypair wallet so toSiwxSigner
    // returns a non-null signer, forcing buildProbeFetch down the dynamic-import
    // branch. wrapFetchWithSIWx is intentionally NOT mocked — the whole point is
    // that the real dynamic import succeeds and the real wrapFetchWithSIWx runs.
    //
    // wrapFetchWithSIWx is a transparent pass-through for any response with
    // status !== 402. A plain 200 immediately returns the response unchanged
    // (see @x402/extensions/dist/cjs/sign-in-with-x/index.js, wrapFetchWithSIWx
    // implementation). So the stub returns a plain 200, the wrapped fetch
    // delegates straight to the stub, and payAndFetch returns ok:true.
    //
    // If the dynamic import were broken or wrapFetchWithSIWx threw on
    // construction, this test would fail — which is exactly the gap it closes.
    // The full SIW-X handshake (a 402 with the extension) is covered by the
    // live-merchant check in Task 13.
    const THROWAWAY_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const wallet = await createEvmKeypairWallet(THROWAWAY_PRIVATE_KEY);

    const mockFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await payAndFetch(
      'https://example.com/data',
      { method: 'GET' },
      { evm: wallet },
      {},
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
