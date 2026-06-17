import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Bypass crypto/on-chain verification (same approach as lease.test.ts) ──
//
// parseRegistration / verifyRegistrationOnChain / verifyVoucherSignature /
// enforceScope all no-op so the test exercises the REAL middleware close-path
// crystallize logic. The error classes the middleware instanceof-checks are
// re-exported from the actual module.
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
    verifyRegistrationOnChain: vi.fn(async () => {}),
    verifyVoucherSignature: vi.fn(() => {}),
    enforceScope: vi.fn(() => {}),
  };
});

import { tabMiddleware, requireTab } from '../middleware';
import { openSse } from '../meter';
import { InMemoryChannelLedger } from '../channel-ledger';
import { humanToAtomic } from '../../tab';

const SELLER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const CHANNEL = 'a'.repeat(64);
const NETWORK = 'solana:mainnet' as const;

const fakeConnection = {} as any;

/** Base64-JSON voucher header the middleware can decode. cumulativeAmount is the
 *  signed cumulative for THIS channel — the value that must get crystallized. */
function voucherHeader(channelId: string, cumulativeAmount: string, sequenceNumber = 1): string {
  const voucher = {
    payload: { channelId, cumulativeAmount, sequenceNumber },
    sessionPublicKey: '00'.repeat(32),
    sessionRegistration: '00'.repeat(188),
    sessionSignature: '00'.repeat(64),
  };
  return Buffer.from(JSON.stringify(voucher), 'utf8').toString('base64');
}

/** Real EventEmitter res so res.on('close'|'finish') and res.emit() work. */
function fakeReqRes(header: string) {
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

/** Captures every /tab/lock POST so the test can assert the close path fired. */
function lockFetch() {
  const calls: Array<{ url: string; init: any; body: any }> = [];
  const fetchImpl = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ claimPda: 'ClaimPda1111' }), { status: 200 });
  });
  return { fetchImpl, calls };
}

function mw(ledger: InMemoryChannelLedger, lockCadence?: { thresholdAtomic: string; onClose: boolean }) {
  return tabMiddleware({
    connection: fakeConnection,
    sellerPubkey: SELLER,
    perUnit: '0.01',
    network: NETWORK,
    settle: 'on-close',
    facilitatorUrl: 'http://fake-facilitator',
    ledger,
    // Huge threshold so the THRESHOLD path never fires — we isolate the CLOSE path.
    lockCadence: lockCadence ?? { thresholdAtomic: humanToAtomic('1000000'), onClose: true },
  });
}

describe('tabMiddleware close-path crystallize (FIX C2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('crystallizes the FINAL signed voucher exactly ONCE on res close, with the matching cumulative', async () => {
    const { fetchImpl, calls } = lockFetch();
    vi.stubGlobal('fetch', fetchImpl);

    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger);

    // Buyer's final signed voucher authorizes 0.05 (signed cumulative).
    const signedHuman = '0.05';
    const signedAtomic = humanToAtomic(signedHuman);
    const { req, res } = fakeReqRes(voucherHeader(CHANNEL, signedAtomic));
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Drive a metered stream through the meter so recordDelivered runs and
    // delivered advances (to LESS than signed — e.g. deliver 0.03).
    const tab = requireTab(req);
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(); meter.send('a'); // +0.01
    await meter.charge(); meter.send('b'); // +0.02
    await meter.charge(); meter.send('c'); // +0.03 delivered
    await meter.end();
    await flushMicrotasks();

    // end() called res.end(); on a real response that emits 'close'. Our fake
    // res.end() does not, so emit it explicitly to drive the close lifecycle.
    res.emit('close');
    await flushMicrotasks();
    await flushMicrotasks();

    // Crystallized EXACTLY ONCE.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://fake-facilitator/tab/lock');
    // It crystallized the FINAL signed voucher cumulative (0.05), not a stale or
    // a delivered (0.03) snapshot — the voucher secures at least what's delivered.
    expect(calls[0].body.cumulativeAmount).toBe(signedAtomic);
    expect(calls[0].body.channelId).toBe(CHANNEL);

    // Watermark persisted to the POSTed voucher cumulative (FIX C1), not delivered.
    const persisted = await ledger.get(CHANNEL);
    expect(persisted?.lastCrystallizedCumulativeAtomic).toBe(signedAtomic);
  });

  it('does not double-crystallize when both finish and close fire', async () => {
    const { fetchImpl, calls } = lockFetch();
    vi.stubGlobal('fetch', fetchImpl);

    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger);

    const signedAtomic = humanToAtomic('0.05');
    const { req, res } = fakeReqRes(voucherHeader(CHANNEL, signedAtomic));
    const next = vi.fn();
    await middleware(req, res, next);

    const tab = requireTab(req);
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(); meter.send('a');
    await meter.end();
    await flushMicrotasks();

    res.emit('finish');
    res.emit('close');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(calls).toHaveLength(1); // closeCrystallized idempotency flag holds
  });

  it('still releases the lease on close independently of the close-crystallize', async () => {
    const { fetchImpl } = lockFetch();
    vi.stubGlobal('fetch', fetchImpl);

    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger);

    const { req: req1, res: res1 } = fakeReqRes(voucherHeader(CHANNEL, humanToAtomic('0.05')));
    const next1 = vi.fn();
    await middleware(req1, res1, next1);
    expect(next1).toHaveBeenCalledTimes(1);

    res1.emit('close');
    await flushMicrotasks();
    await flushMicrotasks();

    // Lease freed → a fresh request on the same channel is accepted.
    const { req: req2, res: res2 } = fakeReqRes(voucherHeader(CHANNEL, humanToAtomic('0.10'), 2));
    const next2 = vi.fn();
    await middleware(req2, res2, next2);
    expect(next2).toHaveBeenCalledTimes(1);
    expect(res2.statusCode).toBe(0);
  });
});
