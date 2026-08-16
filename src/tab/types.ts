/**
 * @dexterai/x402/tab — type contract for the OTS-backed streaming payment module.
 *
 * Session/voucher protocol types moved to @dexterai/vault/types in the v0.1
 * extract. Re-exported here so existing consumers of `@dexterai/x402/tab`
 * see zero import-path changes. Tab-runtime types (VaultAdapter, OpenTabOptions,
 * Tab, errors) stay local — they're HTTP/SSE-shaped, not protocol-shaped.
 */

// ── Protocol primitives — canonical home is @dexterai/vault ────────────
export type {
  TabNetworkId,
  AtomicAmount,
  HumanAmount,
  SessionScope,
  SessionKey,
  VoucherPayload,
  SignedVoucher,
} from '@dexterai/vault/types';

import type {
  TabNetworkId,
  AtomicAmount,
  HumanAmount,
  SessionScope,
  SessionKey,
  VoucherPayload,
  SignedVoucher,
} from '@dexterai/vault/types';

// ────────────────────────────────────────────────────────────────────────────
// Vault adapter — the abstraction that lets one SDK call site serve OTS on
// every chain. Solana adapter ships first; an EVM adapter slots into the
// same interface when EVM vault parity lands.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Adapter for a specific chain's OTS vault implementation. The SDK calls into
 * `authorizeSession()` ONCE per tab and `signWithSession()` many times. The
 * adapter owns the chain-specific wiring (Solana passkey via WebAuthn or
 * noble-curves, EVM passkey via 7212-aware smart account, etc.).
 *
 * IMPORTANT: this interface must remain stable across vault chains. New
 * chains add adapters; the SDK call site does not change.
 */
export interface VaultAdapter {
  /** Which chain this adapter operates on. */
  network: TabNetworkId;
  /** Wallet holding the buyer's funds. */
  swigAddress: string;
  /** Program/contract account holding the OTS gate state. */
  vaultPda: string;
  /** New Solana sessions are context-bound V2. Legacy/custom adapters may
   * omit this and retain the historical V1 runtime contract. */
  readonly sessionVoucherVersion?: 1 | 2;

  /**
   * Use the ROOT signer (passkey) to authorize a fresh session key. This is
   * the only call that prompts the user. V7 live replacement binds retirement
   * and replacement into one ceremony. Returns a
   * session that can be passed to `signWithSession` freely until the scope's
   * cap or expiry is reached.
   *
   * The session PDA is keyed by (vault, counterparty) — re-authorizing
   * against a counterparty you already hold a LIVE session with resolves to
   * the same PDA. The adapter reads it first and applies
   * `opts.onLiveSession` (default `'error'`): see {@link AuthorizeSessionOptions}.
   */
  authorizeSession(scope: SessionScope, opts?: AuthorizeSessionOptions): Promise<SessionKey>;

  /**
   * Use the session key to sign a voucher. Cheap. Never prompts. The seller
   * verifies against the session's registration; the session's registration
   * was passkey-signed by `authorizeSession`.
   */
  signWithSession(session: SessionKey, payload: VoucherPayload): Promise<SignedVoucher>;

  /**
   * Authorize tab open on chain. Posted through the facilitator, which calls
   * `settle_voucher(amount: 0, increment: true)` with the recorded authority.
   */
  signOpenTab(session: SessionKey, channelId: string): Promise<Uint8Array>;

  /**
   * Authorize tab close on chain. Carries the final cumulative amount; the
   * facilitator settles via `settle_voucher(amount, increment: false)`.
   */
  signCloseTab(session: SessionKey, channelId: string, cumulativeAmount: AtomicAmount): Promise<Uint8Array>;
}

/** Exact durable release fence for a buyer-signed FINAL V2 voucher. */
export interface FinalVoucherV2ReservationInput {
  network: TabNetworkId;
  buyerSwigAddress: string;
  vaultPda: string;
  sessionPda: string;
  seller: string;
  channelId: string;
  sessionNonce: number;
  reservationAmountAtomic: AtomicAmount;
  previousCumulativeAtomic: AtomicAmount;
  voucher: SignedVoucher;
}

export interface FinalVoucherV2ReservationReceipt {
  armed: true;
}

export type ReserveFinalVoucherV2 = (
  input: FinalVoucherV2ReservationInput,
) => Promise<FinalVoucherV2ReservationReceipt>;

/**
 * Live-session policy for `authorizeSession` / `openTab` (K-T4e).
 *
 * The on-chain program rejects registering over a LIVE session
 * (`SessionAlreadyActive`); the pre-guard program silently overwrote it —
 * stranding any of the old session's signed-but-unsettled vouchers beyond
 * the on-chain frontier (`max(spent, crystallized_cumulative)`). Neither is
 * what a buyer wants by accident, so the adapter decides UP FRONT:
 *
 *  - `'error'` (default): throw {@link LiveSessionExistsError} carrying the
 *    live session's on-chain evidence. The caller settles the old tab first
 *    (`tab.close()` — or POST its last signed voucher to `/tab/settle`) and
 *    retries, or acknowledges the replace explicitly.
 *  - `'replace'`: compose the ATOMIC same-transaction
 *    [secp(replace), replace] so the buyer is never left sessionless. Value
 *    already settled or crystallized into LockedClaims survives the replace;
 *    anything signed beyond the frontier is voided.
 */
export interface AuthorizeSessionOptions {
  onLiveSession?: 'error' | 'replace';
}

// ────────────────────────────────────────────────────────────────────────────
// Tab handle — the buyer-side handle returned by `openTab`.
// ────────────────────────────────────────────────────────────────────────────

/** Live state of a buyer's tab. All amounts human units. */
export interface TabState {
  /** Whether the tab is currently open (on chain) and accepting vouchers. */
  isOpen: boolean;
  /** Cumulative amount spent against this tab so far — the SESSION-LIFETIME
   *  odometer, matching the on-chain cumulative semantics. For a
   *  grant-resumed tab (`tabFromGrant`) this INCLUDES the on-chain frontier
   *  the tab resumed above, NOT just this process's spend — a receipt or
   *  meter that displays this field as "what this run spent" would overstate
   *  by the entire frontier. This-process spend = `spent` minus the frontier
   *  the tab was constructed at. (openTab tabs start at 0, where the two
   *  readings agree.) */
  spent: HumanAmount;
  /** Remaining headroom under the session's cap. */
  remaining: HumanAmount;
  /** Seconds until session expiry. May be 0 even if isOpen — close ASAP. */
  expiresInSec: number;
}

/**
 * The buyer's handle to an open tab. Returned by `openTab`; the buyer drives
 * one or more `stream()` calls against it, then `close()`.
 *
 * Mental model: this is to `tab` what `BatchSettlementChannel` is to
 * `batch-settlement` — a per-session live object that owns the buyer's
 * accounting and exposes a streaming I/O primitive.
 */
export interface Tab {
  /** Deterministic channel id derived from buyer/seller/scope/salt. */
  readonly channelId: string;
  /**
   * Voucher contract used by this live handle. V2 FINAL vouchers are fenced
   * by a durable reservation and therefore may never fall through to another
   * payment rail after an indeterminate signing/reservation error.
   *
   * Optional only for source compatibility with third-party Tab
   * implementations built before the versioned contract. Every Tab returned
   * by this package sets it explicitly.
   */
  readonly voucherVersion?: 1 | 2;
  /** Which network the underlying vault lives on. */
  readonly network: TabNetworkId;
  /**
   * The seller this tab was opened against — the base58 pubkey resolved
   * from `OpenTabOptions.seller` at open time (the same value bound into
   * the session scope's `allowedCounterparty`). payAndFetch matches it
   * against a `tab`-scheme option's `payTo` before spending this tab.
   */
  readonly counterparty: string;
  /** Live state. Re-reads after every voucher exchange. */
  readonly state: TabState;

  /**
   * Sign the next cumulative voucher for an increment, WITHOUT sending any
   * request. This is the negotiation primitive: payAndFetch uses it to pay a
   * `tab`-scheme accepts entry by attaching the X-Tab-Voucher header itself.
   * Same counter, same scope enforcement as stream() — throws
   * SessionScopeExceededError past the cap.
   */
  signNextVoucher(incrementAtomic: AtomicAmount): Promise<SignedVoucher>;

  /**
   * Streamed paid request. Returns an async iterable of chunks. Voucher
   * signing is internal: the seller demands a fresh session-signed voucher
   * before delivering each chunk, so the buyer is paid up exactly to what
   * they've received.
   *
   * The async iterable break-on-throw on cap-exceeded, expiry, or signature
   * rejection — the SDK never silently keeps streaming after a failure.
   */
  stream(input: string | URL | Request, init?: RequestInit): Promise<AsyncIterable<Uint8Array>>;

  /**
   * Close the tab. Posts the cumulative voucher through the facilitator;
   * facilitator calls `settle_voucher(amount, increment: false)` on chain.
   * The session key is discarded after this resolves.
   *
   * After close(), the buyer's vault `request_withdrawal` is unblocked (the
   * on-chain gate sees pending_voucher_count return to 0).
   */
  close(): Promise<TabCloseResult>;
}

/** Result of `Tab.close()`. */
export interface TabCloseResult {
  /** Cumulative human amount settled on chain. For a grant-resumed tab
   *  (`tabFromGrant`) this is the session's lifetime odometer — frontier +
   *  this process's spend — matching the on-chain cumulative semantics. */
  settledAmount: HumanAmount;
  /** Facilitator's on-chain settlement signature. */
  settleTx: string;
  /** Whether close() revoked the session on chain. `openTab` tabs revoke
   *  (passkey prompt); `tabFromGrant` tabs are settle-only — the grant
   *  holder has no passkey, so the session PDA stays live until the wallet
   *  owner revokes it or it expiry-sweeps. Absent on results predating this
   *  field. */
  sessionRevoked?: boolean;
  /** Atomic amount moved by the final settle, before any facilitator fee.
   *  Absent when the facilitator predates fee support. */
  grossAmount?: string;
  /** Atomic facilitator fee deducted from the final settle. */
  feeAmount?: string;
  /** Atomic amount the seller actually received from the final settle. */
  netAmount?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Top-level entry-point options.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Options for `openTab` — the buyer's session-opening call.
 *
 * The shape deliberately mirrors `openBatchChannel` so users coming from
 * `batch-settlement` need only learn the new fields (`perUnitCap`,
 * `sessionDuration`).
 */
export interface OpenTabOptions {
  /** OTS vault adapter — Solana adapter ships first; future EVM adapter slots in here. */
  vault: VaultAdapter;
  /** CAIP-2-style network the vault lives on; cross-checked against vault.network. */
  network: TabNetworkId;
  /** Seller's endpoint host (used for the counterparty binding + voucher routing). */
  seller: string;
  /** Max amount per voucher — caps how aggressive a single charge can be. */
  perUnitCap: HumanAmount;
  /** Max cumulative for the WHOLE tab — the session-key cap. */
  totalCap: HumanAmount;
  /** Revolving capacity cap (human units, same scale as perUnitCap/totalCap).
   *  Optional; defaults to totalCap. The on-chain meter (current_outstanding)
   *  is checked against this — set it below totalCap to force capacity to
   *  revolve (turnover > 1). */
  revolvingCapacity?: HumanAmount;
  /** Session expiry, seconds from now. Default: 3600 (1 hour). */
  sessionDuration?: number;
  /** Facilitator base URL. Default: DEFAULT_FACILITATOR_URL (https://x402.dexter.cash), overridable. */
  facilitatorUrl?: string;
  /**
   * What to do when a LIVE session already exists for this (vault, seller)
   * pair — the session PDA is per-counterparty, so re-opening against the
   * same seller collides with it. Default `'error'` (throw
   * {@link LiveSessionExistsError} — never silently strand the old session's
   * unsettled tail); `'replace'` composes the atomic revoke-then-register.
   * See {@link AuthorizeSessionOptions}.
   */
  onLiveSession?: 'error' | 'replace';
  /**
   * Required by V2-capable adapters. The callback must durably persist and
   * establish the exact FINAL voucher reservation before resolving. It must
   * be idempotent for identical voucher bytes; a timeout is retried exactly.
   */
  reserveFinalVoucherV2?: ReserveFinalVoucherV2;
}

/**
 * Options for `resumeTab` — open a handle to a tab that was opened by a
 * previous process. Recovery surface for crashed buyers.
 *
 * NOTE: a resumed tab requires a fresh session key, because session keys are
 * memory-only by design. The first call after resume prompts the passkey
 * once to authorize a new session bound to the same channelId.
 */
export interface ResumeTabOptions {
  vault: VaultAdapter;
  network: TabNetworkId;
  seller: string;
  channelId: string;
  perUnitCap: HumanAmount;
  totalCap: HumanAmount;
  sessionDuration?: number;
  facilitatorUrl?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Errors. Public so downstream phases can throw these explicitly and so
// callers can `instanceof`-discriminate.
// ────────────────────────────────────────────────────────────────────────────

/** Thrown when the SDK is invoked against a chain it does not yet support. */
export class UnsupportedNetworkError extends Error {
  constructor(public readonly network: string) {
    super(`Network ${network} is not yet supported by @dexterai/x402/tab`);
    this.name = 'UnsupportedNetworkError';
  }
}

/** Thrown by a buyer call when the session-key cap or expiry would be exceeded. */
export class SessionScopeExceededError extends Error {
  constructor(
    public readonly reason: 'cap_exceeded' | 'expired' | 'wrong_counterparty',
    detail?: string,
  ) {
    super(`Session scope exceeded: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'SessionScopeExceededError';
  }
}

/** Thrown when the buyer tries to operate against a tab that has been closed. */
export class TabClosedError extends Error {
  constructor(public readonly channelId: string) {
    super(`Tab ${channelId} is already closed`);
    this.name = 'TabClosedError';
  }
}

/** The on-chain evidence a stranding-guard refusal carries. All amounts are
 *  atomic strings read from the live SessionAccount PDA. */
export interface LiveSessionDetails {
  /** The seller (counterparty) whose session PDA is live. */
  allowedCounterparty: string;
  /** The LIVE session's ed25519 pubkey (hex) — NOT the one being requested. */
  sessionPubkeyHex: string;
  /** Unix-seconds expiry of the live session (it self-heals here). */
  expiresAtUnix: number;
  /** Cumulative already SETTLED on-chain (USDC moved to the seller). */
  spentAtomic: string;
  /** Cumulative already CRYSTALLIZED into LockedClaims (survives a revoke —
   *  claims are separate PDAs and settle independently). */
  crystallizedCumulativeAtomic: string;
  /** The live revolving meter (armed exposure not yet settled/released). */
  currentOutstandingAtomic: string;
  /** max(spent, crystallized) — everything the chain has terminally counted.
   *  A replace strands ONLY vouchers signed beyond this frontier. */
  frontierAtomic: string;
}

/**
 * Thrown by `authorizeSession` / `openTab` when a LIVE session already
 * exists for the target (vault, counterparty) PDA and the caller did not
 * pass `onLiveSession: 'replace'` (K-T4e stranding guard).
 *
 * WHY THIS IS LOUD: revoking (or atomically replacing) a live session zeroes
 * its entire on-chain registration — any voucher the OLD session key signed
 * beyond the frontier (`max(spent, crystallized)`) becomes permanently
 * unsettleable, stranding the seller's unsecured tail. The chain cannot see
 * that tail (signed vouchers live off-chain), so the SDK refuses to replace
 * silently. Remediate by settling the old tab first (`tab.close()`, or POST
 * its last signed voucher to the facilitator's `/tab/settle`), then retry —
 * or acknowledge the replace explicitly if the tail is known-settled or
 * intentionally abandoned.
 */
export class LiveSessionExistsError extends Error {
  constructor(public readonly details: LiveSessionDetails) {
    super(
      `a LIVE session already exists for counterparty ${details.allowedCounterparty} ` +
        `(session ${details.sessionPubkeyHex.slice(0, 16)}…, expires ${details.expiresAtUnix}; ` +
        `on-chain spent=${details.spentAtomic}, crystallized=${details.crystallizedCumulativeAtomic}, ` +
        `frontier=${details.frontierAtomic}). Replacing it voids any signed-but-unsettled ` +
        `vouchers beyond the frontier. Settle the old tab first (tab.close() or POST its last ` +
        `voucher to /tab/settle), or pass onLiveSession: 'replace' to atomically ` +
        `revoke-then-register over it.`,
    );
    this.name = 'LiveSessionExistsError';
  }
}
