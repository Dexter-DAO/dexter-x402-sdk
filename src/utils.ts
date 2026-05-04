/**
 * Utility Functions
 *
 * Chain-agnostic helpers for x402 payments.
 */

import {
  SOLANA_MAINNET_NETWORK,
  SOLANA_DEVNET_NETWORK,
  SOLANA_TESTNET_NETWORK,
  BASE_MAINNET_NETWORK,
  BASE_SEPOLIA_NETWORK,
  ARBITRUM_ONE_NETWORK,
  POLYGON_NETWORK,
  OPTIMISM_NETWORK,
  AVALANCHE_NETWORK,
  BSC_MAINNET_NETWORK,
  SKALE_BASE_NETWORK,
  SKALE_BASE_SEPOLIA_NETWORK,
  ETHEREUM_MAINNET_NETWORK,
} from './constants';

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

/** Check if a CAIP-2 network identifier is a Solana network */
export function isSolanaNetwork(network: string): boolean {
  return network.startsWith('solana:') || network === 'solana';
}

/** Check if a CAIP-2 network identifier is an EVM network */
export function isEvmNetwork(network: string): boolean {
  return network.startsWith('eip155:') || ['base', 'ethereum', 'arbitrum'].includes(network);
}

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
  if (isSolanaNetwork(network)) return 'solana';
  if (isEvmNetwork(network)) return 'evm';
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
    if (network.includes('devnet') || network === SOLANA_DEVNET_NETWORK) {
      return 'https://api.devnet.solana.com';
    }
    if (network.includes('testnet') || network === SOLANA_TESTNET_NETWORK) {
      return 'https://api.testnet.solana.com';
    }
    // Mainnet uses Dexter's RPC proxy
    return 'https://api.dexter.cash/api/solana/rpc';
  }

  if (family === 'evm') {
    // Extract chain ID from CAIP-2
    if (network.startsWith('eip155:')) {
      const chainId = network.split(':')[1];
      switch (chainId) {
        case '8453': return 'https://api.dexter.cash/api/base/rpc'; // Dexter proxy
        case '84532': return 'https://sepolia.base.org';
        case '1': return 'https://eth.llamarpc.com';
        case '42161': return 'https://arb1.arbitrum.io/rpc';
        default: return 'https://api.dexter.cash/api/base/rpc';
      }
    }
    // Legacy names
    if (network === 'base') return 'https://api.dexter.cash/api/base/rpc';
    if (network === 'ethereum') return 'https://eth.llamarpc.com';
    if (network === 'arbitrum') return 'https://arb1.arbitrum.io/rpc';
    return 'https://api.dexter.cash/api/base/rpc';
  }

  // Unknown - return Dexter's Solana proxy
  return 'https://api.dexter.cash/api/solana/rpc';
}

/**
 * Get human-readable chain name
 *
 * @param network - CAIP-2 network identifier
 * @returns Human-readable name
 */
export function getChainName(network: string): string {
  const mapping: Record<string, string> = {
    // Solana family
    [SOLANA_MAINNET_NETWORK]: 'Solana',
    [SOLANA_DEVNET_NETWORK]: 'Solana Devnet',
    [SOLANA_TESTNET_NETWORK]: 'Solana Testnet',
    'solana': 'Solana',
    'solana-devnet': 'Solana Devnet',
    'solana-testnet': 'Solana Testnet',
    // EVM family — keyed by canonical CAIP-2
    [BASE_MAINNET_NETWORK]: 'Base',
    [BASE_SEPOLIA_NETWORK]: 'Base Sepolia',
    [ETHEREUM_MAINNET_NETWORK]: 'Ethereum',
    [ARBITRUM_ONE_NETWORK]: 'Arbitrum',
    [POLYGON_NETWORK]: 'Polygon',
    [OPTIMISM_NETWORK]: 'Optimism',
    [AVALANCHE_NETWORK]: 'Avalanche',
    [BSC_MAINNET_NETWORK]: 'BSC',
    [SKALE_BASE_NETWORK]: 'SKALE Base',
    [SKALE_BASE_SEPOLIA_NETWORK]: 'SKALE Base Sepolia',
    // EVM family — legacy short-form aliases
    'base': 'Base',
    'base-sepolia': 'Base Sepolia',
    'ethereum': 'Ethereum',
    'arbitrum': 'Arbitrum',
    'polygon': 'Polygon',
    'optimism': 'Optimism',
    'avalanche': 'Avalanche',
    'bsc': 'BSC',
    'skale-base': 'SKALE Base',
    'skale-base-sepolia': 'SKALE Base Sepolia',
  };
  return mapping[network] || network;
}

/**
 * Get a human-readable chain name with adapter-family fallback.
 *
 * Differs from {@link getChainName} in the fallback: instead of returning
 * the raw network identifier (which is useful for logging / matching), this
 * returns the adapter family ("Solana" / "EVM") when the chain isn't in
 * the registry. Use this in user-facing strings — error messages, badges,
 * status pills — where exposing a CAIP-2 string would be ugly.
 *
 * @param network - CAIP-2 network identifier or legacy alias
 * @param family - The adapter family name to use as a fallback
 *                 (e.g. 'Solana' or 'EVM')
 */
export function getChainDisplayName(network: string, family: string): string {
  const name = getChainName(network);
  return name === network ? family : name;
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
    const isDevnet = network.includes('devnet') || network === SOLANA_DEVNET_NETWORK;
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
    } else if (network === 'polygon') {
      chainId = '137';
    } else if (network === 'optimism') {
      chainId = '10';
    } else if (network === 'avalanche') {
      chainId = '43114';
    } else if (network === 'bsc') {
      chainId = '56';
    } else if (network === 'skale-base') {
      chainId = '1187947933';
    } else if (network === 'skale-base-sepolia') {
      chainId = '324705682';
    }

    switch (chainId) {
      case '8453': return `https://basescan.org/tx/${txSignature}`;
      case '84532': return `https://sepolia.basescan.org/tx/${txSignature}`;
      case '1': return `https://etherscan.io/tx/${txSignature}`;
      case '42161': return `https://arbiscan.io/tx/${txSignature}`;
      case '137': return `https://polygonscan.com/tx/${txSignature}`;
      case '10': return `https://optimistic.etherscan.io/tx/${txSignature}`;
      case '43114': return `https://snowtrace.io/tx/${txSignature}`;
      case '56': return `https://bscscan.com/tx/${txSignature}`;
      case '1187947933': return `https://elated-tan-skat.explorer.mainnet.skalenodes.com/tx/${txSignature}`;
      case '324705682': return `https://base-sepolia-testnet.explorer.skalenodes.com/tx/${txSignature}`;
      default: return `https://basescan.org/tx/${txSignature}`;
    }
  }

  return `https://solscan.io/tx/${txSignature}`;
}

// ============================================================================
// Encoding Helpers
// ============================================================================

/**
 * Unicode-safe base64 encode a string.
 * Works in both Node.js and browsers, handling characters above U+00FF
 * that would cause btoa() to throw InvalidCharacterError.
 */
function safeBase64Encode(str: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'utf-8').toString('base64');
  }
  // Browser fallback: encode UTF-8 bytes via TextEncoder
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Unicode-safe base64 decode a string.
 * Works in both Node.js and browsers.
 */
function safeBase64Decode(encoded: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(encoded, 'base64').toString('utf-8');
  }
  // Browser fallback: decode via atob then UTF-8
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Encode an object as base64 JSON (Unicode-safe)
 */
export function encodeBase64Json(obj: unknown): string {
  return safeBase64Encode(JSON.stringify(obj));
}

/**
 * Decode base64 JSON to object (Unicode-safe)
 */
export function decodeBase64Json<T>(encoded: string): T {
  return JSON.parse(safeBase64Decode(encoded)) as T;
}
