/**
 * Express Middleware for x402 Payments
 *
 * One-liner middleware to protect any Express endpoint with x402 payments.
 * Handles the entire flow: 402 response, payment verification, settlement.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { x402Middleware } from '@dexterai/x402/server';
 *
 * const app = express();
 *
 * app.get('/api/protected',
 *   x402Middleware({
 *     payTo: 'YourSolanaAddress...',
 *     amount: '0.01',  // $0.01 USD
 *     network: 'solana:mainnet',
 *   }),
 *   (req, res) => {
 *     // This only runs after successful payment
 *     res.json({ data: 'protected content' });
 *   }
 * );
 * ```
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { PayToProvider } from '../types';
import { createX402Server, type BuildRequirementsOptions } from './x402-server';
import { toAtomicUnits, encodeBase64Json } from '../utils';
import { DEFAULT_NETWORK, USDC_DECIMALS } from '../constants';
import type { SponsoredRecommendation } from '@dexterai/x402-ads-types';
import { getStripeProviderNetwork } from './stripe-payto';

/**
 * Middleware configuration
 */
export interface X402MiddlewareConfig {
  /**
   * Address to receive payments, or a dynamic provider function, or
   * a map of network-specific addresses for multi-chain support.
   *
   * - **Static address**: Pass a Solana pubkey or EVM address string.
   * - **Stripe**: Use `stripePayTo(process.env.STRIPE_SECRET_KEY)` for Base.
   * - **Multi-chain map**: Keys are CAIP-2 networks or globs (`eip155:*`, `*`).
   *
   * @example
   * ```typescript
   * // Single address (works on one network)
   * payTo: '0xYourAddress...'
   *
   * // Stripe on Base, direct wallet on other chains
   * payTo: { 'eip155:8453': stripePayTo(key), '*': '0xYourAddress...' }
   *
   * // Solana + EVM
   * payTo: { 'solana:*': 'SolAddr', 'eip155:*': '0xEvmAddr' }
   * ```
   */
  payTo: string | PayToProvider | Record<string, string | PayToProvider>;

  /**
   * Payment amount in USD (e.g., '0.01' for 1 cent)
   * Will be converted to atomic units automatically.
   */
  amount: string;

  /**
   * CAIP-2 network identifier(s).
   * Pass an array to accept payments on multiple chains simultaneously.
   * The client picks whichever chain it has a wallet for.
   *
   * @default 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' (Solana mainnet)
   *
   * @example
   * ```typescript
   * // Single network
   * network: 'eip155:8453'
   *
   * // Multiple EVM chains (same payTo address works for all)
   * network: ['eip155:8453', 'eip155:137', 'eip155:42161']
   * ```
   */
  network?: string | string[];

  /**
   * Asset to accept
   * @default USDC on the specified network
   */
  asset?: {
    address: string;
    decimals: number;
  };

  /**
   * x402 facilitator URL
   * @default 'https://x402.dexter.cash'
   */
  facilitatorUrl?: string;

  /**
   * Resource description (shown to users)
   */
  description?: string;

  /**
   * Resource URL override
   * By default, uses the full request URL
   */
  resourceUrl?: string;

  /**
   * MIME type of the response
   */
  mimeType?: string;

  /**
   * Payment timeout in seconds
   * @default 120
   */
  timeoutSeconds?: number;

  /**
   * Enable verbose logging
   */
  verbose?: boolean;

  /**
   * Custom function to get resource URL from request
   * Useful for dynamic routing
   */
  getResourceUrl?: (req: Request) => string;

  /**
   * Custom function to get amount from request
   * Useful for dynamic pricing based on request body/params
   */
  getAmount?: (req: Request) => string;

  /**
   * Custom function to get description from request
   */
  getDescription?: (req: Request) => string;

  /**
   * Enable sponsored-access recommendation delivery.
   *
   * When true, the middleware reads `extensions["sponsored-access"]` from the
   * facilitator's SettlementResponse and injects the recommendations into the
   * JSON response body as a `_x402_sponsored` field. This is the only way
   * recommendations reach the agent's LLM (headers and receipt metadata are
   * not visible to LLMs).
   *
   * Pass `true` for default injection, or an object with a custom `inject`
   * function for full control over how recommendations appear in the response.
   *
   * @default false (off, no injection)
   *
   * @example Default injection
   * ```typescript
   * x402Middleware({ payTo: '...', amount: '0.05', sponsoredAccess: true })
   * // Agent receives: { _x402_sponsored: [...], ...originalResponse }
   * ```
   *
   * @example Custom injection
   * ```typescript
   * x402Middleware({
   *   payTo: '...', amount: '0.05',
   *   sponsoredAccess: {
   *     inject: (body, recs) => ({ ...body, related_tools: recs })
   *   }
   * })
   * ```
   */
  sponsoredAccess?: boolean | {
    /** Custom injection function. Receives the original response body and typed recommendations. */
    inject?: (body: unknown, recommendations: SponsoredRecommendation[]) => unknown;
    /** Called when sponsored recommendations are matched for a settlement. */
    onMatch?: (recommendations: SponsoredRecommendation[], settlement: { transaction: string; network: string; payer: string }) => void;
  };

  /**
   * Called after a payment is successfully settled.
   * Use for logging, analytics, webhooks, or side effects.
   * Errors in this callback do not affect the response.
   *
   * @example
   * ```typescript
   * x402Middleware({
   *   payTo: '...', amount: '0.01',
   *   onSettlement: (info) => {
   *     console.log(`Payment: ${info.transaction} from ${info.payer} on ${info.network}`);
   *   },
   * })
   * ```
   */
  onSettlement?: (info: { transaction: string; network: string; payer: string; resourceUrl: string }) => void | Promise<void>;

  /**
   * Called when payment verification fails.
   * Use for monitoring suspicious activity or debugging payment issues.
   * Errors in this callback do not affect the response.
   */
  onVerifyFailed?: (info: { reason?: string; resourceUrl: string }) => void | Promise<void>;
}

/**
 * Extended request with payment info
 */
export interface X402Request extends Request {
  /**
   * Payment information (only present after successful payment)
   */
  x402?: {
    /** Transaction signature/hash */
    transaction: string;
    /** Payer address */
    payer: string;
    /** Network used */
    network: string;
  };
}

/**
 * Create x402 middleware for Express
 *
 * @param config - Middleware configuration
 * @returns Express middleware function
 */
/**
 * Resolve a payTo value for a specific network from the config.
 * Supports: string, PayToProvider, or Record with glob matching.
 */
function resolvePayToForNetwork(
  payTo: string | PayToProvider | Record<string, string | PayToProvider>,
  network: string,
): string | PayToProvider {
  if (typeof payTo === 'string' || typeof payTo === 'function') return payTo;

  // Exact match first
  if (network in payTo) return payTo[network];

  // Prefix glob: 'eip155:*' matches 'eip155:8453'
  const prefix = network.split(':')[0];
  const globKey = `${prefix}:*`;
  if (globKey in payTo) return payTo[globKey];

  // Default fallback
  if ('*' in payTo) return payTo['*'];

  throw new Error(`No payTo configured for network "${network}"`);
}

export function x402Middleware(config: X402MiddlewareConfig): RequestHandler {
  const {
    payTo,
    amount,
    asset,
    description,
    resourceUrl: staticResourceUrl,
    mimeType,
    timeoutSeconds,
    verbose = false,
    getResourceUrl,
    getAmount,
    getDescription,
  } = config;

  const log = verbose
    ? console.log.bind(console, '[x402:middleware]')
    : () => {};

  // Resolve networks: single string, array, or inferred from provider defaults
  const singleProviderDefaults = (typeof payTo === 'function') ? payTo._x402Defaults : undefined;
  const facilitatorUrl = config.facilitatorUrl ?? singleProviderDefaults?.facilitatorUrl;

  const configuredNetworks: string[] = (() => {
    if (config.network) {
      return Array.isArray(config.network) ? config.network : [config.network];
    }
    if (singleProviderDefaults?.network) return [singleProviderDefaults.network];
    return [DEFAULT_NETWORK];
  })();

  // Create one server per network (reused across requests)
  const servers = new Map<string, ReturnType<typeof createX402Server>>();
  for (const net of configuredNetworks) {
    const netPayTo = resolvePayToForNetwork(payTo, net);

    // Guard: Stripe payTo only supports Base — throw early if misconfigured
    if (typeof netPayTo === 'function') {
      const stripeNet = getStripeProviderNetwork(netPayTo as PayToProvider);
      if (stripeNet && net !== stripeNet) {
        throw new Error(
          `stripePayTo is configured for "${stripeNet}" but middleware includes network "${net}". ` +
          `Stripe only supports Base deposit addresses. Use a static payTo for other chains.`
        );
      }
    }

    servers.set(net, createX402Server({
      payTo: netPayTo,
      network: net,
      asset,
      facilitatorUrl,
      defaultTimeoutSeconds: timeoutSeconds,
    }));
  }

  // Primary server for verify/settle when we can't determine network from header
  const primaryServer = servers.get(configuredNetworks[0])!;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Check for payment signature
      const paymentSignature = req.headers['payment-signature'] as string | undefined;

      if (!paymentSignature) {
        // No payment - return 402
        log('No payment signature, returning 402');

        // Build resource URL
        const resourceUrl = getResourceUrl?.(req) 
          ?? staticResourceUrl 
          ?? `${req.protocol}://${req.get('host')}${req.originalUrl}`;

        // Get dynamic values
        const requestAmount = getAmount?.(req) ?? amount;
        const requestDescription = getDescription?.(req) ?? description;

        // Convert USD to atomic units
        const decimals = asset?.decimals ?? USDC_DECIMALS;
        const amountAtomic = toAtomicUnits(parseFloat(requestAmount), decimals);

        const requirementsOptions: BuildRequirementsOptions = {
          amountAtomic,
          resourceUrl,
          description: requestDescription,
          mimeType,
          timeoutSeconds,
        };

        // Build requirements from all network servers and merge accepts arrays
        const allAccepts: import('../types').PaymentAccept[] = [];
        let requirements: import('../types').PaymentRequired | null = null;
        for (const [, srv] of servers) {
          try {
            const reqs = await srv.buildRequirements(requirementsOptions);
            allAccepts.push(...reqs.accepts);
            if (!requirements) requirements = reqs;
          } catch (e) {
            log('Failed to build requirements for a network:', e);
          }
        }
        if (!requirements || allAccepts.length === 0) {
          res.status(500).json({ error: 'Failed to build payment requirements' });
          return;
        }
        requirements = { ...requirements, accepts: allAccepts };
        const encoded = primaryServer.encodeRequirements(requirements);

        res.setHeader('PAYMENT-REQUIRED', encoded);
        res.status(402).json({
          error: 'Payment required',
          accepts: requirements.accepts,
          resource: requirements.resource,
        });
        return;
      }

      // Payment signature present - verify and settle.
      // Determine which network server to use from the payment header.
      log('Payment signature received, verifying...');

      let targetServer = primaryServer;
      try {
        const decoded = JSON.parse(Buffer.from(paymentSignature, 'base64').toString());
        const paymentNetwork = decoded?.accepted?.network as string | undefined;
        if (paymentNetwork && servers.has(paymentNetwork)) {
          targetServer = servers.get(paymentNetwork)!;
        }
      } catch {
        // Fall through to primary server
      }

      const verifyResult = await targetServer.verifyPayment(paymentSignature);
      
      if (!verifyResult.isValid) {
        log('Payment verification failed:', verifyResult.invalidReason);
        if (config.onVerifyFailed) {
          try {
            await config.onVerifyFailed({
              reason: verifyResult.invalidReason,
              resourceUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
            });
          } catch {}
        }
        res.status(402).json({
          error: 'Payment verification failed',
          reason: verifyResult.invalidReason,
        });
        return;
      }

      log('Payment verified, settling...');

      const settleResult = await targetServer.settlePayment(paymentSignature);

      if (!settleResult.success) {
        log('Payment settlement failed:', settleResult.errorReason);
        res.status(402).json({
          error: 'Payment settlement failed',
          reason: settleResult.errorReason,
        });
        return;
      }

      log('Payment settled:', settleResult.transaction);

      const settledNetwork = settleResult.network || configuredNetworks[0];

      if (config.onSettlement) {
        try {
          await config.onSettlement({
            transaction: settleResult.transaction!,
            network: settledNetwork,
            payer: verifyResult.payer ?? '',
            resourceUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
          });
        } catch {}
      }

      // Attach payment info to request
      (req as X402Request).x402 = {
        transaction: settleResult.transaction!,
        payer: verifyResult.payer ?? '',
        network: settledNetwork,
      };

      // Set PAYMENT-RESPONSE header per x402 v2 spec
      const paymentResponseData: Record<string, unknown> = {
        success: true,
        transaction: settleResult.transaction!,
        network: settledNetwork,
        payer: verifyResult.payer ?? '',
      };
      if (settleResult.extensions) {
        paymentResponseData.extensions = settleResult.extensions;
      }
      res.setHeader('PAYMENT-RESPONSE', encodeBase64Json(paymentResponseData));

      // Sponsored Access: inject recommendations into the response body
      // so the agent's LLM actually sees them (headers are invisible to LLMs)
      if (config.sponsoredAccess && settleResult.extensions?.["sponsored-access"]) {
        const extData = settleResult.extensions["sponsored-access"] as
          { info?: { recommendations?: SponsoredRecommendation[] }; recommendations?: SponsoredRecommendation[] } | undefined;
        // Facilitator may nest under .info.recommendations or .recommendations directly
        const recs = extData?.info?.recommendations ?? extData?.recommendations;
        if (recs && recs.length > 0) {
          log('Injecting sponsored-access recommendations into response');

          // Notify callback if configured
          if (typeof config.sponsoredAccess === 'object' && config.sponsoredAccess.onMatch) {
            try {
              config.sponsoredAccess.onMatch(recs, {
                transaction: settleResult.transaction!,
                network: settledNetwork,
                payer: verifyResult.payer ?? '',
              });
            } catch {
              // Don't block response for callback errors
            }
          }

          const originalJson = res.json.bind(res);
          res.json = function patchedJson(body: unknown) {
            if (typeof config.sponsoredAccess === 'object' && config.sponsoredAccess.inject) {
              return originalJson(config.sponsoredAccess.inject(body, recs));
            }
            if (body && typeof body === 'object' && !Array.isArray(body)) {
              return originalJson({ _x402_sponsored: recs, ...(body as Record<string, unknown>) });
            }
            return originalJson(body);
          } as typeof res.json;
        }
      }

      // Continue to actual handler
      next();
    } catch (error) {
      log('Middleware error:', error);

      // Don't expose internal details to clients
      res.status(500).json({
        error: 'Payment processing error',
      });
    }
  };
}
