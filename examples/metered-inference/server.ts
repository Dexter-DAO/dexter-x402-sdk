/**
 * Metered inference — pay per OUTPUT token, capped.
 *
 *   POST /v1/complete { "prompt": "...", "maxTokens": 400 }
 *
 * REAL inference behind the @dexterai/x402 tab seller. Backing is
 * auto-selected from whichever provider key is present (ANTHROPIC_API_KEY ->
 * claude-haiku-4-5 preferred; OPENAI_API_KEY -> gpt-5.4-nano fallback), and
 * both providers report authoritative output-token usage at stream end. One
 * middleware advertises BOTH payment rails in a single 402:
 *
 *   tab rail    — the buyer opens a tab and is metered per output token
 *                 actually served: 10 USDC microunits ($0.00001) per token,
 *                 streamed over SSE with a running charge ticker.
 *   exact rail  — one-shot buyers prepay the flat sticker price ($0.01) for a
 *                 completion capped at MAX_OUTPUT_TOKENS — this is exactly the
 *                 "pre-load a balance" experience the tab replaces.
 *
 * Metering discipline (the meter has no refund path, so never over-charge):
 *   1. Per streamed text chunk, deliberately UNDER-estimate its token count
 *      (floor(chars / 5); real English averages ~4 chars/token) and
 *      meter.charge(estimate) BEFORE meter.send(chunk). charge() fails closed
 *      against the buyer's signed-voucher budget.
 *   2. At stream end, read the provider's authoritative output-token count
 *      (Anthropic usage.output_tokens / OpenAI usage.completion_tokens) and
 *      charge the difference, so settled == output_tokens x price exactly.
 *
 * Crystallization cadence: lockCadence is deliberately NOT set anywhere —
 * as of 5.3.1 the facilitator owns it server-side. Leave it unset.
 *
 * Self-test (proves the inference backing without touching payments):
 *   npx tsx server.ts --selftest
 */

import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { Connection } from '@solana/web3.js';
import { tabOrExactMiddleware, requireTab, openSse } from '@dexterai/x402/tab/seller';
import type { X402Request } from '@dexterai/x402/server';

// ── Pricing — integer USDC microunits (USDC has 6 decimals) ─────────────────
//
// The price per token lives HERE, in the handler's constants — not on chain,
// not in the facilitator. Serving cost on claude-haiku-4-5 is $5/MTok output
// = 5 microunits per token, so 10 microunits per token is margin-positive.

const PRICE_MICROS_PER_TOKEN = 10n; // $0.00001 per output token
const MAX_OUTPUT_TOKENS = 1000; // hard per-request ceiling
const DEFAULT_MAX_TOKENS = 256;
const STICKER_MICROS = PRICE_MICROS_PER_TOKEN * BigInt(MAX_OUTPUT_TOKENS); // 10000 = $0.01

/** 6-decimal USDC micros -> HumanAmount string ('10' -> '0.000010'). */
function microsToHuman(micros: bigint): string {
  const whole = micros / 1_000_000n;
  const frac = (micros % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${frac}`;
}

const PER_TOKEN_HUMAN = microsToHuman(PRICE_MICROS_PER_TOKEN); // '0.000010'
const STICKER_HUMAN = microsToHuman(STICKER_MICROS); // '0.010000'

// ── Config ───────────────────────────────────────────────────────────────────

// Receive-only payout pubkey. No key material anywhere in this process.
const SELLER_PUBKEY = process.env.SELLER_PUBKEY ?? 'FKF63wLt122SLDNPBfpDgrMcQzxtdLfLyrUS1KziRR1h';
const PORT = Number(process.env.PORT ?? 4021);
// One RPC read per buyer session (registration verify); never on the 402 path.
const RPC_URL =
  process.env.HELIUS_RPC_URL ??
  process.env.SOLANA_RPC_ENDPOINT ??
  'https://api.mainnet-beta.solana.com';

// ── The inference backing — REAL provider calls, provider-agnostic meter ────
//
// Auto-select: Anthropic if ANTHROPIC_API_KEY is set, else OpenAI if
// OPENAI_API_KEY is set. Override with INFERENCE_PROVIDER=anthropic|openai.
// Both providers stream text AND report an authoritative output-token count
// at stream end — which is all the meter needs.

type Provider = 'anthropic' | 'openai';

const PROVIDER: Provider | undefined = (() => {
  const forced = process.env.INFERENCE_PROVIDER;
  if (forced === 'anthropic' || forced === 'openai') return forced;
  if (forced) {
    console.error(`INFERENCE_PROVIDER must be "anthropic" or "openai", got "${forced}"`);
    process.exit(1);
  }
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return undefined;
})();

if (!PROVIDER) {
  console.error('Set ANTHROPIC_API_KEY or OPENAI_API_KEY — this demo serves REAL inference.');
  process.exit(1);
}

const MODEL =
  process.env.INFERENCE_MODEL ?? (PROVIDER === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-5.4-nano');

interface CompletionUsage {
  /** Provider-reported model id for the completion. */
  model: string;
  /** Authoritative billed output tokens (Anthropic output_tokens / OpenAI
   *  completion_tokens — the latter includes reasoning tokens, which the
   *  buyer pays for like any other output token). */
  outputTokens: number;
  /** Full concatenated text (for the buffered exact rail). */
  text: string;
}

/** Stream one completion; call onText per text chunk; return authoritative usage. */
async function streamCompletion(
  prompt: string,
  maxTokens: number,
  onText: (text: string) => Promise<void>,
): Promise<CompletionUsage> {
  if (PROVIDER === 'anthropic') {
    const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    let text = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        await onText(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    return { model: final.model, outputTokens: final.usage.output_tokens, text };
  }

  const openai = new OpenAI(); // reads OPENAI_API_KEY
  const stream = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_completion_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true }, // final chunk carries usage
  });
  let text = '';
  let model = MODEL;
  let outputTokens = 0;
  for await (const chunk of stream) {
    model = chunk.model ?? model;
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      text += delta;
      await onText(delta);
    }
    if (chunk.usage) outputTokens = chunk.usage.completion_tokens;
  }
  return { model, outputTokens, text };
}

// ── Self-test: one real provider call, no payments involved ─────────────────

if (process.argv.includes('--selftest')) {
  let streamed = '';
  const usage = await streamCompletion('Reply with exactly: METERED-OK', 32, async (t) => {
    streamed += t;
  });
  console.log(`selftest provider=${PROVIDER} model=${usage.model}`);
  console.log(`selftest text=${JSON.stringify(streamed)}`);
  console.log(`selftest authoritative output_tokens=${usage.outputTokens}`);
  console.log(
    `selftest tab price for this completion = ${usage.outputTokens} tokens x ${PER_TOKEN_HUMAN} USDC = ${microsToHuman(BigInt(usage.outputTokens) * PRICE_MICROS_PER_TOKEN)} USDC`,
  );
  process.exit(0);
}

// ── Payment middleware — the ONLY payment middleware on the route ────────────

const connection = new Connection(RPC_URL, 'confirmed');

const paywall = tabOrExactMiddleware({
  connection,
  sellerPubkey: SELLER_PUBKEY,
  network: 'solana:mainnet',
  // The middleware price is the STICKER (advertised in the 402, and what the
  // exact rail charges flat). The tab rail's per-token bill is set on openSse
  // in the handler below.
  perUnit: STICKER_HUMAN,
  description: `Metered Claude inference: ${PER_TOKEN_HUMAN} USDC per output token (tab) or ${STICKER_HUMAN} flat for up to ${MAX_OUTPUT_TOKENS} tokens (exact)`,
  // facilitatorUrl omitted -> https://x402.dexter.cash
  // lockCadence omitted -> facilitator-owned crystallization cadence (do not tune)
});

// ── Request validation (BEFORE the paywall, so bad input costs nothing) ─────

interface CompleteBody {
  prompt: string;
  maxTokens: number;
}

function validateBody(req: Request, res: Response, next: express.NextFunction): void {
  const body = req.body as { prompt?: unknown; maxTokens?: unknown } | undefined;
  const prompt = body?.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    res.status(400).json({ error: 'invalid_request', detail: 'body.prompt must be a non-empty string' });
    return;
  }
  let maxTokens = DEFAULT_MAX_TOKENS;
  if (body?.maxTokens !== undefined) {
    if (typeof body.maxTokens !== 'number' || !Number.isInteger(body.maxTokens) || body.maxTokens < 1) {
      res.status(400).json({ error: 'invalid_request', detail: 'body.maxTokens must be a positive integer' });
      return;
    }
    maxTokens = Math.min(body.maxTokens, MAX_OUTPUT_TOKENS);
  }
  res.locals.complete = { prompt, maxTokens } satisfies CompleteBody;
  next();
}

// ── The route ────────────────────────────────────────────────────────────────

const app = express();

// Free, unpaid: lets buyers (and demos) read the price card without a wallet.
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    provider: PROVIDER,
    model: MODEL,
    pricing: {
      perOutputTokenMicros: PRICE_MICROS_PER_TOKEN.toString(),
      perOutputTokenUsdc: PER_TOKEN_HUMAN,
      exactFlatUsdc: STICKER_HUMAN,
      maxOutputTokensPerRequest: MAX_OUTPUT_TOKENS,
    },
  });
});

app.post('/v1/complete', express.json(), validateBody, paywall, async (req, res) => {
  const { prompt, maxTokens } = res.locals.complete as CompleteBody;

  // Express does NOT route rejected async handlers to error middleware —
  // a bare throw here would kill the request without a response. Full try/catch.
  try {
    const paid = (req as X402Request).x402;

    if (paid) {
      // ── Exact rail: flat sticker price, buffered JSON response ───────────
      const usage = await streamCompletion(prompt, maxTokens, async () => {});
      res.json({
        paidVia: 'exact',
        model: usage.model,
        text: usage.text,
        outputTokens: usage.outputTokens,
        pricing: { flatMicros: STICKER_MICROS.toString(), flatUsdc: STICKER_HUMAN },
        transaction: paid.transaction,
      });
      return;
    }

    // ── Tab rail: metered per output token, streamed over SSE ──────────────
    const tab = requireTab(req);
    // "The middleware price is the sticker; the meter price is the bill."
    const meter = openSse(res, { tab, perUnit: PER_TOKEN_HUMAN });

    let unitsCharged = 0;
    try {
      const usage = await streamCompletion(prompt, maxTokens, async (text) => {
        // Deliberate UNDER-estimate: floor(chars/5) is below the real token
        // count for any natural text (~4 chars/token English, ~1 char/token
        // CJK). charge() has no refund path, so mid-stream we only ever
        // charge what we are certain of; the true-up below settles exact.
        const estimate = Math.floor(text.length / 5);
        if (estimate > 0) {
          await meter.charge(estimate); // fails closed on voucher-budget exceed
          unitsCharged += estimate;
        }
        meter.send(
          JSON.stringify({
            text,
            tokensCharged: unitsCharged,
            usdcAccrued: microsToHuman(BigInt(unitsCharged) * PRICE_MICROS_PER_TOKEN),
          }),
        );
      });

      // True-up against the provider's authoritative accounting (Anthropic:
      // final message_delta usage.output_tokens; OpenAI: final stream chunk
      // usage.completion_tokens) — ground truth for what the provider billed
      // us and what the buyer consumed.
      const outputTokens = usage.outputTokens;
      const trueUp = outputTokens - unitsCharged;
      if (trueUp > 0) {
        await meter.charge(trueUp);
        unitsCharged += trueUp;
      }
      // trueUp < 0 is unreachable with the /5 floor; if it ever happened we
      // keep the (over)charge — the meter cannot refund — which is exactly why
      // the mid-stream estimate MUST under-count.

      const settledMicros = BigInt(unitsCharged) * PRICE_MICROS_PER_TOKEN;
      meter.send(
        JSON.stringify({
          done: true,
          paidVia: 'tab',
          channelId: tab.channelId,
          model: usage.model,
          outputTokens,
          tokensCharged: unitsCharged,
          settledMicros: settledMicros.toString(),
          settledUsdc: microsToHuman(settledMicros),
        }),
      );
      await meter.end();
    } catch (streamErr) {
      // charge() throws ScopeViolationError when the buyer's voucher budget is
      // exhausted mid-stream; the meter has already persisted what WAS
      // delivered (recordDelivered fires on every terminal path). SSE headers
      // are out, so just close the stream — the buyer settles the delivered
      // amount at tab close.
      console.error('[metered-inference] stream terminated:', (streamErr as Error).message);
      if (!res.writableEnded) res.end();
    }
  } catch (err) {
    console.error('[metered-inference] request failed:', (err as Error).message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'upstream_unavailable', detail: (err as Error).message });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`metered-inference listening on :${PORT}`);
  console.log(`  backing          ${PROVIDER} / ${MODEL}`);
  console.log(`  seller payTo     ${SELLER_PUBKEY}`);
  console.log(`  tab price        ${PER_TOKEN_HUMAN} USDC per output token`);
  console.log(`  exact price      ${STICKER_HUMAN} USDC flat (up to ${MAX_OUTPUT_TOKENS} tokens)`);
  // Host only — RPC URLs often embed API keys; never log them whole.
  console.log(`  rpc              ${new URL(RPC_URL).host}`);
});
