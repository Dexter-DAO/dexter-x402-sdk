import { describe, it, expect } from 'vitest';
import { tabMiddleware } from '../middleware';
import { tabOrExactMiddleware } from '../dual';
import { FileChannelLedger, InMemoryChannelLedger } from '../channel-ledger';
import { RedisChannelLedger, type RedisLikeClient } from '../redis-channel-ledger';
import { Connection } from '@solana/web3.js';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SELLER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

describe('tabMiddleware ledger config', () => {
  const base = {
    connection: new Connection('http://127.0.0.1:8899'),
    sellerPubkey: SELLER,
    perUnit: '0.01' as const,
    network: 'solana:mainnet' as const,
    settle: 'on-close' as const,
  };

  it('accepts a ChannelLedger and rejects a request with no voucher header (402) without touching the ledger', async () => {
    const ledger = new InMemoryChannelLedger();
    const mw = tabMiddleware({
      connection: new Connection('http://127.0.0.1:8899'),
      sellerPubkey: SELLER,
      perUnit: '0.01',
      network: 'solana:mainnet',
      settle: 'on-close',
      ledger,
    });
    let status = 0;
    let body: any;
    const req: any = { headers: {} };
    const res: any = Object.assign(new EventEmitter(), {
      status(c: number) { status = c; return this; },
      json(b: unknown) { body = b; return this; },
    });
    await mw(req, res, () => { throw new Error('next should not be called'); });
    expect(status).toBe(402);
    expect(body.error).toBe('invalid_voucher');
    expect(await ledger.get('f'.repeat(64))).toBeNull();
  });

  it('fails closed instead of silently using memory in production', () => {
    expect(() => tabMiddleware({
      ...base,
      ledgerSafetyMode: 'production-single-instance',
    })).toThrow(/requires restart-safe durable ledger state/);
    expect(() => tabMiddleware({
      ...base,
      ledger: new FileChannelLedger('/tmp/dexter-ledger-capability-only'),
      ledgerSafetyMode: 'production-mulit-instance' as any,
    })).toThrow(/invalid tab seller ledgerSafetyMode/);
  });

  it('rejects an invalid lease TTL at middleware construction', () => {
    expect(() => tabMiddleware({
      ...base,
      leaseTtlMs: Number.NaN,
    })).toThrow(/lease TTL must be an integer/);
  });

  it('requires an explicit deployment topology outside exact test/development NODE_ENV', () => {
    const prior = process.env.NODE_ENV;
    try {
      delete process.env.NODE_ENV;
      expect(() => tabMiddleware({
        ...base,
        ledger: new FileChannelLedger('/tmp/dexter-ledger-capability-only'),
      })).toThrow(/ledgerSafetyMode must be explicit/);
      process.env.NODE_ENV = 'production';
      expect(() => tabMiddleware({
        ...base,
        ledger: new FileChannelLedger('/tmp/dexter-ledger-capability-only'),
      })).toThrow(/ledgerSafetyMode must be explicit/);
    } finally {
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  it('admits file only for single-instance production and requires Redis-class fencing for multi-instance', () => {
    const unacknowledgedFile = new FileChannelLedger('/tmp/dexter-ledger-capability-only');
    expect(() => tabMiddleware({
      ...base,
      ledger: unacknowledgedFile,
      ledgerSafetyMode: 'production-single-instance',
    })).toThrow(/channel-id alias migration/);

    const file = new FileChannelLedger('/tmp/dexter-ledger-capability-only', {
      channelIdCutover: 'legacy-case-aliases-migrated-or-empty',
    });
    expect(() => tabMiddleware({
      ...base,
      ledger: file,
      ledgerSafetyMode: 'production-single-instance',
    })).not.toThrow();
    expect(() => tabMiddleware({
      ...base,
      ledger: file,
      ledgerSafetyMode: 'production-multi-instance',
    })).toThrow(/cross-process atomic fencing/);
    // Bounded construction smoke for the exact configuration now used by the
    // mainnet proof scripts: durable file state + explicit topology/cutover.
    expect(() => tabOrExactMiddleware({
      connection: base.connection,
      sellerPubkey: base.sellerPubkey,
      network: base.network,
      perUnit: base.perUnit,
      ledger: file,
      ledgerSafetyMode: 'production-single-instance',
    })).not.toThrow();

    const unusedClient: RedisLikeClient = {
      get: async () => null,
      set: async () => 'OK',
      del: async () => 0,
      eval: async () => 0,
    };
    expect(() => tabMiddleware({
      ...base,
      ledger: new RedisChannelLedger(unusedClient, {
        durability: {
          persistence: 'aof-always',
          failover: 'no-data-loss',
          maxmemoryPolicy: 'noeviction',
          isolation: 'dedicated-instance',
        },
        writerCutover: 'all-legacy-writers-stopped',
        channelIdCutover: 'legacy-case-aliases-migrated-or-empty',
      }),
      ledgerSafetyMode: 'production-multi-instance',
    })).not.toThrow();
  });

  it('blocks an upgrade replay when a legacy mixed-case file would be invisible to the lowercase key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channel-alias-upgrade-'));
    const legacyAlias = 'A'.repeat(64);
    const canonical = legacyAlias.toLowerCase();
    try {
      // <=6.0.0-rc.2 accepted this spelling and used it verbatim as the file
      // name. The signature still verifies after lowercasing because it covers
      // the decoded 32 bytes, so silently looking only at the lowercase file
      // would re-grant the alias's delivered amount.
      await writeFile(join(dir, `${legacyAlias}.json`), JSON.stringify({
        lastVoucher: null,
        deliveredCumulativeAtomic: '50000',
      }));
      const unmigrated = new FileChannelLedger(dir);
      expect(await unmigrated.get(canonical)).toBeNull();
      await expect(unmigrated.get(legacyAlias)).rejects.toThrow(/canonical lowercase/);
      expect(() => tabMiddleware({
        ...base,
        ledger: unmigrated,
        ledgerSafetyMode: 'production-single-instance',
      })).toThrow(/channel-id alias migration/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
