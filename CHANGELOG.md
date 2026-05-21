# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Documentation
- **README restructured to lead with the canonical paths.** The Quick Start now opens with `payAndFetch` (the version-agnostic 2026+ client) instead of the deprecated `wrapFetch`. New "Discovery (bazaar extension)" section documents the 3.8.0 `bazaarExtension` / `declareDiscoveryExtension` API, which had shipped but was undocumented. Sponsored Access reframed around the MCP-agent reality it already serves. The v1-era pricing helpers (Dynamic Pricing, Token Pricing, Access Pass, Stripe) collapsed from ~300 lines of feature sections into a single "Legacy capabilities" table with migration targets. Stale marketplace counts removed. README is ~40% shorter.

### Fixed
- **`PayResult` no longer reports a phantom network on unpaid responses.** When `payAndFetch` hits an endpoint that returns 200 (or any non-402) directly, the result is now `{ ok: true, paid: false, response }` instead of `{ ok: true, response, amountPaid: '0', network: { caip2: '', bare: '', family: 'evm' } }`. The old placeholder poisoned any downstream analytics that grouped by network — every free-endpoint hit registered as an empty-CAIP-2 EVM payment. The `ok: true` variant is now discriminated by `paid: true | false`; callers should narrow on `paid` before reading `network` / `amountPaid` / `txSignature`. Strategy implementations (v1, v2) also set `paid: true` on their success path. (Source: `payment/dispatcher.ts:104` had a `// not-applicable placeholder` self-flag that finally got the type-level fix it was waiting for.)
- **`payAndFetch` no longer reports `timeout` on a payment that may have settled.** Previously a single 15s deadline governed the whole paid call — both the on-chain settlement and the wait for the merchant's response. A merchant slower than 15s (research / scout / agent endpoints routinely are) had its payment settled, then the abort fired and `payAndFetch` returned `{ ok: false, reason: 'timeout' }` — which reads as "safe to retry" and caused a silent double-charge. The timeout is now two-phase: a short pre-payment deadline (`timeoutMs`, default 15000) covers the unpaid probe and build/sign; a long post-payment deadline (new `responseTimeoutMs`, default 120000) covers the wait for the merchant's response. A pre-payment abort still yields `reason: 'timeout'` (no money moved, safe to retry). A post-payment abort yields the new `reason: 'payment_unconfirmed'` — the payment authorization was sent and may have settled on-chain, so a consumer must NOT blind-retry; the `detail` field spells this out. The `ok: true; paid: true` variant's `response` is now `Response | undefined` to accommodate a future confirmed-but-unanswered result. Both v1 and v2 strategies are fixed. (On-chain settlement confirmation, which upgrades many `payment_unconfirmed` results into confirmed `paid: true`, lands in a follow-up. Reported via a bake-off audit — see `FINDINGS-pay-timeout-double-charge-2026-05-21.md`.)

### Deprecated

Internal hygiene pass ahead of 4.0 and 5.0. No runtime behavior changes — every symbol below still works exactly as before. JSDoc `@deprecated` markers now surface editor warnings so consumers can migrate ahead of the removal releases.

**Slated for removal in 4.0:**

- `x402AccessPass`, `X402AccessPassConfig`, `X402AccessPassRequest` (`@dexterai/x402/server`) — use per-request `x402Middleware` with `payAndFetch` clients.
- `useAccessPass`, `UseAccessPassConfig`, `UseAccessPassReturn` (`@dexterai/x402/react`) — use `useX402Payment` for per-request payments.
- `createDynamicPricing`, `formatPricing`, `DynamicPricingConfig`, `DynamicPricing`, `PriceQuote` (`@dexterai/x402/server`) — compute the price per request in your handler and pass it to `x402Middleware`.
- `createTokenPricing`, `countTokens`, `getAvailableModels`, `isValidModel`, `formatTokenPricing`, `MODEL_PRICING`, `TokenPricingConfig`, `TokenPricing`, `TokenPriceQuote`, `ModelPricing` (`@dexterai/x402/server`) — price requests with your model provider's live API and pass the amount to `x402Middleware`.
- `MODEL_REGISTRY`, `MODEL_PRICING_MAP`, `getModel`, `findModel`, `isValidModelId`, `getAvailableModelIds`, `getModelsByTier`, `getModelsByFamily`, `getActiveModels`, `getTextModels`, `getCheapestModel`, `estimateCost`, `formatModelPricing`, and the related types (`@dexterai/x402/server`) — January 2026 hardcoded snapshot; goes stale fast.
- `x402BrowserSupport`, `X402BrowserSupportConfig` (`@dexterai/x402/server`) — no replacement; build a custom paywall page if needed. (`escapeHtml` stays.)
- `stripePayTo`, `StripePayToConfig`, `getStripeProviderNetwork` (`@dexterai/x402/server`) — integrate Stripe at the application layer if still needed. The Stripe-network check in `x402Middleware` is removed alongside this in 4.0.

**Slated for removal in 5.0** (longer migration window because of real consumers):

- `createX402Client`, `X402Client`, `X402ClientConfig` (`@dexterai/x402/client`) — use `payAndFetch` instead. Migration: `client.fetch(url)` → `(await payAndFetch(url, undefined, wallets)).response`.
- `wrapFetch`, `WrapFetchOptions` (`@dexterai/x402/client`) — use `payAndFetch` with a wallet from `createKeypairWallet` / `createEvmKeypairWallet`.

`getPaymentReceipt` and `PaymentReceipt` (`@dexterai/x402/client`) are NOT deprecated.

## [3.8.1] - 2026-05-20

### Fixed
- **Bazaar `routeTemplate` now includes the mount path.** When `x402Middleware` is mounted on a sub-router via `app.use('/v1/agent', router)`, the bazaar extension previously emitted `routeTemplate: "/campaigns/:id"` instead of the full external-visible `"/v1/agent/campaigns/:id"`. The middleware now prepends `req.baseUrl` to `req.route.path`, so the emitted template matches the URL clients actually call. Without mounting, `req.baseUrl` is empty and behavior is unchanged.

## [3.8.0] - 2026-05-20

Adds a resource-server extension system and the **bazaar discovery extension**, making `x402Middleware`-built 402 responses discoverable via the official x402 bazaar standard (`extensions.bazaar`). Fully backward compatible — calls without the new config fields emit a 402 byte-identical to today.

### Added
- **`ResourceServerExtension` contract** (`@dexterai/x402/server`) — generic interface ported from the upstream `@x402/core` extension model. An extension namespaces its output under its own `key` inside `PaymentRequired.extensions`. Future extensions (offer-receipt, payment-identifier, etc.) plug in the same way.
- **Extension registry with failure isolation.** A throwing extension is caught, logged, and skipped — the 402 still goes out, just without that key. Never propagates, never 500s the payment path.
- **`bazaarExtension()` factory** — the first concrete extension. When configured, the 402 response carries the spec-compliant `extensions.bazaar` block: `{ info, schema, routeTemplate? }`, with `info.input` discriminated by HTTP method (GET/HEAD/DELETE → `queryParams`; POST/PUT/PATCH → `bodyType` + `body`) and `schema` as a JSON Schema (Draft 2020-12) validating `info`. Path-parameterized routes carry `info.input.pathParams` and a top-level `routeTemplate`.
- **`declareDiscoveryExtension(config)` helper** — wrap a route's discovery config as `{ bazaar: <config> }` for `x402Middleware`'s `declarations` map. Method may be omitted; the extension stamps the actual request method at 402 time.
- **`X402MiddlewareConfig.extensions`** + **`X402MiddlewareConfig.declarations`** — new optional fields. Pair them to opt routes into the registry. Example:
  ```ts
  x402Middleware({
    payTo, network, amount, facilitatorUrl,
    extensions: [bazaarExtension()],
    declarations: {
      ...declareDiscoveryExtension({
        method: 'POST',
        bodyType: 'json',
        inputSchema: { properties: { amount: { type: 'string' } }, required: ['amount'] },
        output: { example: { campaign: {} } },
      }),
    },
  });
  ```
- **`routeTemplate` validator** — enforces the bazaar spec's rules (non-empty, starts with `/`, allowed chars, no `..`/`://` even after percent-decoding). Invalid templates are dropped (`routeTemplate` is omitted), the 402 still ships.
- **End-to-end test** (`bazaar-middleware.test.ts`) — drives the full middleware with a mocked facilitator and asserts the 402 body carries `extensions.bazaar` when configured, and is `extensions`-free when not.
- **Public exports** from `@dexterai/x402/server`: `bazaarExtension`, `declareDiscoveryExtension`, and the types `ResourceServerExtension`, `PaymentRequiredContext`, `DiscoveryConfig`, `QueryDiscoveryConfig`, `BodyDiscoveryConfig`, `DiscoveryExtension`, `DeclareDiscoveryConfig`.

### Notes
- **Backward compatible.** A `x402Middleware` call with no `extensions`/`declarations` emits a 402 byte-identical to 3.7.8.
- **HTTP only in v1.** MCP-tool discovery (`input.type: "mcp"`) is intentionally out of scope — a clean discriminated-union add-on later.
- **Spec-conformant.** The emitted `extensions.bazaar` was cross-checked against `/tmp/x402-spec/specs/extensions/bazaar.md` (the official x402 bazaar spec) and the upstream test oracle — field-for-field match on `info.input`, `info.output`, `schema.$schema`, `schema.properties.input.required`, `schema.required`, and `routeTemplate`.
- **272 tests passing.**

## [3.7.4] - 2026-05-18

### Fixed
- **v1 `exact`-scheme EVM payments no longer crash on Node 18.** `buildV1PaymentHeader` generated its EIP-3009 replay nonce via `globalThis.crypto.getRandomValues`, which is undefined on Node 18 (`crypto` is only a global in browsers and Node 19+). The SDK supports Node 18 (`engines: >=18`). The nonce generator now resolves `globalThis.crypto` with a `node:crypto` `webcrypto` fallback, the same fix applied to the batch-settlement salt generator in 3.7.3.

## [3.7.3] - 2026-05-18

### Fixed
- **`openBatchChannel` no longer crashes on Node 18.** 3.7.2's channel-salt generator called `crypto.getRandomValues` on the global `crypto`, which is only defined in browsers and Node 19+. The SDK supports Node 18 (`engines: >=18`), so on Node 18 `openBatchChannel` threw `ReferenceError: crypto is not defined`. The salt generator now resolves `globalThis.crypto` with a `node:crypto` `webcrypto` fallback, matching the pattern used elsewhere in the SDK.

## [3.7.2] - 2026-05-18

Fixes a batch-settlement channel-identity bug: every channel between the same
buyer, seller, and token collided on a single deterministic id, so a buyer
could never open a second channel with a seller they had already used —
`openBatchChannel` would silently reopen the first, exhausted channel.

### Fixed
- **Batch-settlement channels now have unique identities.** `openBatchChannel` generates a fresh random channel-config salt for each channel, so the deterministic `channelId` differs per channel. A buyer can hold multiple independent channels with the same seller over time. Previously the SDK never passed a salt to the upstream scheme, so every channel fell back to the zero `DEFAULT_SALT` and collided.

### Added
- **`channel.salt`** — the 32-byte channel-config salt a channel was opened with, exposed on the `BatchSettlementChannel` handle. Persist it to later resume that exact channel.
- **`OpenBatchChannelOptions.salt`** (optional) — pass an explicit salt to deterministically reopen a specific channel; omit it for a fresh random one.

### Breaking
- **`resumeBatchChannel` now requires `salt`.** Resuming a channel needs the exact salt it was opened with — a `channelId` cannot be reversed to a salt. Persist `channel.salt` at open time and pass it to `resumeBatchChannel`. (Resuming previously relied on the zero `DEFAULT_SALT`, which is the collision bug above; it could not correctly resume a distinct channel.)

## [3.4.0] - 2026-05-17

Batch settlement is now functional end-to-end. 3.3.0 shipped a batch-settlement
buyer but no seller runtime, so a seller had no way to collect the vouchers a
buyer signed. This release adds the seller runtime and corrects the buyer's
`channel.close()`.

### Added
- **Batch-settlement seller runtime** — `createBatchSettlementSeller(config)`, exported from `@dexterai/x402/batch-settlement/seller`. Returns a callable object that **is** an Express request handler (mount it directly) and also exposes `.closeChannel(channelId)`, `.closeAll()`, and `.stop()`. It accepts batch-settlement payments — incoming vouchers are verified and persisted to channel storage — and collects them (claim → settle → refund), automatically via a background loop (on by default) and on explicit demand via `closeChannel` / `closeAll`. Config: `{ payTo, network, price, facilitatorUrl?, route?, channelStore?, autoSettle?, verbose? }`.
- **`x402Middleware({ scheme: 'batch-settlement', ... })` now returns the callable seller object** — a seller that mounts the batch-settlement scheme via `x402Middleware` still gets a `.stop()` / `.closeAll()` / `.closeChannel()` handle.
- **Buyer escape hatch** — `channel.forceWithdraw()` followed (after the channel's withdraw delay) by `channel.finalizeWithdraw()` reclaims unspent escrow directly via the contract's timed withdrawal if the seller never settles. This is a last-resort safety net; normal operation does not need it. Unlike every other batch-settlement step, the escape hatch costs the buyer gas — the buyer's wallet must be transaction-capable (it must expose a `sendTransaction` method). A signature-only wallet cannot use it.

### Breaking
- **`channel.close()` no longer returns a `CloseReceipt`.** It now returns `{ closed: true }` and is an intent signal that the buyer is finished with the channel — it is not a settlement and does not move funds. The buyer's unspent escrow returns via the seller's refund on the normal settlement path. (3.3.0's `close()` threw and never worked; this corrects it.)

### Fixed
- **Batch settlement is now functional end-to-end** — a seller can collect the payments a buyer makes, which 3.3.0 could not (it shipped a buyer with no seller runtime).

## [3.2.0] - 2026-05-03

Multi-chain coverage parity. The facilitator has supported Polygon, Optimism, Avalanche, BSC, and SKALE Base for a while; the client adapters and helper functions now declare every one of those chains explicitly instead of relying on `eip155:` substring fallbacks. This closes the gap that caused downstream consumers (e.g. the Dexter resource verifier) to display "Insufficient balance on Base" for resources that actually accepted payment on a different EVM chain.

### Added
- `EvmAdapter.networks` now declares Polygon, Optimism, Avalanche, SKALE Base, and SKALE Base Sepolia in addition to Base mainnet, Base Sepolia, Ethereum, Arbitrum, and BSC. Behaviour for unknown `eip155:N` strings is unchanged (still accepted via prefix match) — the difference is that supported chains are now first-class enumerated entries.
- `getChainName()` extended with mappings for BSC, Polygon, Optimism, Avalanche, SKALE Base, and SKALE Base Sepolia. Legacy short-form aliases (`'polygon'`, `'avalanche'`, `'bsc'`, `'skale-base'`, etc.) are accepted alongside the canonical CAIP-2 form.
- `getExplorerUrl()` extended with explorer URL templates for the same set of chains (Polygonscan, Optimistic Etherscan, Snowtrace, BscScan, SKALE Base + SKALE Base Sepolia explorers).
- `getChainDisplayName(network, family)` exported from `@dexterai/x402/utils` — same mapping as `getChainName()` but falls back to the adapter family name (`'Solana'` / `'EVM'`) instead of the raw CAIP-2 string. Use this in user-facing error messages and UI badges.
- New test suite `evm-chain-coverage.test.ts` (71 cases) locks in the adapter declaration / canHandle / RPC / USDC / chain ID matrix per chain so future contributors can't add a constant without wiring the adapter.

### Fixed
- The pre-payment `insufficient_balance` X402Error in `createX402Client` now resolves the chain name from the canonical registry, so the message reads "Insufficient balance on Polygon" instead of the previous hardcoded "Insufficient balance on Base" for non-Base EVM chains.
- Access-pass purchase flow's `insufficient_balance` error now includes the chain name. Previously it omitted the chain entirely, which made the diagnosis ambiguous when the same wallet was authorized on multiple chains.

### Changed
- Consolidated network identifiers, token addresses, RPC URLs, chain IDs, Permit2 addresses, and protocol defaults into a single `src/constants.ts` module. Types, adapters, server middleware, access pass, and Stripe PayTo now import from it instead of carrying their own duplicates. Public export surface is unchanged. ([`4d3e881`])
- `getChainName('eip155:42161')` now returns `'Arbitrum'` (was `'Arbitrum One'`). The shorter form reads better in error messages and matches every other chain's display convention. The CAIP-2 identifier is unchanged.

### Removed
- `X402ErrorCode` member `no_solana_accept` — zero callers anywhere in the ecosystem. ([`58c7eea`])
- `KeypairWallet.keypair` — the deprecated field that shadowed `KEYPAIR_SYMBOL`. `isKeypairWallet()` now checks the symbol directly. No external callers were found. ([`58c7eea`])
- Implicit `(response as any)._x402 = receipt` mutation after payment settlement. The typed `getPaymentReceipt(response)` + `PaymentReceipt` WeakMap path has been the public API since 1.8.0; the legacy mutation no longer had any readers. ([`58c7eea`])

## [3.1.1] - 2026-04-18

### Changed
- `capabilitySearch` implementation moved to `@dexterai/x402-core` — this SDK now re-exports from the shared core package so discovery logic stays consistent across Dexter surfaces (SDK, OpenDexter, MCP servers, widgets). Public API unchanged.
- Build now minifies output and targets ES2022.
- Bumped `@dexterai/x402-ads-types` from `^0.1.0` to `^0.2.0`.

### Added
- `@dexterai/x402-core` as a runtime dependency.

### Removed
- Stale `tweet-thread-v2.md` draft marketing content from the repo root.

## [3.0.0] - 2026-04-15

### Breaking
- **`searchAPIs()` is gone. Replaced by `capabilitySearch()`.** The legacy substring ranker at `/api/facilitator/marketplace/resources` was retired — discovery now goes through the semantic capability search pipeline at `/api/x402gle/capability` (vector search + similarity floor + tiering + cross-encoder LLM rerank).
- **`DiscoveredAPI` type removed. Replaced by `CapabilityAPI`.** The new shape carries `tier: 'strong' | 'related'`, a raw `similarity` score (0–1), a `why` string explaining the ranking factors, and a final combined `score`. It also nests gaming-flag signals (`gamingFlags`, `gamingSuspicious`) and drops `sellerReputation`, `totalVolume` (formatted), `lastActive`, and `authRequired`.
- **Hard-filter params are gone.** `category`, `network`, `maxPrice`, `verifiedOnly`, and `sort` were removed from the search options. They were the source of silent false-empties (e.g. `{ query: 'ETH price', network: 'ethereum' }` returned zero results because every ETH-price resource accepts payment on Base). The ranker handles these semantically; payment rail is a checkout-time concern the caller handles separately. The new options are: `query` (required), `limit`, `unverified`, `testnets`, `rerank`, and `endpoint`.
- **Response is tiered.** `capabilitySearch()` returns `{ strongResults, relatedResults, strongCount, relatedCount, topSimilarity, noMatchReason, rerank, intent, durationMs }` instead of a flat array. `strongResults` are high-confidence matches that cleared the strong similarity threshold; `relatedResults` are adjacent candidates that cleared the floor but not the strong threshold.

### Added
- **`capabilitySearch(options: CapabilitySearchOptions): Promise<CapabilitySearchResult>`** — semantic search with synonym expansion at the intent parse layer, similarity floor filtering, strong/related tiering, and cross-encoder LLM rerank on the top strong results.
- **`NoMatchReason` type** — `'below_similarity_threshold' | 'below_strong_threshold' | null`. Callers can distinguish "corpus has zero candidates" from "candidates exist but none are high-confidence".
- **Intent telemetry on every response** — `result.intent` exposes the parsed `capabilityText` and the synonym-expanded `expandedCapabilityText` that was actually embedded for the vector search. Useful for debugging why a query ranked a particular way.
- **Rerank telemetry on every response** — `result.rerank.applied` tells you whether the LLM cross-encoder actually reordered the top strong results, and `result.rerank.reason` explains any skip.

### Migration
Replace the search call:
```ts
// Before (2.x)
const results = await searchAPIs({ query: 'ETH price', category: 'data', maxPrice: 0.10 });
for (const api of results) { console.log(api.name, api.price); }

// After (3.0)
const result = await capabilitySearch({ query: 'ETH price' });
for (const api of result.strongResults) { console.log(api.name, api.price, api.why); }
if (result.strongCount === 0 && result.relatedCount > 0) {
  // Fall back to related matches when nothing cleared the strong threshold
  for (const api of result.relatedResults) { console.log('related:', api.name); }
}
```

Filter semantically via the query text, not parameters:
- `searchAPIs({ category: 'defi' })` → `capabilitySearch({ query: 'DeFi tools' })`
- `searchAPIs({ network: 'solana' })` → `capabilitySearch({ query: 'on Solana' })` (or filter client-side via `pricing.network`)
- `searchAPIs({ maxPrice: 0.10 })` → filter the result array: `result.strongResults.filter(r => r.priceUsdc != null && r.priceUsdc <= 0.10)`

## [2.0.0] - 2026-03-15

### Breaking
- **`PaymentAccept.amount` is now required** — v2 spec field. `maxAmountRequired` is deprecated (optional alias for v1 compat).
- **`PaymentAccept.extra` is now optional** — per v2 spec.
- **`TokenPricing` methods are async** — `calculate()`, `validateQuote()`, `countTokens()` return Promises. `tiktoken` is now an optional peer dependency (lazy-loaded on first call).

### Added
- **Budget Accounts** — `createBudgetAccount()` wraps fetch with spending controls: total budget, per-request cap, hourly rate limit, and domain allowlist. Tracks cumulative spend with a full payment ledger. Give your agent $50 and let it spend autonomously.
- **API Discovery** — `searchAPIs()` searches the Dexter marketplace for x402 paid APIs by query, category, network, price range, and quality score. Returns typed `DiscoveredAPI[]` that can be called directly with `wrapFetch`.
- **Retry with exponential backoff** — `maxRetries` and `retryDelayMs` in client config. Retries on network errors and 502/503/504. Safe for payments — EIP-3009 nonces prevent double-spend.
- **First-class Sponsored Access (Ads for Agents)** — `getSponsoredRecommendations()`, `getSponsoredAccessInfo()`, `fireImpressionBeacon()` client helpers. React hook `sponsoredRecommendations`. Server `onMatch` callback. `@dexterai/x402-ads-types` promoted to direct dependency.
- **Pre-payment inspection** — `onPaymentRequired` callback on client and `wrapFetch`. Return `false` to reject a payment before signing.
- **Settlement webhooks** — `onSettlement` and `onVerifyFailed` callbacks in middleware config.
- **CSP headers** on browser paywall page.
- **`KEYPAIR_SYMBOL`** for safe access to the Solana Keypair (Symbol-keyed, hidden from serialization).
- **`escapeHtml()`** exported from server for safe HTML rendering of payment data.
- **`isSolanaNetwork()` / `isEvmNetwork()`** utility functions.
- **New error codes** — `wallet_disconnected`, `user_rejected_signature`, `rpc_timeout`, `facilitator_timeout`.
- **Typed `WalletSet`** — `solana` and `evm` fields are now typed as `SolanaWallet` and `EvmWallet` instead of `unknown`.
- **52 unit tests** covering dynamic pricing, XSS escaping, USDC detection, type compliance, amount conversion, sponsored access.
- **CI/CD** — GitHub Actions: typecheck + build + test on Node 18/20/22. Publish workflow gated on tests, auto-creates GitHub releases.
- **`extensions` field** on `PaymentRequired` and `PaymentSignature` per v2 spec.
- **Auto GitHub releases** from tag pushes with changelog extraction.

### Fixed
- **EVM nonce security** — `Math.random()` replaced with `crypto.getRandomValues()`.
- **Dynamic pricing security** — FNV-1a replaced with HMAC-SHA256 with timestamp-bounded quotes (5-min TTL).
- **Balance checks** throw on RPC errors instead of silently returning 0.
- **Resource URL validation** — blocks `javascript:`, `data:`, `file:` schemes.
- **Internal errors** no longer leaked to clients.
- **Stripe guard** uses WeakMap instead of fragile `as any` property.
- **Source maps removed** from production build (62% smaller package).
- **Client JWT cache** capped to 24h regardless of decoded `exp`.

## [1.9.4] - 2026-03-15

### Fixed
- **Balance checks no longer silently swallow RPC errors** — Solana adapter now only returns 0 for `TokenAccountNotFoundError` (new wallets). EVM adapter throws on HTTP errors and RPC errors. The client gracefully skips the pre-check on RPC failure and lets the chain reject if balance is actually insufficient.
- **Resource URLs validated for scheme** — client rejects `javascript:`, `data:`, and `file:` URLs from payment requirement headers. Only `http:` and `https:` are accepted.
- **Internal error details no longer leaked to clients** — middleware 500 responses now return generic `"Payment processing error"` without the underlying error message.
- **CSP headers on browser paywall** — the generated HTML paywall page now sets `Content-Security-Policy` and `X-Content-Type-Options: nosniff` headers.
- **Stripe PayTo documentation** — JSDoc now explicitly documents the Base-only limitation with a multi-chain workaround example.
- **sessionStorage risk documented** — `useAccessPass` JSDoc warns about XSS exposure of stored JWTs.

### Added
- **`onSettlement` callback** in middleware config — called after every successful payment settlement for logging, analytics, or webhooks.
- **`onVerifyFailed` callback** in middleware config — called when payment verification fails for monitoring suspicious activity.
- **`onPaymentRequired` callback** in client config — pre-payment inspection hook. Return `false` to reject a payment before signing. Critical for agent budget controls.
- **`KEYPAIR_SYMBOL`** — Symbol-keyed access to the underlying Solana Keypair, preventing accidental private key exposure via `console.log` or `JSON.stringify`. The `keypair` property is deprecated but kept for backwards compat.
- **New error codes** — `wallet_disconnected`, `user_rejected_signature`, `rpc_timeout`, `facilitator_timeout`.
- **`isSolanaNetwork()` and `isEvmNetwork()`** — exported utility functions for network detection, replacing duplicated `startsWith` checks.

## [1.9.3] - 2026-03-15

### Added
- **52 unit tests** (up from 6) covering dynamic pricing HMAC validation, amount conversion edge cases, network detection, XSS escaping, USDC detection across all chains, v2 type compliance, sponsored access helpers, and X402Error behavior.
- **`escapeHtml()` exported** from `@dexterai/x402/server` — the XSS escape function is now public and tested for consumers who render payment data in HTML.

## [1.9.2] - 2026-03-15

### Breaking
- **`TokenPricing.calculate()`, `validateQuote()`, and `countTokens()` are now async** — returns `Promise<TokenPriceQuote>`, `Promise<boolean>`, and `Promise<number>` respectively. This is required because tiktoken is now lazy-loaded. Add `await` to all calls.
- **`TokenPricingConfig.tokenizer` now accepts async functions** — type changed from `(text: string) => number` to `(text: string) => number | Promise<number>`. Existing sync tokenizers still work.

### Fixed
- **tiktoken is no longer a hard dependency** — moved from `dependencies` to optional `peerDependencies`. The 5MB+ WASM binary is only loaded when `createTokenPricing()` or `countTokens()` is actually called. Consumers who don't use token pricing save the install cost entirely. Throws a helpful error if tiktoken is needed but not installed.
- **Stripe PayTo guard used fragile private property** — replaced `(provider as any)._stripeNetwork` with a `WeakMap` registry that survives wrapping, proxying, and `bind()`. Exported `getStripeProviderNetwork()` for external use.

### Added
- **EVM wallet Quick Start in README** — `wrapFetch` with `evmPrivateKey` is now documented alongside the Solana example in the Quick Start section.

## [1.9.1] - 2026-03-15

### Added
- **First-class Sponsored Access (Ads for Agents)** — typed helpers for consuming sponsored recommendations from x402 payment receipts:
  - `getSponsoredRecommendations(response)` — extract typed `SponsoredRecommendation[]` from a payment response
  - `getSponsoredAccessInfo(response)` — extract the full `SponsoredAccessSettlementInfo` extension data
  - `fireImpressionBeacon(response)` — fire-and-forget delivery confirmation to the ad network
- **React hook support** — `useX402Payment` now returns `sponsoredRecommendations` (auto-populated after payment, auto-fires impression beacon)
- **Server `onMatch` callback** — `sponsoredAccess: { onMatch: (recs, settlement) => ... }` for server-side logging/analytics when recommendations are delivered
- **Typed middleware injection** — `sponsoredAccess.inject` callback now receives typed `SponsoredRecommendation[]` instead of `unknown[]`
- **Re-exported types** — `SponsoredRecommendation`, `SponsoredAccessSettlementInfo`, `SponsoredAccessPaymentRequiredInfo`, `SponsoredAccessClientConsent`, and `SPONSORED_ACCESS_EXTENSION_KEY` are now exported from `@dexterai/x402/client`, `@dexterai/x402/server`, and `@dexterai/x402/react`

### Changed
- **`@dexterai/x402-ads-types` is now a direct dependency** — moved from optional peer dependency to ensure types are always available. Package is 72KB (mostly type declarations, 12 lines of JS).

## [1.9.0] - 2026-03-15

### Breaking
- **`PaymentAccept.amount` is now required, `maxAmountRequired` is deprecated** — Aligns with the x402 v2 specification. `amount` is the v2 spec field; `maxAmountRequired` remains as an optional alias for backwards compatibility with v1 data. TypeScript consumers referencing `accept.maxAmountRequired` directly will get deprecation warnings. Server output includes both fields during the transition period.
- **`PaymentAccept.extra` is now optional** — Per v2 spec, `extra` is not required on all payment options. Existing code that accesses `accept.extra.feePayer` should use optional chaining: `accept.extra?.feePayer`.

### Fixed
- **EVM nonce used `Math.random()`** — Replaced with `crypto.getRandomValues()` for cryptographically secure nonce generation in EIP-3009 authorizations. Falls back to Node.js `crypto.webcrypto` for older environments.
- **Dynamic pricing used non-cryptographic hash** — Replaced FNV-1a with HMAC-SHA256 for quote validation. Quotes now include a timestamp and are rejected after 5 minutes, preventing both hash collision attacks and stale quote reuse.
- **Client-side access pass cache didn't cap expiry** — JWT `exp` decoded from unverified tokens is now capped to 24 hours max cache TTL, preventing forged far-future timestamps from caching indefinitely. Server-side verification is unaffected (always enforces HMAC signature).

### Added
- **`extensions` field on `PaymentRequired` and `PaymentSignature`** — Per v2 spec, both types now support optional `extensions: Record<string, unknown>` for protocol extensions like sponsored-access and bazaar.

## [1.8.2] - 2026-03-11

### Fixed
- **`getFeePayer()` throws on EVM networks** — `FacilitatorClient.getFeePayer()` required a `feePayer` field that only exists for SVM networks. Now returns `undefined` for EVM instead of throwing. Only throws if the network isn't supported at all.

## [1.8.1] - 2026-03-11

### Fixed
- **Server SDK crashes on EVM networks** — `createX402Server()` threw "Facilitator does not provide feePayer" when used with any EVM network (Base, Polygon, SKALE, etc.) because `getNetworkExtra()` unconditionally required a `feePayer` field from the facilitator's `/supported` response. That field only exists for Solana. The check is now SVM-only; EVM networks pass through `decimals` and EIP-712 fields without it.

## [1.8.0] - 2026-03-10

### Breaking
- **`createKeypairWallet` is now async** — Returns `Promise<KeypairWallet>` instead of `KeypairWallet`. You must `await` the result: `const wallet = await createKeypairWallet(key)`. This change was required for ESM compatibility (`require('bs58')` → `await import('bs58')`). `wrapFetch` handles this automatically — only direct callers are affected.

### Fixed
- **Verify/settle amount bug** — Server was passing `amountAtomic: '0'` to the facilitator when verifying or settling payments with dynamic payTo (e.g., Stripe). Added an in-memory requirements cache that preserves the correct amount between the initial 402 response and the retry with payment. Falls back to extracting the amount from the payment header if the cache misses.
- **ESM compatibility** — Replaced `require()` calls in `adapters/index.ts` and `keypair-wallet.ts` with ESM-compatible static imports and `await import()`. The package is `"type": "module"` and now works correctly in strict ESM environments.
- **XSS in browser paywall** — HTML-escape all interpolated values (description, price, requestUrl) in the browser paywall page to prevent injection from malicious payment requirement fields.
- **USDC decimal inference** — Client now recognizes USDC on all supported chains (Polygon, Arbitrum, Optimism, Avalanche, SKALE) for decimal inference, not just Solana and Base. Uses a shared `isKnownUSDC()` helper instead of hardcoded lists.
- **Wrong facilitator URL in JSDoc** — Fixed `@default` annotations in middleware, wrap-fetch, and access-pass that said `x402-facilitator.dexter.cash` (wrong) instead of `x402.dexter.cash` (correct).
- **Stripe type safety** — Stripe client, PaymentIntent response, and crypto options are now typed via `import('stripe')` instead of `any`.

### Added
- **Multi-network middleware** — `x402Middleware` now accepts `network: string | string[]` and `payTo: Record<string, string | PayToProvider>` with glob matching (`eip155:*`, `solana:*`, `*`). Endpoints can accept payments on all chains simultaneously. The client picks whichever chain it has a wallet for.
- **Full chain parity with facilitator** — EVM adapter now supports all 10 networks from the Dexter facilitator: Base, Polygon, Arbitrum, Optimism, Avalanche, SKALE Base (mainnet + testnet), and Base Sepolia. Ethereum mainnet is deprecated (not in facilitator).
- **Resilient facilitator client** — `FacilitatorClient` now retries on 5xx and network errors with exponential backoff (3 attempts, 500ms/1s/2s). All requests have a 10s timeout. Both limits are configurable via `FacilitatorClientConfig`.
- **`getPaymentReceipt(response)`** — Typed helper (backed by `WeakMap`) replaces the `(response as any)._x402` pattern. Exported from `@dexterai/x402/client`.
- **`@dexterai/x402-ads-types`** — Added as an optional peer dependency for typed sponsored-access extensions. No inlining; single source of truth.
- **New chain constants** — Exported `POLYGON`, `OPTIMISM`, `AVALANCHE`, `SKALE_BASE`, `SKALE_BASE_SEPOLIA`, `USDC_ADDRESSES` from `@dexterai/x402/adapters`.

## [1.7.2] - 2026-02-28

### Added
- **Sponsored access support** — Server middleware accepts `sponsoredAccess: true` config. Reads `extensions["sponsored-access"]` from the facilitator's settlement response and injects `_x402_sponsored` into the JSON response body.
- `SettleResponse.extensions` field for protocol extensions

## [1.7.1] - 2026-02-25

### Fixed
- Added `@types/aws-lambda` to fix DTS build errors
- Updated npm metadata and package description

## [1.7.0] - 2026-02-20

### Added
- OpenDexter marketplace auto-discovery section in README
- Updated header with marketplace links

## [1.6.6] - 2026-02-12

### Fixed
- Unicode-safe base64 encoding for server-side `btoa`/`atob`

## [1.6.5] - 2026-02-10

### Fixed
- **`wrapFetch` + `createEvmKeypairWallet` ESM compatibility** — v1.6.4 used `require('viem/accounts')` which fails in ESM consumers because viem 2.x is ESM-only. Replaced with `await import('viem/accounts')` (dynamic import). `createEvmKeypairWallet` is now async; `wrapFetch` starts the import eagerly and awaits it before the first fetch call, keeping its own signature synchronous.

## [1.6.4] - 2026-02-10

### Fixed
- **`wrapFetch` EVM support** — `evmPrivateKey` option now works. Previously, passing an EVM private key to `wrapFetch` would log a warning and silently discard the key, causing all Base/EVM payments to fail with `no_matching_payment_option`. The key is now used to create a proper EVM wallet via viem's `privateKeyToAccount` (chain-agnostic EIP-712 signing).

### Added
- **`createEvmKeypairWallet()`** — New helper (parallel to `createKeypairWallet` for Solana) that creates an `EvmWallet` from a hex private key. Exported from `@dexterai/x402/client`. Useful for Node.js scripts that need EVM payments without a browser wallet.

## [1.5.0] - 2026-02-09

### Added
- **Access Pass** — New payment pattern: pay once, get a time-limited JWT for unlimited API requests. Works with both SVM and EVM.
  - **Server**: `x402AccessPass` middleware (`@dexterai/x402/server`) — drop-in Express middleware with tier-based and custom duration pricing. Issues JWTs after x402 payment settlement. Validates passes on subsequent requests without touching the facilitator.
  - **Client**: `accessPass` option on `wrapFetch` and `createX402Client` (`@dexterai/x402/client`) — auto-detects servers that offer access passes, purchases one, caches the JWT, and includes it on all subsequent requests. Auto-renews expired passes.
  - **React**: `useAccessPass` hook (`@dexterai/x402/react`) — dedicated hook for managing the access pass lifecycle: tier discovery, pass purchase, token caching, countdown timer, and auto-fetch with pass.
- New types: `AccessPassTier`, `AccessPassInfo`, `AccessPassClaims`, `AccessPassClientConfig`
- New error codes: `access_pass_expired`, `access_pass_invalid`, `access_pass_tier_not_found`, `access_pass_exceeds_max_spend`
- New HTTP headers: `X-ACCESS-PASS-TIERS` (server -> client on 402), `ACCESS-PASS` (server -> client on pass purchase)
- `test/access-pass.ts` — 8-assertion test suite covering the full access pass lifecycle

## [1.4.1] - 2026-02-09

### Fixed
- **PAYMENT-RESPONSE header** — Server middleware now sets `PAYMENT-RESPONSE` header (base64-encoded settlement data) on 200 OK responses after successful payment, per the x402 v2 HTTP transport spec. Previously, settlement data was only attached to `req.x402` but not surfaced as a response header.
- **`amount` field in 402 response** — The `accepts` array in payment requirements now includes both `amount` (v2 spec field) and `maxAmountRequired` (legacy field). Non-Dexter v2 clients that look for `amount` instead of `maxAmountRequired` will now find it.
- **`x402Version` in facilitator requests** — The `FacilitatorClient` now sends `x402Version: 2` at the top level of `/verify` and `/settle` request bodies, matching the Coinbase reference implementation format.

### Added
- `test/v2-spec-compliance.ts` — Automated test suite validating all three v2 spec compliance fixes against a mock facilitator (6 assertions).

## [1.4.0] - 2026-01-11

### Added
- **Model Registry** - Comprehensive single source of truth for all OpenAI models (`model-registry.ts`)
  - 25 models across 5 tiers: fast, standard, reasoning, premium, specialized
  - Complete pricing data from OpenAI (January 2026)
  - GPT-5 family: gpt-5-nano, gpt-5-mini, gpt-5, gpt-5.1, gpt-5.2, gpt-5-pro, gpt-5.2-pro
  - Reasoning models: o1, o1-mini, o1-pro, o3, o3-mini, o3-pro, o4-mini
  - Specialized: deep-research, computer-use-preview, realtime models
- **Registry API**:
  - `MODEL_REGISTRY` - Full model definitions with pricing, capabilities, and API parameters
  - `getModel(id)` - Get model by ID (throws if not found)
  - `findModel(id)` - Get model by ID (returns undefined if not found)
  - `getModelsByTier(tier)` - Get all models in a tier
  - `getModelsByFamily(family)` - Get models by family (gpt-5, o3, etc.)
  - `getTextModels()` - Get all text-capable models for chat completions
  - `getActiveModels()` - Get all non-deprecated models
  - `getCheapestModel(minTier?)` - Find cheapest model meeting requirements
  - `estimateCost(modelId, inputTokens, outputTokens)` - Calculate request cost
- **Model Parameters** - Each model specifies API compatibility:
  - `usesMaxCompletionTokens` - GPT-5/reasoning models require this instead of `max_tokens`
  - `supportsTemperature` - GPT-5 models only support default (1)
  - `supportsReasoningEffort` - For o-series models
  - `supportsTools`, `supportsStructuredOutput`, `supportsStreaming`

### Changed
- `token-pricing.ts` now uses `MODEL_REGISTRY` as its data source (no more duplicate pricing)
- `getAvailableModels()` returns models sorted by tier then price

### Developer Tools
- **Model Evaluation Harness** (`test/model-eval/`) - CLI for testing models
  - Test prompts across multiple models simultaneously
  - Compare response quality, timing, and costs
  - Context injection from files (`--context`)
  - Full output logging with metrics

## [1.3.1] - 2025-01-10

### Fixed
- Minor type exports cleanup

## [1.3.0] - 2025-01-09

### Changed
- Internal refactoring for model pricing

## [1.2.4] - 2024-12-30

### Fixed
- **x402 v1 compatibility** - SDK now echoes the `x402Version` from the server's 402 response instead of hardcoding v2. This enables compatibility with v1-only facilitators.
- Added `x402Version` field to `PaymentAccept` type

## [1.2.1] - 2024-12-28

### Added
- **Custom model support** for `createTokenPricing()`:
  - `inputRate` - Custom USD per 1M input tokens (for Anthropic, Gemini, Mistral, etc.)
  - `outputRate` - Custom USD per 1M output tokens
  - `maxTokens` - Custom max output tokens
  - `tokenizer` - Custom tokenizer function for non-OpenAI models
- `'custom'` tier for user-defined pricing

### Changed
- `createDynamicPricing()` documentation clarified: works for ANY pricing scenario, not just LLM
- README now shows examples for Anthropic Claude, Google Gemini, and local models

## [1.2.0] - 2024-12-28

### Added
- **Token Pricing** - `createTokenPricing()` for accurate LLM pricing using tiktoken
- Uses real OpenAI model rates (gpt-4o-mini, gpt-4o, o1, o3, etc.)
- `MODEL_PRICING` - Complete pricing table for 20+ models across fast/standard/reasoning/premium tiers
- `countTokens()` - Accurate token counting using OpenAI's tiktoken
- `getAvailableModels()` - List all models sorted by tier and price
- `isValidModel()` - Check if a model is supported
- `formatTokenPricing()` - Display helper (e.g., "$0.15 per 1M tokens")

### Changed
- Dynamic pricing now has two variants:
  - `createDynamicPricing()` - Character-based (generic, no deps)
  - `createTokenPricing()` - Token-based (LLM-accurate, uses tiktoken)

## [1.1.0] - 2024-12-27

### Added
- **Dynamic Pricing** - `createDynamicPricing()` for LLM/AI endpoints where cost scales with input
- Quote hash validation prevents prompt manipulation (includes pricing config in hash)
- `formatPricing()` helper for display strings
- Client SDK now forwards `X-Quote-Hash` header on retry

## [1.0.4] - 2024-12-27

### Changed
- **README overhaul** - Professional documentation with live demo links, emoji formatting, and clear API reference
- Prominent link to [dexter.cash/sdk](https://dexter.cash/sdk) for live verification

## [1.0.3] - 2024-12-27

### Added
- **Utils export** - `toAtomicUnits()` and `fromAtomicUnits()` now available via `@dexterai/x402/utils`
- `getChainFamily()`, `getChainName()`, `getExplorerUrl()` helpers

### Changed
- README now includes notice that server SDK is not yet battle-tested

## [1.0.2] - 2024-12-27

### Added
- **Pre-flight balance check** - SDK now checks USDC balance before signing transactions
- `insufficient_balance` error code with clear message: "Insufficient USDC balance on [Network]. Have $X, need $Y"

### Fixed
- Prevents confusing "Payment was rejected by the server: {}" error when user has insufficient funds
- Users now see a clear, actionable error message before wallet popup appears

## [1.0.1] - 2024-12-26

### Fixed
- EVM adapter payload structure now correctly separates `authorization` and `signature` fields to match upstream `@x402/evm` format
- Removed unnecessary `feePayer` validation for EVM networks (users pay their own gas)

## [1.0.0] - 2024-12-26

### Added
- **Chain-agnostic architecture** - Support for multiple blockchains through adapter pattern
- **SolanaAdapter** - Full Solana mainnet/devnet support with sponsored fees
- **EvmAdapter** - Base, Ethereum, and Arbitrum support via EIP-712 TransferWithAuthorization
- **Client SDK** (`@dexterai/x402/client`)
  - `createX402Client()` - Wrapped fetch that auto-handles 402 responses
  - Multi-wallet support via `WalletSet`
  - Automatic adapter selection based on payment network
- **Server SDK** (`@dexterai/x402/server`)
  - `createX402Server()` - Generate 402 responses and verify/settle payments
  - `buildRequirements()` - Build PaymentRequired payloads
  - `verifyPayment()` / `settlePayment()` - Facilitator integration
  - Auto-fetches feePayer and decimals from facilitator
- **React Hooks** (`@dexterai/x402/react`)
  - `useX402Payment()` - Complete payment state management
  - Multi-wallet balance tracking
  - Real-time connection status per network
- **Adapters** (`@dexterai/x402/adapters`)
  - `ChainAdapter` interface for extensibility
  - `createSolanaAdapter()` / `createEvmAdapter()` factories
  - Balance fetching for USDC across chains
- Dual ESM/CJS builds with full TypeScript definitions
- Comprehensive documentation and examples

### Technical Details
- Uses Dexter's public facilitator at `https://x402.dexter.cash`
- Solana: Sponsored fees via ComputeBudget instructions (12k CU limit, 1 microlamport priority)
- EVM: EIP-3009 TransferWithAuthorization for gasless token transfers
- v2 protocol only (header-based flow with `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE`)

---

[Unreleased]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v3.4.0...HEAD
[3.4.0]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v3.2.0...v3.4.0
[3.1.1]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v3.0.0...v3.1.1
[3.0.0]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.9.4...v2.0.0
[1.9.4]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.9.3...v1.9.4
[1.9.3]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.9.2...v1.9.3
[1.9.2]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.9.1...v1.9.2
[1.9.1]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.8.2...v1.9.0
[1.8.2]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.7.2...v1.8.0
[1.7.2]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.6.6...v1.7.0
[1.6.6]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.6.5...v1.6.6
[1.6.5]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.6.4...v1.6.5
[1.6.4]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.5.5...v1.6.4
[1.5.0]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.2.5...v1.3.0
[1.2.4]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.2.1...v1.2.4
[1.2.1]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.0.4...v1.1.0
[1.0.4]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Dexter-DAO/dexter-x402-sdk/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Dexter-DAO/dexter-x402-sdk/releases/tag/v1.0.0

[`4d3e881`]: https://github.com/Dexter-DAO/dexter-x402-sdk/commit/4d3e881
[`58c7eea`]: https://github.com/Dexter-DAO/dexter-x402-sdk/commit/58c7eea
