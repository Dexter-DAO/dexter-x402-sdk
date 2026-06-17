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

import { InMemoryChannelLedger, withChannelLock, type ChannelLedger, type ChannelLedgerEntry } from './channel-ledger';
import { atomicToHuman, humanToAtomic } from '../tab';
import { maybeCrystallize, crystallizeNow, type LockCadence } from './crystallize';

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
  const ledger: ChannelLedger = config.ledger ?? new InMemoryChannelLedger();
  const cache = new SessionCache();
  const sellerPubkey =
    typeof config.sellerPubkey === 'string'
      ? new PublicKey(config.sellerPubkey)
      : config.sellerPubkey;

  const maxPerVoucherAtomic = config.maxPerVoucherAtomic
    ? BigInt(config.maxPerVoucherAtomic)
    : BigInt(humanToAtomic(config.perUnit)) * 100n;

  // Resolve the keyless crystallization cadence (Step-4 lock-mode). Defaults:
  // threshold 0.10 (atomic) and crystallize at close. All crystallize calls are
  // BEST-EFFORT — they never block, await-gate, or reject the response path.
  const facilitatorUrl = config.facilitatorUrl ?? 'https://facilitator.dexter.cash';
  const lockCadence: LockCadence = {
    thresholdAtomic: config.lockCadence?.thresholdAtomic ?? humanToAtomic('0.10'),
    onClose: config.lockCadence?.onClose ?? true,
  };

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

      // 5b. One live stream per channel: acquire the lease or reject. Closes the
      //     concurrent-same-channel over-delivery rug.
      const leaseTtlMs = config.leaseTtlMs ?? 300_000;
      if (!(await ledger.tryAcquireLease(channelId, leaseTtlMs))) {
        throw new InvalidVoucherError(
          'channel_busy',
          'another stream is live on this channel; tabs serve one stream at a time',
        );
      }

      // Release the lease when the response completes for ANY reason (stream end,
      // non-streaming response, handler error, client disconnect). Owned by the
      // request lifecycle, not the meter — a handler that never opens a meter
      // must not leak the lease for the whole TTL.
      let leaseReleased = false;
      const releaseOnce = () => {
        if (leaseReleased) return;
        leaseReleased = true;
        void ledger.releaseLease(channelId).catch((err) => {
          console.error('[tab/seller] failed to release channel lease:', err);
        });
      };
      res.on('close', releaseOnce);
      res.on('finish', releaseOnce);

      // Keyless crystallization (Step-4 lock-mode). Threshold-driven cadence,
      // invoked from the recordDelivered closure; persists any advance to the
      // ledger. BEST-EFFORT throughout — never throws, never gates the response.
      const crystallizeCadence = async (entry: ChannelLedgerEntry): Promise<void> => {
        const before = entry.lastCrystallizedCumulativeAtomic ?? '0';
        await maybeCrystallize(entry, channelId, facilitatorUrl, config.network, lockCadence);
        if (entry.lastCrystallizedCumulativeAtomic !== before) {
          // A lock landed — persist the advanced watermark under the lock so the
          // next request reads it and doesn't re-fire on the same delivered span.
          await withChannelLock(channelId, async () => {
            const cur = await ledger.get(channelId);
            if (cur) {
              await ledger.set(channelId, {
                ...cur,
                lastCrystallizedCumulativeAtomic: entry.lastCrystallizedCumulativeAtomic,
              });
            }
          }).catch(() => {});
        }
      };

      // At close: crystallize once if the cadence wants it. Fully best-effort —
      // detached, swallows all errors, and only runs after the lease release so
      // it never fights the existing close/finish lifecycle.
      let closeCrystallized = false;
      const crystallizeOnClose = () => {
        if (!lockCadence.onClose || closeCrystallized) return;
        closeCrystallized = true;
        void (async () => {
          const cur = await ledger.get(channelId);
          if (!cur) return;
          const result = await crystallizeNow(cur, channelId, facilitatorUrl, config.network);
          if (result.crystallized) {
            await withChannelLock(channelId, async () => {
              const latest = await ledger.get(channelId);
              if (latest) {
                await ledger.set(channelId, {
                  ...latest,
                  lastCrystallizedCumulativeAtomic: latest.deliveredCumulativeAtomic,
                });
              }
            });
          }
        })().catch(() => {});
      };
      res.on('close', crystallizeOnClose);
      res.on('finish', crystallizeOnClose);

      // 6. Read the durable delivered baseline for the budget, then persist the
      //    accepted voucher WITHOUT touching delivered (delivered only advances
      //    on the meter's terminal path). Locked so a concurrent request can't
      //    interleave a stale write. Spread `...cur` so we PRESERVE the lease (and
      //    onChain) we just acquired — omitting it would erase the lease one line
      //    after acquiring it, reopening the concurrent-same-channel rug.
      const prior = await ledger.get(channelId);
      const deliveredBaselineAtomic = prior ? BigInt(prior.deliveredCumulativeAtomic) : 0n;
      await withChannelLock(channelId, async () => {
        const cur = await ledger.get(channelId);
        await ledger.set(channelId, {
          ...cur,
          lastVoucher: voucher,
          deliveredCumulativeAtomic: cur ? cur.deliveredCumulativeAtomic : '0',
        });
      });

      // 7. Update the hot-path registration cache and attach the SellerTab.
      cache.update(channelId, voucher.payload.cumulativeAmount);
      const tab = new SellerTabImpl(
        channelId,
        config.network,
        cumulative,
        deliveredBaselineAtomic,
        // recordDelivered: the meter calls this on terminal events to persist
        // the new lifetime delivered cumulative. Spread `...cur` to PRESERVE the
        // lease (held by the request lifecycle until the response closes) and
        // onChain — omitting them would erase the lease mid-stream.
        async (incrementAtomic: string) => {
          let updated: ChannelLedgerEntry | null = null;
          await withChannelLock(channelId, async () => {
            const cur = await ledger.get(channelId);
            const base = cur ? BigInt(cur.deliveredCumulativeAtomic) : 0n;
            const inc = BigInt(incrementAtomic);
            const nextDelivered = inc > 0n ? base + inc : base; // monotonic, never backward
            const next: ChannelLedgerEntry = {
              ...cur,
              lastVoucher: cur?.lastVoucher ?? voucher,
              deliveredCumulativeAtomic: nextDelivered.toString(),
              lastCrystallizedCumulativeAtomic:
                cur?.lastCrystallizedCumulativeAtomic ?? '0',
            };
            await ledger.set(channelId, next);
            updated = next;
          });
          // Keyless crystallization cadence (Step-4). BEST-EFFORT: fire OUTSIDE
          // the channel lock so the network POST never serializes delivered
          // writes, and detach it so a slow/failed lock never blocks or rejects
          // the meter's terminal path. maybeCrystallize advances
          // `lastCrystallizedCumulativeAtomic` in memory on success; persist
          // that advance back so the next request doesn't re-fire.
          if (updated) {
            void crystallizeCadence(updated).catch(() => {});
          }
        },
        // charge stub (unchanged): the route handler doesn't drive charging.
        async (_inc) => {
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
