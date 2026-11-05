import { afterEach, describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { createBudgetAccount } from '../budget-account';
import { createX402Client } from '../x402-client';
import { SolanaAdapter } from '../../adapters/solana';
import { SOLANA_MAINNET, USDC_MINT } from '../../constants';
import type { PaymentAccept } from '../../types';

const buyer = Keypair.fromSeed(new Uint8Array(32).fill(7));
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey;
const otherMint = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
const url = 'https://merchant.fixture.invalid/data';
const rpcUrl = 'https://rpc.fixture.invalid';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

function offer(decimals: unknown = 6, asset = USDC_MINT): PaymentAccept {
  return {
    scheme: 'exact', network: SOLANA_MAINNET, asset, amount: '1000000',
    payTo: recipient.toBase58(), maxTimeoutSeconds: 60,
    extra: { decimals: decimals as number, feePayer: recipient.toBase58() },
  };
}

// Real mint decoding and client/adapter control flow; all RPC/HTTP stays in
// process. The direct-builder wallet returns an unsigned fixture transaction.
function fixture(accept: PaymentAccept, accessPass = false, mintDecimals = 6, token2022 = false) {
  const programId = token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mintData = Buffer.alloc(82);
  mintData[44] = mintDecimals;
  mintData[45] = 1;
  const accountData = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({
    mint: new PublicKey(accept.asset), owner: buyer.publicKey, amount: 10_000_000n,
    delegateOption: 0, delegate: PublicKey.default, state: 1,
    isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
    closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  }, accountData);
  const rpc = vi.spyOn(Connection.prototype, 'getAccountInfo').mockImplementation(async key => ({
    data: key.toBase58() === accept.asset ? mintData : accountData,
    owner: programId, executable: false, lamports: 1,
  }));
  const blockhash = vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
    blockhash: recipient.toBase58(), lastValidBlockHeight: 100,
  });
  const merchant = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== new URL(url).origin) {
      throw new Error(`Unexpected network access: ${request.url}`);
    }
    if (request.headers.has('PAYMENT-SIGNATURE')) return new Response('paid');
    return new Response(null, { status: 402, headers: {
      'PAYMENT-REQUIRED': encode({ x402Version: 2, accepts: [accept] }),
      ...(accessPass ? {
        'X-ACCESS-PASS-TIERS': encode({ tiers: [{ id: '1h', price: '0.05' }] }),
      } : {}),
    } });
  });
  vi.stubGlobal('fetch', merchant);
  return { rpc, blockhash, merchant, mintData };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('budget metadata validation through the real Solana adapter', () => {
  it.each([
    { accessPass: false, decimals: 9, token2022: false },
    { accessPass: true, decimals: 9, token2022: false },
    { accessPass: false, decimals: 3, token2022: false },
    { accessPass: true, decimals: 3, token2022: true },
    { accessPass: false, decimals: 9, token2022: true },
    { accessPass: true, decimals: '9', token2022: false },
  ])('rejects false metadata before approval or signing: %j', async ({ accessPass, decimals, token2022 }) => {
    const accept = offer(decimals);
    const f = fixture(accept, accessPass, 6, token2022);
    const approval = vi.fn(() => true);
    const builder = vi.spyOn(SolanaAdapter.prototype, 'buildTransaction').mockResolvedValue({ serialized: 'fixture' });
    const agent = createBudgetAccount({
      walletPrivateKey: buyer.secretKey,
      budget: { total: '0.10', perRequest: '0.10', perHour: '0.10' },
      onPaymentRequired: approval, rpcUrls: { [SOLANA_MAINNET]: rpcUrl },
      ...(accessPass ? { accessPass: { preferTier: '1h' } } : {}),
    });
    await expect(agent.fetch(url)).rejects.toMatchObject({
      code: typeof decimals === 'number' ? 'invalid_payment_required' : 'missing_decimals',
    });
    expect(approval).not.toHaveBeenCalled();
    expect(builder).not.toHaveBeenCalled();
    expect(agent.reservedAmount).toBe(0);
    expect(agent.spentAmount).toBe(0);
    expect(agent.ledger).toHaveLength(0);
    expect(f.merchant).toHaveBeenCalledOnce();

    // A rejected offer must not poison a later valid reservation or record.
    accept.extra!.decimals = 6;
    accept.amount = '50000';
    await expect(agent.fetch(url)).resolves.toHaveProperty('status', 200);
    expect(approval).toHaveBeenCalledOnce();
    expect(builder).toHaveBeenCalledOnce();
    expect(agent.reservedAmount).toBe(0);
    expect(agent.spentAmount).toBe(0.05);
    expect(agent.ledger).toEqual([expect.objectContaining({ amount: 0.05, network: SOLANA_MAINNET })]);
  });

  it.each([false, true])('does not skip failed mint lookup as a balance error (pass=%s)', async accessPass => {
    const f = fixture(offer(9), accessPass);
    f.rpc.mockRejectedValue(new Error('fixture metadata unavailable'));
    const approval = vi.fn(() => true);
    const builder = vi.spyOn(SolanaAdapter.prototype, 'buildTransaction');
    const agent = createBudgetAccount({ walletPrivateKey: buyer.secretKey,
      budget: { total: '0.10' }, onPaymentRequired: approval,
      rpcUrls: { [SOLANA_MAINNET]: rpcUrl },
      ...(accessPass ? { accessPass: { preferTier: '1h' } } : {}),
    });
    await expect(agent.fetch(url)).rejects.toThrow('fixture metadata unavailable');
    expect(approval).not.toHaveBeenCalled();
    expect(builder).not.toHaveBeenCalled();
    expect(agent.reservedAmount).toBe(0);
    expect(agent.payments).toBe(0);
    expect(f.merchant).toHaveBeenCalledOnce();
  });

  it.each([false, true])('checks the known-USDC fallback when decimals are absent (mismatch=%s)', async mismatch => {
    const accept = offer();
    delete accept.extra!.decimals;
    fixture(accept, false, mismatch ? 9 : 6);
    const approval = vi.fn(() => false);
    const client = createX402Client({ wallets: { solana: { publicKey: buyer.publicKey, signTransaction: vi.fn() } },
      rpcUrls: { [SOLANA_MAINNET]: rpcUrl }, onPaymentRequired: approval,
    });
    await expect(client.fetch(url)).rejects.toMatchObject({
      code: mismatch ? 'invalid_payment_required' : 'payment_rejected',
    });
    expect(approval).toHaveBeenCalledTimes(mismatch ? 0 : 1);
  });

  it('validates the v1 amount fallback before approval', async () => {
    const { amount, ...legacy } = offer(9);
    // The runtime accepts v1 offers without the v2-required amount field.
    const accept = { ...legacy, maxAmountRequired: amount } as PaymentAccept;
    fixture(accept);
    const approval = vi.fn(() => true);
    const agent = createBudgetAccount({ walletPrivateKey: buyer.secretKey,
      budget: { total: '0.10' }, onPaymentRequired: approval,
    });
    await expect(agent.fetch(url)).rejects.toMatchObject({ code: 'invalid_payment_required' });
    expect(approval).not.toHaveBeenCalled();
    expect(agent.payments).toBe(0);
  });

  it.each(['total', 'perRequest', 'perHour'] as const)('still rejects an accurately scaled payment above %s', async limit => {
    fixture(offer(6));
    const approval = vi.fn(() => true);
    const builder = vi.spyOn(SolanaAdapter.prototype, 'buildTransaction');
    const agent = createBudgetAccount({ walletPrivateKey: buyer.secretKey,
      budget: { total: '10', [limit]: '0.10' }, onPaymentRequired: approval,
      rpcUrls: { [SOLANA_MAINNET]: rpcUrl },
    });
    await expect(agent.fetch(url)).rejects.toMatchObject({ code: 'amount_exceeds_max' });
    expect(approval).not.toHaveBeenCalled();
    expect(builder).not.toHaveBeenCalled();
    expect(agent.reservedAmount).toBe(0);
    expect(agent.payments).toBe(0);
  });

  it.each(['missing', 'malformed', 'wrong-owner'] as const)('fails closed on %s mint metadata', async problem => {
    const accept = offer(6);
    const f = fixture(accept);
    if (problem === 'missing') f.rpc.mockResolvedValue(null);
    if (problem === 'malformed') f.rpc.mockResolvedValue({
      data: Buffer.alloc(2), owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1,
    });
    if (problem === 'wrong-owner') f.rpc.mockResolvedValue({
      data: f.mintData, owner: recipient, executable: false, lamports: 1,
    });
    const approval = vi.fn(() => true);
    const builder = vi.spyOn(SolanaAdapter.prototype, 'buildTransaction');
    const agent = createBudgetAccount({ walletPrivateKey: buyer.secretKey,
      budget: { total: '10' }, onPaymentRequired: approval,
    });
    await expect(agent.fetch(url)).rejects.toThrow();
    expect(approval).not.toHaveBeenCalled();
    expect(builder).not.toHaveBeenCalled();
    expect(agent.reservedAmount).toBe(0);
    expect(agent.payments).toBe(0);
  });
});

describe('direct Solana adapter metadata contract', () => {
  it.each([9, 3, -1, 1.5, '6'])('rejects declared decimals %s before the wallet is called', async decimals => {
    const accept = offer(decimals);
    const f = fixture(accept);
    const signTransaction = vi.fn();
    await expect(new SolanaAdapter().buildTransaction(accept, {
      publicKey: buyer.publicKey, signTransaction,
    }, rpcUrl)).rejects.toMatchObject({ code: 'invalid_payment_required' });
    expect(signTransaction).not.toHaveBeenCalled();
    expect(f.blockhash).not.toHaveBeenCalled();
    expect(f.merchant).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves matching mint units (Token-2022=%s)', async token2022 => {
    const accept = offer(6);
    fixture(accept, false, 6, token2022);
    const signTransaction = vi.fn(async (tx: VersionedTransaction) => {
      const transfer = tx.message.compiledInstructions[2];
      expect(Buffer.from(transfer.data).readBigUInt64LE(1)).toBe(1_000_000n);
      expect(transfer.data[9]).toBe(6);
      return tx;
    });
    await new SolanaAdapter().buildTransaction(accept, { publicKey: buyer.publicKey, signTransaction }, rpcUrl);
    expect(signTransaction).toHaveBeenCalledOnce();
  });

  it('uses actual mint decimals for a direct balance lookup without declared metadata', async () => {
    const accept = offer(9, otherMint);
    delete accept.extra!.decimals;
    fixture(accept, false, 9);
    const adapter = new SolanaAdapter();
    await expect(adapter.getBalance(accept, { publicKey: buyer.publicKey, signTransaction: vi.fn() }, rpcUrl))
      .resolves.toBe(0.01);
  });

  it('rechecks metadata changed by an approval callback before calling the wallet', async () => {
    fixture(offer(6));
    const signTransaction = vi.fn();
    const client = createX402Client({
      wallets: { solana: { publicKey: buyer.publicKey, signTransaction } },
      rpcUrls: { [SOLANA_MAINNET]: rpcUrl },
      onPaymentRequired: accept => { accept.extra!.decimals = 9; return true; },
    });
    await expect(client.fetch(url)).rejects.toMatchObject({ code: 'invalid_payment_required' });
    expect(signTransaction).not.toHaveBeenCalled();
  });
});
