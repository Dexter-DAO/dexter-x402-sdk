import type { ClientChannelStorage } from '@x402/evm/batch-settlement/client';
import type { EvmWallet } from '../adapters/evm';
import type { ForceWithdrawResult, FinalizeWithdrawResult } from './withdraw';

/**
 * Channel persistence. This is the upstream `ClientChannelStorage` interface
 * (`get` / `set` / `delete`, keyed by lowercased channelId). The SDK ships
 * file-backed and localStorage-backed implementations; a consumer may pass any
 * `ClientChannelStorage` (e.g. one backed by their own database).
 */
export type ChannelStore = ClientChannelStorage;

/** Channel accounting, all amounts USDC human units (e.g. "0.30"). */
export interface ChannelState {
  /** Total escrowed into the channel. */
  deposited: string;
  /** Cumulative amount spent via vouchers. */
  spent: string;
  /** deposited - spent. */
  remaining: string;
}

/** Options for opening a fresh (or auto-resumed) channel. */
export interface OpenBatchChannelOptions {
  /** EVM wallet — any { address, signTypedData }. The same EvmWallet the exact scheme uses. */
  wallet: EvmWallet;
  /** CAIP-2 network: eip155:8453 (Base), eip155:42161 (Arbitrum), eip155:137 (Polygon). */
  network: string;
  /** Total escrow for the channel, USDC human units, e.g. "0.30". */
  deposit: string;
  /** Facilitator base URL. Default: https://x402.dexter.cash */
  facilitatorUrl?: string;
  /** RPC URL override. Default: per-network. */
  rpcUrl?: string;
  /** Channel persistence. Default: localStorage (browser) / file (Node). */
  store?: ChannelStore;
}

/** Options for explicitly resuming an existing channel. */
export interface ResumeBatchChannelOptions {
  wallet: EvmWallet;
  network: string;
  facilitatorUrl?: string;
  rpcUrl?: string;
  store?: ChannelStore;
}

/**
 * Result of the seller runtime's claim -> settle -> refund — the three
 * settlement tx hashes and final amounts. Used by the SELLER module; the
 * buyer's channel.close() returns {@link CloseResult} instead.
 */
export interface CloseReceipt {
  /** claimWithSignature tx hash. */
  claimTx: string;
  /** settle tx hash. */
  settleTx: string;
  /** refundWithSignature tx hash. */
  refundTx: string;
  /** Amount paid to the seller, USDC human units. */
  settledAmount: string;
  /** Unspent amount returned to the buyer, USDC human units. */
  refundedAmount: string;
}

/** Result of the buyer's channel.close() — an intent signal, not a settlement. */
export interface CloseResult {
  /** Always true — the channel was marked done in the buyer's local store. */
  closed: true;
}

/**
 * A live escrow channel. Returned by openBatchChannel / resumeBatchChannel.
 * Hold this handle for the lifetime of a batching session.
 */
export interface BatchSettlementChannel {
  /** On-chain channel id (bytes32 hex). Empty until the first fetch resolves it. */
  readonly channelId: string;
  /** CAIP-2 network. */
  readonly network: string;
  /** Live channel accounting; updated after each fetch. */
  readonly state: ChannelState;
  /** Drop-in fetch. On a batch-settlement 402, signs a voucher and retries. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /**
   * Marks the channel done in the buyer's local store (an intent signal).
   * The buyer does not settle — the seller's runtime claims accumulated
   * vouchers and refunds the buyer's unspent escrow. Returns { closed: true }.
   */
  close(): Promise<CloseResult>;
  /**
   * Escape hatch — initiates the contract's on-chain withdrawal of this
   * channel's unspent escrow, starting the withdrawDelay timer. Use only if
   * the seller never settles. COSTS THE BUYER GAS — the buyer's wallet must
   * hold the chain's native token; there is no facilitator-relayed variant.
   */
  forceWithdraw(): Promise<ForceWithdrawResult>;
  /**
   * Escape hatch — finalizes a withdrawal started by forceWithdraw, after the
   * withdrawDelay has elapsed; returns the funds. Throws WithdrawNotReadyError
   * if called too early. COSTS THE BUYER GAS.
   */
  finalizeWithdraw(): Promise<FinalizeWithdrawResult>;
}

/** Thrown by openBatchChannel when the buyer wallet lacks USDC for the deposit. */
export class InsufficientBalanceError extends Error {
  constructor(message: string) {
    // ES2022 compile target: setting `this.name` is sufficient; no Object.setPrototypeOf needed.
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

/** Thrown when a network has no deployed x402BatchSettlement contract. */
export class UnsupportedNetworkError extends Error {
  constructor(message: string) {
    // ES2022 compile target: setting `this.name` is sufficient; no Object.setPrototypeOf needed.
    super(message);
    this.name = 'UnsupportedNetworkError';
  }
}
