/**
 * x402 Server — Core Implementation
 *
 * TODO: Implement the full server helpers:
 * - buildRequirements() — generate PaymentRequired
 * - create402Response() — build proper 402 response
 * - verifyPayment() — verify via facilitator
 * - settlePayment() — settle via facilitator
 */

import type {
  PaymentRequired,
  PaymentAccept,
  ResourceInfo,
  AssetConfig,
} from '../types';
import {
  SOLANA_MAINNET_NETWORK,
  USDC_MINT,
  DEXTER_FACILITATOR_URL,
} from '../types';

/**
 * Configuration for the x402 server
 */
export interface X402ServerConfig {
  /** Facilitator URL (defaults to Dexter's public facilitator) */
  facilitatorUrl?: string;
  /** CAIP-2 network identifier (defaults to Solana mainnet) */
  network?: string;
  /** Wallet address to receive payments */
  payTo: string;
  /** Asset configuration (defaults to USDC) */
  asset?: AssetConfig;
  /** Default timeout for payments in seconds */
  defaultTimeoutSeconds?: number;
}

/**
 * Options for building payment requirements
 */
export interface BuildRequirementsOptions {
  /** Amount in atomic units (e.g., "30000" for 0.03 USDC) */
  amountAtomic: string;
  /** Full URL of the resource being paid for */
  resourceUrl: string;
  /** Human-readable description */
  description?: string;
  /** MIME type of the response */
  mimeType?: string;
  /** Override timeout for this specific request */
  timeoutSeconds?: number;
}

/**
 * x402 Server instance
 */
export interface X402Server {
  /** Build a PaymentRequired structure */
  buildRequirements(options: BuildRequirementsOptions): PaymentRequired;

  /** Encode PaymentRequired for the PAYMENT-REQUIRED header */
  encodeRequirements(requirements: PaymentRequired): string;

  /** Verify a payment signature with the facilitator */
  verifyPayment(paymentSignatureHeader: string): Promise<boolean>;

  /** Settle a payment via the facilitator */
  settlePayment(paymentSignatureHeader: string): Promise<{ success: boolean; signature?: string }>;
}

/**
 * Create an x402 server for accepting payments
 */
export function createX402Server(config: X402ServerConfig): X402Server {
  const {
    facilitatorUrl: _facilitatorUrl = DEXTER_FACILITATOR_URL,
    network = SOLANA_MAINNET_NETWORK,
    payTo,
    asset = { mint: USDC_MINT, decimals: 6 },
    defaultTimeoutSeconds = 60,
  } = config;

  // TODO: Use facilitatorUrl for verify/settle calls
  void _facilitatorUrl;

  function buildRequirements(options: BuildRequirementsOptions): PaymentRequired {
    const {
      amountAtomic,
      resourceUrl,
      description,
      mimeType,
      timeoutSeconds = defaultTimeoutSeconds,
    } = options;

    const resource: ResourceInfo = {
      url: resourceUrl,
      description,
      mimeType,
    };

    const accept: PaymentAccept = {
      scheme: 'exact',
      network,
      amount: amountAtomic,
      asset: asset.mint,
      payTo,
      maxTimeoutSeconds: timeoutSeconds,
      extra: {
        feePayer: payTo, // Dexter sponsors fees, so feePayer = facilitator
        decimals: asset.decimals,
      },
    };

    return {
      x402Version: 2,
      resource,
      accepts: [accept],
      error: 'Payment required',
    };
  }

  function encodeRequirements(requirements: PaymentRequired): string {
    return btoa(JSON.stringify(requirements));
  }

  async function verifyPayment(_paymentSignatureHeader: string): Promise<boolean> {
    // TODO: Call facilitator /verify endpoint
    throw new Error('verifyPayment not yet implemented');
  }

  async function settlePayment(
    _paymentSignatureHeader: string
  ): Promise<{ success: boolean; signature?: string }> {
    // TODO: Call facilitator /settle endpoint
    throw new Error('settlePayment not yet implemented');
  }

  return {
    buildRequirements,
    encodeRequirements,
    verifyPayment,
    settlePayment,
  };
}

