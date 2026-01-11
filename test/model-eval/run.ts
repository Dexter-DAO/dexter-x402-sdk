#!/usr/bin/env npx tsx
/**
 * Model Evaluation Harness
 * 
 * Tests the same prompt against all OpenAI models, capturing timing,
 * cost, and output for comparison.
 * 
 * Usage:
 *   npx tsx test/model-eval/run.ts --prompt "Your prompt here"
 *   npx tsx test/model-eval/run.ts --prompt "..." --tier fast
 *   npx tsx test/model-eval/run.ts --prompt "..." --models gpt-4o-mini,o3
 *   npx tsx test/model-eval/run.ts --prompt "..." --dry-run
 * 
 * Environment:
 *   OPENAI_API_KEY - Required for API calls
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  MODEL_REGISTRY,
  getModel,
  getTextModels,
  getModelsByTier,
  estimateCost,
  type ModelDefinition,
  type ModelTier,
} from '../../src/server/model-registry';
import type { EvalConfig, EvalResults, ModelRunResult, EvalStats, ProgressCallback } from './types';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// ANSI Color Codes for Beautiful Output
// ============================================================================

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Foreground
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  
  // Backgrounds
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
};

const c = {
  title: (s: string) => `${colors.bold}${colors.cyan}${s}${colors.reset}`,
  success: (s: string) => `${colors.green}${s}${colors.reset}`,
  error: (s: string) => `${colors.red}${s}${colors.reset}`,
  warning: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  info: (s: string) => `${colors.blue}${s}${colors.reset}`,
  dim: (s: string) => `${colors.dim}${s}${colors.reset}`,
  bold: (s: string) => `${colors.bold}${s}${colors.reset}`,
  model: (s: string) => `${colors.bold}${colors.magenta}${s}${colors.reset}`,
  money: (s: string) => `${colors.green}$${s}${colors.reset}`,
  time: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  tier: (tier: ModelTier) => {
    const tierColors: Record<ModelTier, string> = {
      fast: colors.green,
      standard: colors.blue,
      reasoning: colors.magenta,
      premium: colors.yellow,
      specialized: colors.cyan,
    };
    return `${tierColors[tier]}${tier}${colors.reset}`;
  },
};

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): EvalConfig {
  const args = process.argv.slice(2);
  const config: EvalConfig = {
    prompt: '',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--prompt':
      case '-p':
        config.prompt = nextArg || '';
        i++;
        break;
      case '--system':
      case '-s':
        config.systemPrompt = nextArg;
        i++;
        break;
      case '--models':
      case '-m':
        config.models = nextArg?.split(',').map(s => s.trim());
        i++;
        break;
      case '--tier':
      case '-t':
        config.tiers = [nextArg as ModelTier];
        i++;
        break;
      case '--tiers':
        config.tiers = nextArg?.split(',').map(s => s.trim() as ModelTier);
        i++;
        break;
      case '--max-tokens':
        config.maxTokens = parseInt(nextArg || '0', 10);
        i++;
        break;
      case '--reasoning-effort':
        config.reasoningEffort = nextArg as 'low' | 'medium' | 'high';
        i++;
        break;
      case '--dry-run':
        config.dryRun = true;
        break;
      case '--verbose':
      case '-v':
        config.verbose = true;
        break;
      case '--output':
      case '-o':
        config.outputDir = nextArg;
        i++;
        break;
      case '--prompt-file':
        // Read prompt from file
        if (nextArg && fs.existsSync(nextArg)) {
          config.prompt = fs.readFileSync(nextArg, 'utf-8').trim();
        } else {
          console.error(c.error(`Prompt file not found: ${nextArg}`));
          process.exit(1);
        }
        i++;
        break;
      case '--context':
      case '-c':
        // Add a context file
        if (!config.contextFiles) config.contextFiles = [];
        if (nextArg) {
          config.contextFiles.push(nextArg);
        }
        i++;
        break;
      case '--show-responses':
        config.showFullResponses = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return config;
}

function printHelp(): void {
  console.log(`
${c.title('╔══════════════════════════════════════════════════════════════╗')}
${c.title('║           OpenAI Model Evaluation Harness                    ║')}
${c.title('╚══════════════════════════════════════════════════════════════╝')}

${c.bold('Usage:')}
  npx tsx test/model-eval/run.ts --prompt "Your prompt here"
  npx tsx test/model-eval/run.ts --prompt-file question.txt --context docs/*.md

${c.bold('Prompt Options:')}
  ${c.info('--prompt, -p')}       The prompt to test (required unless using --prompt-file)
  ${c.info('--prompt-file')}      Read prompt from a file
  ${c.info('--system, -s')}       System prompt
  ${c.info('--context, -c')}      Files to include as context (can specify multiple)

${c.bold('Model Selection:')}
  ${c.info('--models, -m')}       Comma-separated model IDs to test
  ${c.info('--tier, -t')}         Test only one tier (fast|standard|reasoning|premium)
  ${c.info('--tiers')}            Comma-separated tiers

${c.bold('Model Parameters:')}
  ${c.info('--max-tokens')}       Override max output tokens
  ${c.info('--reasoning-effort')} For o-series: low|medium|high (default: medium)

${c.bold('Output:')}
  ${c.info('--output, -o')}       Custom output directory
  ${c.info('--show-responses')}   Always show full responses in terminal
  ${c.info('--verbose, -v')}      Enable debug logging
  ${c.info('--dry-run')}          Show plan without calling API

${c.bold('Examples:')}
  ${c.dim('# Test with Dexter knowledge base')}
  npx tsx test/model-eval/run.ts \\
    --context ../dexter-api/what-is-dexter/docs-what-is-x402.md \\
    --prompt "Explain x402 in simple terms" \\
    --tier fast

  ${c.dim('# Compare reasoning models')}
  npx tsx test/model-eval/run.ts \\
    --prompt "What are the tradeoffs of x402 vs API keys?" \\
    --tier reasoning --show-responses

  ${c.dim('# Quick single-model test')}
  npx tsx test/model-eval/run.ts --prompt "Hello" --models gpt-4o-mini

${c.bold('Environment:')}
  ${c.warning('OPENAI_API_KEY')}     Required
`);
}

// ============================================================================
// Model Selection
// ============================================================================

function selectModels(config: EvalConfig): ModelDefinition[] {
  // If specific models requested, use those
  if (config.models && config.models.length > 0) {
    return config.models.map(id => {
      try {
        return getModel(id);
      } catch {
        console.error(c.error(`Unknown model: ${id}`));
        process.exit(1);
      }
    });
  }

  // If specific tiers requested, filter by tier
  if (config.tiers && config.tiers.length > 0) {
    return config.tiers.flatMap(tier => getModelsByTier(tier));
  }

  // Default: all text models (excludes realtime, audio-only, etc.)
  return getTextModels();
}

// ============================================================================
// API Call Logic
// ============================================================================

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  reasoning_effort?: 'low' | 'medium' | 'high';
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
      audio_tokens?: number;
      accepted_prediction_tokens?: number;
      rejected_prediction_tokens?: number;
    };
  };
}

async function callModel(
  model: ModelDefinition,
  config: EvalConfig,
  apiKey: string
): Promise<ModelRunResult> {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  const result: ModelRunResult = {
    modelId: model.id,
    model,
    success: false,
    startedAt,
  };

  try {
    // Build messages
    const messages: OpenAIMessage[] = [];
    if (config.systemPrompt && model.parameters.supportsSystemMessage) {
      messages.push({ role: 'system', content: config.systemPrompt });
    }
    messages.push({ role: 'user', content: config.prompt });

    // Build request body with model-specific parameters
    const body: OpenAIRequest = {
      model: model.id,
      messages,
    };

    // Handle max tokens - reasoning models use max_completion_tokens
    const maxTokens = config.maxTokens || model.defaultMaxOutput;
    if (model.parameters.usesMaxCompletionTokens) {
      body.max_completion_tokens = maxTokens;
    } else {
      body.max_tokens = maxTokens;
    }

    // Temperature - only if supported
    if (model.parameters.supportsTemperature) {
      body.temperature = 0.7;
    }

    // Reasoning effort - for o-series
    if (model.parameters.supportsReasoningEffort) {
      body.reasoning_effort = config.reasoningEffort || 'medium';
    }

    // Save request body for debugging
    result.requestBody = body;

    // Make the API call
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const totalTime = Date.now() - startTime;

    if (!response.ok) {
      const errorBody = await response.text();
      result.error = `API error ${response.status}: ${errorBody}`;
      result.totalTime = totalTime;
      result.completedAt = new Date().toISOString();
      return result;
    }

    const data = await response.json() as OpenAIResponse;

    // Extract token details including reasoning tokens
    const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    const visibleTokens = outputTokens - reasoningTokens;

    result.success = true;
    result.response = data.choices[0]?.message?.content || '';
    result.totalTime = totalTime;
    result.inputTokens = data.usage?.prompt_tokens || 0;
    result.outputTokens = outputTokens;
    result.reasoningTokens = reasoningTokens;
    result.visibleTokens = visibleTokens;
    result.cost = estimateCost(model.id, result.inputTokens, result.outputTokens);
    result.rawResponse = data;
    result.completedAt = new Date().toISOString();

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.totalTime = Date.now() - startTime;
    result.completedAt = new Date().toISOString();
    return result;
  }
}

// ============================================================================
// Output Generation
// ============================================================================

function createOutputDir(config: EvalConfig): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseDir = config.outputDir || path.join(__dirname, 'results', timestamp);
  
  fs.mkdirSync(baseDir, { recursive: true });
  
  // Create tier subdirectories
  const tiers: ModelTier[] = ['fast', 'standard', 'reasoning', 'premium', 'specialized'];
  for (const tier of tiers) {
    fs.mkdirSync(path.join(baseDir, `tier-${tier}`), { recursive: true });
  }
  
  return baseDir;
}

function saveModelResult(outputDir: string, result: ModelRunResult): void {
  const tierDir = path.join(outputDir, `tier-${result.model.tier}`);
  const modelDir = path.join(tierDir, result.modelId);
  fs.mkdirSync(modelDir, { recursive: true });

  // Save response.md
  if (result.response) {
    fs.writeFileSync(
      path.join(modelDir, 'response.md'),
      `# ${result.model.displayName} Response\n\n${result.response}`
    );
  }

  // Save metrics.json with full token breakdown
  fs.writeFileSync(
    path.join(modelDir, 'metrics.json'),
    JSON.stringify({
      success: result.success,
      error: result.error,
      totalTime: result.totalTime,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      reasoningTokens: result.reasoningTokens,
      visibleTokens: result.visibleTokens,
      cost: result.cost,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
    }, null, 2)
  );

  // Save request.json (what we sent to the API)
  if (result.requestBody) {
    fs.writeFileSync(
      path.join(modelDir, 'request.json'),
      JSON.stringify(result.requestBody, null, 2)
    );
  }

  // Save raw.json (full API response)
  if (result.rawResponse) {
    fs.writeFileSync(
      path.join(modelDir, 'raw.json'),
      JSON.stringify(result.rawResponse, null, 2)
    );
  }
}

function calculateStats(results: ModelRunResult[]): EvalStats {
  const successfulResults = results.filter(r => r.success && r.totalTime);
  
  const stats: EvalStats = {
    totalModels: results.length,
    successCount: successfulResults.length,
    failureCount: results.length - successfulResults.length,
    totalCost: results.reduce((sum, r) => sum + (r.cost || 0), 0),
    totalInputTokens: results.reduce((sum, r) => sum + (r.inputTokens || 0), 0),
    totalOutputTokens: results.reduce((sum, r) => sum + (r.outputTokens || 0), 0),
  };

  if (successfulResults.length > 0) {
    // Timing stats
    const sorted = [...successfulResults].sort((a, b) => (a.totalTime || 0) - (b.totalTime || 0));
    stats.fastestTime = sorted[0].totalTime;
    stats.fastestModel = sorted[0].modelId;
    stats.slowestTime = sorted[sorted.length - 1].totalTime;
    stats.slowestModel = sorted[sorted.length - 1].modelId;
    stats.averageTime = Math.round(
      successfulResults.reduce((sum, r) => sum + (r.totalTime || 0), 0) / successfulResults.length
    );

    // Cost stats
    const byCost = [...successfulResults].sort((a, b) => (a.cost || 0) - (b.cost || 0));
    stats.cheapestCost = byCost[0].cost;
    stats.cheapestModel = byCost[0].modelId;
    stats.mostExpensiveCost = byCost[byCost.length - 1].cost;
    stats.mostExpensiveModel = byCost[byCost.length - 1].modelId;
  }

  return stats;
}

function generateComparisonReport(evalResults: EvalResults): string {
  const { config, results, stats } = evalResults;
  
  let md = `# Model Evaluation Report

**Run ID:** ${evalResults.runId}
**Started:** ${evalResults.startedAt}
**Completed:** ${evalResults.completedAt || 'N/A'}

## Prompt

\`\`\`
${config.prompt}
\`\`\`

${config.systemPrompt ? `### System Prompt\n\n\`\`\`\n${config.systemPrompt}\n\`\`\`\n` : ''}

## Summary

| Metric | Value |
|--------|-------|
| Models Tested | ${stats.totalModels} |
| Successful | ${stats.successCount} |
| Failed | ${stats.failureCount} |
| Total Cost | $${stats.totalCost.toFixed(6)} |
| Total Tokens | ${stats.totalInputTokens + stats.totalOutputTokens} |
| Fastest | ${stats.fastestModel || 'N/A'} (${stats.fastestTime || 0}ms) |
| Slowest | ${stats.slowestModel || 'N/A'} (${stats.slowestTime || 0}ms) |
| Cheapest | ${stats.cheapestModel || 'N/A'} ($${stats.cheapestCost?.toFixed(6) || '0'}) |

## Results by Model

| Model | Tier | Time | Cost | Tokens (in→🧠→out) | Status |
|-------|------|------|------|---------------------|--------|
`;

  for (const result of results) {
    const status = result.success ? '✅' : `❌ ${result.error?.slice(0, 30)}...`;
    const tokenInfo = result.reasoningTokens 
      ? `${result.inputTokens}→🧠${result.reasoningTokens}→${result.visibleTokens}`
      : `${result.inputTokens || 0}→${result.outputTokens || 0}`;
    md += `| ${result.model.displayName} | ${result.model.tier} | ${result.totalTime || 0}ms | $${(result.cost || 0).toFixed(6)} | ${tokenInfo} | ${status} |\n`;
  }

  md += `\n## Responses\n\n`;

  for (const result of results.filter(r => r.success)) {
    md += `### ${result.model.displayName}\n\n`;
    
    // Show reasoning tokens if present
    const tokenBreakdown = result.reasoningTokens 
      ? `**Tokens:** ${result.inputTokens} in → 🧠${result.reasoningTokens} reasoning + ${result.visibleTokens} visible`
      : `**Tokens:** ${result.inputTokens}→${result.outputTokens}`;
    
    md += `**Time:** ${result.totalTime}ms | **Cost:** $${result.cost?.toFixed(6)} | ${tokenBreakdown}\n\n`;
    md += `${result.response}\n\n---\n\n`;
  }

  return md;
}

function saveResults(outputDir: string, evalResults: EvalResults): void {
  // Save manifest.json
  fs.writeFileSync(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify({
      runId: evalResults.runId,
      startedAt: evalResults.startedAt,
      completedAt: evalResults.completedAt,
      config: evalResults.config,
      stats: evalResults.stats,
    }, null, 2)
  );

  // Save all results
  fs.writeFileSync(
    path.join(outputDir, 'results.json'),
    JSON.stringify(evalResults.results.map(r => ({
      ...r,
      model: undefined, // Don't duplicate model definition
      rawResponse: undefined, // Save separately
    })), null, 2)
  );

  // Save comparison report
  fs.writeFileSync(
    path.join(outputDir, 'comparison.md'),
    generateComparisonReport(evalResults)
  );

  // Save leaderboard
  const leaderboard = generateLeaderboard(evalResults);
  fs.writeFileSync(
    path.join(outputDir, 'leaderboard.md'),
    leaderboard
  );
}

function generateLeaderboard(evalResults: EvalResults): string {
  const successful = evalResults.results.filter(r => r.success);
  
  let md = `# Model Leaderboard

## 🏎️ Speed Ranking (Fastest First)

| Rank | Model | Time | Tier |
|------|-------|------|------|
`;

  const bySpeed = [...successful].sort((a, b) => (a.totalTime || 0) - (b.totalTime || 0));
  bySpeed.forEach((r, i) => {
    md += `| ${i + 1} | ${r.model.displayName} | ${r.totalTime}ms | ${r.model.tier} |\n`;
  });

  md += `\n## 💰 Cost Ranking (Cheapest First)

| Rank | Model | Cost | Tier |
|------|-------|------|------|
`;

  const byCost = [...successful].sort((a, b) => (a.cost || 0) - (b.cost || 0));
  byCost.forEach((r, i) => {
    md += `| ${i + 1} | ${r.model.displayName} | $${r.cost?.toFixed(6)} | ${r.model.tier} |\n`;
  });

  md += `\n## 📊 Tokens/Dollar (Best Value First)

| Rank | Model | Output Tokens/$ | Tier |
|------|-------|-----------------|------|
`;

  const byValue = [...successful]
    .filter(r => r.cost && r.cost > 0)
    .sort((a, b) => {
      const aValue = (a.outputTokens || 0) / (a.cost || 1);
      const bValue = (b.outputTokens || 0) / (b.cost || 1);
      return bValue - aValue;
    });
  byValue.forEach((r, i) => {
    const value = ((r.outputTokens || 0) / (r.cost || 1)).toFixed(0);
    md += `| ${i + 1} | ${r.model.displayName} | ${value} | ${r.model.tier} |\n`;
  });

  return md;
}

// ============================================================================
// Progress Display
// ============================================================================

function printHeader(): void {
  console.log(`
${c.title('╔══════════════════════════════════════════════════════════════╗')}
${c.title('║           🧪 OpenAI Model Evaluation Harness                 ║')}
${c.title('╚══════════════════════════════════════════════════════════════╝')}
`);
}

function printModelPlan(models: ModelDefinition[], config: EvalConfig): void {
  console.log(c.bold('📋 Models to test:'));
  console.log();

  const byTier = new Map<ModelTier, ModelDefinition[]>();
  for (const model of models) {
    const list = byTier.get(model.tier) || [];
    list.push(model);
    byTier.set(model.tier, list);
  }

  for (const [tier, tierModels] of byTier) {
    console.log(`  ${c.tier(tier)} (${tierModels.length})`);
    for (const model of tierModels) {
      const price = `$${model.pricing.input}/$${model.pricing.output}`;
      console.log(`    ${c.model(model.id)} ${c.dim(price)}`);
    }
  }
  console.log();

  // Estimate total cost (very rough - assumes ~100 input tokens, ~500 output)
  const estimatedInputTokens = 100;
  const estimatedOutputTokens = 500;
  let totalEstimate = 0;
  for (const model of models) {
    totalEstimate += estimateCost(model.id, estimatedInputTokens, estimatedOutputTokens);
  }

  console.log(c.bold('💰 Estimated cost:'), c.money(totalEstimate.toFixed(4)), c.dim('(assuming ~100 in / ~500 out tokens per model)'));
  console.log();
}

function printProgress(
  status: 'starting' | 'running' | 'completed' | 'failed',
  modelId: string,
  index: number,
  total: number,
  result?: ModelRunResult,
  config?: EvalConfig
): void {
  const progress = `[${String(index + 1).padStart(2)}/${total}]`;
  
  switch (status) {
    case 'starting':
      process.stdout.write(`${c.dim(progress)} ${c.model(modelId)} ... `);
      break;
    case 'completed': {
      // Show reasoning tokens if present
      const reasoningInfo = result?.reasoningTokens 
        ? `${colors.magenta}🧠${result.reasoningTokens}${colors.reset}+`
        : '';
      const tokenInfo = `${result?.inputTokens}→${reasoningInfo}${result?.visibleTokens || result?.outputTokens}`;
      
      console.log(
        c.success('✓'),
        c.time(`${result?.totalTime}ms`),
        c.money((result?.cost || 0).toFixed(6)),
        c.dim(`${tokenInfo} tokens`)
      );

      // Show response - full by default for short responses, or if requested
      if (result?.response) {
        const showFull = config.showFullResponses || result.response.length < 500;
        if (showFull) {
          console.log(`      ${c.dim('─'.repeat(60))}`);
          // Indent response lines
          const lines = result.response.split('\n');
          for (const line of lines) {
            console.log(`      ${line}`);
          }
          console.log(`      ${c.dim('─'.repeat(60))}`);
        } else {
          // Just show a preview
          const preview = result.response.replace(/\n/g, ' ').slice(0, 120);
          console.log(`      ${c.dim('→')} ${preview}... ${c.dim(`(${result.response.length} chars)`)}`);
        }
      }
      break;
    }
    case 'failed': {
      // Show full error for debugging
      console.log(c.error('✗'));
      // Parse and display error nicely
      if (result?.error) {
        try {
          const match = result.error.match(/API error (\d+): (.+)/s);
          if (match) {
            const [, status, body] = match;
            const parsed = JSON.parse(body);
            console.log(`      ${c.error(`HTTP ${status}:`)} ${parsed.error?.message || body}`);
            if (parsed.error?.param) {
              console.log(`      ${c.dim('Param:')} ${parsed.error.param}`);
            }
          } else {
            console.log(`      ${c.error(result.error.slice(0, 200))}`);
          }
        } catch {
          console.log(`      ${c.error(result.error.slice(0, 200))}`);
        }
      }
      // Show what we sent
      if (result?.requestBody) {
        const body = result.requestBody as Record<string, unknown>;
        const params = [];
        if (body.max_tokens) params.push(`max_tokens=${body.max_tokens}`);
        if (body.max_completion_tokens) params.push(`max_completion_tokens=${body.max_completion_tokens}`);
        if (body.temperature !== undefined) params.push(`temp=${body.temperature}`);
        if (body.reasoning_effort) params.push(`reasoning=${body.reasoning_effort}`);
        if (params.length > 0) {
          console.log(`      ${c.dim('Sent:')} ${params.join(', ')}`);
        }
      }
      break;
    }
  }
}

function printSummary(stats: EvalStats, outputDir: string): void {
  console.log();
  console.log(c.title('═══════════════════════════════════════════════════════════════'));
  console.log(c.bold('📊 Summary'));
  console.log();
  console.log(`  ${c.success('✓ Success:')} ${stats.successCount}/${stats.totalModels}`);
  if (stats.failureCount > 0) {
    console.log(`  ${c.error('✗ Failed:')} ${stats.failureCount}`);
  }
  console.log(`  ${c.bold('💰 Total Cost:')} ${c.money(stats.totalCost.toFixed(6))}`);
  console.log(`  ${c.bold('📝 Tokens:')} ${stats.totalInputTokens} in / ${stats.totalOutputTokens} out`);
  console.log();
  if (stats.fastestModel) {
    console.log(`  ${c.bold('🏎️  Fastest:')} ${c.model(stats.fastestModel)} ${c.time(`${stats.fastestTime}ms`)}`);
  }
  if (stats.slowestModel) {
    console.log(`  ${c.bold('🐢 Slowest:')} ${c.model(stats.slowestModel)} ${c.time(`${stats.slowestTime}ms`)}`);
  }
  if (stats.cheapestModel) {
    console.log(`  ${c.bold('💸 Cheapest:')} ${c.model(stats.cheapestModel)} ${c.money(stats.cheapestCost?.toFixed(6) || '0')}`);
  }
  console.log();
  console.log(c.title('═══════════════════════════════════════════════════════════════'));
  console.log();
  console.log(`${c.bold('📁 Results saved to:')} ${c.info(outputDir)}`);
  console.log();
}

// ============================================================================
// Main Runner
// ============================================================================

async function runEvaluation(config: EvalConfig): Promise<EvalResults> {
  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const startedAt = new Date().toISOString();

  // Select models
  const models = selectModels(config);
  printModelPlan(models, config);

  if (config.dryRun) {
    console.log(c.warning('🔍 Dry run mode - no API calls will be made'));
    console.log();
    process.exit(0);
  }

  // Check API key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(c.error('❌ OPENAI_API_KEY environment variable is required'));
    process.exit(1);
  }

  // Create output directory
  const outputDir = createOutputDir(config);
  console.log(c.info(`📁 Output: ${outputDir}`));
  console.log();

  // Run each model
  const results: ModelRunResult[] = [];
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    printProgress('starting', model.id, i, models.length);

    const result = await callModel(model, config, apiKey);
    results.push(result);

    if (result.success) {
      printProgress('completed', model.id, i, models.length, result, config);
    } else {
      printProgress('failed', model.id, i, models.length, result, config);
    }

    // Save individual result
    saveModelResult(outputDir, result);
  }

  // Calculate stats
  const stats = calculateStats(results);

  // Build final results
  const evalResults: EvalResults = {
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    config,
    results,
    stats,
  };

  // Save aggregate results
  saveResults(outputDir, evalResults);

  // Print summary
  printSummary(stats, outputDir);

  return evalResults;
}

// ============================================================================
// Entry Point
// ============================================================================

async function main(): Promise<void> {
  printHeader();

  const config = parseArgs();

  if (!config.prompt) {
    console.error(c.error('❌ --prompt is required'));
    console.log();
    console.log('Run with --help for usage information');
    process.exit(1);
  }

  // Load context files and prepend to system prompt
  if (config.contextFiles && config.contextFiles.length > 0) {
    const contextParts: string[] = [];
    console.log(c.bold('📚 Context files:'));
    for (const filePath of config.contextFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const filename = path.basename(filePath);
        contextParts.push(`=== ${filename} ===\n${content}`);
        console.log(`   ${c.success('✓')} ${filename} ${c.dim(`(${content.length} chars)`)}`);
      } catch (err: any) {
        console.error(`   ${c.error('✗')} ${filePath}: ${err.message}`);
      }
    }
    if (contextParts.length > 0) {
      const contextBlock = `<context>\n${contextParts.join('\n\n')}\n</context>\n\n`;
      config.systemPrompt = config.systemPrompt 
        ? contextBlock + config.systemPrompt 
        : contextBlock + 'You are a helpful assistant. Use the provided context to answer questions.';
    }
    console.log();
  }

  console.log(c.bold('📝 Prompt:'), c.dim(config.prompt.slice(0, 80) + (config.prompt.length > 80 ? '...' : '')));
  if (config.systemPrompt) {
    const sysLen = config.systemPrompt.length;
    const preview = config.systemPrompt.replace(/\n/g, ' ').slice(0, 60);
    console.log(c.bold('🔧 System:'), c.dim(`${preview}...`), c.dim(`(${sysLen} chars)`));
  }
  console.log();

  await runEvaluation(config);
}

main().catch(error => {
  console.error(c.error(`\n❌ Fatal error: ${error.message}`));
  if (error.stack) {
    console.error(c.dim(error.stack));
  }
  process.exit(1);
});
