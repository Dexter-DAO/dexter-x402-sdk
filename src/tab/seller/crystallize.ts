/**
 * Keyless crystallization cadence for the seller meter (Step-4 lock-mode).
 *
 * The buyer is OFFLINE: their latest voucher is already signed and durably
 * stored in the ChannelLedger (`entry.lastVoucher`). On a configurable
 * delivered-amount threshold — and at tab close — the seller's meter POSTs
 * that stored voucher, server-to-server, to the facilitator's `/tab/lock`
 * endpoint, which crystallizes it into an on-chain LockedClaim.
 *
 * This is BEST-EFFORT by design. A failed crystallize must NEVER block or
 * error the seller's HTTP response — a missed lock just widens the seller's
 * unsecured window (their risk dial). So every error is caught internally and
 * surfaced as a result; these helpers never throw to their caller, and a
 * failed POST does NOT advance `lastCrystallizedCumulativeAtomic` (it retries
 * on the next threshold crossing).
 *
 * Wire shape mirrors `postSettle` (tab.ts) exactly: the facilitator's
 * `/tab/lock` parses the body identically to `/tab/settle`. Field set:
 *   { channelId, cumulativeAmount, sequenceNumber,
 *     sessionPublicKey (hex), sessionSignature (hex),
 *     sessionRegistration (hex), network }
 * channelId is the canonical hex string from the voucher payload;
 * cumulativeAmount is an atomic string; the three byte fields are hex.
 *
 * Note: `network` is NOT carried inside the voucher — it lives on the seller
 * middleware config (`config.network`) — so it's threaded in as a parameter
 * rather than read from the ledger entry. `sessionRegistration` IS retained
 * per-channel: it rides inside the stored `lastVoucher`, so no extra ledger
 * field is needed to crystallize.
 */

import { bytesToHex } from '@noble/hashes/utils';

import type { ChannelLedgerEntry } from './channel-ledger';
import type { TabNetworkId } from '../types';

/** Result of a crystallize attempt. Errors are surfaced here, never thrown. */
export interface CrystallizeResult {
  crystallized: boolean;
  claimPda?: string;
  error?: string;
}

/** Cadence config (resolved — thresholdAtomic + onClose are concrete here). */
export interface LockCadence {
  thresholdAtomic: string;
  onClose: boolean;
}

/** Injectable dependencies (fetch impl for testability). */
export interface CrystallizeDeps {
  fetchImpl?: typeof fetch;
}

/** Hard ceiling on a single crystallize POST so a hung facilitator can't leak
 *  the connection forever. Best-effort: an abort hits the catch → no advance,
 *  retries on the next threshold crossing. House style uses 20s on the RPC
 *  adapter; 15s is fine for this server-to-server lock POST. */
const CRYSTALLIZE_TIMEOUT_MS = 15_000;

/**
 * POST the stored signed voucher (`entry.lastVoucher`) to
 * `${facilitatorUrl}/tab/lock` using the same wire-body shape as `postSettle`.
 * No-op (returns `{ crystallized: false }`) when `lastVoucher` is null. Catches
 * every error internally — a reject or non-2xx resolves with `crystallized:
 * false` and an `error` string; it never throws to the caller.
 */
export async function crystallizeNow(
  entry: ChannelLedgerEntry,
  // The ledger-key channel id. Used as a cheap correctness guard: it must match
  // the SIGNED voucher's payload.channelId before we POST, so we never lock a
  // voucher under the wrong channel. The value actually POSTed is the voucher's
  // own payload.channelId (the signed value).
  channelId: string,
  facilitatorUrl: string,
  network: TabNetworkId,
  fetchImpl: typeof fetch = fetch,
): Promise<CrystallizeResult> {
  const voucher = entry.lastVoucher;
  if (!voucher) return { crystallized: false };

  // Guard: never crystallize a voucher whose signed channelId disagrees with the
  // ledger key we were asked to lock. Surfaced as a result, never thrown.
  if (voucher.payload.channelId !== channelId) {
    return { crystallized: false, error: 'channel_id_mismatch' };
  }

  try {
    const url = `${facilitatorUrl.replace(/\/$/, '')}/tab/lock`;
    const body = {
      channelId: voucher.payload.channelId,
      cumulativeAmount: voucher.payload.cumulativeAmount,
      sequenceNumber: voucher.payload.sequenceNumber,
      sessionPublicKey: bytesToHex(voucher.sessionPublicKey),
      sessionSignature: bytesToHex(voucher.sessionSignature),
      sessionRegistration: bytesToHex(voucher.sessionRegistration),
      network,
    };
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // Bounded POST: an unresponsive facilitator aborts here → AbortError →
      // caught below → best-effort { crystallized: false } (no advance, retries).
      signal: AbortSignal.timeout(CRYSTALLIZE_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      return { crystallized: false, error: `tab lock ${res.status}: ${text.slice(0, 200)}` };
    }
    let claimPda: string | undefined;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.claimPda === 'string') claimPda = parsed.claimPda;
    } catch {
      // A 2xx with a non-JSON body still counts as crystallized; the lock
      // landed even if we couldn't read the claim PDA back.
    }
    return { crystallized: true, claimPda };
  } catch (err: any) {
    return { crystallized: false, error: String(err?.message ?? err) };
  }
}

/**
 * Fire `crystallizeNow` only when the UN-crystallized delivered delta crosses
 * the cadence threshold:
 *
 *   delivered - lastCrystallized >= thresholdAtomic
 *
 * No-op below threshold. On a successful POST, advances
 * `entry.lastCrystallizedCumulativeAtomic` to the cumulative of the VOUCHER that
 * was POSTed (`lastVoucher.payload.cumulativeAmount`) — the value actually
 * crystallized on-chain — so the watermark is truthful (it tracks the highest
 * voucher cumulative secured, not a delivered snapshot). The meter caps delivery
 * at the signed voucher, so the voucher cumulative >= delivered: crystallizing
 * it secures at least what's delivered — conservative and correct. On a FAILED
 * POST it does NOT advance (so the next threshold check retries). Never throws.
 */
export async function maybeCrystallize(
  entry: ChannelLedgerEntry,
  channelId: string,
  facilitatorUrl: string,
  network: TabNetworkId,
  cadence: LockCadence,
  deps: CrystallizeDeps = {},
): Promise<CrystallizeResult> {
  const delivered = BigInt(entry.deliveredCumulativeAtomic);
  const lastCrystallized = BigInt(entry.lastCrystallizedCumulativeAtomic ?? '0');
  const threshold = BigInt(cadence.thresholdAtomic);

  if (delivered - lastCrystallized < threshold) {
    return { crystallized: false };
  }

  // The voucher we're about to POST is what actually gets crystallized on-chain;
  // capture ITS cumulative as the watermark target (FIX C1). Read before the
  // POST so an in-flight voucher swap can't let us advance past what we locked.
  const target = entry.lastVoucher?.payload.cumulativeAmount;
  const result = await crystallizeNow(entry, channelId, facilitatorUrl, network, deps.fetchImpl);
  if (result.crystallized && target !== undefined) {
    entry.lastCrystallizedCumulativeAtomic = target;
  }
  return result;
}
