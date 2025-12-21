/**
 * Dexter x402 v2 SDK — Shared Types
 */

/** CAIP-2 network identifier for Solana mainnet */
export const SOLANA_MAINNET_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** USDC mint on Solana mainnet */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Dexter's public x402 v2 facilitator URL */
export const DEXTER_FACILITATOR_URL = 'https://x402.dexter.cash';

/**
 * Asset configuration for payments
 */
export type AssetConfig = {
  mint: string;
  decimals: number;
};

/**
 * Resource info included in payment requirements
 */
export type ResourceInfo = {
  url: string;
  description?: string;
  mimeType?: string;
};

/**
 * Extra fields specific to Dexter v2 Solana payments
 */
export type AcceptsExtra = {
  feePayer: string;
  decimals: number;
};

/**
 * A single payment option in the accepts array
 */
export type PaymentAccept = {
  scheme: 'exact';
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: AcceptsExtra;
};

/**
 * Full PaymentRequired structure (sent in PAYMENT-REQUIRED header)
 */
export type PaymentRequired = {
  x402Version: 2;
  resource: ResourceInfo;
  accepts: PaymentAccept[];
  error?: string;
};

/**
 * PaymentSignature structure (sent in PAYMENT-SIGNATURE header)
 */
export type PaymentSignature = {
  x402Version: 2;
  resource: ResourceInfo;
  accepted: PaymentAccept;
  payload: {
    transaction: string; // base64 encoded signed transaction
  };
};

/**
 * SDK error codes
 */
export type X402ErrorCode =
  // Client errors
  | 'missing_payment_required_header'
  | 'invalid_payment_required'
  | 'unsupported_network'
  | 'no_solana_accept'
  | 'missing_fee_payer'
  | 'missing_decimals'
  | 'amount_exceeds_max'
  | 'wallet_missing_sign_transaction'
  | 'transaction_build_failed'
  | 'payment_rejected'
  // Server errors
  | 'invalid_payment_signature'
  | 'facilitator_verify_failed'
  | 'facilitator_settle_failed'
  | 'no_matching_requirement';

/**
 * Custom error class for x402 operations
 */
export class X402Error extends Error {
  code: X402ErrorCode;
  details?: unknown;

  constructor(code: X402ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'X402Error';
    this.code = code;
    this.details = details;
  }
}

