import { describe, it, expect } from 'vitest';
import { getPaymentReceipt } from '../x402-client';

describe('getPaymentReceipt', () => {
  it('returns undefined for a response without a receipt', () => {
    const response = new Response('{}', { status: 200 });
    expect(getPaymentReceipt(response)).toBeUndefined();
  });
});
