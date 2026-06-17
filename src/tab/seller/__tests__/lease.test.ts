import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Bypass the crypto/on-chain verification ─────────────────────────────
//
// We mock ../verify so that parseRegistration / verifyRegistrationOnChain /
// verifyVoucherSignature / enforceScope all no-op (verification passes
// trivially) and the test exercises the REAL tabMiddleware lease logic.
//
// The error classes the middleware's catch block instanceof-checks
// (ScopeViolationError / InvalidRegistrationError / OnChainVerificationError /
// InvalidVoucherSignatureError) must be the REAL classes, so we re-export them
// from the actual module via importActual.
vi.mock('../verify', async () => {
  const actual = await vi.importActual<typeof import('../verify')>('../verify');
  return {
    ...actual,
    parseRegistration: vi.fn(() => ({
      // Shape of ParsedRegistration — none of these fields are read once
      // verifyRegistrationOnChain / enforceScope are no-ops, but keep them
      // plausible so the cache entry is well-formed.
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

import { tabMiddleware } from '../middleware';
import { InMemoryChannelLedger } from '../channel-ledger';

const SELLER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const CHANNEL = 'a'.repeat(64);

/** A fake Connection — never actually hit because verifyRegistrationOnChain is mocked. */
const fakeConnection = {} as any;

/** Build a base64-JSON voucher header the middleware can decode. */
function voucherHeader(channelId: string, cumulativeAmount: string, sequenceNumber = 1): string {
  const voucher = {
    payload: { channelId, cumulativeAmount, sequenceNumber },
    sessionPublicKey: '00'.repeat(32),
    sessionRegistration: '00'.repeat(188),
    sessionSignature: '00'.repeat(64),
  };
  return Buffer.from(JSON.stringify(voucher), 'utf8').toString('base64');
}

/**
 * Fake Express request/response. The response is a real EventEmitter so the
 * middleware's res.on('close'|'finish') registration and our res.emit() work,
 * with the Express response methods assigned onto it.
 */
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
    network: 'solana:mainnet',
    settle: 'on-close',
    ledger,
  });
}

describe('channel lease — end-to-end through tabMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BUG 1: a second concurrent request on the same channel is rejected 402 channel_busy (the rug is closed)', async () => {
    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger);

    // Request 1: accepted, lease acquired. We do NOT emit close/finish — the
    // stream is still open, so the lease is still held.
    const { req: req1, res: res1 } = fakeReqRes(voucherHeader(CHANNEL, '1000'));
    const next1 = vi.fn();
    await middleware(req1, res1, next1);
    expect(next1).toHaveBeenCalledTimes(1);
    expect(res1.statusCode).toBe(0);

    // Request 2: same channel, higher cumulative, while req1's stream is open.
    // The lease is held → must be rejected 402 channel_busy and NOT call next.
    const { req: req2, res: res2 } = fakeReqRes(voucherHeader(CHANNEL, '2000', 2));
    const next2 = vi.fn();
    await middleware(req2, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(402);
    expect((res2.body as any).reason).toBe('channel_busy');
  });

  it('BUG 2: the lease is released on res "close" even though no meter ever ran', async () => {
    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger);

    const { req: req1, res: res1 } = fakeReqRes(voucherHeader(CHANNEL, '1000'));
    const next1 = vi.fn();
    await middleware(req1, res1, next1);
    expect(next1).toHaveBeenCalledTimes(1);

    // Handler finished (e.g. plain res.json or an error). The response closes.
    res1.emit('close');
    await flushMicrotasks();

    // A fresh request on the same channel must now be accepted — the lease was
    // freed by the response lifecycle, not by any meter.
    const { req: req2, res: res2 } = fakeReqRes(voucherHeader(CHANNEL, '2000', 2));
    const next2 = vi.fn();
    await middleware(req2, res2, next2);
    expect(next2).toHaveBeenCalledTimes(1);
    expect(res2.statusCode).toBe(0);
  });

  it('BUG 2: the lease is released on res "finish" (non-streaming handler that completes)', async () => {
    const ledger = new InMemoryChannelLedger();
    const middleware = mw(ledger);

    const { req: req1, res: res1 } = fakeReqRes(voucherHeader(CHANNEL, '1000'));
    const next1 = vi.fn();
    await middleware(req1, res1, next1);
    expect(next1).toHaveBeenCalledTimes(1);

    res1.emit('finish');
    await flushMicrotasks();

    const { req: req2, res: res2 } = fakeReqRes(voucherHeader(CHANNEL, '2000', 2));
    const next2 = vi.fn();
    await middleware(req2, res2, next2);
    expect(next2).toHaveBeenCalledTimes(1);
    expect(res2.statusCode).toBe(0);
  });
});
