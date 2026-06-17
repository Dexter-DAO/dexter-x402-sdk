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
 * import { payAndFetch, createEvmKeypairWallet } from '@dexterai/x402/client';
 *
 * // From hex private key (with or without 0x prefix)
 * const evm = await createEvmKeypairWallet('0xabc123...');
 *
 * const result = await payAndFetch(
 *   'https://api.example.com/protected',
 *   undefined,
 *   { evm },
 * );
 * if (result.ok) {
 *   const data = await result.response.json();
 * }
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
 * @returns Wallet interface for the `evm` slot of a `payAndFetch` WalletSet
 * @throws If viem is not installed or the private key is invalid
 *
 * @example From environment variable
 * ```typescript
 * const evm = await createEvmKeypairWallet(process.env.BASE_PRIVATE_KEY!);
 * ```
 *
 * @example Both chains in one WalletSet
 * ```typescript
 * const result = await payAndFetch(url, undefined, {
 *   solana: await createKeypairWallet(process.env.SOLANA_KEY!),
 *   evm: await createEvmKeypairWallet(process.env.BASE_KEY!),
 * });
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
    signTransaction: (params: {
      to: string;
      data: string;
      chainId: number;
      gas?: bigint;
      gasPrice?: bigint;
      nonce?: number;
    }) => account.signTransaction({
      to: params.to as `0x${string}`,
      data: params.data as `0x${string}`,
      chainId: params.chainId,
      gas: params.gas,
      gasPrice: params.gasPrice,
      nonce: params.nonce,
      type: 'legacy' as const,
    }),
    signMessage: (params: { message: string }) =>
      account.signMessage({ message: params.message }),
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
