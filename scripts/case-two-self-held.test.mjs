import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import { decodeSpendGrantRequest } from '@dexterai/vault/grant';
import { buildSettleVoucherInstruction } from '@dexterai/vault/instructions';
import { deriveSessionPda } from '@dexterai/vault/session';
import { deriveSwigVaultBindingPda } from '@dexterai/vault/credit';
import { DEXTER_VAULT_PROGRAM_ID, finalVoucherV2ReservationIdentity, finalVoucherV2ReservationMemo, voucherToHeader } from '@dexterai/x402/tab';
import { approvedGrant, assertLocalUnlessLive, deliverOnce, makeRequest, purchase, readKey, recoverSettlement, resend, resume, save, withGrantLock } from './case-two-self-held.mjs';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'case-two-cli-'));
  t.after(() => rmSync(path, { recursive: true }));
  return path;
}

function request(t) {
  const dir = directory(t);
  const options = { key: join(dir, 'agent.json'), grant: join(dir, 'grant.json'), merchant: Keypair.generate().publicKey.toBase58() };
  return { dir, options, result: makeRequest(options) };
}

function sessionConnection(vault, record, changes = {}) {
  const params = { maxAmount: 5000000n, maxRevolving: 1500000n, spent: 0n, outstanding: 0n, ...changes };
  const data = Buffer.alloc(162);
  Buffer.from([74, 34, 65, 133, 96, 163, 80, 69]).copy(data);
  data[8] = 1;
  vault.toBuffer().copy(data, 10);
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(record.keyPath, 'utf8')))).publicKey.toBuffer().copy(data, 42);
  data.writeBigUInt64LE(params.maxAmount, 74);
  data.writeBigInt64LE(BigInt(record.request.proposed.expiresAtUnix), 82);
  new Keypair().publicKey.toBuffer().copy(data, 90);
  data.writeUInt32LE(0x80000001, 122);
  data.writeBigUInt64LE(params.spent, 126);
  data.writeBigUInt64LE(params.outstanding, 134);
  data.writeBigUInt64LE(params.maxRevolving, 142);
  return { getAccountInfo: async () => ({ data, owner: DEXTER_VAULT_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 }) };
}

test('request creates a private local key and exposes only its public key in the consent blob', t => {
  const { options, result } = request(t);
  assert.equal(statSync(options.key).mode & 0o777, 0o600);
  const key = readKey(options.key);
  const url = new URL(result.consentUrl);
  const blob = decodeSpendGrantRequest(url.searchParams.get('req'));
  assert.equal(url.origin + url.pathname, 'https://dexter.cash/tabs/new');
  assert.equal(blob.sessionPubkey, key.publicKey.toBase58());
  assert.equal(blob.proposed.capAtomic, '5000000');
  assert.equal(blob.proposed.revolvingCapacityAtomic, '1500000');
  assert.equal(result.maxSingleAtomic, '1500000');
  assert.ok(blob.proposed.expiresAtUnix - Math.floor(Date.now() / 1000) <= 7 * 86400);
  assert.ok(!JSON.stringify(result).includes(JSON.stringify(Array.from(key.secretKey))));
  assert.throws(() => makeRequest(options), /EEXIST/);
  assert.equal(readKey(options.key).publicKey.toBase58(), key.publicKey.toBase58());
});

test('key files with broad permissions or symlinks are refused', t => {
  const { options, dir } = request(t);
  chmodSync(options.key, 0o644);
  assert.throws(() => readKey(options.key), /mode 600/);
  chmodSync(options.key, 0o600);
  const link = join(dir, 'linked-key.json');
  symlinkSync(options.key, link);
  assert.throws(() => readKey(link), /ELOOP/);
});

test('non-local endpoints cannot be used accidentally during the clone job', () => {
  for (const url of ['https://x402.dexter.cash', 'https://api.mainnet-beta.solana.com']) assert.throws(() => assertLocalUnlessLive(url, false), /require --live/);
  assert.throws(() => assertLocalUnlessLive('http://user:secret@localhost:27899', false), /Invalid endpoint/);
  assertLocalUnlessLive('http://127.0.0.1:27899', false);
});

test('exclusive grant ownership prevents concurrent operation and reads updated state after ownership ends', async t => {
  const { options } = request(t);
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const first = withGrantLock(options.grant, async record => {
    entered(); await hold; record.pendingReceipt = 'first-purchase'; save(options.grant, record);
  });
  await ready;
  await assert.rejects(withGrantLock(options.grant, async () => assert.fail('Second operation entered')), /Grant is locked/);
  const owner = JSON.parse(readFileSync(`${options.grant}.lock`, 'utf8'));
  assert.equal(owner.pid, process.pid);
  release(); await first;
  await withGrantLock(options.grant, async record => assert.equal(record.pendingReceipt, 'first-purchase'));
  assert.ok(!existsSync(`${options.grant}.lock`));
});

test('an unfinished purchase blocks a new purchase before any network request', async t => {
  const { options, result, dir } = request(t);
  save(options.grant, { ...result, pendingReceipt: 'unfinished' });
  const prior = globalThis.fetch;
  globalThis.fetch = () => assert.fail('No HTTP allowed');
  t.after(() => { globalThis.fetch = prior; });
  await assert.rejects(purchase({ ...options, rpc: 'http://127.0.0.1:27899', endpoint: 'http://127.0.0.1:27902', facilitator: 'http://127.0.0.1:27901', receipt: join(dir, 'next.json') }), /Unfinished purchase/);
  assert.ok(!existsSync(`${options.grant}.lock`));
});

test('resume shares the grant lock and cannot replay delivery while another owner operates', async t => {
  const { options } = request(t);
  await withGrantLock(options.grant, async () => {
    await assert.rejects(resume({ ...options, receipt: '/does-not-exist' }), /Grant is locked/);
  });
});

test('approval read rejects another key and a larger authority scope', async t => {
  const { result } = request(t);
  const vault = Keypair.generate().publicKey;
  const key = readKey(result.keyPath);
  await assert.rejects(approvedGrant(sessionConnection(vault, result), vault.toBase58(), result, Keypair.generate()), /agent key differs/);
  await assert.rejects(approvedGrant(sessionConnection(vault, result, { maxAmount: 5000001n }), vault.toBase58(), result, key), /scope exceeds/);
  const approved = await approvedGrant(sessionConnection(vault, result, { maxAmount: 4000000n, maxRevolving: 1000000n }), vault.toBase58(), result, key);
  assert.equal(approved.maxAmountAtomic, '4000000');
});

test('unknown merchant delivery is never retried when the existing obligation is already terminal', async t => {
  const { result, dir } = request(t);
  const vault = Keypair.generate().publicKey;
  const journal = { stage: 'delivering', vault: vault.toBase58(), merchant: result.request.counterparty,
    reservationInput: { sessionNonce: 0x80000001, voucher: { payload: { cumulativeAmount: '1000000' } } } };
  const prior = globalThis.fetch;
  globalThis.fetch = () => assert.fail('A merchant request or settlement must not be replayed');
  t.after(() => { globalThis.fetch = prior; });
  const settled = await recoverSettlement(sessionConnection(vault, result, { spent: 1000000n }), journal, join(dir, 'receipt.json'));
  assert.equal(settled.stage, 'settled');
  assert.equal(settled.deliveryOutcome, 'unknown');
  assert.equal(JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')).deliveryOutcome, 'unknown');
});


test('resume cancels an attempt that never signed without contacting any service', async t => {
  const { options, result, dir } = request(t);
  const receipt = join(dir, 'unsigned.json');
  save(options.grant, { ...result, pendingReceipt: receipt });
  save(receipt, { stage: 'created', endpoint: 'http://127.0.0.1:27902', facilitator: 'http://127.0.0.1:27901' });
  const prior = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Unsigned recovery must not contact a service');
  t.after(() => { globalThis.fetch = prior; });
  assert.equal((await resume({ grant: options.grant, receipt, rpc: 'http://127.0.0.1:27899' })).stage, 'cancelled-before-signing');
  assert.equal(JSON.parse(readFileSync(options.grant, 'utf8')).pendingReceipt, undefined);
});


test('resume reconciles a reservation settled during downtime without delivering or reserving again', async t => {
  const { options, result, dir } = request(t);
  const vault = Keypair.generate().publicKey;
  const receipt = join(dir, 'reserved.json');
  save(options.grant, { ...result, pendingReceipt: receipt });
  save(receipt, { stage: 'reserved', vault: vault.toBase58(), merchant: result.request.counterparty,
    endpoint: 'http://127.0.0.1:27902', facilitator: 'http://127.0.0.1:27901',
    reservationInput: { sessionNonce: 0x80000001, voucher: { payload: { cumulativeAmount: '1000000' } } } });
  const priorFetch = globalThis.fetch;
  const priorRead = Connection.prototype.getAccountInfo;
  globalThis.fetch = () => assert.fail('A terminal reservation must not be dispatched again');
  Connection.prototype.getAccountInfo = sessionConnection(vault, result, { spent: 1000000n }).getAccountInfo;
  t.after(() => { globalThis.fetch = priorFetch; Connection.prototype.getAccountInfo = priorRead; });
  const recovered = await resume({ grant: options.grant, receipt, rpc: 'http://127.0.0.1:27899' });
  assert.equal(recovered.stage, 'settled');
  assert.equal(recovered.deliveryOutcome, 'not-dispatched');
  assert.equal(JSON.parse(readFileSync(options.grant, 'utf8')).pendingReceipt, undefined);
});


test('resend sends the identical saved paid request once and never signs, reserves or settles', async t => {
  const { dir } = request(t);
  const receipt = join(dir, 'purchase.json');
  const voucher = { payload: { channelId: 'a'.repeat(64), cumulativeAmount: '1000000', sequenceNumber: 0x80000001 },
    sessionPublicKey: new Uint8Array(32).fill(1), sessionSignature: new Uint8Array(64).fill(2), sessionRegistration: new Uint8Array(188).fill(3) };
  const reservationReceipt = { reservationAmountAtomic: '1000000', transaction: 'clone-reservation' };
  const body = JSON.stringify({ orderId: '2bc78f09-789c-4de8-9a9a-8e3d25de72e3' });
  save(receipt, { stage: 'settled', endpoint: 'http://127.0.0.1:27902/books', requestBody: body,
    reservationInput: { voucher }, reservationReceipt });
  const sent = [];
  const prior = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init });
    return new Response('{"status":"accepted"}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = prior; });
  assert.equal((await resend({ receipt })).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'http://127.0.0.1:27902/books');
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.body, body);
  assert.equal(sent[0].init.headers['X-Tab-Voucher'], voucherToHeader({ ...voucher, reservationReceipt }));
  assert.equal(JSON.parse(readFileSync(`${receipt}.resend.json`, 'utf8')).status, 200);
  await assert.rejects(resend({ receipt }), /EEXIST/);
  assert.equal(sent.length, 1);
});

test('resend refuses a receipt that never sent a paid request', async t => {
  const { dir } = request(t);
  const receipt = join(dir, 'reserved.json');
  save(receipt, { stage: 'reserved', endpoint: 'http://127.0.0.1:27902/books', requestBody: '{}' });
  const prior = globalThis.fetch;
  globalThis.fetch = () => assert.fail('No HTTP allowed');
  t.after(() => { globalThis.fetch = prior; });
  await assert.rejects(resend({ receipt }), /use resume/);
  assert.ok(!existsSync(`${receipt}.resend.json`));
});


test('deliverOnce settles nothing: a non-2xx or a lost answer leaves the purchase for resend', async t => {
  const { dir } = request(t);
  const prior = globalThis.fetch;
  t.after(() => { globalThis.fetch = prior; });
  const journal = () => ({ stage: 'reserved', endpoint: 'http://127.0.0.1:27902/books', requestBody: '{"orderId":"o"}' });
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push(init); return new Response('{"error":"busy"}', { status: 503 }); };
  const refused = journal(), refusedReceipt = join(dir, 'refused.json');
  await assert.rejects(deliverOnce(refused, refusedReceipt, 'header'), /Merchant HTTP 503; delivery saved\. Not settled\. Run resend once/);
  assert.equal(sent.length, 1); assert.equal(sent[0].headers['X-Tab-Voucher'], 'header'); assert.equal(sent[0].body, '{"orderId":"o"}');
  assert.deepEqual([refused.stage, refused.deliveryStatus], ['delivered', 503]);
  assert.equal(JSON.parse(readFileSync(`${refusedReceipt}.delivery.json`, 'utf8')).status, 503);
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  const lost = journal(), lostReceipt = join(dir, 'lost.json');
  await assert.rejects(deliverOnce(lost, lostReceipt, 'header'), /outcome unknown \(fetch failed\)\. Not settled\. Run resend once/);
  assert.deepEqual([lost.stage, lost.deliveryOutcome], ['delivering', 'unknown']);
  assert.equal(JSON.parse(readFileSync(lostReceipt, 'utf8')).stage, 'delivering');
});

const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Local stand-in for the clone: RPC reads, the facilitator's /tab/open and /tab/settle, and a shelf whose paid
 * answers come from `shelf`. /tab/open lands a settle_voucher(increment) + Memo reservation, as the clone does. */
function standInClone(t, record, shelf) {
  const merchant = new PublicKey(record.request.counterparty), agent = new PublicKey(record.request.sessionPubkey);
  const vault = Keypair.generate().publicKey, swig = Keypair.generate().publicKey, authority = Keypair.generate().publicKey;
  const [sessionPda, sessionBump] = deriveSessionPda(vault, merchant, DEXTER_VAULT_PROGRAM_ID);
  const [bindingPda, bindingBump] = deriveSwigVaultBindingPda(swig, DEXTER_VAULT_PROGRAM_ID);
  const state = { spent: 0n, outstanding: 0n }, transactions = new Map(), calls = [];
  const accounts = () => {
    const binding = Buffer.alloc(74);
    Buffer.from([56, 67, 4, 209, 238, 143, 0, 129]).copy(binding); binding.writeUInt8(1, 8); binding.writeUInt8(bindingBump, 9);
    swig.toBuffer().copy(binding, 10); vault.toBuffer().copy(binding, 42);
    const vaultData = Buffer.alloc(181);
    Buffer.from([211, 8, 232, 43, 2, 152, 117, 119]).copy(vaultData); vaultData.writeUInt8(7, 8); vaultData.writeUInt8(255, 9);
    Buffer.alloc(33, 7).copy(vaultData, 10); swig.toBuffer().copy(vaultData, 43); vaultData.writeUInt32LE(1, 79);
    authority.toBuffer().copy(vaultData, 116); vaultData.writeUInt8(1, 148);
    const session = Buffer.alloc(162);
    Buffer.from([74, 34, 65, 133, 96, 163, 80, 69]).copy(session); session.writeUInt8(1, 8); session.writeUInt8(sessionBump, 9);
    vault.toBuffer().copy(session, 10); agent.toBuffer().copy(session, 42); session.writeBigUInt64LE(5_000_000n, 74);
    session.writeBigInt64LE(BigInt(record.request.proposed.expiresAtUnix), 82); merchant.toBuffer().copy(session, 90);
    session.writeUInt32LE(0x80000001, 122); session.writeBigUInt64LE(state.spent, 126); session.writeBigUInt64LE(state.outstanding, 134);
    session.writeBigUInt64LE(1_500_000n, 142);
    return new Map([[bindingPda.toBase58(), binding], [vault.toBase58(), vaultData], [sessionPda.toBase58(), session]]);
  };
  const info = data => data ? { data, owner: DEXTER_VAULT_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 } : null;
  const rpc = {
    getAccountInfo: async key => info(accounts().get(key.toBase58())),
    getMultipleAccountsInfoAndContext: async keys => ({ context: { slot: 101 }, value: keys.map(key => info(accounts().get(key.toBase58()))) }),
    getSignatureStatuses: async ([signature]) => ({ context: { slot: 101 }, value: [transactions.has(signature)
      ? { err: null, confirmationStatus: 'confirmed', slot: 100, confirmations: 1 } : null] }),
    getTransaction: async signature => transactions.get(signature) ?? null,
  };
  const land = body => {
    const voucher = { payload: { channelId: body.channel_id, cumulativeAmount: body.cumulative_amount_atomic, sequenceNumber: body.sequence_number },
      sessionPublicKey: Buffer.from(body.session_public_key, 'hex'), sessionSignature: Buffer.from(body.session_signature, 'hex'),
      sessionRegistration: Buffer.from(body.session_registration, 'hex') };
    const reservation = { network: 'solana:mainnet', programId: DEXTER_VAULT_PROGRAM_ID.toBase58(), buyerSwigAddress: body.buyer_swig_address,
      vaultPda: body.vault_pda, sessionPda: sessionPda.toBase58(), seller: body.seller, channelId: body.channel_id, sessionNonce: 0x80000001,
      reservationAmountAtomic: body.reservation_amount_atomic, previousCumulativeAtomic: state.spent.toString(),
      ...finalVoucherV2ReservationIdentity(voucher), voucher };
    const transaction = bs58.encode(randomBytes(64));
    const message = new TransactionMessage({ payerKey: authority, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [
      buildSettleVoucherInstruction({ vaultPda: vault, dexterAuthority: authority, allowedCounterparty: merchant, swigAddress: swig,
        vaultUsdcAta: null, siblingSessionPdas: [], amount: BigInt(body.reservation_amount_atomic), increment: true, programId: DEXTER_VAULT_PROGRAM_ID }),
      new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: authority, isSigner: true, isWritable: false }],
        data: Buffer.from(finalVoucherV2ReservationMemo(reservation), 'utf8') }),
    ] }).compileToV0Message();
    transactions.set(transaction, { slot: 100, blockTime: null, version: 0, transaction: { signatures: [transaction], message },
      meta: { err: null, fee: 5000, preBalances: [], postBalances: [], loadedAddresses: { writable: [], readonly: [] } } });
    state.outstanding += BigInt(body.reservation_amount_atomic);
    return { contract: 'dexter-native-tab-open-receipt/v1', operationId: randomBytes(32).toString('hex'), callerOperationId: body.operation_id,
      network: 'solana:mainnet', transaction, commitment: 'confirmed', confirmationSlot: 100, postStateSlot: 101,
      buyerSwigAddress: body.buyer_swig_address, vaultPda: body.vault_pda, sessionPda: sessionPda.toBase58(), seller: body.seller,
      channelId: body.channel_id, sessionPublicKey: body.session_public_key, voucherDigest: body.voucher_digest,
      cumulativeAmountAtomic: body.cumulative_amount_atomic, sequenceNumber: body.sequence_number, providerReceiptId: body.provider_receipt_id,
      reservationAmountAtomic: body.reservation_amount_atomic, pendingVoucherCountBefore: 0, pendingVoucherCountAfter: 1,
      currentOutstandingBeforeAtomic: '0', currentOutstandingAfterAtomic: body.reservation_amount_atomic };
  };
  const offer = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: 'http://127.0.0.1:27902/books' }, accepts: [{ scheme: 'tab',
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '1000000', asset: USDC, payTo: merchant.toBase58(), maxTimeoutSeconds: 1800 }] })).toString('base64');
  const priorRpc = Object.fromEntries(Object.keys(rpc).map(name => [name, Connection.prototype[name]]));
  const priorFetch = globalThis.fetch, priorToken = process.env.DEXTER_INTERNAL_TOKEN;
  Object.assign(Connection.prototype, rpc);
  process.env.DEXTER_INTERNAL_TOKEN = 'disposable-test-token';
  globalThis.fetch = async (url, init = {}) => {
    const { pathname } = new URL(url), header = init.headers?.['X-Tab-Voucher'];
    calls.push(header ? `${pathname} paid` : pathname);
    if (pathname === '/tab/open') return Response.json({ armed: true, receipt: land(JSON.parse(init.body)) });
    if (pathname === '/tab/settle') {
      state.spent = BigInt(JSON.parse(init.body).cumulativeAmount); state.outstanding = 0n;
      return Response.json({ settled: true });
    }
    if (!header) return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': offer } });
    return shelf(header);
  };
  t.after(() => {
    Object.assign(Connection.prototype, priorRpc); globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.DEXTER_INTERNAL_TOKEN; else process.env.DEXTER_INTERNAL_TOKEN = priorToken;
  });
  return { vault: vault.toBase58(), state, calls };
}

test('a failed delivery stops the purchase unsettled; resend delivers, then resume settles once', async t => {
  const { dir, options, result } = request(t);
  const answers = [new Response('{"error":"bookstore_order_unavailable"}', { status: 503 }), Response.json({ status: 'accepted' })];
  const headers = [];
  const fake = standInClone(t, result, header => { headers.push(header); return answers.shift(); });
  const body = join(dir, 'order.json'), receipt = join(dir, 'purchase-1.json');
  writeFileSync(body, '{"orderId":"2bc78f09-789c-4de8-9a9a-8e3d25de72e3"}');
  const buy = { grant: options.grant, vault: fake.vault, rpc: 'http://127.0.0.1:27899', endpoint: 'http://127.0.0.1:27902/books',
    facilitator: 'http://127.0.0.1:27901', body, receipt, reason: 'test order' };
  await assert.rejects(purchase(buy), /Merchant HTTP 503; delivery saved\. Not settled\. Run resend once for .*purchase-1\.json, then resume/);
  assert.deepEqual(fake.calls, ['/books', '/tab/open', '/books paid']);
  assert.deepEqual([fake.state.spent, fake.state.outstanding], [0n, 1_000_000n]);
  assert.equal(JSON.parse(readFileSync(options.grant, 'utf8')).pendingReceipt, receipt);
  assert.deepEqual(['stage', 'deliveryStatus'].map(k => JSON.parse(readFileSync(receipt, 'utf8'))[k]), ['delivered', 503]);
  await assert.rejects(purchase({ ...buy, receipt: join(dir, 'purchase-2.json') }), /Unfinished purchase/);
  assert.equal((await resend({ receipt })).status, 200);
  assert.equal(headers[1], headers[0]);
  assert.deepEqual([fake.state.spent, fake.state.outstanding], [0n, 1_000_000n]);
  const settled = await resume({ grant: options.grant, receipt, rpc: 'http://127.0.0.1:27899' });
  assert.equal(settled.stage, 'settled');
  assert.deepEqual(fake.calls, ['/books', '/tab/open', '/books paid', '/books paid', '/tab/settle']);
  assert.deepEqual([fake.state.spent, fake.state.outstanding], [1_000_000n, 0n]);
  assert.equal(JSON.parse(readFileSync(options.grant, 'utf8')).pendingReceipt, undefined);
});
