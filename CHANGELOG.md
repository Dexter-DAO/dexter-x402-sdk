# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

