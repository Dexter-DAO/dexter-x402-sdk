/**
 * Utility Functions
 *
 * Chain-agnostic helpers for x402 payments.
 */

import { SOLANA_MAINNET_NETWORK, BASE_MAINNET_NETWORK } from './types';

// ============================================================================
// Amount Conversion
// ============================================================================

/**
 * Convert human-readable amount to atomic units
 *
 * @param amount - Human-readable amount (e.g., 0.05 for $0.05)
 * @param decimals - Token decimals (e.g., 6 for USDC)
 * @returns Amount in atomic units as string
 *
 * @example
 * ```typescript
 * toAtomicUnits(0.05, 6) // '50000'
 * toAtomicUnits(1.50, 6) // '1500000'
 * ```
 */
export function toAtomicUnits(amount: number, decimals: number): string {
  const multiplier = Math.pow(10, decimals);
  return Math.floor(amount * multiplier).toString();
}

/**
 * Convert atomic units to human-readable amount
 *
 * @param atomicUnits - Amount in smallest units
 * @param decimals - Token decimals
 * @returns Human-readable amount
 *
 * @example
 * ```typescript
 * fromAtomicUnits('50000', 6) // 0.05
 * fromAtomicUnits(1500000n, 6) // 1.5
 * ```
 */
export function fromAtomicUnits(
  atomicUnits: string | bigint | number,
  decimals: number
): number {
  const divisor = Math.pow(10, decimals);
  return Number(atomicUnits) / divisor;
}

// ============================================================================
// Network Helpers
// ============================================================================

/**
 * Network type
 */
export type ChainFamily = 'solana' | 'evm' | 'unknown';

/**
 * Get the chain family from a CAIP-2 network identifier
 *
 * @param network - CAIP-2 network identifier
 * @returns Chain family
 *
 * @example
 * ```typescript
 * getChainFamily('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') // 'solana'
 * getChainFamily('eip155:8453') // 'evm'
 * ```
 */
export function getChainFamily(network: string): ChainFamily {
  if (network.startsWith('solana:') || network === 'solana') {
    return 'solana';
  }
  if (network.startsWith('eip155:') || ['base', 'ethereum', 'arbitrum'].includes(network)) {
    return 'evm';
  }
  return 'unknown';
}

/**
 * Get default RPC URL for a network
 *
 * @param network - CAIP-2 network identifier
 * @returns Default RPC URL
 */
export function getDefaultRpcUrl(network: string): string {
  const family = getChainFamily(network);

  if (family === 'solana') {
    if (network.includes('devnet') || network === 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1') {
      return 'https://api.devnet.solana.com';
    }
    if (network.includes('testnet') || network === 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z') {
      return 'https://api.testnet.solana.com';
    }
    return 'https://api.mainnet-beta.solana.com';
  }

  if (family === 'evm') {
    // Extract chain ID from CAIP-2
    if (network.startsWith('eip155:')) {
      const chainId = network.split(':')[1];
      switch (chainId) {
        case '8453': return 'https://mainnet.base.org';
        case '84532': return 'https://sepolia.base.org';
        case '1': return 'https://eth.llamarpc.com';
        case '42161': return 'https://arb1.arbitrum.io/rpc';
        default: return 'https://mainnet.base.org';
      }
    }
    // Legacy names
    if (network === 'base') return 'https://mainnet.base.org';
    if (network === 'ethereum') return 'https://eth.llamarpc.com';
    if (network === 'arbitrum') return 'https://arb1.arbitrum.io/rpc';
    return 'https://mainnet.base.org';
  }

  // Unknown - return a generic
  return 'https://api.mainnet-beta.solana.com';
}

/**
 * Get human-readable chain name
 *
 * @param network - CAIP-2 network identifier
 * @returns Human-readable name
 */
export function getChainName(network: string): string {
  const mapping: Record<string, string> = {
    [SOLANA_MAINNET_NETWORK]: 'Solana',
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'Solana Devnet',
    'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z': 'Solana Testnet',
    'solana': 'Solana',
    [BASE_MAINNET_NETWORK]: 'Base',
    'eip155:84532': 'Base Sepolia',
    'eip155:1': 'Ethereum',
    'eip155:42161': 'Arbitrum One',
    'base': 'Base',
    'ethereum': 'Ethereum',
    'arbitrum': 'Arbitrum',
  };
  return mapping[network] || network;
}

// ============================================================================
// Transaction URL Helpers
// ============================================================================

/**
 * Get explorer URL for a transaction
 *
 * @param txSignature - Transaction signature/hash
 * @param network - CAIP-2 network identifier
 * @returns Explorer URL
 */
export function getExplorerUrl(txSignature: string, network: string): string {
  const family = getChainFamily(network);

  if (family === 'solana') {
    const isDevnet = network.includes('devnet') || network === 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
    if (isDevnet) {
      return `https://solscan.io/tx/${txSignature}?cluster=devnet`;
    }
    // Prefer Orb Markets for mainnet
    return `https://www.orbmarkets.io/tx/${txSignature}`;
  }

  if (family === 'evm') {
    // Extract chain ID
    let chainId = '8453'; // Default to Base
    if (network.startsWith('eip155:')) {
      chainId = network.split(':')[1];
    } else if (network === 'ethereum') {
      chainId = '1';
    } else if (network === 'arbitrum') {
      chainId = '42161';
    }

    switch (chainId) {
      case '8453': return `https://basescan.org/tx/${txSignature}`;
      case '84532': return `https://sepolia.basescan.org/tx/${txSignature}`;
      case '1': return `https://etherscan.io/tx/${txSignature}`;
      case '42161': return `https://arbiscan.io/tx/${txSignature}`;
      default: return `https://basescan.org/tx/${txSignature}`;
    }
  }

  return `https://solscan.io/tx/${txSignature}`;
}

// ============================================================================
// Encoding Helpers
// ============================================================================

/**
 * Encode an object as base64 JSON
 */
export function encodeBase64Json(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

/**
 * Decode base64 JSON to object
 */
export function decodeBase64Json<T>(encoded: string): T {
  return JSON.parse(atob(encoded)) as T;
}
