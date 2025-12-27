/**
 * @dexter/x402-solana/server
 *
 * Server SDK for accepting x402 v2 payments.
 * Helpers for building requirements, verifying, and settling.
 *
 * @example
 * ```ts
 * import { createX402Server } from '@dexter/x402-solana/server';
 *
 * const server = createX402Server({
 *   payTo: 'YourSolanaAddress...',
 * });
 *
 * // Build 402 response
 * const requirements = await server.buildRequirements({
 *   amountAtomic: '30000',
 *   resourceUrl: req.url,
 * });
 *
 * // Verify payment
 * const verified = await server.verifyPayment(paymentHeader);
 *
 * // Settle payment
 * const settled = await server.settlePayment(paymentHeader);
 * ```
 */

// Main exports
export { createX402Server } from './x402-server';
export type { X402ServerConfig, X402Server, BuildRequirementsOptions } from './x402-server';

// Facilitator client (for advanced use cases)
export { FacilitatorClient } from './facilitator-client';
export type { SupportedKind, SupportedResponse, VerifyResponse, SettleResponse } from './facilitator-client';

// Re-export shared types and constants
export {
  SOLANA_MAINNET_NETWORK,
  USDC_MINT,
  DEXTER_FACILITATOR_URL,
  X402Error,
} from '../types';

export type {
  PaymentRequired,
  PaymentSignature,
  PaymentAccept,
  ResourceInfo,
  AssetConfig,
  AcceptsExtra,
  X402ErrorCode,
} from '../types';

// Re-export utilities
export {
  getDefaultRpcUrl,
  isSolanaNetwork,
  toCAIP2Network,
  encodePaymentRequired,
  decodePaymentRequired,
  buildPaymentSignature,
  encodePaymentSignature,
  decodePaymentSignature,
  toAtomicUnits,
  fromAtomicUnits,
} from '../utils';
