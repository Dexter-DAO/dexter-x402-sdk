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
 * Implementation phases tracked in `docs/DESIGN-tab-streaming.md` §6. Phase 1
 * (this file) locks the contract; downstream phases fill the bodies without
 * being able to drift the public shape.
 */

import type {
  Tab,
  OpenTabOptions,
  ResumeTabOptions,
} from './types';

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

const NOT_IMPLEMENTED_DETAIL =
  '@dexterai/x402/tab is in Phase 1 (contract lock). Implementation lands in Phase 2 — see docs/DESIGN-tab-streaming.md.';

/**
 * Open a new tab against a seller. ONE passkey prompt authorizes a session
 * key; the session key signs vouchers for the duration of the tab.
 *
 * The returned `Tab` exposes `stream()` and `close()`. The buyer can call
 * `stream()` multiple times against the same seller for the same session.
 *
 * @throws {UnsupportedNetworkError} when the adapter targets an unsupported network
 */
export async function openTab(_options: OpenTabOptions): Promise<Tab> {
  throw new Error(`openTab not_implemented: ${NOT_IMPLEMENTED_DETAIL}`);
}

/**
 * Open a handle to a tab that was opened by a previous (crashed) process.
 * Recovery surface — the prior session key is gone (memory-only by design),
 * so this re-prompts the passkey to authorize a fresh session bound to the
 * same channelId on chain.
 *
 * @throws {UnsupportedNetworkError} when the adapter targets an unsupported network
 */
export async function resumeTab(_options: ResumeTabOptions): Promise<Tab> {
  throw new Error(`resumeTab not_implemented: ${NOT_IMPLEMENTED_DETAIL}`);
}
