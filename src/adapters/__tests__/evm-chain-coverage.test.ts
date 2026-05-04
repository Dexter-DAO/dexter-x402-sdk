import { describe, it, expect } from 'vitest';
import { EvmAdapter } from '../evm';
import {
  BSC_MAINNET,
  BASE_MAINNET,
  BASE_SEPOLIA,
  ETHEREUM_MAINNET,
  ARBITRUM_ONE,
  POLYGON,
  OPTIMISM,
  AVALANCHE,
  SKALE_BASE,
  SKALE_BASE_SEPOLIA,
  CHAIN_IDS,
  EVM_RPC_URLS,
  USDC_ADDRESSES,
} from '../../constants';

/**
 * Coverage matrix: every chain Dexter's facilitator supports must be
 * declared in EvmAdapter.networks, resolvable via canHandle (CAIP-2 +
 * legacy alias), and have an RPC URL, USDC address, and chain ID
 * registered. Without this matrix, adding a new chain to constants.ts
 * but forgetting the adapter declaration causes the verifier to silently
 * pick the wrong chain at runtime.
 */
describe('EvmAdapter — multi-chain coverage matrix', () => {
  const adapter = new EvmAdapter({ verbose: false });

  const declared = [
    { name: 'Base mainnet', caip2: BASE_MAINNET, alias: 'base' },
    { name: 'Base Sepolia', caip2: BASE_SEPOLIA, alias: null },
    { name: 'Ethereum mainnet', caip2: ETHEREUM_MAINNET, alias: 'ethereum' },
    { name: 'Arbitrum One', caip2: ARBITRUM_ONE, alias: 'arbitrum' },
    { name: 'BSC mainnet', caip2: BSC_MAINNET, alias: 'bsc' },
    { name: 'Polygon', caip2: POLYGON, alias: 'polygon' },
    { name: 'Optimism', caip2: OPTIMISM, alias: 'optimism' },
    { name: 'Avalanche', caip2: AVALANCHE, alias: 'avalanche' },
    { name: 'SKALE Base', caip2: SKALE_BASE, alias: 'skale-base' },
    { name: 'SKALE Base Sepolia', caip2: SKALE_BASE_SEPOLIA, alias: 'skale-base-sepolia' },
  ] as const;

  for (const chain of declared) {
    describe(chain.name, () => {
      it('appears in EvmAdapter.networks', () => {
        expect(adapter.networks).toContain(chain.caip2);
      });

      it('canHandle accepts the CAIP-2 identifier', () => {
        expect(adapter.canHandle(chain.caip2)).toBe(true);
      });

      if (chain.alias) {
        const alias = chain.alias;
        it(`canHandle accepts the legacy alias "${alias}"`, () => {
          expect(adapter.canHandle(alias)).toBe(true);
        });

        it(`getDefaultRpcUrl returns the registered RPC for "${alias}"`, () => {
          expect(adapter.getDefaultRpcUrl(alias)).toBe(EVM_RPC_URLS[chain.caip2]);
        });
      }

      it('has a registered chain ID', () => {
        expect(CHAIN_IDS[chain.caip2]).toBeTypeOf('number');
        expect(CHAIN_IDS[chain.caip2]).toBeGreaterThan(0);
      });

      it('has a registered RPC URL', () => {
        expect(EVM_RPC_URLS[chain.caip2]).toBeTypeOf('string');
        expect(EVM_RPC_URLS[chain.caip2]).toMatch(/^https?:\/\//);
      });

      it('has a registered USDC contract address', () => {
        expect(USDC_ADDRESSES[chain.caip2]).toBeTypeOf('string');
        expect(USDC_ADDRESSES[chain.caip2]).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });
    });
  }

  describe('Unknown EIP-155 chain handling', () => {
    it('canHandle accepts any eip155: prefix even without explicit registration', () => {
      // Future-proofing: a 402 from a brand-new chain we haven't yet
      // catalogued should still parse, even if we lack RPC/USDC defaults.
      expect(adapter.canHandle('eip155:9999999')).toBe(true);
    });

    it('rejects non-EVM CAIP-2 identifiers', () => {
      expect(adapter.canHandle('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(false);
    });

    it('rejects garbage strings', () => {
      expect(adapter.canHandle('not-a-network')).toBe(false);
      expect(adapter.canHandle('')).toBe(false);
    });
  });
});
