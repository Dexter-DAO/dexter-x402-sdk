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

import {
  ChannelLeaseLostError,
  InMemoryChannelLedger,
  normalizeLeaseTtlMs,
  type ChannelLedger,
  type ChannelLedgerEntry,
  type ChannelLedgerUpdater,
  type ChannelLease,
} from './channel-ledger';
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

class ResponseTerminatedError extends Error {
  constructor() {
    super('response terminated before tab admission completed');
    this.name = 'ResponseTerminatedError';
  }
}

function resolveLedgerSafetyMode(
  configured: TabMiddlewareOptions['ledgerSafetyMode'],
): NonNullable<TabMiddlewareOptions['ledgerSafetyMode']> {
  if (configured !== undefined) return configured;
  if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
    return 'development';
  }
  throw new Error(
    'tab seller ledgerSafetyMode must be explicit outside NODE_ENV=test/development; ' +
      'choose production-single-instance or production-multi-instance for deployment',
  );
}

function assertLedgerSafety(
  ledger: ChannelLedger,
  mode: NonNullable<TabMiddlewareOptions['ledgerSafetyMode']>,
): void {
  if (![
    'development',
    'production-single-instance',
    'production-multi-instance',
  ].includes(mode)) {
    throw new Error(`invalid tab seller ledgerSafetyMode: ${String(mode)}`);
  }
  const capabilities = ledger.capabilities;
  if (!capabilities || capabilities.conditionalWrites !== true) {
    throw new Error(
      'tab seller ledger must declare conditional owner-token/fence writes',
    );
  }
  if (mode !== 'development' && !capabilities.restartSafe) {
    throw new Error(
      `tab seller ${mode} requires restart-safe durable ledger state; ` +
        `${capabilities.adapter} is not restart-safe`,
    );
  }
  if (mode !== 'development' && !capabilities.canonicalChannelIds) {
    throw new Error(
      `tab seller ${mode} requires the legacy channel-id alias migration or an empty-store proof; ` +
        `${capabilities.adapter} has no canonical channel-id cutover acknowledgement`,
    );
  }
  if (mode === 'production-multi-instance' && !capabilities.multiInstanceSafe) {
    throw new Error(
      `tab seller production-multi-instance requires cross-process atomic fencing; ` +
        `${capabilities.adapter} is single-instance only`,
    );
  }
}

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
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new InvalidVoucherError(
      'signature_invalid',
      `channelId must be canonical lowercase 64-char hex, got "${hex}"`,
    );
  }
  return hexToBytes(hex);
}

// ── The middleware ─────────────────────────────────────────────────────

export function tabMiddleware(config: TabMiddlewareConfig): RequestHandler {
  const ledger: ChannelLedger = config.ledger ?? new InMemoryChannelLedger();
  const ledgerSafetyMode = resolveLedgerSafetyMode(config.ledgerSafetyMode);
  // Construction-time fail-closed gate. A production typo cannot silently
  // turn durable seller revenue state into an in-memory ledger.
  assertLedgerSafety(ledger, ledgerSafetyMode);
  const leaseTtlMs = normalizeLeaseTtlMs(config.leaseTtlMs ?? 300_000);
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
    let provisionalCacheEntry: {
      channelId: string;
      entry: SessionCacheEntry;
    } | null = null;
    let heldLease: {
      channelId: string;
      lease: ChannelLease;
      releaseStarted: boolean;
    } | null = null;
    let leaseHeartbeat: ReturnType<typeof setInterval> | null = null;
    let leaseRenewal: Promise<void> | null = null;
    let leaseFailure: Error | null = null;
    let responseTerminated = false;
    let assertLeaseActive = async (): Promise<void> => {
      if (leaseFailure) throw leaseFailure;
    };

    const releaseHeldLease = async (): Promise<void> => {
      if (!heldLease || heldLease.releaseStarted) return;
      const held = heldLease;
      held.releaseStarted = true;
      if (leaseHeartbeat) {
        clearInterval(leaseHeartbeat);
        leaseHeartbeat = null;
      }
      if (leaseRenewal) {
        await leaseRenewal.catch(() => undefined);
      }
      try {
        await ledger.releaseLease(held.channelId, heldLease?.lease ?? held.lease);
      } catch (error) {
        // Allow the response error path to retry once. Store failures surface
        // loudly; no in-memory release/fallback is attempted.
        held.releaseStarted = false;
        throw error;
      }
    };
    const onResponseTerminated = () => {
      if (responseTerminated) return;
      responseTerminated = true;
      setImmediate(() => {
        void releaseHeldLease().catch((error) => {
          console.error('[tab/seller] failed to release channel lease on response termination:', error);
        });
      });
    };
    const assertResponseOpen = () => {
      if (responseTerminated) throw new ResponseTerminatedError();
    };
    // Register before any registration/RPC proof. A close event is one-shot;
    // waiting until after proof can miss it and leave a later-acquired heartbeat
    // renewing a dead request forever.
    res.on('close', onResponseTerminated);
    res.on('finish', onResponseTerminated);
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
      let cacheEntryAfterAdmission = false;
      if (!entry) {
        // First voucher for this channel. Historical V1 verifies the
        // registration directly. Both generations defer caching until durable
        // lease ownership, registration binding, and the accepted-voucher write
        // succeed, so a rejected/losing request cannot poison this process for
        // the channel's real owner.
        cacheEntryAfterAdmission = true;
        const parsed = parseRegistration(voucher.sessionRegistration);
        if (nativeTabWireVersion(parsed.nonce) === 1) {
          onChain = await verifyRegistrationOnChain(config.connection, parsed);
          // Defensive `?.`: custom/mocked verifiers may still return void.
          chainFrontierAtomic = onChain?.frontierAtomic ?? null;
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
      let claimedReservation: bigint | null = null;
      let verifiedCurrentOutstanding: bigint | null = null;

      if (registrationWireVersion === 2) {
        if (!reservationReceipt) {
          throw new InvalidVoucherError(
            'reservation_proof_missing',
            'Native Tab V2 reservation proof was not carried through admission',
          );
        }
        claimedReservation = parseOnChainAtomic(
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
        verifiedCurrentOutstanding = currentOutstanding;
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
      // authoritative covered baseline. Historical V1 may reconnect with a
      // higher sequence at the same cumulative to consume previously
      // under-delivered headroom; the exact durable sequence check happens
      // after lease acquisition below.
      const v1EqualCumulativeReconnect =
        registrationWireVersion === 1 && cumulative === authorizationBaseline;
      enforceScope({
        registration: entry.registration,
        voucher,
        expectedCounterparty: sellerPubkey,
        previousCumulativeAtomic: v1EqualCumulativeReconnect
          ? undefined
          : authorizationBaseline.toString(),
      });

      // 5. Bound per-voucher increment. Protects against a giant single
      //    voucher slipping through; the buyer's perUnitCap should prevent
      //    this from the client side but the seller still defends.
      let increment = cumulative - authorizationBaseline;
      if (increment > maxPerVoucherAtomic) {
        throw new ScopeViolationError(
          'cumulative_exceeds_cap',
          `single voucher increment ${increment} exceeds maxPerVoucherAtomic ${maxPerVoucherAtomic}`,
        );
      }

      // Re-read after all RPC awaits. A concurrently admitted winner may now
      // exist even though the cache was empty when this request began. Do not
      // bind a new entry yet: the durable lease must be acquired first.
      if (cacheEntryAfterAdmission) {
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
      assertResponseOpen();
      const lease = await ledger.tryAcquireLease(channelId, leaseTtlMs);
      if (!lease) {
        throw new InvalidVoucherError(
          'channel_busy',
          'another stream is live on this channel; tabs serve one stream at a time',
        );
      }
      heldLease = { channelId, lease, releaseStarted: false };
      assertResponseOpen();

      // A live stream may legitimately outlast one TTL. Renew the exact owner
      // token + fence every third of the lease window. A renewal/store failure
      // permanently fails this request closed and destroys the response; every
      // charged chunk is already write-ahead persisted before delivery.
      const heartbeatMs = Math.max(1, Math.floor(leaseTtlMs / 3));
      const renewHeldLease = async (): Promise<void> => {
        if (leaseFailure) throw leaseFailure;
        if (!heldLease || heldLease.releaseStarted) {
          throw new ChannelLeaseLostError(channelId);
        }
        if (leaseRenewal) return leaseRenewal;
        leaseRenewal = (async () => {
          const renewed = await ledger.renewLease(
            channelId,
            heldLease!.lease,
            leaseTtlMs,
          );
          if (heldLease && !heldLease.releaseStarted) heldLease.lease = renewed;
        })()
          .catch((error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            leaseFailure = failure;
            console.error(
              `[tab/seller] channel lease renewal FAILED channel=${channelId.slice(0, 16)}…; ` +
                'stream terminated before further delivery:',
              failure,
            );
            if (typeof (res as any).destroy === 'function') {
              (res as any).destroy(failure);
            }
            throw failure;
          })
          .finally(() => {
            leaseRenewal = null;
          });
        return leaseRenewal;
      };
      assertLeaseActive = async (): Promise<void> => {
        if (leaseFailure) throw leaseFailure;
        if (!heldLease || heldLease.releaseStarted) {
          throw new ChannelLeaseLostError(channelId);
        }
        if (heldLease.lease.heldUntilUnixMs - Date.now() <= heartbeatMs) {
          await renewHeldLease();
        }
      };
      leaseHeartbeat = setInterval(() => {
        void renewHeldLease().catch(() => {
          // renewHeldLease records/logs the terminal failure exactly once.
        });
      }, heartbeatMs);
      (leaseHeartbeat as any).unref?.();

      // The pre-proof snapshot can be stale: another seller process may have
      // admitted and released this channel while our RPC proof was in flight.
      // Ownership is now exclusive, so bind the exact durable registration and
      // repeat every baseline-dependent check before any cache/ledger mutation.
      const postLeasePrior = await ledger.get(channelId);
      assertResponseOpen();
      if (
        postLeasePrior?.lastVoucher
        && !sameBytes(
          postLeasePrior.lastVoucher.sessionRegistration,
          voucher.sessionRegistration,
        )
      ) {
        throw new InvalidVoucherSignatureError(
          'durable channel registration changed while reservation proof was in flight',
        );
      }
      const durableCumulative = BigInt(
        postLeasePrior?.lastVoucher?.payload.cumulativeAmount ?? '0',
      );
      let postLeaseBaseline = BigInt(entry.lastCumulativeAtomic);
      if (durableCumulative > postLeaseBaseline) postLeaseBaseline = durableCumulative;
      if (registrationWireVersion === 2 && chainFrontierAtomic !== null) {
        const chainFrontier = parseOnChainAtomic(chainFrontierAtomic, 'frontierAtomic');
        if (chainFrontier > postLeaseBaseline) postLeaseBaseline = chainFrontier;
      }
      const v1EqualPostLeaseReconnect =
        registrationWireVersion === 1 && cumulative === postLeaseBaseline;
      if (
        cumulative < postLeaseBaseline
        || (registrationWireVersion === 2 && cumulative === postLeaseBaseline)
      ) {
        throw new InvalidVoucherError(
          registrationWireVersion === 2 ? 'voucher_already_covered' : 'non_monotonic',
          `cumulative ${cumulative} is not above post-lease covered frontier ${postLeaseBaseline}`,
        );
      }
      if (v1EqualPostLeaseReconnect) {
        const durableVoucher = postLeasePrior?.lastVoucher;
        if (
          !durableVoucher
          || BigInt(durableVoucher.payload.cumulativeAmount) !== cumulative
          || voucher.payload.sequenceNumber <= durableVoucher.payload.sequenceNumber
        ) {
          throw new InvalidVoucherError(
            'non_monotonic',
            'same-cumulative V1 reconnect requires a strictly newer sequence than the durable voucher',
          );
        }
      }
      enforceScope({
        registration: entry.registration,
        voucher,
        expectedCounterparty: sellerPubkey,
        previousCumulativeAtomic: v1EqualPostLeaseReconnect
          ? undefined
          : postLeaseBaseline.toString(),
      });
      increment = cumulative - postLeaseBaseline;
      if (increment > maxPerVoucherAtomic) {
        throw new ScopeViolationError(
          'cumulative_exceeds_cap',
          `post-lease voucher increment ${increment} exceeds maxPerVoucherAtomic ${maxPerVoucherAtomic}`,
        );
      }
      if (registrationWireVersion === 2) {
        if (
          claimedReservation === null
          || verifiedCurrentOutstanding === null
          || claimedReservation !== increment
          || verifiedCurrentOutstanding !== increment
        ) {
          throw new InvalidVoucherError(
            'reservation_mismatch',
            'durable channel frontier advanced while reservation proof was in flight',
          );
        }
      }
      authorizationBaseline = postLeaseBaseline;

      // The durable lease serializes first-seen channel binding across all
      // requests sharing this ledger. Re-read once more after acquiring it,
      // then install only an exact provisional entry. If later durable ledger
      // I/O fails, the outer catch removes this exact object so a failed
      // admission cannot poison the process cache.
      if (cacheEntryAfterAdmission) {
        const winner = cache.get(channelId);
        if (winner) {
          if (!sameBytes(winner.registrationBytes, entry.registrationBytes)) {
            await releaseHeldLease();
            throw new InvalidVoucherSignatureError(
              'voucher registration lost the channel lease race to a different verified registration',
            );
          }
          entry = winner;
        } else {
          cache.set(channelId, entry);
          provisionalCacheEntry = { channelId, entry };
        }
      }

      const persistBackgroundMutation = async (
        updater: ChannelLedgerUpdater,
      ): Promise<ChannelLedgerEntry> => {
        try {
          return await ledger.update(channelId, lease, updater);
        } catch (error) {
          if (!(error instanceof ChannelLeaseLostError)) throw error;
          // Detached crystallization can finish after the response releases its
          // stream lease. Reacquire a short fenced lease only if the channel is
          // idle; never write through another request's ownership.
          const maintenanceLease = await ledger.tryAcquireLease(
            channelId,
            Math.min(leaseTtlMs, 15_000),
          );
          if (!maintenanceLease) throw error;
          try {
            return await ledger.update(channelId, maintenanceLease, updater);
          } finally {
            await ledger.releaseLease(channelId, maintenanceLease);
          }
        }
      };

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
          await persistBackgroundMutation((cur) => {
            if (!cur) throw new Error('channel ledger entry missing during crystallize persist');
            const crystallized = (
              BigInt(cur.lastCrystallizedCumulativeAtomic ?? '0')
              >= BigInt(entry.lastCrystallizedCumulativeAtomic ?? '0')
            )
              ? cur.lastCrystallizedCumulativeAtomic ?? '0'
              : entry.lastCrystallizedCumulativeAtomic ?? '0';
            const refusalCandidates = [
              cur.gateRefusedCumulativeAtomic,
              entry.gateRefusedCumulativeAtomic,
            ].filter((value): value is string => value !== undefined);
            const refused = refusalCandidates.reduce<string | undefined>(
              (highest, value) => (
                highest === undefined || BigInt(value) > BigInt(highest)
                  ? value
                  : highest
              ),
              undefined,
            );
            return {
              ...cur,
              lastCrystallizedCumulativeAtomic: crystallized,
              gateRefusedCumulativeAtomic:
                refused !== undefined && BigInt(refused) > BigInt(crystallized)
                  ? refused
                  : undefined,
            };
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

      // Threshold and close crystallization are detached from delivery, but
      // they must observe one another's durable watermarks. Serialize this
      // request's jobs and make each job re-read the ledger after the previous
      // one persists; otherwise two rapid charges can both POST the same span
      // before the first below-cadence refusal is visible.
      let crystallizeTail: Promise<void> = Promise.resolve();
      const queueCrystallize = (work: () => Promise<void>): Promise<void> => {
        const run = crystallizeTail.then(work, work);
        crystallizeTail = run.catch(() => undefined);
        return run;
      };

      // At close: crystallize the channel's FINAL signed voucher exactly once if
      // the cadence wants it. We read `lastVoucher` from the ledger at close —
      // NOT a `delivered` snapshot — which sidesteps the close-handler ordering
      // problem entirely: `lastVoucher` is persisted during the request (step 6,
      // before next()), so it is already the final signed voucher at close
      // while every delivered chunk was already written ahead before send. We
      // crystallize that voucher and advance the watermark to ITS cumulative
      // (FIX C1/C2), so the watermark is truthful and never lies about a
      // delivered span the lock didn't actually secure.
      //
      // Fully best-effort: detached + swallows all errors. The `closeCrystallized`
      // flag is INDEPENDENT of `releaseOnce` — they guard different concerns and
      // must not be merged. Both handlers are registered on the same events; the
      // bodies are detached and run concurrently, so the lease release
      // (`releaseOnce`, registered earlier) is not gated on this crystallize.
      let closeCrystallized = false;
      const crystallizeOnClose = () => {
        if (!lockCadence.onClose || closeCrystallized) return;
        closeCrystallized = true;
        void queueCrystallize(async () => {
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
            await persistBackgroundMutation((latest) => {
              if (!latest) throw new Error('channel ledger entry missing during close crystallize');
              const crystallized = BigInt(latest.lastCrystallizedCumulativeAtomic ?? '0')
                >= BigInt(lockedCumulative)
                ? latest.lastCrystallizedCumulativeAtomic ?? '0'
                : lockedCumulative;
              return {
                ...latest,
                lastCrystallizedCumulativeAtomic: crystallized,
                // A landed lock supersedes refusal state only through the
                // amount it actually secured; never erase a newer watermark.
                gateRefusedCumulativeAtomic:
                  latest.gateRefusedCumulativeAtomic !== undefined
                  && BigInt(latest.gateRefusedCumulativeAtomic) > BigInt(crystallized)
                    ? latest.gateRefusedCumulativeAtomic
                    : undefined,
              };
            });
          } else if (isGateRefused(result.error)) {
            // Record the below-cadence refusal so later closes/deliveries of
            // the SAME span stay quiet (§5 A12). Benign — logged once by
            // crystallizeNow's outcome table.
            await persistBackgroundMutation((latest) => {
              if (!latest) throw new Error('channel ledger entry missing during close refusal persist');
              const crystallized = BigInt(latest.lastCrystallizedCumulativeAtomic ?? '0');
              const refused = latest.gateRefusedCumulativeAtomic !== undefined
                && BigInt(latest.gateRefusedCumulativeAtomic) >= BigInt(lockedCumulative)
                ? latest.gateRefusedCumulativeAtomic
                : lockedCumulative;
              return {
                ...latest,
                gateRefusedCumulativeAtomic:
                  BigInt(refused) > crystallized ? refused : undefined,
              };
            });
          }
        }).catch((err) => {
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
      //    accepted voucher WITHOUT touching delivered (each later meter charge
      //    advances delivered before its chunk is sent). Locked so a concurrent
      //    request can't interleave a stale write. The adapter keeps lease
      //    identity separate and conditionally commits on owner token + fence.
      const prior = postLeasePrior;
      // A ledger entry is FRESH when it has never seen a voucher or delivery.
      // V1 retains the historical fresh-only
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
      await ledger.update(channelId, lease, (cur) => ({
          ...(cur ?? {}),
          lastVoucher: voucher,
          deliveredCumulativeAtomic:
            seedAtomic ?? (cur ? cur.deliveredCumulativeAtomic : '0'),
          // Seed the crystallization watermark too: locks below the frontier
          // are unlockable (facilitator 409s), so the un-crystallized span
          // starts at zero on a resume.
          lastCrystallizedCumulativeAtomic:
            seedAtomic ?? cur?.lastCrystallizedCumulativeAtomic ?? '0',
        }));
      provisionalCacheEntry = null;
      assertResponseOpen();

      // 7. Update the hot-path registration cache and attach the SellerTab.
      cache.update(channelId, voucher.payload.cumulativeAmount);
      const tab = new SellerTabImpl(
        channelId,
        config.network,
        cumulative,
        deliveredBaselineAtomic,
        // recordDelivered: the meter calls this for each write-ahead chunk
        // before service using this request's exact owner token + fence. A
        // post-takeover writer fails closed.
        async (incrementAtomic: string) => {
          await assertLeaseActive();
          let updated: ChannelLedgerEntry | null = null;
          updated = await ledger.update(channelId, lease, (cur) => {
            if (!cur?.lastVoucher || !sameVoucherIdentity(cur.lastVoucher, voucher)) {
              throw new InvalidVoucherSignatureError(
                'durable voucher identity changed before delivery accounting',
              );
            }
            const base = BigInt(cur.deliveredCumulativeAtomic);
            const inc = BigInt(incrementAtomic);
            const nextDelivered = inc > 0n ? base + inc : base; // monotonic, never backward
            const signedCumulative = BigInt(cur.lastVoucher.payload.cumulativeAmount);
            if (nextDelivered > signedCumulative) {
              throw new ScopeViolationError(
                'cumulative_exceeds_cap',
                `durable delivered cumulative ${nextDelivered} exceeds signed cumulative ${signedCumulative}`,
              );
            }
            const next: ChannelLedgerEntry = {
              ...cur,
              lastVoucher: cur.lastVoucher,
              deliveredCumulativeAtomic: nextDelivered.toString(),
              lastCrystallizedCumulativeAtomic:
                cur.lastCrystallizedCumulativeAtomic ?? '0',
            };
            return next;
          });
          // Keyless crystallization cadence (Step-4). BEST-EFFORT: fire OUTSIDE
          // the channel lock so the network POST never serializes delivered
          // writes, and detach it so a slow/failed lock never blocks or rejects
          // the already-durable delivery charge. maybeCrystallize advances
          // `lastCrystallizedCumulativeAtomic` in memory on success; persist
          // that advance back so the next request doesn't re-fire.
          if (updated) {
            void queueCrystallize(async () => {
              const latest = await ledger.get(channelId);
              if (latest) await crystallizeCadence(latest);
            }).catch((err) => {
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
      if (heldLease && !heldLease.releaseStarted) {
        await releaseHeldLease().catch((releaseError) => {
          console.error('[tab/seller] failed to release channel lease after request error:', releaseError);
        });
      }
      if (provisionalCacheEntry) {
        cache.deleteIfSame(
          provisionalCacheEntry.channelId,
          provisionalCacheEntry.entry,
        );
      }
      if (err instanceof ResponseTerminatedError) return;
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

function sameVoucherIdentity(left: SignedVoucher, right: SignedVoucher): boolean {
  return left.payload.channelId === right.payload.channelId
    && left.payload.cumulativeAmount === right.payload.cumulativeAmount
    && left.payload.sequenceNumber === right.payload.sequenceNumber
    && sameBytes(left.sessionPublicKey, right.sessionPublicKey)
    && sameBytes(left.sessionRegistration, right.sessionRegistration)
    && sameBytes(left.sessionSignature, right.sessionSignature);
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
