# Metered inference — pay per token, capped

Real LLM inference sold per **output token** over an x402 tab. The buyer
opens a tab instead of pre-loading a balance: tokens stream, a USDC meter ticks
per token, and ONE on-chain settle at close pays for exactly what was served.

```
POST /v1/complete
{ "prompt": "Explain tabs in one paragraph", "maxTokens": 400 }
```

One middleware (`tabOrExactMiddleware`) advertises both payment rails in a
single standard x402 402 challenge:

| Rail | Who it's for | What you pay |
|---|---|---|
| `tab` | Agents, streaming buyers | **0.000010 USDC per output token actually served.** A 137-token answer settles at 0.001370 USDC. |
| `exact` | One-shot buyers, catalog verifiers | **0.01 USDC flat** for a completion capped at 1,000 output tokens — the prepaid experience the tab replaces. |

The backing is REAL: every completion is a live provider call. The server
auto-selects from whichever key is present (no key, no server):

| Key | Default model | Authoritative usage source |
|---|---|---|
| `ANTHROPIC_API_KEY` (preferred) | `claude-haiku-4-5` | final `message_delta` → `usage.output_tokens` |
| `OPENAI_API_KEY` | `gpt-5.4-nano` | final stream chunk → `usage.completion_tokens` (with `stream_options: { include_usage: true }`) |

Force one with `INFERENCE_PROVIDER=anthropic|openai`; pick a model with
`INFERENCE_MODEL`.

## Quickstart (seller)

```bash
npm install
cp .env.example .env       # set ANTHROPIC_API_KEY or OPENAI_API_KEY — the only required secret
npm run selftest           # one real provider call; prints token usage + what the tab would bill
npm start                  # boots on :4021
```

Prove the paywall without paying:

```bash
curl -s -X POST http://localhost:4021/v1/complete \
  -H 'content-type: application/json' \
  -d '{"prompt":"hello"}' | head -c 400
# -> HTTP 402 with accepts[]: scheme "tab" AND scheme "exact", payTo, USDC asset
curl -s http://localhost:4021/healthz   # free price card
```

## Quickstart (buyer)

```bash
npm run buyer:discover     # no wallet: parse the tab offer out of the 402
npm run buyer:oneshot -- "Explain x402 tabs briefly"   # exact rail via payAndFetch
npm run buyer:tab     -- "Explain x402 tabs briefly"   # tab rail: stream + meter + settle
```

- `discover` needs nothing.
- `oneshot` needs `SOLANA_PRIVATE_KEY` (base58) holding USDC. Without it the
  snippet generates an ephemeral keypair so you can watch the payment path run
  and fail cleanly with `insufficient_funds`.
- `tab` needs a funded Swig vault (`BUYER_SWIG`, `BUYER_VAULT_PDA`,
  `PASSKEY_KEY_FILE`, `FEE_PAYER_KEY_FILE`) — the same credential set as
  `examples/live-chain/demo-app`. On close it prints the settle transaction and
  a Solscan link.

## The price math

All pricing is **integer USDC microunits** (USDC has 6 decimals), set in the
handler — not on chain, not in the facilitator:

```
PRICE_MICROS_PER_TOKEN = 10          # 10 microunits = $0.00001 per output token
MAX_OUTPUT_TOKENS      = 1000        # hard per-request ceiling
STICKER_MICROS         = 10 × 1000   # = 10000 microunits = $0.01 flat (exact rail)
```

Serving cost: `claude-haiku-4-5` output is $5/MTok = **5 microunits per
token**, so the 10-microunit price is 2x serving cost — every token served is
margin-positive (`gpt-5.4-nano` output is cheaper still).

One provider nuance: OpenAI's `completion_tokens` includes reasoning tokens on
reasoning models — the buyer pays for every output token the provider bills,
visible or not. Anthropic's `output_tokens` is what you'd expect. Either way
the number is the provider's own accounting, not an estimate.

Worst case per request: `1000 tokens × 10 micros = 10000 micros = $0.01`,
which is why the buyer signs a `perUnitCap` of `0.01` per request — the voucher
budget always covers the ceiling, and unused budget carries forward on the
channel.

**The middleware price is the sticker; the meter price is the bill.**
`tabOrExactMiddleware({ perUnit: '0.010000' })` is what the 402 advertises (and
what the exact rail charges flat). The tab rail's real per-token price is set
where the charging happens:

```ts
const meter = openSse(res, { tab, perUnit: '0.000010' });  // per OUTPUT token
```

## How the metering stays exact (and never over-charges)

Provider stream chunks are multi-token text fragments, not 1:1 tokens, and the
meter has **no refund path** (`charge()` is monotonic). So the handler:

1. **Under-estimates per chunk** — `floor(chars / 5)` undercounts typical
   natural text (English averages ~4 chars/token; CJK ~1 char/token).
   `meter.charge(estimate)` runs BEFORE `meter.send(chunk)` and fails closed
   against the buyer's signed-voucher budget.
2. **Trues up at stream end** — the provider's final usage carries the
   authoritative output-token count; the handler charges the difference,
   clamped at zero, so `settled == output_tokens × price`. Content averaging
   more than 5 chars/token (whitespace runs, long words, indented code) can
   make the estimator overshoot — the clamp keeps the overshoot, because the
   meter has no refund path. That's the deal: the conservative floor bounds
   the overshoot, it doesn't eliminate it.

Each SSE event carries the running meter (`tokensCharged`, `usdcAccrued`) so
the buyer watches the bill tick per token; the final event reports the
provider's token count next to what the meter settled — they match.

**Frames are base64-wrapped (`b64:<base64(JSON)>`), not raw JSON.** The 5.3.1
SSE meter transforms payloads asymmetrically across the hop: `meter.send()`
escapes only RAW newlines (a no-op for `JSON.stringify` output), while the
buyer-side `tab.stream()` unwrapper rewrites every literal `\n` back into a
raw newline. Raw-JSON frames whose text contains a newline — most multi-line
completions — arrive as invalid JSON and get silently dropped by any
parse-guarded buyer. Base64's alphabet has no backslash and no newline, so
frames cross the meter byte-identical. The codec lives in `sse-frame.ts`;
`npm run check:frames` proves both the corruption and the fix mechanically.

If the buyer's voucher budget runs out mid-stream, `charge()` throws, the SDK
has already persisted what WAS delivered (`recordDelivered` fires on every
terminal path, including client disconnect), and the buyer settles the
delivered amount at close. A buyer cannot consume tokens it didn't sign for; a
seller cannot bill tokens it didn't serve.

## What the seller needs (and doesn't)

- **Needs:** one provider key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` — the
  inference backing), a Solana RPC URL (one registration read per buyer
  session — never on the 402 path), and a receive-only payout pubkey. That's
  the entire configuration.
- **Doesn't need:** a vault, a wallet, key material of any kind, or a
  facilitator account. `facilitatorUrl` is omitted and defaults to
  `https://x402.dexter.cash`.
- **Do not tune `lockCadence`.** It is deliberately unset in this example: as
  of `@dexterai/x402@5.3.1` the facilitator owns crystallization cadence
  server-side. It is a risk dial, not a performance dial — ship without it.
- **Durability:** `tabOrExactMiddleware` uses the in-memory channel ledger, so
  delivered-counters reset on restart (buyer-signed vouchers remain the source
  of truth for settlement — you can't lose money, only re-grant unspent
  budget). For a production seller, compose `tabChallengeMiddleware` +
  `tabMiddleware({ ledger: new FileChannelLedger(dir), ... })`.

## How you observe that you were paid

`tab.cumulative()` (what the buyer signed) and `tab.deliveredCumulative()`
(what you served) are accrual counters, not settlement confirmations. The
BUYER receives the settle transaction at `tab.close()`. As the seller, watch
your payout address's USDC token account — the demo seller is
[`FKF63...RR1h`](https://solscan.io/account/FKF63wLt122SLDNPBfpDgrMcQzxtdLfLyrUS1KziRR1h).

## Files

| File | What it is |
|---|---|
| `server.ts` | The seller: Express + `tabOrExactMiddleware` + per-token SSE meter + real provider streaming (Anthropic or OpenAI). `--selftest` proves the inference backing with one provider call. |
| `buyer-snippet.ts` | The buyer: `discover` (parse the 402), `oneshot` (`payAndFetch`, exact rail), `tab` (`openTab` → `tab.stream()` → `tab.close()`). |
| `sse-frame.ts` | The `b64:` frame codec both sides share — the 5.3.1 meter corrupts raw-JSON frames containing `\n`; base64 crosses byte-identical. |
| `frame-roundtrip-check.ts` | Mechanical proof (`npm run check:frames`): a multi-line frame through the REAL `openSse` meter + the 5.3.1 client unescape — raw JSON corrupts, `b64:` round-trips deep-equal. |
| `.env.example` | Every knob, documented. One provider key is required — `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` both work (OpenAI is the backing currently proven live). |
