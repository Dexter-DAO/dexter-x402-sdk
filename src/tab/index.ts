/**
 * @dexterai/x402/tab — OTS-backed streaming payments for the SDK.
 *
 * Streaming peer of `@dexterai/x402/batch-settlement`. Where batch-settlement
 * amortizes gas across N DISCRETE paid requests, `tab` is for *continuous
 * metered consumption* — tokens, bytes, frames, seconds — settled on close.
 *
 * @example
 * ```ts
 * import { openTab } from '@dexterai/x402/tab';
 * import { createSolanaVaultAdapter } from '@dexterai/x402/tab/adapters/solana';
 *
 * const vault = createSolanaVaultAdapter({ ... });
 * const tab = await openTab({
 *   vault,
 *   network: 'solana:mainnet',
 *   seller: 'https://api.example.com',
 *   perUnitCap: '0.001',
 *   totalCap: '5.00',
 * });
 *
 * const stream = await tab.stream('https://api.example.com/inference', {
 *   method: 'POST',
 *   body: JSON.stringify({ prompt: 'Hello' }),
 * });
 *
 * for await (const chunk of stream) {
 *   process.stdout.write(chunk);
 * }
 *
 * await tab.close();
 * ```
 *
 * Phase 1 (this file) locks the public contract; downstream phases fill the
 * bodies without being able to drift the public shape.
 */

export type {
  Tab,
  TabState,
  TabCloseResult,
  TabNetworkId,
  AtomicAmount,
  HumanAmount,
  SessionScope,
  SessionKey,
  VoucherPayload,
  SignedVoucher,
  VaultAdapter,
  OpenTabOptions,
  ResumeTabOptions,
  AuthorizeSessionOptions,
  LiveSessionDetails,
} from './types';

export {
  UnsupportedNetworkError,
  SessionScopeExceededError,
  TabClosedError,
  LiveSessionExistsError,
} from './types';

// Phase 2 implementations.
export { openTab, resumeTab, humanToAtomic, atomicToHuman, voucherToHeader, armTabOpen, DEFAULT_FACILITATOR_URL } from './tab';

// Grant lane: a Tab from a granted session key (the /tabs/connect ceremony's
// custody modes) — openTab minus the passkey, resume = the on-chain frontier.
export {
  tabFromGrant,
  type TabFromGrantOptions,
  type ApprovedSpendGrantParams,
} from './from-grant';

// Step 3a: pay-a-URL — counterparty resolved from the wire, never the caller.
export { resolveTabOffer, type TabOffer, type TabOfferResult } from './resolve';
export {
  HOSTED_TAB_ACCEPTANCE_RULE,
  HOSTED_TAB_REGISTRATION_ENCODING,
  HOSTED_TAB_TERMS_VERSION,
  HOSTED_TAB_VOUCHER_HEADER,
} from './hosted-terms';
export {
  payUrlWithTab,
  type PayUrlWithTabOptions,
  type PayUrlWithTabResult,
} from './pay-url';

// Protocol primitives — re-exported from @dexterai/vault through the local
// shim so existing consumers of `@dexterai/x402/tab` can import them by name.
export {
  sessionRegisterMessage,
  sessionRevokeMessage,
  voucherPayloadMessage,
  buildVoucherMessage,
  type SessionRegisterMessageArgs,
  type SessionRevokeMessageArgs,
  type VoucherPayloadBytes,
} from './messages';

export {
  buildRegisterSessionKeyInstruction,
  buildRevokeSessionKeyInstruction,
  buildSecp256r1VerifyInstruction,
  DEXTER_VAULT_PROGRAM_ID,
  SECP256R1_PROGRAM_ID,
  INSTRUCTIONS_SYSVAR_ID,
  type BuildRegisterSessionKeyArgs,
  type BuildRevokeSessionKeyArgs,
} from './instructions';

// Step 3b: pre-flight resolution — a URL's tab terms without paying.
export {
  resolveTabTerms,
  type TabTerms,
  type TabTermsResult,
  type ResolveTabTermsOptions,
} from './terms';

// Session-key primitives for DELEGATED-SIGNER integrations (Hark mandates,
// 2026-07-19): a service that holds a subscriber's session key and signs
// per-delivery voucher increments needs the raw building blocks, not the
// Tab class (which assumes the buyer's own process drives the stream).
export {
  generateSessionKeypair,
  makeSessionKey,
  signVoucher,
  signContextBoundFinalVoucherV2,
  scopeCapAtomic,
  parseAtomic,
  deriveChannelId,
  type SignContextBoundFinalVoucherV2Input,
  type SignContextBoundFinalVoucherV2Result,
} from './sessions';
