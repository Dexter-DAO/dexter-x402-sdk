/**
 * The `Tab` runtime — the live object returned by `openTab()`.
 *
 * Owns: the session key, the channel id, the cumulative-amount counter,
 * the voucher sequence counter, the last signed voucher. Exposes:
 * `stream()` for paid streamed requests and `close()` for on-chain
 * settle + session revocation.
 *
 * As of `@dexterai/x402@3.10.0`, `close()` POSTs the final voucher to
 * the facilitator's `POST /tab/settle` endpoint BEFORE revoking the
 * session, so `TabCloseResult.settleTx` is the real on-chain settlement
 * signature (USDC swig → seller ATA, atomic with the session's `spent`
 * advance + `pending_voucher_count` decrement).
 */

import { PublicKey } from '@solana/web3.js';
import { bytesToHex } from '@noble/hashes/utils';

import type {
  Tab,
  TabState,
  TabCloseResult,
  TabNetworkId,
  HumanAmount,
  AtomicAmount,
  OpenTabOptions,
  ResumeTabOptions,
  SessionScope,
  SessionKey,
  VaultAdapter,
  VoucherPayload,
  SignedVoucher,
  TabSignedVoucher,
  FinalVoucherV2ReservationReceipt,
} from './types';
import {
  TabClosedError,
  HistoricalV1MigrationRequiredError,
  SessionScopeExceededError,
  UnsupportedNetworkError,
} from './types';

import { deriveChannelId } from './sessions';
import {
  assertFinalVoucherV2ReservationReceipt,
  finalVoucherV2ReservationIdentity,
} from './reservation';
import { deriveSessionPda } from '@dexterai/vault/session';
import { sessionRegisterMessage } from './messages';
import { DEXTER_VAULT_PROGRAM_ID } from './instructions';

// ── Defaults ───────────────────────────────────────────────────────────

/** Default session lifetime: 1 hour. Aggressive limits are the buyer's
 *  first line of defense against a stolen session. */
const DEFAULT_SESSION_DURATION_SEC = 3600;

/** Live Dexter x402 facilitator API. NOT facilitator.dexter.cash —
 *  that's a marketing redirect. */
export const DEFAULT_FACILITATOR_URL = 'https://x402.dexter.cash';

/** USDC decimals on Solana. Hardcoded — every SPL USDC mint on every
 *  supported chain in our stack uses 6. */
const USDC_DECIMALS = 6;

// ── Human ↔ atomic conversion ──────────────────────────────────────────

/**
 * Convert a human decimal string ("0.001") to atomic-unit string ("1000")
 * for a 6-decimal token. Rejects negative, scientific, or malformed input.
 */
export function humanToAtomic(human: HumanAmount, decimals: number = USDC_DECIMALS): AtomicAmount {
  if (!/^\d+(\.\d+)?$/.test(human)) {
    throw new Error(`amount must be a non-negative decimal string, got "${human}"`);
  }
  const [whole, frac = ''] = human.split('.');
  if (frac.length > decimals) {
    throw new Error(`amount "${human}" has more than ${decimals} decimals`);
  }
  const padded = frac.padEnd(decimals, '0');
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, '');
  return combined === '' ? '0' : combined;
}

export function atomicToHuman(atomic: AtomicAmount, decimals: number = USDC_DECIMALS): HumanAmount {
  if (!/^\d+$/.test(atomic)) {
    throw new Error(`atomic must be a non-negative integer string, got "${atomic}"`);
  }
  const padded = atomic.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '') || '0';
  const frac = padded.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

// ── The Tab runtime ────────────────────────────────────────────────────

interface TabInternals {
  vault: VaultAdapter;
  network: TabNetworkId;
  seller: string;
  /** Seller base58 pubkey — same value bound into scope.allowedCounterparty. */
  counterparty: string;
  session: SessionKey;
  channelIdHex: string;
  channelIdBytes: Uint8Array;
  perUnitCapAtomic: bigint;
  totalCapAtomic: bigint;
  expiresAtUnix: number;
  facilitatorUrl: string;
  /**
   * Starting value of the cumulative odometer. `openTab` opens fresh sessions
   * and omits this (0n). `tabFromGrant` seeds the on-chain frontier
   * `max(session.spent, session.crystallizedCumulative)` so the FIRST voucher
   * strictly exceeds everything the chain has already terminally counted —
   * the resume story: the chain is the durable counter, no local state.
   */
  initialCumulativeAtomic?: bigint;
  /** Initial V2 sequence ordinal recovered from durable terminal state. */
  initialSequenceOrdinal?: number;
  /**
   * V2-only release fence. A FINAL voucher is an irrevocable bearer claim;
   * it must not escape this process until an exact, durable reservation has
   * been established for it. The callback must be idempotent for identical
   * voucher bytes because a timeout is retried with the same signature.
   */
  beforeVoucherRelease?: (input: {
    voucher: SignedVoucher;
    incrementAtomic: AtomicAmount;
    previousCumulativeAtomic: AtomicAmount;
  }) => Promise<FinalVoucherV2ReservationReceipt>;
  /**
   * What `close()` does after posting the final voucher to `/tab/settle`:
   *  - 'revoke' (default, openTab): passkey-sign + submit the on-chain session
   *    revocation via `vault.signCloseTab`.
   *  - 'settle-only' (tabFromGrant): NO revocation — a grant-held tab has no
   *    passkey, revoke belongs to the wallet owner's surfaces. The session PDA
   *    stays live until owner-revoked or expiry-swept. Never a silent no-op:
   *    `TabCloseResult.sessionRevoked` reports which path ran.
   */
  closeMode?: 'revoke' | 'settle-only';
}

class TabImpl implements Tab {
  readonly channelId: string;
  readonly voucherVersion: 1 | 2;
  readonly network: TabNetworkId;
  readonly counterparty: string;

  private readonly internals: TabInternals;
  /** The odometer floor this tab was constructed at — 0n for openTab, the
   *  on-chain frontier for tabFromGrant. Rollback of the first voucher
   *  reverts HERE, never below (below would sign non-monotonic cumulatives
   *  the seller and the chain both reject). */
  private readonly initialCumulativeAtomic: bigint;
  private cumulativeAtomic: bigint;
  /** Ordinal only. V2's FINAL flag exists in the signed payload, not here. */
  private sequenceNumber: number;
  private readonly isFinalV2: boolean;
  private closed = false;
  /**
   * Local single-flight gate for state-changing Tab operations. Without it,
   * two concurrent sign calls can both observe the same sequence/cumulative
   * frontier and attempt to reserve the same obligation. Close must share the
   * same gate so it cannot snapshot or wipe the session while signing is in
   * flight.
   */
  private operationInFlight: 'voucher' | 'close' | 'rollback' | null = null;
  /** Most recent voucher we signed. Held so `close()` can POST it to the
   *  facilitator for on-chain settle without needing the seller to round-trip
   *  it back to us. Null if no voucher was signed in this tab's lifetime
   *  (close-without-stream → nothing to settle). */
  private lastSignedVoucher: TabSignedVoucher | null = null;
  /** Exact economic increment bound to `lastSignedVoucher`. In Native Tab V2
   *  this is also the immutable reservation amount, and `/tab/settle` must
   *  send this value rather than reconstructing it from lifetime cumulative. */
  private lastSignedVoucherIncrementAtomic: bigint | null = null;
  /** One level of voucher history: the voucher that was `lastSignedVoucher`
   *  immediately before the current one. Retained so `rollbackVoucher` can
   *  restore the pre-refusal voucher when a seller honestly refuses the
   *  most recent one. Set at commit time inside `signNextVoucher`. */
  private previousSignedVoucher: TabSignedVoucher | null = null;
  /** Increment paired with `previousSignedVoucher`, retained for V1 rollback. */
  private previousSignedVoucherIncrementAtomic: bigint | null = null;

  constructor(internals: TabInternals) {
    this.internals = internals;
    this.channelId = internals.channelIdHex;
    this.network = internals.network;
    this.counterparty = internals.counterparty;
    this.initialCumulativeAtomic = internals.initialCumulativeAtomic ?? 0n;
    this.cumulativeAtomic = this.initialCumulativeAtomic;
    this.sequenceNumber = internals.initialSequenceOrdinal ?? 0;
    this.isFinalV2 = isContextBoundV2Session(internals.session);
    this.voucherVersion = this.isFinalV2 ? 2 : 1;
    if (this.isFinalV2 !== Boolean(internals.beforeVoucherRelease)) {
      throw new Error(
        this.isFinalV2
          ? 'native_tab_v2_reservation_fence_required'
          : 'native_tab_v1_must_not_use_v2_reservation_fence',
      );
    }
  }

  get state(): TabState {
    const remaining = this.internals.totalCapAtomic - this.cumulativeAtomic;
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      isOpen: !this.closed,
      spent: atomicToHuman(this.cumulativeAtomic.toString()),
      remaining: atomicToHuman(remaining.toString()),
      expiresInSec: Math.max(0, this.internals.expiresAtUnix - nowSec),
    };
  }

  /**
   * Sign a voucher representing the new cumulative-amount-owed. Public
   * because Phase 3 seller middleware will call this directly via the
   * stream() body. Phase 2 callers can use it to drive a manual loop
   * against any seller endpoint that understands the voucher format.
   *
   * The seller MUST verify before delivering. The SDK only protects the
   * buyer from over-signing (cap, expiry, perUnitCap).
   */
  async signNextVoucher(incrementAtomic: AtomicAmount): Promise<TabSignedVoucher> {
    this.beginOperation('voucher');
    try {
      return await this.signNextVoucherExclusive(incrementAtomic);
    } finally {
      this.endOperation('voucher');
    }
  }

  private async signNextVoucherExclusive(
    incrementAtomic: AtomicAmount,
  ): Promise<TabSignedVoucher> {
    if (this.closed) throw new TabClosedError(this.channelId);

    const incBig = BigInt(incrementAtomic);
    if (incBig <= 0n) {
      throw new Error(`voucher increment must be > 0, got ${incrementAtomic}`);
    }
    if (incBig > this.internals.perUnitCapAtomic) {
      throw new SessionScopeExceededError(
        'cap_exceeded',
        `single voucher increment ${incBig} exceeds perUnitCap ${this.internals.perUnitCapAtomic}`,
      );
    }

    const newCumulative = this.cumulativeAtomic + incBig;
    if (newCumulative > this.internals.totalCapAtomic) {
      throw new SessionScopeExceededError(
        'cap_exceeded',
        `cumulative ${newCumulative} would exceed totalCap ${this.internals.totalCapAtomic}`,
      );
    }

    // Compute the next counter values into locals and only COMMIT them after
    // the signature lands. A signing rejection must leave the tab untouched —
    // mutating first would inflate the counter with a phantom increment that
    // no voucher exists for, silently folding it into the next voucher.
    // (Scope checks above deliberately stay BEFORE signing.)
    const nextSequence = this.sequenceNumber + 1;

    const payload: VoucherPayload = {
      channelId: this.channelId,
      cumulativeAmount: newCumulative.toString(),
      sequenceNumber: nextSequence,
    };

    const signed = await this.internals.vault.signWithSession(this.internals.session, payload);

    // A chain adapter owns the signature bytes, not the accounting identity.
    // Refuse an adapter that signs/returns a different voucher than requested;
    // otherwise local counters and the bearer claim would silently diverge.
    if (
      signed.payload.channelId !== payload.channelId
      || signed.payload.cumulativeAmount !== payload.cumulativeAmount
      || (
        this.isFinalV2
          ? (signed.payload.sequenceNumber & 0x7fff_ffff) !== nextSequence
            || (signed.payload.sequenceNumber & 0x8000_0000) === 0
          : signed.payload.sequenceNumber !== nextSequence
      )
    ) {
      throw new Error('tab_signer_returned_unexpected_voucher');
    }

    // FINAL V2 is deliberately not a speculative/reversible signature. The
    // durable reservation fence runs after deterministic signing but before
    // the voucher can be returned to a merchant-facing caller. If it times
    // out, counters stay unchanged and the next retry reproduces the same
    // exact bytes for idempotent reconciliation.
    let reservationReceipt: FinalVoucherV2ReservationReceipt | undefined;
    if (this.internals.beforeVoucherRelease) {
      reservationReceipt = await this.internals.beforeVoucherRelease({
        voucher: signed,
        incrementAtomic: incBig.toString(),
        previousCumulativeAtomic: this.cumulativeAtomic.toString(),
      });
    }

    const released: TabSignedVoucher = reservationReceipt
      ? { ...signed, reservationReceipt }
      : signed;

    // Commit: counters, one level of history, and the new last voucher.
    this.previousSignedVoucher = this.lastSignedVoucher;
    this.previousSignedVoucherIncrementAtomic =
      this.lastSignedVoucherIncrementAtomic;
    this.lastSignedVoucher = released;
    this.lastSignedVoucherIncrementAtomic = incBig;
    this.sequenceNumber = nextSequence;
    this.cumulativeAtomic = newCumulative;
    return released;
  }

  private beginOperation(operation: 'voucher' | 'close' | 'rollback'): void {
    if (this.operationInFlight !== null) {
      throw new Error(
        `tab_operation_in_flight: ${this.operationInFlight}`,
      );
    }
    this.operationInFlight = operation;
  }

  private endOperation(operation: 'voucher' | 'close' | 'rollback'): void {
    if (this.operationInFlight !== operation) {
      throw new Error('tab_operation_gate_corrupted');
    }
    this.operationInFlight = null;
  }

  /**
   * INTERNAL — deliberately NOT on the public `Tab` interface.
   *
   * Roll back the most recent signed voucher after an HONEST seller refusal
   * (the seller answered a voucher-paid request with a fresh 402 instead of
   * delivering). `payWithTab` calls this before falling through to the
   * generic payment path so the refused increment isn't ALSO settled by
   * `close()` — without it the buyer pays twice: once exact, once when the
   * tab settles a cumulative that includes the refused voucher.
   *
   * Only rolls back IFF `lastSignedVoucher` is exactly `v` (same sequence
   * number AND same cumulative amount); otherwise it's a no-op returning
   * false. Restores the previous voucher from the one level of history kept
   * by `signNextVoucher`. Only one level is retained, so a rollback consumes
   * the history — a second consecutive rollback (beyond sequence 1) refuses.
   *
   * Trust model: this rollback optimizes the HONEST-refusal case. A
   * MALICIOUS seller still holds a bearer claim on the refused voucher —
   * nothing the buyer does locally can un-sign it. On-chain cumulative
   * monotonicity means at most ONE of the {refused, reissued} cumulative-X
   * vouchers ever settles, so exposure stays bounded by the session cap;
   * this is the known soft-tail of the voucher scheme, not a new hole
   * introduced by rolling back.
   */
  rollbackVoucher(v: SignedVoucher): boolean {
    // A FINAL V2 voucher is an irrevocable bearer claim and already has a
    // durable exact reservation. Reusing its ordinal/cumulative or falling
    // through to another payment rail would create a double-payment path.
    if (this.isFinalV2) return false;

    // Rollback mutates the same cumulative/sequence frontier as signing and
    // close. Refuse while either is suspended at an await boundary; otherwise
    // rollback could erase the state underneath an in-flight signature or the
    // settle/revoke snapshot. Once admitted, hold the same gate for the whole
    // synchronous mutation so no other operation can interleave.
    if (this.operationInFlight !== null) return false;
    this.beginOperation('rollback');

    try {
      return this.rollbackVoucherExclusive(v);
    } finally {
      this.endOperation('rollback');
    }
  }

  private rollbackVoucherExclusive(v: SignedVoucher): boolean {
    const last = this.lastSignedVoucher;
    if (
      !last ||
      last.payload.sequenceNumber !== v.payload.sequenceNumber ||
      last.payload.cumulativeAmount !== v.payload.cumulativeAmount
    ) {
      return false;
    }

    const prev = this.previousSignedVoucher;
    if (prev) {
      const prevIncrement = this.previousSignedVoucherIncrementAtomic;
      if (prevIncrement === null) return false;
      this.sequenceNumber = prev.payload.sequenceNumber;
      this.cumulativeAtomic = BigInt(prev.payload.cumulativeAmount);
      this.lastSignedVoucher = prev;
      this.lastSignedVoucherIncrementAtomic = prevIncrement;
    } else if (last.payload.sequenceNumber === 1) {
      // The refused voucher was the tab's first — revert to the pristine
      // state: the odometer FLOOR this tab was constructed at (0n for
      // openTab; the on-chain frontier for a grant-resumed tab).
      this.sequenceNumber = 0;
      this.cumulativeAtomic = this.initialCumulativeAtomic;
      this.lastSignedVoucher = null;
      this.lastSignedVoucherIncrementAtomic = null;
    } else {
      // History exhausted (only one level retained) — refuse rather than guess.
      return false;
    }
    this.previousSignedVoucher = null;
    this.previousSignedVoucherIncrementAtomic = null;
    return true;
  }

  /**
   * Streamed paid request. Phase 3 implementation:
   *   1. Buyer signs a voucher bumping the cumulative by `perUnitCap` (the
   *      authorized budget for this single request).
   *   2. SDK serializes the voucher to base64-JSON and sets it as the
   *      `X-Tab-Voucher` request header.
   *   3. fetch() the seller endpoint.
   *   4. Read the response body as Server-Sent Events; yield each `data:`
   *      chunk as a Uint8Array.
   *
   * The buyer's authorized budget for this request equals `perUnitCap`. A
   * single tab.stream() call can deliver many chunks WITHIN that budget;
   * for higher budgets, call stream() multiple times with fresh vouchers.
   *
   * The async iterable throws on cap-exceeded, expiry, signature rejection,
   * or non-2xx response. Never silently stalls.
   */
  async stream(input: string | URL | Request, init?: RequestInit): Promise<AsyncIterable<Uint8Array>> {
    if (this.closed) throw new TabClosedError(this.channelId);

    // Sign a voucher authorizing perUnitCap more atomic units for this
    // request. The seller's SSE meter operates within that budget.
    const voucher = await this.signNextVoucher(this.internals.perUnitCapAtomic.toString());

    const headers = new Headers(init?.headers);
    headers.set('X-Tab-Voucher', voucherToHeader(voucher));
    headers.set('Accept', 'text/event-stream');

    const response = await fetch(input, { ...init, headers });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`tab.stream HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    if (!response.body) {
      throw new Error('tab.stream response has no body');
    }

    return decodeSseChunks(response.body);
  }

  /**
   * Close the tab.
   *
   * Order matters here:
   *
   *   1. POST the last signed voucher to `${facilitatorUrl}/tab/settle`.
   *      The facilitator submits the 3-instruction tx that actually moves
   *      USDC from the buyer's swig wallet PDA's ATA to the seller's ATA,
   *      verified on chain by the Ed25519 precompile against the session
   *      key. After this lands, `vault.active_session.spent` advances and
   *      `pending_voucher_count` decrements — both atomic with the
   *      transfer.
   *
   *   2. Sign + submit the revocation tx. The session key is no longer
   *      accepted by any seller after this. We do this AFTER settle
   *      because settle reads `vault.active_session` on chain; revoking
   *      first would clear it and the settle tx would be rejected.
   *
   *   3. Best-effort wipe the in-memory private key.
   *
   * Tabs that stream nothing (no voucher ever signed) skip step 1 — there's
   * nothing to settle. The revocation still runs so the session can't be
   * resurrected, and `settleTx` comes back empty (legitimately).
   */
  async close(): Promise<TabCloseResult> {
    this.beginOperation('close');
    try {
      if (this.closed) throw new TabClosedError(this.channelId);

      let settled: SettleResult = { settleTx: '' };
      if (this.lastSignedVoucher && this.cumulativeAtomic > 0n) {
        // Native Tab V2 reserves one exact obligation at a time, so close
        // declares the FINAL voucher's immutable reservation increment.
        // Grandfathered V1 tabs instead accumulate several vouchers before
        // one terminal settle and therefore declare the complete local span.
        const attemptedAmount = this.isFinalV2
          ? this.lastSignedVoucherIncrementAtomic
          : this.cumulativeAtomic - this.initialCumulativeAtomic;
        if (attemptedAmount === null || attemptedAmount <= 0n) {
          throw new Error('tab_settle_attempted_amount_missing');
        }
        settled = await postSettle(
          this.internals.facilitatorUrl,
          this.lastSignedVoucher,
          this.internals.network,
          attemptedAmount.toString(),
        );
      }

      // 'revoke' (openTab): passkey-sign + submit the on-chain revocation.
      // 'settle-only' (tabFromGrant): a grant-held tab has NO passkey — the
      // revoke belongs to the wallet owner's surfaces; skipping it here is a
      // documented mode, reported honestly via `sessionRevoked` below.
      const revoke = (this.internals.closeMode ?? 'revoke') === 'revoke';
      if (revoke) {
        await this.internals.vault.signCloseTab(
          this.internals.session,
          this.channelId,
          this.cumulativeAtomic.toString(),
        );
      }

      this.closed = true;
      this.internals.session.privateKey.fill(0);

      return {
        settledAmount: atomicToHuman(this.cumulativeAtomic.toString()),
        sessionRevoked: revoke,
        ...settled,
      };
    } finally {
      this.endOperation('close');
    }
  }
}

function isContextBoundV2Session(session: SessionKey): boolean {
  if (session.registration.length !== 188) return false;
  const view = new DataView(
    session.registration.buffer,
    session.registration.byteOffset,
    session.registration.byteLength,
  );
  return (view.getUint32(176, true) & 0x8000_0000) !== 0;
}

/**
 * Serialize a signed voucher to the `X-Tab-Voucher` header value:
 * base64-encoded JSON with hex-encoded byte fields. V2 additionally carries
 * the complete reservation receipt that was independently verified before the
 * voucher left the buyer. The receipt is an untrusted transaction locator at
 * the seller; it never replaces the seller's own at-least-confirmed chain proof.
 *
 * This is THE wire encoding the seller middleware and the facilitator's
 * `/tab/settle` endpoint both parse — `stream()` uses it, and `payAndFetch`
 * uses it to pay a `tab`-scheme accepts entry directly.
 */
export function voucherToHeader(
  signed: SignedVoucher | TabSignedVoucher,
  reservationReceipt?: FinalVoucherV2ReservationReceipt,
): string {
  const carriedReceipt = reservationReceipt
    ?? (signed as TabSignedVoucher).reservationReceipt;
  const isV2 = (signed.payload.sequenceNumber & 0x8000_0000) !== 0;
  if (isV2 && !carriedReceipt) {
    throw new Error('native_tab_v2_reservation_receipt_required');
  }
  return Buffer.from(
    JSON.stringify({
      payload: signed.payload,
      sessionPublicKey: bytesToHex(signed.sessionPublicKey),
      sessionRegistration: bytesToHex(signed.sessionRegistration),
      sessionSignature: bytesToHex(signed.sessionSignature),
      ...(carriedReceipt ? { reservationReceipt: carriedReceipt } : {}),
    }),
    'utf8',
  ).toString('base64');
}

/** What postSettle extracts from the facilitator's `/tab/settle` response.
 *  The fee fields are present only when a fee-aware facilitator sends them
 *  as strings — older facilitators omit them and they stay undefined. */
interface SettleResult {
  settleTx: string;
  grossAmount?: string;
  feeAmount?: string;
  netAmount?: string;
}

/**
 * Parse a facilitator-reported atomic amount to BigInt, STRICTLY. Atomic
 * amounts are non-negative integer strings; anything else (decimal, negative,
 * non-numeric, a number, or missing) yields `null` so the caller falls through
 * to the throw path. Never parseFloat — atomic amounts compare as BigInt only.
 */
function atomicFieldToBigInt(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  return BigInt(v);
}

/**
 * Deploy-skew tolerance test: is this 409 body a genuinely-COVERED final settle
 * (seller-side locks already crystallized the closing span) rather than a
 * stale/replayed or still-uncovered one?
 *
 * Tolerate IFF the body parses as JSON, its `error`/`reason` is
 * `non_monotonic_cumulative`, and its SNAKE_CASE amounts (the 409 error body
 * keeps the legacy convention while success bodies are camelCase) prove
 * coverage as BigInt:
 *   attempted_cumulative > on_chain_spent   (NOT a stale replay), AND
 *   attempted_cumulative <= frontier        (inside the locked watermark).
 *
 * Any missing or malformed field → `false` → the caller throws (fail closed).
 * A 409 with attempted_cumulative <= on_chain_spent is genuinely stale and a
 * 409 with attempted_cumulative > frontier is genuinely uncovered — both throw.
 */
function isCoveredByFrontier409(text: string): boolean {
  let body: {
    error?: unknown;
    reason?: unknown;
    on_chain_spent?: unknown;
    frontier?: unknown;
    attempted_cumulative?: unknown;
  };
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  // JSON.parse succeeds on literal `null` and bare primitives ('null', '5',
  // '"x"') — property access on null would throw a TypeError OUT of this
  // fail-closed check. Non-object bodies can never prove coverage.
  if (typeof body !== 'object' || body === null) return false;

  const marker = 'non_monotonic_cumulative';
  if (body.error !== marker && body.reason !== marker) return false;

  const attempted = atomicFieldToBigInt(body.attempted_cumulative);
  const onChainSpent = atomicFieldToBigInt(body.on_chain_spent);
  const frontier = atomicFieldToBigInt(body.frontier);
  if (attempted === null || onChainSpent === null || frontier === null) return false;

  return attempted > onChainSpent && attempted <= frontier;
}

/**
 * POST the buyer's final voucher to the facilitator's `/tab/settle` endpoint
 * and return the on-chain settlement signature plus, when the facilitator
 * sends them, the gross/fee/net atomic amounts of the final settle. Throws
 * on non-2xx so a settle failure surfaces to the buyer rather than silently
 * leaving the seller unpaid.
 *
 * Wire shape matches dexter-facilitator/src/tabSettle.ts: the endpoint
 * accepts hex-encoded bytes for the session pubkey / signature /
 * registration and a 32-byte hex channel id. Same encoding we use in the
 * X-Tab-Voucher stream header.
 */
async function postSettle(
  facilitatorUrl: string,
  voucher: SignedVoucher,
  network: TabNetworkId,
  attemptedAmount: AtomicAmount,
): Promise<SettleResult> {
  const url = `${facilitatorUrl.replace(/\/$/, '')}/tab/settle`;
  const body = {
    attemptedAmount,
    channelId: voucher.payload.channelId,
    cumulativeAmount: voucher.payload.cumulativeAmount,
    sequenceNumber: voucher.payload.sequenceNumber,
    sessionPublicKey: bytesToHex(voucher.sessionPublicKey),
    sessionSignature: bytesToHex(voucher.sessionSignature),
    sessionRegistration: bytesToHex(voucher.sessionRegistration),
    network,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // Covered-by-frontier deploy skew: an OLD facilitator (pre-C-2 frontier
    // fix) 409s a final settle that seller-side locks already crystallized.
    // Tolerate ONLY when the 409 body PROVES coverage; every other 409 — and
    // every other non-2xx — keeps throwing so the session stays alive and the
    // buyer can retry the settle. See isCoveredByFrontier409 for the exact bar.
    if (res.status === 409 && isCoveredByFrontier409(text)) {
      return { settleTx: '' };
    }
    throw new Error(`tab settle ${res.status}: ${text.slice(0, 500)}`);
  }
  let parsed: {
    settled?: unknown;
    reason?: unknown;
    settleTx?: string;
    grossAmount?: unknown;
    feeAmount?: unknown;
    netAmount?: unknown;
    onChainSpent?: unknown;
    frontier?: unknown;
    attemptedCumulative?: unknown;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`tab settle returned non-JSON: ${text.slice(0, 200)}`);
  }
  // New-facilitator covered no-op: HTTP 200 { settled: false,
  // reason: 'covered_by_frontier', settleTx: '', ...camelCase amounts }. The
  // final span was locked (crystallized) before this settle arrived — a NORMAL
  // post-crystallization outcome, only reachable when crystallized > spent.
  //
  // The marker alone is NEVER sufficient: a false no-op would make the buyer
  // revoke, clearing the session and stranding the seller's tail
  // unrecoverably. Re-derive coverage from the body's own CAMELCASE amounts
  // (success bodies are camelCase; the 409 error body keeps snake_case),
  // BigInt-strict, before tolerating:
  //   attemptedCumulative > onChainSpent   (NOT a stale replay), AND
  //   attemptedCumulative <= frontier      (inside the locked watermark).
  // Missing/malformed/inequality-failing → fall through to the existing
  // no-settleTx throw below (fail closed: close() throws before the revoke,
  // the session stays alive, and the settle stays retryable).
  if (parsed.reason === 'covered_by_frontier') {
    const attempted = atomicFieldToBigInt(parsed.attemptedCumulative);
    const onChainSpent = atomicFieldToBigInt(parsed.onChainSpent);
    const frontier = atomicFieldToBigInt(parsed.frontier);
    if (
      attempted !== null &&
      onChainSpent !== null &&
      frontier !== null &&
      attempted > onChainSpent &&
      attempted <= frontier
    ) {
      return { settleTx: '' };
    }
    // Not provably covered — fall through to the existing throw path.
  }
  if (!parsed.settleTx) {
    throw new Error(`tab settle returned no settleTx: ${text.slice(0, 200)}`);
  }
  // Fee fields are optional (older facilitators don't send them) and only
  // accepted as strings — anything else is ignored, never coerced.
  const result: SettleResult = { settleTx: parsed.settleTx };
  if (typeof parsed.grossAmount === 'string') result.grossAmount = parsed.grossAmount;
  if (typeof parsed.feeAmount === 'string') result.feeAmount = parsed.feeAmount;
  if (typeof parsed.netAmount === 'string') result.netAmount = parsed.netAmount;
  return result;
}

// ── armTabOpen ────────────────────────────────────────────────────────

/**
 * Arm drain-protection for a freshly-registered tab via the facilitator's
 * /tab/open. THROWS if protection cannot be confirmed — a tab that is not
 * drain-protected must never be returned to the caller.
 */
/**
 * @deprecated V6 has no buyer-side V1 arming route. This retained symbol is a
 * deterministic migration fence for callers compiled against the old helper;
 * it performs no fetch, signing, or chain action.
 */
export async function armTabOpen(
  _facilitatorUrl: string,
  _buyerSwigAddress: string,
  _maxAmountAtomic: bigint,
  _network: string,
  _counterparty: string,
): Promise<{ armed: true; signature: string }> {
  throw new HistoricalV1MigrationRequiredError('armTabOpen');
}

// ── openTab / resumeTab ────────────────────────────────────────────────

export async function openTab(options: OpenTabOptions): Promise<Tab> {
  // 1. Network sanity check. The adapter says what it supports; the
  //    caller passes the network it expects; they must match.
  if (options.network !== options.vault.network) {
    throw new UnsupportedNetworkError(
      `options.network (${options.network}) doesn't match vault.network (${options.vault.network})`,
    );
  }
  if (options.network !== 'solana:mainnet') {
    throw new UnsupportedNetworkError(options.network);
  }
  if (
    options.vault.sessionVoucherVersion !== 1
    && options.vault.sessionVoucherVersion !== 2
  ) {
    throw new Error('native_tab_adapter_voucher_version_required');
  }
  if (options.vault.sessionVoucherVersion === 1) {
    // The current facilitator's /tab/open route is exact V2-only. Reject
    // before authorizeSession creates an unusable on-chain credential.
    throw new HistoricalV1MigrationRequiredError('openTab');
  }
  if (
    options.vault.sessionVoucherVersion === 2
    && (
      !options.reserveFinalVoucherV2
      || !options.vault.verifyFinalVoucherV2Reservation
    )
  ) {
    // Fail before authorizeSession creates/replaces any on-chain session. A
    // V2 FINAL voucher may never be issued without an exact durable fence.
    throw new Error('native_tab_v2_reservation_fence_required');
  }

  // 2. Derive the channel id from (vault, seller, nonce). The buyer
  //    decides nonce; we use a random one here. A buyer who wants
  //    deterministic ids (e.g. resume across processes) can compute
  //    deriveChannelId themselves and pass via a future option.
  const nonce = BigInt(Math.floor(Math.random() * 0xffffffff));
  const vaultPdaKey = new PublicKey(options.vault.vaultPda);
  const channelIdBytes = deriveChannelId({
    vaultPda: vaultPdaKey,
    sellerUrl: options.seller,
    nonce: BigInt(nonce),
  });
  const channelIdHex = bytesToHex(channelIdBytes);

  // 3. Convert human amounts to atomic. Cap a single voucher AND the
  //    cumulative session.
  const perUnitCapAtomic = BigInt(humanToAtomic(options.perUnitCap));
  const totalCapAtomic = BigInt(humanToAtomic(options.totalCap));
  if (perUnitCapAtomic <= 0n) throw new Error('perUnitCap must be > 0');
  if (totalCapAtomic < perUnitCapAtomic) {
    throw new Error('totalCap must be >= perUnitCap');
  }
  // Surface a zero/negative revolving cap here rather than letting the on-chain
  // program reject it (RevolvingCapacityZero) after a wasted round-trip. When
  // omitted, revolvingCapacity defaults to totalCap below (always > 0).
  if (options.revolvingCapacity !== undefined) {
    const revolvingCapAtomic = BigInt(humanToAtomic(options.revolvingCapacity));
    if (revolvingCapAtomic <= 0n) throw new Error('revolvingCapacity must be > 0');
  }

  // 4. Build the session scope and authorize the session key on chain.
  //    This is the ONE passkey prompt of the tab lifecycle.
  const durationSec = options.sessionDuration ?? DEFAULT_SESSION_DURATION_SEC;
  const expiresAtUnix = Math.floor(Date.now() / 1000) + durationSec;

  const counterparty = sellerToCounterparty(options.seller);
  const scope: SessionScope = {
    channelId: channelIdHex,
    maxAmountAtomic: totalCapAtomic.toString(),
    revolvingCapacityAtomic: options.revolvingCapacity
      ? humanToAtomic(options.revolvingCapacity)
      : totalCapAtomic.toString(),
    expiresAtUnix,
    allowedCounterparty: counterparty,
  };

  // K-T4e: the session PDA is per (vault, counterparty) — re-opening against
  // a seller with a LIVE session collides with it. Default policy throws the
  // typed LiveSessionExistsError (never silently strand the old session's
  // unsettled tail); `onLiveSession: 'replace'` composes the atomic same-tx
  // revoke-then-register.
  const session = await options.vault.authorizeSession(scope, {
    onLiveSession: options.onLiveSession,
  });

  const isV2 = isContextBoundV2Session(session);
  if (options.vault.sessionVoucherVersion !== (isV2 ? 2 : 1)) {
    throw new Error('native_tab_adapter_voucher_version_mismatch');
  }
  let beforeVoucherRelease: TabInternals['beforeVoucherRelease'];
  if (isV2) {
    if (!options.reserveFinalVoucherV2) {
      throw new Error('native_tab_v2_reservation_fence_required');
    }
    const registration = session.registration;
    const view = new DataView(
      registration.buffer,
      registration.byteOffset,
      registration.byteLength,
    );
    const programId = new PublicKey(registration.subarray(32, 64));
    const registrationVault = new PublicKey(registration.subarray(64, 96));
    const registrationSeller = new PublicKey(registration.subarray(144, 176));
    const sessionNonce = view.getUint32(176, true);
    const maxRevolvingCapacity = view.getBigUint64(180, true);
    const expectedRegistration = sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: vaultPdaKey,
      sessionPubkey: session.publicKey,
      maxAmount: totalCapAtomic,
      expiresAt: BigInt(expiresAtUnix),
      allowedCounterparty: new PublicKey(counterparty),
      nonce: sessionNonce,
      maxRevolvingCapacity: BigInt(scope.revolvingCapacityAtomic!),
    });
    if (
      !programId.equals(DEXTER_VAULT_PROGRAM_ID)
      || !registrationVault.equals(vaultPdaKey)
      || !registrationSeller.equals(new PublicKey(counterparty))
      || maxRevolvingCapacity !== BigInt(scope.revolvingCapacityAtomic!)
      || !Buffer.from(registration).equals(Buffer.from(expectedRegistration))
    ) {
      throw new Error('native_tab_v2_registration_identity_mismatch');
    }
    const [sessionPda] = deriveSessionPda(
      registrationVault,
      registrationSeller,
      programId,
    );
    beforeVoucherRelease = async ({
      voucher,
      incrementAtomic,
      previousCumulativeAtomic,
    }) => {
      const identity = finalVoucherV2ReservationIdentity(voucher);
      const input = {
        network: options.network,
        programId: programId.toBase58(),
        buyerSwigAddress: options.vault.swigAddress,
        vaultPda: registrationVault.toBase58(),
        sessionPda: sessionPda.toBase58(),
        seller: registrationSeller.toBase58(),
        channelId: channelIdHex,
        sessionNonce,
        reservationAmountAtomic: incrementAtomic,
        previousCumulativeAtomic,
        ...identity,
        voucher,
      };
      const receipt = await options.reserveFinalVoucherV2!(input);
      assertFinalVoucherV2ReservationReceipt(input, receipt);
      await options.vault.verifyFinalVoucherV2Reservation!(input, receipt);
      return receipt;
    };
  }

  return new TabImpl({
    vault: options.vault,
    network: options.network,
    seller: options.seller,
    counterparty,
    session,
    channelIdHex,
    channelIdBytes,
    perUnitCapAtomic,
    totalCapAtomic,
    expiresAtUnix,
    facilitatorUrl: options.facilitatorUrl ?? DEFAULT_FACILITATOR_URL,
    beforeVoucherRelease,
  });
}

export async function resumeTab(_options: ResumeTabOptions): Promise<Tab> {
  // Phase 2 doesn't ship resume because session keys are memory-only by
  // design. Resume requires reading active_session off chain, then
  // prompting the passkey to authorize a NEW session that picks up the
  // existing channel id. Phase 3 wires this up because it needs the
  // adapter to expose `readActiveSession()` which doesn't exist yet.
  //
  // NOTE for Phase 3 (revolving meter / credex): the on-chain session already
  // carries max_revolving_capacity, set at original openTab registration. A
  // resumed session should READ that cap from chain (verify.ts parseRegistration
  // already returns maxRevolvingCapacity) — it does NOT need to re-supply it.
  // Memory-only keys are load-bearing for non-custody: the powerful credential
  // is the hardware passkey (never persisted); the session key is bounded
  // (capped, single-counterparty, no withdraw) and ephemeral. Resume must NOT
  // persist/recover a session key — re-prompt the passkey for a fresh one.
  throw new Error(
    'resumeTab is Phase 3 work. Session keys are memory-only by design; ' +
    'recovery requires reading active_session on chain and re-authorizing. ' +
    'Tracked in dexter-vault roadmap.',
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Derive the counterparty (Solana pubkey) for a seller URL. For now we
 * accept either a base58 pubkey directly (`options.seller = "abc..."`) or
 * a URL; in the URL case Phase 3 will plumb in a `/well-known` lookup
 * against the seller. Phase 2 requires the buyer to pass a pubkey
 * directly.
 */
function sellerToCounterparty(seller: string): string {
  // If it looks like a base58 pubkey (32-44 chars, no slashes), trust it.
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(seller)) {
    try {
      new PublicKey(seller); // validates
      return seller;
    } catch {
      // fall through
    }
  }
  throw new Error(
    `seller must be a base58 Solana pubkey for Phase 2 (got "${seller}"). ` +
    'URL-based counterparty resolution lands in Phase 3 (seller middleware).',
  );
}

// ── SSE decoding ───────────────────────────────────────────────────────
//
// Server-Sent Events frame format: each event is a block of lines, blocks
// separated by a blank line. We only care about `data:` lines for content
// and `event: end` for stream completion.

async function* decodeSseChunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on blank-line event boundaries.
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const eventText = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseEvent(eventText);
        if (parsed.eventName === 'end') return;
        if (parsed.data !== null) {
          // True inverse of the meter's escape (backslashes first, then
          // newlines): a single left-to-right pass so `\\n` decodes to a
          // literal backslash+n (JSON escape preserved) and `\n` decodes to
          // a real newline. The old newline-only unescape corrupted JSON
          // payloads containing their own `\n` escapes.
          const text = parsed.data.replace(/\\(\\|n)/g, (_, c: string) => (c === 'n' ? '\n' : '\\'));
          yield new TextEncoder().encode(text);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseEvent(text: string): { eventName: string | null; data: string | null } {
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  return { eventName, data: dataLines.length ? dataLines.join('\n') : null };
}

// Re-export the helpers callers want.
export { TabImpl };
