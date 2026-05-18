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
});
