import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvmAdapter, BSC_MAINNET, BSC_USDT, BSC_USDC, PERMIT2_ADDRESS, X402_EXACT_PERMIT2_PROXY } from '../evm';
import type { PaymentAccept } from '../../types';

const PAYER = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
const SELLER = '0x1111111111111111111111111111111111111111';

function createPermit2Accept(overrides: Partial<PaymentAccept> & { extra?: Record<string, unknown> } = {}): PaymentAccept {
  return {
    scheme: 'exact',
    network: BSC_MAINNET,
    amount: '1000000000000000000', // 1 USDT (18 decimals)
    asset: BSC_USDT,
    payTo: SELLER,
    maxTimeoutSeconds: 300,
    extra: {
      assetTransferMethod: 'permit2',
      decimals: 18,
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

function mockFetchResponses(allowance: bigint, receiptStatus = '0x1') {
  const paddedAllowance = '0x' + allowance.toString(16).padStart(64, '0');
  let receiptCalls = 0;
  return vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) || '{}');
    if (body.method === 'eth_call') {
      return { ok: true, json: async () => ({ result: paddedAllowance }) };
    }
    if (body.method === 'eth_getTransactionReceipt') {
      receiptCalls++;
      if (receiptCalls <= 1) {
        return { ok: true, json: async () => ({ result: null }) };
      }
      return { ok: true, json: async () => ({ result: { status: receiptStatus } }) };
    }
    return { ok: true, json: async () => ({ result: '0x0' }) };
  });
}

describe('EvmAdapter — Permit2', () => {
  let adapter: EvmAdapter;

  beforeEach(() => {
    vi.restoreAllMocks();
    adapter = new EvmAdapter({ verbose: false });
  });

  // ============================================================
  // Happy path: sufficient Permit2 allowance
  // ============================================================

  describe('buildTransaction — sufficient Permit2 allowance', () => {
    it('skips approval and signs PermitWitnessTransferFrom', async () => {
      const wallet = createWallet();
      const accept = createPermit2Accept();
      const mockFetch = mockFetchResponses(BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await adapter.buildTransaction(accept, wallet);

      // Should NOT have called sendTransaction (no approval needed)
      expect(wallet.sendTransaction).not.toHaveBeenCalled();

      // Should have called signTypedData for PermitWitnessTransferFrom
      expect(wallet.signTypedData).toHaveBeenCalledOnce();
      const signCall = wallet.signTypedData.mock.calls[0][0];
      expect(signCall.primaryType).toBe('PermitWitnessTransferFrom');
      expect(signCall.domain.name).toBe('Permit2');
      expect(signCall.domain.verifyingContract).toBe(PERMIT2_ADDRESS);

      // Verify payload shape matches upstream @x402/evm
      const payload = JSON.parse(result.serialized);
      expect(payload.permit2Authorization).toBeDefined();
      expect(payload.permit2Authorization.from).toBe(PAYER);
      expect(payload.permit2Authorization.permitted.token).toBe(BSC_USDT);
      expect(payload.permit2Authorization.permitted.amount).toBe('1000000000000000000');
      expect(payload.permit2Authorization.spender).toBe(X402_EXACT_PERMIT2_PROXY);
      expect(payload.permit2Authorization.witness.to).toBe(SELLER);
      expect(payload.permit2Authorization.nonce).toBeDefined();
      expect(payload.permit2Authorization.deadline).toBeDefined();
      expect(payload.signature).toBeDefined();

      // Should NOT have EIP-3009 fields
      expect(payload.authorization).toBeUndefined();
      // Should NOT have exact-approval fields
      expect(payload.paymentId).toBeUndefined();
      expect(payload.token).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });

  // ============================================================
  // Insufficient allowance: triggers Permit2 approval
  // ============================================================

  describe('buildTransaction — insufficient Permit2 allowance', () => {
    it('sends maxUint256 approval to Permit2 then signs', async () => {
      const wallet = createWallet();
      const accept = createPermit2Accept();
      const mockFetch = mockFetchResponses(0n);
      vi.stubGlobal('fetch', mockFetch);

      const result = await adapter.buildTransaction(accept, wallet);

      // Should have called sendTransaction for Permit2 approval
      expect(wallet.sendTransaction).toHaveBeenCalledOnce();
      const approveTx = wallet.sendTransaction.mock.calls[0][0];
      expect(approveTx.to).toBe(BSC_USDT); // approve on the token contract
      // approve(address,uint256) selector = 0x095ea7b3
      expect(approveTx.data).toMatch(/^0x095ea7b3/);
      // Spender should be Permit2 address (padded to 32 bytes)
      const spenderHex = approveTx.data.slice(10, 74);
      expect(spenderHex.toLowerCase()).toContain(PERMIT2_ADDRESS.slice(2).toLowerCase());

      // Should also have signed PermitWitnessTransferFrom
      expect(wallet.signTypedData).toHaveBeenCalledOnce();
      const signCall = wallet.signTypedData.mock.calls[0][0];
      expect(signCall.primaryType).toBe('PermitWitnessTransferFrom');

      // Payload should be valid
      const payload = JSON.parse(result.serialized);
      expect(payload.permit2Authorization).toBeDefined();

      vi.unstubAllGlobals();
    });
  });

  // ============================================================
  // Error cases
  // ============================================================

  describe('error cases', () => {
    it('throws if wallet lacks sendTransaction and approval needed', async () => {
      const wallet = createWallet({ sendTransaction: undefined });
      const accept = createPermit2Accept();
      const mockFetch = mockFetchResponses(0n);
      vi.stubGlobal('fetch', mockFetch);

      await expect(adapter.buildTransaction(accept, wallet))
        .rejects.toThrow('sendTransaction');

      vi.unstubAllGlobals();
    });

    it('throws if wallet lacks signTypedData', async () => {
      const wallet = createWallet({ signTypedData: undefined });
      const accept = createPermit2Accept();

      await expect(adapter.buildTransaction(accept, wallet))
        .rejects.toThrow('signTypedData');
    });

    it('throws if approval tx reverts', async () => {
      const wallet = createWallet();
      const accept = createPermit2Accept();
      const mockFetch = mockFetchResponses(0n, '0x0');
      vi.stubGlobal('fetch', mockFetch);

      await expect(adapter.buildTransaction(accept, wallet))
        .rejects.toThrow('reverted');

      vi.unstubAllGlobals();
    });
  });

  // ============================================================
  // Works with USDC too
  // ============================================================

  describe('token compatibility', () => {
    it('works with BSC USDC', async () => {
      const wallet = createWallet();
      const accept = createPermit2Accept({ asset: BSC_USDC });
      const mockFetch = mockFetchResponses(BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await adapter.buildTransaction(accept, wallet);
      const payload = JSON.parse(result.serialized);
      expect(payload.permit2Authorization.permitted.token).toBe(BSC_USDC);

      vi.unstubAllGlobals();
    });

    it('works on non-BSC chains with Permit2', async () => {
      const wallet = createWallet();
      const accept = createPermit2Accept({
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '1000000', // 6 decimals
        extra: { assetTransferMethod: 'permit2', decimals: 6 },
      });
      const mockFetch = mockFetchResponses(BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await adapter.buildTransaction(accept, wallet);
      const signCall = wallet.signTypedData.mock.calls[0][0];
      expect(signCall.primaryType).toBe('PermitWitnessTransferFrom');
      expect(signCall.domain.chainId).toBe(8453n);

      vi.unstubAllGlobals();
    });
  });

  // ============================================================
  // Doesn't interfere with existing paths
  // ============================================================

  describe('routing isolation', () => {
    it('uses EIP-3009 when assetTransferMethod is absent', async () => {
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

      const payload = JSON.parse(result.serialized);
      expect(payload.authorization).toBeDefined();
      expect(payload.permit2Authorization).toBeUndefined();
    });

    it('uses exact-approval when scheme is exact-approval', async () => {
      const wallet = createWallet();
      const accept = createPermit2Accept({
        scheme: 'exact-approval' as any,
        extra: {
          decimals: 18,
          facilitatorContract: '0x3D56A1A196aC81c959A1be21ABC28c173fB063B8',
          fee: '0',
          eip712Domain: {
            name: 'DexterBSCFacilitator', version: '1', chainId: 56,
            verifyingContract: '0x3D56A1A196aC81c959A1be21ABC28c173fB063B8',
          },
          eip712Types: {
            Payment: [
              { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
              { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' },
              { name: 'fee', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' }, { name: 'paymentId', type: 'bytes32' },
            ],
          },
        },
      });
      const mockFetch = mockFetchResponses(BigInt('100000000000000000000'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await adapter.buildTransaction(accept, wallet);
      const signCall = wallet.signTypedData.mock.calls[0][0];
      expect(signCall.primaryType).toBe('Payment');

      const payload = JSON.parse(result.serialized);
      expect(payload.permit2Authorization).toBeUndefined();
      expect(payload.paymentId).toBeDefined();

      vi.unstubAllGlobals();
    });
  });
});
