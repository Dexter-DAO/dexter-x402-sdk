import { describe, it, expect } from 'vitest';
import { buildV1PaymentHeader } from '../v1-header';
import { createEvmKeypairWallet } from '../../client/evm-wallet';
import { createKeypairWallet } from '../../client/keypair-wallet';
import type { PaymentChallenge } from '../types';

const EVM_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

function evmChallenge(): PaymentChallenge {
  return {
    x402Version: 1,
    options: [
      {
        scheme: 'exact',
        network: { caip2: 'eip155:8453', bare: 'base', family: 'evm' },
        amount: '10000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x0000000000000000000000000000000000000001',
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
  };
}

describe('buildV1PaymentHeader — EVM', () => {
  it('builds a base64 X-PAYMENT header for a v1 EVM exact option', async () => {
    const evm = await createEvmKeypairWallet(EVM_KEY);
    const result = await buildV1PaymentHeader(evmChallenge(), { evm }, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const decoded = JSON.parse(
        Buffer.from(result.headerValue, 'base64').toString('utf8'),
      );
      expect(decoded.x402Version).toBe(1);
      expect(decoded.scheme).toBe('exact');
      expect(decoded.network).toBe('base'); // NO network rewrite
      expect(typeof decoded.payload.signature).toBe('string');
      expect(decoded.payload.authorization.to).toBe(
        '0x0000000000000000000000000000000000000001',
      );
    }
  });

  it('fails merchant_rejected when the EIP-712 domain is missing', async () => {
    const evm = await createEvmKeypairWallet(EVM_KEY);
    const ch = evmChallenge();
    ch.options[0].extra = {};
    const result = await buildV1PaymentHeader(ch, { evm }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('merchant_rejected');
  });

  it('fails budget_exceeded when amount exceeds maxAmountAtomic', async () => {
    const evm = await createEvmKeypairWallet(EVM_KEY);
    const result = await buildV1PaymentHeader(evmChallenge(), { evm }, {
      maxAmountAtomic: '1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('budget_exceeded');
  });

  it('fails unsupported_network when no wallet matches any option', async () => {
    const result = await buildV1PaymentHeader(evmChallenge(), {}, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_network');
  });
});

// A deterministic throwaway 64-byte Solana secret key (generated, unfunded).
const SOL_KEY: number[] = [137,185,198,196,16,106,26,238,156,217,247,235,0,99,5,122,9,60,71,230,189,252,89,54,148,208,50,194,245,60,76,91,191,134,28,7,166,25,141,198,166,230,146,187,146,223,231,79,84,59,221,99,80,28,46,80,141,155,16,110,66,104,43,97];

describe('buildV1PaymentHeader — SVM', () => {
  it('fails merchant_rejected when a v1 SVM option omits extra.feePayer', async () => {
    const solana = await createKeypairWallet(SOL_KEY);
    const ch: PaymentChallenge = {
      x402Version: 1,
      options: [
        {
          scheme: 'exact',
          network: { caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', bare: 'solana', family: 'svm' },
          amount: '10000',
          asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          payTo: '11111111111111111111111111111111',
          maxTimeoutSeconds: 60,
          extra: {}, // no feePayer
        },
      ],
    };
    const result = await buildV1PaymentHeader(ch, { solana }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('merchant_rejected');
      expect(result.detail).toMatch(/feePayer/i);
    }
  });

  it('budget_exceeded is checked before any RPC work for SVM', async () => {
    const solana = await createKeypairWallet(SOL_KEY);
    const ch: PaymentChallenge = {
      x402Version: 1,
      options: [
        {
          scheme: 'exact',
          network: { caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', bare: 'solana', family: 'svm' },
          amount: '10000',
          asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          payTo: '11111111111111111111111111111111',
          maxTimeoutSeconds: 60,
          extra: { feePayer: '11111111111111111111111111111111' },
        },
      ],
    };
    // amount 10000 > budget 1 -> must fail budget_exceeded WITHOUT hitting RPC.
    const result = await buildV1PaymentHeader(ch, { solana }, { maxAmountAtomic: '1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('budget_exceeded');
  });

  it('rejects a non-exact scheme before any RPC work', async () => {
    const solana = await createKeypairWallet(SOL_KEY);
    const ch: PaymentChallenge = {
      x402Version: 1,
      options: [
        {
          scheme: 'upto', // not 'exact' — v1 SVM supports only exact
          network: { caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', bare: 'solana', family: 'svm' },
          amount: '10000',
          asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          payTo: '11111111111111111111111111111111',
          maxTimeoutSeconds: 60,
          extra: { feePayer: '11111111111111111111111111111111' },
        },
      ],
    };
    const result = await buildV1PaymentHeader(ch, { solana }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('merchant_rejected');
      expect(result.detail).toMatch(/exact/i);
    }
  });
});
