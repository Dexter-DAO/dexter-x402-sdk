/**
 * Chain-frontier baseline seeding (money-review T1 seller finding).
 *
 * verifyRegistrationOnChain already reads the SessionAccount PDA on the
 * first voucher of a session — but it used to DISCARD the spent /
 * crystallizedCumulative odometers. A fresh ledger entry (new channel, or
 * in-memory ledger after a process restart) therefore started its delivered
 * baseline at 0, which:
 *
 *   1. re-granted budget the buyer had already consumed on a resumed
 *      session (over-delivery window: budget = signed − 0 instead of
 *      signed − frontier), and
 *   2. let the meter deliver under a voucher whose cumulative is BELOW the
 *      chain frontier — vouchers the facilitator can never settle or lock
 *      (409 non_monotonic) — i.e. unsecured free service.
 *
 * Fix under test: on a FRESH ledger entry, seed both
 * deliveredCumulativeAtomic and lastCrystallizedCumulativeAtomic from the
 * chain frontier max(spent, crystallizedCumulative). Existing ledger
 * entries are never overwritten.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

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

import { tabMiddleware, requireTab } from '../middleware';
import { openSse } from '../meter';
import { verifyRegistrationOnChain, ScopeViolationError } from '../verify';
import { InMemoryChannelLedger } from '../channel-ledger';
import { humanToAtomic } from '../../tab';

const SELLER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const CHANNEL = 'c'.repeat(64);
const NETWORK = 'solana:mainnet' as const;
const fakeConnection = {} as any;

function voucherHeader(channelId: string, cumulativeAmount: string, sequenceNumber = 1): string {
  const voucher = {
    payload: { channelId, cumulativeAmount, sequenceNumber },
    sessionPublicKey: '00'.repeat(32),
    sessionRegistration: '00'.repeat(188),
    sessionSignature: '00'.repeat(64),
  };
  return Buffer.from(JSON.stringify(voucher), 'utf8').toString('base64');
}

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

function mw(ledger: InMemoryChannelLedger) {
  return tabMiddleware({
    connection: fakeConnection,
    sellerPubkey: SELLER,
    perUnit: '0.01',
    network: NETWORK,
    settle: 'on-close',
    facilitatorUrl: 'http://fake-facilitator',
    ledger,
    // Keep crystallize quiet in these tests — we assert the ledger baseline.
    lockCadence: { thresholdAtomic: humanToAtomic('1000000'), onClose: false },
  });
}

const mockedVerify = vi.mocked(verifyRegistrationOnChain);

describe('chain-frontier baseline seeding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedVerify.mockResolvedValue(undefined as any);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('seeds delivered + crystallized baselines from the chain frontier on a FRESH ledger entry', async () => {
    // Chain says this session already spent/locked 0.03.
    mockedVerify.mockResolvedValue({
      frontierAtomic: humanToAtomic('0.03'),
      spentAtomic: humanToAtomic('0.03'),
      crystallizedCumulativeAtomic: '0',
    } as any);

    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger);

    // Buyer resumes: signed cumulative 0.05 (0.02 above the frontier).
    const { req, res } = fakeReqRes(voucherHeader(CHANNEL, humanToAtomic('0.05')));
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    const entry = await ledger.get(CHANNEL);
    expect(entry?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.03'));
    expect(entry?.lastCrystallizedCumulativeAtomic).toBe(humanToAtomic('0.03'));

    // Budget is signed − frontier = 0.02 → exactly two 0.01 charges fit.
    const tab = requireTab(req);
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(); // 0.01
    await meter.charge(); // 0.02 — at the cap
    await expect(meter.charge()).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it('fails CLOSED when the voucher cumulative is at/below the chain frontier (zero budget)', async () => {
    mockedVerify.mockResolvedValue({
      frontierAtomic: humanToAtomic('0.05'),
      spentAtomic: '0',
      crystallizedCumulativeAtomic: humanToAtomic('0.05'),
    } as any);

    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger);

    // Stale voucher: cumulative 0.04 < frontier 0.05 — unsettleable.
    const { req, res } = fakeReqRes(voucherHeader(CHANNEL, humanToAtomic('0.04')));
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    const tab = requireTab(req);
    const meter = openSse(res, { tab, perUnit: '0.01' });
    // Budget clamps to 0 → the very first charge refuses. No unsecured delivery.
    await expect(meter.charge()).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it('does NOT overwrite an existing ledger entry with the chain frontier', async () => {
    mockedVerify.mockResolvedValue({
      frontierAtomic: humanToAtomic('0.09'),
      spentAtomic: humanToAtomic('0.09'),
      crystallizedCumulativeAtomic: '0',
    } as any);

    const ledger = new InMemoryChannelLedger();
    // Pre-existing history: seller already delivered 0.02 on this channel.
    const seedLease = await ledger.tryAcquireLease(CHANNEL, 60_000);
    if (!seedLease) throw new Error('expected seed lease');
    await ledger.set(CHANNEL, {
      lastVoucher: {
        payload: { channelId: CHANNEL, cumulativeAmount: humanToAtomic('0.02'), sequenceNumber: 1 },
        sessionPublicKey: new Uint8Array(32),
        sessionRegistration: new Uint8Array(188),
        sessionSignature: new Uint8Array(64),
      },
      deliveredCumulativeAtomic: humanToAtomic('0.02'),
      lastCrystallizedCumulativeAtomic: '0',
    }, seedLease);
    await ledger.releaseLease(CHANNEL, seedLease);

    const middleware = mw(ledger);
    const { req, res } = fakeReqRes(voucherHeader(CHANNEL, humanToAtomic('0.10'), 2));
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    const entry = await ledger.get(CHANNEL);
    // Ledger history preserved — not clobbered by the (stale-looking) frontier.
    expect(entry?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.02'));
    expect(entry?.lastCrystallizedCumulativeAtomic).toBe('0');
    void res;
  });

  it('tolerates a void verifyRegistrationOnChain (no seeding, legacy behavior)', async () => {
    mockedVerify.mockResolvedValue(undefined as any);

    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger);
    const { req, res } = fakeReqRes(voucherHeader(CHANNEL, humanToAtomic('0.05')));
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    const entry = await ledger.get(CHANNEL);
    expect(entry?.deliveredCumulativeAtomic).toBe('0');
    void res;
  });

  it('a zero frontier (brand-new session) seeds nothing', async () => {
    mockedVerify.mockResolvedValue({
      frontierAtomic: '0',
      spentAtomic: '0',
      crystallizedCumulativeAtomic: '0',
    } as any);

    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger);
    const { req, res } = fakeReqRes(voucherHeader(CHANNEL, humanToAtomic('0.05')));
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    const entry = await ledger.get(CHANNEL);
    expect(entry?.deliveredCumulativeAtomic).toBe('0');
    expect(entry?.lastCrystallizedCumulativeAtomic).toBe('0');
    void res;
    await flushMicrotasks();
  });
});
