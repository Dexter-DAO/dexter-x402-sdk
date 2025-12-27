/**
 * Chain Adapter Interface
 *
 * x402 v2 is chain-agnostic. This interface defines how each chain
 * handles transaction building, signing, and balance queries.
 *
 * Implementations:
 * - SolanaAdapter: Solana mainnet/devnet
 * - EvmAdapter: Base, Arbitrum, Ethereum, etc.
 */

import type { PaymentAccept } from '../types';

/**
 * Generic wallet interface that works across chains.
 * Each chain adapter will cast to its specific wallet type.
 */
export interface GenericWallet {
  /** Chain-specific identifier (address or public key) */
  address: string;
  /** Whether the wallet is connected and ready */
  connected: boolean;
}

/**
 * Result of building and signing a transaction
 */
export interface SignedTransaction {
  /** Base64 or hex encoded transaction ready for payload */
  serialized: string;
  /** Transaction signature/hash if available before broadcast */
  signature?: string;
}

/**
 * Chain adapter interface - each chain implements this
 */
export interface ChainAdapter {
  /**
   * Human-readable chain name
   */
  readonly name: string;

  /**
   * CAIP-2 network identifiers this adapter handles
   * e.g., ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'] for Solana mainnet
   * e.g., ['eip155:8453'] for Base
   */
  readonly networks: string[];

  /**
   * Check if this adapter can handle a given network
   * @param network - CAIP-2 network identifier
   */
  canHandle(network: string): boolean;

  /**
   * Build and sign a payment transaction
   *
   * @param accept - The payment option from server's accepts[]
   * @param wallet - Chain-specific wallet (will be cast internally)
   * @param rpcUrl - Optional RPC URL override
   * @returns Signed transaction ready for PAYMENT-SIGNATURE payload
   */
  buildTransaction(
    accept: PaymentAccept,
    wallet: unknown,
    rpcUrl?: string
  ): Promise<SignedTransaction>;

  /**
   * Get the wallet's balance for the payment asset
   *
   * @param accept - Payment option (contains asset info)
   * @param wallet - Chain-specific wallet
   * @param rpcUrl - Optional RPC URL override
   * @returns Balance in human-readable units (e.g., 12.50 for $12.50 USDC)
   */
  getBalance(
    accept: PaymentAccept,
    wallet: unknown,
    rpcUrl?: string
  ): Promise<number>;

  /**
   * Get the wallet's address as a string
   * @param wallet - Chain-specific wallet
   */
  getAddress(wallet: unknown): string | null;

  /**
   * Check if wallet is connected
   * @param wallet - Chain-specific wallet
   */
  isConnected(wallet: unknown): boolean;

  /**
   * Get default RPC URL for a network
   * @param network - CAIP-2 network identifier
   */
  getDefaultRpcUrl(network: string): string;
}

/**
 * Configuration for creating a chain adapter
 */
export interface AdapterConfig {
  /** Custom RPC URLs by network */
  rpcUrls?: Record<string, string>;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Multi-wallet container for different chains
 */
export interface WalletSet {
  /** Solana wallet (from @solana/wallet-adapter) */
  solana?: unknown;
  /** EVM wallet (from wagmi, ethers, or viem) */
  evm?: unknown;
}

/**
 * Balance info across chains
 */
export interface BalanceInfo {
  /** CAIP-2 network identifier */
  network: string;
  /** Human-readable chain name */
  chainName: string;
  /** Balance in human units */
  balance: number;
  /** Asset symbol (e.g., 'USDC') */
  asset: string;
}

