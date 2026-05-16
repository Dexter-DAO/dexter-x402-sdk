import { describe, it, expect } from 'vitest';
import { runClose } from '../close';

// The fake manager mirrors the REAL @x402/evm 2.12.0 BatchSettlementChannelManager
// shape: claimAndSettle() -> { claims: ClaimResult[]; settle?: SettleResult } and
// refund(ids) -> RefundResult[] ({ channel, transaction }). The manager surfaces
// only transaction hashes; settled/refunded USDC amounts come from the channel's
// own accounting, passed to runClose as atomic-unit strings.

describe('runClose — claim/settle/refund orchestration', () => {
  it('runs claimAndSettle then refund and returns a CloseReceipt', async () => {
    const calls: string[] = [];
    const fakeManager = {
      async claimAndSettle() {
        calls.push('claimAndSettle');
        return {
          claims: [{ vouchers: 3, transaction: '0xclaim' }],
          settle: { transaction: '0xsettle' },
        };
      },
      async refund(ids: string[]) {
        calls.push(`refund:${ids.join(',')}`);
        return [{ channel: ids[0]!, transaction: '0xrefund' }];
      },
    };
    const receipt = await runClose(fakeManager, '0xchannel', {
      settledAtomic: '160000',
      refundedAtomic: '140000',
    });
    expect(calls).toEqual(['claimAndSettle', 'refund:0xchannel']);
    expect(receipt).toEqual({
      claimTx: '0xclaim',
      settleTx: '0xsettle',
      refundTx: '0xrefund',
      settledAmount: '0.16',
      refundedAmount: '0.14',
    });
  });

  it('surfaces a claim failure as a thrown error, not a partial receipt', async () => {
    const failingManager = {
      async claimAndSettle(): Promise<never> { throw new Error('claim simulation failed'); },
      async refund() { return []; },
    };
    await expect(
      runClose(failingManager, '0xchannel', { settledAtomic: '0', refundedAtomic: '0' }),
    ).rejects.toThrow(/claim simulation failed/);
  });
});
