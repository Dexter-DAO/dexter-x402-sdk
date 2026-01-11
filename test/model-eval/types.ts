/**
 * Model Evaluation Harness Types
 */

import type { ModelDefinition, ModelTier } from '../../src/server/model-registry';

/**
 * Configuration for an evaluation run
 */
export interface EvalConfig {
  /** The prompt to send to all models */
  prompt: string;
  /** Optional system prompt */
  systemPrompt?: string;
  /** Context files to include (their content becomes part of system prompt) */
  contextFiles?: string[];
  /** Which models to test (if empty, tests all text models) */
  models?: string[];
  /** Which tiers to test */
  tiers?: ModelTier[];
  /** Max tokens for output (uses model default if not specified) */
  maxTokens?: number;
  /** Reasoning effort for o-series models */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Dry run - show what would happen without calling API */
  dryRun?: boolean;
  /** Output directory (defaults to timestamped folder in results/) */
  outputDir?: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Always show full responses in terminal */
  showFullResponses?: boolean;
}

/**
 * Result from a single model run
 */
export interface ModelRunResult {
  /** Model ID */
  modelId: string;
  /** Model definition */
  model: ModelDefinition;
  /** Whether the run succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** The generated response */
  response?: string;
  /** Time to first token (ms) */
  ttfb?: number;
  /** Total response time (ms) */
  totalTime?: number;
  /** Input tokens used */
  inputTokens?: number;
  /** Output tokens used (total, includes reasoning) */
  outputTokens?: number;
  /** Hidden reasoning tokens (GPT-5, o-series) */
  reasoningTokens?: number;
  /** Visible output tokens (outputTokens - reasoningTokens) */
  visibleTokens?: number;
  /** Actual cost in USD */
  cost?: number;
  /** Raw API response (for debugging) */
  rawResponse?: unknown;
  /** API request body sent (for debugging) */
  requestBody?: unknown;
  /** Timestamp when run started */
  startedAt: string;
  /** Timestamp when run completed */
  completedAt?: string;
}

/**
 * Complete evaluation run results
 */
export interface EvalResults {
  /** Run ID (timestamp-based) */
  runId: string;
  /** When the run started */
  startedAt: string;
  /** When the run completed */
  completedAt?: string;
  /** The config used */
  config: EvalConfig;
  /** Results per model */
  results: ModelRunResult[];
  /** Aggregate statistics */
  stats: EvalStats;
}

/**
 * Aggregate statistics for an eval run
 */
export interface EvalStats {
  /** Total models attempted */
  totalModels: number;
  /** Successful runs */
  successCount: number;
  /** Failed runs */
  failureCount: number;
  /** Total cost in USD */
  totalCost: number;
  /** Total input tokens */
  totalInputTokens: number;
  /** Total output tokens */
  totalOutputTokens: number;
  /** Fastest response time (ms) */
  fastestTime?: number;
  /** Fastest model ID */
  fastestModel?: string;
  /** Slowest response time (ms) */
  slowestTime?: number;
  /** Slowest model ID */
  slowestModel?: string;
  /** Average response time (ms) */
  averageTime?: number;
  /** Cheapest cost */
  cheapestCost?: number;
  /** Cheapest model ID */
  cheapestModel?: string;
  /** Most expensive cost */
  mostExpensiveCost?: number;
  /** Most expensive model ID */
  mostExpensiveModel?: string;
}

/**
 * Progress callback for live updates
 */
export type ProgressCallback = (
  status: 'starting' | 'running' | 'completed' | 'failed',
  modelId: string,
  index: number,
  total: number,
  result?: ModelRunResult
) => void;
