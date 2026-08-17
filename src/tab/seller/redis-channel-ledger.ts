/**
 * Redis-backed ChannelLedger — the multi-process production ledger the
 * ChannelLedger interface docs call for: revenue state
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
 *   2. DURABLE, NO-ROLLBACK persistence/failover plus server-wide NO EVICTION.
 *      A logical DB does not isolate Redis's server-wide eviction policy. To
 *      declare `restartSafe`, pass the explicit durability attestation AND
 *      writer-generation cutover acknowledgement to the constructor only
 *      after verifying AOF always, no-loss failover,
 *      `maxmemory-policy noeviction`, a dedicated Redis instance, and that
 *      every pre-fencing SDK writer has stopped.
 *
 * Key layouts (prefix configurable):
 *   legacy-v0 (default, upgrade-compatible with <= 6.0.0-rc.2):
 *     <prefix>ledger:<channelId> / lease:<channelId> / fence:<channelId>
 *   cluster-v1 (explicit stop-the-world migration):
 *     <prefix>{<channelId>}:ledger / :lease / :fence
 * The cluster-v1 hash tag keeps each channel's Lua keys in one Redis Cluster
 * slot. It is never selected implicitly: hiding legacy delivery state or using
 * a different lease key during a rolling deploy would re-grant buyer budget.
 *
 * Lease semantics: acquire atomically checks the lease, INCRs the fence, and
 * installs owner:fence with PX. Every entry write/delete and lease release is
 * a Lua compare-and-mutate on that exact owner:fence identity. An expired or
 * crashed process therefore cannot overwrite or release a takeover owner's
 * state when it resumes.
 */

import { randomUUID } from 'node:crypto';

import type {
  ChannelLedger,
  ChannelLedgerCapabilities,
  ChannelLedgerEntry,
  ChannelLedgerUpdater,
  ChannelLease,
  ChannelIdCutover,
} from './channel-ledger';
import {
  ChannelLeaseLostError,
  serializeChannelLedgerEntry,
  deserializeChannelLedgerEntry,
  assertCanonicalChannelId,
  normalizeLeaseTtlMs,
  withChannelLock,
  type SerializedEntry,
} from './channel-ledger';

/** Structural subset of a Redis client (ioredis satisfies this). */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/**
 * Explicit operator attestation required before this adapter may advertise
 * restart safety. These are deployment facts a structural Redis client cannot
 * infer. Omitting this keeps `restartSafe=false`, so production safety modes
 * fail closed instead of trusting a lossy/default Redis server.
 */
export interface RedisDurabilityAttestation {
  persistence: 'aof-always';
  failover: 'no-data-loss';
  maxmemoryPolicy: 'noeviction';
  isolation: 'dedicated-instance';
}

export type RedisKeyLayout = 'legacy-v0' | 'cluster-v1';

export interface RedisChannelLedgerOptions {
  keyPrefix?: string;
  durability?: RedisDurabilityAttestation;
  /**
   * Explicit writer-generation fence. Production restart safety is advertised
   * only after every pre-fencing SDK process has been stopped; those versions
   * could write the legacy ledger without an owner/fence condition.
   */
  writerCutover?: 'all-legacy-writers-stopped';
  /** Required in production after merging/removing historical case aliases. */
  channelIdCutover?: ChannelIdCutover;
  /** Default `legacy-v0`, preserving the <= 6.0.0-rc.2 Redis keyspace. */
  keyLayout?: RedisKeyLayout;
  /** Required for cluster-v1 after legacy state has been migrated or proven empty. */
  keyspaceCutover?: 'legacy-state-migrated-or-empty';
}

function isDurabilityAttestation(value: unknown): value is RedisDurabilityAttestation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.persistence === 'aof-always'
    && candidate.failover === 'no-data-loss'
    && candidate.maxmemoryPolicy === 'noeviction'
    && candidate.isolation === 'dedicated-instance';
}

const ACQUIRE_FENCED_LEASE_LUA = `
if redis.call("exists", KEYS[1]) == 1 then return false end
redis.call("incr", KEYS[2])
local fence = redis.call("get", KEYS[2])
redis.call("set", KEYS[1], ARGV[1] .. ":" .. tostring(fence), "PX", ARGV[2])
return tostring(fence)
`;

const SET_IF_LEASE_MATCHES_LUA = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("set", KEYS[2], ARGV[2])
return 1
`;

const DELETE_IF_LEASE_MATCHES_LUA = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("del", KEYS[2])
return 1
`;

const RELEASE_IF_LEASE_MATCHES_LUA = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call("del", KEYS[1])
`;

const RENEW_IF_LEASE_MATCHES_LUA = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("pexpire", KEYS[1], ARGV[2])
return 1
`;

// EVAL is routed to the key's primary even when an ioredis Cluster client is
// configured to scale ordinary GETs to replicas. Seller delivery truth may
// never be derived from a lagging replica.
const READ_FROM_PRIMARY_LUA = 'return redis.call("get", KEYS[1])';

export class RedisKeyspaceMigrationRequiredError extends Error {
  constructor(channelId: string) {
    super(
      `legacy Redis seller state exists for channel ${channelId}; stop all legacy writers, ` +
        'migrate/delete the legacy ledger, lease, and fence keys, then retry cluster-v1',
    );
    this.name = 'RedisKeyspaceMigrationRequiredError';
  }
}

function leaseIdentity(lease: ChannelLease): string {
  return `${lease.ownerToken}:${lease.fence}`;
}

function mutationSucceeded(result: unknown): boolean {
  return result === 1 || result === '1';
}

export class RedisChannelLedger implements ChannelLedger {
  readonly capabilities: ChannelLedgerCapabilities;
  private readonly keyPrefix: string;
  private readonly keyLayout: RedisKeyLayout;

  constructor(
    private readonly client: RedisLikeClient,
    keyPrefixOrOptions: string | RedisChannelLedgerOptions = 'tab:',
  ) {
    if (
      typeof keyPrefixOrOptions !== 'string'
      && (
        keyPrefixOrOptions === null
        || typeof keyPrefixOrOptions !== 'object'
        || Array.isArray(keyPrefixOrOptions)
      )
    ) {
      throw new Error('RedisChannelLedger options must be a key prefix or options object');
    }
    const options: RedisChannelLedgerOptions = typeof keyPrefixOrOptions === 'string'
      ? { keyPrefix: keyPrefixOrOptions }
      : keyPrefixOrOptions;
    if (options.keyPrefix !== undefined && typeof options.keyPrefix !== 'string') {
      throw new Error('RedisChannelLedger keyPrefix must be a string');
    }
    this.keyPrefix = options.keyPrefix ?? 'tab:';
    this.keyLayout = options.keyLayout ?? 'legacy-v0';
    if (!['legacy-v0', 'cluster-v1'].includes(this.keyLayout)) {
      throw new Error(`invalid RedisChannelLedger keyLayout: ${String(this.keyLayout)}`);
    }
    if (
      this.keyLayout === 'cluster-v1'
      && (this.keyPrefix.includes('{') || this.keyPrefix.includes('}'))
    ) {
      throw new Error('cluster-v1 keyPrefix must not contain Redis hash-tag braces');
    }
    if (
      options.writerCutover !== undefined
      && options.writerCutover !== 'all-legacy-writers-stopped'
    ) {
      throw new Error('invalid RedisChannelLedger writerCutover acknowledgement');
    }
    if (
      options.channelIdCutover !== undefined
      && options.channelIdCutover !== 'legacy-case-aliases-migrated-or-empty'
    ) {
      throw new Error('invalid RedisChannelLedger channelIdCutover acknowledgement');
    }
    if (
      this.keyLayout === 'cluster-v1'
      && options.keyspaceCutover !== 'legacy-state-migrated-or-empty'
    ) {
      throw new Error(
        'cluster-v1 requires keyspaceCutover: legacy-state-migrated-or-empty',
      );
    }
    const durability = options.durability;
    if (durability !== undefined && !isDurabilityAttestation(durability)) {
      throw new Error(
        'RedisChannelLedger durability attestation must confirm aof-always, ' +
          'no-data-loss failover, noeviction, and dedicated-instance isolation',
      );
    }
    this.capabilities = {
      adapter: 'redis',
      restartSafe:
        isDurabilityAttestation(durability)
        && options.writerCutover === 'all-legacy-writers-stopped',
      multiInstanceSafe: true,
      conditionalWrites: true,
      canonicalChannelIds:
        options.channelIdCutover === 'legacy-case-aliases-migrated-or-empty',
    };
  }

  private assertChannelId(channelId: string): void {
    assertCanonicalChannelId(channelId);
  }

  private legacyKey(channelId: string, suffix: 'ledger' | 'lease' | 'fence'): string {
    this.assertChannelId(channelId);
    return `${this.keyPrefix}${suffix}:${channelId}`;
  }

  private channelKey(channelId: string, suffix: 'ledger' | 'lease' | 'fence'): string {
    this.assertChannelId(channelId);
    return this.keyLayout === 'cluster-v1'
      ? `${this.keyPrefix}{${channelId}}:${suffix}`
      : this.legacyKey(channelId, suffix);
  }

  private ledgerKey(channelId: string): string {
    return this.channelKey(channelId, 'ledger');
  }

  private leaseKey(channelId: string): string {
    return this.channelKey(channelId, 'lease');
  }

  private fenceKey(channelId: string): string {
    return this.channelKey(channelId, 'fence');
  }

  private async primaryGet(key: string): Promise<string | null> {
    const raw = await this.client.eval(READ_FROM_PRIMARY_LUA, 1, key);
    if (raw === null || raw === false) return null;
    if (typeof raw !== 'string') {
      throw new Error(`Redis primary GET returned invalid value type: ${typeof raw}`);
    }
    return raw;
  }

  private async assertClusterCutover(channelId: string): Promise<void> {
    if (this.keyLayout !== 'cluster-v1') return;
    // Read legacy keys separately so this check itself is valid on a Cluster.
    // The constructor acknowledgement requires old writers to be stopped; this
    // runtime guard catches an incomplete state migration instead of treating
    // the new namespace as an empty channel.
    const legacyLedger = await this.primaryGet(this.legacyKey(channelId, 'ledger'));
    const legacyLease = await this.primaryGet(this.legacyKey(channelId, 'lease'));
    const legacyFence = await this.primaryGet(this.legacyKey(channelId, 'fence'));
    if (legacyLedger !== null || legacyLease !== null || legacyFence !== null) {
      throw new RedisKeyspaceMigrationRequiredError(channelId);
    }
  }

  async get(channelId: string): Promise<ChannelLedgerEntry | null> {
    this.assertChannelId(channelId);
    await this.assertClusterCutover(channelId);
    const raw = await this.primaryGet(this.ledgerKey(channelId));
    if (raw === null) return null;
    return deserializeChannelLedgerEntry(JSON.parse(raw) as SerializedEntry);
  }

  private async writeIfOwned(
    channelId: string,
    entry: ChannelLedgerEntry,
    lease: ChannelLease,
  ): Promise<void> {
    const serialized = serializeChannelLedgerEntry(entry);
    const result = await this.client.eval(
      SET_IF_LEASE_MATCHES_LUA,
      2,
      this.leaseKey(channelId),
      this.ledgerKey(channelId),
      leaseIdentity(lease),
      JSON.stringify(serialized),
    );
    if (!mutationSucceeded(result)) throw new ChannelLeaseLostError(channelId);
  }

  async set(channelId: string, entry: ChannelLedgerEntry, lease: ChannelLease): Promise<void> {
    this.assertChannelId(channelId);
    await withChannelLock(channelId, () => this.writeIfOwned(channelId, entry, lease));
  }

  async update(
    channelId: string,
    lease: ChannelLease,
    updater: ChannelLedgerUpdater,
  ): Promise<ChannelLedgerEntry> {
    this.assertChannelId(channelId);
    return withChannelLock(channelId, async () => {
      const next = updater(await this.get(channelId));
      await this.writeIfOwned(channelId, next, lease);
      return next;
    });
  }

  async delete(channelId: string, lease: ChannelLease): Promise<void> {
    this.assertChannelId(channelId);
    await withChannelLock(channelId, async () => {
      const result = await this.client.eval(
        DELETE_IF_LEASE_MATCHES_LUA,
        2,
        this.leaseKey(channelId),
        this.ledgerKey(channelId),
        leaseIdentity(lease),
      );
      if (!mutationSucceeded(result)) throw new ChannelLeaseLostError(channelId);
    });
  }

  async tryAcquireLease(channelId: string, ttlMs: number): Promise<ChannelLease | null> {
    this.assertChannelId(channelId);
    return withChannelLock(channelId, async () => {
      await this.assertClusterCutover(channelId);
      const ownerToken = randomUUID();
      const ttl = normalizeLeaseTtlMs(ttlMs);
      const result = await this.client.eval(
        ACQUIRE_FENCED_LEASE_LUA,
        2,
        this.leaseKey(channelId),
        this.fenceKey(channelId),
        ownerToken,
        ttl,
      );
      if (result === null || result === false || result === 0 || result === '0') return null;
      const fence = String(result);
      if (!/^[1-9][0-9]*$/.test(fence)) {
        throw new Error(`Redis returned invalid channel fence: ${fence}`);
      }
      return {
        ownerToken,
        fence,
        heldUntilUnixMs: Date.now() + ttl,
      };
    });
  }

  async releaseLease(channelId: string, lease: ChannelLease): Promise<boolean> {
    this.assertChannelId(channelId);
    return withChannelLock(channelId, async () => {
      const result = await this.client.eval(
        RELEASE_IF_LEASE_MATCHES_LUA,
        1,
        this.leaseKey(channelId),
        leaseIdentity(lease),
      );
      return mutationSucceeded(result);
    });
  }

  async renewLease(
    channelId: string,
    lease: ChannelLease,
    ttlMs: number,
  ): Promise<ChannelLease> {
    this.assertChannelId(channelId);
    return withChannelLock(channelId, async () => {
      const ttl = normalizeLeaseTtlMs(ttlMs);
      const result = await this.client.eval(
        RENEW_IF_LEASE_MATCHES_LUA,
        1,
        this.leaseKey(channelId),
        leaseIdentity(lease),
        ttl,
      );
      if (!mutationSucceeded(result)) throw new ChannelLeaseLostError(channelId);
      return { ...lease, heldUntilUnixMs: Date.now() + ttl };
    });
  }
}
