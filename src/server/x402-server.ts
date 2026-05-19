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
import { USDC_ADDRESSES, BSC_STABLECOIN_ADDRESSES } from '../constants';
import { FacilitatorClient, type SupportedKind } from './facilitator-client';
import { encodeBase64Json, decodeBase64Json, isSolanaNetwork } from '../utils';

/**
 * Resolve the default payment asset (USDC) for a CAIP-2 network.
 *
 * The Dexter facilitator settles USDC on every supported chain, but USDC
 * lives at a different contract on each one — and on BSC it has 18 decimals,
 * not the 6 it uses everywhere else. When a caller passes a multi-chain
 * `network` array without an explicit `asset`, each per-network gate must
 * resolve its OWN chain's USDC; using one chain's mint for all of them
 * tells a paying agent to send a token that does not exist on its chain.
 *
 * Returns the Solana USDC mint for Solana networks (and as a final fallback),
 * the per-chain USDC contract for known EVM chains, with BSC's 18 decimals
 * applied. The facilitator's `getNetworkExtra` can still override `decimals`
 * downstream; the address is what only this map can supply.
 */
export function resolveDefaultAsset(network: string): { address: string; decimals: number } {
  if (isSolanaNetwork(network)) {
    return { address: USDC_MINT, decimals: 6 };
  }
  const evmUsdc = USDC_ADDRESSES[network];
  if (evmUsdc) {
    const decimals = BSC_STABLECOIN_ADDRESSES[evmUsdc]?.decimals ?? 6;
    return { address: evmUsdc, decimals };
  }
  // Unknown network — fall back to the Solana mint (legacy behaviour).
  // A network the SDK has no USDC address for is misconfiguration; the
  // facilitator will reject settlement rather than mis-settle.
  return { address: USDC_MINT, decimals: 6 };
}

/**
 * Best-effort extraction of amount from a PAYMENT-SIGNATURE header.
 * Used as a fallback when the requirements cache misses (e.g., server restart
 * between initial 402 and retry). Returns the accepted amount or undefined.
 */
function extractAmountFromHeader(paymentSignatureHeader: string): string | undefined {
  try {
    const decoded = decodeBase64Json<{
      accepted?: { amount?: string; maxAmountRequired?: string };
    }>(paymentSignatureHeader);
    return decoded?.accepted?.amount ?? decoded?.accepted?.maxAmountRequired;
  } catch {
    return undefined;
  }
}

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
  /**
   * Payment scheme to advertise. 'batch-settlement' is the EVM escrow-channel
   * batching scheme (discrete API purchases, gas-amortized) — see
   * @dexterai/x402/batch-settlement. Default: 'exact'.
   */
  scheme?: 'exact' | 'batch-settlement';
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

  /**
   * Decimals of the payment asset on THIS server's network. USDC is 6
   * decimals on every supported chain except BSC, where it is 18. The
   * multi-chain middleware reads this to convert the USD price into the
   * correct atomic amount per network.
   */
  readonly assetDecimals: number;

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
    defaultTimeoutSeconds = 60,
  } = config;

  // When the caller passes no explicit `asset`, default to USDC *on this
  // server's network* — not a hardcoded Solana mint. createX402Server is
  // built per-network (the multi-chain middleware spins one up per chain),
  // so `network` here is always a single concrete chain.
  const asset = config.asset ?? resolveDefaultAsset(network);

  const scheme = config.scheme ?? 'exact';

  const facilitator = new FacilitatorClient(facilitatorUrl);

  // Cache for network extra data
  let cachedExtra: SupportedKind['extra'] | null = null;

  // Requirements cache: payTo address -> PaymentAccept + expiry.
  // Populated by buildRequirements/getPaymentAccept, consumed by verify/settle.
  // Prevents the bug where verify/settle fabricates requirements with amount '0'.
  // Parallels the SettlementCache pattern from coinbase/x402.
  const requirementsCache = new Map<string, { accept: PaymentAccept; expiresAt: number }>();
  const CACHE_PRUNE_INTERVAL = 30_000;
  let lastPrune = Date.now();

  function cacheRequirements(accept: PaymentAccept): void {
    const ttl = (accept.maxTimeoutSeconds || defaultTimeoutSeconds) * 1000;
    requirementsCache.set(accept.payTo, { accept, expiresAt: Date.now() + ttl });

    if (Date.now() - lastPrune > CACHE_PRUNE_INTERVAL) {
      const now = Date.now();
      for (const [key, entry] of requirementsCache) {
        if (entry.expiresAt < now) requirementsCache.delete(key);
      }
      lastPrune = now;
    }
  }

  function getCachedRequirements(address: string): PaymentAccept | undefined {
    const entry = requirementsCache.get(address);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      requirementsCache.delete(address);
      return undefined;
    }
    return entry.accept;
  }

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

    const isSvm = isSolanaNetwork(network);

    if (isSvm && !cachedExtra?.feePayer) {
      throw new Error(`Facilitator does not provide feePayer for network "${network}"`);
    }

    return {
      ...(cachedExtra?.feePayer ? { feePayer: cachedExtra.feePayer } : {}),
      decimals: cachedExtra?.decimals ?? asset.decimals,
      name: cachedExtra?.name,
      version: cachedExtra?.version,
      // batch-settlement: surface the facilitator's on-chain authorizer so the
      // buyer's channel pays into the right contract.
      ...(scheme === 'batch-settlement' && cachedExtra?.receiverAuthorizer
        ? { receiverAuthorizer: cachedExtra.receiverAuthorizer as string }
        : {}),
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

    const accept: PaymentAccept = {
      scheme,
      network,
      amount: amountAtomic,
      maxAmountRequired: amountAtomic,
      asset: asset.address,
      payTo: resolvedPayTo,
      maxTimeoutSeconds: timeoutSeconds,
      extra,
    };

    cacheRequirements(accept);
    return accept;
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
   * Resolves requirements from cache (populated by buildRequirements),
   * falling back to the payment header for the payTo address.
   */
  async function verifyPayment(
    paymentSignatureHeader: string,
    requirements?: PaymentAccept
  ): Promise<VerifyResponse> {
    if (!requirements) {
      const address = await resolvePayTo({ paymentHeader: paymentSignatureHeader });
      requirements = getCachedRequirements(address);
      if (!requirements) {
        // Fallback: rebuild with amount from payment header if possible
        requirements = await buildPaymentAccept(address, {
          amountAtomic: extractAmountFromHeader(paymentSignatureHeader) ?? '0',
          resourceUrl: '',
        });
      }
    }

    return facilitator.verifyPayment(paymentSignatureHeader, requirements);
  }

  /**
   * Settle payment via facilitator.
   * Resolves requirements from cache (populated by buildRequirements),
   * falling back to the payment header for the payTo address.
   */
  async function settlePayment(
    paymentSignatureHeader: string,
    requirements?: PaymentAccept
  ): Promise<SettleResponse> {
    if (!requirements) {
      const address = await resolvePayTo({ paymentHeader: paymentSignatureHeader });
      requirements = getCachedRequirements(address);
      if (!requirements) {
        requirements = await buildPaymentAccept(address, {
          amountAtomic: extractAmountFromHeader(paymentSignatureHeader) ?? '0',
          resourceUrl: '',
        });
      }
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
    assetDecimals: asset.decimals,
    facilitator,
  };
}
