/**
 * @dexterai/x402/tab/seller — types for the seller side of OTS tab streaming.
 *
 * The seller middleware verifies vouchers locally (microsecond latency, no
 * chain calls) and demands a fresh session-signed voucher before delivering
 * each chunk. Voucher accumulation is internal; the seller's mental model
 * is "charge for what I serve."
 */

import type {
  AtomicAmount,
  HumanAmount,
  SignedVoucher,
  TabNetworkId,
} from '../types';
import type { ChannelLedger } from './channel-ledger';

/**
 * Persistent store for the seller's per-tab voucher state. The middleware
 * writes the latest accepted voucher after every chunk so a process crash
 * loses at most the last in-flight voucher's worth of revenue. Pluggable to
 * match `batch-settlement/store`'s ChannelStore pattern.
 */
/** @deprecated Superseded by ChannelLedger (channel-ledger.ts), which also persists deliveredCumulative. */
export interface VoucherStore {
  get(channelId: string): Promise<SignedVoucher | null>;
  set(channelId: string, voucher: SignedVoucher): Promise<void>;
  delete(channelId: string): Promise<void>;
}

/**
 * Tab handle injected by `tabMiddleware` onto the Express request. The route
 * handler reads it to drive a metered stream.
 */
export interface SellerTab {
  readonly channelId: string;
  readonly network: TabNetworkId;
  /** The buyer's session pubkey for this tab (set by the first voucher). */
  readonly sessionPublicKey: Uint8Array | null;
  /** Cumulative human amount already accepted via vouchers. */
  cumulative(): HumanAmount;
  /**
   * Accept a fresh voucher from the buyer that bumps the cumulative amount
   * by `incrementHuman`. Throws if the voucher signature, scope, or
   * monotonicity check fails. The middleware persists on success.
   */
  charge(incrementHuman: HumanAmount): Promise<void>;
  /**
   * Off-chain cumulative (human amount) the meter has DELIVERED on this
   * channel across ALL requests, read from the ChannelLedger at request start.
   * The meter's per-request budget is `cumulative() − deliveredCumulative()`.
   */
  deliveredCumulative(): HumanAmount;
  /**
   * Add `incrementAtomic` (this request's delivered amount, atomic) to the
   * channel's durable lifetime delivered total, under a per-channel lock.
   * Monotonic — a non-positive increment is a no-op. Called by the meter once
   * per request on the terminal path (end / cap-reject / disconnect).
   */
  recordDelivered(incrementAtomic: AtomicAmount): Promise<void>;
  /**
   * Release the channel's single-stream lease; called by the meter on the
   * terminal path.
   */
  releaseLease(): Promise<void>;
}

/** Options for `tabMiddleware`. */
export interface TabMiddlewareOptions {
  /** Charge unit denomination (human amount per delivered unit). */
  perUnit: HumanAmount;
  /** Which network the seller accepts. */
  network: TabNetworkId;
  /** When to settle on chain: at tab close (the common case) vs periodically. */
  settle: 'on-close' | 'periodic';
  /** Facilitator base URL. Default: https://facilitator.dexter.cash. */
  facilitatorUrl?: string;
  /**
   * Durable per-channel state (latest voucher + delivered cumulative).
   * Default: in-memory (loses state on restart). Pass a FileChannelLedger or
   * your own ChannelLedger for restart-safe revenue + resumeTab support.
   */
  ledger?: ChannelLedger;
  /**
   * Max single-stream duration before a crashed holder's lease auto-expires.
   * Default 300000 (5 min).
   */
  leaseTtlMs?: number;
  /**
   * Hard cap on a single voucher's incremental amount. Protects the seller's
   * middleware from accepting a buyer trying to slip in a giant single
   * voucher. Default: 100x `perUnit`.
   */
  maxPerVoucherAtomic?: AtomicAmount;
}

/**
 * Options for `openSse` — the Express response → SSE stream helper. Returns
 * a meter the route handler drives.
 */
export interface OpenSseOptions {
  tab: SellerTab;
  /** Per-chunk human amount; default = the middleware's perUnit. */
  perUnit?: HumanAmount;
}

/**
 * Meter returned by `openSse`. The route handler calls `charge()` before
 * delivering each chunk and `send()` to actually push the chunk; `end()`
 * closes the SSE stream without settling.
 */
export interface SseMeter {
  charge(units?: number): Promise<void>;
  send(chunk: string | Uint8Array): void;
  end(): Promise<void>;
}

/** Errors thrown by the seller middleware on bad vouchers. */
export class InvalidVoucherError extends Error {
  constructor(
    public readonly reason:
      | 'signature_invalid'
      | 'registration_invalid'
      | 'cap_exceeded'
      | 'session_expired'
      | 'wrong_counterparty'
      | 'non_monotonic'
      | 'channel_busy',
    detail?: string,
  ) {
    super(`Invalid voucher: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'InvalidVoucherError';
  }
}
