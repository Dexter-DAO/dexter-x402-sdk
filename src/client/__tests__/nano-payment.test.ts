import { afterEach, describe, expect, it, vi } from 'vitest';
import { createX402Client, getPaymentReceipt } from '../x402-client';
import { createEvmAdapter } from '../../adapters/evm';
import { createSolanaAdapter } from '../../adapters/solana';
import { createNanoAdapter, NANO_ASSET, NANO_MAINNET, type NanoWallet } from '../../adapters/nano';
import type { PaymentAccept } from '../../types';

/**
 * A 402 that offers both Base USDC and Nano must be paid on whichever wallet
 * the caller holds. The Nano adapter is opt-in: passed in `adapters`
 * explicitly, never a default.
 */

const url = 'https://merchant.example/tool';
const MERCHANT_NANO = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const PAYER_NANO = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp';
const BLOCK_HASH = 'C'.repeat(64);

const baseUsdc: PaymentAccept = {
  scheme: 'exact', network: 'eip155:8453', amount: '10000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x1111111111111111111111111111111111111111',
  maxTimeoutSeconds: 60, extra: { decimals: 6 },
};
const nano: PaymentAccept = {
  scheme: 'exact', network: NANO_MAINNET, amount: '1000000000000000000000000000', // 0.001 XNO
  asset: NANO_ASSET, payTo: MERCHANT_NANO,
  maxTimeoutSeconds: 60, extra: { decimals: 30 },
};

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

function merchant(accepts: PaymentAccept[]) {
  const paid: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (requestUrl !== url) {
      // EVM balance / allowance fixture. No provider request leaves this process.
      return Response.json({ jsonrpc: '2.0', id: 1, result: `0x${'f'.repeat(64)}` });
    }
    const payment = new Headers(init?.headers).get('PAYMENT-SIGNATURE');
    if (payment) {
      const decoded = JSON.parse(Buffer.from(payment, 'base64').toString());
      paid.push(decoded);
      return new Response('{"result":"ok"}', { status: 200, headers: {
        'PAYMENT-RESPONSE': encode({ success: true, transaction: 'tx', network: decoded.accepted.network }),
      } });
    }
    return new Response('{}', { status: 402, headers: {
      'PAYMENT-REQUIRED': encode({ x402Version: 2, resource: { url }, accepts }),
    } });
  });
  vi.stubGlobal('fetch', fetch);
  return { paid };
}

function nanoWallet(): NanoWallet & { send: ReturnType<typeof vi.fn> } {
  return {
    address: PAYER_NANO,
    send: vi.fn(async () => BLOCK_HASH),
    getBalanceRaw: async () => 10n ** 30n,
  };
}

function evmWallet() {
  const signTypedData = vi.fn(async (_input: unknown) => `0x${'11'.repeat(65)}` as const);
  return { address: '0x2222222222222222222222222222222222222222' as const, signTypedData };
}

const adapters = () => [createSolanaAdapter(), createEvmAdapter(), createNanoAdapter()];

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('x402 client — Base USDC + nano:mainnet offer', () => {
  it('pays on Nano when only a Nano wallet is set', async () => {
    const { paid } = merchant([baseUsdc, nano]);
    const wallet = nanoWallet();

    const res = await createX402Client({ adapters: adapters(), wallets: { nano: wallet } }).fetch(url);

    expect(res.status).toBe(200);
    expect(wallet.send).toHaveBeenCalledWith({ to: MERCHANT_NANO, amountRaw: BigInt(nano.amount) });
    expect(paid).toHaveLength(1);
    expect(paid[0].accepted).toEqual(nano);
    expect(paid[0].payload).toEqual({ blockHash: BLOCK_HASH, account: PAYER_NANO });
    expect(getPaymentReceipt(res)).toMatchObject({
      settlementStatus: 'settled', network: NANO_MAINNET, amountAtomic: nano.amount, assetDecimals: 30,
    });
  });

  it('pays on Base when only an EVM wallet is set, without touching Nano', async () => {
    const { paid } = merchant([baseUsdc, nano]);
    const wallet = evmWallet();

    const res = await createX402Client({ adapters: adapters(), wallets: { evm: wallet } }).fetch(url);

    expect(res.status).toBe(200);
    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
    expect(paid).toHaveLength(1);
    expect(paid[0].accepted).toEqual(baseUsdc);
    expect(paid[0].payload).toHaveProperty('authorization');
  });

  it('honours preferredNetwork when both wallets are set', async () => {
    const { paid } = merchant([baseUsdc, nano]);
    const wallet = nanoWallet();
    const evm = evmWallet();

    await createX402Client({
      adapters: adapters(), wallets: { evm, nano: wallet }, preferredNetwork: NANO_MAINNET,
    }).fetch(url);

    expect(paid[0].accepted).toEqual(nano);
    expect(evm.signTypedData).not.toHaveBeenCalled();
  });

  it('ignores the Nano offer when the Nano adapter is not opted in', async () => {
    merchant([nano]);
    await expect(createX402Client({ wallets: { nano: nanoWallet() } }).fetch(url))
      .rejects.toThrow(/No supported payment option with a connected wallet for: nano:mainnet/);
  });
});
