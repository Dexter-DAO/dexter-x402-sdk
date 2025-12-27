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

/**
 * Simple hash function (browser-compatible, no crypto needed)
 * Uses FNV-1a for speed and simplicity
 */
function simpleHash(str: string): string {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
  }
  // Convert to hex string
  return (hash >>> 0).toString(16).padStart(8, '0');
}

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

  /**
   * Build hash input string (input + config)
   * Config is included so pricing changes invalidate old quotes
   */
  function buildHashInput(input: string): string {
    const configStr = JSON.stringify({
      unitSize,
      ratePerUnit,
      minUsd,
      maxUsd: maxUsd === Infinity ? 'none' : maxUsd,
      roundingMode,
    });
    return `${input}|${configStr}`;
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

    // Generate quote hash (includes config)
    const quoteHash = simpleHash(buildHashInput(input));

    return {
      amountAtomic,
      usdAmount,
      quoteHash,
      units,
      inputLength,
    };
  }

  /**
   * Validate quote hash
   * Returns true if the hash matches (input + config unchanged)
   */
  function validateQuote(input: string, quoteHash: string): boolean {
    if (!quoteHash) return false;
    const expectedHash = simpleHash(buildHashInput(input));
    return expectedHash === quoteHash;
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



