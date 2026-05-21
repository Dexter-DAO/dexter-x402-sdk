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
 * Everything an adapter needs to ask the chain "did this exact payment
 * settle?" after the fact — without trusting the facilitator or the merchant.
 *
 * `buildTransaction` populates this on the {@link SignedTransaction} it
 * returns. If a post-payment timeout fires, the strategy hands it back to
 * {@link ChainAdapter.confirmSettlement}. A scheme that has no clean on-chain
 * "was this consumed" check (e.g. EVM exact-approval) leaves it `undefined`,
 * and the strategy falls back to reporting `payment_unconfirmed`.
 */
export type SettlementProbe =
  | {
      /** EVM EIP-3009 `transferWithAuthorization` — the default `exact` scheme. */
      kind: 'eip3009';
      /** The authorizer (payer) address — `authorization.from`. */
      from: string;
      /** The 32-byte authorization nonce the SDK generated. The unique key. */
      nonce: string;
      /** The token contract (USDC) — also the EIP-3009 contract exposing `authorizationState`. */
      asset: string;
      /** EVM chain id, decimal. */
      chainId: number;
    }
  | {
      /** EVM Permit2 `permitWitnessTransferFrom`. */
      kind: 'permit2';
      /** The payer address — Permit2 nonces are namespaced per owner. */
      from: string;
      /** The Permit2 nonce (256-bit, decimal string). */
      nonce: string;
      /** EVM chain id, decimal. */
      chainId: number;
    }
  | {
      /** Solana SPL transfer. No nonce-consumed view — confirmed by a windowed scan. */
      kind: 'solana';
      /** The buyer's source associated-token-account. */
      sourceAta: string;
      /** The merchant's destination associated-token-account — the address we scan. */
      destinationAta: string;
      /** The token mint. */
      asset: string;
      /** Atomic amount, as a string. */
      amount: string;
      /** The transaction's recent blockhash — bounds how far back the scan need look. */
      blockhash: string;
    };

/**
 * Result of building and signing a transaction.
 *
 * **Internal adapter return type.** The client remaps these fields before
 * sending to the facilitator — the wire payload uses `payload.transaction`
 * (Solana) or `payload.authorization + payload.signature` (EVM), not
 * `serialized` directly.  See {@link ../client/x402-client.ts} for the mapping.
 */
export interface SignedTransaction {
  /** Base64 (Solana) or JSON-stringified (EVM) transaction — internal only, not the wire field name */
  serialized: string;
  /** Transaction signature/hash if available before broadcast */
  signature?: string;
  /** Protocol extensions (e.g., erc20ApprovalGasSponsoring) to attach to the payment payload */
  extensions?: Record<string, unknown>;
  /**
   * Data needed to confirm settlement on-chain after a post-payment timeout.
   * `undefined` for schemes with no clean on-chain confirmation check.
   * See {@link SettlementProbe} and {@link ChainAdapter.confirmSettlement}.
   */
  settlementProbe?: SettlementProbe;
}

/**
 * Outcome of an on-chain settlement check.
 */
export interface SettlementConfirmation {
  /** True if the payment is confirmed settled on-chain. */
  settled: boolean;
  /** The settling transaction hash, when the check can recover it. */
  txSignature?: string;
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

  /**
   * Ask the chain whether a specific payment settled.
   *
   * Called after a post-payment timeout: the SDK sent the payment
   * authorization, the merchant never responded, and we need to know whether
   * the money actually moved before deciding what to tell the caller. This
   * consults the chain directly via `rpcUrl` — it does not trust the
   * facilitator or the merchant.
   *
   * Optional: an adapter that cannot confirm a given scheme may omit this
   * method (or return `{ settled: false }` is wrong — see below). When the
   * method is absent, or the {@link SettlementProbe} was `undefined`, the
   * strategy falls back to reporting `payment_unconfirmed`.
   *
   * @param probe - The {@link SettlementProbe} captured at build time.
   * @param rpcUrl - The RPC endpoint to query.
   * @returns settled true/false, plus the tx hash when recoverable. An
   *   implementation that genuinely cannot tell should THROW rather than
   *   return `{ settled: false }` — a thrown error is treated as "unknown"
   *   (→ `payment_unconfirmed`), whereas `{ settled: false }` is treated as
   *   a definitive "the money did not move."
   */
  confirmSettlement?(
    probe: SettlementProbe,
    rpcUrl: string,
  ): Promise<SettlementConfirmation>;
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
 * Multi-wallet container for different chains.
 *
 * @example
 * ```typescript
 * import type { SolanaWallet, EvmWallet } from '@dexterai/x402/adapters';
 * ```
 */
export interface WalletSet {
  /** Solana wallet (from @solana/wallet-adapter or createKeypairWallet) */
  solana?: import('../adapters/solana').SolanaWallet;
  /** EVM wallet (from wagmi, createEvmKeypairWallet, or any { address, signTypedData } object) */
  evm?: import('../adapters/evm').EvmWallet;
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



