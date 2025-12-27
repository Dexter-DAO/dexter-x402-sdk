/**
 * Dexter x402 v2 Server
 *
 * Server-side helpers for accepting x402 payments:
 * - Build payment requirements for 402 responses
 * - Verify payments with the facilitator
 * - Settle payments to execute the transfer
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
import { FacilitatorClient } from './facilitator-client';
import type { VerifyResponse, SettleResponse } from './facilitator-client';

/**
 * Configuration for the x402 server
 */
export interface X402ServerConfig {
  /** Wallet address to receive payments */
  payTo: string;
  /** Facilitator URL (defaults to Dexter's public facilitator) */
  facilitatorUrl?: string;
  /** CAIP-2 network identifier (defaults to Solana mainnet) */
  network?: string;
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
  /** Build a PaymentRequired structure (async to fetch feePayer from facilitator) */
  buildRequirements(options: BuildRequirementsOptions): Promise<PaymentRequired>;

  /** Encode PaymentRequired for the PAYMENT-REQUIRED header */
  encodeRequirements(requirements: PaymentRequired): string;

  /** Create a complete 402 response object */
  create402Response(requirements: PaymentRequired): {
    status: 402;
    headers: { 'PAYMENT-REQUIRED': string };
    body: Record<string, never>;
  };

  /** Verify a payment signature with the facilitator */
  verifyPayment(paymentSignatureHeader: string): Promise<VerifyResponse>;

  /** Settle a payment via the facilitator */
  settlePayment(paymentSignatureHeader: string): Promise<SettleResponse>;

  /** Get the PaymentAccept structure for verify/settle calls */
  getPaymentAccept(options: BuildRequirementsOptions): Promise<PaymentAccept>;
}

/**
 * Create an x402 server for accepting payments
 *
 * @example
 * ```ts
 * const server = createX402Server({
 *   payTo: 'YourSolanaAddress...',
 * });
 *
 * // In your route handler:
 * const requirements = await server.buildRequirements({
 *   amountAtomic: '30000', // $0.03 USDC
 *   resourceUrl: 'https://api.example.com/resource',
 *   description: 'Access to protected resource',
 * });
 *
 * // Return 402 with PAYMENT-REQUIRED header
 * const response = server.create402Response(requirements);
 * ```
 */
export function createX402Server(config: X402ServerConfig): X402Server {
  const {
    payTo,
    facilitatorUrl = DEXTER_FACILITATOR_URL,
    network = SOLANA_MAINNET_NETWORK,
    asset = { mint: USDC_MINT, decimals: 6 },
    defaultTimeoutSeconds = 60,
  } = config;

  const facilitator = new FacilitatorClient(facilitatorUrl);

  // Cache for feePayer to avoid repeated /supported calls
  let cachedFeePayer: string | null = null;

  /**
   * Get the feePayer from the facilitator (cached)
   */
  async function getFeePayer(): Promise<string> {
    if (!cachedFeePayer) {
      cachedFeePayer = await facilitator.getFeePayer(network);
    }
    return cachedFeePayer;
  }

  /**
   * Build a PaymentAccept structure
   */
  async function getPaymentAccept(options: BuildRequirementsOptions): Promise<PaymentAccept> {
    const {
      amountAtomic,
      timeoutSeconds = defaultTimeoutSeconds,
    } = options;

    const feePayer = await getFeePayer();

    return {
      scheme: 'exact',
      network,
      amount: amountAtomic,
      asset: asset.mint,
      payTo,
      maxTimeoutSeconds: timeoutSeconds,
      extra: {
        feePayer, // CORRECT: feePayer comes from facilitator, not payTo
        decimals: asset.decimals,
      },
    };
  }

  /**
   * Build payment requirements for a 402 response
   */
  async function buildRequirements(options: BuildRequirementsOptions): Promise<PaymentRequired> {
    const {
      resourceUrl,
      description,
      mimeType = 'application/json',
    } = options;

    const resource: ResourceInfo = {
      url: resourceUrl,
      description,
      mimeType,
    };

    const accept = await getPaymentAccept(options);

    return {
      x402Version: 2,
      resource,
      accepts: [accept],
      error: 'Payment required',
    };
  }

  /**
   * Encode requirements for PAYMENT-REQUIRED header
   */
  function encodeRequirements(requirements: PaymentRequired): string {
    return btoa(JSON.stringify(requirements));
  }

  /**
   * Create a complete 402 response object
   */
  function create402Response(requirements: PaymentRequired): {
    status: 402;
    headers: { 'PAYMENT-REQUIRED': string };
    body: Record<string, never>;
  } {
    return {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': encodeRequirements(requirements),
      },
      body: {},
    };
  }

  /**
   * Verify a payment with the facilitator
   */
  async function verifyPayment(paymentSignatureHeader: string): Promise<VerifyResponse> {
    // We need to know the requirements that were originally sent
    // The payment signature contains the 'accepted' field which should match
    // For now, reconstruct from config
    // In practice, servers should store/pass the original requirements
    
    const accept = await getPaymentAccept({
      amountAtomic: '0', // Will be overwritten by payload
      resourceUrl: '', // Will be overwritten by payload
    });

    return facilitator.verifyPayment(paymentSignatureHeader, accept);
  }

  /**
   * Settle a payment with the facilitator
   */
  async function settlePayment(paymentSignatureHeader: string): Promise<SettleResponse> {
    const accept = await getPaymentAccept({
      amountAtomic: '0', // Will be overwritten by payload
      resourceUrl: '', // Will be overwritten by payload
    });

    return facilitator.settlePayment(paymentSignatureHeader, accept);
  }

  return {
    buildRequirements,
    encodeRequirements,
    create402Response,
    verifyPayment,
    settlePayment,
    getPaymentAccept,
  };
}
