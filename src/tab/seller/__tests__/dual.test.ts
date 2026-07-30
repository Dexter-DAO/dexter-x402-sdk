import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Connection } from '@solana/web3.js';
import { tabOrExactMiddleware } from '../dual';
import { parseV2Challenge } from '../../../payment/v2-challenge';
import { requireTab } from '../middleware';
import { openSse } from '../meter';
import { humanToAtomic } from '../../tab';

// ── Bypass crypto/on-chain voucher verification (same approach as
// middleware-crystallize.test.ts) so the lockCadence-forwarding tests below can
// drive a synthetic voucher all the way to the tab rail's crystallize paths.
// SAFE for the dual wrapper's own tests above: they only ever send GARBAGE
// vouchers, which decodeVoucherHeader rejects BEFORE any of these functions run,
// and the exact rail never touches this module.
vi.mock('../verify', async () => {
  const actual = await vi.importActual<typeof import('../verify')>('../verify');
  return {
    ...actual,
    parseRegistration: vi.fn(() => ({
      programId: { toBase58: () => 'prog' },
      vaultPda: { toBase58: () => 'vault' },
      sessionPubkey: new Uint8Array(32),
      maxAmount: 1_000_000_000n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      allowedCounterparty: { toBase58: () => 'cp', equals: () => true },
      nonce: 1,
      maxRevolvingCapacity: 0n,
    })),
    verifyRegistrationOnChain: vi.fn(async () => undefined),
    verifyVoucherSignature: vi.fn(() => {}),
    enforceScope: vi.fn(() => {}),
  };
});

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

// ── Harness for the lockCadence-forwarding tests ───────────────────────────
const CHANNEL = 'a'.repeat(64);

/** base64-JSON voucher header the tab rail can decode (crypto verify is mocked). */
function voucherHeader(channelId: string, cumulativeAmount: string, sequenceNumber = 1): string {
  const voucher = {
    payload: { channelId, cumulativeAmount, sequenceNumber },
    sessionPublicKey: '00'.repeat(32),
    sessionRegistration: '00'.repeat(188),
    sessionSignature: '00'.repeat(64),
  };
  return Buffer.from(JSON.stringify(voucher), 'utf8').toString('base64');
}

/** Real EventEmitter res so res.on('close'|'finish') fire the crystallize handlers. */
function fakeReqResEmitter(header: string) {
  const req: any = { headers: { 'x-tab-voucher': header } };
  const res: any = new EventEmitter();
  res.statusCode = 0;
  res.body = undefined;
  res.headers = {};
  res.status = function (c: number) { this.statusCode = c; return this; };
  res.json = function (b: unknown) { this.body = b; return this; };
  res.setHeader = function (n: string, v: string) { this.headers[n] = v; return this; };
  res.write = function () { return true; };
  res.end = function () { return this; };
  res.flushHeaders = function () {};
  res.headersSent = false;
  return { req, res };
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

/** Captures every /tab/lock POST the tab rail fires (best-effort crystallize). */
function lockFetch() {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ claimPda: 'ClaimPda1111' }), { status: 200 });
  });
  return { fetchImpl, calls };
}

/** Construct the dual middleware through the PUBLIC API, optionally with lockCadence. */
function dualMw(lockCadence?: { thresholdAtomic?: string; onClose?: boolean }) {
  return tabOrExactMiddleware({
    connection: new Connection('http://127.0.0.1:8899'),
    sellerPubkey: SELLER,
    network: 'solana:mainnet',
    perUnit: '0.01',
    facilitatorUrl: 'http://fake-facilitator',
    ...(lockCadence !== undefined ? { lockCadence } : {}),
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
    expect(accepts[0].extra).toMatchObject({
      termsVersion: 'dexter-tab-hosted-pay-before-delivery/v1',
      acceptanceRule: 'pay_before_delivery_seller_2xx',
    });
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
    expect(tab!.extra).toMatchObject({
      termsVersion: 'dexter-tab-hosted-pay-before-delivery/v1',
      acceptanceRule: 'pay_before_delivery_seller_2xx',
    });
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

describe('tabOrExactMiddleware — lockCadence forwarding (seller crystallization dial)', () => {
  it('DISARM PIN: lockCadence { onClose: false } through the PUBLIC dual API → ZERO /tab/lock POSTs on close', async () => {
    const { fetchImpl, calls } = lockFetch();
    vi.stubGlobal('fetch', fetchImpl);

    // The disarm: turn OFF the close-time crystallize on the tab rail via the
    // dual wrapper's public config. This is a RUNTIME assertion on compiled
    // behavior — it pins the exact "TS2353 at compile + emitted JS silently
    // ignores the option, ships armed" failure the deploy was blocked on.
    const middleware = dualMw({ onClose: false });

    const signedAtomic = humanToAtomic('0.05');
    const { req, res } = fakeReqResEmitter(voucherHeader(CHANNEL, signedAtomic));
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1); // tab rail accepted the voucher

    // Deliver 0.03 — BELOW the default $0.10 threshold, so the threshold cadence
    // stays silent and the CLOSE path is the only thing that could fire a lock.
    const tab = requireTab(req);
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(); meter.send('a');
    await meter.charge(); meter.send('b');
    await meter.charge(); meter.send('c');
    await meter.end();
    await flushMicrotasks();
    res.emit('close');
    await flushMicrotasks();
    await flushMicrotasks();

    const lockCalls = calls.filter((c) => c.url.includes('/tab/lock'));
    expect(lockCalls).toHaveLength(0); // disarmed: no on-chain crystallize fired
  });

  it('DEFAULT PRESERVED: lockCadence omitted → close-path crystallize DOES fire (armed by default)', async () => {
    const { fetchImpl, calls } = lockFetch();
    vi.stubGlobal('fetch', fetchImpl);

    const middleware = dualMw(); // no lockCadence → defaults: threshold $0.10, onClose true

    const signedAtomic = humanToAtomic('0.05');
    const { req, res } = fakeReqResEmitter(voucherHeader(CHANNEL, signedAtomic));
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Deliver 0.03 (< $0.10 threshold) so ONLY the close path fires → exactly one lock.
    const tab = requireTab(req);
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(); meter.send('a');
    await meter.charge(); meter.send('b');
    await meter.charge(); meter.send('c');
    await meter.end();
    await flushMicrotasks();
    res.emit('close');
    await flushMicrotasks();
    await flushMicrotasks();

    const lockCalls = calls.filter((c) => c.url.includes('/tab/lock'));
    expect(lockCalls).toHaveLength(1); // armed default preserved: exactly one close-path lock
    expect(lockCalls[0].url).toBe('http://fake-facilitator/tab/lock');
    expect(lockCalls[0].body.channelId).toBe(CHANNEL);
    expect(lockCalls[0].body.cumulativeAmount).toBe(signedAtomic);
  });

  it('THRESHOLD FORWARD: a custom thresholdAtomic fires the cadence at the custom value, not $0.10', async () => {
    const { fetchImpl, calls } = lockFetch();
    vi.stubGlobal('fetch', fetchImpl);

    // Custom threshold 0.02 + onClose false: the ONLY lock that can fire is the
    // THRESHOLD cadence at 0.02. If thresholdAtomic were NOT forwarded, the rail
    // would default to $0.10 and delivering 0.02 (with close disarmed) fires
    // nothing — so this pins the threshold half of the forward.
    const middleware = dualMw({ thresholdAtomic: humanToAtomic('0.02'), onClose: false });

    const signedAtomic = humanToAtomic('0.05');
    const { req, res } = fakeReqResEmitter(voucherHeader(CHANNEL, signedAtomic));
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    const tab = requireTab(req);
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(); meter.send('a'); // 0.01
    await meter.charge(); meter.send('b'); // 0.02 — crosses the custom 0.02 threshold
    await meter.end();                     // recordDelivered → threshold cadence fires
    await flushMicrotasks();
    await flushMicrotasks();
    // NO res.emit('close') — onClose:false, so any lock here is purely the threshold path.

    const lockCalls = calls.filter((c) => c.url.includes('/tab/lock'));
    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0].body.cumulativeAmount).toBe(signedAtomic); // POSTs the stored signed voucher
  });

  it('PER-FIELD DEFAULT: lockCadence { thresholdAtomic } with onClose OMITTED stays ARMED on close (?? true)', async () => {
    const { fetchImpl, calls } = lockFetch();
    vi.stubGlobal('fetch', fetchImpl);

    // Partial cadence: supply ONLY thresholdAtomic. onClose is omitted, so the
    // per-field default `?? true` (middleware.ts:219) must keep close-crystallize
    // ARMED — a partial config must NOT silently disarm the close path. Threshold
    // is set above the delivered amount so the ONLY lock that can fire is close.
    const middleware = dualMw({ thresholdAtomic: humanToAtomic('0.20') });

    const signedAtomic = humanToAtomic('0.05');
    const { req, res } = fakeReqResEmitter(voucherHeader(CHANNEL, signedAtomic));
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Deliver 0.03 — below the custom 0.20 threshold, so the threshold cadence
    // stays silent; close is the only path that can fire a lock.
    const tab = requireTab(req);
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(); meter.send('a');
    await meter.charge(); meter.send('b');
    await meter.charge(); meter.send('c');
    await meter.end();
    await flushMicrotasks();
    res.emit('close');
    await flushMicrotasks();
    await flushMicrotasks();

    const lockCalls = calls.filter((c) => c.url.includes('/tab/lock'));
    expect(lockCalls).toHaveLength(1); // onClose defaulted true → exactly one close-path lock
    expect(lockCalls[0].body.channelId).toBe(CHANNEL);
    expect(lockCalls[0].body.cumulativeAmount).toBe(signedAtomic);
  });
});
