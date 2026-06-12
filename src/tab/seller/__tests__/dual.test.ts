import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Connection } from '@solana/web3.js';
import { tabOrExactMiddleware } from '../dual';
import { parseV2Challenge } from '../../../payment/v2-challenge';

const CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SELLER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const FEE_PAYER = 'DexFeePayer1111111111111111111111111111111';

// Records facilitator calls so tests can assert WHAT we sent (the
// underpayment pin reads the /verify request body).
const calls: Array<{ path: string; body: unknown }> = [];
let verifyResponse: unknown = { isValid: false, invalidReason: 'test_invalid' };
let settleResponse: unknown = { success: false, errorReason: 'settle_not_stubbed' };

function fakeFacilitatorFetch(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.includes('/supported')) {
      return new Response(JSON.stringify({ kinds: [
        { x402Version: 2, scheme: 'exact', network: CAIP2, extra: { feePayer: FEE_PAYER, decimals: 6 } },
        { x402Version: 2, scheme: 'tab', network: CAIP2, extra: { feePayer: FEE_PAYER, decimals: 6 } },
      ] }), { status: 200 });
    }
    if (url.includes('/verify')) {
      calls.push({ path: '/verify', body });
      return new Response(JSON.stringify(verifyResponse), { status: 200 });
    }
    if (url.includes('/settle')) {
      calls.push({ path: '/settle', body });
      return new Response(JSON.stringify(settleResponse), { status: 200 });
    }
    throw new Error(`unexpected facilitator call: ${url}`);
  }) as typeof fetch;
}

function fakeReqRes(headers: Record<string, string> = {}) {
  const req: any = {
    headers,
    protocol: 'http',
    originalUrl: '/paid/tick',
    get: (h: string) => (h.toLowerCase() === 'host' ? '127.0.0.1:4455' : undefined),
  };
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    set(h: Record<string, string>) { Object.assign(this.headers, h); return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return { req, res };
}

/** Decode the base64-encoded PAYMENT-REQUIRED header into the requirements object */
function decodePaymentRequired(header: string): Record<string, unknown> {
  const padded = header.replace(/-/g, '+').replace(/_/g, '/');
  const normalized = padded + '='.repeat((4 - (padded.length % 4 || 4)) % 4);
  return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
}

function mw() {
  return tabOrExactMiddleware({
    connection: new Connection('http://127.0.0.1:8899'),
    sellerPubkey: SELLER,
    network: 'solana:mainnet',
    perUnit: '0.01',
    facilitatorUrl: 'http://fake-facilitator',
  });
}

beforeEach(() => {
  calls.length = 0;
  verifyResponse = { isValid: false, invalidReason: 'test_invalid' };
  settleResponse = { success: false, errorReason: 'settle_not_stubbed' };
  vi.stubGlobal('fetch', fakeFacilitatorFetch());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tabOrExactMiddleware', () => {
  it('emits ONE merged 402 challenge: tab first, exact second, same price, same payTo', async () => {
    const { req, res } = fakeReqRes();
    const next = vi.fn();
    await mw()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect(res.headers['PAYMENT-REQUIRED']).toBeTruthy();

    const requirements = decodePaymentRequired(res.headers['PAYMENT-REQUIRED']);
    const accepts = (requirements as any).accepts;
    expect(accepts).toHaveLength(2);
    expect(accepts[0].scheme).toBe('tab');
    expect(accepts[1].scheme).toBe('exact');
    for (const accept of accepts) {
      expect(accept.payTo).toBe(SELLER);
      expect(accept.network).toBe(CAIP2);
      expect(accept.maxAmountRequired).toBe('10000');
    }

    // Catalog ingestion reads BODIES — the 402 body must carry accepts too.
    const bodyAccepts = (res.body as any).accepts;
    expect(bodyAccepts).toHaveLength(2);
  });

  it('INTEROP: the emitted challenge parses under parseV2Challenge with BOTH schemes', async () => {
    const { req, res } = fakeReqRes();
    await mw()(req, res, vi.fn());
    const wire = new Response(JSON.stringify(res.body), {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': res.headers['PAYMENT-REQUIRED'] },
    });
    const challenge = await parseV2Challenge(wire);
    expect(challenge).not.toBeNull();
    const schemes = challenge!.options.map((o) => o.scheme);
    expect(schemes).toContain('tab');
    expect(schemes).toContain('exact');
    const tab = challenge!.options.find((o) => o.scheme === 'tab');
    expect(tab!.network.caip2).toBe(CAIP2);
  });

  it('dispatches voucher-carrying requests to the tab rail (no fresh challenge)', async () => {
    const { req, res } = fakeReqRes({ 'x-tab-voucher': 'garbage-not-a-voucher' });
    const next = vi.fn();
    await mw()(req, res, next);
    // The tab rail handled it: rejected the garbage voucher, did NOT emit a
    // fresh challenge.
    expect(res.headers['PAYMENT-REQUIRED']).toBeUndefined();
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('UNDERPAYMENT PIN: verify is called with OUR amount, never the buyer header amount', async () => {
    const underpayingHeader = Buffer.from(JSON.stringify({
      accepted: { network: CAIP2, scheme: 'exact', amount: '1', maxAmountRequired: '1' },
      payload: { transaction: 'AAAA' },
    })).toString('base64');

    const { req, res } = fakeReqRes({ 'payment-signature': underpayingHeader });
    const next = vi.fn();
    await mw()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect((res.body as any).error).toBe('Payment verification failed');

    // Exactly one /verify call, and the requirements we sent carry OUR
    // configured amount — NOT the '1' the buyer's header claims. (The
    // paymentPayload field necessarily echoes the buyer's header verbatim,
    // so the pin reads paymentRequirements — the field the facilitator
    // verifies the payment AGAINST.)
    expect(calls).toHaveLength(1);
    const requirements = (calls[0].body as any).paymentRequirements;
    expect(requirements).toBeTruthy();
    expect(requirements.amount).toBe('10000');
    expect(requirements.maxAmountRequired).toBe('10000');
    expect(JSON.stringify(calls[0].body)).toContain('"10000"');
    expect(JSON.stringify(requirements)).not.toContain('"amount":"1"');
  });

  it('SUCCESS PATH: valid payment -> settle -> req.x402 + PAYMENT-RESPONSE + next()', async () => {
    verifyResponse = { isValid: true, payer: 'BuyerPayer1111111111111111111111111111111111' };
    settleResponse = { success: true, transaction: 'TxSig123', network: CAIP2 };
    const paidHeader = Buffer.from(JSON.stringify({
      accepted: { network: CAIP2, scheme: 'exact', amount: '10000', maxAmountRequired: '10000' },
      payload: { transaction: 'AAAA' },
    })).toString('base64');

    const { req, res } = fakeReqRes({ 'payment-signature': paidHeader });
    const next = vi.fn();
    await mw()(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0); // middleware never wrote a status — handler owns it
    expect(req.x402).toEqual({
      transaction: 'TxSig123',
      payer: 'BuyerPayer1111111111111111111111111111111111',
      network: CAIP2,
    });
    const receipt = decodePaymentRequired(res.headers['PAYMENT-RESPONSE']);
    expect(receipt).toEqual({
      success: true,
      transaction: 'TxSig123',
      network: CAIP2,
      payer: 'BuyerPayer1111111111111111111111111111111111',
    });
    // Settle was called with the SAME explicit requirements as verify.
    const settleCall = calls.find((c) => c.path === '/settle');
    expect((settleCall!.body as any).paymentRequirements.amount).toBe('10000');
  });

  it('settle failure -> 402 with the settlement error, no next()', async () => {
    verifyResponse = { isValid: true, payer: 'BuyerPayer1111111111111111111111111111111111' };
    settleResponse = { success: false, errorReason: 'insufficient_funds' };
    const paidHeader = Buffer.from(JSON.stringify({
      accepted: { network: CAIP2, scheme: 'exact', amount: '10000' },
      payload: { transaction: 'AAAA' },
    })).toString('base64');

    const { req, res } = fakeReqRes({ 'payment-signature': paidHeader });
    const next = vi.fn();
    await mw()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect(res.body).toEqual({ error: 'Payment settlement failed', reason: 'insufficient_funds' });
  });

  it('facilitator down on the EXACT rail -> 503 challenge_unavailable, not 500', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch);
    const paidHeader = Buffer.from(JSON.stringify({
      accepted: { network: CAIP2, scheme: 'exact', amount: '10000' },
      payload: { transaction: 'AAAA' },
    })).toString('base64');

    const { req, res } = fakeReqRes({ 'payment-signature': paidHeader });
    const next = vi.fn();
    await mw()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('5');
    expect((res.body as any).error).toBe('challenge_unavailable');
  });

  it('header precedence: voucher wins when BOTH payment headers are present', async () => {
    const { req, res } = fakeReqRes({
      'x-tab-voucher': 'garbage-not-a-voucher',
      'payment-signature': 'also-present',
    });
    const next = vi.fn();
    await mw()(req, res, next);
    // Dispatched to the tab rail: no challenge, no exact /verify call.
    expect(res.headers['PAYMENT-REQUIRED']).toBeUndefined();
    expect(calls.filter((c) => c.path === '/verify')).toHaveLength(0);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('answers 503 + Retry-After when the facilitator is unreachable', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch);
    const { req, res } = fakeReqRes();
    const next = vi.fn();
    await mw()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('5');
    expect((res.body as any).error).toBe('challenge_unavailable');
  });

  it('throws at construction for an invalid sellerPubkey and an unsupported network', () => {
    expect(() => tabOrExactMiddleware({
      connection: new Connection('http://127.0.0.1:8899'),
      sellerPubkey: 'not-a-pubkey',
      network: 'solana:mainnet',
      perUnit: '0.01',
      facilitatorUrl: 'http://fake-facilitator',
    })).toThrow();

    expect(() => tabOrExactMiddleware({
      connection: new Connection('http://127.0.0.1:8899'),
      sellerPubkey: SELLER,
      network: 'solana:devnet' as never,
      perUnit: '0.01',
      facilitatorUrl: 'http://fake-facilitator',
    })).toThrow();
  });
});
