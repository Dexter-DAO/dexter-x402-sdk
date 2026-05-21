/**
 * @dexterai/x402 Client
 *
 * Chain-agnostic client for x402 payments. Supports both x402 v1 and v2
 * transparently — pick the canonical entrypoint (`payAndFetch`) and the
 * client figures out which protocol the server speaks.
 *
 * @example Recommended (any environment, any protocol version)
 * ```typescript
 * import { payAndFetch, createKeypairWallet } from '@dexterai/x402/client';
 *
 * const solana = await createKeypairWallet(process.env.SOLANA_PRIVATE_KEY!);
 * const result = await payAndFetch(
 *   'https://api.example.com/protected',
 *   undefined,
 *   { solana },
 * );
 *
 * if (result.ok) {
 *   const data = await result.response.json();
 * }
 * ```
 *
 * @example Sponsored Access — read ad-network recommendations off a paid response
 * ```typescript
 * import { payAndFetch, getSponsoredRecommendations, fireImpressionBeacon } from '@dexterai/x402/client';
 *
 * const result = await payAndFetch(url, undefined, wallets);
 * if (result.ok) {
 *   const recs = getSponsoredRecommendations(result.response);
 *   if (recs) await fireImpressionBeacon(result.response);
 * }
 * ```
 */

// ─── Canonical client (2026+) ──────────────────────────────────────────────
// `payAndFetch` is the version-agnostic entrypoint. Works with both x402 v1
// and v2 servers, returns a discriminated union (`PayResult`) so callers don't
// branch on protocol version. Use this for all new code.

export {
  payAndFetch,
  detectStrategy,
  toNetworkRef,
  toSiwxSigner,
  buildV1PaymentHeader,
} from '../payment';
export type {
  PaymentStrategy,
  PaymentChallenge,
  ChallengeOption,
  PayResult,
  PayAndFetchOptions,
  NetworkRef,
  V1HeaderResult,
} from '../payment';

// ─── Wallet helpers ────────────────────────────────────────────────────────
// Build the `WalletSet` that `payAndFetch` (and the legacy clients) take.

export { createKeypairWallet, isKeypairWallet, KEYPAIR_SYMBOL } from './keypair-wallet';
export type { KeypairWallet } from './keypair-wallet';

export { createEvmKeypairWallet, isEvmKeypairWallet } from './evm-wallet';

export {
  createSolanaAdapter,
  createEvmAdapter,
  SOLANA_MAINNET,
  BASE_MAINNET,
} from '../adapters';

export type { ChainAdapter, WalletSet } from '../adapters/types';

// ─── Sponsored Access (Instinct ad network — buyer-side reader) ────────────
// Reads ad-network recommendations off any paid `Response` and fires the
// impression beacon. Used by the MCP `fetch` tools that Claude/ChatGPT/Cursor
// agents call, plus the x402gle InstinctReceipt UI.

export {
  getSponsoredRecommendations,
  getSponsoredAccessInfo,
  fireImpressionBeacon,
} from './sponsored-access';
export type { SponsoredRecommendation, SponsoredAccessSettlementInfo } from './sponsored-access';

// ─── Agent budget controls ─────────────────────────────────────────────────

export { createBudgetAccount } from './budget-account';
export type { BudgetAccount, BudgetAccountConfig, BudgetConfig, PaymentRecord } from './budget-account';

// ─── API discovery (semantic capability search) ────────────────────────────

export { capabilitySearch } from './discovery';
export type {
  CapabilitySearchOptions,
  CapabilitySearchResult,
  CapabilityAPI,
  NoMatchReason,
} from './discovery';

// ─── Receipts ──────────────────────────────────────────────────────────────
// Reads the payment receipt from a paid `Response`. Works with `payAndFetch`
// and the legacy clients. NOT deprecated.

export { getPaymentReceipt } from './x402-client';
export type { PaymentReceipt } from './x402-client';

// ─── Shared types / constants ──────────────────────────────────────────────

export { X402Error } from '../types';
export { DEXTER_FACILITATOR_URL, USDC_MINT } from '../types';
export type { AccessPassClientConfig, AccessPassTier, AccessPassInfo } from '../types';

// ─── @deprecated — predate `payAndFetch` ───────────────────────────────────
// `createX402Client` and `wrapFetch` were the v2-era client surface. They
// still work — these exports are unchanged at runtime. New code should reach
// for `payAndFetch` above instead. Removal targeted for a future major.

export { createX402Client } from './x402-client';
export type { X402ClientConfig, X402Client } from './x402-client';

export { wrapFetch } from './wrap-fetch';
export type { WrapFetchOptions } from './wrap-fetch';
