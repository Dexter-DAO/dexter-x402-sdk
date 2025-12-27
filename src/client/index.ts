/**
 * @dexterai/x402 Client
 *
 * Chain-agnostic client for x402 v2 payments.
 *
 * @example
 * ```typescript
 * import { createX402Client } from '@dexterai/x402/client';
 *
 * // Simple: auto-detects adapters, pass wallet
 * const client = createX402Client({
 *   wallet: solanaWallet,
 * });
 *
 * // Multi-chain: explicit wallets
 * const client = createX402Client({
 *   wallets: {
 *     solana: solanaWallet,
 *     evm: evmWallet,
 *   },
 * });
 *
 * // Fetch with automatic payment handling
 * const response = await client.fetch('https://api.example.com/protected');
 * ```
 */

export { createX402Client } from './x402-client';
export type { X402ClientConfig, X402Client } from './x402-client';

// Re-export types and adapters for convenience
export type { ChainAdapter, WalletSet } from '../adapters/types';
export { X402Error } from '../types';
export {
  createSolanaAdapter,
  createEvmAdapter,
  SOLANA_MAINNET,
  BASE_MAINNET,
} from '../adapters';

// Constants
export { DEXTER_FACILITATOR_URL, USDC_MINT } from '../types';
