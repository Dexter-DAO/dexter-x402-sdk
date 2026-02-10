/**
 * x402 Access Pass Middleware
 *
 * Pay once, get a time-limited JWT for unlimited API requests.
 * Supports both predefined tiers and custom durations.
 *
 * @example Tier-based pricing
 * ```typescript
 * app.use('/api', x402AccessPass({
 *   payTo: 'YourSolanaAddress...',
 *   tiers: {
 *     '1h':  '0.50',   // $0.50 for 1 hour
 *     '24h': '2.00',   // $2.00 for 24 hours
 *   },
 * }));
 * ```
 *
 * @example Rate-based custom durations
 * ```typescript
 * app.use('/api', x402AccessPass({
 *   payTo: 'YourSolanaAddress...',
 *   ratePerHour: '0.50',  // $0.50/hour, any duration
 * }));
 * ```
 *
 * @example Both tiers and custom durations
 * ```typescript
 * app.use('/api', x402AccessPass({
 *   payTo: 'YourSolanaAddress...',
 *   tiers: { '1h': '0.50', '24h': '2.00' },
 *   ratePerHour: '0.50',  // fallback for custom durations
 * }));
 * ```
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createX402Server } from './x402-server';
import { toAtomicUnits, encodeBase64Json } from '../utils';
import type { AccessPassTier, AccessPassInfo, AccessPassClaims } from '../types';
import crypto from 'crypto';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Access pass middleware configuration
 */
export interface X402AccessPassConfig {
  /** Address to receive payments (Solana pubkey or EVM address) */
  payTo: string;

  /** CAIP-2 network identifier @default 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' */
  network?: string;

  /** x402 facilitator URL @default 'https://x402-facilitator.dexter.cash' */
  facilitatorUrl?: string;

  /** Asset config @default USDC on specified network */
  asset?: { address: string; decimals: number };

  /**
   * Predefined pricing tiers.
   * Keys are tier IDs (e.g., '5m', '1h', '24h').
   * Values are prices in USD (e.g., '0.50').
   * Duration is parsed from the ID: '5m' = 5 minutes, '1h' = 1 hour, '24h' = 24 hours, '7d' = 7 days.
   */
  tiers?: Record<string, string>;

  /**
   * Rate per hour in USD for custom durations.
   * When set, buyers can request any duration via ?duration=<seconds> query param.
   */
  ratePerHour?: string;

  /** HMAC secret for JWT signing. Auto-generated if not provided. */
  secret?: Buffer;

  /** Issuer string for JWT 'iss' claim @default 'x402-access-pass' */
  issuer?: string;

  /** Enable verbose logging */
  verbose?: boolean;

  /** Description shown in 402 response */
  description?: string;
}

/**
 * Extended request with access pass info
 */
export interface X402AccessPassRequest extends Request {
  /** Access pass info (present when request is authenticated via valid pass) */
  accessPass?: {
    tier: string;
    duration: number;
    expiresAt: string;
    payer: string;
    network: string;
  };
  /** x402 payment info (present when a new pass was just purchased) */
  x402?: {
    transaction: string;
    payer: string;
    network: string;
  };
}

// ============================================================================
// Duration Parsing
// ============================================================================

const DURATION_REGEX = /^(\d+)(m|h|d|w)$/;

function parseTierDuration(tierId: string): number | null {
  const match = tierId.match(DURATION_REGEX);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    case 'w': return value * 604800;
    default: return null;
  }
}

function formatDuration(seconds: number): string {
  if (seconds >= 604800 && seconds % 604800 === 0) return `${seconds / 604800} week${seconds / 604800 > 1 ? 's' : ''}`;
  if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400} day${seconds / 86400 > 1 ? 's' : ''}`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} hour${seconds / 3600 > 1 ? 's' : ''}`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} minute${seconds / 60 > 1 ? 's' : ''}`;
  return `${seconds} second${seconds > 1 ? 's' : ''}`;
}

// ============================================================================
// JWT Helpers (built-in crypto, no external deps)
// ============================================================================

function signJwt(payload: AccessPassClaims, secret: Buffer): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token: string, secret: Buffer): AccessPassClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, body, sig] = parts;
    const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    if (sig !== expected) return null;

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as AccessPassClaims;

    // Check expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;

    // Validate sub
    if (payload.sub !== 'x402-access-pass') return null;

    return payload;
  } catch {
    return null;
  }
}

// ============================================================================
// Middleware Factory
// ============================================================================

const DEFAULT_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_DECIMALS = 6;

/**
 * Create x402 access pass middleware for Express.
 *
 * Protects routes with time-limited access passes purchased via x402 payments.
 * Supports predefined tiers, custom durations, or both.
 */
export function x402AccessPass(config: X402AccessPassConfig): RequestHandler {
  const {
    payTo,
    network = DEFAULT_NETWORK,
    asset,
    facilitatorUrl,
    tiers: tierPrices,
    ratePerHour,
    secret = crypto.randomBytes(32),
    issuer = 'x402-access-pass',
    verbose = false,
    description,
  } = config;

  // Validate config
  if (!tierPrices && !ratePerHour) {
    throw new Error('x402AccessPass: at least one of `tiers` or `ratePerHour` is required');
  }

  const log = verbose
    ? console.log.bind(console, '[x402:access-pass]')
    : () => {};

  const decimals = asset?.decimals ?? USDC_DECIMALS;

  // Build tier definitions
  const builtTiers: AccessPassTier[] = [];

  if (tierPrices) {
    for (const [id, price] of Object.entries(tierPrices)) {
      const seconds = parseTierDuration(id);
      if (!seconds) {
        console.warn(`x402AccessPass: skipping tier "${id}" — unrecognized duration format (use 5m, 1h, 24h, 7d)`);
        continue;
      }
      builtTiers.push({
        id,
        label: formatDuration(seconds),
        seconds,
        price,
        priceAtomic: toAtomicUnits(parseFloat(price), decimals),
      });
    }
    // Sort by duration ascending
    builtTiers.sort((a, b) => a.seconds - b.seconds);
  }

  // Create x402 server instance (reused across requests)
  const server = createX402Server({
    payTo,
    network,
    asset,
    facilitatorUrl,
  });

  // Build access pass info for X-ACCESS-PASS-TIERS header
  const passInfo: AccessPassInfo = {
    tiers: builtTiers.length > 0 ? builtTiers : undefined,
    ratePerHour: ratePerHour || undefined,
    issuer,
  };
  const passInfoEncoded = encodeBase64Json(passInfo);

  /**
   * Calculate price for a custom duration in seconds
   */
  function calculateCustomPrice(durationSeconds: number): { price: string; priceAtomic: string } {
    if (!ratePerHour) {
      throw new Error('Custom durations not supported — no ratePerHour configured');
    }
    const hours = durationSeconds / 3600;
    const price = (parseFloat(ratePerHour) * hours).toFixed(decimals > 4 ? 4 : 2);
    return { price, priceAtomic: toAtomicUnits(parseFloat(price), decimals) };
  }

  /**
   * Resolve tier/duration from request query params
   */
  function resolvePricing(req: Request): {
    tier: string;
    seconds: number;
    price: string;
    priceAtomic: string;
    label: string;
  } {
    const tierParam = req.query.tier as string | undefined;
    const durationParam = req.query.duration as string | undefined;

    // Explicit tier
    if (tierParam) {
      const found = builtTiers.find(t => t.id === tierParam);
      if (found) {
        return { tier: found.id, seconds: found.seconds, price: found.price, priceAtomic: found.priceAtomic, label: found.label };
      }
    }

    // Custom duration
    if (durationParam) {
      const seconds = parseInt(durationParam, 10);
      if (seconds > 0 && ratePerHour) {
        const pricing = calculateCustomPrice(seconds);
        return { tier: 'custom', seconds, ...pricing, label: formatDuration(seconds) };
      }
    }

    // Default: cheapest tier or 1h
    if (builtTiers.length > 0) {
      const t = builtTiers[0];
      return { tier: t.id, seconds: t.seconds, price: t.price, priceAtomic: t.priceAtomic, label: t.label };
    }

    // Rate-only: default to 1 hour
    const pricing = calculateCustomPrice(3600);
    return { tier: 'custom', seconds: 3600, ...pricing, label: '1 hour' };
  }

  // --------------------------------------------------------------------------
  // Middleware handler
  // --------------------------------------------------------------------------
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // ── Step 1: Check for valid access pass JWT ──
      const auth = req.headers.authorization;
      if (auth?.startsWith('Bearer ')) {
        const claims = verifyJwt(auth.slice(7), secret);
        if (claims) {
          log('Valid access pass:', claims.tier, '| expires:', new Date(claims.exp * 1000).toISOString());
          (req as X402AccessPassRequest).accessPass = {
            tier: claims.tier,
            duration: claims.duration,
            expiresAt: new Date(claims.exp * 1000).toISOString(),
            payer: claims.payer,
            network: claims.network,
          };
          return next();
        }
        log('Invalid or expired access pass token');
      }

      // ── Step 2: Check for x402 payment signature (pass purchase) ──
      const paymentSignature = req.headers['payment-signature'] as string | undefined;

      if (paymentSignature) {
        log('Payment signature received, verifying for pass purchase...');

        // Verify payment
        const verifyResult = await server.verifyPayment(paymentSignature);
        if (!verifyResult.isValid) {
          log('Payment verification failed:', verifyResult.invalidReason);
          res.status(402).json({ error: 'Payment verification failed', reason: verifyResult.invalidReason });
          return;
        }

        // Settle payment
        const settleResult = await server.settlePayment(paymentSignature);
        if (!settleResult.success) {
          log('Payment settlement failed:', settleResult.errorReason);
          res.status(402).json({ error: 'Payment settlement failed', reason: settleResult.errorReason });
          return;
        }

        log('Payment settled:', settleResult.transaction);

        // Determine tier/duration
        const pricing = resolvePricing(req);

        // Issue JWT
        const now = Math.floor(Date.now() / 1000);
        const claims: AccessPassClaims = {
          sub: 'x402-access-pass',
          tier: pricing.tier,
          duration: pricing.seconds,
          iat: now,
          exp: now + pricing.seconds,
          payer: verifyResult.payer ?? '',
          network,
          iss: issuer,
        };
        const jwt = signJwt(claims, secret);

        // Set x402 payment info on request
        (req as X402AccessPassRequest).x402 = {
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
        res.setHeader('PAYMENT-RESPONSE', encodeBase64Json(paymentResponseData));

        // Set ACCESS-PASS header with the JWT
        res.setHeader('ACCESS-PASS', jwt);

        // Return pass details
        res.json({
          accessPass: {
            token: jwt,
            tier: pricing.tier,
            duration: pricing.label,
            durationSeconds: pricing.seconds,
            expiresAt: new Date((now + pricing.seconds) * 1000).toISOString(),
            usage: 'Include on subsequent requests as: Authorization: Bearer <token>',
          },
          transaction: settleResult.transaction,
          payer: verifyResult.payer,
        });
        return;
      }

      // ── Step 3: No pass, no payment — return 402 ──
      log('No access pass or payment, returning 402');

      const pricing = resolvePricing(req);
      const amountAtomic = pricing.priceAtomic;
      const resourceUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

      const requirements = await server.buildRequirements({
        amountAtomic,
        resourceUrl,
        description: description || `Access pass: ${pricing.label}`,
        mimeType: 'application/json',
      });

      const encoded = server.encodeRequirements(requirements);

      res.setHeader('PAYMENT-REQUIRED', encoded);
      res.setHeader('X-ACCESS-PASS-TIERS', passInfoEncoded);

      res.status(402).json({
        error: 'Access pass required',
        message: 'Purchase an access pass to unlock unlimited API access for a time window.',
        accepts: requirements.accepts,
        resource: requirements.resource,
        accessPass: {
          tiers: builtTiers.length > 0 ? builtTiers : undefined,
          ratePerHour: ratePerHour || undefined,
          usage: 'Add ?tier=<id> or ?duration=<seconds> to your payment request to choose a pass duration.',
        },
      });
    } catch (error) {
      log('Access pass middleware error:', error);
      res.status(500).json({
        error: 'Payment processing error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };
}
