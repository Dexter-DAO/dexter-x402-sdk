import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvmAdapter, BSC_MAINNET, BSC_USDT, BSC_USDC } from '../evm';
import type { PaymentAccept } from '../../types';

const FACILITATOR_CONTRACT = '0x3D56A1A196aC81c959A1be21ABC28c173fB063B8';
const PAYER = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
const SELLER = '0x1111111111111111111111111111111111111111';

function createAccept(overrides: Partial<PaymentAccept> & { extra?: Record<string, unknown> } = {}): PaymentAccept {
  return {
    scheme: 'exact-approval',
    network: BSC_MAINNET,
    amount: '1000000000000000000', // 1 USDT (18 decimals)
    asset: BSC_USDT,
    payTo: SELLER,
    maxTimeoutSeconds: 300,
    extra: {
      decimals: 18,
      facilitatorContract: FACILITATOR_CONTRACT,
      fee: '5000000000000000', // 0.005 USDT
      eip712Domain: {
        name: 'DexterBSCFacilitator',
        version: '1',
        chainId: 56,
        verifyingContract: FACILITATOR_CONTRACT,
      },
      eip712Types: {
        Payment: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'fee', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'paymentId', type: 'bytes32' },
        ],
      },
      approvalStrategy: {
        mode: 'buffered',
        defaultMultiple: 10,
        maxCapUsd: 5,
        exactAboveUsd: 1,
      },
      ...overrides.extra,
    },
    ...overrides,
  } as PaymentAccept;
}

function createWallet(overrides: Record<string, unknown> = {}) {
  return {
    address: PAYER,
    signTypedData: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(65)),
    sendTransaction: vi.fn().mockResolvedValue('0x' + 'cd'.repeat(32)),
    ...overrides,
  };
}

// Mock fetch for RPC calls (allowance check, receipt polling)
function mockFetchResponses(allowance: bigint, receiptStatus = '0x1') {
  const paddedAllowance = '0x' + allowance.toString(16).padStart(64, '0');
  let callCount = 0;
  return vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) || '{}');
    if (body.method === 'eth_call') {
      // allowance check
      return {
        ok: true,
        json: async () => ({ result: paddedAllowance }),
      };
    }
    if (body.method === 'eth_getTransactionReceipt') {
      callCount++;
      // First call: null (pending), second call: receipt
      if (callCount <= 1) {
        return { ok: true, json: async () => ({ result: null }) };
      }
      return {
        ok: true,
        json: async () => ({ result: { status: receiptStatus } }),
      };
    }
    return { ok: true, json: async () => ({ result: '0x0' }) };
  });
}

describe('EvmAdapter — exact-approval (BSC)', () => {
  let adapter: EvmAdapter;

  beforeEach(() => {
    vi.restoreAllMocks();
    adapter = new EvmAdapter({ verbose: false });
  });

  // ============================================================
  // Discovery / Constants
  // ============================================================

  describe('BSC support', () => {
    it('canHandle recognizes BSC mainnet', () => {
      expect(adapter.canHandle(BSC_MAINNET)).toBe(true);
      expect(adapter.canHandle('eip155:56')).toBe(true);
      expect(adapter.canHandle('bsc')).toBe(true);
    });

    it('has BSC in networks list', () => {
      expect(adapter.networks).toContain(BSC_MAINNET);
    });

    it('returns BSC RPC URL', () => {
      expect(adapter.getDefaultRpcUrl(BSC_MAINNET)).toBe('https://bsc-dataseed1.binance.org');
      expect(adapter.getDefaultRpcUrl('bsc')).toBe('https://bsc-dataseed1.binance.org');
    });
  });

  // ============================================================
  // Happy path: sufficient allowance, skip approval
  // ============================================================

  describe('buildTransaction — sufficient allowance', () => {
    it('skips approval tx and signs EIP-712 Payment message', async () => {
      const wallet = createWallet();
      const accept = createAccept();
      // Allowance of 100 USDT — more than enough
      const mockFetch = mockFetchResponses(BigInt('100000000000000000000'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await adapter.buildTransaction(accept, wallet);

      // Should NOT have called sendTransaction (no approval needed)
      expect(wallet.sendTransaction).not.toHaveBeenCalled();

      // Should have called signTypedData for the Payment message
      expect(wallet.signTypedData).toHaveBeenCalledOnce();
      const signCall = wallet.signTypedData.mock.calls[0][0];
      expect(signCall.primaryType).toBe('Payment');
      expect(signCall.domain.name).toBe('DexterBSCFacilitator');
      expect(signCall.domain.verifyingContract).toBe(FACILITATOR_CONTRACT);

      // Verify payload shape
      const payload = JSON.parse(result.serialized);
      expect(payload.from).toBe(PAYER);
      expect(payload.to).toBe(SELLER);
      expect(payload.token).toBe(BSC_USDT);
      expect(payload.amount).toBe('1000000000000000000');
      expect(payload.fee).toBe('5000000000000000');
      expect(payload.signature).toBeDefined();
      expect(payload.nonce).toBeDefined();
      expect(payload.deadline).toBeDefined();
      expect(payload.paymentId).toMatch(/^0x[a-f0-9]{64}$/);

      vi.unstubAllGlobals();
    });
  });

  // ============================================================
  // Happy path: insufficient allowance, triggers approval
  // ============================================================

  describe('buildTransaction — insufficient allowance', () => {
    it('sends approval tx then signs EIP-712 Payment message', async () => {
      const wallet = createWallet();
      const accept = createAccept();
      // Zero allowance — needs approval
      const mockFetch = mockFetchResponses(0n);
      vi.stubGlobal('fetch', mockFetch);

      const result = await adapter.buildTransaction(accept, wallet);

      // Should have called sendTransaction for approval
      expect(wallet.sendTransaction).toHaveBeenCalledOnce();
      const approveTx = wallet.sendTransaction.mock.calls[0][0];
      expect(approveTx.to).toBe(BSC_USDT);
      // approve(address,uint256) selector = 0x095ea7b3
      expect(approveTx.data).toMatch(/^0x095ea7b3/);

      // Should also have signed the Payment
      expect(wallet.signTypedData).toHaveBeenCalledOnce();

      // Payload should still be valid
      const payload = JSON.parse(result.serialized);
      expect(payload.from).toBe(PAYER);
      expect(payload.signature).toBeDefined();

      vi.unstubAllGlobals();
    });

    it('uses buffered approval strategy (10x, $5 cap)', async () => {
      const wallet = createWallet();
      // Small payment: 0.01 USDT = 10000000000000000 (18 dec)
      const accept = createAccept({
        amount: '10000000000000000',
        extra: {
          decimals: 18,
          facilitatorContract: FACILITATOR_CONTRACT,
          fee: '0',
          eip712Domain: {
            name: 'DexterBSCFacilitator',
            version: '1',
            chainId: 56,
            verifyingContract: FACILITATOR_CONTRACT,
          },
          eip712Types: {
            Payment: [
              { name: 'from', type: 'address' },
              { name: 'to', type: 'address' },
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
              { name: 'fee', type: 'uint256' },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' },
              { name: 'paymentId', type: 'bytes32' },
            ],
          },
          approvalStrategy: {
            mode: 'buffered',
            defaultMultiple: 10,
            maxCapUsd: 5,
            exactAboveUsd: 1,
          },
        },
      });
      const mockFetch = mockFetchResponses(0n);
      vi.stubGlobal('fetch', mockFetch);

      await adapter.buildTransaction(accept, wallet);

      // The approval amount should be 10x the payment (0.1 USDT), not the exact 0.01
      const approveTx = wallet.sendTransaction.mock.calls[0][0];
      const approvedAmount = BigInt('0x' + approveTx.data.slice(74)); // skip selector + address
      // 10x of 0.01 USDT = 0.1 USDT = 100000000000000000
      expect(approvedAmount).toBe(100000000000000000n);

      vi.unstubAllGlobals();
    });
  });

  // ============================================================
  // Error cases
  // ============================================================

  describe('buildTransaction — error cases', () => {
    it('throws if facilitatorContract missing from extra', async () => {
      const wallet = createWallet();
      const accept = createAccept();
      delete (accept.extra as Record<string, unknown>).facilitatorContract;

      await expect(adapter.buildTransaction(accept, wallet))
        .rejects.toThrow('extra.facilitatorContract');
    });

    it('throws if wallet lacks sendTransaction and approval needed', async () => {
      const wallet = createWallet({ sendTransaction: undefined });
      const accept = createAccept();
      const mockFetch = mockFetchResponses(0n);
      vi.stubGlobal('fetch', mockFetch);

      await expect(adapter.buildTransaction(accept, wallet))
        .rejects.toThrow('sendTransaction');

      vi.unstubAllGlobals();
    });

    it('throws if wallet lacks signTypedData', async () => {
      const wallet = createWallet({ signTypedData: undefined });
      const accept = createAccept();

      await expect(adapter.buildTransaction(accept, wallet))
        .rejects.toThrow('signTypedData');
    });

    it('throws if approval tx reverts', async () => {
      const wallet = createWallet();
      const accept = createAccept();
      // Reverted receipt
      const mockFetch = mockFetchResponses(0n, '0x0');
      vi.stubGlobal('fetch', mockFetch);

      await expect(adapter.buildTransaction(accept, wallet))
        .rejects.toThrow('reverted');

      vi.unstubAllGlobals();
    });
  });

  // ============================================================
  // Existing EIP-3009 path is untouched
  // ============================================================

  describe('buildTransaction — exact scheme (EIP-3009)', () => {
    it('still builds TransferWithAuthorization for non-BSC chains', async () => {
      const wallet = createWallet();
      const accept: PaymentAccept = {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '1000000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: SELLER,
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2' },
      };

      const result = await adapter.buildTransaction(accept, wallet);

      const signCall = wallet.signTypedData.mock.calls[0][0];
      expect(signCall.primaryType).toBe('TransferWithAuthorization');
      expect(signCall.domain.verifyingContract).toBe(accept.asset);

      const payload = JSON.parse(result.serialized);
      expect(payload.authorization).toBeDefined();
      expect(payload.signature).toBeDefined();
      // Should NOT have BSC payload fields
      expect(payload.token).toBeUndefined();
      expect(payload.paymentId).toBeUndefined();
    });
  });

  // ============================================================
  // Payload field validation
  // ============================================================

  describe('payload fields', () => {
    it('nonce is a valid numeric string', async () => {
      const wallet = createWallet();
      const accept = createAccept();
      const mockFetch = mockFetchResponses(BigInt('100000000000000000000'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await adapter.buildTransaction(accept, wallet);
      const payload = JSON.parse(result.serialized);
      expect(Number(payload.nonce)).toBeGreaterThan(0);
      // 128-bit nonce max is 2^128 - 1, should be numeric string
      expect(BigInt(payload.nonce)).toBeGreaterThan(0n);

      vi.unstubAllGlobals();
    });

    it('deadline is in the future', async () => {
      const wallet = createWallet();
      const accept = createAccept();
      const mockFetch = mockFetchResponses(BigInt('100000000000000000000'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await adapter.buildTransaction(accept, wallet);
      const payload = JSON.parse(result.serialized);
      const now = Math.floor(Date.now() / 1000);
      expect(Number(payload.deadline)).toBeGreaterThan(now);

      vi.unstubAllGlobals();
    });

    it('works with BSC USDC too', async () => {
      const wallet = createWallet();
      const accept = createAccept({ asset: BSC_USDC });
      const mockFetch = mockFetchResponses(BigInt('100000000000000000000'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await adapter.buildTransaction(accept, wallet);
      const payload = JSON.parse(result.serialized);
      expect(payload.token).toBe(BSC_USDC);

      vi.unstubAllGlobals();
    });
  });
});
