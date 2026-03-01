/**
 * x402 v2 Server
 *
 * Server-side helpers for accepting x402 payments.
 * Chain-agnostic - works with Solana, Base, and any x402-compatible network.
 *
 * @example
 * ```typescript
 * import { createX402Server } from '@dexterai/x402/server';
 *
 * const server = createX402Server({
 *   payTo: 'YourAddress...',
 *   network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
 * });
 *
 * // Handle 402 responses
 * if (!paymentSignature) {
 *   const requirements = await server.buildRequirements({
 *     amountAtomic: '50000',
 *     resourceUrl: '/api/protected',
 *   });
 *   res.setHeader('PAYMENT-REQUIRED', server.encodeRequirements(requirements));
 *   res.status(402).json({});
 *   return;
 * }
 *
 * // Verify and settle
 * const verify = await server.verifyPayment(paymentSignature);
 * if (!verify.isValid) throw new Error(verify.invalidReason);
 *
 * const settle = await server.settlePayment(paymentSignature);
 * if (!settle.success) throw new Error(settle.errorReason);
 *
 * // Payment successful!
 * res.json({ transaction: settle.transaction });
 * ```
 */

import type {
  PaymentRequired,
  PaymentAccept,
  ResourceInfo,
  AcceptsExtra,
  VerifyResponse,
  SettleResponse,
  PayToContext,
  PayToProvider,
} from '../types';
import {
  SOLANA_MAINNET_NETWORK,
  USDC_MINT,
  DEXTER_FACILITATOR_URL,
} from '../types';
import { FacilitatorClient, type SupportedKind } from './facilitator-client';
import { encodeBase64Json } from '../utils';

// ============================================================================
// Types
// ============================================================================

/**
 * Asset configuration
 */
export interface AssetConfig {
  /** Token address (mint on Solana, contract on EVM) */
  address: string;
  /** Token decimals */
  decimals: number;
}

/**
 * Server configuration
 */
export interface X402ServerConfig {
  /**
   * Address to receive payments, or a dynamic provider function.
   * Use a string for static wallet addresses.
   * Use a PayToProvider (e.g., stripePayTo) for per-request addresses.
   */
  payTo: string | PayToProvider;
  /** Facilitator URL (defaults to Dexter) */
  facilitatorUrl?: string;
  /** CAIP-2 network identifier */
  network?: string;
  /** Asset configuration (defaults to USDC) */
  asset?: AssetConfig;
  /** Default payment timeout in seconds */
  defaultTimeoutSeconds?: number;
}

/**
 * Options for building payment requirements
 */
export interface BuildRequirementsOptions {
  /** Amount in atomic units (e.g., '50000' for 0.05 USDC) */
  amountAtomic: string;
  /** Full URL of the resource */
  resourceUrl: string;
  /** Human-readable description */
  description?: string;
  /** MIME type of the response */
  mimeType?: string;
  /** Override timeout for this request */
  timeoutSeconds?: number;
}

/**
 * x402 Server interface
 */
export interface X402Server {
  /** Build payment requirements (fetches feePayer from facilitator) */
  buildRequirements(options: BuildRequirementsOptions): Promise<PaymentRequired>;

  /** Encode requirements for PAYMENT-REQUIRED header */
  encodeRequirements(requirements: PaymentRequired): string;

  /** Create complete 402 response object */
  create402Response(requirements: PaymentRequired): {
    status: 402;
    headers: { 'PAYMENT-REQUIRED': string };
    body: Record<string, unknown>;
  };

  /** Verify payment with facilitator */
  verifyPayment(
    paymentSignatureHeader: string,
    requirements?: PaymentAccept
  ): Promise<VerifyResponse>;

  /** Settle payment via facilitator */
  settlePayment(
    paymentSignatureHeader: string,
    requirements?: PaymentAccept
  ): Promise<SettleResponse>;

  /** Get PaymentAccept for verify/settle */
  getPaymentAccept(options: BuildRequirementsOptions): Promise<PaymentAccept>;

  /** Get network this server is configured for */
  readonly network: string;

  /** Get facilitator client for advanced usage */
  readonly facilitator: FacilitatorClient;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create an x402 server for accepting payments
 */
export function createX402Server(config: X402ServerConfig): X402Server {
  const {
    payTo,
    facilitatorUrl = DEXTER_FACILITATOR_URL,
    network = SOLANA_MAINNET_NETWORK,
    asset = { address: USDC_MINT, decimals: 6 },
    defaultTimeoutSeconds = 60,
  } = config;

  const facilitator = new FacilitatorClient(facilitatorUrl);

  // Cache for network extra data
  let cachedExtra: SupportedKind['extra'] | null = null;

  /**
   * Resolve payTo to a concrete address.
   * For static strings, returns immediately.
   * For providers (e.g. Stripe), calls the function with context.
   */
  async function resolvePayTo(context?: PayToContext): Promise<string> {
    if (typeof payTo === 'string') return payTo;
    return payTo(context || {});
  }

  /**
   * Get extra data from facilitator (cached)
   */
  async function getNetworkExtra(): Promise<AcceptsExtra> {
    if (!cachedExtra) {
      cachedExtra = await facilitator.getNetworkExtra(network);
    }

    if (!cachedExtra?.feePayer) {
      throw new Error(`Facilitator does not provide feePayer for network "${network}"`);
    }

    return {
      feePayer: cachedExtra.feePayer,
      decimals: cachedExtra.decimals ?? asset.decimals,
      // Include any additional EIP-712 data for EVM chains
      name: cachedExtra.name,
      version: cachedExtra.version,
    };
  }

  /**
   * Build a PaymentAccept with a pre-resolved address (internal helper)
   */
  async function buildPaymentAccept(
    resolvedPayTo: string,
    options: BuildRequirementsOptions,
  ): Promise<PaymentAccept> {
    const {
      amountAtomic,
      timeoutSeconds = defaultTimeoutSeconds,
    } = options;

    const extra = await getNetworkExtra();

    return {
      scheme: 'exact',
      network,
      amount: amountAtomic,
      maxAmountRequired: amountAtomic,
      asset: asset.address,
      payTo: resolvedPayTo,
      maxTimeoutSeconds: timeoutSeconds,
      extra,
    };
  }

  /**
   * Build a PaymentAccept structure (resolves payTo dynamically)
   */
  async function getPaymentAccept(options: BuildRequirementsOptions): Promise<PaymentAccept> {
    const address = await resolvePayTo({
      amountAtomic: options.amountAtomic,
      resourceUrl: options.resourceUrl,
    });
    return buildPaymentAccept(address, options);
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
    return encodeBase64Json(requirements);
  }

  /**
   * Create complete 402 response object
   */
  function create402Response(requirements: PaymentRequired) {
    return {
      status: 402 as const,
      headers: {
        'PAYMENT-REQUIRED': encodeRequirements(requirements),
      },
      body: {},
    };
  }

  /**
   * Verify payment with facilitator.
   * When payTo is dynamic, resolves the address from the payment header.
   */
  async function verifyPayment(
    paymentSignatureHeader: string,
    requirements?: PaymentAccept
  ): Promise<VerifyResponse> {
    if (!requirements) {
      const address = await resolvePayTo({ paymentHeader: paymentSignatureHeader });
      requirements = await buildPaymentAccept(address, { amountAtomic: '0', resourceUrl: '' });
    }

    return facilitator.verifyPayment(paymentSignatureHeader, requirements);
  }

  /**
   * Settle payment via facilitator.
   * When payTo is dynamic, resolves the address from the payment header.
   */
  async function settlePayment(
    paymentSignatureHeader: string,
    requirements?: PaymentAccept
  ): Promise<SettleResponse> {
    if (!requirements) {
      const address = await resolvePayTo({ paymentHeader: paymentSignatureHeader });
      requirements = await buildPaymentAccept(address, { amountAtomic: '0', resourceUrl: '' });
    }

    return facilitator.settlePayment(paymentSignatureHeader, requirements);
  }

  return {
    buildRequirements,
    encodeRequirements,
    create402Response,
    verifyPayment,
    settlePayment,
    getPaymentAccept,
    network,
    facilitator,
  };
}
