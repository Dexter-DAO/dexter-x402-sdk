/**
 * OpenAI Model Registry
 * 
 * The single source of truth for all OpenAI models.
 * Contains pricing, capabilities, API requirements, and constraints.
 * 
 * Updated: January 2026
 * Source: https://platform.openai.com/docs/pricing
 * 
 * @example
 * ```typescript
 * import { ModelRegistry, getModel, getModelsByTier } from '@dexterai/x402/server';
 * 
 * // Get a specific model
 * const model = getModel('gpt-4o-mini');
 * console.log(model.pricing.input); // 0.15
 * 
 * // Get all reasoning models
 * const reasoners = getModelsByTier('reasoning');
 * ```
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Model capability tiers, ordered by general capability level
 */
export type ModelTier = 
  | 'fast'        // Cheapest, fastest, good for simple tasks
  | 'standard'    // Balanced price/performance
  | 'reasoning'   // Chain-of-thought reasoning (o-series)
  | 'premium'     // Most capable, expensive
  | 'specialized'; // Special purpose (computer use, deep research, etc.)

/**
 * What the model can process/generate
 */
export type ModelModality = 'text' | 'vision' | 'audio' | 'realtime' | 'image' | 'video';

/**
 * API endpoint type
 */
export type ModelApiType = 'chat' | 'completion' | 'responses';

/**
 * Pricing per 1M tokens (USD)
 */
export interface ModelPricing {
  /** Input token cost per 1M */
  input: number;
  /** Output token cost per 1M */
  output: number;
  /** Cached input token cost per 1M (if supported) */
  cached?: number;
}

/**
 * What parameters the model accepts
 */
export interface ModelParameters {
  /** Uses max_completion_tokens instead of max_tokens */
  usesMaxCompletionTokens: boolean;
  /** Supports temperature parameter */
  supportsTemperature: boolean;
  /** Supports top_p parameter */
  supportsTopP: boolean;
  /** Supports frequency_penalty */
  supportsFrequencyPenalty: boolean;
  /** Supports presence_penalty */
  supportsPresencePenalty: boolean;
  /** Supports reasoning_effort parameter */
  supportsReasoningEffort: boolean;
  /** Supports streaming */
  supportsStreaming: boolean;
  /** Supports system messages */
  supportsSystemMessage: boolean;
  /** Supports function/tool calling */
  supportsTools: boolean;
  /** Supports structured outputs (JSON mode) */
  supportsStructuredOutput: boolean;
}

/**
 * Complete model definition
 */
export interface ModelDefinition {
  /** Model ID as used in API calls */
  id: string;
  /** Human-readable display name */
  displayName: string;
  /** Model family (gpt-4o, gpt-5, o1, o3, etc.) */
  family: string;
  /** Capability tier */
  tier: ModelTier;
  /** Capability rank within tier (1 = lowest, 10 = highest) */
  capabilityRank: number;
  /** What it can process */
  modalities: ModelModality[];
  /** API type */
  apiType: ModelApiType;
  /** Pricing per 1M tokens */
  pricing: ModelPricing;
  /** Context window size (tokens) */
  contextWindow: number;
  /** Default max output tokens */
  defaultMaxOutput: number;
  /** Maximum output tokens allowed */
  maxOutputTokens: number;
  /** Parameter support */
  parameters: ModelParameters;
  /** Is this model deprecated? */
  deprecated: boolean;
  /** Brief description */
  description: string;
}

// ============================================================================
// Default Parameter Profiles
// ============================================================================

/** Standard chat model parameters (GPT-4o, GPT-4.1 family) */
const STANDARD_PARAMS: ModelParameters = {
  usesMaxCompletionTokens: false,
  supportsTemperature: true,
  supportsTopP: true,
  supportsFrequencyPenalty: true,
  supportsPresencePenalty: true,
  supportsReasoningEffort: false,
  supportsStreaming: true,
  supportsSystemMessage: true,
  supportsTools: true,
  supportsStructuredOutput: true,
};

/** GPT-5 family parameters - uses max_completion_tokens, no temperature */
const GPT5_PARAMS: ModelParameters = {
  usesMaxCompletionTokens: true,  // GPT-5 requires this!
  supportsTemperature: false,     // Only default (1) is supported
  supportsTopP: false,            // Likely same restriction
  supportsFrequencyPenalty: false,
  supportsPresencePenalty: false,
  supportsReasoningEffort: false,
  supportsStreaming: true,
  supportsSystemMessage: true,
  supportsTools: true,
  supportsStructuredOutput: true,
};

/** Reasoning model parameters (o1, o3, o4 series) */
const REASONING_PARAMS: ModelParameters = {
  usesMaxCompletionTokens: true,
  supportsTemperature: false,  // Fixed at 1
  supportsTopP: false,
  supportsFrequencyPenalty: false,
  supportsPresencePenalty: false,
  supportsReasoningEffort: true,
  supportsStreaming: true,
  supportsSystemMessage: true,  // Developer message
  supportsTools: true,
  supportsStructuredOutput: true,
};

/** Pro/Premium reasoning model parameters */
const PRO_REASONING_PARAMS: ModelParameters = {
  ...REASONING_PARAMS,
  supportsStreaming: false,  // Pro models may not stream
};

// ============================================================================
// Model Registry
// ============================================================================

/**
 * Complete registry of all OpenAI models
 * Ordered by tier, then by capability rank (ascending)
 */
export const MODEL_REGISTRY: ModelDefinition[] = [
  // =========================================================================
  // FAST TIER - Cheapest, fastest, good for simple tasks
  // =========================================================================
  {
    id: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    family: 'gpt-4o',
    tier: 'fast',
    capabilityRank: 3,
    modalities: ['text', 'vision'],
    apiType: 'chat',
    pricing: { input: 0.15, output: 0.60, cached: 0.075 },
    contextWindow: 128000,
    defaultMaxOutput: 4096,
    maxOutputTokens: 16384,
    parameters: STANDARD_PARAMS,
    deprecated: false,
    description: 'Fast, affordable small model with vision support',
  },
  {
    id: 'gpt-4.1-nano',
    displayName: 'GPT-4.1 Nano',
    family: 'gpt-4.1',
    tier: 'fast',
    capabilityRank: 2,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 0.10, output: 0.40, cached: 0.025 },
    contextWindow: 128000,
    defaultMaxOutput: 4096,
    maxOutputTokens: 32768,
    parameters: STANDARD_PARAMS,
    deprecated: false,
    description: 'Smallest 4.1 model, very fast and cheap',
  },
  {
    id: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 Mini',
    family: 'gpt-4.1',
    tier: 'fast',
    capabilityRank: 4,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 0.40, output: 1.60, cached: 0.10 },
    contextWindow: 128000,
    defaultMaxOutput: 4096,
    maxOutputTokens: 32768,
    parameters: STANDARD_PARAMS,
    deprecated: false,
    description: 'Balanced 4.1 model, good price/performance',
  },
  {
    id: 'gpt-5-nano',
    displayName: 'GPT-5 Nano',
    family: 'gpt-5',
    tier: 'fast',
    capabilityRank: 1,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 0.05, output: 0.40, cached: 0.005 },
    contextWindow: 128000,
    defaultMaxOutput: 4096,
    maxOutputTokens: 16384,
    parameters: GPT5_PARAMS,
    deprecated: false,
    description: 'Cheapest GPT-5 variant, extremely fast',
  },
  {
    id: 'gpt-5-mini',
    displayName: 'GPT-5 Mini',
    family: 'gpt-5',
    tier: 'fast',
    capabilityRank: 5,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 0.25, output: 2.00, cached: 0.025 },
    contextWindow: 128000,
    defaultMaxOutput: 8192,
    maxOutputTokens: 32768,
    parameters: GPT5_PARAMS,
    deprecated: false,
    description: 'Small but capable GPT-5, great value',
  },

  // =========================================================================
  // STANDARD TIER - Balanced price/performance
  // =========================================================================
  {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    family: 'gpt-4o',
    tier: 'standard',
    capabilityRank: 5,
    modalities: ['text', 'vision'],
    apiType: 'chat',
    pricing: { input: 2.50, output: 10.00, cached: 1.25 },
    contextWindow: 128000,
    defaultMaxOutput: 4096,
    maxOutputTokens: 16384,
    parameters: STANDARD_PARAMS,
    deprecated: false,
    description: 'Flagship multimodal model with vision',
  },
  {
    id: 'gpt-4.1',
    displayName: 'GPT-4.1',
    family: 'gpt-4.1',
    tier: 'standard',
    capabilityRank: 6,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 2.00, output: 8.00, cached: 0.50 },
    contextWindow: 1000000,  // 1M context!
    defaultMaxOutput: 8192,
    maxOutputTokens: 32768,
    parameters: STANDARD_PARAMS,
    deprecated: false,
    description: 'Long context specialist, 1M token window',
  },
  {
    id: 'gpt-5',
    displayName: 'GPT-5',
    family: 'gpt-5',
    tier: 'standard',
    capabilityRank: 7,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 1.25, output: 10.00, cached: 0.125 },
    contextWindow: 128000,
    defaultMaxOutput: 8192,
    maxOutputTokens: 32768,
    parameters: GPT5_PARAMS,
    deprecated: false,
    description: 'Base GPT-5, excellent all-around',
  },
  {
    id: 'gpt-5.1',
    displayName: 'GPT-5.1',
    family: 'gpt-5',
    tier: 'standard',
    capabilityRank: 8,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 1.25, output: 10.00, cached: 0.125 },
    contextWindow: 128000,
    defaultMaxOutput: 8192,
    maxOutputTokens: 32768,
    parameters: GPT5_PARAMS,
    deprecated: false,
    description: 'Improved GPT-5 with better instruction following',
  },
  {
    id: 'gpt-5.2',
    displayName: 'GPT-5.2',
    family: 'gpt-5',
    tier: 'standard',
    capabilityRank: 9,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 1.75, output: 14.00, cached: 0.175 },
    contextWindow: 128000,
    defaultMaxOutput: 8192,
    maxOutputTokens: 32768,
    parameters: GPT5_PARAMS,
    deprecated: false,
    description: 'Latest GPT-5, most capable standard model',
  },

  // =========================================================================
  // REASONING TIER - Chain-of-thought reasoning (o-series)
  // =========================================================================
  {
    id: 'o1-mini',
    displayName: 'o1 Mini',
    family: 'o1',
    tier: 'reasoning',
    capabilityRank: 3,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 1.10, output: 4.40, cached: 0.55 },
    contextWindow: 128000,
    defaultMaxOutput: 16384,
    maxOutputTokens: 65536,
    parameters: REASONING_PARAMS,
    deprecated: false,
    description: 'Fast reasoning model, good for math/code',
  },
  {
    id: 'o3-mini',
    displayName: 'o3 Mini',
    family: 'o3',
    tier: 'reasoning',
    capabilityRank: 4,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 1.10, output: 4.40, cached: 0.55 },
    contextWindow: 128000,
    defaultMaxOutput: 16384,
    maxOutputTokens: 65536,
    parameters: REASONING_PARAMS,
    deprecated: false,
    description: 'Improved mini reasoner with better efficiency',
  },
  {
    id: 'o4-mini',
    displayName: 'o4 Mini',
    family: 'o4',
    tier: 'reasoning',
    capabilityRank: 5,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 1.10, output: 4.40, cached: 0.275 },
    contextWindow: 128000,
    defaultMaxOutput: 16384,
    maxOutputTokens: 65536,
    parameters: REASONING_PARAMS,
    deprecated: false,
    description: 'Latest mini reasoner, best reasoning per dollar',
  },
  {
    id: 'o3',
    displayName: 'o3',
    family: 'o3',
    tier: 'reasoning',
    capabilityRank: 7,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 2.00, output: 8.00, cached: 0.50 },
    contextWindow: 200000,
    defaultMaxOutput: 32768,
    maxOutputTokens: 100000,
    parameters: REASONING_PARAMS,
    deprecated: false,
    description: 'Full o3 reasoning model, excellent for complex problems',
  },
  {
    id: 'o1',
    displayName: 'o1',
    family: 'o1',
    tier: 'reasoning',
    capabilityRank: 8,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 15.00, output: 60.00, cached: 7.50 },
    contextWindow: 200000,
    defaultMaxOutput: 32768,
    maxOutputTokens: 100000,
    parameters: REASONING_PARAMS,
    deprecated: false,
    description: 'Original full reasoning model, very capable',
  },

  // =========================================================================
  // PREMIUM TIER - Most capable, expensive
  // =========================================================================
  {
    id: 'gpt-5-pro',
    displayName: 'GPT-5 Pro',
    family: 'gpt-5',
    tier: 'premium',
    capabilityRank: 7,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 15.00, output: 120.00 },
    contextWindow: 128000,
    defaultMaxOutput: 16384,
    maxOutputTokens: 32768,
    parameters: GPT5_PARAMS,
    deprecated: false,
    description: 'Enhanced GPT-5 for demanding tasks',
  },
  {
    id: 'gpt-5.2-pro',
    displayName: 'GPT-5.2 Pro',
    family: 'gpt-5',
    tier: 'premium',
    capabilityRank: 8,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 21.00, output: 168.00 },
    contextWindow: 128000,
    defaultMaxOutput: 16384,
    maxOutputTokens: 32768,
    parameters: GPT5_PARAMS,
    deprecated: false,
    description: 'Most capable standard model available',
  },
  {
    id: 'o3-pro',
    displayName: 'o3 Pro',
    family: 'o3',
    tier: 'premium',
    capabilityRank: 9,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 20.00, output: 80.00 },
    contextWindow: 200000,
    defaultMaxOutput: 32768,
    maxOutputTokens: 100000,
    parameters: PRO_REASONING_PARAMS,
    deprecated: false,
    description: 'Premium o3 with extended thinking time',
  },
  {
    id: 'o1-pro',
    displayName: 'o1 Pro',
    family: 'o1',
    tier: 'premium',
    capabilityRank: 10,
    modalities: ['text'],
    apiType: 'chat',
    pricing: { input: 150.00, output: 600.00 },
    contextWindow: 200000,
    defaultMaxOutput: 32768,
    maxOutputTokens: 100000,
    parameters: PRO_REASONING_PARAMS,
    deprecated: false,
    description: 'Most capable reasoning model, extended compute',
  },

  // =========================================================================
  // SPECIALIZED TIER - Special purpose models
  // =========================================================================
  {
    id: 'o3-deep-research',
    displayName: 'o3 Deep Research',
    family: 'o3',
    tier: 'specialized',
    capabilityRank: 8,
    modalities: ['text'],
    apiType: 'responses',
    pricing: { input: 10.00, output: 40.00, cached: 2.50 },
    contextWindow: 200000,
    defaultMaxOutput: 32768,
    maxOutputTokens: 100000,
    parameters: {
      ...REASONING_PARAMS,
      supportsStreaming: false,
    },
    deprecated: false,
    description: 'Extended research sessions with web access',
  },
  {
    id: 'o4-mini-deep-research',
    displayName: 'o4 Mini Deep Research',
    family: 'o4',
    tier: 'specialized',
    capabilityRank: 6,
    modalities: ['text'],
    apiType: 'responses',
    pricing: { input: 2.00, output: 8.00, cached: 0.50 },
    contextWindow: 128000,
    defaultMaxOutput: 16384,
    maxOutputTokens: 65536,
    parameters: {
      ...REASONING_PARAMS,
      supportsStreaming: false,
    },
    deprecated: false,
    description: 'Affordable deep research with o4 mini',
  },
  {
    id: 'computer-use-preview',
    displayName: 'Computer Use Preview',
    family: 'computer-use',
    tier: 'specialized',
    capabilityRank: 5,
    modalities: ['text', 'vision'],
    apiType: 'responses',
    pricing: { input: 3.00, output: 12.00 },
    contextWindow: 128000,
    defaultMaxOutput: 4096,
    maxOutputTokens: 16384,
    parameters: {
      ...STANDARD_PARAMS,
      supportsReasoningEffort: false,
    },
    deprecated: false,
    description: 'Can control computer interfaces via screenshots',
  },

  // =========================================================================
  // REALTIME TIER - Real-time audio/video
  // =========================================================================
  {
    id: 'gpt-realtime',
    displayName: 'GPT Realtime',
    family: 'gpt-realtime',
    tier: 'specialized',
    capabilityRank: 7,
    modalities: ['text', 'audio', 'realtime'],
    apiType: 'chat',
    pricing: { input: 4.00, output: 16.00, cached: 0.40 },
    contextWindow: 128000,
    defaultMaxOutput: 4096,
    maxOutputTokens: 4096,
    parameters: {
      ...STANDARD_PARAMS,
      supportsReasoningEffort: false,
    },
    deprecated: false,
    description: 'Real-time audio conversation model',
  },
  {
    id: 'gpt-realtime-mini',
    displayName: 'GPT Realtime Mini',
    family: 'gpt-realtime',
    tier: 'specialized',
    capabilityRank: 4,
    modalities: ['text', 'audio', 'realtime'],
    apiType: 'chat',
    pricing: { input: 0.60, output: 2.40, cached: 0.06 },
    contextWindow: 128000,
    defaultMaxOutput: 4096,
    maxOutputTokens: 4096,
    parameters: {
      ...STANDARD_PARAMS,
      supportsReasoningEffort: false,
    },
    deprecated: false,
    description: 'Affordable real-time audio model',
  },

  // =========================================================================
  // LEGACY MODELS - Still available but older
  // =========================================================================
  {
    id: 'gpt-4o-2024-05-13',
    displayName: 'GPT-4o (May 2024)',
    family: 'gpt-4o',
    tier: 'standard',
    capabilityRank: 4,
    modalities: ['text', 'vision'],
    apiType: 'chat',
    pricing: { input: 5.00, output: 15.00 },
    contextWindow: 128000,
    defaultMaxOutput: 4096,
    maxOutputTokens: 4096,
    parameters: STANDARD_PARAMS,
    deprecated: true,
    description: 'Original GPT-4o snapshot, use gpt-4o instead',
  },
];

// ============================================================================
// Lookup Functions
// ============================================================================

/** Map for O(1) lookup by model ID */
const MODEL_MAP = new Map<string, ModelDefinition>(
  MODEL_REGISTRY.map(m => [m.id, m])
);

/**
 * Get a model by ID
 * @throws if model not found
 */
export function getModel(modelId: string): ModelDefinition {
  const model = MODEL_MAP.get(modelId);
  if (!model) {
    throw new Error(`Unknown model: ${modelId}. Use getAvailableModelIds() to see valid options.`);
  }
  return model;
}

/**
 * Get a model by ID, returns undefined if not found
 */
export function findModel(modelId: string): ModelDefinition | undefined {
  return MODEL_MAP.get(modelId);
}

/**
 * Check if a model ID is valid
 */
export function isValidModelId(modelId: string): boolean {
  return MODEL_MAP.has(modelId);
}

/**
 * Get all model IDs
 */
export function getAvailableModelIds(): string[] {
  return MODEL_REGISTRY.map(m => m.id);
}

/**
 * Get all models in a specific tier
 */
export function getModelsByTier(tier: ModelTier): ModelDefinition[] {
  return MODEL_REGISTRY
    .filter(m => m.tier === tier && !m.deprecated)
    .sort((a, b) => a.capabilityRank - b.capabilityRank);
}

/**
 * Get all models in a specific family
 */
export function getModelsByFamily(family: string): ModelDefinition[] {
  return MODEL_REGISTRY
    .filter(m => m.family === family)
    .sort((a, b) => a.capabilityRank - b.capabilityRank);
}

/**
 * Get all non-deprecated models, ordered by tier then capability
 */
export function getActiveModels(): ModelDefinition[] {
  const tierOrder: Record<ModelTier, number> = {
    fast: 1,
    standard: 2,
    reasoning: 3,
    premium: 4,
    specialized: 5,
  };
  
  return MODEL_REGISTRY
    .filter(m => !m.deprecated)
    .sort((a, b) => {
      const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
      if (tierDiff !== 0) return tierDiff;
      return a.capabilityRank - b.capabilityRank;
    });
}

/**
 * Get models suitable for text generation testing
 * (excludes realtime, audio-only, etc.)
 */
export function getTextModels(): ModelDefinition[] {
  return MODEL_REGISTRY
    .filter(m => 
      !m.deprecated && 
      m.modalities.includes('text') &&
      !m.modalities.includes('realtime') &&
      m.apiType !== 'responses'  // Standard chat API
    )
    .sort((a, b) => {
      const tierOrder: Record<ModelTier, number> = {
        fast: 1, standard: 2, reasoning: 3, premium: 4, specialized: 5
      };
      const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
      if (tierDiff !== 0) return tierDiff;
      return a.capabilityRank - b.capabilityRank;
    });
}

/**
 * Get the cheapest model that meets minimum capability requirements
 */
export function getCheapestModel(minTier: ModelTier = 'fast'): ModelDefinition {
  const tierOrder: Record<ModelTier, number> = {
    fast: 1, standard: 2, reasoning: 3, premium: 4, specialized: 5
  };
  const minTierNum = tierOrder[minTier];
  
  const candidates = MODEL_REGISTRY
    .filter(m => !m.deprecated && tierOrder[m.tier] >= minTierNum)
    .sort((a, b) => a.pricing.input - b.pricing.input);
  
  return candidates[0];
}

/**
 * Estimate cost for a request
 */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  useCached: boolean = false
): number {
  const model = getModel(modelId);
  const inputCost = useCached && model.pricing.cached
    ? (inputTokens / 1_000_000) * model.pricing.cached
    : (inputTokens / 1_000_000) * model.pricing.input;
  const outputCost = (outputTokens / 1_000_000) * model.pricing.output;
  return inputCost + outputCost;
}

/**
 * Format pricing for display
 */
export function formatModelPricing(modelId: string): string {
  const model = getModel(modelId);
  return `$${model.pricing.input.toFixed(2)} in / $${model.pricing.output.toFixed(2)} out per 1M tokens`;
}

// ============================================================================
// Export a simple pricing map for backwards compatibility
// ============================================================================

/**
 * Simple pricing map for token-pricing.ts compatibility
 */
export const MODEL_PRICING_MAP: Record<string, {
  input: number;
  output: number;
  cached?: number;
  maxTokens: number;
  tier: string;
}> = Object.fromEntries(
  MODEL_REGISTRY.map(m => [m.id, {
    input: m.pricing.input,
    output: m.pricing.output,
    cached: m.pricing.cached,
    maxTokens: m.defaultMaxOutput,
    tier: m.tier,
  }])
);
