import { describe, it, expect } from 'vitest';
import { createBatchSettlementSeller } from '../seller';

describe('createBatchSettlementSeller', () => {
  it('returns a callable object exposing middleware, closeChannel, closeAll, stop', () => {
    const seller = createBatchSettlementSeller({
      payTo: '0x00AC604E07eA856235C746F45362f1BFfc030Ab9',
      network: 'eip155:8453',
      price: '0.08',
      autoSettle: false, // no background loop in this unit test
    });
    expect(typeof seller).toBe('function');          // callable as RequestHandler
    expect(typeof seller.middleware).toBe('function');
    expect(typeof seller.closeChannel).toBe('function');
    expect(typeof seller.closeAll).toBe('function');
    expect(typeof seller.stop).toBe('function');
  });

  it('rejects an unsupported network', () => {
    expect(() =>
      createBatchSettlementSeller({
        payTo: '0x00AC604E07eA856235C746F45362f1BFfc030Ab9',
        network: 'eip155:1', // no x402BatchSettlement contract
        price: '0.08',
        autoSettle: false,
      }),
    ).toThrow(/not (available|supported) on network/i);
  });

  it('stop() resolves even when autoSettle is disabled', async () => {
    const seller = createBatchSettlementSeller({
      payTo: '0x00AC604E07eA856235C746F45362f1BFfc030Ab9',
      network: 'eip155:8453',
      price: '0.08',
      autoSettle: false,
    });
    await expect(seller.stop()).resolves.toBeUndefined();
  });
});
