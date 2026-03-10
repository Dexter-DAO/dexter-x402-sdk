# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.8.0] - 2026-03-10

### Fixed
- **Verify/settle amount bug** — Server was passing `amountAtomic: '0'` to the facilitator when verifying or settling payments with dynamic payTo (e.g., Stripe). Added an in-memory requirements cache that preserves the correct amount between the initial 402 response and the retry with payment. Falls back to extracting the amount from the payment header if the cache misses.
- **ESM compatibility** — Replaced `require()` calls in `adapters/index.ts` and `keypair-wallet.ts` with ESM-compatible static imports and `await import()`. The package is `"type": "module"` and now works correctly in strict ESM environments.
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
- **x402 v1 compatibility** - SDK now echoes the `x402Version` from the server's 402 response instead of hardcoding v2. This enables compatibility with v1-only facilitators (PayAI, Ultraviolet, etc.)
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

## Migration from PayAI SDKs

If migrating from `@payai/x402-solana`:

```diff
- import { createX402Client } from '@payai/x402-solana';
+ import { createX402Client } from '@dexterai/x402/client';
+ import { createSolanaAdapter } from '@dexterai/x402/adapters';

- const client = createX402Client({ wallet });
+ const client = createX402Client({
+   adapters: [createSolanaAdapter()],
+   wallets: { solana: wallet },
+ });
```

Key differences:
- Dexter SDK is v2-only (no legacy X-PAYMENT header support)
- Multi-chain by design - add Base support by including `createEvmAdapter()`
- Phantom-compatible (handles Lighthouse assertions automatically)

