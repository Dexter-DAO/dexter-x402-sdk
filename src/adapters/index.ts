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

import { createSolanaAdapter as _createSolanaAdapter } from './solana';
import { createEvmAdapter as _createEvmAdapter } from './evm';
import { USDC_ADDRESSES as _USDC_ADDRESSES, BSC_STABLECOIN_ADDRESSES as _BSC_STABLECOINS } from './evm';

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
  PERMIT2_ADDRESS,
  X402_EXACT_PERMIT2_PROXY,
  BSC_MAINNET,
  BSC_USDT,
  BSC_USDC,
  BSC_STABLECOIN_ADDRESSES,
  BASE_MAINNET,
  BASE_SEPOLIA,
  ARBITRUM_ONE,
  POLYGON,
  OPTIMISM,
  AVALANCHE,
  SKALE_BASE,
  SKALE_BASE_SEPOLIA,
  ETHEREUM_MAINNET,
  USDC_ADDRESSES,
} from './evm';
export type { EvmWallet } from './evm';

/**
 * Check if an asset address is a known USDC contract (any chain).
 * Single source of truth for decimal inference in the client.
 * Also recognizes BSC stablecoins (USDT + USDC, both 18 decimals).
 */
export function isKnownUSDC(asset: string): boolean {
  // Solana mints
  if (asset === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return true; // mainnet
  if (asset === '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU') return true; // devnet
  // All EVM USDC addresses (case-insensitive for EVM)
  const lc = asset.toLowerCase();
  for (const addr of Object.values(_USDC_ADDRESSES)) {
    if (addr.toLowerCase() === lc) return true;
  }
  // BSC stablecoins (USDT + USDC — both recognized, decimals come from extra)
  for (const addr of Object.keys(_BSC_STABLECOINS)) {
    if (addr.toLowerCase() === lc) return true;
  }
  return false;
}

/**
 * Create all default adapters
 */
export function createDefaultAdapters(verbose = false) {
  return [
    _createSolanaAdapter({ verbose }),
    _createEvmAdapter({ verbose }),
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



