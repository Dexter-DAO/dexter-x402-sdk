import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FacilitatorClient } from '../facilitator-client';

const MOCK_SUPPORTED = {
  kinds: [
    {
      x402Version: 2,
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      extra: { feePayer: 'DEXV...', decimals: 6 },
    },
    {
      x402Version: 2,
      scheme: 'exact',
      network: 'eip155:8453',
      extra: { feePayer: undefined, decimals: 6 },
    },
  ],
};

describe('FacilitatorClient', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.restoreAllMocks());

  it('caches /supported for 1 minute', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => MOCK_SUPPORTED,
    });

    const client = new FacilitatorClient('https://test.facilitator');
    await client.getSupported();
    await client.getSupported();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('getFeePayer returns address for Solana', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => MOCK_SUPPORTED,
    });

    const client = new FacilitatorClient('https://test.facilitator');
    const fp = await client.getFeePayer('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(fp).toBe('DEXV...');
  });

  it('getFeePayer throws for unsupported network', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => MOCK_SUPPORTED,
    });

    const client = new FacilitatorClient('https://test.facilitator');
    await expect(client.getFeePayer('eip155:999')).rejects.toThrow('does not support');
  });

  it('retries on 500 errors', async () => {
    let calls = 0;
    fetchSpy.mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        return { ok: false, status: 500, text: async () => 'Internal error' };
      }
      return { ok: true, json: async () => ({ isValid: true, payer: '0xABC' }) };
    });

    const client = new FacilitatorClient('https://test.facilitator', {
      retryBaseMs: 10,
    });

    const mockPaymentHeader = btoa(JSON.stringify({
      x402Version: 2,
      resource: { url: '/test' },
      accepted: { network: 'eip155:8453', payTo: '0x123', amount: '10000' },
      payload: { transaction: 'abc' },
    }));

    const result = await client.verifyPayment(mockPaymentHeader, {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x123',
      maxTimeoutSeconds: 60,
      extra: {},
    });

    expect(result.isValid).toBe(true);
    expect(calls).toBe(3);
  });

  it('returns structured error on persistent failure', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad request',
    });

    const client = new FacilitatorClient('https://test.facilitator', {
      retryBaseMs: 10,
      maxRetries: 1,
    });

    const mockPaymentHeader = btoa(JSON.stringify({
      x402Version: 2,
      resource: { url: '/test' },
      accepted: { network: 'eip155:8453', payTo: '0x123', amount: '10000' },
      payload: { transaction: 'abc' },
    }));

    const result = await client.verifyPayment(mockPaymentHeader, {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x123',
      maxTimeoutSeconds: 60,
      extra: {},
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('facilitator_error_400');
  });
});
