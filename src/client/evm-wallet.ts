/**
 * EVM Keypair Wallet for Node.js
 *
 * Creates an EVM wallet interface from a private key.
 * Enables Node.js scripts to use the x402 client for Base/EVM payments
 * without a browser wallet (MetaMask, etc.).
 *
 * Requires `viem` as a peer dependency (`npm install viem`).
 *
 * @example
 * ```typescript
 * import { createX402Client, createEvmKeypairWallet } from '@dexterai/x402/client';
 *
 * // From hex private key (with or without 0x prefix)
 * const wallet = await createEvmKeypairWallet('0xabc123...');
 *
 * const client = createX402Client({
 *   wallets: { evm: wallet },
 * });
 *
 * const response = await client.fetch('https://api.example.com/protected');
 * ```
 */

import type { EvmWallet } from '../adapters/evm';

/**
 * Create an EVM wallet from a private key
 *
 * Uses viem's `privateKeyToAccount` for EIP-712 typed data signing,
 * which is chain-agnostic -- works for Base, Ethereum, Arbitrum, and
 * any EVM chain without hardcoding a specific network.
 *
 * This function is async because viem is loaded via dynamic `import()`
 * to ensure compatibility with both ESM and CJS consumers.
 *
 * @param privateKey - Hex-encoded private key (with or without 0x prefix)
 * @returns Wallet interface compatible with createX402Client's `wallets.evm`
 * @throws If viem is not installed or the private key is invalid
 *
 * @example From environment variable
 * ```typescript
 * const wallet = await createEvmKeypairWallet(process.env.BASE_PRIVATE_KEY!);
 * ```
 *
 * @example With createX402Client
 * ```typescript
 * const client = createX402Client({
 *   wallets: {
 *     solana: createKeypairWallet(process.env.SOLANA_KEY!),
 *     evm: await createEvmKeypairWallet(process.env.BASE_KEY!),
 *   },
 * });
 * ```
 *
 * @example With wrapFetch (automatic -- you don't need this directly)
 * ```typescript
 * const x402Fetch = wrapFetch(fetch, {
 *   evmPrivateKey: process.env.BASE_PRIVATE_KEY!,
 * });
 * // wrapFetch calls createEvmKeypairWallet internally
 * ```
 */
export async function createEvmKeypairWallet(privateKey: string): Promise<EvmWallet> {
  // Dynamic import -- works in both ESM and CJS, and viem 2.x is ESM-only.
  // The module path is a variable so TypeScript doesn't try to resolve the
  // types at build time (viem is an optional peer dependency).
  let privateKeyToAccount: (key: `0x${string}`) => any;
  try {
    const viemAccountsPath = 'viem/accounts';
    const viemAccounts: any = await import(viemAccountsPath);
    privateKeyToAccount = viemAccounts.privateKeyToAccount;
  } catch {
    throw new Error(
      'EVM wallet support requires viem as a peer dependency. Install with: npm install viem'
    );
  }

  // Normalize the private key (accept with or without 0x prefix)
  const normalizedKey = (
    privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
  ) as `0x${string}`;

  const account = privateKeyToAccount(normalizedKey);

  return {
    address: account.address,
    signTypedData: (params: {
      domain: Record<string, unknown>;
      types: Record<string, unknown[]>;
      primaryType: string;
      message: Record<string, unknown>;
    }) => account.signTypedData(params),
  };
}

/**
 * Check if an object is a wallet created by createEvmKeypairWallet
 *
 * Note: This also returns true for any valid EvmWallet -- use `isEvmWallet`
 * from `@dexterai/x402/adapters` for the general check.
 */
export function isEvmKeypairWallet(wallet: unknown): wallet is EvmWallet {
  if (!wallet || typeof wallet !== 'object') return false;
  const w = wallet as Record<string, unknown>;
  return (
    'address' in w &&
    typeof w.address === 'string' &&
    w.address.startsWith('0x') &&
    'signTypedData' in w &&
    typeof w.signTypedData === 'function'
  );
}
