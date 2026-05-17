import { describe, it, expect } from 'vitest';
import { __test_buildClientStack, openBatchChannel } from '../channel';
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

describe('openBatchChannel', () => {
  it('rejects an unsupported network before any signing', async () => {
    await expect(
      openBatchChannel({
        wallet: fakeWallet,
        network: 'eip155:1',
        deposit: '0.30',
        store: getDefaultChannelStore(),
      }),
    ).rejects.toThrow(/not available on network/i);
  });

  it('rejects a non-positive deposit', async () => {
    await expect(
      openBatchChannel({
        wallet: fakeWallet,
        network: 'eip155:8453',
        deposit: '0',
        store: getDefaultChannelStore(),
      }),
    ).rejects.toThrow(/deposit must be a positive amount/i);
  });

  it('rejects a malformed deposit string with a clear error', async () => {
    await expect(
      openBatchChannel({
        wallet: fakeWallet,
        network: 'eip155:8453',
        deposit: 'not-a-number',
        store: getDefaultChannelStore(),
      }),
    ).rejects.toThrow(/valid USDC amount/i);
  });

  it('returns a handle exposing channelId, network, state, fetch, and close', async () => {
    const channel = await openBatchChannel({
      wallet: fakeWallet,
      network: 'eip155:8453',
      deposit: '0.30',
      rpcUrl: 'https://example.invalid',
      store: getDefaultChannelStore(),
    });
    expect(channel.network).toBe('eip155:8453');
    expect(typeof channel.fetch).toBe('function');
    expect(typeof channel.close).toBe('function');
    expect(channel.state).toEqual({
      deposited: '0.3',
      spent: '0',
      remaining: '0.3',
    });
  });
});

describe('channel.close() — repurposed as an intent signal', () => {
  it('returns { closed: true } and does not throw when no requests were made', async () => {
    const channel = await openBatchChannel({
      wallet: fakeWallet,
      network: 'eip155:8453',
      deposit: '0.30',
      rpcUrl: 'https://example.invalid',
      store: getDefaultChannelStore(),
    });
    const result = await channel.close();
    expect(result).toEqual({ closed: true });
  });
});

describe('escape hatch — wallet transaction capability', () => {
  // The escape hatch bridges only `wallet.sendTransaction` (the wallet owns
  // gas/nonce). A `signTransaction`-only wallet cannot be used: signing without
  // a nonce/gas yields an unbroadcastable raw tx. So the capability gate must
  // require `sendTransaction` specifically and the error must name it.
  it('forceWithdraw throws a clear error when the wallet cannot submit transactions', async () => {
    // fakeWallet has only signTypedData — no sendTransaction.
    // The escape hatch needs the buyer to pay gas, so it must fail clearly.
    const channel = await openBatchChannel({
      wallet: fakeWallet,
      network: 'eip155:8453',
      deposit: '0.30',
      rpcUrl: 'https://example.invalid',
      store: getDefaultChannelStore(),
    });
    await expect(channel.forceWithdraw()).rejects.toThrow(
      /requires a wallet with a sendTransaction method/i,
    );
  });

  it('finalizeWithdraw throws the same clear error for a signature-only wallet', async () => {
    const channel = await openBatchChannel({
      wallet: fakeWallet,
      network: 'eip155:8453',
      deposit: '0.30',
      rpcUrl: 'https://example.invalid',
      store: getDefaultChannelStore(),
    });
    await expect(channel.finalizeWithdraw()).rejects.toThrow(
      /requires a wallet with a sendTransaction method/i,
    );
  });

  it('forceWithdraw throws the capability error for a signTransaction-only wallet (signTransaction alone is not sufficient)', async () => {
    // A wallet that exposes signTransaction but NOT sendTransaction must FAIL
    // the gate: this SDK does not hand the wallet a nonce/gas-bearing tx, so a
    // raw signature from signTransaction is not broadcastable.
    const signOnlyWallet = {
      ...fakeWallet,
      async signTransaction() {
        return ('0x' + 'cd'.repeat(64)) as `0x${string}`;
      },
    };
    const channel = await openBatchChannel({
      wallet: signOnlyWallet,
      network: 'eip155:8453',
      deposit: '0.30',
      rpcUrl: 'https://example.invalid',
      store: getDefaultChannelStore(),
    });
    await expect(channel.forceWithdraw()).rejects.toThrow(
      /requires a wallet with a sendTransaction method/i,
    );
    await expect(channel.finalizeWithdraw()).rejects.toThrow(
      /requires a wallet with a sendTransaction method/i,
    );
  });

  it('a transaction-capable wallet passes the capability gate (fails later on channel state, not capability)', async () => {
    // A wallet with sendTransaction CAN use the escape hatch — so it must NOT
    // hit the capability error. With no fetch() yet there is no channelConfig,
    // so it falls through to the channel-state error instead.
    const txWallet = {
      ...fakeWallet,
      async sendTransaction() {
        return ('0x' + 'ab'.repeat(32)) as `0x${string}`;
      },
    };
    const channel = await openBatchChannel({
      wallet: txWallet,
      network: 'eip155:8453',
      deposit: '0.30',
      rpcUrl: 'https://example.invalid',
      store: getDefaultChannelStore(),
    });
    await expect(channel.forceWithdraw()).rejects.toThrow(
      /unavailable until the channel has resolved on-chain/i,
    );
  });
});
