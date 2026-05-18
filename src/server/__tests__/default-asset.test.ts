import { describe, it, expect } from 'vitest';
import { resolveDefaultAsset } from '../x402-server';
import {
  SOLANA_MAINNET_NETWORK,
  BASE_MAINNET_NETWORK,
  POLYGON_NETWORK,
  ARBITRUM_ONE_NETWORK,
  OPTIMISM_NETWORK,
  AVALANCHE_NETWORK,
  BSC_MAINNET_NETWORK,
  SKALE_BASE_NETWORK,
  USDC_MINT,
  USDC_BASE,
  BSC_USDC,
  USDC_ADDRESSES,
} from '../../constants';

/**
 * Regression guard: when a multi-chain `network` array is passed to
 * x402Middleware with no explicit `asset`, each per-network gate must
 * resolve USDC on ITS OWN chain. The bug this locks out: every chain's
 * 402 advertised the Solana USDC mint, so an agent paying on Base was
 * told to send a token that does not exist there.
 */
describe('resolveDefaultAsset — per-network USDC resolution', () => {
  it('resolves the Solana USDC mint for Solana mainnet', () => {
    expect(resolveDefaultAsset(SOLANA_MAINNET_NETWORK)).toEqual({
      address: USDC_MINT,
      decimals: 6,
    });
  });

  it('resolves each EVM chain to its own USDC contract', () => {
    expect(resolveDefaultAsset(BASE_MAINNET_NETWORK).address).toBe(USDC_BASE);
    expect(resolveDefaultAsset(POLYGON_NETWORK).address).toBe(
      USDC_ADDRESSES[POLYGON_NETWORK],
    );
    expect(resolveDefaultAsset(ARBITRUM_ONE_NETWORK).address).toBe(
      USDC_ADDRESSES[ARBITRUM_ONE_NETWORK],
    );
    expect(resolveDefaultAsset(OPTIMISM_NETWORK).address).toBe(
      USDC_ADDRESSES[OPTIMISM_NETWORK],
    );
    expect(resolveDefaultAsset(AVALANCHE_NETWORK).address).toBe(
      USDC_ADDRESSES[AVALANCHE_NETWORK],
    );
    expect(resolveDefaultAsset(SKALE_BASE_NETWORK).address).toBe(
      USDC_ADDRESSES[SKALE_BASE_NETWORK],
    );
  });

  it('never returns the Solana mint for an EVM chain', () => {
    for (const network of Object.keys(USDC_ADDRESSES)) {
      expect(resolveDefaultAsset(network).address).not.toBe(USDC_MINT);
    }
  });

  it('applies BSC USDC 18 decimals, not the 6 used elsewhere', () => {
    const bsc = resolveDefaultAsset(BSC_MAINNET_NETWORK);
    expect(bsc.address).toBe(BSC_USDC);
    expect(bsc.decimals).toBe(18);
    // every non-BSC chain stays at 6
    expect(resolveDefaultAsset(BASE_MAINNET_NETWORK).decimals).toBe(6);
  });
});
