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
function voucherHeader(
  channelId: string,
  cumulativeAmount: string,
  sequenceNumber = 1,
  registrationHex = '00'.repeat(188),
): string {
  const voucher = {
    payload: { channelId, cumulativeAmount, sequenceNumber },
    sessionPublicKey: '00'.repeat(32),
    sessionRegistration: registrationHex,
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

  // ── K-T3 (cadence §5 A12): below_lock_cadence storm suppression ────────

  /** A facilitator whose router gate refuses every lock as below-cadence. */
  function refusingLockFetch() {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({ error: 'below_lock_cadence', threshold_atomic: '250000' }),
        { status: 409 },
      );
    });
    return { fetchImpl, calls };
  }

  async function driveRequest(
    middleware: ReturnType<typeof mw>,
    signedAtomic: string,
    seq: number,
    units: number,
  ) {
    const { req, res } = fakeReqRes(voucherHeader(CHANNEL, signedAtomic, seq));
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const tab = requireTab(req);
    const meter = openSse(res, { tab, perUnit: '0.01' });
    for (let i = 0; i < units; i += 1) { await meter.charge(); meter.send('x'); }
    await meter.end();
    await flushMicrotasks();
    res.emit('close');
    await flushMicrotasks();
    await flushMicrotasks();
  }

  it('threshold path: a below_lock_cadence refusal is persisted and the SAME span is not re-POSTed by later requests', async () => {
    const { fetchImpl, calls } = refusingLockFetch();
    vi.stubGlobal('fetch', fetchImpl);

    const ledger = new InMemoryChannelLedger();
    // Tiny threshold so the delivery path fires; onClose OFF to isolate it.
    const middleware = mw(ledger, { thresholdAtomic: humanToAtomic('0.01'), onClose: false });

    // Request 1: deliver past the threshold → ONE refused POST, watermark persisted.
    await driveRequest(middleware, humanToAtomic('0.05'), 1, 2);
    expect(calls).toHaveLength(1);
    expect((await ledger.get(CHANNEL))?.gateRefusedCumulativeAtomic).toBe(humanToAtomic('0.05'));

    // Request 2: SAME signed voucher (the refused span is unchanged) — more
    // deliveries cross the threshold again, but the gate already refused this
    // exact span. No re-POST (the storm guard).
    await driveRequest(middleware, humanToAtomic('0.05'), 2, 2);
    expect(calls).toHaveLength(1);

    // Request 3: a HIGHER signed voucher — the span grew, re-attempt fires.
    await driveRequest(middleware, humanToAtomic('0.10'), 3, 2);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.cumulativeAmount).toBe(humanToAtomic('0.10'));
  });

  it('close path: a refused final span is not re-POSTed by the next request-close with the same voucher', async () => {
    const { fetchImpl, calls } = refusingLockFetch();
    vi.stubGlobal('fetch', fetchImpl);

    const ledger = new InMemoryChannelLedger();
    // Huge threshold isolates the CLOSE path (matching the FIX C2 tests).
    const middleware = mw(ledger, { thresholdAtomic: humanToAtomic('1000000'), onClose: true });

    await driveRequest(middleware, humanToAtomic('0.05'), 1, 1);
    expect(calls).toHaveLength(1); // close fired, gate refused
    expect((await ledger.get(CHANNEL))?.gateRefusedCumulativeAtomic).toBe(humanToAtomic('0.05'));

    // Second request, same signed voucher → its close must NOT re-ask the
    // gate about the identical refused span.
    await driveRequest(middleware, humanToAtomic('0.05'), 2, 1);
    expect(calls).toHaveLength(1);

    // A higher final voucher re-attempts at close.
    await driveRequest(middleware, humanToAtomic('0.12'), 3, 1);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.cumulativeAmount).toBe(humanToAtomic('0.12'));
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

  it('allows V1 reconnect headroom only with a strictly newer durable sequence', async () => {
    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger, {
      thresholdAtomic: humanToAtomic('1000000'),
      onClose: false,
    });
    const cumulative = humanToAtomic('0.05');

    const first = fakeReqRes(voucherHeader(CHANNEL, cumulative, 1));
    const firstNext = vi.fn();
    await middleware(first.req, first.res, firstNext);
    expect(firstNext).toHaveBeenCalledOnce();
    first.res.emit('close');
    await flushMicrotasks();

    const replay = fakeReqRes(voucherHeader(CHANNEL, cumulative, 1));
    const replayNext = vi.fn();
    await middleware(replay.req, replay.res, replayNext);
    expect(replayNext).not.toHaveBeenCalled();
    expect(replay.res.body).toMatchObject({ reason: 'non_monotonic' });

    const reconnect = fakeReqRes(voucherHeader(CHANNEL, cumulative, 2));
    const reconnectNext = vi.fn();
    await middleware(reconnect.req, reconnect.res, reconnectNext);
    expect(reconnectNext).toHaveBeenCalledOnce();
    reconnect.res.emit('close');
    await flushMicrotasks();
  });

  it('rejects a case-flipped spelling of the same signed channel bytes', async () => {
    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger, {
      thresholdAtomic: humanToAtomic('1000000'),
      onClose: false,
    });
    const cumulative = humanToAtomic('0.05');

    const canonical = fakeReqRes(voucherHeader(CHANNEL, cumulative, 1));
    await middleware(canonical.req, canonical.res, vi.fn());
    canonical.res.emit('close');
    await flushMicrotasks();

    // Hex decoding would produce the same 32 signed bytes, but raw-case keys
    // would create a second cache/lease/ledger identity without this guard.
    const flippedChannel = CHANNEL.toUpperCase();
    const replay = fakeReqRes(voucherHeader(flippedChannel, cumulative, 2));
    const replayNext = vi.fn();
    await middleware(replay.req, replay.res, replayNext);
    expect(replayNext).not.toHaveBeenCalled();
    expect(replay.res.body).toMatchObject({ reason: 'signature_invalid' });
    await expect(ledger.get(flippedChannel)).rejects.toThrow(/canonical lowercase/);
    expect((await ledger.get(CHANNEL))?.deliveredCumulativeAtomic).toBe('0');
  });

  it('does not cache a first-seen V1 registration that loses the durable lease', async () => {
    const ledger = new InMemoryChannelLedger();
    const acquire = ledger.tryAcquireLease.bind(ledger);
    vi.spyOn(ledger, 'tryAcquireLease')
      .mockResolvedValueOnce(null)
      .mockImplementation(acquire);
    const middleware = mw(ledger, {
      thresholdAtomic: humanToAtomic('1000000'),
      onClose: false,
    });
    const cumulative = humanToAtomic('0.01');

    const loser = fakeReqRes(voucherHeader(
      CHANNEL,
      cumulative,
      1,
      '11'.repeat(188),
    ));
    await middleware(loser.req, loser.res, vi.fn());
    expect(loser.res.body).toMatchObject({ reason: 'channel_busy' });

    const legitimate = fakeReqRes(voucherHeader(
      CHANNEL,
      cumulative,
      1,
      '22'.repeat(188),
    ));
    const next = vi.fn();
    await middleware(legitimate.req, legitimate.res, next);
    expect(next).toHaveBeenCalledOnce();

    legitimate.res.emit('close');
    await flushMicrotasks();
  });

  it('caps two meters sharing one admitted SellerTab at the durable signed cumulative', async () => {
    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger, {
      thresholdAtomic: humanToAtomic('1000000'),
      onClose: false,
    });
    const signedAtomic = humanToAtomic('0.01');
    const admitted = fakeReqRes(voucherHeader(CHANNEL, signedAtomic, 1));
    const next = vi.fn();
    await middleware(admitted.req, admitted.res, next);
    expect(next).toHaveBeenCalledOnce();

    const tab = requireTab(admitted.req);
    // Both meters snapshot the same zero delivered baseline and each locally
    // sees the full signed remainder. The fenced ledger mutation is therefore
    // the authoritative shared cap boundary, not either meter's local counter.
    const first = openSse(fakeReqRes('').res, { tab, perUnit: '0.01' });
    const second = openSse(fakeReqRes('').res, { tab, perUnit: '0.01' });
    const results = await Promise.allSettled([first.charge(1), second.charge(1)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await ledger.get(CHANNEL))?.deliveredCumulativeAtomic).toBe(signedAtomic);

    admitted.res.emit('close');
    await flushMicrotasks();
  });
});
