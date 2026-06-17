/**
 * Express middleware for accepting OTS tab vouchers.
 *
 * Wire shape:
 *   - Buyer sends each paid request with header `X-Tab-Voucher: <base64-json>`
 *   - The voucher JSON is the SignedVoucher shape (payload + session pubkey +
 *     registration + signature)
 *   - On the FIRST voucher of a session, the middleware parses the
 *     registration, verifies it against the on-chain vault (one RPC call),
 *     and caches the result
 *   - On EVERY voucher, the middleware verifies the session-key signature
 *     and enforces scope (cap, expiry, counterparty, monotonicity)
 *   - The route handler reads `req.tab` and either runs a stream against it
 *     or rejects with 402 Payment Required
 *
 * The middleware never blocks on chain in the per-voucher hot path. The
 * one-time on-chain read is amortized across the entire session.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';

import type { SignedVoucher, HumanAmount, AtomicAmount } from '../types';
import type {
  SellerTab,
  TabMiddlewareOptions,
  VoucherStore,
} from './types';
import { InvalidVoucherError } from './types';

import {
  parseRegistration,
  verifyRegistrationOnChain,
  verifyVoucherSignature,
  enforceScope,
  type ParsedRegistration,
  InvalidRegistrationError,
  OnChainVerificationError,
  InvalidVoucherSignatureError,
  ScopeViolationError,
} from './verify';

import { InMemoryVoucherStore } from './voucher-store';
import { atomicToHuman, humanToAtomic } from '../tab';

// ── Augmented Express request type ─────────────────────────────────────

declare module 'express-serve-static-core' {
  interface Request {
    tab?: SellerTab;
  }
}

// ── Configuration ──────────────────────────────────────────────────────

export interface TabMiddlewareConfig extends TabMiddlewareOptions {
  /** RPC connection used for the one-time on-chain registration read. */
  connection: Connection;
  /** The seller's pubkey — used as allowed_counterparty for scope check. */
  sellerPubkey: string | PublicKey;
}

/** Header the buyer sends with each paid request. base64-encoded JSON of SignedVoucher. */
export const TAB_VOUCHER_HEADER = 'x-tab-voucher';

// ── Session cache ──────────────────────────────────────────────────────
//
// Per-process cache of (channelId → session info). Survives across many
// chunks of the same tab; cleared on revoke or process restart.

interface SessionCacheEntry {
  registration: ParsedRegistration;
  // Last accepted voucher's cumulative — used for monotonicity.
  lastCumulativeAtomic: AtomicAmount;
}

class SessionCache {
  private map = new Map<string, SessionCacheEntry>();
  get(channelId: string): SessionCacheEntry | undefined {
    return this.map.get(channelId);
  }
  set(channelId: string, entry: SessionCacheEntry): void {
    this.map.set(channelId, entry);
  }
  update(channelId: string, cumulative: AtomicAmount): void {
    const e = this.map.get(channelId);
    if (e) e.lastCumulativeAtomic = cumulative;
  }
  delete(channelId: string): void {
    this.map.delete(channelId);
  }
}

// ── SellerTab implementation ───────────────────────────────────────────

export class SellerTabImpl implements SellerTab {
  readonly channelId: string;
  readonly network: TabMiddlewareOptions['network'];
  sessionPublicKey: Uint8Array | null = null;
  private cumulativeAtomic: bigint;
  private deliveredBaselineAtomic: bigint;

  constructor(
    channelId: string,
    network: TabMiddlewareOptions['network'],
    initialCumulative: bigint,
    deliveredBaselineAtomic: bigint,
    private readonly recordDeliveredImpl: (cumulativeAtomic: string) => Promise<void>,
    private readonly chargeImpl: (incrementHuman: HumanAmount) => Promise<void>,
  ) {
    this.channelId = channelId;
    this.network = network;
    this.cumulativeAtomic = initialCumulative;
    this.deliveredBaselineAtomic = deliveredBaselineAtomic;
  }

  cumulative(): HumanAmount {
    return atomicToHuman(this.cumulativeAtomic.toString());
  }

  deliveredCumulative(): HumanAmount {
    return atomicToHuman(this.deliveredBaselineAtomic.toString());
  }

  async recordDelivered(cumulativeAtomic: AtomicAmount): Promise<void> {
    return this.recordDeliveredImpl(cumulativeAtomic);
  }

  bumpCumulative(toAtomic: bigint): void {
    this.cumulativeAtomic = toAtomic;
  }

  setSessionPublicKey(pk: Uint8Array): void {
    this.sessionPublicKey = pk;
  }

  async charge(incrementHuman: HumanAmount): Promise<void> {
    return this.chargeImpl(incrementHuman);
  }
}

// ── Voucher decoding ───────────────────────────────────────────────────

function decodeVoucherHeader(header: unknown): SignedVoucher {
  if (typeof header !== 'string' || header.length === 0) {
    throw new InvalidVoucherError('signature_invalid', `missing ${TAB_VOUCHER_HEADER} header`);
  }
  let json: string;
  try {
    json = Buffer.from(header, 'base64').toString('utf8');
  } catch {
    throw new InvalidVoucherError('signature_invalid', 'malformed base64');
  }
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidVoucherError('signature_invalid', 'malformed JSON');
  }
  // Light shape check; the verifier rejects deeper malformations.
  if (!parsed || typeof parsed !== 'object' || !parsed.payload || !parsed.sessionPublicKey) {
    throw new InvalidVoucherError('signature_invalid', 'missing required fields');
  }
  return {
    payload: parsed.payload,
    sessionPublicKey: hexToBytes(parsed.sessionPublicKey),
    sessionRegistration: hexToBytes(parsed.sessionRegistration),
    sessionSignature: hexToBytes(parsed.sessionSignature),
  };
}

function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new InvalidVoucherError('signature_invalid', `bad hex: ${typeof hex}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

// ── Channel id reconstruction ──────────────────────────────────────────
//
// The voucher's payload.channelId is the canonical hex string the buyer
// derived. The signature was over the 32 raw bytes of that id (the
// voucherPayloadMessage encodes it). We just hex-decode.

function channelIdHexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new InvalidVoucherError(
      'signature_invalid',
      `channelId must be 64-char hex, got "${hex}"`,
    );
  }
  return hexToBytes(hex);
}

// ── The middleware ─────────────────────────────────────────────────────

export function tabMiddleware(config: TabMiddlewareConfig): RequestHandler {
  const store: VoucherStore = config.store ?? new InMemoryVoucherStore();
  const cache = new SessionCache();
  const sellerPubkey =
    typeof config.sellerPubkey === 'string'
      ? new PublicKey(config.sellerPubkey)
      : config.sellerPubkey;

  const maxPerVoucherAtomic = config.maxPerVoucherAtomic
    ? BigInt(config.maxPerVoucherAtomic)
    : BigInt(humanToAtomic(config.perUnit)) * 100n;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1. Decode the voucher off the header.
      const voucher = decodeVoucherHeader(req.headers[TAB_VOUCHER_HEADER]);
      const channelId = voucher.payload.channelId;
      const channelIdBytes = channelIdHexToBytes(channelId);

      // 2. Look up (or build) the session entry.
      let entry = cache.get(channelId);
      if (!entry) {
        // First voucher for this channel — parse + verify the registration.
        const parsed = parseRegistration(voucher.sessionRegistration);
        await verifyRegistrationOnChain(config.connection, parsed);
        entry = {
          registration: parsed,
          lastCumulativeAtomic: '0',
        };
        cache.set(channelId, entry);
      }

      // 3. Verify the voucher signature over the canonical message.
      verifyVoucherSignature(voucher, channelIdBytes);

      // 4. Enforce scope: cap, expiry, counterparty, monotonicity.
      enforceScope({
        registration: entry.registration,
        voucher,
        expectedCounterparty: sellerPubkey,
        previousCumulativeAtomic: entry.lastCumulativeAtomic,
      });

      // 5. Bound per-voucher increment. Protects against a giant single
      //    voucher slipping through; the buyer's perUnitCap should prevent
      //    this from the client side but the seller still defends.
      const cumulative = BigInt(voucher.payload.cumulativeAmount);
      const previous = BigInt(entry.lastCumulativeAtomic);
      const increment = cumulative - previous;
      if (increment > maxPerVoucherAtomic) {
        throw new ScopeViolationError(
          'cumulative_exceeds_cap',
          `single voucher increment ${increment} exceeds maxPerVoucherAtomic ${maxPerVoucherAtomic}`,
        );
      }

      // 6. Persist the voucher (so a crash doesn't lose the latest claim).
      await store.set(channelId, voucher);

      // 7. Update cache and attach the SellerTab to the request.
      cache.update(channelId, voucher.payload.cumulativeAmount);
      const tab = new SellerTabImpl(
        channelId,
        config.network,
        cumulative,
        async (_inc) => {
          // The route handler can't `charge()` after-the-fact in this
          // architecture — vouchers are presented by the buyer per chunk.
          // We leave a stub so the SellerTab shape is satisfied; phase 4
          // (SSE meter) implements a different surface that demands a
          // voucher before delivering each chunk.
          throw new Error(
            'SellerTab.charge() is not driven by the route handler; the buyer ' +
            'presents a fresh voucher per chunk. Use openSse(res, tab) for the ' +
            'metered-stream pattern.',
          );
        },
      );
      tab.setSessionPublicKey(voucher.sessionPublicKey);
      req.tab = tab;
      next();
    } catch (err) {
      // Map our internal errors to 402 with a structured body.
      if (
        err instanceof InvalidVoucherError ||
        err instanceof InvalidRegistrationError ||
        err instanceof OnChainVerificationError ||
        err instanceof InvalidVoucherSignatureError ||
        err instanceof ScopeViolationError
      ) {
        res.status(402).json({
          error: 'invalid_voucher',
          reason: (err as any).reason ?? 'unknown',
          detail: err.message,
        });
        return;
      }
      next(err);
    }
  };
}

/** Pull the SellerTab off a request. Throws if the middleware didn't run. */
export function requireTab(req: Request): SellerTab {
  if (!req.tab) {
    throw new Error('req.tab is missing — did tabMiddleware run on this route?');
  }
  return req.tab;
}
