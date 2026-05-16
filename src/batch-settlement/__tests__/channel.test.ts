import { describe, it, expect } from 'vitest';
import { __test_buildClientStack } from '../channel';
import { getDefaultChannelStore } from '../store';

/** A deterministic fake EvmWallet — signs a fixed value, enough for construction. */
const fakeWallet = {
  address: '0x1111111111111111111111111111111111111111' as `0x${string}`,
  connected: true,
  async signTypedData() {
    return ('0x' + '11'.repeat(65)) as `0x${string}`;
  },
};

describe('__test_buildClientStack', () => {
  it('builds an httpClient and scheme for a supported network', () => {
    const stack = __test_buildClientStack({
      wallet: fakeWallet,
      network: 'eip155:8453',
      rpcUrl: 'https://example.invalid',
      store: getDefaultChannelStore(),
      depositAtomic: '300000',
    });
    expect(stack.httpClient).toBeDefined();
    expect(stack.scheme).toBeDefined();
    expect(typeof stack.httpClient.createPaymentPayload).toBe('function');
  });

  it('throws UnsupportedNetworkError for a non-batch-settlement network', () => {
    expect(() =>
      __test_buildClientStack({
        wallet: fakeWallet,
        network: 'eip155:1', // Ethereum mainnet — contract not deployed
        rpcUrl: 'https://example.invalid',
        store: getDefaultChannelStore(),
        depositAtomic: '300000',
      }),
    ).toThrow(/not available on network/i);
  });
});
