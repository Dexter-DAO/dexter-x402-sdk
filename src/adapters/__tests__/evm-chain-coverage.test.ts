import { describe, it, expect } from 'vitest';
import { EvmAdapter } from '../evm';
import type { PaymentAccept } from '../../types';
import {
  BSC_MAINNET,
  BASE_MAINNET,
  BASE_SEPOLIA,
  ETHEREUM_MAINNET,
  ARBITRUM_ONE,
  POLYGON,
  OPTIMISM,
  AVALANCHE,
  WORLD_MAINNET,
  MONAD_MAINNET,
  ROBINHOOD_MAINNET,
  ROBINHOOD_USDG,
  SKALE_BASE,
  SKALE_BASE_SEPOLIA,
  CHAIN_IDS,
  EVM_RPC_URLS,
  USDC_ADDRESSES,
  EIP712_DOMAINS,
} from '../../constants';
import { toNetworkRef } from '../../payment/network-map';

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
    { name: 'World Chain', caip2: WORLD_MAINNET, alias: 'world' },
    { name: 'Monad', caip2: MONAD_MAINNET, alias: 'monad' },
    { name: 'Robinhood Chain', caip2: ROBINHOOD_MAINNET, alias: 'robinhood' },
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

  describe('New-chain pinned facts (verified on-chain 2026-07-19)', () => {
    it('World Chain: eip155:480, USDC 0x79A0..., Alchemy public RPC', () => {
      expect(WORLD_MAINNET).toBe('eip155:480');
      expect(CHAIN_IDS[WORLD_MAINNET]).toBe(480);
      expect(USDC_ADDRESSES[WORLD_MAINNET]).toBe('0x79A02482A880bCE3F13e09Da970dC34db4CD24d1');
      expect(EVM_RPC_URLS[WORLD_MAINNET]).toBe('https://worldchain-mainnet.g.alchemy.com/public');
    });

    it('Monad: eip155:143, USDC 0x7547..., rpc.monad.xyz', () => {
      expect(MONAD_MAINNET).toBe('eip155:143');
      expect(CHAIN_IDS[MONAD_MAINNET]).toBe(143);
      expect(USDC_ADDRESSES[MONAD_MAINNET]).toBe('0x754704Bc059F8C67012fEd69BC8A327a5aafb603');
      expect(EVM_RPC_URLS[MONAD_MAINNET]).toBe('https://rpc.monad.xyz');
    });

    it('Robinhood Chain: eip155:4663, Paxos USDG as the settlement asset', () => {
      expect(ROBINHOOD_MAINNET).toBe('eip155:4663');
      expect(CHAIN_IDS[ROBINHOOD_MAINNET]).toBe(4663);
      // No native Circle USDC on Robinhood Chain — USDG fills the USDC slot.
      expect(ROBINHOOD_USDG).toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
      expect(USDC_ADDRESSES[ROBINHOOD_MAINNET]).toBe(ROBINHOOD_USDG);
      expect(EVM_RPC_URLS[ROBINHOOD_MAINNET]).toBe('https://rpc.mainnet.chain.robinhood.com');
    });
  });

  describe('network-map ENTRIES coverage (CAIP-2 <-> bare)', () => {
    const expected = [
      { caip2: WORLD_MAINNET, bare: 'world' },
      { caip2: MONAD_MAINNET, bare: 'monad' },
      { caip2: ROBINHOOD_MAINNET, bare: 'robinhood' },
      // SKALE was missing from the map entirely — that drift blocked SKALE
      // payments through the SDK's v1/v2 dispatcher. Locked in here.
      { caip2: SKALE_BASE, bare: 'skale-base' },
      { caip2: SKALE_BASE_SEPOLIA, bare: 'skale-base-sepolia' },
    ] as const;

    for (const { caip2, bare } of expected) {
      it(`resolves ${caip2} <-> "${bare}" losslessly`, () => {
        expect(toNetworkRef(caip2)).toEqual({ caip2, bare, family: 'evm' });
        expect(toNetworkRef(bare)).toEqual({ caip2, bare, family: 'evm' });
      });
    }
  });

  describe('EIP-3009 routing + EIP-712 domain for the new chains', () => {
    // A capture wallet: records the domain buildTransaction signs against.
    function captureWallet() {
      const captured: { domain?: Record<string, unknown>; primaryType?: string } = {};
      const wallet = {
        address: '0x1111111111111111111111111111111111111111',
        async signTypedData(params: {
          domain: Record<string, unknown>;
          types: Record<string, unknown[]>;
          primaryType: string;
          message: Record<string, unknown>;
        }) {
          captured.domain = params.domain;
          captured.primaryType = params.primaryType;
          return '0x' + 'ab'.repeat(65);
        },
      };
      return { wallet, captured };
    }

    function acceptFor(network: string, extra?: Record<string, unknown>): PaymentAccept {
      return {
        x402Version: 2,
        scheme: 'exact',
        network,
        asset: USDC_ADDRESSES[network],
        payTo: '0x2222222222222222222222222222222222222222',
        amount: '10000',
        maxTimeoutSeconds: 60,
        extra,
      } as PaymentAccept;
    }

    const cases = [
      { name: 'World Chain', caip2: WORLD_MAINNET, domain: { name: 'USDC', version: '2' } },
      { name: 'Monad', caip2: MONAD_MAINNET, domain: { name: 'USDC', version: '2' } },
      { name: 'Robinhood Chain', caip2: ROBINHOOD_MAINNET, domain: { name: 'Global Dollar', version: '1' } },
    ] as const;

    for (const c of cases) {
      it(`${c.name}: exact routes down the native EIP-3009 path (not permit2/exact-approval)`, async () => {
        const { wallet, captured } = captureWallet();
        const built = await adapter.buildTransaction(acceptFor(c.caip2), wallet);
        // EIP-3009 signs TransferWithAuthorization; the permit2 path signs
        // PermitWitnessTransferFrom and the exact-approval path signs Payment.
        expect(captured.primaryType).toBe('TransferWithAuthorization');
        expect(built.settlementProbe?.kind).toBe('eip3009');
      });

      it(`${c.name}: requirements extra.name/version wins for the EIP-712 domain`, async () => {
        const { wallet, captured } = captureWallet();
        await adapter.buildTransaction(
          acceptFor(c.caip2, { name: c.domain.name, version: c.domain.version, decimals: 6 }),
          wallet,
        );
        expect(captured.domain?.name).toBe(c.domain.name);
        expect(captured.domain?.version).toBe(c.domain.version);
        expect(captured.domain?.chainId).toBe(BigInt(CHAIN_IDS[c.caip2]));
        expect(captured.domain?.verifyingContract).toBe(USDC_ADDRESSES[c.caip2]);
      });

      it(`${c.name}: EIP712_DOMAINS registry backstops a missing extra (never "USD Coin")`, async () => {
        const { wallet, captured } = captureWallet();
        await adapter.buildTransaction(acceptFor(c.caip2), wallet);
        expect(EIP712_DOMAINS[c.caip2]).toEqual(c.domain);
        expect(captured.domain?.name).toBe(c.domain.name);
        expect(captured.domain?.version).toBe(c.domain.version);
      });
    }

    it('Base (Circle FiatToken default) still falls back to "USD Coin"/"2"', async () => {
      const { wallet, captured } = captureWallet();
      await adapter.buildTransaction(acceptFor(BASE_MAINNET), wallet);
      expect(captured.domain?.name).toBe('USD Coin');
      expect(captured.domain?.version).toBe('2');
    });
  });

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
