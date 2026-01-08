/**
 * Keypair Wallet for Node.js
 *
 * Creates a wallet interface from a Solana private key.
 * Enables Node.js scripts to use the x402 client without a browser wallet.
 *
 * @example
 * ```typescript
 * import { createX402Client, createKeypairWallet } from '@dexterai/x402/client';
 *
 * // From base58 private key
 * const wallet = createKeypairWallet('5abc...xyz');
 *
 * // Or from a JSON array (like in id.json files)
 * const wallet = createKeypairWallet([1,2,3,...64 bytes]);
 *
 * const client = createX402Client({
 *   wallets: { solana: wallet },
 * });
 *
 * const response = await client.fetch('https://api.example.com/protected');
 * ```
 */

import { Keypair, VersionedTransaction, Transaction } from '@solana/web3.js';

/**
 * Keypair wallet interface (compatible with SDK's SolanaWallet)
 */
export interface KeypairWallet {
  /** Public key with toBase58() method */
  publicKey: { toBase58(): string };
  /** Sign a transaction */
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  /** Get the underlying keypair (for advanced use) */
  keypair: Keypair;
}

/**
 * Create a wallet from a Solana private key
 *
 * @param privateKey - Base58 encoded private key string, or Uint8Array/number[] of 64 bytes
 * @returns Wallet interface compatible with createX402Client
 *
 * @example Base58 private key
 * ```typescript
 * const wallet = createKeypairWallet('5abc...xyz');
 * ```
 *
 * @example JSON array (like solana-keygen output)
 * ```typescript
 * const wallet = createKeypairWallet([1,2,3,...]);
 * ```
 *
 * @example From environment variable
 * ```typescript
 * const wallet = createKeypairWallet(process.env.SOLANA_PRIVATE_KEY!);
 * ```
 */
export function createKeypairWallet(
  privateKey: string | number[] | Uint8Array
): KeypairWallet {
  let keypair: Keypair;

  if (typeof privateKey === 'string') {
    // Base58 encoded private key
    // bs58 v6+ uses default export
    const bs58 = require('bs58');
    const decode = bs58.decode || bs58.default?.decode;
    if (!decode) {
      throw new Error('bs58 module not found or incompatible version');
    }
    try {
      const decoded = decode(privateKey);
      keypair = Keypair.fromSecretKey(decoded);
    } catch (e) {
      // Maybe it's a JSON array string?
      try {
        const parsed = JSON.parse(privateKey);
        if (Array.isArray(parsed)) {
          keypair = Keypair.fromSecretKey(Uint8Array.from(parsed));
        } else {
          throw new Error('Invalid private key format');
        }
      } catch {
        throw new Error(
          'Invalid private key. Expected base58 string or JSON array of bytes.'
        );
      }
    }
  } else if (Array.isArray(privateKey)) {
    // Number array
    keypair = Keypair.fromSecretKey(Uint8Array.from(privateKey));
  } else if (privateKey instanceof Uint8Array) {
    // Uint8Array
    keypair = Keypair.fromSecretKey(privateKey);
  } else {
    throw new Error(
      'Invalid private key type. Expected string, number[], or Uint8Array.'
    );
  }

  return {
    publicKey: {
      toBase58: () => keypair.publicKey.toBase58(),
    },
    signTransaction: async <T extends Transaction | VersionedTransaction>(
      tx: T
    ): Promise<T> => {
      if (tx instanceof VersionedTransaction) {
        tx.sign([keypair]);
        return tx;
      } else if (tx instanceof Transaction) {
        tx.sign(keypair);
        return tx;
      }
      throw new Error('Unknown transaction type');
    },
    keypair,
  };
}

/**
 * Check if a wallet is a KeypairWallet
 */
export function isKeypairWallet(wallet: unknown): wallet is KeypairWallet {
  if (!wallet || typeof wallet !== 'object') return false;
  const w = wallet as Record<string, unknown>;
  return (
    'keypair' in w &&
    w.keypair instanceof Keypair &&
    'publicKey' in w &&
    'signTransaction' in w
  );
}
