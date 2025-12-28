/**
 * Token-Based Pricing for x402
 *
 * Accurate LLM pricing using tiktoken for token counting.
 * Uses real OpenAI model rates for precise cost calculation.
 *
 * @example
 * ```typescript
 * import { createTokenPricing, MODEL_PRICING } from '@dexterai/x402/server';
 *
 * const pricing = createTokenPricing({
 *   model: 'gpt-4o-mini',
 *   // Optional overrides:
 *   // minUsd: 0.001,
 *   // maxUsd: 50.0,
 * });
 *
 * // Calculate price from input
 * const quote = pricing.calculate(userPrompt);
 * // → { amountAtomic: '1500', usdAmount: 0.0015, inputTokens: 100, quoteHash: 'abc...' }
 *
 * // Validate on retry (prevents prompt manipulation)
 * const isValid = pricing.validateQuote(userPrompt, req.headers['x-quote-hash']);
 * ```
 */

import { createHash } from 'crypto';
import { encoding_for_model, get_encoding, type TiktokenModel } from 'tiktoken';

// ============================================================================
// Model Pricing Table
// ============================================================================

/**
 * Pricing info for a model
 */
export interface ModelPricing {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cached input tokens (optional) */
  cached?: number;
  /** Default max output tokens for this model */
  maxTokens: number;
  /** Pricing tier */
  tier: 'fast' | 'standard' | 'reasoning' | 'premium';
}

/**
 * OpenAI Model Pricing - USD per million tokens
 * Updated: December 2024
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // === FAST TIER (cheapest, fastest) ===
  'gpt-4o-mini': { 
    input: 0.15, output: 0.6, cached: 0.075, 
    maxTokens: 4096, tier: 'fast' 
  },
  'gpt-4.1-mini': { 
    input: 0.4, output: 1.6, cached: 0.1, 
    maxTokens: 4096, tier: 'fast' 
  },
  'gpt-4.1-nano': { 
    input: 0.1, output: 0.4, cached: 0.025, 
    maxTokens: 4096, tier: 'fast' 
  },
  'gpt-5-nano': { 
    input: 0.05, output: 0.4, cached: 0.005, 
    maxTokens: 4096, tier: 'fast' 
  },
  'gpt-5-mini': { 
    input: 0.25, output: 2.0, cached: 0.025, 
    maxTokens: 8192, tier: 'fast' 
  },

  // === STANDARD TIER (balanced) ===
  'gpt-4o': { 
    input: 2.5, output: 10.0, cached: 1.25, 
    maxTokens: 4096, tier: 'standard' 
  },
  'gpt-4.1': { 
    input: 2.0, output: 8.0, cached: 0.5, 
    maxTokens: 8192, tier: 'standard' 
  },
  'gpt-5': { 
    input: 1.25, output: 10.0, cached: 0.125, 
    maxTokens: 8192, tier: 'standard' 
  },

  // === REASONING TIER (o-series) ===
  'o1-mini': { 
    input: 1.1, output: 4.4, cached: 0.55, 
    maxTokens: 16384, tier: 'reasoning' 
  },
  'o3-mini': { 
    input: 1.1, output: 4.4, cached: 0.55, 
    maxTokens: 16384, tier: 'reasoning' 
  },
  'o4-mini': { 
    input: 1.1, output: 4.4, cached: 0.275, 
    maxTokens: 16384, tier: 'reasoning' 
  },
  'o3': { 
    input: 2.0, output: 8.0, cached: 0.5, 
    maxTokens: 32768, tier: 'reasoning' 
  },
  'o1': { 
    input: 15.0, output: 60.0, cached: 7.5, 
    maxTokens: 32768, tier: 'reasoning' 
  },

  // === PREMIUM TIER (expensive, specialized) ===
  'o3-pro': { 
    input: 20.0, output: 80.0, 
    maxTokens: 32768, tier: 'premium' 
  },
  'o1-pro': { 
    input: 150.0, output: 600.0, 
    maxTokens: 32768, tier: 'premium' 
  },
};

// Default model for fallback
const DEFAULT_MODEL = 'gpt-4o-mini';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for token-based pricing
 */
export interface TokenPricingConfig {
  /**
   * Model to use for pricing.
   * Must be a key in MODEL_PRICING or will fallback to gpt-4o-mini.
   */
  model?: string;

  /**
   * Minimum USD amount (floor).
   * @default 0.001
   */
  minUsd?: number;

  /**
   * Maximum USD amount (ceiling).
   * @default 50.0
   */
  maxUsd?: number;

  /**
   * Token decimals for atomic conversion.
   * @default 6 (USDC)
   */
  decimals?: number;
}

/**
 * Token price quote
 */
export interface TokenPriceQuote {
  /** Amount in atomic units (for buildRequirements) */
  amountAtomic: string;

  /** Human-readable USD amount */
  usdAmount: number;

  /** Number of input tokens */
  inputTokens: number;

  /** Model used for pricing */
  model: string;

  /** Pricing tier */
  tier: string;

  /** Input rate per million tokens */
  inputRatePerMillion: number;

  /** Output rate per million tokens */
  outputRatePerMillion: number;

  /** Max output tokens for this model */
  maxOutputTokens: number;

  /**
   * Quote hash for validation.
   * Client should send this back as X-Quote-Hash header.
   */
  quoteHash: string;
}

/**
 * Token pricing calculator
 */
export interface TokenPricing {
  /** Calculate price from input text */
  calculate(input: string, systemPrompt?: string): TokenPriceQuote;

  /** Validate quote hash (returns true if valid) */
  validateQuote(input: string, quoteHash: string): boolean;

  /** Count tokens in a string */
  countTokens(input: string): number;

  /** Get pricing config */
  readonly config: Required<TokenPricingConfig>;

  /** Get model info */
  readonly modelInfo: ModelPricing;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Get tiktoken encoding for a model.
 * Falls back to cl100k_base for unknown models.
 */
function getEncodingForModel(model: string) {
  try {
    return encoding_for_model(model as TiktokenModel);
  } catch {
    // Fall back to cl100k_base (GPT-4/4o family encoding)
    return get_encoding('cl100k_base');
  }
}

/**
 * Count tokens in a string using tiktoken.
 */
export function countTokens(text: string, model: string = DEFAULT_MODEL): number {
  const encoding = getEncodingForModel(model);
  try {
    const tokens = encoding.encode(text);
    return tokens.length;
  } finally {
    encoding.free();
  }
}

/**
 * Generate a hash of the prompt + pricing config for validation.
 */
function generateQuoteHash(prompt: string, model: string, rate: number, tokens: number): string {
  const configString = JSON.stringify({ model, rate, tokens });
  return createHash('sha256').update(prompt + configString).digest('hex').slice(0, 16);
}

/**
 * Create a token-based pricing calculator
 */
export function createTokenPricing(config: TokenPricingConfig = {}): TokenPricing {
  const model = config.model && MODEL_PRICING[config.model] ? config.model : DEFAULT_MODEL;
  const modelInfo = MODEL_PRICING[model];

  const fullConfig: Required<TokenPricingConfig> = {
    model,
    minUsd: config.minUsd ?? 0.001,
    maxUsd: config.maxUsd ?? 50.0,
    decimals: config.decimals ?? 6,
  };

  const { minUsd, maxUsd, decimals } = fullConfig;

  /**
   * Count tokens in text
   */
  function countTokensInternal(input: string): number {
    return countTokens(input, model);
  }

  /**
   * Calculate price from input
   */
  function calculate(input: string, systemPrompt?: string): TokenPriceQuote {
    // Count input tokens (prompt + system prompt if provided)
    const fullInput = systemPrompt ? `${systemPrompt}\n\n${input}` : input;
    const inputTokens = countTokensInternal(fullInput);

    // Calculate USD cost based on input tokens only
    // Price = (inputTokens / 1,000,000) × inputRate
    let usdAmount = (inputTokens / 1_000_000) * modelInfo.input;

    // Apply min/max caps
    usdAmount = Math.max(usdAmount, minUsd);
    usdAmount = Math.min(usdAmount, maxUsd);

    // Convert to atomic units
    const multiplier = Math.pow(10, decimals);
    const amountAtomic = Math.floor(usdAmount * multiplier).toString();

    // Generate quote hash for validation
    const quoteHash = generateQuoteHash(input, model, modelInfo.input, inputTokens);

    return {
      amountAtomic,
      usdAmount,
      inputTokens,
      model,
      tier: modelInfo.tier,
      inputRatePerMillion: modelInfo.input,
      outputRatePerMillion: modelInfo.output,
      maxOutputTokens: modelInfo.maxTokens,
      quoteHash,
    };
  }

  /**
   * Validate quote hash
   */
  function validateQuote(input: string, quoteHash: string): boolean {
    if (!quoteHash) return false;
    const inputTokens = countTokensInternal(input);
    const expectedHash = generateQuoteHash(input, model, modelInfo.input, inputTokens);
    return expectedHash === quoteHash;
  }

  return {
    calculate,
    validateQuote,
    countTokens: countTokensInternal,
    config: fullConfig,
    modelInfo,
  };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Get list of available models with their pricing.
 */
export function getAvailableModels(): Array<{
  model: string;
  inputRate: number;
  outputRate: number;
  maxTokens: number;
  tier: string;
}> {
  return Object.entries(MODEL_PRICING)
    .map(([model, pricing]) => ({
      model,
      inputRate: pricing.input,
      outputRate: pricing.output,
      maxTokens: pricing.maxTokens,
      tier: pricing.tier,
    }))
    .sort((a, b) => {
      // Sort by tier, then by input rate
      const tierOrder = { fast: 0, standard: 1, reasoning: 2, premium: 3 };
      const tierDiff = tierOrder[a.tier as keyof typeof tierOrder] - tierOrder[b.tier as keyof typeof tierOrder];
      if (tierDiff !== 0) return tierDiff;
      return a.inputRate - b.inputRate;
    });
}

/**
 * Check if a model exists in our pricing.
 */
export function isValidModel(model: string): boolean {
  return model in MODEL_PRICING;
}

/**
 * Format token pricing for display
 * Example: "$0.15 per 1M tokens (gpt-4o-mini)"
 */
export function formatTokenPricing(model: string = DEFAULT_MODEL): string {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_MODEL];
  const actualModel = MODEL_PRICING[model] ? model : DEFAULT_MODEL;
  return `$${pricing.input.toFixed(2)} per 1M tokens (${actualModel})`;
}

