/**
 * @dexterai/x402/tab/seller — Express middleware + SSE helper for OTS tabs.
 *
 * The middleware verifies vouchers locally and injects a `SellerTab` onto
 * `req.tab` that the route handler drives. `openSse` is a convenience helper
 * that turns an Express response into an SSE meter.
 *
 * @example
 * ```ts
 * import { tabMiddleware, openSse, requireTab } from '@dexterai/x402/tab/seller';
 * import { Connection } from '@solana/web3.js';
 *
 * const connection = new Connection(process.env.RPC!);
 * app.post('/inference',
 *   tabMiddleware({
 *     connection,
 *     sellerPubkey: process.env.SELLER_PUBKEY!,
 *     perUnit: '0.00003',
 *     network: 'solana:mainnet',
 *     settle: 'on-close',
 *   }),
 *   async (req, res) => {
 *     const tab = requireTab(req);
 *     const meter = openSse(res, { tab, perUnit: '0.00003' });
 *     for await (const token of llm(req.body.prompt)) {
 *       await meter.charge(1);
 *       meter.send(token);
 *     }
 *     meter.end();
 *   }
 * );
 * ```
 */

// Public types.
export type {
  VoucherStore,
  SellerTab,
  TabMiddlewareOptions,
  OpenSseOptions,
  SseMeter,
} from './types';
export { InvalidVoucherError } from './types';

// Middleware + helpers.
export {
  tabMiddleware,
  requireTab,
  TAB_VOUCHER_HEADER,
  type TabMiddlewareConfig,
} from './middleware';

export { openSse } from './meter';

// Voucher persistence.
export {
  InMemoryVoucherStore,
  FileVoucherStore,
} from './voucher-store';

// Verification primitives (exposed for sellers who want to do bespoke
// flows outside the canned middleware).
export {
  parseRegistration,
  verifyRegistrationOnChain,
  verifyVoucherSignature,
  enforceScope,
  InvalidRegistrationError,
  OnChainVerificationError,
  InvalidVoucherSignatureError,
  ScopeViolationError,
  type ParsedRegistration,
} from './verify';

// Discovery: standard x402 v2 challenge for voucher-less requests.
// Compose BEFORE tabMiddleware.
export {
  tabChallengeMiddleware,
  type TabChallengeConfig,
} from './challenge';

export { tabOrExactMiddleware, type TabOrExactConfig } from './dual';
