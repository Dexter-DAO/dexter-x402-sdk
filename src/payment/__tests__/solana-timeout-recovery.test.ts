import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ComputeBudgetInstruction, Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { SolanaAdapter } from '../../adapters/solana';
import type { SettlementProbe, SignedTransaction } from '../../adapters/types';
import type { PaymentAccept } from '../../types';
import { payAndFetch } from '../dispatcher';
import { confirmSettlement } from '../confirm-settlement';

// Real messages, signatures and RPC decoding, with only unfunded local accounts.
const buyer = Keypair.fromSeed(new Uint8Array(32).fill(1));
const sponsor = Keypair.fromSeed(new Uint8Array(32).fill(2));
const seller = Keypair.fromSeed(new Uint8Array(32).fill(3));
const mint = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey;
const blockhash = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58();
const otherBuyer = Keypair.fromSeed(new Uint8Array(32).fill(6));
const sourceAta = getAssociatedTokenAddressSync(mint, buyer.publicKey);
const destinationAta = getAssociatedTokenAddressSync(mint, seller.publicKey);
const network = { caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', bare: 'solana', family: 'svm' as const };
const accept: PaymentAccept = {
  scheme: 'exact', network: network.caip2, amount: '10000',
  asset: mint.toBase58(), payTo: seller.publicKey.toBase58(), maxTimeoutSeconds: 60,
  extra: { feePayer: sponsor.publicKey.toBase58(), decimals: 6 },
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const adapter = new SolanaAdapter();
const wallet = { publicKey: buyer.publicKey, signTransaction: vi.fn(async <T>(tx: T): Promise<T> => {
  (tx as VersionedTransaction).sign([buyer]); return tx;
}) };

type SolanaProbe = Extract<SettlementProbe, { kind: 'solana' }>;
type Candidate = ReturnType<typeof candidate>;
let candidates: Candidate[] = [];
let rpcMethods: string[] = [];
let rpcUrl: string;
let simulationValue: Record<string, unknown>;
let simulationError: string | undefined;
let simulations: { transaction: VersionedTransaction; config: Record<string, unknown> }[];

function candidate(built: SignedTransaction, options: { sender?: Keypair; blockhash?: string; memo?: string } = {}) {
  const unsigned = VersionedTransaction.deserialize(Buffer.from(built.serialized, 'base64'));
  const message = TransactionMessage.decompile(unsigned.message);
  const sender = options.sender ?? buyer;
  if (options.sender) {
    message.instructions[2].keys[0].pubkey = getAssociatedTokenAddressSync(mint, sender.publicKey);
    message.instructions[2].keys[3].pubkey = sender.publicKey;
  }
  if (options.blockhash) message.recentBlockhash = options.blockhash;
  if (options.memo !== undefined) message.instructions[3].data = Buffer.from(options.memo);
  const tx = new VersionedTransaction(message.compileToV0Message());
  tx.sign([sender, sponsor]);
  const destinationIndex = tx.message.staticAccountKeys.findIndex(k => k.equals(destinationAta));
  const tokenBalance = (amount: string) => ({
    accountIndex: destinationIndex, mint: mint.toBase58(),
    uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) },
  });
  return {
    signature: bs58.encode(tx.signatures[0]), err: null as unknown,
    transaction: {
      signatures: tx.signatures.map(s => bs58.encode(s)),
      message: {
        header: tx.message.header,
        accountKeys: tx.message.staticAccountKeys.map(k => k.toBase58()),
        recentBlockhash: tx.message.recentBlockhash,
        instructions: tx.message.compiledInstructions.map(ix => ({
          programIdIndex: ix.programIdIndex, accounts: ix.accountKeyIndexes, data: bs58.encode(ix.data),
        })),
        addressTableLookups: [],
      },
    },
    meta: {
      err: null as unknown, fee: 5000, preBalances: tx.message.staticAccountKeys.map(() => 1000000),
      postBalances: tx.message.staticAccountKeys.map(() => 1000000),
      preTokenBalances: [tokenBalance('100000')], postTokenBalances: [tokenBalance('110000')],
      loadedAddresses: { writable: [], readonly: [] },
    },
  };
}

function accountInfo(address: string) {
  const isMint = address === mint.toBase58();
  const data = Buffer.alloc(isMint ? 82 : 165);
  if (isMint) { data[44] = 6; data[45] = 1; }
  else {
    mint.toBuffer().copy(data); buyer.publicKey.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(1000000n, 64); data[108] = 1;
  }
  return { data: [data.toString('base64'), 'base64'], owner: TOKEN_PROGRAM_ID.toBase58(), executable: false, lamports: 10000000, rentEpoch: 0 };
}

const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const { id, method, params } = JSON.parse(body);
  rpcMethods.push(method);
  if (method === 'simulateTransaction') {
    simulations.push({ transaction: VersionedTransaction.deserialize(Buffer.from(params[0], 'base64')), config: params[1] });
    if (simulationError) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: simulationError } }));
      return;
    }
  }
  const result = (() => {
    if (method === 'getAccountInfo') return { context: { slot: 10 }, value: accountInfo(params[0]) };
    if (method === 'getLatestBlockhash') return { context: { slot: 10 }, value: { blockhash, lastValidBlockHeight: 100 } };
    if (method === 'simulateTransaction') return { context: { slot: 10 }, value: simulationValue };
    if (method === 'getSignaturesForAddress') return candidates.map(c => ({ signature: c.signature, err: c.err, slot: 10, memo: null, blockTime: null, confirmationStatus: 'confirmed' }));
    if (method === 'getTransaction') {
      const found = candidates.find(c => c.signature === params[0]);
      return found ? { slot: 10, blockTime: null, version: 0, transaction: found.transaction, meta: found.meta } : null;
    }
    throw new Error(`Unexpected local RPC method: ${method}`);
  })();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
});

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); });
beforeEach(() => {
  candidates = []; rpcMethods = []; wallet.signTransaction.mockClear();
  simulations = []; simulationError = undefined;
  simulationValue = { err: null, logs: [], unitsConsumed: 20000 };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const build = (extra = accept.extra) => adapter.buildTransaction({ ...accept, extra }, wallet, rpcUrl);

describe('Solana exact payment identity', () => {
  it('captures the message signed by the wallet and permits the sponsor to add its signature', async () => {
    const built = await build();
    const signed = VersionedTransaction.deserialize(Buffer.from(built.serialized, 'base64'));
    expect(built.settlementProbe).toMatchObject({
      sourceAta: sourceAta.toBase58(), destinationAta: destinationAta.toBase58(), blockhash,
      signedMessage: Buffer.from(signed.message.serialize()).toString('base64'),
      recoveryNonce: Buffer.from(signed.message.compiledInstructions[3].data).toString(),
    });
    candidates = [candidate(built)];
    expect(candidates[0].transaction.signatures[0]).not.toBe(bs58.encode(signed.signatures[0]));
    expect(await adapter.confirmSettlement(built.settlementProbe!, rpcUrl)).toEqual({ settled: true, txSignature: candidates[0].signature });
    expect(rpcMethods).toContain('getTransaction');
  });

  it('gives consecutive identical purchases distinct messages on the same blockhash', async () => {
    const first = await build();
    const second = await build();
    const a = VersionedTransaction.deserialize(Buffer.from(first.serialized, 'base64'));
    const b = VersionedTransaction.deserialize(Buffer.from(second.serialized, 'base64'));
    expect(a.message.recentBlockhash).toBe(b.message.recentBlockhash);
    expect(a.message.compiledInstructions[3].data).not.toEqual(b.message.compiledInstructions[3].data);
    expect(Buffer.from(b.message.compiledInstructions[3].data).toString()).toMatch(/^[a-f0-9]{32}$/);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(TransactionMessage.decompile(b.message).instructions[0]).units).toBe(25000);
    expect(simulations).toEqual([]);
    candidates = [candidate(first)];
    expect(await adapter.confirmSettlement(second.settlementProbe!, rpcUrl)).toEqual({ settled: false });
  });

  it.each(['invoice-123', '가'.repeat(85) + 'a', '😀'.repeat(64), '\0'.repeat(256), '', 'a'.repeat(256)])('preserves the seller Memo exactly: %j', async memo => {
    const built = await build({ ...accept.extra, memo });
    const tx = VersionedTransaction.deserialize(Buffer.from(built.serialized, 'base64'));
    const message = TransactionMessage.decompile(tx.message);
    expect(message.instructions).toHaveLength(4);
    expect(message.instructions[3].programId.toBase58()).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    expect(message.instructions[3].data).toEqual(Buffer.from(memo, 'utf8'));
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(message.instructions[0]).units).toBe(22000);
    expect(built.settlementProbe).not.toHaveProperty('recoveryNonce');
    expect(simulations).toHaveLength(1);
    expect(simulations[0].config).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64' });
    expect(simulations[0].transaction.signatures.every(s => s.every(b => b === 0))).toBe(true);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(TransactionMessage.decompile(simulations[0].transaction.message).instructions[0]).units).toBe(1400000);
    expect(built.settlementProbe?.kind === 'solana' && built.settlementProbe.signedMessage).not.toBe(Buffer.from(simulations[0].transaction.message.serialize()).toString('base64'));
  });

  it.each([undefined, null, 0, -1, 1.5, 1400001, '20000'])('rejects invalid simulation compute units before signing: %j', async unitsConsumed => {
    simulationValue = { err: null, logs: [], unitsConsumed };
    await expect(build({ ...accept.extra, memo: 'invoice-123' })).rejects.toThrow();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(simulations).toHaveLength(1);
  });

  it.each([1399999, 1400000])('caps simulation headroom at the runtime maximum: %i', async unitsConsumed => {
    simulationValue = { err: null, logs: [], unitsConsumed };
    const built = await build({ ...accept.extra, memo: 'invoice-123' });
    const tx = VersionedTransaction.deserialize(Buffer.from(built.serialized, 'base64'));
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(TransactionMessage.decompile(tx.message).instructions[0]).units).toBe(1400000);
  });

  it('rejects failed simulation execution before signing', async () => {
    simulationValue = { err: { InstructionError: [2, 'Custom'] }, logs: [], unitsConsumed: 20000 };
    await expect(build({ ...accept.extra, memo: 'invoice-123' })).rejects.toThrow(/simulation failed/);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('rejects a simulation RPC error before signing', async () => {
    simulationError = 'local simulation unavailable';
    await expect(build({ ...accept.extra, memo: 'invoice-123' })).rejects.toThrow(/simulate transaction.*local simulation unavailable/);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it.each(['a'.repeat(257), '가'.repeat(86), null, 123])('rejects invalid seller Memo before signing or RPC: %j', async memo => {
    await expect(build({ ...accept.extra, memo })).rejects.toThrow(/memo.*256 bytes/i);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(rpcMethods).toEqual([]);
  });

  it.each([
    ['another message on the same blockhash', { memo: 'another purchase' }],
    ['another payer', { sender: otherBuyer }],
    ['an earlier blockhash', { blockhash: Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58() }],
  ] as const)('rejects a same-amount deposit from %s', async (_label, options) => {
    const built = await build();
    candidates = [candidate(built, options)];
    expect(await adapter.confirmSettlement(built.settlementProbe!, rpcUrl)).toEqual({ settled: false });
  });

  it.each([undefined, ''])('leaves an older/incomplete probe unconfirmed: %j', async signedMessage => {
    const built = await build();
    candidates = [candidate(built)];
    rpcMethods = [];
    const probe = { ...built.settlementProbe, signedMessage } as SolanaProbe;
    expect(await confirmSettlement(probe, network, rpcUrl)).toMatchObject({ confirmed: false, detail: expect.stringContaining('missing the signed message') });
    expect(rpcMethods).toEqual([]);
  });

  it.each(['sourceAta', 'destinationAta', 'asset', 'amount', 'blockhash'] as const)('leaves a probe missing %s unconfirmed', async field => {
    const built = await build();
    candidates = [candidate(built)];
    rpcMethods = [];
    const probe = { ...built.settlementProbe, [field]: undefined } as SolanaProbe;
    expect(await confirmSettlement(probe, network, rpcUrl)).toMatchObject({ confirmed: false });
    expect(rpcMethods).toEqual([]);
  });

  it.each([undefined, '', 'static-reference', 'a'.repeat(31)])('does not recover an older probe without a fresh nonce: %j', async recoveryNonce => {
    const built = await build();
    candidates = [candidate(built)];
    rpcMethods = [];
    expect(await confirmSettlement({ ...built.settlementProbe, recoveryNonce } as SolanaProbe, network, rpcUrl)).toMatchObject({ confirmed: false });
    expect(rpcMethods).toEqual([]);
  });

  it.each(['removed', 'replaced', 'wrong-program'])('does not recover after the wallet %s the nonce Memo', async change => {
    wallet.signTransaction.mockImplementationOnce(async <T>(tx: T): Promise<T> => {
      const message = TransactionMessage.decompile((tx as VersionedTransaction).message);
      if (change === 'removed') message.instructions.splice(3, 1);
      else if (change === 'replaced') message.instructions[3].data = Buffer.from('another-wallet-reference');
      else message.instructions[3].programId = otherBuyer.publicKey;
      const altered = new VersionedTransaction(message.compileToV0Message());
      altered.sign([buyer]); return altered as T;
    });
    const built = await build();
    candidates = [candidate(built)];
    expect(built.settlementProbe).toHaveProperty('recoveryNonce', expect.stringMatching(/^[a-f0-9]{32}$/));
    expect(await adapter.confirmSettlement(built.settlementProbe!, rpcUrl)).toEqual({ settled: false });
  });

  it.each([
    ['failed signature record', (c: Candidate) => { c.err = { InstructionError: [2, 'Custom'] }; }],
    ['failed transaction metadata', (c: Candidate) => { c.meta.err = { InstructionError: [2, 'Custom'] }; }],
    ['wrong amount', (c: Candidate) => { c.meta.postTokenBalances[0].uiTokenAmount.amount = '110001'; }],
    ['wrong account', (c: Candidate) => { c.meta.postTokenBalances[0].accountIndex = 0; }],
    ['wrong mint', (c: Candidate) => { c.meta.postTokenBalances[0].mint = otherBuyer.publicKey.toBase58(); }],
    ['conflicting pre-balance mint', (c: Candidate) => { c.meta.preTokenBalances[0].mint = otherBuyer.publicKey.toBase58(); }],
  ] as const)('rejects %s even when the RPC message matches', async (_label, mutate) => {
    const built = await build();
    candidates = [candidate(built)];
    mutate(candidates[0]);
    expect(await adapter.confirmSettlement(built.settlementProbe!, rpcUrl)).toEqual({ settled: false });
  });

  it('continues past unrelated deposits to find the exact successful purchase', async () => {
    const built = await build();
    candidates = [candidate(built, { sender: otherBuyer }), candidate(built)];
    expect(await adapter.confirmSettlement(built.settlementProbe!, rpcUrl)).toEqual({ settled: true, txSignature: candidates[1].signature });
  });
});

describe.each([1, 2])('public v%s Solana timeout recovery', version => {
  it.each(['current', 'different-message', 'different-payer', 'past-blockhash', 'failed'] as const)('reports the %s transaction without dispatching another payment', async scenario => {
    const merchantUrl = 'https://merchant.example/solana-tool';
    const realFetch = globalThis.fetch;
    let paidRequests = 0;
    vi.spyOn(SolanaAdapter.prototype, 'getDefaultRpcUrl').mockReturnValue(rpcUrl);
    const challenge = () => version === 2
      ? new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encode({ x402Version: 2, resource: { url: merchantUrl }, accepts: [accept] }) } })
      : Response.json({ x402Version: 1, accepts: [{ ...accept, network: 'solana', maxAmountRequired: accept.amount }] }, { status: 402 });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (requestUrl !== merchantUrl) {
        if (!requestUrl.startsWith(rpcUrl)) throw new Error(`External request refused: ${requestUrl}`);
        return realFetch(input, init);
      }
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const header = headers.get(version === 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT');
      if (!header) return challenge();
      paidRequests++;
      const payment = JSON.parse(Buffer.from(header, 'base64').toString());
      const built = { serialized: payment.payload.transaction };
      const options = scenario === 'different-message' ? { memo: 'previous purchase' }
        : scenario === 'different-payer' ? { sender: otherBuyer }
        : scenario === 'past-blockhash' ? { blockhash: otherBuyer.publicKey.toBase58() } : {};
      candidates = [candidate(built, options)];
      if (scenario === 'failed') candidates[0].meta.err = { InstructionError: [2, 'Custom'] };
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }));
    const result = await payAndFetch(merchantUrl, {}, { solana: wallet }, { timeoutMs: 5000, responseTimeoutMs: 20, solanaRpcUrl: rpcUrl });
    if (scenario === 'current') {
      expect(result).toMatchObject({ ok: true, paid: true, txSignature: candidates[0].signature, response: undefined, amountPaid: '10000' });
    } else {
      expect(result).toMatchObject({ ok: false, reason: 'payment_unconfirmed' });
      expect(result).not.toHaveProperty('paid');
    }
    expect(wallet.signTransaction).toHaveBeenCalledOnce();
    expect(paidRequests).toBe(1);
    expect(rpcMethods).toContain('getTransaction');
  });

  it.each(['timeout', 'receipt'] as const)('keeps duplicate seller Memo purchases independent after %s', async outcome => {
    const merchantUrl = 'https://merchant.example/repeated-reference';
    const realFetch = globalThis.fetch;
    const sellerAccept = { ...accept, extra: { ...accept.extra, memo: 'reused-invoice-reference' } };
    const dispatched: string[] = [];
    vi.spyOn(SolanaAdapter.prototype, 'getDefaultRpcUrl').mockReturnValue(rpcUrl);
    const challenge = () => version === 2
      ? new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encode({ x402Version: 2, resource: { url: merchantUrl }, accepts: [sellerAccept] }) } })
      : Response.json({ x402Version: 1, accepts: [{ ...sellerAccept, network: 'solana', maxAmountRequired: accept.amount }] }, { status: 402 });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (requestUrl !== merchantUrl) {
        if (!requestUrl.startsWith(rpcUrl)) throw new Error(`External request refused: ${requestUrl}`);
        return realFetch(input, init);
      }
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const header = headers.get(version === 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT');
      if (!header) return challenge();
      const payment = JSON.parse(Buffer.from(header, 'base64').toString());
      dispatched.push(payment.payload.transaction);
      if (candidates.length === 0) candidates = [candidate({ serialized: dispatched[0] })];
      if (outcome === 'receipt') return new Response('merchant result', { status: 200, headers: {
        [version === 2 ? 'PAYMENT-RESPONSE' : 'X-PAYMENT-RESPONSE']: encode({ success: true, transaction: candidates[0].signature, network: accept.network }),
      } });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }));
    const results = [];
    for (let i = 0; i < 2; i++) results.push(await payAndFetch(merchantUrl, {}, { solana: wallet }, { timeoutMs: 5000, responseTimeoutMs: 20, solanaRpcUrl: rpcUrl }));
    for (const result of results) {
      expect(result).toMatchObject(outcome === 'receipt'
        ? { ok: true, paid: true, txSignature: candidates[0].signature }
        : { ok: false, reason: 'payment_unconfirmed' });
    }
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]).toBe(dispatched[1]);
    expect(wallet.signTransaction).toHaveBeenCalledTimes(2);
    expect(simulations).toHaveLength(2);
    expect(rpcMethods).not.toContain('getSignaturesForAddress');
  });
});
