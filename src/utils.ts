/**
 * Dexter x402 v2 SDK — Utility Functions
 */

import type { PaymentRequired, PaymentSignature, PaymentAccept, ResourceInfo } from './types';
import { SOLANA_MAINNET_NETWORK } from './types';

// CAIP-2 network identifiers
const SOLANA_DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/**
 * Get default RPC URL for a Solana network
 */
export function getDefaultRpcUrl(network: string): string {
  if (network === SOLANA_MAINNET_NETWORK || network === 'solana') {
    return 'https://api.mainnet-beta.solana.com';
  }
  if (network === SOLANA_DEVNET_CAIP2 || network === 'solana-devnet') {
    return 'https://api.devnet.solana.com';
  }
  // Default to mainnet
  return 'https://api.mainnet-beta.solana.com';
}

/**
 * Check if a network identifier is a Solana network
 */
export function isSolanaNetwork(network: string): boolean {
  return (
    network === 'solana' ||
    network === 'solana-devnet' ||
    network.startsWith('solana:')
  );
}

/**
 * Convert simple network name to CAIP-2 format
 */
export function toCAIP2Network(network: string): string {
  if (network === 'solana') return SOLANA_MAINNET_NETWORK;
  if (network === 'solana-devnet') return SOLANA_DEVNET_CAIP2;
  // Already CAIP-2 or unknown, return as-is
  return network;
}

/**
 * Encode PaymentRequired structure for PAYMENT-REQUIRED header
 */
export function encodePaymentRequired(requirements: PaymentRequired): string {
  return btoa(JSON.stringify(requirements));
}

/**
 * Decode PAYMENT-REQUIRED header to PaymentRequired structure
 */
export function decodePaymentRequired(header: string): PaymentRequired {
  try {
    return JSON.parse(atob(header));
  } catch {
    throw new Error('Failed to decode PAYMENT-REQUIRED header');
  }
}

/**
 * Build a PaymentSignature payload for the PAYMENT-SIGNATURE header
 */
export function buildPaymentSignature(
  transactionBase64: string,
  accept: PaymentAccept,
  resource: ResourceInfo
): PaymentSignature {
  return {
    x402Version: 2,
    resource,
    accepted: accept,
    payload: {
      transaction: transactionBase64,
    },
  };
}

/**
 * Encode PaymentSignature for PAYMENT-SIGNATURE header
 */
export function encodePaymentSignature(signature: PaymentSignature): string {
  return btoa(JSON.stringify(signature));
}

/**
 * Decode PAYMENT-SIGNATURE header to PaymentSignature structure
 */
export function decodePaymentSignature(header: string): PaymentSignature {
  try {
    return JSON.parse(atob(header));
  } catch {
    throw new Error('Failed to decode PAYMENT-SIGNATURE header');
  }
}

/**
 * Convert human-readable amount to atomic units
 * @param amount - Amount in human-readable format (e.g., 0.03 for $0.03)
 * @param decimals - Token decimals (6 for USDC)
 * @returns Amount in atomic units as string
 */
export function toAtomicUnits(amount: number, decimals: number): string {
  return Math.floor(amount * Math.pow(10, decimals)).toString();
}

/**
 * Convert atomic units to human-readable amount
 * @param atomicUnits - Amount in atomic units
 * @param decimals - Token decimals (6 for USDC)
 * @returns Amount in human-readable format
 */
export function fromAtomicUnits(atomicUnits: string | bigint, decimals: number): number {
  return Number(atomicUnits) / Math.pow(10, decimals);
}

