/**
 * @dexter/x402-solana/client
 *
 * Client SDK for making x402 v2 payments on Solana.
 * Wraps fetch with automatic 402 handling.
 *
 * @example
 * ```ts
 * import { createX402Client } from '@dexter/x402-solana/client';
 *
 * const client = createX402Client({
 *   wallet,
 *   network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
 * });
 *
 * const response = await client.fetch('https://api.example.com/endpoint');
 * ```
 */

// Main exports
export { createX402Client } from './x402-client';
export type { X402ClientConfig, X402Client, X402Wallet } from './x402-client';

// Transaction building (for advanced use cases)
export { buildPaymentTransaction, serializeTransaction } from './transaction-builder';

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
