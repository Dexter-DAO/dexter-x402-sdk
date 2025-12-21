/**
 * @dexter/x402-solana/server
 *
 * Server SDK for accepting x402 v2 payments.
 * Helpers for building requirements, verifying, and settling.
 */

export { createX402Server } from './x402-server';
export type { X402ServerConfig, X402Server, BuildRequirementsOptions } from './x402-server';

// Re-export shared types
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
  X402ErrorCode,
} from '../types';

