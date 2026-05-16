import type { ClientChannelStorage } from '@x402/evm/batch-settlement/client';
import type { EvmWallet } from '../adapters/evm';

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

/** Result of channel.close() — the three settlement tx hashes and final amounts. */
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
  /** Facilitator-driven claim -> settle -> refund. Resumable if interrupted. */
  close(): Promise<CloseReceipt>;
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
