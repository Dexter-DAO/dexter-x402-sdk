# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

