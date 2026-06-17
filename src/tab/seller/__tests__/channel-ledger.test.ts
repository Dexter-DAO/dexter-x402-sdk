import { describe, it, expect } from 'vitest';
import { InMemoryChannelLedger, withChannelLock, type ChannelLedgerEntry } from '../channel-ledger';
import type { SignedVoucher } from '../../types';

function fakeVoucher(channelId: string, cumulativeAmount: string): SignedVoucher {
  return {
    payload: { channelId, cumulativeAmount, sequenceNumber: 1 },
    sessionPublicKey: new Uint8Array(32).fill(1),
    sessionRegistration: new Uint8Array(188).fill(2),
    sessionSignature: new Uint8Array(64).fill(3),
  };
}

describe('InMemoryChannelLedger', () => {
  const channelId = 'a'.repeat(64);

  it('returns null for an unknown channel', async () => {
    const ledger = new InMemoryChannelLedger();
    expect(await ledger.get(channelId)).toBeNull();
  });

  it('roundtrips lastVoucher + deliveredCumulativeAtomic', async () => {
    const ledger = new InMemoryChannelLedger();
    const entry: ChannelLedgerEntry = {
      lastVoucher: fakeVoucher(channelId, '100000'),
      deliveredCumulativeAtomic: '50000',
    };
    await ledger.set(channelId, entry);
    const got = await ledger.get(channelId);
    expect(got?.deliveredCumulativeAtomic).toBe('50000');
    expect(got?.lastVoucher?.payload.cumulativeAmount).toBe('100000');
  });

  it('preserves the optional onChain snapshot when present', async () => {
    const ledger = new InMemoryChannelLedger();
    await ledger.set(channelId, {
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
    await ledger.set(channelId, { lastVoucher: fakeVoucher(channelId, '1'), deliveredCumulativeAtomic: '0' });
    await ledger.delete(channelId);
    expect(await ledger.get(channelId)).toBeNull();
  });
});

import { FileChannelLedger } from '../channel-ledger';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

describe('withChannelLock — serializes concurrent read-modify-write', () => {
  it('10 concurrent +1 increments on one channel do not lose updates', async () => {
    const ledger = new InMemoryChannelLedger();
    const channelId = 'e'.repeat(64);
    await ledger.set(channelId, { lastVoucher: fakeVoucher(channelId, '0'), deliveredCumulativeAtomic: '0' });
    await Promise.all(Array.from({ length: 10 }, () =>
      withChannelLock(channelId, async () => {
        const cur = await ledger.get(channelId);
        const base = BigInt(cur!.deliveredCumulativeAtomic);
        await new Promise((r) => setTimeout(r, 1)); // async gap to expose races
        await ledger.set(channelId, { ...cur!, deliveredCumulativeAtomic: (base + 1n).toString() });
      }),
    ));
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe('10');
  });
});

describe('FileChannelLedger', () => {
  const channelId = 'b'.repeat(64);

  it('persists across instances (survives a simulated restart)', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'chanledger-'));
    try {
      const writer = new FileChannelLedger(dir);
      await writer.set(channelId, {
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

  it('returns null for a missing file and rejects unsafe channel ids', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'chanledger-'));
    try {
      const ledger = new FileChannelLedger(dir);
      expect(await ledger.get('c'.repeat(64))).toBeNull();
      await expect(
        ledger.set('../escape', { lastVoucher: fakeVoucher('x', '1'), deliveredCumulativeAtomic: '0' }),
      ).rejects.toThrow(/unsafe channelId/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('channel lease — reject concurrent same-channel metering', () => {
  const channelId = 'f'.repeat(64);

  it('acquires when free, refuses while held, re-acquires after release', async () => {
    const ledger = new InMemoryChannelLedger();
    expect(await ledger.tryAcquireLease(channelId, 60_000)).toBe(true);
    expect(await ledger.tryAcquireLease(channelId, 60_000)).toBe(false); // held
    await ledger.releaseLease(channelId);
    expect(await ledger.tryAcquireLease(channelId, 60_000)).toBe(true);  // free again
  });

  it('re-acquires after the lease TTL expires (crashed-holder safety)', async () => {
    const ledger = new InMemoryChannelLedger();
    expect(await ledger.tryAcquireLease(channelId, 5)).toBe(true); // 5ms TTL
    await new Promise((r) => setTimeout(r, 15));
    expect(await ledger.tryAcquireLease(channelId, 60_000)).toBe(true); // expired → free
  });

  it('preserves deliveredCumulative across lease acquire/release', async () => {
    const ledger = new InMemoryChannelLedger();
    await ledger.set(channelId, { lastVoucher: fakeVoucher(channelId, '100000'), deliveredCumulativeAtomic: '70000' });
    await ledger.tryAcquireLease(channelId, 60_000);
    await ledger.releaseLease(channelId);
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe('70000');
  });

  it('FileChannelLedger acquires a lease on a FRESH channel without throwing (durable-path regression)', async () => {
    // The first request on any channel acquires the lease BEFORE any voucher is
    // persisted (middleware step 5b precedes step 6). On a durable/file ledger
    // that means serializing a lease-only entry with no voucher — must not throw.
    const dir = await mkdtemp(pathJoin(tmpdir(), 'chanledger-'));
    try {
      const fresh = 'a'.repeat(64);
      const ledger = new FileChannelLedger(dir);
      expect(await ledger.tryAcquireLease(fresh, 60_000)).toBe(true);
      const got = await ledger.get(fresh);
      expect(got?.lease?.heldUntilUnixMs).toBeGreaterThan(0);
      expect(got?.lastVoucher).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
