import { createWalletClient, http, publicActions, type Chain } from 'viem';
import { base, arbitrum, polygon } from 'viem/chains';
import { toClientEvmSigner } from '@x402/evm';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { EvmWallet } from '../adapters/evm';
import { UnsupportedNetworkError, type ChannelStore } from './types';

/** CAIP-2 networks where the x402BatchSettlement contract is deployed. */
const SUPPORTED: Record<string, { chain: Chain; defaultRpc: string }> = {
  'eip155:8453': { chain: base, defaultRpc: 'https://mainnet.base.org' },
  'eip155:42161': { chain: arbitrum, defaultRpc: 'https://arb1.arbitrum.io/rpc' },
  'eip155:137': { chain: polygon, defaultRpc: 'https://polygon-rpc.com' },
};

export interface ClientStackInput {
  wallet: EvmWallet;
  network: string;
  rpcUrl?: string;
  store: ChannelStore;
  /** Atomic-units deposit amount; the deposit strategy returns this on the first request. */
  depositAtomic: string;
}

export interface ClientStack {
  scheme: BatchSettlementEvmScheme;
  x402Cli: x402Client;
  httpClient: x402HTTPClient;
  rpcUrl: string;
}

/**
 * Builds the upstream client stack (signer -> scheme -> x402Client -> x402HTTPClient)
 * for a batch-settlement-capable network. The scheme is given the provided
 * ChannelStore, so persistence and on-chain recovery are handled upstream.
 * Throws UnsupportedNetworkError if the network has no deployed contract.
 */
function buildClientStack(input: ClientStackInput): ClientStack {
  const entry = SUPPORTED[input.network];
  if (!entry) {
    throw new UnsupportedNetworkError(
      `batch-settlement is not available on network "${input.network}" — ` +
        `supported: ${Object.keys(SUPPORTED).join(', ')}`,
    );
  }
  const rpcUrl = input.rpcUrl ?? entry.defaultRpc;

  // The scheme signs EIP-712 vouchers and ERC-3009 deposit authorizations; a
  // wallet without signTypedData cannot participate in batch-settlement.
  const walletSignTypedData = input.wallet.signTypedData;
  if (typeof walletSignTypedData !== 'function') {
    throw new Error(
      'batch-settlement requires an EvmWallet that supports signTypedData (EIP-712)',
    );
  }

  // The wallet only needs signTypedData; wrap it as a viem-shaped client and
  // route signTypedData through the consumer's wallet.
  const walletClient = createWalletClient({
    account: { address: input.wallet.address as `0x${string}`, type: 'json-rpc' },
    chain: entry.chain,
    transport: http(rpcUrl),
  }).extend(publicActions);

  const signerClient = Object.assign(walletClient, {
    address: input.wallet.address as `0x${string}`,
    signTypedData: (args: {
      domain: Record<string, unknown>;
      types: Record<string, unknown[]>;
      primaryType: string;
      message: Record<string, unknown>;
    }) => walletSignTypedData.call(input.wallet, args),
  });
  const clientSigner = toClientEvmSigner(
    signerClient as Parameters<typeof toClientEvmSigner>[0],
  );

  const scheme = new BatchSettlementEvmScheme(clientSigner, {
    storage: input.store,
    depositPolicy: { depositMultiplier: 4 },
    depositStrategy: () => input.depositAtomic,
  });

  const x402Cli = new x402Client();
  x402Cli.register(input.network as `${string}:${string}`, scheme);
  const httpClient = new x402HTTPClient(x402Cli);

  return { scheme, x402Cli, httpClient, rpcUrl };
}

/** Test-only export — do not use outside tests. */
export const __test_buildClientStack = buildClientStack;
