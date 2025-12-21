/**
 * @dexter/x402-solana/client
 *
 * Client SDK for making x402 v2 payments on Solana.
 * Wraps fetch with automatic 402 handling.
 */

export { createX402Client } from './x402-client';
export type { X402ClientConfig, X402Client } from './x402-client';

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
  X402ErrorCode,
} from '../types';

