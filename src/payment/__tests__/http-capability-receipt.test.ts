import { afterEach, describe, expect, it, vi } from 'vitest';
import { payAndFetch } from '../dispatcher';
import { createX402Client, getPaymentReceipt } from '../../client/x402-client';
import { EvmAdapter } from '../../adapters/evm';
import { SolanaAdapter } from '../../adapters/solana';
import type { PaymentAccept } from '../../types';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

const url = 'https://merchant.example/tool';
const base: PaymentAccept = {
  scheme: 'exact', network: 'eip155:8453', amount: '10000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x1111111111111111111111111111111111111111',
  maxTimeoutSeconds: 60, extra: { decimals: 6 },
};
const settled = { success: true, transaction: 'fixture-tx', network: base.network };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

function fixture(accepts: PaymentAccept[], receipt: unknown = settled, status = 200, extensions?: Record<string, unknown>) {
  const signed = vi.fn(async (_input: unknown) => `0x${'11'.repeat(65)}` as const);
  const wallet = { address: '0x2222222222222222222222222222222222222222' as const, signTypedData: signed };
  const paid: Record<string, unknown>[] = [];
  let rpcCalls = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (requestUrl !== url) {
      rpcCalls++;
      // Fixture balance and Permit2 allowance. No provider request leaves this process.
      return Response.json({ jsonrpc: '2.0', id: 1, result: `0x${'f'.repeat(64)}` });
    }
    const payment = new Headers(init?.headers).get('PAYMENT-SIGNATURE');
    if (payment) {
      paid.push(JSON.parse(Buffer.from(payment, 'base64').toString()));
      return new Response('{"result":"saved response"}', {
        status, headers: receipt === 'missing' ? {} : {
          'PAYMENT-RESPONSE': receipt === 'malformed' ? 'not-json' : encode(receipt),
        },
      });
    }
    return new Response('{}', { status: 402, headers: {
      'PAYMENT-REQUIRED': encode({ x402Version: 2, resource: { url }, accepts, extensions }),
    } });
  });
  vi.stubGlobal('fetch', fetch);
  return { wallet, signed, paid, fetch, rpcCalls: () => rpcCalls };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const unsupported = [
  { paymentFlow: 'upfront' }, { paymentFlow: 'escrow' },
  { paymentFlow: 'future-flow' }, { paymentFlow: null },
  { assetTransferMethod: 'future-method' }, { assetTransferMethod: null },
  { assetTransferMethod: ['permit2'] },
];

describe('HTTP capability negotiation through the actual builders', () => {
  it('refuses a required payment identifier before both client entrypoints sign', async () => {
    const extensions = { 'payment-identifier': { info: { required: true } } };
    const f = fixture([base], settled, 200, extensions);
    expect(await payAndFetch(url, {}, { evm: f.wallet }, {})).toMatchObject({
      ok: false, reason: 'no_payment_options', detail: 'unsupported_required_payment_identifier',
    });
    await expect(createX402Client({ wallets: { evm: f.wallet } }).fetch(url)).rejects.toMatchObject({ code: 'unsupported_required_payment_identifier' });
    expect(f.signed).not.toHaveBeenCalled();
    expect(f.rpcCalls()).toBe(0);
    expect(f.paid).toHaveLength(0);
  });

  it.each([
    { 'payment-identifier': { info: { required: false } } },
    { 'other-extension': { info: { required: true } } },
  ])('preserves optional identifiers and unrelated extensions: %j', async extensions => {
    const f = fixture([base], settled, 200, extensions);
    expect(await payAndFetch(url, {}, { evm: f.wallet }, {})).toMatchObject({ ok: true, paid: true });
    expect(f.paid).toHaveLength(1);
  });

  it.each(unsupported)('refuses unsupported extras before any signing or RPC: %j', async extra => {
    const f = fixture([{ ...base, extra }]);
    expect(await payAndFetch(url, {}, { evm: f.wallet }, {})).toMatchObject({ ok: false, reason: 'no_payment_options' });
    expect(f.signed).not.toHaveBeenCalled();
    expect(f.paid).toHaveLength(0);
    expect(f.rpcCalls()).toBe(0);
  });

  it.each(unsupported)('also refuses unsupported extras in the direct client and adapter: %j', async extra => {
    const accept = { ...base, extra };
    const f = fixture([accept]);
    await expect(createX402Client({ wallets: { evm: f.wallet } }).fetch(url)).rejects.toThrow(/No supported payment option/);
    await expect(new EvmAdapter().buildTransaction(accept, f.wallet)).rejects.toThrow(/Unsupported payment/);
    expect(f.signed).not.toHaveBeenCalled();
    expect(f.paid).toHaveLength(0);
    expect(f.rpcCalls()).toBe(0);
  });

  it.each([
    {}, { paymentFlow: 'authorization' }, { assetTransferMethod: 'eip3009' },
    { paymentFlow: 'authorization', assetTransferMethod: 'permit2' },
  ])('preserves supported exact payment construction: %j', async extra => {
    const f = fixture([{ ...base, extra }]);
    expect(await payAndFetch(url, {}, { evm: f.wallet }, {})).toMatchObject({ ok: true, paid: true, txSignature: 'fixture-tx' });
    expect(f.signed).toHaveBeenCalledOnce();
    expect(f.signed.mock.calls[0]?.[0]).toMatchObject({
      primaryType: extra.assetTransferMethod === 'permit2' ? 'PermitWitnessTransferFrom' : 'TransferWithAuthorization',
    });
    expect(f.paid).toHaveLength(1);
  });

  it('skips an unsupported first option and pays the supported offer exactly once', async () => {
    const f = fixture([{ ...base, extra: { paymentFlow: 'escrow' } }, { ...base, amount: '5000' }]);
    expect(await payAndFetch(url, {}, { evm: f.wallet }, {})).toMatchObject({ ok: true, paid: true, amountPaid: '5000' });
    expect(f.paid).toHaveLength(1);
    expect(f.paid[0].accepted).toMatchObject({ amount: '5000' });
  });

  it.each(unsupported)('guards the Solana direct builder before wallet/RPC work: %j', async extra => {
    const f = fixture([]);
    await expect(new SolanaAdapter().buildTransaction({ ...base, network: 'solana', extra }, {})).rejects.toThrow(/Unsupported payment/);
    expect(f.rpcCalls()).toBe(0);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, 'default'])('preserves the Solana transfer builder for method %s', async assetTransferMethod => {
    const payer = Keypair.fromSeed(new Uint8Array(32).fill(1));
    const recipient = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
    const mint = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
    const data = Buffer.alloc(82);
    data[44] = 6; data[45] = 1;
    vi.spyOn(Connection.prototype, 'getAccountInfo').mockResolvedValue({
      data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1,
    });
    vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
      blockhash: Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58(), lastValidBlockHeight: 100,
    });
    const wallet = { publicKey: payer.publicKey, signTransaction: vi.fn(async (tx: VersionedTransaction) => {
      tx.sign([payer]); return tx;
    }) };
    const built = await new SolanaAdapter().buildTransaction({
      ...base, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      asset: mint.toBase58(), payTo: recipient.toBase58(),
      extra: { feePayer: recipient.toBase58(), decimals: 6, paymentFlow: 'authorization', assetTransferMethod },
    }, wallet, 'https://rpc.fixture.invalid');
    const tx = VersionedTransaction.deserialize(Buffer.from(built.serialized, 'base64'));
    expect(wallet.signTransaction).toHaveBeenCalledOnce();
    expect(tx.message.compiledInstructions).toHaveLength(3);
    expect(built.settlementProbe).toMatchObject({ kind: 'solana', amount: '10000', asset: mint.toBase58() });
  });
});

describe('HTTP settlement evidence after payment dispatch', () => {
  it('retains a settled receipt while reporting HTTP delivery failure', async () => {
    const f = fixture([base], settled, 500);
    const result = await payAndFetch(url, {}, { evm: f.wallet }, {});
    expect(result).toMatchObject({
      ok: false, reason: 'delivery_failed', txSignature: 'fixture-tx',
      paymentReceipt: { ...settled, settlementStatus: 'settled', amountAtomic: '10000' },
    });
    if (!result.ok) {
      expect(result.response?.status).toBe(500);
      expect(result.detail).toMatch(/same payment/);
    }
    expect(f.signed).toHaveBeenCalledOnce();
    expect(f.paid).toHaveLength(1);
  });

  it.each([
    { success: true, errorReason: 'settlement_pending' },
    { success: true, errorCode: 'settlement_pending' },
    { success: false, errorCode: 'settlement_pending' },
  ])('gives pending evidence precedence over contradictory success: %j', async fields => {
    const receipt = { ...settled, ...fields };
    const f = fixture([base], receipt);
    expect(await payAndFetch(url, {}, { evm: f.wallet }, {})).toMatchObject({
      ok: false, reason: 'payment_unconfirmed', txSignature: 'fixture-tx', paymentReceipt: receipt,
    });
    expect(f.paid).toHaveLength(1);
    expect(f.signed).toHaveBeenCalledOnce();
  });

  it.each([200, 202, 402, 503])('preserves a pending receipt on HTTP %i without another payment', async status => {
    const receipt = { success: false, errorReason: 'settlement_pending', transaction: 'pending-tx', network: base.network, extensions: { continuation: { id: 'original' } } };
    const f = fixture([base], receipt, status);
    const result = await payAndFetch(url, {}, { evm: f.wallet }, {});
    expect(result).toMatchObject({ ok: false, reason: 'payment_unconfirmed', txSignature: 'pending-tx', paymentReceipt: receipt });
    if (!result.ok) {
      expect(result.detail).toMatch(/same payment/i);
      expect(await result.response?.json()).toEqual({ result: 'saved response' });
      expect(getPaymentReceipt(result.response!)).toMatchObject({ ...receipt, attemptedAmountAtomic: '10000' });
      expect(getPaymentReceipt(result.response!)?.amountAtomic).toBeUndefined();
    }
    expect(f.signed).toHaveBeenCalledOnce();
    expect(f.paid).toHaveLength(1);
  });

  it.each([
    ['missing', 'missing'], ['malformed', 'malformed'], ['array', []],
    ['wrong network', { ...settled, network: 'eip155:1' }],
    ['missing network', { success: true, transaction: 'fixture-tx' }],
    ['missing transaction', { success: true, network: base.network }],
  ])('does not claim settlement from a %s receipt', async (_name, receipt) => {
    const f = fixture([base], receipt);
    const result = await payAndFetch(url, {}, { evm: f.wallet }, {});
    expect(result).toMatchObject({ ok: false, reason: 'payment_unconfirmed' });
    expect(f.signed).toHaveBeenCalledOnce();
    expect(f.paid).toHaveLength(1);
  });

  it('retains an explicit seller failure instead of reporting paid', async () => {
    const receipt = { success: false, errorReason: 'settlement_failed', transaction: 'attempt-tx', network: base.network };
    const f = fixture([base], receipt);
    const result = await payAndFetch(url, {}, { evm: f.wallet }, {});
    expect(result).toMatchObject({ ok: false, reason: 'settlement_failed', txSignature: 'attempt-tx', paymentReceipt: receipt });
    if (!result.ok) expect(result.detail).toMatch(/same payment/i);
    expect(f.signed).toHaveBeenCalledOnce();
    expect(f.paid).toHaveLength(1);
  });
});
