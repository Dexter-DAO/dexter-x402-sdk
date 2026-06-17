/**
 * Durable per-channel seller ledger for OTS tab streaming.
 *
 * Supersedes VoucherStore: it persists the latest accepted voucher AND the
 * one quantity the chain never sees — `deliveredCumulativeAtomic`, the
 * cumulative service the meter has actually delivered on this channel across
 * ALL requests. Monotonic, never reset. This is what closes the channel-reuse
 * metering leak: the meter budgets each request against
 * `signedCumulative − deliveredCumulative`, not the lifetime cumulative.
 *
 * Shape mirrors the on-chain SessionRegistration money ledger
 * (spent / crystallized_cumulative / current_outstanding / last_locked_sequence)
 * that already ships in V6, via the optional `onChain` snapshot. That field is
 * RESERVED for the Step-4 lock/LockedClaim model (lock_voucher reads/writes
 * those on-chain) — the off-chain meter does not populate it today. Reserving
 * it here keeps the ledger forward-compatible without a later breaking change.
 *
 * The same durable state is the substrate resumeTab / stranded-tab recovery
 * needs (last voucher + delivered baseline per channel).
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';

import type { AtomicAmount, SignedVoucher } from '../types';

/**
 * Per-channel async mutex. Serializes read-modify-write on one channel's ledger
 * entry so concurrent same-channel requests cannot lose a delivered update.
 * Lightweight promise-chain per channelId; the map entry is a tail promise.
 */
const _channelLocks = new Map<string, Promise<unknown>>();
export function withChannelLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _channelLocks.get(channelId) ?? Promise.resolve();
  const run = prev.then(() => fn(), () => fn()); // run fn after prev settles, success or fail
  _channelLocks.set(channelId, run.then(() => undefined, () => undefined));
  return run;
}

/**
 * Read-through cache of the on-chain SessionRegistration money ledger.
 * RESERVED for Step 4 (lock_voucher / LockedClaim). Not populated by the
 * off-chain meter today. All amounts are atomic (base units) strings.
 */
export interface OnChainLedgerSnapshot {
  spentAtomic: AtomicAmount;
  crystallizedCumulativeAtomic: AtomicAmount;
  currentOutstandingAtomic: AtomicAmount;
  lastLockedSequence: number;
  /** Unix seconds when this snapshot was read from chain. */
  fetchedAtUnixSec: number;
}

export interface ChannelLedgerEntry {
  /** Latest accepted voucher. `payload.cumulativeAmount` is the signedCumulative. */
  lastVoucher: SignedVoucher;
  /**
   * Off-chain cumulative the meter has DELIVERED on this channel across all
   * requests. Monotonic; never reset. The leak-fix field.
   */
  deliveredCumulativeAtomic: AtomicAmount;
  /** RESERVED (Step 4): on-chain money ledger snapshot. Unset today. */
  onChain?: OnChainLedgerSnapshot;
}

export interface ChannelLedger {
  get(channelId: string): Promise<ChannelLedgerEntry | null>;
  set(channelId: string, entry: ChannelLedgerEntry): Promise<void>;
  delete(channelId: string): Promise<void>;
}

// ── In-memory ledger (zero-config default; loses state on restart) ──────

export class InMemoryChannelLedger implements ChannelLedger {
  private map = new Map<string, ChannelLedgerEntry>();

  async get(channelId: string): Promise<ChannelLedgerEntry | null> {
    return this.map.get(channelId) ?? null;
  }

  async set(channelId: string, entry: ChannelLedgerEntry): Promise<void> {
    this.map.set(channelId, entry);
  }

  async delete(channelId: string): Promise<void> {
    this.map.delete(channelId);
  }
}

// ── Serialization helpers (Uint8Array voucher fields → hex) ─────────────

interface SerializedEntry {
  lastVoucher: {
    payload: SignedVoucher['payload'];
    sessionPublicKey: string;
    sessionRegistration: string;
    sessionSignature: string;
  };
  deliveredCumulativeAtomic: AtomicAmount;
  onChain?: OnChainLedgerSnapshot;
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (const x of b) out += x.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hex length must be even, got ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function serialize(entry: ChannelLedgerEntry): SerializedEntry {
  return {
    lastVoucher: {
      payload: entry.lastVoucher.payload,
      sessionPublicKey: bytesToHex(entry.lastVoucher.sessionPublicKey),
      sessionRegistration: bytesToHex(entry.lastVoucher.sessionRegistration),
      sessionSignature: bytesToHex(entry.lastVoucher.sessionSignature),
    },
    deliveredCumulativeAtomic: entry.deliveredCumulativeAtomic,
    onChain: entry.onChain,
  };
}

function deserialize(s: SerializedEntry): ChannelLedgerEntry {
  return {
    lastVoucher: {
      payload: s.lastVoucher.payload,
      sessionPublicKey: hexToBytes(s.lastVoucher.sessionPublicKey),
      sessionRegistration: hexToBytes(s.lastVoucher.sessionRegistration),
      sessionSignature: hexToBytes(s.lastVoucher.sessionSignature),
    },
    deliveredCumulativeAtomic: s.deliveredCumulativeAtomic,
    onChain: s.onChain,
  };
}

// ── File-backed ledger (durable across restarts; one JSON file per channel) ──
//
// Atomicity matches FileVoucherStore: write-then-rename. The middleware
// serializes writes per channel, so concurrent same-channel writes don't race
// in practice. Production sellers expecting high concurrency implement
// ChannelLedger over Redis/Postgres and pass it into tabMiddleware.

export class FileChannelLedger implements ChannelLedger {
  constructor(private readonly dir: string) {}

  private pathFor(channelId: string): string {
    if (!/^[a-z0-9_-]+$/i.test(channelId)) {
      throw new Error(`unsafe channelId for filesystem: ${channelId}`);
    }
    return join(this.dir, `${channelId}.json`);
  }

  async get(channelId: string): Promise<ChannelLedgerEntry | null> {
    try {
      const raw = await fs.readFile(this.pathFor(channelId), 'utf8');
      return deserialize(JSON.parse(raw) as SerializedEntry);
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  async set(channelId: string, entry: ChannelLedgerEntry): Promise<void> {
    const path = this.pathFor(channelId);
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(serialize(entry)));
    await fs.rename(tmp, path);
  }

  async delete(channelId: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(channelId));
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }
}
