/**
 * RedisChannelLedger — entry round-trip, cross-instance lease atomicity,
 * TTL expiry, and token-guarded release (an instance that lost its lease to
 * expiry must never delete the next holder's lease).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RedisChannelLedger, type RedisLikeClient } from '../redis-channel-ledger';
import type { ChannelLedgerEntry } from '../channel-ledger';

const CHANNEL = 'e'.repeat(64);

/** In-memory fake honoring the exact subset the ledger uses: GET, SET [PX ms] [NX], DEL, EVAL(compare-and-del). */
class FakeRedis implements RedisLikeClient {
  store = new Map<string, { value: string; expiresAtMs: number | null }>();

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

  async eval(_script: string, _numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    // The only script the ledger ships: compare token, delete on match.
    const [key, token] = args as [string, string];
    if (this.live(key)?.value === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
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

  it('round-trips an entry with Uint8Array voucher fields intact', async () => {
    const ledger = new RedisChannelLedger(redis);
    await ledger.set(CHANNEL, entry('150000'));
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

  it('never persists an inline lease on set', async () => {
    const ledger = new RedisChannelLedger(redis);
    await ledger.set(CHANNEL, { ...entry('1'), lease: { heldUntilUnixMs: Date.now() + 99999 } });
    expect(JSON.parse(redis.store.get('tab:ledger:' + CHANNEL)!.value).lease).toBeUndefined();
  });

  it('lease is exclusive across instances and reopens after TTL expiry', async () => {
    const a = new RedisChannelLedger(redis);
    const b = new RedisChannelLedger(redis); // second process, same Redis
    expect(await a.tryAcquireLease(CHANNEL, 5000)).toBe(true);
    expect(await b.tryAcquireLease(CHANNEL, 5000)).toBe(false);
    expect(await a.tryAcquireLease(CHANNEL, 5000)).toBe(false); // strict: even the holder re-acquires only after release/expiry
    vi.advanceTimersByTime(5001);
    expect(await b.tryAcquireLease(CHANNEL, 5000)).toBe(true);
  });

  it('release only deletes the lease this instance still owns (token guard)', async () => {
    const a = new RedisChannelLedger(redis);
    const b = new RedisChannelLedger(redis);
    expect(await a.tryAcquireLease(CHANNEL, 5000)).toBe(true);
    vi.advanceTimersByTime(5001); // A's lease expires…
    expect(await b.tryAcquireLease(CHANNEL, 5000)).toBe(true); // …B takes over
    await a.releaseLease(CHANNEL); // stale A releases — must NOT delete B's lease
    const c = new RedisChannelLedger(redis);
    expect(await c.tryAcquireLease(CHANNEL, 5000)).toBe(false); // B still holds
    await b.releaseLease(CHANNEL);
    expect(await c.tryAcquireLease(CHANNEL, 5000)).toBe(true); // real release frees it
  });

  it('releaseLease is a no-op for an instance that never acquired', async () => {
    const a = new RedisChannelLedger(redis);
    const b = new RedisChannelLedger(redis);
    expect(await a.tryAcquireLease(CHANNEL, 5000)).toBe(true);
    await b.releaseLease(CHANNEL); // b never held it
    expect(await b.tryAcquireLease(CHANNEL, 5000)).toBe(false); // a's lease intact
  });

  it('delete removes both the entry and any lease', async () => {
    const ledger = new RedisChannelLedger(redis);
    await ledger.set(CHANNEL, entry('5'));
    await ledger.tryAcquireLease(CHANNEL, 60000);
    await ledger.delete(CHANNEL);
    expect(await ledger.get(CHANNEL)).toBeNull();
    const other = new RedisChannelLedger(redis);
    expect(await other.tryAcquireLease(CHANNEL, 5000)).toBe(true); // lease gone too
  });
});
