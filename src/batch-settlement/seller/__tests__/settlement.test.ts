import { describe, it, expect } from 'vitest';
import { closeChannel, closeAll } from '../settlement';

/** A fake upstream BatchSettlementChannelManager. */
function fakeManager(opts?: { failClaim?: boolean }) {
  return {
    async claimAndSettle() {
      if (opts?.failClaim) throw new Error('claim simulation failed');
      return {
        claims: [{ vouchers: 2, transaction: '0xclaim' }],
        settle: { transaction: '0xsettle' },
      };
    },
    async refund(ids: string[]) {
      return ids.map((id) => ({ channel: id, transaction: '0xrefund' }));
    },
  };
}

/** A fake ChannelStorage holding two channels. */
function fakeStore() {
  const channels = [
    { channelId: '0xaaa', balance: '300000', totalClaimed: '0', chargedCumulativeAmount: '160000' },
    { channelId: '0xbbb', balance: '500000', totalClaimed: '0', chargedCumulativeAmount: '250000' },
  ];
  return {
    async get(id: string) { return channels.find((c) => c.channelId === id); },
    async list() { return channels; },
    async set() {},
    async delete() {},
  };
}

describe('closeChannel', () => {
  it('claims then refunds one channel and returns a CloseReceipt', async () => {
    const receipt = await closeChannel({
      manager: fakeManager() as never,
      store: fakeStore() as never,
      channelId: '0xaaa',
    });
    expect(receipt.claimTx).toBe('0xclaim');
    expect(receipt.settleTx).toBe('0xsettle');
    expect(receipt.refundTx).toBe('0xrefund');
    // 160000 atomic charged -> 0.16 settled; 300000-160000 -> 0.14 refunded.
    expect(receipt.settledAmount).toBe('0.16');
    expect(receipt.refundedAmount).toBe('0.14');
  });

  it('throws when the claim fails', async () => {
    await expect(
      closeChannel({
        manager: fakeManager({ failClaim: true }) as never,
        store: fakeStore() as never,
        channelId: '0xaaa',
      }),
    ).rejects.toThrow(/claim simulation failed/);
  });
});

describe('closeAll', () => {
  it('returns one result per channel in storage', async () => {
    const results = await closeAll({
      manager: fakeManager() as never,
      store: fakeStore() as never,
    });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.channelId).sort()).toEqual(['0xaaa', '0xbbb']);
    for (const r of results) {
      expect('claimTx' in r).toBe(true);
    }
  });

  it('reports a per-channel error instead of throwing when one channel fails', async () => {
    // A manager whose refund throws only for 0xbbb.
    const manager = {
      async claimAndSettle() {
        return { claims: [{ vouchers: 1, transaction: '0xclaim' }], settle: { transaction: '0xsettle' } };
      },
      async refund(ids: string[]) {
        if (ids.includes('0xbbb')) throw new Error('refund failed for bbb');
        return ids.map((id) => ({ channel: id, transaction: '0xrefund' }));
      },
    };
    const results = await closeAll({ manager: manager as never, store: fakeStore() as never });
    const bbb = results.find((r) => r.channelId === '0xbbb')!;
    expect('error' in bbb).toBe(true);
    if ('error' in bbb) expect(bbb.error).toMatch(/refund failed for bbb/);
  });
});
