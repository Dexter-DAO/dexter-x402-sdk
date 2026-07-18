/**
 * Restart baseline reseeding (metered-inference spec panel, 2026-07-18).
 *
 * The per-process SessionCache's `lastCumulativeAtomic` (the monotonicity /
 * per-voucher-increment baseline) used to start at '0' for every channel the
 * process hadn't seen — including long-lived tabs whose history is sitting in
 * the durable ChannelLedger. After a process restart, the first voucher on
 * such a tab computed increment = its FULL lifetime cumulative, tripping
 * maxPerVoucherAtomic with a false `cumulative_exceeds_cap` 402, and the
 * monotonicity check ran against 0 instead of the last accepted cumulative.
 *
 * Fix under test: a fresh SessionCache entry seeds `lastCumulativeAtomic`
 * from the persisted `ledger.lastVoucher.payload.cumulativeAmount`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { tabMiddleware } from '../middleware';
import { enforceScope } from '../verify';
import { InMemoryChannelLedger } from '../channel-ledger';
import { humanToAtomic } from '../../tab';

const SELLER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const CHANNEL = 'd'.repeat(64);
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

// perUnit 0.01 → default maxPerVoucherAtomic = 100 × 0.01 = $1.00.
function mw(ledger: InMemoryChannelLedger) {
  return tabMiddleware({
    connection: fakeConnection,
    sellerPubkey: SELLER,
    perUnit: '0.01',
    network: NETWORK,
    settle: 'on-close',
    facilitatorUrl: 'http://fake-facilitator',
    ledger,
    lockCadence: { thresholdAtomic: humanToAtomic('1000000'), onClose: false },
  });
}

function persistedEntry(cumulative: string) {
  return {
    lastVoucher: {
      payload: { channelId: CHANNEL, cumulativeAmount: cumulative, sequenceNumber: 7 },
      sessionPublicKey: new Uint8Array(32),
      sessionRegistration: new Uint8Array(188),
      sessionSignature: new Uint8Array(64),
    },
    deliveredCumulativeAtomic: cumulative,
    lastCrystallizedCumulativeAtomic: '0',
  };
}

const mockedEnforceScope = vi.mocked(enforceScope);

describe('restart baseline reseeding from the durable ledger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts the next voucher on a long-lived tab after a simulated restart (no false cumulative_exceeds_cap)', async () => {
    const ledger = new InMemoryChannelLedger();
    // Lifetime cumulative $1.50 — ABOVE the $1.00 per-voucher cap. Pre-patch,
    // a fresh process treats 1.50→1.51 as a 1.51 increment and 402s.
    await ledger.set(CHANNEL, persistedEntry(humanToAtomic('1.50')));

    const middleware = mw(ledger); // fresh middleware = fresh SessionCache = restarted process
    const { req, res } = fakeReqRes(voucherHeader(CHANNEL, humanToAtomic('1.51'), 8));
    const next = vi.fn();
    await middleware(req, res, next);

    expect(res.statusCode).toBe(0); // no 402 written
    expect(next).toHaveBeenCalledTimes(1);
    // Monotonicity input is the persisted cumulative, not '0'.
    expect(mockedEnforceScope).toHaveBeenCalledWith(
      expect.objectContaining({ previousCumulativeAtomic: humanToAtomic('1.50') }),
    );
  });

  it('still rejects a genuinely oversized increment after reseed', async () => {
    const ledger = new InMemoryChannelLedger();
    await ledger.set(CHANNEL, persistedEntry(humanToAtomic('1.50')));

    const middleware = mw(ledger);
    // 1.50 → 2.90 is a $1.40 single-voucher increment > the $1.00 cap.
    const { req, res } = fakeReqRes(voucherHeader(CHANNEL, humanToAtomic('2.90'), 8));
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect(res.body?.reason ?? res.body?.detail ?? JSON.stringify(res.body)).toContain('cumulative_exceeds_cap');
  });

  it('a brand-new channel (no ledger entry) keeps the zero baseline', async () => {
    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger);
    const { req, res } = fakeReqRes(voucherHeader(CHANNEL, humanToAtomic('0.05')));
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockedEnforceScope).toHaveBeenCalledWith(
      expect.objectContaining({ previousCumulativeAtomic: '0' }),
    );
    void res;
  });
});
