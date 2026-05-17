import type { RequestHandler } from 'express';
import type { ChannelStorage } from '@x402/evm/batch-settlement/server';
import type { CloseReceipt } from '../types';

/**
 * Result of closing one channel from the seller side. Either a settlement
 * receipt, or an error entry when that channel's claim/settle/refund failed.
 */
export type SellerCloseResult =
  | (CloseReceipt & { channelId: string })
  | { channelId: string; error: string };

/** Configuration for createBatchSettlementSeller. */
export interface BatchSettlementSellerConfig {
  /** Seller's payout address; also the channel receiver. */
  payTo: string;
  /** CAIP-2 network: eip155:8453 (Base), eip155:42161 (Arbitrum), eip155:137 (Polygon). */
  network: string;
  /** USDC charged per request, human units, e.g. "0.08". */
  price: string;
  /** Facilitator base URL. Default: https://x402.dexter.cash */
  facilitatorUrl?: string;
  /** The protected route, e.g. "GET /api/data". Default: "GET /". */
  route?: string;
  /**
   * Persistent server-side channel storage. Default: file-backed at
   * ~/.dexter-x402/seller-channels/. Pass RedisChannelStorage or a custom
   * server-side ChannelStorage for multi-instance deployments.
   */
  channelStore?: ChannelStorage;
  /**
   * Auto-settlement loop. Default true (loop on, default intervals). Pass an
   * object to tune; pass false to disable (settle only via closeChannel/closeAll).
   */
  autoSettle?: boolean | {
    claimIntervalSecs?: number;   // default 300
    settleIntervalSecs?: number;  // default 600
    refundIntervalSecs?: number;  // default 900
  };
  /** Verbose logging. */
  verbose?: boolean;
}

/**
 * The seller runtime. It is callable — usable directly as an Express
 * RequestHandler — and exposes lifecycle + settlement methods.
 */
export interface BatchSettlementSeller extends RequestHandler {
  /** Returns the Express request handler (same handler the object itself is). */
  middleware(): RequestHandler;
  /** Claim -> settle -> refund one channel. */
  closeChannel(channelId: string): Promise<CloseReceipt>;
  /** Settle every channel currently in storage; one result per channel. */
  closeAll(): Promise<SellerCloseResult[]>;
  /** Halt the auto-settle loop and flush a final claimAndSettle. */
  stop(): Promise<void>;
}
