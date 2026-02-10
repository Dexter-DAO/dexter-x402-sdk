/**
 * Simple Fetch Wrapper for Node.js
 *
 * The easiest way to make x402 payments from Node.js scripts.
 * Just provide a private key and it handles everything automatically.
 *
 * @example
 * ```typescript
 * import { wrapFetch } from '@dexterai/x402/client';
 *
 * const x402Fetch = wrapFetch(fetch, {
 *   walletPrivateKey: process.env.SOLANA_PRIVATE_KEY!,
 * });
 *
 * // Make a paid request - payment happens automatically
 * const response = await x402Fetch('https://api.example.com/protected');
 * const data = await response.json();
 * ```
 */

import { createX402Client, type X402ClientConfig } from './x402-client';
import { createKeypairWallet } from './keypair-wallet';
import { createEvmKeypairWallet } from './evm-wallet';
import type { AccessPassClientConfig } from '../types';

/**
 * Options for wrapFetch
 */
export interface WrapFetchOptions {
  /**
   * Solana private key (base58 string or JSON array)
   * Required for Solana payments.
   */
  walletPrivateKey?: string | number[] | Uint8Array;

  /**
   * EVM private key (hex string with or without 0x prefix)
   * Required for Base/EVM payments.
   * Note: EVM support requires viem - import from '@dexterai/x402/adapters'
   */
  evmPrivateKey?: string;

  /**
   * Preferred network when multiple options are available
   * @default 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' (Solana mainnet)
   */
  preferredNetwork?: string;

  /**
   * Facilitator URL
   * @default 'https://x402-facilitator.dexter.cash'
   */
  facilitatorUrl?: string;

  /**
   * Custom RPC URLs by network
   */
  rpcUrls?: Record<string, string>;

  /**
   * Maximum payment amount in atomic units
   * Rejects payments exceeding this amount.
   */
  maxAmountAtomic?: string;

  /**
   * Enable verbose logging
   */
  verbose?: boolean;

  /**
   * Access pass configuration.
   * When provided, the client prefers purchasing time-limited passes
   * over per-request payments. One payment grants unlimited requests.
   *
   * @example
   * ```typescript
   * const x402Fetch = wrapFetch(fetch, {
   *   walletPrivateKey: process.env.SOLANA_PRIVATE_KEY!,
   *   accessPass: { preferTier: '1h', maxSpend: '1.00' },
   * });
   * // First call: auto-buys 1-hour pass
   * // All subsequent calls: uses cached pass (no payment)
   * ```
   */
  accessPass?: AccessPassClientConfig;
}

/**
 * Wrap fetch with automatic x402 payment handling
 *
 * @param fetchImpl - The fetch function to wrap (usually `fetch` or `node-fetch`)
 * @param options - Configuration options
 * @returns A fetch function that handles x402 payments automatically
 *
 * @example Basic usage
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
 * @example With options
 * ```typescript
 * const x402Fetch = wrapFetch(fetch, {
 *   walletPrivateKey: process.env.SOLANA_PRIVATE_KEY!,
 *   maxAmountAtomic: '1000000',  // Max $1.00 per request
 *   verbose: true,
 * });
 * ```
 */
export function wrapFetch(
  fetchImpl: typeof globalThis.fetch,
  options: WrapFetchOptions
): typeof globalThis.fetch {
  const {
    walletPrivateKey,
    evmPrivateKey,
    preferredNetwork,
    // facilitatorUrl is reserved for future use when we add facilitator selection
    rpcUrls,
    maxAmountAtomic,
    verbose,
    accessPass,
  } = options;

  // Validate at least one wallet
  if (!walletPrivateKey && !evmPrivateKey) {
    throw new Error('At least one wallet private key is required (walletPrivateKey or evmPrivateKey)');
  }

  // Build wallet set
  const wallets: { solana?: unknown; evm?: unknown } = {};

  if (walletPrivateKey) {
    wallets.solana = createKeypairWallet(walletPrivateKey);
  }

  // EVM wallet init is async (viem is ESM-only, must use dynamic import).
  // We start it eagerly here and await it in the returned fetch function
  // so wrapFetch itself stays synchronous.
  let evmReady: Promise<void> | null = null;
  if (evmPrivateKey) {
    evmReady = createEvmKeypairWallet(evmPrivateKey)
      .then(w => { wallets.evm = w; })
      .catch(e => { console.warn(`[x402] ${e.message}`); });
  }

  // Create client config
  const clientConfig: X402ClientConfig = {
    wallets,
    preferredNetwork,
    rpcUrls,
    maxAmountAtomic,
    fetch: fetchImpl,
    verbose,
    accessPass,
  };

  // Create client
  const client = createX402Client(clientConfig);
  const clientFetch = client.fetch.bind(client);

  // If EVM wallet is initializing, wrap fetch to await it before first call
  if (evmReady) {
    return (async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      await evmReady;
      return clientFetch(input, init);
    }) as typeof globalThis.fetch;
  }

  return clientFetch;
}
