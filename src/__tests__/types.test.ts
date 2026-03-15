import { describe, it, expect } from 'vitest';
import { X402Error } from '../types';
import type { PaymentAccept, PaymentRequired, PaymentSignature } from '../types';

describe('X402Error', () => {
  it('creates error with code and message', () => {
    const err = new X402Error('insufficient_balance', 'Not enough USDC');
    expect(err.code).toBe('insufficient_balance');
    expect(err.message).toBe('Not enough USDC');
    expect(err.name).toBe('X402Error');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof X402Error).toBe(true);
  });

  it('includes optional details', () => {
    const err = new X402Error('payment_rejected', 'Rejected', { reason: 'expired' });
    expect(err.details).toEqual({ reason: 'expired' });
  });

  it('is catchable as Error', () => {
    try {
      throw new X402Error('missing_amount', 'No amount');
    } catch (e) {
      expect(e instanceof Error).toBe(true);
      expect(e instanceof X402Error).toBe(true);
      expect((e as X402Error).code).toBe('missing_amount');
    }
  });
});

describe('PaymentAccept v2 spec compliance', () => {
  it('amount is required, maxAmountRequired is optional', () => {
    // This is a compile-time check — if it compiles, the types are correct.
    const accept: PaymentAccept = {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',  // required in v2
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x123',
      maxTimeoutSeconds: 60,
      // extra is optional in v2
      // maxAmountRequired is optional (v1 compat)
    };
    expect(accept.amount).toBe('10000');
    expect(accept.maxAmountRequired).toBeUndefined();
    expect(accept.extra).toBeUndefined();
  });

  it('accepts both amount and maxAmountRequired for backwards compat', () => {
    const accept: PaymentAccept = {
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      amount: '50000',
      maxAmountRequired: '50000', // v1 alias
      asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      payTo: 'SellerAddress',
      maxTimeoutSeconds: 60,
      extra: { feePayer: 'FeePayerAddress', decimals: 6 },
    };
    expect(accept.amount).toBe(accept.maxAmountRequired);
  });
});

describe('PaymentRequired has extensions', () => {
  it('supports optional extensions field', () => {
    const req: PaymentRequired = {
      x402Version: 2,
      resource: { url: 'https://api.example.com/data' },
      accepts: [{
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '10000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x123',
        maxTimeoutSeconds: 60,
      }],
      extensions: {
        'sponsored-access': { version: '1', pricing: {} },
      },
    };
    expect(req.extensions?.['sponsored-access']).toBeDefined();
  });
});

describe('PaymentSignature has extensions', () => {
  it('supports optional extensions field', () => {
    const sig: PaymentSignature = {
      x402Version: 2,
      resource: { url: 'https://api.example.com/data' },
      accepted: {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '10000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x123',
        maxTimeoutSeconds: 60,
      },
      payload: { transaction: 'base64tx' },
      extensions: {
        'sponsored-access': { accepted: true, optedOut: false },
      },
    };
    expect(sig.extensions?.['sponsored-access']).toBeDefined();
  });
});
