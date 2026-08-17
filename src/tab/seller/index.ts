/**
 * @dexterai/x402/tab/seller — Express middleware + SSE helper for OTS tabs.
 *
 * The middleware verifies vouchers locally and injects a `SellerTab` onto
 * `req.tab` that the route handler drives. `openSse` is a convenience helper
 * that turns an Express response into an SSE meter.
 *
 * @example
 * ```ts
 * import {
 *   FileChannelLedger,
 *   tabMiddleware,
 *   openSse,
 *   requireTab,
 * } from '@dexterai/x402/tab/seller';
 * import { Connection } from '@solana/web3.js';
 *
 * const connection = new Connection(process.env.RPC!);
 * const ledgerDir = process.env.TAB_LEDGER_DIR;
 * const channelIdCutover = process.env.TAB_CHANNEL_ID_CUTOVER;
 * if (!ledgerDir) throw new Error('TAB_LEDGER_DIR must name persistent storage');
 * if (channelIdCutover !== 'legacy-case-aliases-migrated-or-empty') {
 *   throw new Error('prove the store empty or complete the documented alias migration first');
 * }
 * const ledger = new FileChannelLedger(ledgerDir, { channelIdCutover });
 * app.post('/inference',
 *   tabMiddleware({
 *     connection,
 *     sellerPubkey: process.env.SELLER_PUBKEY!,
 *     perUnit: '0.00003',
 *     network: 'solana:mainnet',
 *     settle: 'on-close',
 *     ledger,
 *     ledgerSafetyMode: 'production-single-instance',
 *   }),
 *   async (req, res) => {
 *     const tab = requireTab(req);
 *     const meter = openSse(res, { tab, perUnit: '0.00003' });
 *     for await (const token of llm(req.body.prompt)) {
 *       await meter.charge(1);
 *       meter.send(token);
 *     }
 *     await meter.end();
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

// Durable per-channel ledger (off-chain deliveredCumulative + last voucher).
//
// Every adapter declares restartSafe/multiInstanceSafe and must condition every
// mutation/release on the acquired owner token + monotonic fence. InMemory is
// development-only; File is restart-safe for one seller process; Redis provides
// multi-instance fencing and becomes restart-safe only with the explicit
// verified durability + stopped-legacy-writer attestations. tabMiddleware's
// production safety modes reject weaker adapters instead of silently falling
// back.
export type {
  ChannelLedger,
  ChannelLedgerEntry,
  ChannelLedgerCapabilities,
  ChannelLedgerUpdater,
  ChannelLease,
  ChannelIdCutover,
  FileChannelLedgerOptions,
  OnChainLedgerSnapshot,
} from './channel-ledger';
export {
  ChannelLeaseLostError,
  InMemoryChannelLedger,
  FileChannelLedger,
  serializeChannelLedgerEntry,
  deserializeChannelLedgerEntry,
} from './channel-ledger';
export type { SerializedEntry } from './channel-ledger';
export {
  RedisChannelLedger,
  RedisKeyspaceMigrationRequiredError,
} from './redis-channel-ledger';
export type {
  RedisLikeClient,
  RedisDurabilityAttestation,
  RedisChannelLedgerOptions,
  RedisKeyLayout,
} from './redis-channel-ledger';

// Middleware + helpers.
export {
  tabMiddleware,
  requireTab,
  TAB_VOUCHER_HEADER,
  type TabMiddlewareConfig,
} from './middleware';

export { openSse } from './meter';

// Deprecated voucher persistence — superseded by ChannelLedger above.
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
