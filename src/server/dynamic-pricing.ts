/**
 * Dynamic Pricing for x402
 *
 * Calculate prices based on input length (characters, tokens, etc.)
 * Perfect for LLM/AI endpoints where cost scales with input size.
 *
 * @example
 * ```typescript
 * import { createDynamicPricing } from '@dexterai/x402/server';
 *
 * const pricing = createDynamicPricing({
 *   unitSize: 1000,      // chars per billing unit
 *   ratePerUnit: 0.01,   // $0.01 per unit
 *   minUsd: 0.01,        // floor
 *   maxUsd: 10.00,       // ceiling (optional)
 * });
 *
 * // Calculate price from input
 * const quote = pricing.calculate(userPrompt);
 * // → { amountAtomic: '23000', usdAmount: 0.023, quoteHash: 'abc...', units: 2.3 }
 *
 * // Validate on retry (prevents prompt manipulation)
 * const isValid = pricing.validateQuote(userPrompt, req.headers['x-quote-hash']);
 * ```
 */

import { createHmac, randomBytes } from 'crypto';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for dynamic pricing
 */
export interface DynamicPricingConfig {
  /**
   * Characters per billing unit.
   * Example: 1000 means every 1000 chars = 1 unit
   */
  unitSize: number;

  /**
   * USD per unit.
   * Example: 0.01 means $0.01 per unit
   */
  ratePerUnit: number;

  /**
   * Minimum USD amount (floor).
   * Recommended: 0.01 (practical minimum for settlement)
   * @default 0.01
   */
  minUsd?: number;

  /**
   * Maximum USD amount (ceiling).
   * Optional - prevents unexpectedly large bills.
   */
  maxUsd?: number;

  /**
   * Rounding mode for unit calculation.
   * - 'ceil': Always round up (fair to seller)
   * - 'floor': Always round down (fair to buyer)
   * - 'round': Standard rounding
   * @default 'ceil'
   */
  roundingMode?: 'ceil' | 'floor' | 'round';

  /**
   * Token decimals for atomic conversion.
   * @default 6 (USDC)
   */
  decimals?: number;
}

/**
 * Price quote returned by calculate()
 */
export interface PriceQuote {
  /** Amount in atomic units (for buildRequirements) */
  amountAtomic: string;

  /** Human-readable USD amount (for display) */
  usdAmount: number;

  /**
   * Quote hash for validation.
   * Includes input + config, so config changes invalidate quotes.
   * Client should send this back as X-Quote-Hash header.
   */
  quoteHash: string;

  /** Number of billing units */
  units: number;

  /** Input length in characters */
  inputLength: number;
}

/**
 * Dynamic pricing calculator
 */
export interface DynamicPricing {
  /** Calculate price from input */
  calculate(input: string): PriceQuote;

  /** Validate quote hash (returns true if valid) */
  validateQuote(input: string, quoteHash: string): boolean;

  /** Get pricing config (for display) */
  readonly config: Required<DynamicPricingConfig>;
}

// ============================================================================
// Implementation
// ============================================================================

/** Max age for a quote before it's considered stale (seconds) */
const QUOTE_MAX_AGE_SECONDS = 300; // 5 minutes

/**
 * Create a dynamic pricing calculator
 */
export function createDynamicPricing(config: DynamicPricingConfig): DynamicPricing {
  const fullConfig: Required<DynamicPricingConfig> = {
    unitSize: config.unitSize,
    ratePerUnit: config.ratePerUnit,
    minUsd: config.minUsd ?? 0.01,
    maxUsd: config.maxUsd ?? Infinity,
    roundingMode: config.roundingMode ?? 'ceil',
    decimals: config.decimals ?? 6,
  };

  const { unitSize, ratePerUnit, minUsd, maxUsd, roundingMode, decimals } = fullConfig;

  // Validate config
  if (unitSize <= 0) throw new Error('unitSize must be positive');
  if (ratePerUnit <= 0) throw new Error('ratePerUnit must be positive');
  if (minUsd < 0) throw new Error('minUsd cannot be negative');
  if (maxUsd < minUsd) throw new Error('maxUsd must be >= minUsd');

  // Per-instance HMAC secret — quotes are only valid for this pricing instance.
  // Config changes (new instance) automatically invalidate old quotes.
  const hmacSecret = randomBytes(32);

  /**
   * Sign a quote with HMAC-SHA256. Includes input, config, and timestamp
   * so quotes are tamper-proof and time-bounded.
   */
  function signQuote(input: string, timestamp: number): string {
    const configStr = JSON.stringify({
      unitSize,
      ratePerUnit,
      minUsd,
      maxUsd: maxUsd === Infinity ? 'none' : maxUsd,
      roundingMode,
    });
    const data = `${input}|${configStr}|${timestamp}`;
    return createHmac('sha256', hmacSecret).update(data).digest('hex').slice(0, 16);
  }

  /**
   * Calculate price from input
   */
  function calculate(input: string): PriceQuote {
    const inputLength = input.length;

    // Calculate units based on rounding mode
    const rawUnits = inputLength / unitSize;
    let units: number;
    switch (roundingMode) {
      case 'ceil':
        units = Math.ceil(rawUnits);
        break;
      case 'floor':
        units = Math.floor(rawUnits);
        break;
      case 'round':
        units = Math.round(rawUnits);
        break;
    }

    // Ensure at least 1 unit if there's any input
    if (inputLength > 0 && units === 0) {
      units = 1;
    }

    // Calculate USD amount
    let usdAmount = units * ratePerUnit;

    // Apply min/max
    usdAmount = Math.max(minUsd, usdAmount);
    usdAmount = Math.min(maxUsd, usdAmount);

    // Convert to atomic units
    const multiplier = Math.pow(10, decimals);
    const amountAtomic = Math.floor(usdAmount * multiplier).toString();

    // Sign quote with HMAC-SHA256 (timestamp-bounded)
    const timestamp = Math.floor(Date.now() / 1000);
    const mac = signQuote(input, timestamp);
    const quoteHash = `${timestamp}.${mac}`;

    return {
      amountAtomic,
      usdAmount,
      quoteHash,
      units,
      inputLength,
    };
  }

  /**
   * Validate quote hash.
   * Verifies HMAC signature and rejects quotes older than QUOTE_MAX_AGE_SECONDS.
   */
  function validateQuote(input: string, quoteHash: string): boolean {
    if (!quoteHash) return false;
    const dotIndex = quoteHash.indexOf('.');
    if (dotIndex === -1) return false;

    const timestamp = parseInt(quoteHash.slice(0, dotIndex), 10);
    const mac = quoteHash.slice(dotIndex + 1);
    if (isNaN(timestamp) || !mac) return false;

    // Reject stale quotes
    const age = Math.floor(Date.now() / 1000) - timestamp;
    if (age < 0 || age > QUOTE_MAX_AGE_SECONDS) return false;

    // Verify HMAC
    const expectedMac = signQuote(input, timestamp);
    // Constant-time comparison to prevent timing attacks
    if (mac.length !== expectedMac.length) return false;
    let mismatch = 0;
    for (let i = 0; i < mac.length; i++) {
      mismatch |= mac.charCodeAt(i) ^ expectedMac.charCodeAt(i);
    }
    return mismatch === 0;
  }

  return {
    calculate,
    validateQuote,
    config: fullConfig,
  };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Format pricing for display
 * Example: "from $0.01 per 1,000 chars"
 */
export function formatPricing(config: DynamicPricingConfig): string {
  const rate = config.ratePerUnit.toFixed(2);
  const units = config.unitSize.toLocaleString();
  return `from $${rate} per ${units} chars`;
}



