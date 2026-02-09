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
import { createX402Server, type BuildRequirementsOptions } from './x402-server';
import { toAtomicUnits } from '../utils';

/**
 * Middleware configuration
 */
export interface X402MiddlewareConfig {
  /**
   * Address to receive payments (Solana pubkey or EVM address)
   */
  payTo: string;

  /**
   * Payment amount in USD (e.g., '0.01' for 1 cent)
   * Will be converted to atomic units automatically.
   */
  amount: string;

  /**
   * CAIP-2 network identifier
   * @default 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' (Solana mainnet)
   */
  network?: string;

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
   * @default 'https://x402-facilitator.dexter.cash'
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

// Default network
const DEFAULT_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

// USDC decimals
const USDC_DECIMALS = 6;

/**
 * Create x402 middleware for Express
 *
 * @param config - Middleware configuration
 * @returns Express middleware function
 */
export function x402Middleware(config: X402MiddlewareConfig): RequestHandler {
  const {
    payTo,
    amount,
    network = DEFAULT_NETWORK,
    asset,
    facilitatorUrl,
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

  // Create server instance (reused across requests)
  const server = createX402Server({
    payTo,
    network,
    asset,
    facilitatorUrl,
    defaultTimeoutSeconds: timeoutSeconds,
  });

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

        const requirements = await server.buildRequirements(requirementsOptions);
        const encoded = server.encodeRequirements(requirements);

        res.setHeader('PAYMENT-REQUIRED', encoded);
        res.status(402).json({
          error: 'Payment required',
          accepts: requirements.accepts,
          resource: requirements.resource,
        });
        return;
      }

      // Payment signature present - verify and settle
      log('Payment signature received, verifying...');

      // Verify payment
      const verifyResult = await server.verifyPayment(paymentSignature);
      
      if (!verifyResult.isValid) {
        log('Payment verification failed:', verifyResult.invalidReason);
        res.status(402).json({
          error: 'Payment verification failed',
          reason: verifyResult.invalidReason,
        });
        return;
      }

      log('Payment verified, settling...');

      // Settle payment
      const settleResult = await server.settlePayment(paymentSignature);

      if (!settleResult.success) {
        log('Payment settlement failed:', settleResult.errorReason);
        res.status(402).json({
          error: 'Payment settlement failed',
          reason: settleResult.errorReason,
        });
        return;
      }

      log('Payment settled:', settleResult.transaction);

      // Attach payment info to request
      (req as X402Request).x402 = {
        transaction: settleResult.transaction!,
        payer: verifyResult.payer ?? '',
        network,
      };

      // Set PAYMENT-RESPONSE header per x402 v2 spec
      const paymentResponseData = {
        success: true,
        transaction: settleResult.transaction!,
        network,
        payer: verifyResult.payer ?? '',
      };
      res.setHeader('PAYMENT-RESPONSE', btoa(JSON.stringify(paymentResponseData)));

      // Continue to actual handler
      next();
    } catch (error) {
      log('Middleware error:', error);
      
      // Don't expose internal errors
      res.status(500).json({
        error: 'Payment processing error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };
}
