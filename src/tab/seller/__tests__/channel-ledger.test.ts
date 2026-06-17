import { describe, it, expect } from 'vitest';
import { InMemoryChannelLedger, type ChannelLedgerEntry } from '../channel-ledger';
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
    expect(got?.lastVoucher.payload.cumulativeAmount).toBe('100000');
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
