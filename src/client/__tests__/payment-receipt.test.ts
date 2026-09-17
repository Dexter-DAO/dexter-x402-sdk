import { describe, it, expect } from 'vitest';
import { getPaymentReceipt, capturePaymentReceipt } from '../index';

describe('getPaymentReceipt', () => {
  it('returns undefined for a response without a receipt', () => {
    const response = new Response('{}', { status: 200 });
    expect(getPaymentReceipt(response)).toBeUndefined();
  });

  it('captures a frozen purchase response through the public export without consuming its body', async () => {
    const response = new Response('retained result', { status: 402, headers: {
      'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({
        success: false, errorReason: 'settlement_pending', transaction: 'same-tx',
        network: 'eip155:8453', extensions: { recover: 'original-purchase' },
      })).toString('base64'),
    } });
    const receipt = capturePaymentReceipt(response, { network: 'eip155:8453', amountAtomic: '10000', assetDecimals: 6 });
    expect(receipt).toMatchObject({ settlementStatus: 'pending', transaction: 'same-tx', attemptedAmountAtomic: '10000' });
    expect(receipt.amountAtomic).toBeUndefined();
    expect(getPaymentReceipt(response)).toBe(receipt);
    expect(await response.text()).toBe('retained result');
  });
});
