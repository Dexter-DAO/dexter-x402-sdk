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

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (const x of b) out += x.toString(16).padStart(2, '0');
  return out;
}

/**
 * POST the stored signed voucher (`entry.lastVoucher`) to
 * `${facilitatorUrl}/tab/lock` using the same wire-body shape as `postSettle`.
 * No-op (returns `{ crystallized: false }`) when `lastVoucher` is null. Catches
 * every error internally — a reject or non-2xx resolves with `crystallized:
 * false` and an `error` string; it never throws to the caller.
 */
export async function crystallizeNow(
  entry: ChannelLedgerEntry,
  // Accepted for call-site symmetry with maybeCrystallize / the ledger key; the
  // canonical channel id POSTed to the facilitator is read from the voucher
  // payload (the signed value), not this param.
  _channelId: string,
  facilitatorUrl: string,
  network: TabNetworkId,
  fetchImpl: typeof fetch = fetch,
): Promise<CrystallizeResult> {
  const voucher = entry.lastVoucher;
  if (!voucher) return { crystallized: false };

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
 * `entry.lastCrystallizedCumulativeAtomic` to the delivered cumulative that was
 * crystallized so the next call doesn't double-fire. On a FAILED POST it does
 * NOT advance (so the next threshold check retries). Never throws.
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

  // Snapshot the cumulative we're about to crystallize BEFORE the POST, so an
  // in-flight delivery bump doesn't let us advance past what the lock covered.
  const target = entry.deliveredCumulativeAtomic;
  const result = await crystallizeNow(entry, channelId, facilitatorUrl, network, deps.fetchImpl);
  if (result.crystallized) {
    entry.lastCrystallizedCumulativeAtomic = target;
  }
  return result;
}
