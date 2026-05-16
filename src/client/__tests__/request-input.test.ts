import { describe, it, expect } from 'vitest';
import { createX402Client } from '../x402-client';

/**
 * Regression test for the Request-reuse crash.
 *
 * The x402 flow issues the same request more than once (unpaid probe →
 * paid retry). When the caller passes a `Request` object — which happens
 * whenever another fetch wrapper, e.g. the SIWx extension, composes around
 * this client — the probe consumed its one-shot body stream and the retry
 * threw "Cannot construct a Request with a Request object that has already
 * been used." The client now normalizes `Request` input into a string +
 * buffered init up front, so the body survives every retry.
 *
 * These tests exercise the normalization without needing a funded wallet:
 * a non-402 response means the payment path is never entered, but the
 * request body still has to be read by `customFetch` exactly as a real
 * server would, and a `Request` passed in must not blow up.
 */
describe('x402 client — Request-object input', () => {
  it('accepts a POST Request with a body and forwards the body', async () => {
    let seenBody: string | null = null;
    let seenMethod: string | null = null;

    const customFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      // After normalization the client must hand customFetch a string URL
      // plus a plain init — never a Request — so the body is re-readable.
      expect(typeof input).toBe('string');
      seenMethod = (init?.method ?? 'GET').toUpperCase();
      // Reconstruct a Request the way a real composed fetch wrapper (or the
      // platform fetch itself) does. If the client had passed a consumed
      // Request through, this line is where the runtime throws
      // "Cannot construct a Request with a Request object that has already
      // been used." A string + buffered init reconstructs cleanly.
      const reconstructed = new Request(input, init);
      seenBody = await reconstructed.text();
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof globalThis.fetch;

    const client = createX402Client({
      wallets: {},
      fetch: customFetch,
    });

    const request = new Request('https://example.com/api/foo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'abc', limit: 100 }),
    });

    const res = await client.fetch(request);
    expect(res.status).toBe(200);
    expect(seenMethod).toBe('POST');
    expect(seenBody).toBe(JSON.stringify({ token: 'abc', limit: 100 }));
  });

  it('survives a 402 → retry without "already been used" on a POST Request body', async () => {
    let calls = 0;
    const bodies: string[] = [];

    // First call: 402 with a PAYMENT-REQUIRED header offering only a network
    // we have no wallet for. The client will fail to find a payment option
    // and throw no_matching_payment_option — but crucially it must reach that
    // point WITHOUT a Request-reuse crash, and must have read the body once.
    const customFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      const body = init?.body;
      if (body instanceof ArrayBuffer) bodies.push(new TextDecoder().decode(body));
      else if (typeof body === 'string') bodies.push(body);

      const paymentRequired = btoa(
        JSON.stringify({ x402Version: 2, accepts: [{ network: 'unobtainium:0', asset: 'x' }] }),
      );
      return new Response('{"error":"payment required"}', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': paymentRequired },
      });
    }) as typeof globalThis.fetch;

    const client = createX402Client({ wallets: {}, fetch: customFetch });

    const request = new Request('https://example.com/api/foo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'abc' }),
    });

    // No wallet for "unobtainium" → throws no_matching_payment_option.
    // It must NOT throw the Request-reuse TypeError.
    await expect(client.fetch(request)).rejects.toThrow(/no_matching_payment_option|No connected wallet/);
    expect(calls).toBe(1); // probe happened; payment-option lookup failed before retry
    expect(bodies[0]).toBe(JSON.stringify({ token: 'abc' }));
  });
});
