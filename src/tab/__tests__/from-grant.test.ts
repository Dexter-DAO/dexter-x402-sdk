// src/tab/__tests__/from-grant.test.ts
/**
 * tabFromGrant — the buyer-side tab constructor for a GRANTED session key
 * (the /tabs/connect ceremony's custody modes i/ii). What openTab does minus
 * the passkey step: the grant ceremony already registered the session on
 * chain; tabFromGrant rebuilds the 188-byte registration from the consented
 * params, reads the on-chain frontier, arms drain protection, and returns a
 * Tab whose cumulative odometer resumes ABOVE everything the chain has
 * already terminally counted.
 *
 * Verification oracles are REAL, not mirrored constants:
 *  - the registration byte-exactness test compares against
 *    @dexterai/vault/grant's own approveSpendGrant().message
 *  - the wire round-trip test runs the actual seller tabMiddleware
 *    (base64/hex decode, parseRegistration, on-chain verify, ed25519,
 *    enforceScope) against a faked RPC serving a real-layout SessionAccount
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import nacl from 'tweetnacl';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { requestSpendGrant, approveSpendGrant, type ApprovedSpendGrantParams } from '@dexterai/vault/grant';
import { deriveSessionPda } from '@dexterai/vault/session';

import { tabFromGrant, type TabFromGrantOptions } from '../from-grant';
import { voucherToHeader } from '../tab';
import { DEXTER_VAULT_PROGRAM_ID } from '../instructions';
import { sessionRegisterMessage } from '../messages';
import { signVoucher } from '../sessions';
import { finalizedReservationReceipt } from './reservation-fixture';
import { verifySolanaFinalVoucherV2Reservation } from '../adapters/solana/reservation-verifier';
import { parseRegistration, verifyVoucherSignature } from '../seller/verify';
import { tabMiddleware } from '../seller/middleware';
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
} from 'express';

vi.mock('../adapters/solana/reservation-verifier', () => ({
  verifySolanaFinalVoucherV2Reservation: vi.fn(async () => undefined),
}));

// ── Fixtures ───────────────────────────────────────────────────────────

const VAULT = Keypair.generate().publicKey;
const SELLER = Keypair.generate().publicKey; // counterparty (settlement pubkey)
const SWIG = Keypair.generate().publicKey.toBase58();
const FAC = 'https://fac.test';

const NOW = Math.floor(Date.now() / 1000);

function grantParams(
  kp: nacl.SignKeyPair,
  over: Partial<ApprovedSpendGrantParams> = {},
): ApprovedSpendGrantParams {
  return {
    counterparty: SELLER.toBase58(),
    sessionPubkey: new PublicKey(kp.publicKey).toBase58(),
    maxAmountAtomic: '1000000', // 1 USDC
    expiresAtUnix: NOW + 3600,
    nonce: 0x8000_002a,
    maxRevolvingCapacityAtomic: '1000000',
    ...over,
  };
}

/** Real-layout 162-byte SessionAccount (vault dist/session decode.ts contract). */
function sessionAccountData(args: {
  params: ApprovedSpendGrantParams;
  vault?: PublicKey;
  sessionPubkey?: Uint8Array;
  version?: number;
  spent?: bigint;
  currentOutstanding?: bigint;
  crystallized?: bigint;
  lastLockedSequence?: number;
  maxAmountOnChain?: bigint;
  expiresAtOnChain?: number;
}): Buffer {
  const buf = Buffer.alloc(162);
  // Anchor discriminator for SessionAccount (vault dist/session).
  Buffer.from([74, 34, 65, 133, 96, 163, 80, 69]).copy(buf, 0);
  buf.writeUInt8(args.version ?? 1, 8);
  buf.writeUInt8(255, 9); // bump
  (args.vault ?? VAULT).toBuffer().copy(buf, 10);
  Buffer.from(args.sessionPubkey ?? new PublicKey(args.params.sessionPubkey).toBytes()).copy(buf, 42);
  buf.writeBigUInt64LE(args.maxAmountOnChain ?? BigInt(args.params.maxAmountAtomic), 74);
  buf.writeBigInt64LE(BigInt(args.expiresAtOnChain ?? args.params.expiresAtUnix), 82);
  new PublicKey(args.params.counterparty).toBuffer().copy(buf, 90);
  buf.writeUInt32LE(args.params.nonce, 122);
  buf.writeBigUInt64LE(args.spent ?? 0n, 126);
  buf.writeBigUInt64LE(args.currentOutstanding ?? 0n, 134);
  buf.writeBigUInt64LE(BigInt(args.params.maxRevolvingCapacityAtomic), 142);
  buf.writeBigUInt64LE(args.crystallized ?? 0n, 150);
  buf.writeUInt32LE(args.lastLockedSequence ?? 0, 158);
  return buf;
}

/** Vault account (readVaultFull contract): version@8, swig_address@43..75. */
function vaultAccountData(swigAddress: string): Buffer {
  const buf = Buffer.alloc(150);
  Buffer.from([211, 8, 232, 43, 2, 152, 117, 119]).copy(buf, 0);
  buf.writeUInt8(6, 8); // version
  new PublicKey(swigAddress).toBuffer().copy(buf, 43);
  return buf;
}

function sessionPdaFor(params: ApprovedSpendGrantParams): PublicKey {
  return deriveSessionPda(VAULT, new PublicKey(params.counterparty))[0];
}

/** Minimal Connection double: serves getAccountInfo from a base58→Buffer map. */
function fakeConnection(accounts: Map<string, Buffer>): Connection & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    getAccountInfo: async (pda: PublicKey) => {
      reads.push(pda.toBase58());
      const data = accounts.get(pda.toBase58());
      return data
        ? {
            data,
            owner: DEXTER_VAULT_PROGRAM_ID,
            executable: false,
            lamports: 1,
            rentEpoch: 0,
          }
        : null;
    },
  } as unknown as Connection & { reads: string[] };
}

function connFor(params: ApprovedSpendGrantParams, data?: Buffer, extra?: Array<[string, Buffer]>) {
  const map = new Map<string, Buffer>(extra ?? []);
  if (data) map.set(sessionPdaFor(params).toBase58(), data);
  return fakeConnection(map);
}

/** Routes fetch by URL suffix; records JSON bodies. */
function stubFetchRouter(overrides: Record<string, () => Response> = {}) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchMock = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const suffix of Object.keys(overrides)) {
      if (u.endsWith(suffix)) return overrides[suffix]();
    }
    if (u.endsWith('/tab/open')) {
      return jsonResponse({ success: true, armed: true, signature: 'ARM_SIG' });
    }
    if (u.endsWith('/tab/settle')) {
      return jsonResponse({ settleTx: 'SETTLE_TX' });
    }
    if (u.endsWith('/tab/lock')) {
      return jsonResponse({ success: true });
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function baseOptions(
  kp: nacl.SignKeyPair,
  params: ApprovedSpendGrantParams,
  conn: Connection,
): TabFromGrantOptions {
  return {
    sessionSecretKey: kp.secretKey,
    params,
    vaultPda: VAULT,
    connection: conn,
    swigAddress: SWIG,
    perUnitCapAtomic: '5000',
    facilitatorUrl: FAC,
    reserveFinalVoucherV2: async input => finalizedReservationReceipt(input),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(verifySolanaFinalVoucherV2Reservation).mockClear();
});

// ── 1. Registration byte-exactness vs the grant ceremony's own output ──

describe('tabFromGrant — registration rebuild', () => {
  it('rebuilds the 188-byte registration byte-for-byte from approveSpendGrant output', async () => {
    const { calls } = stubFetchRouter();
    const kp = nacl.sign.keyPair();

    // The REAL grant ceremony (custody mode i, injected recorder sign fn).
    const request = requestSpendGrant({
      app: { name: 'Test App', domain: 'test.example' },
      counterparty: SELLER.toBase58(),
      capAtomic: '1000000',
      expiresAtUnix: NOW + 3600,
    });
    const grant = await approveSpendGrant({
      request,
      vaultPda: VAULT,
      sign: async (message) => ({ signedBytes: message }),
      authorizationNonce: 42n,
      sessionKeypair: { publicKey: kp.publicKey, privateKey: kp.secretKey },
    });

    const conn = connFor(grant.params, sessionAccountData({ params: grant.params }));
    const reserveFinalVoucherV2 = vi.fn(async (input) => (
      finalizedReservationReceipt(input)
    ));
    const tab = await tabFromGrant({
      ...baseOptions(kp, grant.params, conn),
      reserveFinalVoucherV2,
    });
    const voucher = await tab.signNextVoucher('5000');

    // Byte-exact against the ceremony's own signed message.
    expect(Buffer.from(voucher.sessionRegistration).equals(Buffer.from(grant.message))).toBe(true);

    // And the SELLER's own parser accepts + extracts the same scope.
    const parsed = parseRegistration(voucher.sessionRegistration);
    expect(parsed.vaultPda.equals(VAULT)).toBe(true);
    expect(parsed.allowedCounterparty.toBase58()).toBe(SELLER.toBase58());
    expect(parsed.maxAmount).toBe(1000000n);
    expect(parsed.nonce).toBe(0x8000_0000 + 42);
    expect(Buffer.from(parsed.sessionPubkey).equals(Buffer.from(kp.publicKey))).toBe(true);
    expect(voucher.payload.sequenceNumber).toBe(0x8000_0001);
    expect(reserveFinalVoucherV2).toHaveBeenCalledOnce();
    expect(verifySolanaFinalVoucherV2Reservation).toHaveBeenCalledOnce();
    expect(reserveFinalVoucherV2).toHaveBeenCalledWith(expect.objectContaining({
      buyerSwigAddress: SWIG,
      vaultPda: VAULT.toBase58(),
      seller: SELLER.toBase58(),
      sessionNonce: 0x8000_0000 + 42,
      reservationAmountAtomic: '5000',
      previousCumulativeAtomic: '0',
      voucher,
    }));
    expect(calls.some((call) => call.url === `${FAC}/tab/open`)).toBe(false);
  });

  it('refuses a V2 grant without a durable reservation fence before any I/O', async () => {
    const { fetchMock } = stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp, { nonce: 0x8000_002a });
    const conn = connFor(params, sessionAccountData({ params }));

    const options = baseOptions(kp, params, conn);
    delete options.reserveFinalVoucherV2;
    await expect(tabFromGrant(options)).rejects.toThrow(
      /native_tab_v2_reservation_fence_required/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect((conn as any).reads).toHaveLength(0);
  });

  it('retries the exact same FINAL voucher after an ambiguous reservation failure', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp, { nonce: 0x8000_002a });
    const conn = connFor(params, sessionAccountData({ params }));
    const reserved: Array<import('../types').FinalVoucherV2ReservationInput> = [];
    const reserveFinalVoucherV2 = vi.fn(async (input) => {
      reserved.push(input);
      if (reserved.length === 1) throw new Error('reservation_timeout_unknown');
      return finalizedReservationReceipt(input);
    });
    const tab = await tabFromGrant({
      ...baseOptions(kp, params, conn),
      reserveFinalVoucherV2,
    });

    await expect(tab.signNextVoucher('5000')).rejects.toThrow(
      /reservation_timeout_unknown/,
    );
    expect(tab.state.spent).toBe('0');

    const voucher = await tab.signNextVoucher('5000');
    expect(voucher.payload.sequenceNumber).toBe(0x8000_0001);
    expect(reserved).toHaveLength(2);
    expect(voucherToHeader(reserved[1].voucher)).toBe(
      voucherToHeader(reserved[0].voucher),
    );
    expect(voucherToHeader(voucher)).toBe(voucherToHeader(reserved[0].voucher));
    expect((tab as any).rollbackVoucher(voucher)).toBe(false);
  });

  it('refuses a new FINAL voucher while the V2 session has an outstanding claim', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp, { nonce: 0x8000_002a });
    const conn = connFor(
      params,
      sessionAccountData({ params, currentOutstanding: 5000n }),
    );

    await expect(tabFromGrant({
      ...baseOptions(kp, params, conn),
      reserveFinalVoucherV2: async (input) => finalizedReservationReceipt(input),
    })).rejects.toThrow(/native_tab_v2_reservation_pending/);
  });
});

// ── 2. Frontier math ───────────────────────────────────────────────────

describe('tabFromGrant — chain-frontier resume', () => {
  it('starts at 0 on a fresh session (spent=0, crystallized=0)', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params }));

    const tab = await tabFromGrant(baseOptions(kp, params, conn));
    expect(tab.state.spent).toBe('0');

    const v = await tab.signNextVoucher('5000');
    expect(v.payload.cumulativeAmount).toBe('5000');
    expect(v.payload.sequenceNumber).toBe(0x8000_0001);
  });

  it('resumes above spent when spent > crystallized', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params, spent: 250000n, crystallized: 100000n }));

    const tab = await tabFromGrant(baseOptions(kp, params, conn));
    expect(tab.state.spent).toBe('0.25'); // odometer semantics: the session's lifetime cumulative

    const v = await tab.signNextVoucher('5000');
    // Strictly exceeds the frontier — the facilitator's non_monotonic_cumulative rule.
    expect(BigInt(v.payload.cumulativeAmount)).toBe(255000n);
    expect(BigInt(v.payload.cumulativeAmount) > 250000n).toBe(true);
  });

  it('resumes above crystallizedCumulative when crystallized > spent', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params, spent: 100000n, crystallized: 250000n }));

    const tab = await tabFromGrant(baseOptions(kp, params, conn));
    const v = await tab.signNextVoucher('5000');
    expect(BigInt(v.payload.cumulativeAmount)).toBe(255000n);
  });

  it('respects the remaining headroom: cap minus frontier', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params, spent: 998000n }));

    const tab = await tabFromGrant(baseOptions(kp, params, conn));
    expect(tab.state.remaining).toBe('0.002');
    // 2000 left under the cap: 5000 must refuse, 2000 must sign.
    await expect(tab.signNextVoucher('5000')).rejects.toThrow(/cap/);
    const v = await tab.signNextVoucher('2000');
    expect(BigInt(v.payload.cumulativeAmount)).toBe(1000000n);
  });

  it('rejects an exhausted tab (frontier >= cap) — no voucher can strictly exceed it', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params, spent: 1000000n }));

    await expect(tabFromGrant(baseOptions(kp, params, conn))).rejects.toThrow(/tab_exhausted/);
  });

  it('does not roll back a finalized V2 obligation from the frontier', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params, spent: 250000n }));

    const tab = await tabFromGrant(baseOptions(kp, params, conn));
    const first = await tab.signNextVoucher('5000');
    const rollback = (tab as any).rollbackVoucher(first);
    expect(rollback).toBe(false);
    expect(tab.state.spent).toBe('0.255');
  });
});

// ── 3. Key / params mismatch rejection ─────────────────────────────────

describe('tabFromGrant — key and params validation', () => {
  it('rejects a session key that does not match params.sessionPubkey, before ANY I/O', async () => {
    const { fetchMock } = stubFetchRouter();
    const rightKp = nacl.sign.keyPair();
    const wrongKp = nacl.sign.keyPair();
    const params = grantParams(rightKp);
    const conn = connFor(params, sessionAccountData({ params }));

    await expect(
      tabFromGrant({ ...baseOptions(wrongKp, params, conn) }),
    ).rejects.toThrow(/tab_session_key_mismatch/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((conn as any).reads).toHaveLength(0);
  });

  it('rejects a Frankenstein 64-byte secret whose embedded pubkey half matches but whose seed does not sign for it', async () => {
    stubFetchRouter();
    const rightKp = nacl.sign.keyPair();
    const wrongKp = nacl.sign.keyPair();
    const params = grantParams(rightKp);
    const conn = connFor(params, sessionAccountData({ params }));

    // seed half from the WRONG key, pubkey half from the RIGHT key —
    // exactly the cross-process key-mixup shape the self-check exists for.
    const franken = new Uint8Array(64);
    franken.set(wrongKp.secretKey.slice(0, 32), 0);
    franken.set(rightKp.publicKey, 32);

    await expect(
      tabFromGrant({ ...baseOptions(rightKp, params, conn), sessionSecretKey: franken }),
    ).rejects.toThrow(/tab_session_key_mismatch/);
  });

  it('accepts a 32-byte seed and derives the same signer', async () => {
    stubFetchRouter();
    const seed = nacl.randomBytes(32);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params }));

    const tab = await tabFromGrant({ ...baseOptions(kp, params, conn), sessionSecretKey: seed });
    const v = await tab.signNextVoucher('5000');
    // The production seller verifier checks the granted pubkey signature and
    // the complete V2 economic context.
    expect(() => verifyVoucherSignature(
      v,
      Uint8Array.from(Buffer.from(v.payload.channelId, 'hex')),
    )).not.toThrow();
  });

  it('rejects garbage key lengths', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params }));

    await expect(
      tabFromGrant({ ...baseOptions(kp, params, conn), sessionSecretKey: new Uint8Array(48) }),
    ).rejects.toThrow(/tab_session_key_invalid/);
  });

  it('rejects when the on-chain session carries a DIFFERENT session pubkey (grant was replaced)', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const other = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params, sessionPubkey: other.publicKey }));

    await expect(tabFromGrant(baseOptions(kp, params, conn))).rejects.toThrow(/tab_session_pubkey_mismatch/);
  });

  it('rejects when the handed-across params drift from the on-chain scope (stale cap)', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params, maxAmountOnChain: 900000n }));

    await expect(tabFromGrant(baseOptions(kp, params, conn))).rejects.toThrow(/tab_grant_params_stale/);
  });

  it('rejects a revoked/cleared session (version 0)', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params, version: 0 }));

    await expect(tabFromGrant(baseOptions(kp, params, conn))).rejects.toThrow(/tab_session_not_live/);
  });

  it('rejects a missing SessionAccount PDA', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params); // no account served

    await expect(tabFromGrant(baseOptions(kp, params, conn))).rejects.toThrow(/tab_session_not_live/);
  });

  it('rejects an expired session', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp, { expiresAtUnix: NOW - 10 });
    const conn = connFor(params, sessionAccountData({ params }));

    await expect(tabFromGrant(baseOptions(kp, params, conn))).rejects.toThrow(/tab_session_not_live/);
  });
});

// ── 4. Exact V2 reservation identity ──────────────────────────────────

describe('tabFromGrant — exact V2 reservation identity', () => {
  it('does not call the obsolete V1 /tab/open route', async () => {
    const { calls } = stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params }));

    const reserveFinalVoucherV2 = vi.fn(async input =>
      finalizedReservationReceipt(input));
    const tab = await tabFromGrant({
      ...baseOptions(kp, params, conn),
      reserveFinalVoucherV2,
    });
    await tab.signNextVoucher('5000');

    expect(calls.some(c => c.url === `${FAC}/tab/open`)).toBe(false);
    expect(reserveFinalVoucherV2).toHaveBeenCalledWith(expect.objectContaining({
      buyerSwigAddress: SWIG,
      seller: SELLER.toBase58(),
      reservationAmountAtomic: '5000',
    }));
  });

  it('reads swigAddress from the on-chain vault account for the V2 receipt', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const chainSwig = Keypair.generate().publicKey.toBase58();
    const conn = connFor(params, sessionAccountData({ params }), [
      [VAULT.toBase58(), vaultAccountData(chainSwig)],
    ]);

    const opts = baseOptions(kp, params, conn);
    delete opts.swigAddress;
    const reserveFinalVoucherV2 = vi.fn(async input =>
      finalizedReservationReceipt(input));
    opts.reserveFinalVoucherV2 = reserveFinalVoucherV2;
    const tab = await tabFromGrant(opts);
    await tab.signNextVoucher('5000');

    expect(reserveFinalVoucherV2).toHaveBeenCalledWith(expect.objectContaining({
      buyerSwigAddress: chainSwig,
    }));
  });
});

// ── 5. Wire round-trip through the REAL seller middleware ──────────────

describe('tabFromGrant — voucher satisfies the seller middleware (real oracle)', () => {
  it('passes a context-bound FINAL V2 voucher through the real seller verifier', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp, { nonce: 0x8000_002a });
    const conn = connFor(params, sessionAccountData({ params }));
    const tab = await tabFromGrant({
      ...baseOptions(kp, params, conn),
      reserveFinalVoucherV2: async (input) => finalizedReservationReceipt(input),
    });
    const mw = tabMiddleware({
      connection: conn,
      sellerPubkey: SELLER.toBase58(),
      perUnit: '0.005',
      network: 'solana:mainnet',
      settle: 'on-close',
      facilitatorUrl: FAC,
    });

    const voucher = await tab.signNextVoucher('5000');
    expect(voucher.payload.sequenceNumber).toBe(0x8000_0001);
    const req = fakeReq(voucherToHeader(voucher));
    const res = fakeRes();
    const next = vi.fn();
    await mw(
      req as unknown as ExpressRequest,
      res as unknown as ExpressResponse,
      next as NextFunction,
    );
    expect(res.statusCode).toBe(0);
    expect(next).toHaveBeenCalledOnce();
    expect(req.tab?.cumulative()).toBe('0.005');
  });

  it('streams two vouchers through tabMiddleware: decode + registration + on-chain + ed25519 + scope all pass', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const accountData = sessionAccountData({ params, spent: 250000n, crystallized: 100000n });
    const conn = connFor(params, accountData);

    const tab = await tabFromGrant(baseOptions(kp, params, conn));

    // One middleware instance across both requests: session cache + ledger persist.
    const mw = tabMiddleware({
      connection: conn,
      sellerPubkey: SELLER.toBase58(),
      perUnit: '0.005',
      network: 'solana:mainnet',
      settle: 'on-close',
      facilitatorUrl: FAC,
    });

    // Request 1 — first voucher, strictly above the resumed frontier.
    const v1 = await tab.signNextVoucher('5000');
    const req1 = fakeReq(voucherToHeader(v1));
    const res1 = fakeRes();
    const next1 = vi.fn();
    await mw(req1 as unknown as ExpressRequest, res1 as unknown as ExpressResponse, next1 as NextFunction);
    expect(res1.statusCode).toBe(0); // never rejected
    expect(next1).toHaveBeenCalledOnce();
    expect(req1.tab).toBeDefined();
    expect(req1.tab!.cumulative()).toBe('0.255');

    // Release the single-stream lease the way express does — response finished.
    res1.emit('finish');
    res1.emit('close');
    await new Promise((r) => setTimeout(r, 0));

    // Request 2 — monotonicity against the seller's cached cumulative.
    const v2 = await tab.signNextVoucher('5000');
    const req2 = fakeReq(voucherToHeader(v2));
    const res2 = fakeRes();
    const next2 = vi.fn();
    await mw(req2 as unknown as ExpressRequest, res2 as unknown as ExpressResponse, next2 as NextFunction);
    expect(res2.statusCode).toBe(0);
    expect(next2).toHaveBeenCalledOnce();
    expect(req2.tab!.cumulative()).toBe('0.26');
  });

  it('a REPLAYED voucher is rejected by the seller as non-monotonic', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params }));

    const tab = await tabFromGrant(baseOptions(kp, params, conn));
    const mw = tabMiddleware({
      connection: conn,
      sellerPubkey: SELLER.toBase58(),
      perUnit: '0.005',
      network: 'solana:mainnet',
      settle: 'on-close',
      facilitatorUrl: FAC,
    });

    const v = await tab.signNextVoucher('5000');
    const header = voucherToHeader(v);

    const res1 = fakeRes();
    await mw(fakeReq(header) as unknown as ExpressRequest, res1 as unknown as ExpressResponse, vi.fn() as NextFunction);
    expect(res1.statusCode).toBe(0);
    res1.emit('finish');
    await new Promise((r) => setTimeout(r, 0));

    // Same voucher again — cumulative not strictly greater → 402 non_monotonic.
    const res2 = fakeRes();
    await mw(fakeReq(header) as unknown as ExpressRequest, res2 as unknown as ExpressResponse, vi.fn() as NextFunction);
    expect(res2.statusCode).toBe(402);
    expect(res2.body).toMatchObject({ error: 'invalid_voucher', reason: 'non_monotonic' });
  });

  it('never lets a forged registration/key inherit a verified channel cache entry', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params }));
    const tab = await tabFromGrant(baseOptions(kp, params, conn));
    const mw = tabMiddleware({
      connection: conn,
      sellerPubkey: SELLER.toBase58(),
      perUnit: '0.005',
      network: 'solana:mainnet',
      settle: 'on-close',
      facilitatorUrl: FAC,
    });

    const legitimate = await tab.signNextVoucher('5000');
    const firstRes = fakeRes();
    await mw(
      fakeReq(voucherToHeader(legitimate)) as unknown as ExpressRequest,
      firstRes as unknown as ExpressResponse,
      vi.fn() as NextFunction,
    );
    expect(firstRes.statusCode).toBe(0);
    firstRes.emit('finish');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const attacker = nacl.sign.keyPair();
    const attackerRegistration = sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: VAULT,
      sessionPubkey: attacker.publicKey,
      maxAmount: 9_000_000n,
      expiresAt: BigInt(NOW + 3600),
      allowedCounterparty: SELLER,
      nonce: 99,
      maxRevolvingCapacity: 9_000_000n,
    });
    const forged = signVoucher({
      publicKey: attacker.publicKey,
      privateKey: attacker.secretKey,
      registration: attackerRegistration,
      scope: {
        channelId: legitimate.payload.channelId,
        maxAmountAtomic: '9000000',
        expiresAtUnix: NOW + 3600,
        allowedCounterparty: SELLER.toBase58(),
      },
    }, {
      channelId: legitimate.payload.channelId,
      cumulativeAmount: '10000',
      sequenceNumber: 2,
    }, Uint8Array.from(Buffer.from(legitimate.payload.channelId, 'hex')));
    const forgedRes = fakeRes();
    const forgedNext = vi.fn();
    await mw(
      fakeReq(voucherToHeader(forged)) as unknown as ExpressRequest,
      forgedRes as unknown as ExpressResponse,
      forgedNext as NextFunction,
    );
    expect(forgedRes.statusCode).toBe(402);
    expect(forgedNext).not.toHaveBeenCalled();
    expect(forgedRes.body).toMatchObject({
      error: 'invalid_voucher',
      reason: 'unknown',
      detail: expect.stringMatching(/verified registration/),
    });
  });
});

// ── 6. close() — settle-only (a grant holder cannot passkey-revoke) ────

describe('tabFromGrant — settle-only close', () => {
  it('close() POSTs the final voucher to /tab/settle, reports sessionRevoked=false, and closes the tab', async () => {
    const { calls } = stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params, spent: 250000n }));

    const tab = await tabFromGrant(baseOptions(kp, params, conn));
    const v = await tab.signNextVoucher('5000');
    const result = await tab.close();

    const settle = calls.find((c) => c.url === `${FAC}/tab/settle`);
    expect(settle).toBeDefined();
    expect(settle!.body).toMatchObject({
      channelId: v.payload.channelId,
      cumulativeAmount: '255000',
      sequenceNumber: 0x8000_0001,
      network: 'solana:mainnet',
    });
    // hex-encoded byte fields, exactly the /tab/settle wire shape
    expect(settle!.body.sessionPublicKey).toBe(Buffer.from(kp.publicKey).toString('hex'));
    expect(settle!.body.sessionRegistration).toHaveLength(188 * 2);
    expect(settle!.body.sessionSignature).toHaveLength(64 * 2);

    expect(result.settleTx).toBe('SETTLE_TX');
    expect(result.sessionRevoked).toBe(false); // honest: NO on-chain revoke happened
    await expect(tab.signNextVoucher('5000')).rejects.toThrow(/closed/i);
  });

  it('close() with zero vouchers signed settles nothing and still closes', async () => {
    const { calls } = stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params, spent: 250000n }));

    const tab = await tabFromGrant(baseOptions(kp, params, conn));
    const result = await tab.close();

    expect(calls.find((c) => c.url === `${FAC}/tab/settle`)).toBeUndefined();
    expect(result.settleTx).toBe('');
    expect(result.sessionRevoked).toBe(false);
  });
});

// ── 7. Option validation ───────────────────────────────────────────────

describe('tabFromGrant — option validation', () => {
  it('requires perUnitCapAtomic > 0', async () => {
    stubFetchRouter();
    const kp = nacl.sign.keyPair();
    const params = grantParams(kp);
    const conn = connFor(params, sessionAccountData({ params }));

    await expect(
      tabFromGrant({ ...baseOptions(kp, params, conn), perUnitCapAtomic: '0' }),
    ).rejects.toThrow(/perUnitCapAtomic/);
  });
});

// ── Test doubles for express ───────────────────────────────────────────

function fakeReq(voucherHeader: string) {
  return {
    headers: { 'x-tab-voucher': voucherHeader },
    tab: undefined as import('../seller/types').SellerTab | undefined,
  };
}

function fakeRes() {
  const handlers = new Map<string, Array<() => void>>();
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    on(event: string, fn: () => void) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    emit(event: string) {
      for (const fn of handlers.get(event) ?? []) fn();
    },
  };
  return res;
}
