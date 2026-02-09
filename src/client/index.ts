/**
 * @dexterai/x402 Client
 *
 * Chain-agnostic client for x402 v2 payments.
 *
 * @example Browser (with wallet adapter)
 * ```typescript
 * import { createX402Client } from '@dexterai/x402/client';
 *
 * const client = createX402Client({
 *   wallets: { solana: phantomWallet },
 * });
 *
 * const response = await client.fetch('https://api.example.com/protected');
 * ```
 *
 * @example Node.js (with private key) - Recommended
 * ```typescript
 * import { wrapFetch } from '@dexterai/x402/client';
 *
 * const x402Fetch = wrapFetch(fetch, {
 *   walletPrivateKey: process.env.SOLANA_PRIVATE_KEY!,
 * });
 *
 * const response = await x402Fetch('https://api.example.com/protected');
 * ```
 *
 * @example Node.js (with keypair wallet)
 * ```typescript
 * import { createX402Client, createKeypairWallet } from '@dexterai/x402/client';
 *
 * const wallet = createKeypairWallet(process.env.SOLANA_PRIVATE_KEY!);
 * const client = createX402Client({ wallets: { solana: wallet } });
 *
 * const response = await client.fetch('https://api.example.com/protected');
 * ```
 */

// Main client
export { createX402Client } from './x402-client';
export type { X402ClientConfig, X402Client } from './x402-client';

// Node.js helpers
export { wrapFetch } from './wrap-fetch';
export type { WrapFetchOptions } from './wrap-fetch';

export { createKeypairWallet, isKeypairWallet } from './keypair-wallet';
export type { KeypairWallet } from './keypair-wallet';

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

// Access pass types
export type { AccessPassClientConfig, AccessPassTier, AccessPassInfo } from '../types';
