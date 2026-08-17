/**
 * RedisChannelLedger — entry round-trip, cross-instance lease atomicity,
 * TTL expiry, and token-guarded release (an instance that lost its lease to
 * expiry must never delete the next holder's lease).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RedisChannelLedger, type RedisLikeClient } from '../redis-channel-ledger';
import { ChannelLeaseLostError, type ChannelLedgerEntry, type ChannelLease } from '../channel-ledger';

const CHANNEL = 'e'.repeat(64);

/** In-memory fake honoring the exact Redis GET/EVAL scripts the ledger uses. */
class FakeRedis implements RedisLikeClient {
  store = new Map<string, { value: string; expiresAtMs: number | null }>();
  evalError: Error | null = null;

  private live(key: string): { value: string; expiresAtMs: number | null } | undefined {
    const rec = this.store.get(key);
    if (!rec) return undefined;
    if (rec.expiresAtMs !== null && rec.expiresAtMs <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return rec;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<unknown> {
    let px: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === 'PX') px = Number(args[++i]);
      else if (a === 'NX') nx = true;
    }
    if (nx && this.live(key)) return null;
    this.store.set(key, { value, expiresAtMs: px === null ? null : Date.now() + px });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }

  async eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    if (this.evalError) throw this.evalError;
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);

    if (script.includes('return redis.call("get", KEYS[1])')) {
      return this.live(keys[0])?.value ?? null;
    }

    if (script.includes('redis.call("incr"')) {
      const [leaseKey, fenceKey] = keys;
      if (this.live(leaseKey)) return false;
      const fence = BigInt(this.live(fenceKey)?.value ?? '0') + 1n;
      this.store.set(fenceKey, { value: fence.toString(), expiresAtMs: null });
      this.store.set(leaseKey, {
        value: `${argv[0]}:${fence}`,
        expiresAtMs: Date.now() + Number(argv[1]),
      });
      return fence.toString();
    }

    const [leaseKey, secondKey] = keys;
    if (this.live(leaseKey)?.value !== argv[0]) return 0;
    if (script.includes('redis.call("pexpire"')) {
      const current = this.live(leaseKey)!;
      this.store.set(leaseKey, {
        value: current.value,
        expiresAtMs: Date.now() + Number(argv[1]),
      });
      return 1;
    }
    if (script.includes('redis.call("set", KEYS[2], ARGV[2])')) {
      this.store.set(secondKey, { value: argv[1], expiresAtMs: null });
      return 1;
    }
    if (script.includes('redis.call("del", KEYS[2])')) {
      this.store.delete(secondKey);
      return 1;
    }
    this.store.delete(leaseKey);
    return 1;
  }
}

function entry(cumulative: string): ChannelLedgerEntry {
  return {
    lastVoucher: {
      payload: { channelId: CHANNEL, cumulativeAmount: cumulative, sequenceNumber: 3 },
      sessionPublicKey: Uint8Array.from({ length: 32 }, (_, i) => i),
      sessionRegistration: Uint8Array.from({ length: 188 }, (_, i) => (i * 7) % 256),
      sessionSignature: Uint8Array.from({ length: 64 }, (_, i) => 255 - (i % 256)),
    },
    deliveredCumulativeAtomic: cumulative,
    lastCrystallizedCumulativeAtomic: '0',
  };
}

describe('RedisChannelLedger', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    vi.useFakeTimers();
    redis = new FakeRedis();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function acquire(ledger: RedisChannelLedger, ttlMs = 5000): Promise<ChannelLease> {
    const lease = await ledger.tryAcquireLease(CHANNEL, ttlMs);
    if (!lease) throw new Error('expected Redis lease');
    return lease;
  }

  it('round-trips an entry with Uint8Array voucher fields intact', async () => {
    const ledger = new RedisChannelLedger(redis);
    const lease = await acquire(ledger);
    await ledger.set(CHANNEL, entry('150000'), lease);
    const got = await ledger.get(CHANNEL);
    expect(got).not.toBeNull();
    expect(got!.lastVoucher!.payload.cumulativeAmount).toBe('150000');
    expect(got!.lastVoucher!.sessionPublicKey).toBeInstanceOf(Uint8Array);
    expect(Array.from(got!.lastVoucher!.sessionPublicKey)).toEqual(
      Array.from(Uint8Array.from({ length: 32 }, (_, i) => i)),
    );
    expect(got!.deliveredCumulativeAtomic).toBe('150000');
  });

  it('get returns null for a missing channel', async () => {
    const ledger = new RedisChannelLedger(redis);
    expect(await ledger.get(CHANNEL)).toBeNull();
  });

  it('keeps lease identity out of the durable revenue entry', async () => {
    const ledger = new RedisChannelLedger(redis);
    const lease = await acquire(ledger);
    await ledger.set(CHANNEL, entry('1'), lease);
    const persisted = JSON.parse(redis.store.get(`tab:ledger:${CHANNEL}`)!.value);
    expect(persisted.lease).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain(lease.ownerToken);
  });

  it('lease is exclusive across instances and reopens after TTL expiry', async () => {
    const a = new RedisChannelLedger(redis);
    const b = new RedisChannelLedger(redis); // second process, same Redis
    const first = await acquire(a);
    expect(await b.tryAcquireLease(CHANNEL, 5000)).toBeNull();
    expect(await a.tryAcquireLease(CHANNEL, 5000)).toBeNull(); // strict: even the holder re-acquires only after release/expiry
    vi.advanceTimersByTime(5001);
    const takeover = await acquire(b);
    expect(BigInt(takeover.fence)).toBeGreaterThan(BigInt(first.fence));
  });

  it('rejects invalid TTLs before sending PX or PEXPIRE to Redis', async () => {
    const ledger = new RedisChannelLedger(redis);
    await expect(ledger.tryAcquireLease(CHANNEL, NaN)).rejects.toThrow(/lease TTL/);
    await expect(ledger.tryAcquireLease(CHANNEL, Infinity)).rejects.toThrow(/lease TTL/);
    const lease = await acquire(ledger);
    await expect(ledger.renewLease(CHANNEL, lease, 1.5)).rejects.toThrow(/lease TTL/);
  });

  it('renews only the exact owner/fence without changing its monotonic fence', async () => {
    const owner = new RedisChannelLedger(redis);
    const other = new RedisChannelLedger(redis);
    const lease = await acquire(owner);
    vi.advanceTimersByTime(4000);
    const renewed = await owner.renewLease(CHANNEL, lease, 5000);
    expect(renewed.fence).toBe(lease.fence);
    expect(renewed.ownerToken).toBe(lease.ownerToken);
    vi.advanceTimersByTime(2000); // original TTL elapsed; renewed lease lives
    expect(await other.tryAcquireLease(CHANNEL, 5000)).toBeNull();
    await expect(
      other.renewLease(CHANNEL, { ...lease, ownerToken: 'stale' }, 5000),
    ).rejects.toBeInstanceOf(ChannelLeaseLostError);
  });

  it('release only deletes the lease this instance still owns (token guard)', async () => {
    const a = new RedisChannelLedger(redis);
    const b = new RedisChannelLedger(redis);
    const stale = await acquire(a);
    vi.advanceTimersByTime(5001); // A's lease expires…
    const current = await acquire(b); // …B takes over
    expect(await a.releaseLease(CHANNEL, stale)).toBe(false); // stale A releases — must NOT delete B's lease
    const c = new RedisChannelLedger(redis);
    expect(await c.tryAcquireLease(CHANNEL, 5000)).toBeNull(); // B still holds
    expect(await b.releaseLease(CHANNEL, current)).toBe(true);
    expect(await c.tryAcquireLease(CHANNEL, 5000)).not.toBeNull(); // real release frees it
  });

  it('releaseLease is a no-op for an instance that never acquired', async () => {
    const a = new RedisChannelLedger(redis);
    const b = new RedisChannelLedger(redis);
    const held = await acquire(a);
    const fabricated = { ...held, ownerToken: 'not-the-owner' };
    expect(await b.releaseLease(CHANNEL, fabricated)).toBe(false);
    expect(await b.tryAcquireLease(CHANNEL, 5000)).toBeNull(); // a's lease intact
  });

  it('delete removes the revenue entry but keeps ownership fenced until explicit release', async () => {
    const ledger = new RedisChannelLedger(redis);
    const lease = await acquire(ledger, 60_000);
    await ledger.set(CHANNEL, entry('5'), lease);
    await ledger.delete(CHANNEL, lease);
    expect(await ledger.get(CHANNEL)).toBeNull();
    await ledger.releaseLease(CHANNEL, lease);
    const other = new RedisChannelLedger(redis);
    expect(await other.tryAcquireLease(CHANNEL, 5000)).not.toBeNull();
  });

  it('conditionally rejects a stale writer after TTL crash takeover', async () => {
    const crashed = new RedisChannelLedger(redis);
    const stale = await acquire(crashed);
    await crashed.set(CHANNEL, entry('1'), stale);
    vi.advanceTimersByTime(5001);

    const restarted = new RedisChannelLedger(redis);
    const takeover = await acquire(restarted);
    await restarted.set(CHANNEL, entry('2'), takeover);
    await expect(crashed.set(CHANNEL, entry('999'), stale))
      .rejects.toBeInstanceOf(ChannelLeaseLostError);
    expect((await restarted.get(CHANNEL))?.deliveredCumulativeAtomic).toBe('2');
    expect(BigInt(takeover.fence)).toBeGreaterThan(BigInt(stale.fence));
  });

  it('survives an adapter restart and never resets the Redis fence', async () => {
    const before = new RedisChannelLedger(redis);
    const first = await acquire(before);
    await before.set(CHANNEL, entry('7'), first);
    await before.releaseLease(CHANNEL, first);

    const after = new RedisChannelLedger(redis);
    expect((await after.get(CHANNEL))?.deliveredCumulativeAtomic).toBe('7');
    const second = await acquire(after);
    expect(BigInt(second.fence)).toBeGreaterThan(BigInt(first.fence));
  });

  it('does not advertise restart safety without explicit durable/noeviction attestation', () => {
    expect(new RedisChannelLedger(redis).capabilities).toMatchObject({
      restartSafe: false,
      canonicalChannelIds: false,
    });
    expect(new RedisChannelLedger(redis, {
      durability: {
        persistence: 'aof-always',
        failover: 'no-data-loss',
        maxmemoryPolicy: 'noeviction',
        isolation: 'dedicated-instance',
      },
    }).capabilities.restartSafe).toBe(false);
    const durable = new RedisChannelLedger(redis, {
      durability: {
        persistence: 'aof-always',
        failover: 'no-data-loss',
        maxmemoryPolicy: 'noeviction',
        isolation: 'dedicated-instance',
      },
      writerCutover: 'all-legacy-writers-stopped',
      channelIdCutover: 'legacy-case-aliases-migrated-or-empty',
    });
    expect(durable.capabilities).toMatchObject({
      restartSafe: true,
      multiInstanceSafe: true,
      canonicalChannelIds: true,
    });
    expect(() => new RedisChannelLedger(redis, {
      durability: {} as any,
    })).toThrow(/durability attestation must confirm/);
    expect(() => new RedisChannelLedger(redis, {
      durability: null as any,
    })).toThrow(/durability attestation must confirm/);
    expect(() => new RedisChannelLedger(redis, {
      channelIdCutover: 'wrong' as any,
    })).toThrow(/channelIdCutover/);
  });

  it('rejects uppercase before any Redis key or lock alias can be created', async () => {
    const ledger = new RedisChannelLedger(redis, {
      channelIdCutover: 'legacy-case-aliases-migrated-or-empty',
    });
    await expect(ledger.get('E'.repeat(64))).rejects.toThrow(/canonical lowercase/);
    await expect(ledger.tryAcquireLease('E'.repeat(64), 5_000))
      .rejects.toThrow(/canonical lowercase/);
    expect(redis.store.size).toBe(0);
  });

  it('uses one Redis Cluster hash tag for ledger, lease, and fence keys', async () => {
    const ledger = new RedisChannelLedger(redis, {
      keyLayout: 'cluster-v1',
      keyspaceCutover: 'legacy-state-migrated-or-empty',
    });
    const lease = await acquire(ledger);
    await ledger.set(CHANNEL, entry('1'), lease);
    const keys = [...redis.store.keys()].filter((key) => key.includes(CHANNEL));
    expect(keys).toEqual(expect.arrayContaining([
      `tab:{${CHANNEL}}:ledger`,
      `tab:{${CHANNEL}}:lease`,
      `tab:{${CHANNEL}}:fence`,
    ]));
    expect(new Set(keys.map((key) => key.match(/\{[^}]+\}/)?.[0])).size).toBe(1);
  });

  it('preserves the legacy ledger/lease namespace and waits on a raw old UUID lease', async () => {
    const legacyEntry = JSON.stringify({
      ...entry('41'),
      lastVoucher: {
        ...entry('41').lastVoucher,
        sessionPublicKey: Buffer.from(entry('41').lastVoucher!.sessionPublicKey).toString('hex'),
        sessionRegistration: Buffer.from(entry('41').lastVoucher!.sessionRegistration).toString('hex'),
        sessionSignature: Buffer.from(entry('41').lastVoucher!.sessionSignature).toString('hex'),
      },
    });
    redis.store.set(`tab:ledger:${CHANNEL}`, { value: legacyEntry, expiresAtMs: null });
    redis.store.set(`tab:lease:${CHANNEL}`, {
      value: 'old-sdk-raw-uuid-token',
      expiresAtMs: Date.now() + 5_000,
    });

    const upgraded = new RedisChannelLedger(redis);
    expect((await upgraded.get(CHANNEL))?.deliveredCumulativeAtomic).toBe('41');
    expect(await upgraded.tryAcquireLease(CHANNEL, 5_000)).toBeNull();
    expect(redis.store.has(`tab:{${CHANNEL}}:ledger`)).toBe(false);
  });

  it('requires explicit cluster cutover and rejects every legacy key remnant', async () => {
    expect(() => new RedisChannelLedger(redis, {
      keyLayout: 'cluster-v1',
    })).toThrow(/keyspaceCutover/);

    const cluster = new RedisChannelLedger(redis, {
      keyLayout: 'cluster-v1',
      keyspaceCutover: 'legacy-state-migrated-or-empty',
    });
    for (const suffix of ['ledger', 'lease', 'fence'] as const) {
      redis.store.clear();
      redis.store.set(`tab:${suffix}:${CHANNEL}`, { value: 'legacy', expiresAtMs: null });
      await expect(cluster.get(CHANNEL)).rejects.toThrow(/legacy Redis seller state exists/);
    }
  });

  it('forces reads through primary-routed Lua instead of a possibly stale client GET', async () => {
    const ledger = new RedisChannelLedger(redis);
    const lease = await acquire(ledger);
    await ledger.set(CHANNEL, entry('9'), lease);
    const replicaGet = vi.spyOn(redis, 'get').mockResolvedValue(null);
    expect((await ledger.get(CHANNEL))?.deliveredCumulativeAtomic).toBe('9');
    await ledger.update(CHANNEL, lease, (current) => ({
      ...current!,
      deliveredCumulativeAtomic: '10',
    }));
    expect((await ledger.get(CHANNEL))?.deliveredCumulativeAtomic).toBe('10');
    expect(replicaGet).not.toHaveBeenCalled();
  });

  it('propagates Redis write errors without a memory fallback', async () => {
    const ledger = new RedisChannelLedger(redis);
    const lease = await acquire(ledger);
    redis.evalError = new Error('redis unavailable');
    await expect(ledger.set(CHANNEL, entry('1'), lease)).rejects.toThrow('redis unavailable');
    redis.evalError = null;
    expect(await ledger.get(CHANNEL)).toBeNull();
  });
});
