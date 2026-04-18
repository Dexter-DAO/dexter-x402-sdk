/**
 * @dexterai/x402 — Canonical constants
 *
 * Single source of truth for network identifiers, token addresses, RPC URLs,
 * explorer templates, and protocol-level defaults. Everything else in the SDK
 * imports from here.
 *
 * Source of truth for chain configuration: `dexter-facilitator/src/config/chains.ts`
 * (updates to chain coverage must land in both places).
 */

// ============================================================================
// CAIP-2 Network Identifiers
// ============================================================================

/** CAIP-2 network identifier for Solana mainnet */
export const SOLANA_MAINNET_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** CAIP-2 network identifier for Solana devnet */
export const SOLANA_DEVNET_NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/** CAIP-2 network identifier for Solana testnet */
export const SOLANA_TESTNET_NETWORK = 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z';

/** Aliases preserved for backwards compatibility (existing public exports) */
export const SOLANA_MAINNET = SOLANA_MAINNET_NETWORK;
export const SOLANA_DEVNET = SOLANA_DEVNET_NETWORK;
export const SOLANA_TESTNET = SOLANA_TESTNET_NETWORK;

/** CAIP-2 network identifiers for EVM chains */
export const BASE_MAINNET_NETWORK = 'eip155:8453';
export const BASE_SEPOLIA_NETWORK = 'eip155:84532';
export const ARBITRUM_ONE_NETWORK = 'eip155:42161';
export const POLYGON_NETWORK = 'eip155:137';
export const OPTIMISM_NETWORK = 'eip155:10';
export const AVALANCHE_NETWORK = 'eip155:43114';
export const BSC_MAINNET_NETWORK = 'eip155:56';
export const SKALE_BASE_NETWORK = 'eip155:1187947933';
export const SKALE_BASE_SEPOLIA_NETWORK = 'eip155:324705682';

/** @deprecated Not supported by the Dexter facilitator. Use BASE_MAINNET for EVM payments. */
export const ETHEREUM_MAINNET_NETWORK = 'eip155:1';

/** Aliases preserved for backwards compatibility (existing public exports) */
export const BASE_MAINNET = BASE_MAINNET_NETWORK;
export const BASE_SEPOLIA = BASE_SEPOLIA_NETWORK;
export const ARBITRUM_ONE = ARBITRUM_ONE_NETWORK;
export const POLYGON = POLYGON_NETWORK;
export const OPTIMISM = OPTIMISM_NETWORK;
export const AVALANCHE = AVALANCHE_NETWORK;
export const BSC_MAINNET = BSC_MAINNET_NETWORK;
export const SKALE_BASE = SKALE_BASE_NETWORK;
export const SKALE_BASE_SEPOLIA = SKALE_BASE_SEPOLIA_NETWORK;
export const ETHEREUM_MAINNET = ETHEREUM_MAINNET_NETWORK;

// ============================================================================
// Token Addresses
// ============================================================================

/** USDC mint on Solana mainnet */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** USDC mint on Solana devnet */
export const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/** USDC on Base mainnet (alias preserved for backwards compatibility) */
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** BSC stablecoin addresses (18 decimals — unlike 6 on every other chain) */
export const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955';
export const BSC_USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

/** USDC contract addresses indexed by CAIP-2 network */
export const USDC_ADDRESSES: Record<string, string> = {
  [BSC_MAINNET_NETWORK]: BSC_USDC,
  [BASE_MAINNET_NETWORK]: USDC_BASE,
  [BASE_SEPOLIA_NETWORK]: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  [ARBITRUM_ONE_NETWORK]: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  [POLYGON_NETWORK]: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  [OPTIMISM_NETWORK]: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  [AVALANCHE_NETWORK]: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  [SKALE_BASE_NETWORK]: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
  [SKALE_BASE_SEPOLIA_NETWORK]: '0x2e08028E3C4c2356572E096d8EF835cD5C6030bD',
  [ETHEREUM_MAINNET_NETWORK]: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
};

/**
 * Known BSC stablecoin metadata (for isKnownStablecoin checks).
 * Both use 18 decimals on BSC, unlike the 6 decimals on all other chains.
 */
export const BSC_STABLECOIN_ADDRESSES: Record<string, { symbol: string; decimals: number }> = {
  [BSC_USDT]: { symbol: 'USDT', decimals: 18 },
  [BSC_USDC]: { symbol: 'USDC', decimals: 18 },
};

/** Default USDC decimals across every chain except BSC */
export const USDC_DECIMALS = 6;

// ============================================================================
// Permit2 (Uniswap canonical deployment, same address on every EVM chain)
// ============================================================================

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const X402_EXACT_PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';

// ============================================================================
// EVM Chain IDs (numeric, for eth_chainId)
// ============================================================================

export const CHAIN_IDS: Record<string, number> = {
  [BSC_MAINNET_NETWORK]: 56,
  [BASE_MAINNET_NETWORK]: 8453,
  [BASE_SEPOLIA_NETWORK]: 84532,
  [ARBITRUM_ONE_NETWORK]: 42161,
  [POLYGON_NETWORK]: 137,
  [OPTIMISM_NETWORK]: 10,
  [AVALANCHE_NETWORK]: 43114,
  [SKALE_BASE_NETWORK]: 1187947933,
  [SKALE_BASE_SEPOLIA_NETWORK]: 324705682,
  [ETHEREUM_MAINNET_NETWORK]: 1,
};

// ============================================================================
// Default RPC URLs
// ============================================================================

/** Solana RPC URLs. Mainnet uses Dexter's RPC proxy for reliability and zero-config setup. */
export const SOLANA_RPC_URLS: Record<string, string> = {
  [SOLANA_MAINNET_NETWORK]: 'https://api.dexter.cash/api/solana/rpc',
  [SOLANA_DEVNET_NETWORK]: 'https://api.devnet.solana.com',
  [SOLANA_TESTNET_NETWORK]: 'https://api.testnet.solana.com',
};

/** EVM RPC URLs. Base mainnet uses Dexter's RPC proxy. */
export const EVM_RPC_URLS: Record<string, string> = {
  [BSC_MAINNET_NETWORK]: 'https://bsc-dataseed1.binance.org',
  [BASE_MAINNET_NETWORK]: 'https://api.dexter.cash/api/base/rpc',
  [BASE_SEPOLIA_NETWORK]: 'https://sepolia.base.org',
  [ARBITRUM_ONE_NETWORK]: 'https://arb1.arbitrum.io/rpc',
  [POLYGON_NETWORK]: 'https://polygon-rpc.com',
  [OPTIMISM_NETWORK]: 'https://mainnet.optimism.io',
  [AVALANCHE_NETWORK]: 'https://api.avax.network/ext/bc/C/rpc',
  [SKALE_BASE_NETWORK]: 'https://skale-base.skalenodes.com/v1/base',
  [SKALE_BASE_SEPOLIA_NETWORK]: 'https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha',
  [ETHEREUM_MAINNET_NETWORK]: 'https://eth.llamarpc.com',
};

// ============================================================================
// Facilitator
// ============================================================================

/** Dexter's public x402 v2 facilitator URL */
export const DEXTER_FACILITATOR_URL = 'https://x402.dexter.cash';

// ============================================================================
// Defaults referenced across server + client
// ============================================================================

/** Default CAIP-2 network when one isn't specified (Solana mainnet) */
export const DEFAULT_NETWORK = SOLANA_MAINNET_NETWORK;
