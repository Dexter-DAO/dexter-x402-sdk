/**
 * x402 v2 SDK — Shared Types
 *
 * Chain-agnostic types for x402 v2 payments.
 * Works with Solana, Base, and any future x402-compatible networks.
 */

// ============================================================================
// Network Constants
// ============================================================================

/** CAIP-2 network identifier for Solana mainnet */
export const SOLANA_MAINNET_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** CAIP-2 network identifier for Base mainnet */
export const BASE_MAINNET_NETWORK = 'eip155:8453';

/** Alias for Solana mainnet */
export const SOLANA_MAINNET = SOLANA_MAINNET_NETWORK;

/** Alias for Base mainnet */
export const BASE_MAINNET = BASE_MAINNET_NETWORK;

// ============================================================================
// Asset Constants
// ============================================================================

/** USDC mint on Solana mainnet */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** USDC address on Base mainnet */
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// ============================================================================
// Facilitator Constants
// ============================================================================

/** Dexter's public x402 v2 facilitator URL */
export const DEXTER_FACILITATOR_URL = 'https://x402.dexter.cash';

// ============================================================================
// PayTo Provider Types (for dynamic address resolution, e.g. Stripe)
// ============================================================================

/**
 * Context passed to a PayToProvider function.
 * Contains request-scoped information for dynamic address resolution.
 */
export interface PayToContext {
  /** The PAYMENT-SIGNATURE header value (present on retry/verify, undefined on initial 402) */
  paymentHeader?: string;
  /** Amount in atomic units (e.g., '10000' for 0.01 USDC) */
  amountAtomic?: string;
  /** The resource URL being accessed */
  resourceUrl?: string;
}

/**
 * Optional defaults a PayToProvider can advertise for auto-configuration.
 * Attached as `_x402Defaults` on the provider function.
 */
export interface PayToProviderDefaults {
  /** Default CAIP-2 network (e.g., 'eip155:8453' for Base) */
  network?: string;
  /** Default facilitator URL */
  facilitatorUrl?: string;
}

/**
 * A function that dynamically resolves a payment address.
 * Used for providers like Stripe that generate per-request deposit addresses.
 *
 * @example
 * ```typescript
 * import { stripePayTo } from '@dexterai/x402/server';
 *
 * const provider = stripePayTo(process.env.STRIPE_SECRET_KEY);
 * const address = await provider({ amountAtomic: '10000' });
 * ```
 */
export type PayToProvider = ((context: PayToContext) => Promise<string>) & {
  /** Auto-configuration defaults (set by provider factories like stripePayTo) */
  _x402Defaults?: PayToProviderDefaults;
};

// ============================================================================
// Payment Types
// ============================================================================

/**
 * Asset configuration for payments
 */
export interface AssetConfig {
  /** Token address (mint on Solana, contract on EVM) */
  address: string;
  /** Token decimals */
  decimals: number;
  /** Optional: Human-readable symbol */
  symbol?: string;
}

/**
 * Resource info included in payment requirements
 */
export interface ResourceInfo {
  /** Resource URL */
  url: string;
  /** Human-readable description */
  description?: string;
  /** MIME type of the resource */
  mimeType?: string;
}

/**
 * Extra fields in payment requirements
 * Chain-specific fields may vary
 */
export interface AcceptsExtra {
  /** Facilitator address that pays tx fees (required for Solana) */
  feePayer?: string;
  /** Token decimals (optional - defaults to 6 for USDC) */
  decimals?: number;
  /** EIP-712: Token name (EVM only) */
  name?: string;
  /** EIP-712: Token version (EVM only) */
  version?: string;
  /** Additional chain-specific fields */
  [key: string]: unknown;
}

/**
 * A single payment option in the accepts array
 */
export interface PaymentAccept {
  /** x402 version (1 or 2, defaults to 2 if not specified) */
  x402Version?: 1 | 2;
  /** Payment scheme (always 'exact' for x402 v2) */
  scheme: 'exact';
  /** CAIP-2 network identifier (v1: 'solana', v2: 'solana:5eykt...') */
  network: string;
  /** Payment amount in atomic units (x402 spec field - REQUIRED) */
  maxAmountRequired: string;
  /** Alias for maxAmountRequired (for convenience) */
  amount?: string;
  /** Token address */
  asset: string;
  /** Seller's address to receive payment */
  payTo: string;
  /** Maximum seconds until payment expires */
  maxTimeoutSeconds: number;
  /** Chain-specific extra data */
  extra: AcceptsExtra;
}

/**
 * Full PaymentRequired structure (sent in PAYMENT-REQUIRED header)
 */
export interface PaymentRequired {
  /** x402 version (always 2) */
  x402Version: 2;
  /** Resource being accessed */
  resource: ResourceInfo;
  /** Available payment options */
  accepts: PaymentAccept[];
  /** Optional error message */
  error?: string;
}

/**
 * PaymentSignature structure (sent in PAYMENT-SIGNATURE header)
 */
export interface PaymentSignature {
  /** x402 version (always 2) */
  x402Version: 2;
  /** Resource being accessed */
  resource: ResourceInfo;
  /** The payment option that was accepted */
  accepted: PaymentAccept;
  /** The signed payment */
  payload: {
    /** Signed transaction (base64 for Solana, JSON for EVM) */
    transaction: string;
  };
}

// ============================================================================
// Facilitator Response Types
// ============================================================================

/**
 * Response from /verify endpoint
 */
export interface VerifyResponse {
  /** Whether the payment is valid */
  isValid: boolean;
  /** Reason for invalidity (if invalid) */
  invalidReason?: string;
  /** Payer address */
  payer?: string;
}

/**
 * Response from /settle endpoint
 */
export interface SettleResponse {
  /** Whether settlement succeeded */
  success: boolean;
  /** Transaction signature/hash */
  transaction?: string;
  /** Network the payment was made on */
  network: string;
  /** Error reason (if failed) */
  errorReason?: string;
  /** Error code (if failed) */
  errorCode?: string;
  /** Payer address */
  payer?: string;
}

// ============================================================================
// Access Pass Types
// ============================================================================

/**
 * A single access pass tier offered by a seller
 */
export interface AccessPassTier {
  /** Tier ID (e.g., '1h', '24h') */
  id: string;
  /** Human-readable label (e.g., '1 hour') */
  label: string;
  /** Duration in seconds */
  seconds: number;
  /** Price in USD (e.g., '0.50') */
  price: string;
  /** Price in atomic units (e.g., '500000') */
  priceAtomic: string;
}

/**
 * Access pass info returned in X-ACCESS-PASS-TIERS header
 */
export interface AccessPassInfo {
  /** Available tiers (if tier-based pricing) */
  tiers?: AccessPassTier[];
  /** Rate per hour in USD (if custom duration pricing) */
  ratePerHour?: string;
  /** Pass issuer identifier */
  issuer?: string;
}

/**
 * JWT claims inside an access pass token
 */
export interface AccessPassClaims {
  /** Subject — always 'x402-access-pass' */
  sub: string;
  /** Tier ID or 'custom' */
  tier: string;
  /** Duration in seconds */
  duration: number;
  /** Issued at (unix seconds) */
  iat: number;
  /** Expires at (unix seconds) */
  exp: number;
  /** Payer wallet address */
  payer: string;
  /** Network used for payment */
  network: string;
  /** Issuer identifier */
  iss: string;
}

/**
 * Client-side access pass configuration
 */
export interface AccessPassClientConfig {
  /** Enable access pass mode (default: true when this config is present) */
  enabled?: boolean;
  /** Preferred tier ID (e.g., '1h') — pick this tier if available */
  preferTier?: string;
  /** Preferred custom duration in seconds (e.g., 3600) */
  preferDuration?: number;
  /** Maximum amount willing to spend in USD (e.g., '2.00') */
  maxSpend?: string;
  /** Auto-renew expired passes (default: true) */
  autoRenew?: boolean;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * SDK error codes
 */
export type X402ErrorCode =
  // Client errors
  | 'missing_payment_required_header'
  | 'invalid_payment_required'
  | 'unsupported_network'
  | 'no_matching_payment_option'
  | 'no_solana_accept' // Legacy, kept for compatibility
  | 'missing_fee_payer'
  | 'missing_decimals'
  | 'missing_amount'
  | 'amount_exceeds_max'
  | 'insufficient_balance'
  | 'wallet_missing_sign_transaction'
  | 'wallet_not_connected'
  | 'transaction_build_failed'
  | 'payment_rejected'
  // Server errors
  | 'invalid_payment_signature'
  | 'facilitator_verify_failed'
  | 'facilitator_settle_failed'
  | 'facilitator_request_failed'
  | 'no_matching_requirement'
  // Access pass errors
  | 'access_pass_expired'
  | 'access_pass_invalid'
  | 'access_pass_tier_not_found'
  | 'access_pass_exceeds_max_spend';

/**
 * Custom error class for x402 operations
 */
export class X402Error extends Error {
  /** Error code for programmatic handling */
  code: X402ErrorCode;
  /** Additional error details */
  details?: unknown;

  constructor(code: X402ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'X402Error';
    this.code = code;
    this.details = details;
    // Maintain proper prototype chain
    Object.setPrototypeOf(this, X402Error.prototype);
  }
}
