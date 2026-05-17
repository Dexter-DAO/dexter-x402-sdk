import { describe, it, expect } from 'vitest';
import { x402Middleware } from '../middleware';

describe('x402Middleware — batch-settlement scheme', () => {
  it('returns a callable seller object exposing stop() and closeAll()', () => {
    const result = x402Middleware({
      payTo: '0x00AC604E07eA856235C746F45362f1BFfc030Ab9',
      amount: '0.08',
      network: 'eip155:8453',
      scheme: 'batch-settlement',
      batchSettlement: { autoSettle: false },
    } as never);
    expect(typeof result).toBe('function');               // usable as RequestHandler
    expect(typeof (result as { stop?: unknown }).stop).toBe('function');
    expect(typeof (result as { closeAll?: unknown }).closeAll).toBe('function');
  });

  it('returns a plain handler (no stop()) for the exact scheme', () => {
    const result = x402Middleware({
      payTo: '0x00AC604E07eA856235C746F45362f1BFfc030Ab9',
      amount: '0.08',
      network: 'eip155:8453',
    });
    expect(typeof result).toBe('function');
    expect((result as { stop?: unknown }).stop).toBeUndefined();
  });
});
