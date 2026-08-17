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
 *
 * Single-stream lease (multi-instance boundary): the per-channel `lease`
 * (tryAcquireLease/releaseLease) enforces ONE live stream per channel, the
 * defense against the concurrent-same-channel over-delivery rug. The default
 * InMemoryChannelLedger / FileChannelLedger acquire it atomically WITHIN one
 * seller process (via the per-channel async lock). A seller running MULTIPLE
 * instances behind a load balancer MUST back ChannelLedger with a store that
 * makes acquisition and every owner/fence mutation atomic across processes
 * (Redis Lua, a versioned Postgres row, etc.). Routing affinity alone is not a
 * takeover fence and is rejected by `production-multi-instance` safety mode.
 */

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  /**
   * Latest accepted voucher (`payload.cumulativeAmount` is the signedCumulative),
   * or `null` for explicitly bootstrapped/legacy entries. Lease identity lives
   * outside the revenue entry so acquiring a lease never fabricates ledger
   * history and callers cannot mutate ownership by spreading an entry.
   */
  lastVoucher: SignedVoucher | null;
  /**
   * Off-chain cumulative the meter has DELIVERED on this channel across all
   * requests. Monotonic; never reset. The leak-fix field.
   */
  deliveredCumulativeAtomic: AtomicAmount;
  /**
   * Delivered cumulative (atomic) that the seller has already crystallized into
   * an on-chain LockedClaim via the keyless `/tab/lock` cadence (Step-4). The
   * crystallization cadence fires when `deliveredCumulativeAtomic −
   * lastCrystallizedCumulativeAtomic` crosses the configured threshold, then
   * advances this on a successful lock so it can't double-fire. Treated as
   * `'0'` when absent (older/bootstrap entries). Optional so
   * pre-Step-4 ledger constructors remain valid without a breaking change.
   */
  lastCrystallizedCumulativeAtomic?: AtomicAmount;
  /**
   * Gate-refused watermark (cadence spec §5 [A12]): the highest voucher
   * cumulative (atomic) the facilitator's router gate REFUSED with
   * `below_lock_cadence`. The crystallization cadence skips re-attempting
   * any span at or below it — the facilitator's server-side engine already
   * guarantees the protection cadence, so re-asking about the identical
   * refused span on every delivery/close is a retry storm, not protection.
   * A NEW signed voucher (higher cumulative) always re-attempts; a
   * successful lock clears it. Absent on entries that were never refused.
   */
  gateRefusedCumulativeAtomic?: AtomicAmount;
  /** RESERVED (Step 4): on-chain money ledger snapshot. Unset today. */
  onChain?: OnChainLedgerSnapshot;
}

/**
 * Capability returned by lease acquisition and required by every mutation.
 * `ownerToken` prevents one process from releasing another's lease; `fence`
 * increases on every successful acquisition so an expired/crashed holder can
 * never write after a takeover, even if it wakes back up later.
 */
export interface ChannelLease {
  ownerToken: string;
  /** Canonical unsigned decimal. A string avoids losing Redis INCR precision. */
  fence: string;
  heldUntilUnixMs: number;
}

/** Public safety declaration for a ChannelLedger adapter. */
export interface ChannelLedgerCapabilities {
  adapter: 'memory' | 'file' | 'redis' | 'custom';
  /** Ledger entries and fence counters survive a process restart. */
  restartSafe: boolean;
  /** Lease acquisition and fenced writes are atomic across seller processes. */
  multiInstanceSafe: boolean;
  /** Every mutation is conditional on owner token + monotonic fence. */
  conditionalWrites: true;
  /**
   * All historical case aliases have been merged into canonical lowercase
   * channel keys (or the durable store was proven empty before first use).
   */
  canonicalChannelIds: boolean;
}

export type ChannelIdCutover = 'legacy-case-aliases-migrated-or-empty';

export interface FileChannelLedgerOptions {
  /** Explicit operator acknowledgement after the documented alias migration. */
  channelIdCutover?: ChannelIdCutover;
}

export class ChannelLeaseLostError extends Error {
  readonly code = 'channel_lease_lost';

  constructor(channelId: string) {
    super(`channel lease lost for ${channelId}`);
    this.name = 'ChannelLeaseLostError';
  }
}

export type ChannelLedgerUpdater = (
  current: ChannelLedgerEntry | null,
) => ChannelLedgerEntry;

export interface ChannelLedger {
  /**
   * All methods must reject noncanonical channel IDs before taking an adapter
   * lock or touching storage. `canonicalChannelIds=true` additionally attests
   * that historical durable aliases were merged or the store was proven empty.
   */
  readonly capabilities: ChannelLedgerCapabilities;
  get(channelId: string): Promise<ChannelLedgerEntry | null>;
  set(channelId: string, entry: ChannelLedgerEntry, lease: ChannelLease): Promise<void>;
  /** Atomic within this adapter instance; the resulting write is lease-fenced. */
  update(
    channelId: string,
    lease: ChannelLease,
    updater: ChannelLedgerUpdater,
  ): Promise<ChannelLedgerEntry>;
  delete(channelId: string, lease: ChannelLease): Promise<void>;
  /**
   * Atomically acquire the channel's single-stream lease if free or expired.
   * Returns a new owner token + monotonically increasing fence if acquired,
   * or null if another live stream holds it. The
   * in-process/file impls serialize via the per-channel lock (correct for a
   * single seller process). A multi-instance seller MUST back this with a store
   * that makes acquisition and fenced writes atomic across processes.
   */
  tryAcquireLease(channelId: string, ttlMs: number): Promise<ChannelLease | null>;
  /** Extend this exact live owner/fence lease; stale owners are rejected. */
  renewLease(
    channelId: string,
    lease: ChannelLease,
    ttlMs: number,
  ): Promise<ChannelLease>;
  /** Conditional release. Returns false when this is a stale/non-owner lease. */
  releaseLease(channelId: string, lease: ChannelLease): Promise<boolean>;
}

/**
 * Normalize the lease TTL shared by adapters and middleware. Node timers clamp
 * values above a signed 32-bit millisecond delay, while NaN/fractions can make
 * store expiry semantics adapter-dependent. Reject them instead of silently
 * creating a near-zero or effectively immortal lease.
 *
 * @internal
 */
export function normalizeLeaseTtlMs(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 3 || ttlMs > 0x7fff_ffff) {
    throw new Error('channel lease TTL must be an integer from 3 to 2147483647 milliseconds');
  }
  return ttlMs;
}

/** @internal Enforce one key identity before any adapter lock or store access. */
export function assertCanonicalChannelId(channelId: string): void {
  if (!/^[0-9a-f]{64}$/.test(channelId)) {
    throw new Error('channelId must be canonical lowercase 64-character hex');
  }
}

function sameLease(left: ChannelLease | undefined, right: ChannelLease): boolean {
  return left !== undefined
    && left.ownerToken === right.ownerToken
    && left.fence === right.fence;
}

function requireLiveLease(
  channelId: string,
  current: ChannelLease | undefined,
  expected: ChannelLease,
): void {
  if (!current || !sameLease(current, expected) || current.heldUntilUnixMs <= Date.now()) {
    throw new ChannelLeaseLostError(channelId);
  }
}

// ── In-memory ledger (zero-config default; loses state on restart) ──────

export class InMemoryChannelLedger implements ChannelLedger {
  readonly capabilities: ChannelLedgerCapabilities = {
    adapter: 'memory',
    restartSafe: false,
    multiInstanceSafe: false,
    conditionalWrites: true,
    // Process-local state cannot survive an upgrade with legacy aliases; all
    // admitted IDs in this process already passed lowercase middleware.
    canonicalChannelIds: true,
  };

  private map = new Map<string, ChannelLedgerEntry>();
  private leases = new Map<string, ChannelLease>();
  private fences = new Map<string, bigint>();

  async get(channelId: string): Promise<ChannelLedgerEntry | null> {
    assertCanonicalChannelId(channelId);
    const entry = this.map.get(channelId);
    return entry ? deserialize(serialize(entry)) : null;
  }

  async set(channelId: string, entry: ChannelLedgerEntry, lease: ChannelLease): Promise<void> {
    assertCanonicalChannelId(channelId);
    await withChannelLock(channelId, async () => {
      requireLiveLease(channelId, this.leases.get(channelId), lease);
      this.map.set(channelId, deserialize(serialize(entry)));
    });
  }

  async update(
    channelId: string,
    lease: ChannelLease,
    updater: ChannelLedgerUpdater,
  ): Promise<ChannelLedgerEntry> {
    assertCanonicalChannelId(channelId);
    return withChannelLock(channelId, async () => {
      requireLiveLease(channelId, this.leases.get(channelId), lease);
      const current = this.map.get(channelId);
      const next = updater(current ? deserialize(serialize(current)) : null);
      const stored = deserialize(serialize(next));
      this.map.set(channelId, stored);
      return deserialize(serialize(stored));
    });
  }

  async delete(channelId: string, lease: ChannelLease): Promise<void> {
    assertCanonicalChannelId(channelId);
    await withChannelLock(channelId, async () => {
      requireLiveLease(channelId, this.leases.get(channelId), lease);
      this.map.delete(channelId);
    });
  }

  async tryAcquireLease(channelId: string, ttlMs: number): Promise<ChannelLease | null> {
    assertCanonicalChannelId(channelId);
    return withChannelLock(channelId, async () => {
      const ttl = normalizeLeaseTtlMs(ttlMs);
      const now = Date.now();
      const current = this.leases.get(channelId);
      if (current && current.heldUntilUnixMs > now) return null;
      const nextFence = (this.fences.get(channelId) ?? 0n) + 1n;
      this.fences.set(channelId, nextFence);
      const lease: ChannelLease = {
        ownerToken: randomUUID(),
        fence: nextFence.toString(),
        heldUntilUnixMs: now + ttl,
      };
      this.leases.set(channelId, lease);
      return { ...lease };
    });
  }

  async releaseLease(channelId: string, lease: ChannelLease): Promise<boolean> {
    assertCanonicalChannelId(channelId);
    return withChannelLock(channelId, async () => {
      const current = this.leases.get(channelId);
      if (!current || !sameLease(current, lease) || current.heldUntilUnixMs <= Date.now()) return false;
      this.leases.delete(channelId);
      return true;
    });
  }

  async renewLease(
    channelId: string,
    lease: ChannelLease,
    ttlMs: number,
  ): Promise<ChannelLease> {
    assertCanonicalChannelId(channelId);
    return withChannelLock(channelId, async () => {
      const ttl = normalizeLeaseTtlMs(ttlMs);
      const current = this.leases.get(channelId);
      requireLiveLease(channelId, current, lease);
      const renewed: ChannelLease = {
        ...current!,
        heldUntilUnixMs: Date.now() + ttl,
      };
      this.leases.set(channelId, renewed);
      return { ...renewed };
    });
  }
}

// ── Serialization helpers (Uint8Array voucher fields → hex) ─────────────
// Exported for out-of-process ChannelLedger impls (Redis, Postgres) so they
// share one wire shape with FileChannelLedger instead of forking their own.

export interface SerializedEntry {
  lastVoucher: {
    payload: SignedVoucher['payload'];
    sessionPublicKey: string;
    sessionRegistration: string;
    sessionSignature: string;
  } | null;
  deliveredCumulativeAtomic: AtomicAmount;
  lastCrystallizedCumulativeAtomic?: AtomicAmount;
  gateRefusedCumulativeAtomic?: AtomicAmount;
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

export function serializeChannelLedgerEntry(entry: ChannelLedgerEntry): SerializedEntry {
  return serialize(entry);
}

export function deserializeChannelLedgerEntry(s: SerializedEntry): ChannelLedgerEntry {
  return deserialize(s);
}

function serialize(entry: ChannelLedgerEntry): SerializedEntry {
  return {
    lastVoucher: entry.lastVoucher
      ? {
          payload: entry.lastVoucher.payload,
          sessionPublicKey: bytesToHex(entry.lastVoucher.sessionPublicKey),
          sessionRegistration: bytesToHex(entry.lastVoucher.sessionRegistration),
          sessionSignature: bytesToHex(entry.lastVoucher.sessionSignature),
        }
      : null,
    deliveredCumulativeAtomic: entry.deliveredCumulativeAtomic,
    lastCrystallizedCumulativeAtomic: entry.lastCrystallizedCumulativeAtomic,
    gateRefusedCumulativeAtomic: entry.gateRefusedCumulativeAtomic,
    onChain: entry.onChain,
  };
}

function deserialize(s: SerializedEntry): ChannelLedgerEntry {
  return {
    lastVoucher: s.lastVoucher
      ? {
          payload: s.lastVoucher.payload,
          sessionPublicKey: hexToBytes(s.lastVoucher.sessionPublicKey),
          sessionRegistration: hexToBytes(s.lastVoucher.sessionRegistration),
          sessionSignature: hexToBytes(s.lastVoucher.sessionSignature),
        }
      : null,
    deliveredCumulativeAtomic: s.deliveredCumulativeAtomic,
    lastCrystallizedCumulativeAtomic: s.lastCrystallizedCumulativeAtomic ?? '0',
    gateRefusedCumulativeAtomic: s.gateRefusedCumulativeAtomic,
    onChain: s.onChain,
  };
}

// ── File-backed ledger (durable across restarts; one JSON file per channel) ──
//
// Atomicity matches FileVoucherStore: write-then-rename. Adapter mutations are
// serialized per channel and require the current owner token + fence. This is
// restart-safe but deliberately declares multiInstanceSafe=false: separate OS
// processes do not share the in-process lock. Use Redis/Postgres for that.

export class FileChannelLedger implements ChannelLedger {
  readonly capabilities: ChannelLedgerCapabilities;

  constructor(
    private readonly dir: string,
    options: FileChannelLedgerOptions = {},
  ) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('FileChannelLedger options must be an object');
    }
    if (
      options.channelIdCutover !== undefined
      && options.channelIdCutover !== 'legacy-case-aliases-migrated-or-empty'
    ) {
      throw new Error('invalid FileChannelLedger channelIdCutover acknowledgement');
    }
    this.capabilities = {
      adapter: 'file',
      restartSafe: true,
      multiInstanceSafe: false,
      conditionalWrites: true,
      canonicalChannelIds:
        options.channelIdCutover === 'legacy-case-aliases-migrated-or-empty',
    };
  }

  private pathFor(channelId: string, suffix = '.json'): string {
    assertCanonicalChannelId(channelId);
    return join(this.dir, `${channelId}${suffix}`);
  }

  private async writeAtomic(path: string, value: string): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, value);
    await fs.rename(tmp, path);
  }

  private async readLease(channelId: string): Promise<ChannelLease | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.pathFor(channelId, '.lease.json'), 'utf8')) as ChannelLease;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async requireLease(channelId: string, lease: ChannelLease): Promise<void> {
    requireLiveLease(channelId, await this.readLease(channelId), lease);
  }

  async get(channelId: string): Promise<ChannelLedgerEntry | null> {
    assertCanonicalChannelId(channelId);
    try {
      const raw = await fs.readFile(this.pathFor(channelId), 'utf8');
      return deserialize(JSON.parse(raw) as SerializedEntry);
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  async set(channelId: string, entry: ChannelLedgerEntry, lease: ChannelLease): Promise<void> {
    assertCanonicalChannelId(channelId);
    await withChannelLock(channelId, async () => {
      await this.requireLease(channelId, lease);
      await this.writeAtomic(this.pathFor(channelId), JSON.stringify(serialize(entry)));
    });
  }

  async update(
    channelId: string,
    lease: ChannelLease,
    updater: ChannelLedgerUpdater,
  ): Promise<ChannelLedgerEntry> {
    assertCanonicalChannelId(channelId);
    return withChannelLock(channelId, async () => {
      await this.requireLease(channelId, lease);
      const next = updater(await this.get(channelId));
      await this.writeAtomic(this.pathFor(channelId), JSON.stringify(serialize(next)));
      return next;
    });
  }

  async delete(channelId: string, lease: ChannelLease): Promise<void> {
    assertCanonicalChannelId(channelId);
    await withChannelLock(channelId, async () => {
      await this.requireLease(channelId, lease);
      try {
        await fs.unlink(this.pathFor(channelId));
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    });
  }

  async tryAcquireLease(channelId: string, ttlMs: number): Promise<ChannelLease | null> {
    assertCanonicalChannelId(channelId);
    return withChannelLock(channelId, async () => {
      const ttl = normalizeLeaseTtlMs(ttlMs);
      const now = Date.now();
      const current = await this.readLease(channelId);
      if (current && current.heldUntilUnixMs > now) return null;
      let currentFence = 0n;
      try {
        currentFence = BigInt(await fs.readFile(this.pathFor(channelId, '.fence'), 'utf8'));
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const fence = currentFence + 1n;
      // Persist the counter before the lease. A crash can skip a number but can
      // never reuse one, which is the only safe direction for a fence.
      await this.writeAtomic(this.pathFor(channelId, '.fence'), fence.toString());
      const lease: ChannelLease = {
        ownerToken: randomUUID(),
        fence: fence.toString(),
        heldUntilUnixMs: now + ttl,
      };
      await this.writeAtomic(this.pathFor(channelId, '.lease.json'), JSON.stringify(lease));
      return lease;
    });
  }

  async releaseLease(channelId: string, lease: ChannelLease): Promise<boolean> {
    assertCanonicalChannelId(channelId);
    return withChannelLock(channelId, async () => {
      const current = await this.readLease(channelId);
      if (!current || !sameLease(current, lease) || current.heldUntilUnixMs <= Date.now()) return false;
      await fs.unlink(this.pathFor(channelId, '.lease.json'));
      return true;
    });
  }

  async renewLease(
    channelId: string,
    lease: ChannelLease,
    ttlMs: number,
  ): Promise<ChannelLease> {
    assertCanonicalChannelId(channelId);
    return withChannelLock(channelId, async () => {
      const ttl = normalizeLeaseTtlMs(ttlMs);
      const current = await this.readLease(channelId);
      requireLiveLease(channelId, current, lease);
      const renewed: ChannelLease = {
        ...current!,
        heldUntilUnixMs: Date.now() + ttl,
      };
      await this.writeAtomic(
        this.pathFor(channelId, '.lease.json'),
        JSON.stringify(renewed),
      );
      return renewed;
    });
  }
}
