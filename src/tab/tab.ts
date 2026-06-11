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
  /** Seller base58 pubkey — same value bound into scope.allowedCounterparty. */
  counterparty: string;
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
  readonly counterparty: string;

  private readonly internals: TabInternals;
  private cumulativeAtomic: bigint = 0n;
  private sequenceNumber: number = 0;
  private closed = false;
  /** Most recent voucher we signed. Held so `close()` can POST it to the
   *  facilitator for on-chain settle without needing the seller to round-trip
   *  it back to us. Null if no voucher was signed in this tab's lifetime
   *  (close-without-stream → nothing to settle). */
  private lastSignedVoucher: SignedVoucher | null = null;
  /** One level of voucher history: the voucher that was `lastSignedVoucher`
   *  immediately before the current one. Retained so `rollbackVoucher` can
   *  restore the pre-refusal voucher when a seller honestly refuses the
   *  most recent one. Set at commit time inside `signNextVoucher`. */
  private previousSignedVoucher: SignedVoucher | null = null;

  constructor(internals: TabInternals) {
    this.internals = internals;
    this.channelId = internals.channelIdHex;
    this.network = internals.network;
    this.counterparty = internals.counterparty;
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

    // Commit: counters, one level of history, and the new last voucher.
    this.previousSignedVoucher = this.lastSignedVoucher;
    this.lastSignedVoucher = signed;
    this.sequenceNumber = nextSequence;
    this.cumulativeAtomic = newCumulative;
    return signed;
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
      this.sequenceNumber = prev.payload.sequenceNumber;
      this.cumulativeAtomic = BigInt(prev.payload.cumulativeAmount);
      this.lastSignedVoucher = prev;
    } else if (last.payload.sequenceNumber === 1) {
      // The refused voucher was the tab's first — revert to the pristine state.
      this.sequenceNumber = 0;
      this.cumulativeAtomic = 0n;
      this.lastSignedVoucher = null;
    } else {
      // History exhausted (only one level retained) — refuse rather than guess.
      return false;
    }
    this.previousSignedVoucher = null;
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
    if (this.closed) throw new TabClosedError(this.channelId);

    let settled: SettleResult = { settleTx: '' };
    if (this.lastSignedVoucher && this.cumulativeAtomic > 0n) {
      settled = await postSettle(
        this.internals.facilitatorUrl,
        this.lastSignedVoucher,
        this.internals.network,
      );
    }

    await this.internals.vault.signCloseTab(
      this.internals.session,
      this.channelId,
      this.cumulativeAtomic.toString(),
    );

    this.closed = true;
    this.internals.session.privateKey.fill(0);

    return {
      settledAmount: atomicToHuman(this.cumulativeAtomic.toString()),
      ...settled,
    };
  }
}

/**
 * Serialize a signed voucher to the `X-Tab-Voucher` header value:
 * base64-encoded JSON with hex-encoded byte fields. This is THE wire
 * encoding the seller middleware and the facilitator's `/tab/settle`
 * endpoint both parse — `stream()` uses it, and `payAndFetch` uses it to
 * pay a `tab`-scheme accepts entry directly.
 */
export function voucherToHeader(signed: SignedVoucher): string {
  return Buffer.from(
    JSON.stringify({
      payload: signed.payload,
      sessionPublicKey: bytesToHex(signed.sessionPublicKey),
      sessionRegistration: bytesToHex(signed.sessionRegistration),
      sessionSignature: bytesToHex(signed.sessionSignature),
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
): Promise<SettleResult> {
  const url = `${facilitatorUrl.replace(/\/$/, '')}/tab/settle`;
  const body = {
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
    throw new Error(`tab settle ${res.status}: ${text.slice(0, 500)}`);
  }
  let parsed: {
    settleTx?: string;
    grossAmount?: unknown;
    feeAmount?: unknown;
    netAmount?: unknown;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`tab settle returned non-JSON: ${text.slice(0, 200)}`);
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

  const session = await options.vault.authorizeSession(scope);

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
          // Unescape the SSE-encoded newlines the meter applied.
          const text = parsed.data.replace(/\\n/g, '\n');
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
