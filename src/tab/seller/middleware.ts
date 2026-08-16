/**
 * Express middleware for accepting OTS tab vouchers.
 *
 * Wire shape:
 *   - Buyer sends each paid request with header `X-Tab-Voucher: <base64-json>`
 *   - The envelope contains the SignedVoucher fields (payload + session pubkey
 *     + registration + signature). V2 additionally carries the complete
 *     FinalVoucherV2ReservationReceipt used only as an untrusted proof locator.
 *   - On the FIRST V1 voucher of a session, the middleware parses the
 *     registration, verifies it against the on-chain vault (one RPC call),
 *     and caches the result. V2 independently reads the exact reservation
 *     transaction and its coherent SessionAccount post-state on EVERY voucher.
 *   - On EVERY voucher, the middleware verifies the session-key signature
 *     and enforces scope (cap, expiry, counterparty, monotonicity)
 *   - The route handler reads `req.tab` and either runs a stream against it
 *     or rejects with 402 Payment Required
 *
 * Historical V1 keeps the cached, no-chain hot path. Native Tab V2 deliberately
 * performs confirmed registration/reservation admission on every voucher and
 * independently proves the exact authority-signed settle + Memo before delivery.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';

import type {
  SignedVoucher,
  HumanAmount,
  AtomicAmount,
  FinalVoucherV2ReservationReceipt,
} from '../types';
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
  nativeTabWireVersion,
  type ParsedRegistration,
  type OnChainSessionFrontier,
  InvalidRegistrationError,
  OnChainVerificationError,
  InvalidVoucherSignatureError,
  ScopeViolationError,
} from './verify';

import { InMemoryChannelLedger, withChannelLock, type ChannelLedger, type ChannelLedgerEntry } from './channel-ledger';
import { atomicToHuman, humanToAtomic, DEFAULT_FACILITATOR_URL } from '../tab';
import { finalVoucherV2ReservationIdentity } from '../reservation';
import {
  SolanaFinalVoucherV2ReservationError,
  inspectSolanaFinalVoucherV2Reservation,
} from '../adapters/solana/reservation-verifier';
import { deriveSessionPda } from '@dexterai/vault/session';
import { maybeCrystallize, crystallizeNow, isGateRefused, type LockCadence } from './crystallize';

// ── Augmented Express request type ─────────────────────────────────────

declare module 'express-serve-static-core' {
  interface Request {
    tab?: SellerTab;
  }
}

// ── Configuration ──────────────────────────────────────────────────────

export interface TabMiddlewareConfig extends TabMiddlewareOptions {
  /** RPC connection used once for V1 registration and per voucher for V2. */
  connection: Connection;
  /** The seller's pubkey — used as allowed_counterparty for scope check. */
  sellerPubkey: string | PublicKey;
}

/** Header the buyer sends with each paid request. Base64 JSON voucher envelope. */
export const TAB_VOUCHER_HEADER = 'x-tab-voucher';

// ── Session cache ──────────────────────────────────────────────────────
//
// Per-process cache of (channelId → session info). Survives across many
// chunks of the same tab; cleared on revoke or process restart.

interface SessionCacheEntry {
  registration: ParsedRegistration;
  /** Exact 188-byte on-chain witness accepted for this channel. Every later
   * voucher must carry the same bytes; a channel id alone is not identity. */
  registrationBytes: Uint8Array;
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
  deleteIfSame(channelId: string, entry: SessionCacheEntry): void {
    if (this.map.get(channelId) === entry) this.map.delete(channelId);
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

interface DecodedVoucherHeader {
  voucher: SignedVoucher;
  reservationReceipt: unknown;
}

function decodeVoucherHeader(header: unknown): DecodedVoucherHeader {
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
    voucher: {
      payload: parsed.payload,
      sessionPublicKey: hexToBytes(parsed.sessionPublicKey),
      sessionRegistration: hexToBytes(parsed.sessionRegistration),
      sessionSignature: hexToBytes(parsed.sessionSignature),
    },
    reservationReceipt: parsed.reservationReceipt,
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
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR_URL;
  const lockCadence: LockCadence = {
    thresholdAtomic: config.lockCadence?.thresholdAtomic ?? humanToAtomic('0.10'),
    onClose: config.lockCadence?.onClose ?? true,
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    let provisionalV2CacheEntry: {
      channelId: string;
      entry: SessionCacheEntry;
    } | null = null;
    try {
      // 1. Decode the voucher off the header.
      const decoded = decodeVoucherHeader(req.headers[TAB_VOUCHER_HEADER]);
      const voucher = decoded.voucher;
      const channelId = voucher.payload.channelId;
      const channelIdBytes = channelIdHexToBytes(channelId);

      // 2. Look up (or build) the session entry.
      let entry = cache.get(channelId);
      // Chain frontier (max(spent, crystallized)) read as a by-product of the
      // registration check. Historical V1 reads it only on the first voucher;
      // V2 refreshes it on every voucher together with currentOutstanding.
      let chainFrontierAtomic: string | null = null;
      let onChain: OnChainSessionFrontier | undefined;
      let cacheEntryAfterV2Admission = false;
      if (!entry) {
        // First voucher for this channel. Historical V1 verifies the
        // registration directly. V2 defers caching until its exact confirmed
        // transaction + post-state proof and every local static scope check
        // succeed, so a rejected request cannot poison the process cache for
        // a legitimate channel.
        const parsed = parseRegistration(voucher.sessionRegistration);
        if (nativeTabWireVersion(parsed.nonce) === 1) {
          onChain = await verifyRegistrationOnChain(config.connection, parsed);
          // Defensive `?.`: custom/mocked verifiers may still return void.
          chainFrontierAtomic = onChain?.frontierAtomic ?? null;
        } else {
          cacheEntryAfterV2Admission = true;
        }
        // Seed the monotonicity/increment baseline from the durable ledger's
        // last accepted voucher. Without this, a restarted process treats a
        // long-lived tab's full lifetime cumulative as a single voucher
        // increment (false cumulative_exceeds_cap) and would accept replays
        // of pre-restart vouchers.
        const persisted = await ledger.get(channelId);
        entry = {
          registration: parsed,
          registrationBytes: voucher.sessionRegistration.slice(),
          lastCumulativeAtomic: persisted?.lastVoucher?.payload.cumulativeAmount ?? '0',
        };
        if (!cacheEntryAfterV2Admission) cache.set(channelId, entry);
      } else if (!sameBytes(entry.registrationBytes, voucher.sessionRegistration)) {
        // Cache hits must not turn the buyer-chosen channel id into an
        // authorization oracle. Without this exact binding, an attacker can
        // reuse a cached channel with a self-signed registration/key while
        // scope enforcement still reads the legitimate cached cap/seller.
        throw new InvalidVoucherSignatureError(
          'voucher registration does not match the channel\'s verified registration',
        );
      }

      const registrationWireVersion = nativeTabWireVersion(
        entry.registration.nonce,
      );
      const voucherWireVersion = nativeTabWireVersion(
        voucher.payload.sequenceNumber,
      );
      if (voucherWireVersion !== registrationWireVersion) {
        throw new InvalidVoucherError(
          'wire_version_mismatch',
          `voucher is V${voucherWireVersion}, active registration is V${registrationWireVersion}`,
        );
      }

      let reservationReceipt: FinalVoucherV2ReservationReceipt | undefined;
      if (registrationWireVersion === 2) {
        if (decoded.reservationReceipt === undefined) {
          throw new InvalidVoucherError(
            'reservation_proof_missing',
            'Native Tab V2 requires the verified reservation receipt in the voucher envelope',
          );
        }
        if (
          decoded.reservationReceipt === null
          || typeof decoded.reservationReceipt !== 'object'
          || Array.isArray(decoded.reservationReceipt)
        ) {
          throw new InvalidVoucherError(
            'reservation_proof_invalid',
            'reservationReceipt must be an object',
          );
        }
        reservationReceipt = decoded.reservationReceipt as
          FinalVoucherV2ReservationReceipt;
      }

      // 3. Verify the voucher signature over the canonical message.
      verifyVoucherSignature(voucher, channelIdBytes);

      const cumulative = BigInt(voucher.payload.cumulativeAmount);
      const previous = BigInt(entry.lastCumulativeAtomic);
      let authorizationBaseline = previous;
      let reservationDelta: bigint | null = null;

      if (registrationWireVersion === 2) {
        if (!reservationReceipt) {
          throw new InvalidVoucherError(
            'reservation_proof_missing',
            'Native Tab V2 reservation proof was not carried through admission',
          );
        }
        const claimedReservation = parseOnChainAtomic(
          reservationReceipt.reservationAmountAtomic,
          'receipt.reservationAmountAtomic',
        );
        if (claimedReservation <= 0n || claimedReservation > cumulative) {
          throw new InvalidVoucherError(
            'reservation_mismatch',
            'reservation amount does not fit the voucher cumulative',
          );
        }
        const claimedFrontier = cumulative - claimedReservation;
        const [sessionPda] = deriveSessionPda(
          entry.registration.vaultPda,
          entry.registration.allowedCounterparty,
          entry.registration.programId,
        );
        const identity = finalVoucherV2ReservationIdentity(voucher);
        try {
          const verification = await inspectSolanaFinalVoucherV2Reservation(
            config.connection,
            {
              network: config.network,
              programId: entry.registration.programId.toBase58(),
              buyerSwigAddress: reservationReceipt.buyerSwigAddress,
              vaultPda: entry.registration.vaultPda.toBase58(),
              sessionPda: sessionPda.toBase58(),
              seller: entry.registration.allowedCounterparty.toBase58(),
              channelId,
              sessionNonce: entry.registration.nonce,
              reservationAmountAtomic: claimedReservation.toString(),
              previousCumulativeAtomic: claimedFrontier.toString(),
              ...identity,
              voucher,
            },
            reservationReceipt,
          );
          onChain = verification;
          chainFrontierAtomic = verification.frontierAtomic;
        } catch (error) {
          if (error instanceof SolanaFinalVoucherV2ReservationError) {
            throw new InvalidVoucherError(
              'reservation_proof_invalid',
              error.message,
            );
          }
          throw error;
        }

        // V2 must fail closed if a custom verifier omits any authoritative
        // field. A reservation is exact: currentOutstanding covers only the
        // voucher delta above the greater of the seller's accepted cumulative
        // and the terminal chain frontier. Anything at/below that frontier is
        // already covered and cannot buy delivery again.
        if (onChain?.wireVersion !== 2) {
          throw new InvalidVoucherError(
            'wire_version_mismatch',
            `active SessionAccount is V${onChain?.wireVersion ?? 'unknown'}, voucher is V2`,
          );
        }
        if (
          onChain.sessionAccountVersion !== 1
          || chainFrontierAtomic === null
          || onChain.currentOutstandingAtomic === undefined
        ) {
          throw new InvalidVoucherError(
            'reservation_mismatch',
            'authoritative V2 SessionAccount reservation evidence is incomplete',
          );
        }
        const chainFrontier = parseOnChainAtomic(
          chainFrontierAtomic,
          'frontierAtomic',
        );
        if (chainFrontier > authorizationBaseline) {
          authorizationBaseline = chainFrontier;
        }
        if (cumulative <= authorizationBaseline) {
          throw new InvalidVoucherError(
            'voucher_already_covered',
            `cumulative ${cumulative} is not above covered frontier ${authorizationBaseline}`,
          );
        }
        reservationDelta = cumulative - authorizationBaseline;
        const currentOutstanding = parseOnChainAtomic(
          onChain.currentOutstandingAtomic,
          'currentOutstandingAtomic',
        );
        if (currentOutstanding !== reservationDelta) {
          throw new InvalidVoucherError(
            'reservation_mismatch',
            `currentOutstanding ${currentOutstanding} does not equal voucher delta ${reservationDelta}`,
          );
        }
        if (claimedReservation !== reservationDelta) {
          throw new InvalidVoucherError(
            'reservation_mismatch',
            `receipt reservation ${claimedReservation} does not equal voucher delta ${reservationDelta}`,
          );
        }
      }

      // 4. Enforce scope: cap, expiry, counterparty, monotonicity. V2 uses the
      // authoritative covered baseline; V1 retains its cached seller baseline.
      enforceScope({
        registration: entry.registration,
        voucher,
        expectedCounterparty: sellerPubkey,
        previousCumulativeAtomic: authorizationBaseline.toString(),
      });

      // 5. Bound per-voucher increment. Protects against a giant single
      //    voucher slipping through; the buyer's perUnitCap should prevent
      //    this from the client side but the seller still defends.
      const increment = cumulative - authorizationBaseline;
      if (increment > maxPerVoucherAtomic) {
        throw new ScopeViolationError(
          'cumulative_exceeds_cap',
          `single voucher increment ${increment} exceeds maxPerVoucherAtomic ${maxPerVoucherAtomic}`,
        );
      }

      // Re-read after all RPC awaits. A concurrently admitted winner may now
      // exist even though the cache was empty when this request began. Do not
      // bind a new entry yet: the durable lease must be acquired first.
      if (cacheEntryAfterV2Admission) {
        const winner = cache.get(channelId);
        if (winner) {
          if (!sameBytes(winner.registrationBytes, entry.registrationBytes)) {
            throw new InvalidVoucherSignatureError(
              'voucher registration lost the channel admission race to a different verified registration',
            );
          }
          // If the winner already advanced before this proof returned, reject
          // the stale calculation. A retry will start from the current cache
          // and durable-ledger baseline and re-prove the exact uncovered delta.
          if (
            BigInt(winner.lastCumulativeAtomic)
            > BigInt(entry.lastCumulativeAtomic)
          ) {
            throw new ScopeViolationError(
              'non_monotonic',
              'channel admission advanced while reservation proof was in flight',
            );
          }
          entry = winner;
        }
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

      // The durable lease serializes first-seen channel binding across all
      // requests sharing this ledger. Re-read once more after acquiring it,
      // then install only an exact provisional entry. If later durable ledger
      // I/O fails, the outer catch removes this exact object so a failed
      // admission cannot poison the process cache.
      if (cacheEntryAfterV2Admission) {
        const winner = cache.get(channelId);
        if (winner) {
          if (!sameBytes(winner.registrationBytes, entry.registrationBytes)) {
            await ledger.releaseLease(channelId);
            throw new InvalidVoucherSignatureError(
              'voucher registration lost the channel lease race to a different verified registration',
            );
          }
          entry = winner;
        } else {
          cache.set(channelId, entry);
          provisionalV2CacheEntry = { channelId, entry };
        }
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
        const refusedBefore = entry.gateRefusedCumulativeAtomic;
        await maybeCrystallize(entry, channelId, facilitatorUrl, config.network, lockCadence);
        if (
          entry.lastCrystallizedCumulativeAtomic !== before ||
          entry.gateRefusedCumulativeAtomic !== refusedBefore
        ) {
          // A lock landed (crystallized watermark advanced) OR the gate
          // refused it below-cadence (gate-refused watermark advanced, §5
          // A12) — persist BOTH under the lock so the next request reads
          // them and doesn't re-fire on the same span.
          await withChannelLock(channelId, async () => {
            const cur = await ledger.get(channelId);
            if (cur) {
              await ledger.set(channelId, {
                ...cur,
                lastCrystallizedCumulativeAtomic: entry.lastCrystallizedCumulativeAtomic,
                gateRefusedCumulativeAtomic: entry.gateRefusedCumulativeAtomic,
              });
            }
          }).catch((err) => {
            // LOUD (no-silent-fallbacks): the outcome watermark didn't
            // persist — the next request will re-attempt the same span and
            // draw a benign duplicate/below-cadence response.
            console.error(
              `[tab/seller] crystallize watermark persist FAILED channel=${channelId.slice(0, 16)}… ` +
                `(expect a benign duplicate/below-cadence warn on the next request):`,
              err,
            );
          });
        }
      };

      // At close: crystallize the channel's FINAL signed voucher exactly once if
      // the cadence wants it. We read `lastVoucher` from the ledger at close —
      // NOT a `delivered` snapshot — which sidesteps the close-handler ordering
      // problem entirely: `lastVoucher` is persisted during the request (step 6,
      // before next()), so it is already the final signed voucher at close
      // regardless of when the meter's own `persistDelivered` close handler
      // writes `delivered`. We crystallize that voucher and advance the watermark
      // to ITS cumulative (FIX C1/C2), so the watermark is truthful and never
      // lies about a delivered span the lock didn't actually secure.
      //
      // Fully best-effort: detached + swallows all errors. The `closeCrystallized`
      // flag is INDEPENDENT of `leaseReleased` — they guard different concerns and
      // must not be merged. Both handlers are registered on the same events; the
      // bodies are detached and run concurrently, so the lease release
      // (`releaseOnce`, registered earlier) is not gated on this crystallize.
      let closeCrystallized = false;
      const crystallizeOnClose = () => {
        if (!lockCadence.onClose || closeCrystallized) return;
        closeCrystallized = true;
        void (async () => {
          const cur = await ledger.get(channelId);
          if (!cur || !cur.lastVoucher) return;
          // The cumulative we will lock is the FINAL signed voucher's — captured
          // before the POST so a later mutation can't shift the watermark.
          const lockedCumulative = cur.lastVoucher.payload.cumulativeAmount;
          // [A12] The gate already refused this exact span below-cadence —
          // re-asking on every response close is the same retry storm the
          // gate-refused watermark exists to stop. A HIGHER final voucher
          // always re-attempts; the engine guarantees the cadence meanwhile.
          if (
            cur.gateRefusedCumulativeAtomic !== undefined &&
            BigInt(lockedCumulative) <= BigInt(cur.gateRefusedCumulativeAtomic)
          ) {
            return;
          }
          const result = await crystallizeNow(cur, channelId, facilitatorUrl, config.network);
          if (result.crystallized) {
            await withChannelLock(channelId, async () => {
              const latest = await ledger.get(channelId);
              if (latest) {
                await ledger.set(channelId, {
                  ...latest,
                  lastCrystallizedCumulativeAtomic: lockedCumulative,
                  // A landed lock supersedes any stale refusal record.
                  gateRefusedCumulativeAtomic: undefined,
                });
              }
            });
          } else if (isGateRefused(result.error)) {
            // Record the below-cadence refusal so later closes/deliveries of
            // the SAME span stay quiet (§5 A12). Benign — logged once by
            // crystallizeNow's outcome table.
            await withChannelLock(channelId, async () => {
              const latest = await ledger.get(channelId);
              if (latest) {
                await ledger.set(channelId, {
                  ...latest,
                  gateRefusedCumulativeAtomic: lockedCumulative,
                });
              }
            });
          }
        })().catch((err) => {
          // LOUD (no-silent-fallbacks): the close-path crystallize is the last
          // chance to secure this request's final voucher — a crash here means
          // the seller's exposure stays unsecured with no on-chain claim.
          console.error(
            `[tab/seller] close-path crystallize CRASHED channel=${channelId.slice(0, 16)}… ` +
              `(final voucher NOT locked; exposure unsecured until the next request retries):`,
            err,
          );
        });
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
      // A ledger entry is FRESH when it has never seen a voucher or delivery —
      // tryAcquireLease auto-creates zeroed entries, so `prior != null` alone
      // does not mean history exists. V1 retains the historical fresh-only
      // seed. V2 advances even an existing ledger's delivery floor when the
      // authoritative chain frontier has moved, preventing another process's
      // already-settled delivery from becoming fresh budget here.
      const priorDelivered = BigInt(prior?.deliveredCumulativeAtomic ?? '0');
      const priorIsFresh = !prior?.lastVoucher && priorDelivered === 0n;
      const frontier = chainFrontierAtomic === null
        ? null
        : BigInt(chainFrontierAtomic);
      const seedAtomic = frontier !== null && frontier > priorDelivered && (
        registrationWireVersion === 2 || priorIsFresh
      )
        ? frontier.toString()
        : null;
      if (seedAtomic !== null) {
        console.info(
          `[tab/seller] channel ${channelId.slice(0, 16)}… resumed: seeding delivered ` +
            `baseline from chain frontier ${seedAtomic} (session already settled/locked ` +
            `up to it — that span is not deliverable budget)`,
        );
      }
      const deliveredBaselineAtomic =
        seedAtomic !== null
          ? BigInt(seedAtomic)
          : prior
            ? BigInt(prior.deliveredCumulativeAtomic)
            : 0n;
      await withChannelLock(channelId, async () => {
        const cur = await ledger.get(channelId);
        await ledger.set(channelId, {
          ...cur,
          lastVoucher: voucher,
          deliveredCumulativeAtomic:
            seedAtomic ?? (cur ? cur.deliveredCumulativeAtomic : '0'),
          // Seed the crystallization watermark too: locks below the frontier
          // are unlockable (facilitator 409s), so the un-crystallized span
          // starts at zero on a resume.
          lastCrystallizedCumulativeAtomic:
            seedAtomic ?? cur?.lastCrystallizedCumulativeAtomic ?? '0',
        });
      });
      provisionalV2CacheEntry = null;

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
            void crystallizeCadence(updated).catch((err) => {
              // LOUD (no-silent-fallbacks): the threshold cadence crashed
              // before it could even attempt the lock POST.
              console.error(
                `[tab/seller] crystallize cadence CRASHED channel=${channelId.slice(0, 16)}… ` +
                  `(threshold lock not attempted; retries at the next delivery):`,
                err,
              );
            });
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
      if (provisionalV2CacheEntry) {
        cache.deleteIfSame(
          provisionalV2CacheEntry.channelId,
          provisionalV2CacheEntry.entry,
        );
      }
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

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function parseOnChainAtomic(value: string, field: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new InvalidVoucherError(
      'reservation_mismatch',
      `authoritative ${field} is not a canonical atomic amount`,
    );
  }
  return BigInt(value);
}

/** Pull the SellerTab off a request. Throws if the middleware didn't run. */
export function requireTab(req: Request): SellerTab {
  if (!req.tab) {
    throw new Error('req.tab is missing — did tabMiddleware run on this route?');
  }
  return req.tab;
}
