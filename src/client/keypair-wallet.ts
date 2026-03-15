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
import type { SolanaWallet } from '../adapters/solana';

/** Symbol key for the underlying Keypair — prevents accidental exposure via console.log or JSON.stringify */
const KEYPAIR_SYMBOL = Symbol.for('x402:keypair');

/**
 * Keypair wallet interface — extends SolanaWallet with safe Keypair access.
 */
export interface KeypairWallet extends SolanaWallet {
  /**
   * Get the underlying Keypair. Accessed via Symbol to prevent accidental
   * exposure through console.log, JSON.stringify, or Object.keys.
   *
   * @example
   * ```typescript
   * import { KEYPAIR_SYMBOL } from '@dexterai/x402/client';
   * const kp = wallet[KEYPAIR_SYMBOL];
   * ```
   */
  [KEYPAIR_SYMBOL]: Keypair;
  /** @deprecated Use wallet[KEYPAIR_SYMBOL] instead — this will be removed in a future major version */
  keypair: Keypair;
}

export { KEYPAIR_SYMBOL };

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
export async function createKeypairWallet(
  privateKey: string | number[] | Uint8Array
): Promise<KeypairWallet> {
  let keypair: Keypair;

  if (typeof privateKey === 'string') {
    // Base58 encoded private key — dynamic import for ESM compatibility.
    // bs58 v5 uses named `decode`; v6+ uses `default.decode`.
    let bs58Decode: (input: string) => Uint8Array;
    try {
      const mod: Record<string, unknown> = await import('bs58');
      const resolve = (mod.decode ?? (mod.default as Record<string, unknown>)?.decode) as
        ((input: string) => Uint8Array) | undefined;
      if (!resolve) throw new Error('decode not found');
      bs58Decode = resolve;
    } catch (e) {
      throw new Error(
        'The "bs58" package is required for base58 private keys. ' +
        'Install it with: npm install bs58',
      );
    }
    try {
      const decoded = bs58Decode(privateKey);
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
    signTransaction: async <T>(tx: T): Promise<T> => {
      if (tx instanceof VersionedTransaction) {
        tx.sign([keypair]);
        return tx;
      } else if (tx instanceof Transaction) {
        tx.sign(keypair);
        return tx;
      }
      throw new Error('Unknown transaction type');
    },
    [KEYPAIR_SYMBOL]: keypair,
    keypair, // deprecated — kept for backwards compat
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
