/**
 * Solana Chain Adapter
 *
 * Implements the ChainAdapter interface for Solana networks.
 * Handles transaction building, signing, and balance queries.
 */

import {
  PublicKey,
  Connection,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  createTransferCheckedInstruction,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import type { ChainAdapter, AdapterConfig, SignedTransaction } from './types';
import type { PaymentAccept } from '../types';

/**
 * CAIP-2 network identifiers for Solana
 */
export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const SOLANA_TESTNET = 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z';

/**
 * Default RPC URLs
 */
const DEFAULT_RPC_URLS: Record<string, string> = {
  [SOLANA_MAINNET]: 'https://api.mainnet-beta.solana.com',
  [SOLANA_DEVNET]: 'https://api.devnet.solana.com',
  [SOLANA_TESTNET]: 'https://api.testnet.solana.com',
};

/**
 * Dexter policy-safe compute budget settings
 */
const DEFAULT_COMPUTE_UNIT_LIMIT = 12_000;
const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1;

/**
 * Solana wallet interface (compatible with @solana/wallet-adapter)
 */
export interface SolanaWallet {
  publicKey: { toBase58(): string } | null;
  signTransaction<T>(tx: T): Promise<T>;
}

/**
 * Check if an object is a valid Solana wallet
 */
export function isSolanaWallet(wallet: unknown): wallet is SolanaWallet {
  if (!wallet || typeof wallet !== 'object') return false;
  const w = wallet as Record<string, unknown>;
  return (
    'publicKey' in w &&
    'signTransaction' in w &&
    typeof w.signTransaction === 'function'
  );
}

/**
 * Solana Chain Adapter
 */
export class SolanaAdapter implements ChainAdapter {
  readonly name = 'Solana';
  readonly networks = [SOLANA_MAINNET, SOLANA_DEVNET, SOLANA_TESTNET];

  private config: AdapterConfig;
  private log: (...args: unknown[]) => void;

  constructor(config: AdapterConfig = {}) {
    this.config = config;
    this.log = config.verbose
      ? console.log.bind(console, '[x402:solana]')
      : () => {};
  }

  canHandle(network: string): boolean {
    // Handle both exact CAIP-2 and legacy formats
    if (this.networks.includes(network)) return true;
    // Legacy format support
    if (network === 'solana') return true;
    if (network === 'solana-devnet') return true;
    if (network === 'solana-testnet') return true;
    // Check if it starts with 'solana:'
    if (network.startsWith('solana:')) return true;
    return false;
  }

  getDefaultRpcUrl(network: string): string {
    // Check custom config first
    if (this.config.rpcUrls?.[network]) {
      return this.config.rpcUrls[network];
    }
    // Check defaults
    if (DEFAULT_RPC_URLS[network]) {
      return DEFAULT_RPC_URLS[network];
    }
    // Normalize legacy networks
    if (network === 'solana') return DEFAULT_RPC_URLS[SOLANA_MAINNET];
    if (network === 'solana-devnet') return DEFAULT_RPC_URLS[SOLANA_DEVNET];
    if (network === 'solana-testnet') return DEFAULT_RPC_URLS[SOLANA_TESTNET];
    // Default to mainnet
    return DEFAULT_RPC_URLS[SOLANA_MAINNET];
  }

  getAddress(wallet: unknown): string | null {
    if (!isSolanaWallet(wallet)) return null;
    return wallet.publicKey?.toBase58() ?? null;
  }

  isConnected(wallet: unknown): boolean {
    if (!isSolanaWallet(wallet)) return false;
    return wallet.publicKey !== null;
  }

  async getBalance(
    accept: PaymentAccept,
    wallet: unknown,
    rpcUrl?: string
  ): Promise<number> {
    if (!isSolanaWallet(wallet) || !wallet.publicKey) {
      return 0;
    }

    const url = rpcUrl || this.getDefaultRpcUrl(accept.network);
    const connection = new Connection(url, 'confirmed');
    const userPubkey = new PublicKey(wallet.publicKey.toBase58());
    const mintPubkey = new PublicKey(accept.asset);

    try {
      // Determine token program
      const mintInfo = await connection.getAccountInfo(mintPubkey, 'confirmed');
      const programId =
        mintInfo?.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()
          ? TOKEN_2022_PROGRAM_ID
          : TOKEN_PROGRAM_ID;

      const ata = await getAssociatedTokenAddress(
        mintPubkey,
        userPubkey,
        false,
        programId
      );

      const account = await getAccount(connection, ata, undefined, programId);
      const decimals = accept.extra?.decimals ?? 6;
      return Number(account.amount) / Math.pow(10, decimals);
    } catch {
      // Token account doesn't exist
      return 0;
    }
  }

  async buildTransaction(
    accept: PaymentAccept,
    wallet: unknown,
    rpcUrl?: string
  ): Promise<SignedTransaction> {
    if (!isSolanaWallet(wallet)) {
      throw new Error('Invalid Solana wallet');
    }
    if (!wallet.publicKey) {
      throw new Error('Wallet not connected');
    }

    const url = rpcUrl || this.getDefaultRpcUrl(accept.network);
    const connection = new Connection(url, 'confirmed');
    const userPubkey = new PublicKey(wallet.publicKey.toBase58());

    // Extract required fields (amount or maxAmountRequired for x402 spec compatibility)
    const { payTo, asset, extra } = accept;
    const amount = accept.amount || accept.maxAmountRequired;
    if (!amount) {
      throw new Error('Missing amount in payment requirements');
    }

    if (!extra?.feePayer) {
      throw new Error('Missing feePayer in payment requirements');
    }
    // Note: decimals is optional - we fetch from mint on-chain if not provided

    const feePayerPubkey = new PublicKey(extra.feePayer);
    const mintPubkey = new PublicKey(asset);
    const destinationPubkey = new PublicKey(payTo);

    this.log('Building transaction:', {
      from: userPubkey.toBase58(),
      to: payTo,
      amount,
      asset,
      feePayer: extra.feePayer,
    });

    // Build instructions
    const instructions: TransactionInstruction[] = [];

    // 1. ComputeBudget: Set compute unit limit
    instructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: DEFAULT_COMPUTE_UNIT_LIMIT,
      })
    );

    // 2. ComputeBudget: Set compute unit price
    instructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
      })
    );

    // 3. Determine token program
    const mintInfo = await connection.getAccountInfo(mintPubkey, 'confirmed');
    if (!mintInfo) {
      throw new Error(`Token mint ${asset} not found`);
    }

    const programId =
      mintInfo.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;

    // Fetch mint to get decimals (required for TransferChecked)
    const mint = await getMint(connection, mintPubkey, undefined, programId);
    if (typeof extra?.decimals === 'number' && mint.decimals !== extra.decimals) {
      this.log(
        `Decimals mismatch: requirements say ${extra.decimals}, mint says ${mint.decimals}`
      );
    }

    // Derive Associated Token Accounts
    const sourceAta = await getAssociatedTokenAddress(
      mintPubkey,
      userPubkey,
      false,
      programId
    );
    const destinationAta = await getAssociatedTokenAddress(
      mintPubkey,
      destinationPubkey,
      false,
      programId
    );

    // Verify source ATA exists
    const sourceAtaInfo = await connection.getAccountInfo(sourceAta, 'confirmed');
    if (!sourceAtaInfo) {
      throw new Error(
        `No token account found for ${asset}. Please ensure you have USDC in your wallet.`
      );
    }

    // Verify destination ATA exists
    const destAtaInfo = await connection.getAccountInfo(destinationAta, 'confirmed');
    if (!destAtaInfo) {
      throw new Error(
        `Seller token account not found. The seller (${payTo}) must have a USDC account.`
      );
    }

    // 4. TransferChecked instruction
    const amountBigInt = BigInt(amount);
    instructions.push(
      createTransferCheckedInstruction(
        sourceAta,
        mintPubkey,
        destinationAta,
        userPubkey,
        amountBigInt,
        mint.decimals,
        [],
        programId
      )
    );

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    // Compile to V0 message (feePayer is facilitator)
    const message = new TransactionMessage({
      payerKey: feePayerPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    // Create and sign transaction
    const transaction = new VersionedTransaction(message);
    const signedTx = await wallet.signTransaction(transaction);

    this.log('Transaction signed successfully');

    return {
      serialized: Buffer.from(signedTx.serialize()).toString('base64'),
    };
  }
}

/**
 * Create a Solana adapter instance
 */
export function createSolanaAdapter(config?: AdapterConfig): SolanaAdapter {
  return new SolanaAdapter(config);
}



