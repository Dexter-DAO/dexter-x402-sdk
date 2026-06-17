import { describe, it, expect } from 'vitest';
import { tabMiddleware } from '../middleware';
import { InMemoryChannelLedger } from '../channel-ledger';
import { Connection } from '@solana/web3.js';

const SELLER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

describe('tabMiddleware ledger config', () => {
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
    const res: any = {
      status(c: number) { status = c; return this; },
      json(b: unknown) { body = b; return this; },
    };
    await mw(req, res, () => { throw new Error('next should not be called'); });
    expect(status).toBe(402);
    expect(body.error).toBe('invalid_voucher');
    expect(await ledger.get('whatever'.padEnd(64, '0'))).toBeNull();
  });
});
