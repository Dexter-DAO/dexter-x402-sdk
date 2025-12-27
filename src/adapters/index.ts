/**
 * Chain Adapters
 *
 * x402 v2 is designed to be chain-agnostic. Each adapter handles
 * the specifics of transaction building and signing for its chain.
 *
 * @example
 * ```typescript
 * import { createSolanaAdapter, createEvmAdapter } from '@dexterai/x402/adapters';
 *
 * const adapters = [
 *   createSolanaAdapter(),
 *   createEvmAdapter(),
 * ];
 *
 * // Find adapter for a network
 * const adapter = adapters.find(a => a.canHandle('eip155:8453'));
 * ```
 */

// Types
export type {
  ChainAdapter,
  AdapterConfig,
  SignedTransaction,
  GenericWallet,
  WalletSet,
  BalanceInfo,
} from './types';

// Solana
export {
  SolanaAdapter,
  createSolanaAdapter,
  isSolanaWallet,
  SOLANA_MAINNET,
  SOLANA_DEVNET,
  SOLANA_TESTNET,
} from './solana';
export type { SolanaWallet } from './solana';

// EVM
export {
  EvmAdapter,
  createEvmAdapter,
  isEvmWallet,
  BASE_MAINNET,
  BASE_SEPOLIA,
  ETHEREUM_MAINNET,
  ARBITRUM_ONE,
} from './evm';
export type { EvmWallet } from './evm';

/**
 * Create all default adapters
 */
export function createDefaultAdapters(verbose = false) {
  const { createSolanaAdapter } = require('./solana');
  const { createEvmAdapter } = require('./evm');
  return [
    createSolanaAdapter({ verbose }),
    createEvmAdapter({ verbose }),
  ];
}

/**
 * Find adapter that can handle a network
 */
export function findAdapter(
  adapters: import('./types').ChainAdapter[],
  network: string
): import('./types').ChainAdapter | undefined {
  return adapters.find(adapter => adapter.canHandle(network));
}



