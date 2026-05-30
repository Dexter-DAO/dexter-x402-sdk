/**
 * The `Tab` runtime — the live object returned by `openTab()`.
 *
 * Owns: the session key, the channel id, the cumulative-amount counter,
 * the voucher sequence counter. Exposes: `stream()` for paid streamed
 * requests and `close()` for revocation + settlement.
 *
 * Phase 2 ships `open` and `close` against the live program; `stream()`
 * is the seller-facing surface that lands fully in Phase 3 once the
 * seller middleware is built. For Phase 2, `stream()` throws a clear
 * "phase 3" error — but the open/close round-trip works end to end.
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
} from './types';
import {
  TabClosedError,
  SessionScopeExceededError,
  UnsupportedNetworkError,
} from './types';

import { deriveChannelId } from './sessions';

// ── Defaults ───────────────────────────────────────────────────────────

/** Default session lifetime: 1 hour. Aggressive limits are the buyer's
 *  first line of defense against a stolen session. */
const DEFAULT_SESSION_DURATION_SEC = 3600;

/** Live Dexter x402 facilitator API. NOT facilitator.dexter.cash —
 *  that's a marketing redirect. See reference_dexter_facilitator_url.md. */
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
  session: SessionKey;
  channelIdHex: string;
  channelIdBytes: Uint8Array;
  perUnitCapAtomic: bigint;
  totalCapAtomic: bigint;
  expiresAtUnix: number;
  facilitatorUrl: string;
}

class TabImpl implements Tab {
  readonly channelId: string;
  readonly network: TabNetworkId;

  private readonly internals: TabInternals;
  private cumulativeAtomic: bigint = 0n;
  private sequenceNumber: number = 0;
  private closed = false;

  constructor(internals: TabInternals) {
    this.internals = internals;
    this.channelId = internals.channelIdHex;
    this.network = internals.network;
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
  async signNextVoucher(incrementAtomic: AtomicAmount): Promise<SignedVoucher> {
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

    this.sequenceNumber += 1;
    this.cumulativeAtomic = newCumulative;

    const payload: VoucherPayload = {
      channelId: this.channelId,
      cumulativeAmount: this.cumulativeAtomic.toString(),
      sequenceNumber: this.sequenceNumber,
    };

    const signed = await this.internals.vault.signWithSession(this.internals.session, payload);
    return signed;
  }

  /**
   * Streamed paid request. Phase 3 lands the full implementation against
   * a real seller. Phase 2 stub explains the gap so a caller doesn't get
   * a silent stall.
   */
  async stream(_input: string | URL | Request, _init?: RequestInit): Promise<AsyncIterable<Uint8Array>> {
    if (this.closed) throw new TabClosedError(this.channelId);
    throw new Error(
      'tab.stream() requires Phase 3 seller middleware. ' +
      'Use tab.signNextVoucher() to drive a manual paid-stream loop against ' +
      'any seller endpoint that understands the voucher format.',
    );
  }

  /**
   * Close the tab. Revokes the session key on chain (one passkey prompt)
   * and clears the in-memory keypair. The on-chain settle of
   * pending_voucher_count is Phase 3 work — at that point we'll hand the
   * lastSignedVoucher to the facilitator for the settle_voucher tx.
   */
  async close(): Promise<TabCloseResult> {
    if (this.closed) throw new TabClosedError(this.channelId);

    // 1. Sign + submit the revocation tx. The session key is no longer
    //    accepted by any seller after this lands.
    await this.internals.vault.signCloseTab(
      this.internals.session,
      this.channelId,
      this.cumulativeAtomic.toString(),
    );

    this.closed = true;

    // 2. Best-effort wipe the in-memory private key. JS can't truly clear
    //    memory, but we can at least null the reference and zero the
    //    buffer so a heap dump after close doesn't trivially recover it.
    this.internals.session.privateKey.fill(0);

    // 3. Phase 2 returns the cumulative human amount; the on-chain settle
    //    tx (which actually transfers funds to the seller) is Phase 3.
    //    Returning empty string for settleTx makes that gap explicit.
    return {
      settledAmount: atomicToHuman(this.cumulativeAtomic.toString()),
      settleTx: '',
    };
  }
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

  // 4. Build the session scope and authorize the session key on chain.
  //    This is the ONE passkey prompt of the tab lifecycle.
  const durationSec = options.sessionDuration ?? DEFAULT_SESSION_DURATION_SEC;
  const expiresAtUnix = Math.floor(Date.now() / 1000) + durationSec;

  const scope: SessionScope = {
    channelId: channelIdHex,
    maxAmountAtomic: totalCapAtomic.toString(),
    expiresAtUnix,
    allowedCounterparty: sellerToCounterparty(options.seller),
  };

  const session = await options.vault.authorizeSession(scope);

  return new TabImpl({
    vault: options.vault,
    network: options.network,
    seller: options.seller,
    session,
    channelIdHex,
    channelIdBytes,
    perUnitCapAtomic,
    totalCapAtomic,
    expiresAtUnix,
    facilitatorUrl: options.facilitatorUrl ?? DEFAULT_FACILITATOR_URL,
  });
}

export async function resumeTab(_options: ResumeTabOptions): Promise<Tab> {
  // Phase 2 doesn't ship resume because session keys are memory-only by
  // design. Resume requires reading active_session off chain, then
  // prompting the passkey to authorize a NEW session that picks up the
  // existing channel id. Phase 3 wires this up because it needs the
  // adapter to expose `readActiveSession()` which doesn't exist yet.
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

// Re-export the helpers callers want.
export { TabImpl };
