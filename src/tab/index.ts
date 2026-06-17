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
} from './types';

export {
  UnsupportedNetworkError,
  SessionScopeExceededError,
  TabClosedError,
} from './types';

// Phase 2 implementations.
export { openTab, resumeTab, humanToAtomic, atomicToHuman, voucherToHeader, DEFAULT_FACILITATOR_URL } from './tab';

// Step 3a: pay-a-URL — counterparty resolved from the wire, never the caller.
export { resolveTabOffer, type TabOffer, type TabOfferResult } from './resolve';
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
