import { describe, it, expect, vi } from 'vitest';
import {
  ChannelLeaseLostError,
  FileChannelLedger,
  InMemoryChannelLedger,
  type ChannelLedger,
  type ChannelLedgerEntry,
  type ChannelLease,
} from '../channel-ledger';
import type { SignedVoucher } from '../../types';

function fakeVoucher(channelId: string, cumulativeAmount: string): SignedVoucher {
  return {
    payload: { channelId, cumulativeAmount, sequenceNumber: 1 },
    sessionPublicKey: new Uint8Array(32).fill(1),
    sessionRegistration: new Uint8Array(188).fill(2),
    sessionSignature: new Uint8Array(64).fill(3),
  };
}

async function acquire(
  ledger: ChannelLedger,
  channelId: string,
  ttlMs = 60_000,
): Promise<ChannelLease> {
  const lease = await ledger.tryAcquireLease(channelId, ttlMs);
  if (!lease) throw new Error('expected channel lease');
  return lease;
}

async function seed(
  ledger: ChannelLedger,
  channelId: string,
  entry: ChannelLedgerEntry,
): Promise<void> {
  const lease = await acquire(ledger, channelId);
  await ledger.set(channelId, entry, lease);
  expect(await ledger.releaseLease(channelId, lease)).toBe(true);
}

describe('InMemoryChannelLedger', () => {
  const channelId = 'a'.repeat(64);

  it('returns null for an unknown channel', async () => {
    const ledger = new InMemoryChannelLedger();
    expect(await ledger.get(channelId)).toBeNull();
    expect(ledger.capabilities).toEqual({
      adapter: 'memory',
      restartSafe: false,
      multiInstanceSafe: false,
      conditionalWrites: true,
      canonicalChannelIds: true,
    });
  });

  it('rejects noncanonical case before creating an alias key', async () => {
    const ledger = new InMemoryChannelLedger();
    await expect(ledger.get('A'.repeat(64))).rejects.toThrow(/canonical lowercase/);
    expect(await ledger.get('a'.repeat(64))).toBeNull();
  });

  it('does not expose an unfenced mutable reference from get()', async () => {
    const ledger = new InMemoryChannelLedger();
    await seed(ledger, channelId, {
      lastVoucher: fakeVoucher(channelId, '10'),
      deliveredCumulativeAtomic: '1',
    });
    const detached = await ledger.get(channelId);
    detached!.deliveredCumulativeAtomic = '999';
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe('1');
  });

  it('roundtrips lastVoucher + deliveredCumulativeAtomic', async () => {
    const ledger = new InMemoryChannelLedger();
    const entry: ChannelLedgerEntry = {
      lastVoucher: fakeVoucher(channelId, '100000'),
      deliveredCumulativeAtomic: '50000',
    };
    await seed(ledger, channelId, entry);
    const got = await ledger.get(channelId);
    expect(got?.deliveredCumulativeAtomic).toBe('50000');
    expect(got?.lastVoucher?.payload.cumulativeAmount).toBe('100000');
  });

  it('preserves the optional onChain snapshot when present', async () => {
    const ledger = new InMemoryChannelLedger();
    await seed(ledger, channelId, {
      lastVoucher: fakeVoucher(channelId, '100000'),
      deliveredCumulativeAtomic: '0',
      onChain: {
        spentAtomic: '0',
        crystallizedCumulativeAtomic: '0',
        currentOutstandingAtomic: '0',
        lastLockedSequence: 0,
        fetchedAtUnixSec: 1718000000,
      },
    });
    const got = await ledger.get(channelId);
    expect(got?.onChain?.fetchedAtUnixSec).toBe(1718000000);
  });

  it('deletes a channel', async () => {
    const ledger = new InMemoryChannelLedger();
    const lease = await acquire(ledger, channelId);
    await ledger.set(channelId, { lastVoucher: fakeVoucher(channelId, '1'), deliveredCumulativeAtomic: '0' }, lease);
    await ledger.delete(channelId, lease);
    expect(await ledger.releaseLease(channelId, lease)).toBe(true);
    expect(await ledger.get(channelId)).toBeNull();
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

describe('ChannelLedger.update — serializes concurrent read-modify-write', () => {
  it('10 concurrent +1 increments on one channel do not lose updates', async () => {
    const ledger = new InMemoryChannelLedger();
    const channelId = 'e'.repeat(64);
    const lease = await acquire(ledger, channelId);
    await ledger.set(channelId, { lastVoucher: fakeVoucher(channelId, '0'), deliveredCumulativeAtomic: '0' }, lease);
    await Promise.all(Array.from({ length: 10 }, () =>
      ledger.update(channelId, lease, (cur) => {
        const base = BigInt(cur!.deliveredCumulativeAtomic);
        return { ...cur!, deliveredCumulativeAtomic: (base + 1n).toString() };
      }),
    ));
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe('10');
    await ledger.releaseLease(channelId, lease);
  });
});

describe('FileChannelLedger', () => {
  const channelId = 'b'.repeat(64);

  it('persists across instances (survives a simulated restart)', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'chanledger-'));
    try {
      const writer = new FileChannelLedger(dir);
      await seed(writer, channelId, {
        lastVoucher: fakeVoucher(channelId, '200000'),
        deliveredCumulativeAtomic: '150000',
      });
      // New instance, same dir = a process restart.
      const reader = new FileChannelLedger(dir);
      const got = await reader.get(channelId);
      expect(got?.deliveredCumulativeAtomic).toBe('150000');
      expect(got?.lastVoucher?.payload.cumulativeAmount).toBe('200000');
      expect(got?.lastVoucher?.sessionSignature.length).toBe(64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a missing file and rejects noncanonical channel ids', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'chanledger-'));
    try {
      const ledger = new FileChannelLedger(dir);
      expect(await ledger.get('c'.repeat(64))).toBeNull();
      await expect(
        ledger.tryAcquireLease('../escape', 60_000),
      ).rejects.toThrow(/canonical lowercase/);
      await expect(ledger.get('B'.repeat(64))).rejects.toThrow(/canonical lowercase/);
      expect(await ledger.get('b'.repeat(64))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('advertises canonical safety only after the explicit alias cutover acknowledgement', () => {
    const unacknowledged = new FileChannelLedger('/tmp/channel-ledger-capability');
    const acknowledged = new FileChannelLedger('/tmp/channel-ledger-capability', {
      channelIdCutover: 'legacy-case-aliases-migrated-or-empty',
    });
    expect(unacknowledged.capabilities.canonicalChannelIds).toBe(false);
    expect(acknowledged.capabilities.canonicalChannelIds).toBe(true);
    expect(() => new FileChannelLedger('/tmp/channel-ledger-capability', {
      channelIdCutover: 'wrong' as any,
    })).toThrow(/channelIdCutover/);
  });

  // K-T3 (cadence §5 A12): the gate-refused watermark must survive a restart,
  // or a rebooted seller re-storms the facilitator gate with the same span.
  it('round-trips gateRefusedCumulativeAtomic (and omits it when absent)', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'chanledger-'));
    try {
      const writer = new FileChannelLedger(dir);
      const lease = await acquire(writer, channelId);
      await writer.set(channelId, {
        lastVoucher: fakeVoucher(channelId, '200000'),
        deliveredCumulativeAtomic: '150000',
        gateRefusedCumulativeAtomic: '200000',
      }, lease);
      const reader = new FileChannelLedger(dir);
      const got = await reader.get(channelId);
      expect(got?.gateRefusedCumulativeAtomic).toBe('200000');

      await writer.set(channelId, {
        lastVoucher: fakeVoucher(channelId, '200000'),
        deliveredCumulativeAtomic: '150000',
      }, lease);
      const got2 = await reader.get(channelId);
      expect(got2?.gateRefusedCumulativeAtomic).toBeUndefined();
      await writer.releaseLease(channelId, lease);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('channel lease — reject concurrent same-channel metering', () => {
  const channelId = 'f'.repeat(64);

  it('rejects non-finite, fractional, tiny, and timer-overflow TTLs', async () => {
    const ledger = new InMemoryChannelLedger();
    for (const invalid of [NaN, Infinity, 0, 2.5, 0x8000_0000]) {
      await expect(ledger.tryAcquireLease(channelId, invalid)).rejects.toThrow(
        /lease TTL must be an integer from 3 to 2147483647/,
      );
    }
  });

  it('acquires when free, refuses while held, re-acquires after release', async () => {
    const ledger = new InMemoryChannelLedger();
    const first = await acquire(ledger, channelId);
    expect(await ledger.tryAcquireLease(channelId, 60_000)).toBeNull(); // held
    expect(await ledger.releaseLease(channelId, first)).toBe(true);
    const second = await acquire(ledger, channelId);
    expect(BigInt(second.fence)).toBeGreaterThan(BigInt(first.fence));
  });

  it('re-acquires after the lease TTL expires (crashed-holder safety)', async () => {
    const ledger = new InMemoryChannelLedger();
    const crashed = await acquire(ledger, channelId, 5);
    await new Promise((r) => setTimeout(r, 15));
    const takeover = await acquire(ledger, channelId); // expired → free
    expect(BigInt(takeover.fence)).toBeGreaterThan(BigInt(crashed.fence));
  });

  it('preserves deliveredCumulative across lease acquire/release', async () => {
    const ledger = new InMemoryChannelLedger();
    await seed(ledger, channelId, { lastVoucher: fakeVoucher(channelId, '100000'), deliveredCumulativeAtomic: '70000' });
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe('70000');
  });

  it('rejects stale writes and stale release after crash takeover', async () => {
    const ledger = new InMemoryChannelLedger();
    const ch = 'b'.repeat(64);
    const crashed = await acquire(ledger, ch, 5);
    await ledger.set(ch, { lastVoucher: fakeVoucher(ch, '1000'), deliveredCumulativeAtomic: '1' }, crashed);
    await new Promise((r) => setTimeout(r, 15));
    const takeover = await acquire(ledger, ch);
    await ledger.update(ch, takeover, (cur) => ({ ...cur!, deliveredCumulativeAtomic: '2' }));
    await expect(
      ledger.update(ch, crashed, (cur) => ({ ...cur!, deliveredCumulativeAtomic: '999' })),
    ).rejects.toBeInstanceOf(ChannelLeaseLostError);
    expect(await ledger.releaseLease(ch, crashed)).toBe(false);
    expect((await ledger.get(ch))?.deliveredCumulativeAtomic).toBe('2');
  });

  it('FileChannelLedger acquires a lease on a FRESH channel without throwing (durable-path regression)', async () => {
    // The first request acquires before a voucher is persisted. Lease metadata
    // is separate, so acquisition must not fabricate revenue history.
    const dir = await mkdtemp(pathJoin(tmpdir(), 'chanledger-'));
    try {
      const fresh = 'a'.repeat(64);
      const ledger = new FileChannelLedger(dir);
      const lease = await acquire(ledger, fresh);
      const got = await ledger.get(fresh);
      expect(got).toBeNull(); // lease metadata is separate from revenue state
      expect(lease.fence).toBe('1');
      await ledger.releaseLease(fresh, lease);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('FileChannelLedger persists its fence and rejects a pre-crash writer after takeover', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'chanledger-'));
    vi.useFakeTimers();
    try {
      const beforeCrash = new FileChannelLedger(dir);
      const stale = await acquire(beforeCrash, channelId, 5);
      await beforeCrash.set(channelId, {
        lastVoucher: fakeVoucher(channelId, '10'),
        deliveredCumulativeAtomic: '1',
      }, stale);
      vi.advanceTimersByTime(6);

      const afterRestart = new FileChannelLedger(dir);
      const takeover = await acquire(afterRestart, channelId);
      expect(BigInt(takeover.fence)).toBeGreaterThan(BigInt(stale.fence));
      await afterRestart.update(channelId, takeover, (cur) => ({
        ...cur!,
        deliveredCumulativeAtomic: '2',
      }));
      await expect(
        beforeCrash.set(channelId, {
          lastVoucher: fakeVoucher(channelId, '10'),
          deliveredCumulativeAtomic: '999',
        }, stale),
      ).rejects.toBeInstanceOf(ChannelLeaseLostError);
      expect((await afterRestart.get(channelId))?.deliveredCumulativeAtomic).toBe('2');
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
