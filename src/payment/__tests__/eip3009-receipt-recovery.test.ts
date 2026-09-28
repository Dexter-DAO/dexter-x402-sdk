import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { capturePaymentReceipt } from '../../client/x402-client';
import type { SettlementProbe } from '../../adapters/types';
import type { PaymentAccept } from '../../types';
import { recoverIncompleteEip3009Receipt } from '../eip3009-receipt-recovery';
import { payAndFetch } from '../dispatcher';

const txHash = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'cd'.repeat(32)}`;
const nonce = `0x${'ef'.repeat(32)}`;
const buyer = `0x${'11'.repeat(20)}`;
const seller = `0x${'22'.repeat(20)}`;
const sponsor = `0x${'33'.repeat(20)}`;
const asset = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const accept: PaymentAccept = { scheme: 'exact', network: 'eip155:42161', asset, payTo: seller, amount: '20000', maxTimeoutSeconds: 60, extra: { decimals: 6 } };
const probe: SettlementProbe = { kind: 'eip3009', from: buyer, to: seller, amount: '20000', nonce, asset, chainId: 42161 };
const topic = (text: string) => `0x${bytesToHex(keccak_256(new TextEncoder().encode(text)))}`;
const addr = (text: string) => `0x${text.slice(2).padStart(64, '0')}`;
const data = (amount: string) => `0x${BigInt(amount).toString(16).padStart(64, '0')}`;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

function chainFixture(currentNonce = nonce) {
  const identity = { transactionHash: txHash, blockHash, blockNumber: '0x123', transactionIndex: '0x0' };
  const log = { ...identity, address: asset, removed: false };
  return {
    chainId: '0xa4b1',
    receipt: { ...identity, status: '0x1', logs: [
      { ...log, topics: [topic('AuthorizationUsed(address,bytes32)'), addr(buyer), currentNonce], data: '0x' },
      { ...log, topics: [topic('Transfer(address,address,uint256)'), addr(buyer), addr(seller)], data: data('20000') },
    ] },
    transaction: { ...identity, hash: txHash, chainId: '0xa4b1', from: sponsor },
    block: { hash: blockHash, number: '0x123', transactions: [txHash] },
  };
}
type Chain = ReturnType<typeof chainFixture>;

function rpcMock(chain: Chain) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    const results: Record<string, unknown> = {
      eth_chainId: chain.chainId, eth_getTransactionReceipt: chain.receipt,
      eth_getTransactionByHash: chain.transaction, eth_getBlockByNumber: chain.block,
    };
    if (!(request.method in results)) throw new Error(`Unexpected RPC method ${request.method}`);
    return Response.json({ jsonrpc: '2.0', id: request.id, result: results[request.method] });
  });
}

async function run(chain = chainFixture(), fields: Record<string, unknown> = { transaction: txHash }, options: { probe?: SettlementProbe; accept?: PaymentAccept; headers?: Record<string, string> } = {}) {
  const response = new Response('preserved report', { headers: options.headers ?? { 'PAYMENT-RESPONSE': JSON.stringify(fields) } });
  const receipt = capturePaymentReceipt(response, { network: accept.network, amountAtomic: '20000', assetDecimals: 6 });
  const fetch = rpcMock(chain);
  vi.stubGlobal('fetch', fetch);
  await recoverIncompleteEip3009Receipt(response, receipt, options.probe ?? probe, options.accept ?? accept);
  return { response, receipt, fetch };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('incomplete EIP3009 receipt recovery', () => {
  it('proves the current authorization and transfer while retaining the raw merchant fields and unread body', async () => {
    const { receipt, response, fetch } = await run();
    expect(receipt).toMatchObject({ transaction: txHash, settlementStatus: 'settled', amountAtomic: '20000', chainConfirmation: {
      source: 'eip3009_transaction', finality: 'included', network: accept.network, blockHash, blockNumber: '0x123', authorizationNonce: nonce,
    } });
    expect(receipt.success).toBeUndefined();
    expect(receipt.network).toBeUndefined();
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe('preserved report');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each(['PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'])('accepts bounded raw JSON or base64 in %s', async header => {
    for (const value of [JSON.stringify({ transaction: txHash }), encode({ transaction: txHash })]) {
      expect((await run(undefined, undefined, { headers: { [header]: value } })).receipt.settlementStatus).toBe('settled');
    }
  });

  it.each([
    ['wrong chain', (c: Chain) => { c.chainId = '0x2105'; }],
    ['reverted transaction', (c: Chain) => { c.receipt.status = '0x0'; }],
    ['different receipt tx', (c: Chain) => { c.receipt.transactionHash = blockHash; }],
    ['different fetched tx', (c: Chain) => { c.transaction.hash = blockHash; }],
    ['transaction chain mismatch', (c: Chain) => { c.transaction.chainId = '0x2105'; }],
    ['reorged transaction', (c: Chain) => { c.transaction.blockHash = nonce; }],
    ['reorged canonical block', (c: Chain) => { c.block.hash = nonce; }],
    ['missing canonical inclusion', (c: Chain) => { c.block.transactions = [nonce]; }],
    ['wrong transaction index', (c: Chain) => { c.transaction.transactionIndex = '0x1'; }],
    ['wrong block number', (c: Chain) => { c.block.number = '0x124'; }],
    ['different nonce', (c: Chain) => { c.receipt.logs[0].topics[2] = blockHash; }],
    ['cancellation only', (c: Chain) => { c.receipt.logs[0].topics[0] = topic('AuthorizationCanceled(address,bytes32)'); }],
    ['transfer only', (c: Chain) => { c.receipt.logs.shift(); }],
    ['authorization only', (c: Chain) => { c.receipt.logs.pop(); }],
    ['wrong recipient', (c: Chain) => { c.receipt.logs[1].topics[2] = addr(sponsor); }],
    ['wrong sender', (c: Chain) => { c.receipt.logs[1].topics[1] = addr(sponsor); }],
    ['wrong authorizer', (c: Chain) => { c.receipt.logs[0].topics[1] = addr(sponsor); }],
    ['wrong amount', (c: Chain) => { c.receipt.logs[1].data = data('20001'); }],
    ['wrong asset', (c: Chain) => { c.receipt.logs[1].address = seller; }],
    ['duplicate debit', (c: Chain) => { c.receipt.logs.push({ ...c.receipt.logs[1] }); }],
    ['extra debit', (c: Chain) => { c.receipt.logs.push({ ...c.receipt.logs[1], topics: [topic('Transfer(address,address,uint256)'), addr(buyer), addr(sponsor)], data: data('1') }); }],
    ['removed log', (c: Chain) => { c.receipt.logs[0].removed = true; }],
    ['inconsistent log block', (c: Chain) => { c.receipt.logs[1].blockHash = nonce; }],
    ['inconsistent log tx', (c: Chain) => { c.receipt.logs[1].transactionHash = nonce; }],
  ] as const)('keeps %s unconfirmed', async (_name, alter) => {
    const chain = chainFixture(); alter(chain);
    const { receipt } = await run(chain);
    expect(receipt).toMatchObject({ transaction: txHash, settlementStatus: 'unconfirmed' });
    expect(receipt.amountAtomic).toBeUndefined();
    expect(receipt.chainConfirmation).toBeUndefined();
  });

  it.each([
    { success: false }, { success: 'true' }, { network: 'eip155:8453' }, { network: null },
    { settlementStatus: 'pending' }, { errorReason: 'settlement_pending' }, { errorMessage: 'unknown' },
    { errorCode: [] }, { errorReason: 0 }, { payer: {} }, { amountAtomic: 20000 },
    { assetDecimals: '6' }, { assetDecimals: 18 }, { transaction: 'bad-hash' }, { payer: sponsor },
    { amountAtomic: '20001' }, { attemptedAmountAtomic: '30000' },
  ])('does not query RPC for conflicting or malformed merchant fields %j', async fields => {
    const { receipt, fetch } = await run(undefined, { transaction: txHash, ...fields });
    expect(receipt.settlementStatus).not.toBe('settled'); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { probe: { ...probe, nonce: '' } }, { probe: { ...probe, amount: undefined } },
    { probe: { ...probe, amount: '30000' } }, { probe: { ...probe, to: sponsor } },
    { probe: { ...probe, asset: sponsor } }, { accept: { ...accept, network: 'eip155:8453' } },
    { accept: { ...accept, extra: { assetTransferMethod: 'permit2' } } },
    { accept: { ...accept, scheme: 'exact-approval' as const } },
  ])('requires current signed EIP3009 terms %j', async options => {
    const { receipt, fetch } = await run(undefined, undefined, options);
    expect(receipt.settlementStatus).toBe('unconfirmed'); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([JSON.stringify({ transaction: nonce }), JSON.stringify({ transaction: txHash, success: false }), 'invalid', 'x'.repeat(16_385)])(
    'rejects a conflicting second receipt header', async second => {
      const { receipt, fetch } = await run(undefined, undefined, { headers: { 'PAYMENT-RESPONSE': JSON.stringify({ transaction: txHash }), 'X-PAYMENT-RESPONSE': second } });
      expect(receipt.settlementStatus).toBe('unconfirmed'); expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('bounds a stalled RPC and retains the original response and tx', async () => {
    vi.useFakeTimers();
    const response = new Response('preserved', { headers: { 'PAYMENT-RESPONSE': JSON.stringify({ transaction: txHash }) } });
    const receipt = capturePaymentReceipt(response, { network: accept.network, amountAtomic: '20000' });
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const pending = recoverIncompleteEip3009Receipt(response, receipt, probe, accept);
    await vi.advanceTimersByTimeAsync(5001); await pending;
    expect(receipt).toMatchObject({ transaction: txHash, settlementStatus: 'unconfirmed' });
    expect(response.bodyUsed).toBe(false);
  });

  it('bounds oversized RPC response bodies', async () => {
    const response = new Response('preserved', { headers: { 'PAYMENT-RESPONSE': JSON.stringify({ transaction: txHash }) } });
    const receipt = capturePaymentReceipt(response, { network: accept.network, amountAtomic: '20000' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(1_048_577))));
    await recoverIncompleteEip3009Receipt(response, receipt, probe, accept);
    expect(receipt.settlementStatus).toBe('unconfirmed');
  });
});

describe('actual payAndFetch incomplete receipt path', () => {
  it.each([200, 500])('uses one authorization and returns the original HTTP %i body', async status => {
    const url = 'https://merchant.example/report';
    const signed = vi.fn(async () => `0x${'44'.repeat(65)}`);
    let chain = chainFixture();
    let paidDispatches = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (input !== url) {
        const request = JSON.parse(String(init?.body));
        if (request.method === 'eth_call') return Response.json({ jsonrpc: '2.0', id: request.id, result: data('100000') });
        return rpcMock(chain)(input, init);
      }
      const authorization = new Headers(init?.headers).get('PAYMENT-SIGNATURE');
      if (!authorization) return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encode({ x402Version: 2, resource: { url }, accepts: [accept] }) } });
      paidDispatches++;
      const sent = JSON.parse(Buffer.from(authorization, 'base64').toString());
      chain = chainFixture(sent.payload.authorization.nonce);
      return new Response('paid report', { status, headers: {
        'PAYMENT-RESPONSE': JSON.stringify({ transaction: txHash }),
        'X-PAYMENT-RESPONSE': JSON.stringify({ transaction: txHash }),
      } });
    }));
    const result = await payAndFetch(url, {}, { evm: { address: buyer, signTypedData: signed } }, { maxAmountAtomic: '20000' });
    expect(signed).toHaveBeenCalledOnce(); expect(paidDispatches).toBe(1);
    expect(result).toMatchObject(status === 200
      ? { ok: true, paid: true, amountPaid: '20000', txSignature: txHash }
      : { ok: false, reason: 'delivery_failed', txSignature: txHash });
    if (!('paymentReceipt' in result)) throw new Error('Expected payment receipt');
    expect(result.paymentReceipt).toMatchObject({ settlementStatus: 'settled', chainConfirmation: { finality: 'included' } });
    expect(result.response?.bodyUsed).toBe(false);
    expect(await result.response?.text()).toBe('paid report');
  });
});
