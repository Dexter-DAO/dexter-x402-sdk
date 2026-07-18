/**
 * Redis-backed ChannelLedger — the multi-process production ledger the
 * ChannelLedger interface docs call for ("Redis SETNX"): revenue state
 * survives restarts, and the single-stream lease is atomic ACROSS processes.
 *
 * Zero new dependencies: the constructor takes a structural `RedisLikeClient`
 * (ioredis satisfies it) instead of importing a Redis library. Sellers pass
 * their own client, configured to their taste — with two hard requirements:
 *
 *   1. FAIL-FAST client: disable unbounded offline queueing
 *      (`enableOfflineQueue: false` on ioredis). A Redis outage must surface
 *      as a thrown ledger error the seller can terminate a stream on — never
 *      an indefinite hang inside the payment path.
 *   2. NO EVICTION on the keyspace holding these entries
 *      (`maxmemory-policy noeviction`, or a dedicated logical DB). Ledger
 *      entries are revenue state; an evicted entry silently re-grants
 *      delivered budget.
 *
 * Key layout (prefix configurable):
 *   <prefix>ledger:<channelId>  — serialized entry, NO TTL (durable until the
 *                                 seller's end-of-life sweep deletes it)
 *   <prefix>lease:<channelId>   — single-stream lease, PX = leaseTtlMs,
 *                                 value = per-acquire random token
 *
 * Lease semantics: acquire is SET NX PX (atomic across processes); release is
 * a compare-and-delete Lua script on the acquire token, so an instance that
 * lost its lease to TTL expiry can never delete the next holder's lease.
 */

import { randomUUID } from 'node:crypto';

import type { ChannelLedger, ChannelLedgerEntry } from './channel-ledger';
import {
  serializeChannelLedgerEntry,
  deserializeChannelLedgerEntry,
  type SerializedEntry,
} from './channel-ledger';

/** Structural subset of a Redis client (ioredis satisfies this). */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

const RELEASE_IF_TOKEN_MATCHES_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export class RedisChannelLedger implements ChannelLedger {
  /** Tokens for leases THIS instance holds; release only compares-and-deletes its own. */
  private readonly leaseTokens = new Map<string, string>();

  constructor(
    private readonly client: RedisLikeClient,
    private readonly keyPrefix: string = 'tab:',
  ) {}

  private ledgerKey(channelId: string): string {
    return `${this.keyPrefix}ledger:${channelId}`;
  }

  private leaseKey(channelId: string): string {
    return `${this.keyPrefix}lease:${channelId}`;
  }

  async get(channelId: string): Promise<ChannelLedgerEntry | null> {
    const raw = await this.client.get(this.ledgerKey(channelId));
    if (raw === null) return null;
    return deserializeChannelLedgerEntry(JSON.parse(raw) as SerializedEntry);
  }

  async set(channelId: string, entry: ChannelLedgerEntry): Promise<void> {
    // The lease lives in its own key here; never persist a stale inline copy.
    const serialized = serializeChannelLedgerEntry({ ...entry, lease: undefined });
    await this.client.set(this.ledgerKey(channelId), JSON.stringify(serialized));
  }

  async delete(channelId: string): Promise<void> {
    this.leaseTokens.delete(channelId);
    await this.client.del(this.ledgerKey(channelId), this.leaseKey(channelId));
  }

  async tryAcquireLease(channelId: string, ttlMs: number): Promise<boolean> {
    const token = randomUUID();
    const result = await this.client.set(
      this.leaseKey(channelId),
      token,
      'PX',
      Math.max(1, Math.floor(ttlMs)),
      'NX',
    );
    if (result !== 'OK') return false;
    this.leaseTokens.set(channelId, token);
    return true;
  }

  async releaseLease(channelId: string): Promise<void> {
    const token = this.leaseTokens.get(channelId);
    if (token === undefined) return; // not held by this instance — no-op
    this.leaseTokens.delete(channelId);
    await this.client.eval(RELEASE_IF_TOKEN_MATCHES_LUA, 1, this.leaseKey(channelId), token);
  }
}
