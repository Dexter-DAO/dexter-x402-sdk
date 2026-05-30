/**
 * @dexterai/x402/tab — type contract for the OTS-backed streaming payment module.
 *
 * Peer of `batch-settlement`. Where `batch-settlement` is for N discrete paid
 * requests against one escrow channel, `tab` is for *continuous metered
 * consumption* — tokens, bytes, frames, seconds — settled on close.
 *
 * Full design: see `docs/DESIGN-tab-streaming.md`. This file is the contract
 * lock for Phase 1: the public types and option shapes that downstream phases
 * must implement against without drift.
 */

/**
 * CAIP-2-style network identifier. The buyer-side `openTab` accepts a string
 * here so future networks (EVM L2s) require no API change — only a new
 * VaultAdapter implementation.
 */
export type TabNetworkId = 'solana:mainnet' | (string & {});

/**
 * Atomic-unit cumulative amount the seller is asking the buyer to authorize
 * for a single voucher. Strings to avoid bigint JSON-serialization headaches
 * across language boundaries.
 */
export type AtomicAmount = string;

/**
 * Human-readable amount (e.g. "0.001" USDC). Used at SDK boundaries; converted
 * to atomic units internally per the vault's token decimals.
 */
export type HumanAmount = string;

// ────────────────────────────────────────────────────────────────────────────
// Session-key layer (see DESIGN-tab-streaming.md §4.2)
//
// The passkey is expensive to invoke (biometric / hardware prompt). Streaming
// needs hundreds of voucher signatures per session. The session-key pattern
// resolves the conflict: the passkey signs ONCE per tab to authorize a fresh
// in-memory keypair, which then signs vouchers freely. The session key dies
// when the tab closes. Swig's role-policy system is the on-chain primitive
// that makes this enforceable.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Scope of a session key — the limits the passkey embeds into its
 * registration signature. The on-chain program (via Swig) and the seller's
 * middleware (locally) both enforce these.
 */
export interface SessionScope {
  /** The specific tab this session is bound to. */
  channelId: string;
  /** Cumulative cap, atomic units. The session-key cannot sign beyond this. */
  maxAmountAtomic: AtomicAmount;
  /** Wall-clock expiry (unix seconds). Hard deadline regardless of usage. */
  expiresAtUnix: number;
  /** Counterparty restriction — typically the seller's address. */
  allowedCounterparty: string;
}

/**
 * In-memory session key. NEVER persisted to disk. A crashed process forfeits
 * the session and re-prompts the passkey on the next attempt — this is the
 * right default because a session key on disk is a real attack surface.
 */
export interface SessionKey {
  /** Public key the seller verifies signatures against. */
  publicKey: Uint8Array;
  /** Private key — in-memory only. */
  privateKey: Uint8Array;
  /** Limits this session may operate within. */
  scope: SessionScope;
  /** The passkey signature authorizing this session. The seller verifies it
   *  against the vault's registered passkey on every voucher. */
  registration: Uint8Array;
}

// ────────────────────────────────────────────────────────────────────────────
// Voucher format
// ────────────────────────────────────────────────────────────────────────────

/**
 * What the buyer signs per stream chunk, and what the seller verifies before
 * delivering. Cumulative-amount semantics: each voucher represents the TOTAL
 * owed so far, not the incremental amount. Replay-resistant because vouchers
 * monotonically increase.
 */
export interface VoucherPayload {
  channelId: string;
  /** Total owed so far, atomic units. Must strictly exceed the prior voucher. */
  cumulativeAmount: AtomicAmount;
  /** Monotonic sequence number. Replay protection within a tab. */
  sequenceNumber: number;
}

/**
 * The full voucher as sent over the wire: payload + session signature +
 * the registration that authorizes the signing session key. The seller's
 * middleware verifies the registration's passkey signature once per session,
 * caches the result, and verifies only the session-key signature per chunk.
 */
export interface SignedVoucher {
  payload: VoucherPayload;
  sessionPublicKey: Uint8Array;
  sessionRegistration: Uint8Array;
  sessionSignature: Uint8Array;
}

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

  /**
   * Use the ROOT signer (passkey) to authorize a fresh session key. This is
   * the only call that prompts the user. Returns a session that can be passed
   * to `signWithSession` freely until the scope's cap or expiry is reached.
   */
  authorizeSession(scope: SessionScope): Promise<SessionKey>;

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

// ────────────────────────────────────────────────────────────────────────────
// Tab handle — the buyer-side handle returned by `openTab`.
// ────────────────────────────────────────────────────────────────────────────

/** Live state of a buyer's tab. All amounts human units. */
export interface TabState {
  /** Whether the tab is currently open (on chain) and accepting vouchers. */
  isOpen: boolean;
  /** Cumulative amount spent against this tab so far. */
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
  /** Which network the underlying vault lives on. */
  readonly network: TabNetworkId;
  /** Live state. Re-reads after every voucher exchange. */
  readonly state: TabState;

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
  /** Cumulative human amount settled on chain. */
  settledAmount: HumanAmount;
  /** Facilitator's on-chain settlement signature. */
  settleTx: string;
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
  /** Session expiry, seconds from now. Default: 3600 (1 hour). */
  sessionDuration?: number;
  /** Facilitator base URL. Default: https://facilitator.dexter.cash, overridable. */
  facilitatorUrl?: string;
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
