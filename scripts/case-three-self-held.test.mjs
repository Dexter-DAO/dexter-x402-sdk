import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import { deriveSessionPda } from '@dexterai/vault/session';
import { deriveSwigVaultBindingPda } from '@dexterai/vault/credit';
import { buildSettleVoucherInstruction } from '@dexterai/vault/instructions';
import { DEXTER_VAULT_PROGRAM_ID, LOCKED_CLAIM_DISCRIMINATOR, DISCRIMINATORS } from '@dexterai/vault/constants';
import { finalVoucherV2ReservationIdentity, finalVoucherV2ReservationMemo } from '@dexterai/x402/tab';
import { request, checkedQuote, expiry, buy, claimFor, purchaseLifecycle, redisCommand, settleHeld, waitPending } from './case-three-self-held.mjs';
import { resume } from './case-two-self-held.mjs';
import { now, realUrl, realQuote, realFile, realKey, payee, impostor, signed, fetchDidDocument } from './case-three-seller-fixture.mjs';

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'case-three-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function quoteResponse(body = realQuote) {
  return new Response(JSON.stringify(body), { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(body)).toString('base64') } });
}
function requestOptions(dir) {
  return { merchant: payee.publicKey.toBase58(), 'seller-url': realUrl, endpoint: 'http://127.0.0.1:27902/books',
    'expiry-rule': '2.5h', key: join(dir, 'agent.json'), grant: join(dir, 'grant.json') };
}
const quoteDependencies = { now, fetch: async () => quoteResponse(), fetchDidDocument };

test('expiry picks the first half hour at least 2.5 hours away', () => {
  assert.equal(expiry({ 'expiry-rule': '2.5h' }, 1800).unix, 10800);
  assert.equal(expiry({ 'expiry-rule': '2.5h' }, 1801).unix, 12600);
  assert.throws(() => expiry({ 'expires-at': 10 }, 11), /future/);
});

test('request refuses an unsigned or refused quote before writing an agent or grant', async t => {
  const dir = directory(t), options = requestOptions(dir);
  const unsigned = structuredClone(realQuote); delete unsigned.extensions;
  await assert.rejects(request(options, { ...quoteDependencies, fetch: async () => quoteResponse(unsigned) }), /Unsigned quote/);
  const wrong = { ...options, merchant: impostor.publicKey.toBase58() };
  await assert.rejects(request(wrong, quoteDependencies), /payto_mismatch/);
  assert.equal(existsSync(options.key), false); assert.equal(existsSync(options.grant), false);
});

test('buy refuses a quote for another host, resource or payTo', async () => {
  const options = requestOptions('/unused');
  await assert.rejects(checkedQuote({ ...options, 'expected-host': 'another.dexter.cash' }, options.merchant, {}, quoteDependencies), /expected_host_mismatch/);
  await assert.rejects(checkedQuote({ ...options, 'seller-url': realUrl.replace('the-innovators-dilemma', 'the-sovereign-individual') }, options.merchant, {}, quoteDependencies), /resource_url_mismatch/);
  await assert.rejects(checkedQuote(options, impostor.publicKey.toBase58(), {}, quoteDependencies), /payto_mismatch/);
});

test('buy refuses a quote whose unsigned accepts payTo differs from the signed payTo', async () => {
  const body = structuredClone(realQuote); body.accepts[0].payTo = impostor.publicKey.toBase58();
  await assert.rejects(checkedQuote(requestOptions('/unused'), payee.publicKey.toBase58(), {}, {
    ...quoteDependencies, fetch: async () => quoteResponse(body),
  }), /Unsigned quote or unsigned accepts terms differ/);
});

// The reservation verifier and Tab SDK run unchanged. Only RPC and HTTP are in-memory.
function cloneStandIn(t, record, { badReceipt = false, losePayoutResponseOnce = false } = {}) {
  const merchant = new PublicKey(record.request.counterparty), agent = new PublicKey(record.request.sessionPubkey);
  const vault = Keypair.generate().publicKey, swig = Keypair.generate().publicKey, authority = Keypair.generate().publicKey;
  const [sessionPda, bump] = deriveSessionPda(vault, merchant);
  const [bindingPda, bindingBump] = deriveSwigVaultBindingPda(swig);
  const state = { spent: 0n, locked: 0n, outstanding: 0n, claim: null, closed: false, claimPolls: 0 };
  const transactions = new Map(), calls = [];
  const accounts = () => {
    const binding = Buffer.alloc(74); Buffer.from([56, 67, 4, 209, 238, 143, 0, 129]).copy(binding);
    binding[8] = 1; binding[9] = bindingBump; swig.toBuffer().copy(binding, 10); vault.toBuffer().copy(binding, 42);
    const v = Buffer.alloc(181); Buffer.from([211, 8, 232, 43, 2, 152, 117, 119]).copy(v); v[8] = 7; v[9] = 255;
    Buffer.alloc(33, 7).copy(v, 10); swig.toBuffer().copy(v, 43); v.writeUInt32LE(1, 79); authority.toBuffer().copy(v, 116); v[148] = 1;
    const session = Buffer.alloc(162); Buffer.from([74, 34, 65, 133, 96, 163, 80, 69]).copy(session); session[8] = 1; session[9] = bump;
    vault.toBuffer().copy(session, 10); agent.toBuffer().copy(session, 42); session.writeBigUInt64LE(3_000_000n, 74);
    session.writeBigInt64LE(BigInt(record.request.proposed.expiresAtUnix), 82); merchant.toBuffer().copy(session, 90);
    session.writeUInt32LE(0x80000001, 122); session.writeBigUInt64LE(state.spent, 126); session.writeBigUInt64LE(state.outstanding, 134);
    session.writeBigUInt64LE(1_500_000n, 142); session.writeBigUInt64LE(state.locked, 150);
    return new Map([[bindingPda.toBase58(), binding], [vault.toBase58(), v], [sessionPda.toBase58(), session]]);
  };
  function claimData() {
    const bytes = Buffer.alloc(224); Buffer.from(LOCKED_CLAIM_DISCRIMINATOR).copy(bytes); bytes[8] = 1;
    vault.toBuffer().copy(bytes, 10); agent.toBuffer().copy(bytes, 42); bytes.writeBigUInt64LE(1_000_000n, 106);
    bytes.writeBigInt64LE(BigInt(now), 114); authority.toBuffer().copy(bytes, 124); bytes[159] = 1; merchant.toBuffer().copy(bytes, 160);
    return bytes;
  }
  const info = data => data ? { data, owner: DEXTER_VAULT_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 } : null;
  const rpc = {
    getAccountInfo: async key => {
      if (key.toBase58() === state.claim) {
        if (state.closed) return null;
        state.claimPolls++;
        if (state.claimPolls < 2) { calls.push('claim-not-yet'); return null; }
        calls.push('claim-Pending'); state.locked = 1_000_000n; state.outstanding = 0n; return info(claimData());
      }
      return info(accounts().get(key.toBase58()));
    },
    getMultipleAccountsInfoAndContext: async keys => ({ context: { slot: 101 }, value: keys.map(key => info(accounts().get(key.toBase58()))) }),
    getSignatureStatuses: async ([signature]) => ({ value: [transactions.has(signature) ? { err: null, confirmationStatus: 'finalized', slot: 100 } : null] }),
    getTransaction: async signature => transactions.get(signature) ?? null,
    getSignaturesForAddress: async () => [...transactions.keys()].map(signature => ({ signature, err: null })),
  };
  function reserve(body) {
    const voucher = { payload: { channelId: body.channel_id, cumulativeAmount: body.cumulative_amount_atomic, sequenceNumber: body.sequence_number },
      sessionPublicKey: Buffer.from(body.session_public_key, 'hex'), sessionSignature: Buffer.from(body.session_signature, 'hex'), sessionRegistration: Buffer.from(body.session_registration, 'hex') };
    const input = { network: 'solana:mainnet', programId: DEXTER_VAULT_PROGRAM_ID.toBase58(), buyerSwigAddress: body.buyer_swig_address,
      vaultPda: body.vault_pda, sessionPda: sessionPda.toBase58(), seller: body.seller, channelId: body.channel_id, sessionNonce: 0x80000001,
      reservationAmountAtomic: body.reservation_amount_atomic, previousCumulativeAtomic: '0', ...finalVoucherV2ReservationIdentity(voucher), voucher };
    state.claim = claimFor(input);
    const signature = bs58.encode(randomBytes(64));
    const instructions = [buildSettleVoucherInstruction({ vaultPda: vault, dexterAuthority: authority, allowedCounterparty: merchant,
      swigAddress: swig, vaultUsdcAta: null, siblingSessionPdas: [], amount: 1_000_000n, increment: true }),
    new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [{ pubkey: authority, isSigner: true, isWritable: false }],
      data: Buffer.from(finalVoucherV2ReservationMemo(input)) })];
    const message = new TransactionMessage({ payerKey: authority, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions }).compileToV0Message();
    transactions.set(signature, { slot: 100, version: 0, transaction: { signatures: [signature], message }, meta: { err: null, loadedAddresses: { writable: [], readonly: [] } } });
    state.outstanding = 1_000_000n;
    return { contract: 'dexter-native-tab-open-receipt/v1', operationId: randomBytes(32).toString('hex'), callerOperationId: body.operation_id,
      network: 'solana:mainnet', transaction: signature, commitment: 'confirmed', confirmationSlot: 100, postStateSlot: 101,
      buyerSwigAddress: body.buyer_swig_address, vaultPda: body.vault_pda, sessionPda: sessionPda.toBase58(), seller: body.seller,
      channelId: body.channel_id, sessionPublicKey: body.session_public_key, voucherDigest: body.voucher_digest,
      cumulativeAmountAtomic: body.cumulative_amount_atomic, sequenceNumber: body.sequence_number, providerReceiptId: body.provider_receipt_id,
      reservationAmountAtomic: body.reservation_amount_atomic, pendingVoucherCountBefore: 0, pendingVoucherCountAfter: 1,
      currentOutstandingBeforeAtomic: '0', currentOutstandingAfterAtomic: body.reservation_amount_atomic };
  }
  const priorRpc = Object.fromEntries(Object.keys(rpc).map(name => [name, Connection.prototype[name]]));
  const previousFetch = globalThis.fetch, previousToken = process.env.DEXTER_INTERNAL_TOKEN;
  Object.assign(Connection.prototype, rpc); process.env.DEXTER_INTERNAL_TOKEN = 'disposable-case-three-token';
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname, paid = !!init.headers?.['X-Tab-Voucher']; calls.push(paid ? `${path} paid` : path);
    if (path === '/tab/open') return Response.json({ armed: true, receipt: reserve(JSON.parse(init.body)) });
    if (path === '/tab/settle') {
      assert.ok(calls.includes('claim-Pending'), 'must observe claim before close');
      return Response.json({ settled: false, reason: 'covered_by_frontier', settleTx: '', onChainSpent: state.spent.toString(),
        crystallizedCumulative: state.locked.toString(), frontier: state.locked.toString(), attemptedCumulative: '1000000' });
    }
    if (path === '/tab/lock/settle') {
      state.closed = true;
      const signature = bs58.encode(randomBytes(64));
      const keys = [vault, authority, new PublicKey(state.claim)].map(pubkey => ({ pubkey, isSigner: false, isWritable: true }));
      const message = new TransactionMessage({ payerKey: authority, recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [new TransactionInstruction({ programId: DEXTER_VAULT_PROGRAM_ID, keys, data: Buffer.from(DISCRIMINATORS.settle_locked_voucher) })] }).compileToV0Message();
      transactions.set(signature, { slot: 100, transaction: { message }, meta: { err: null } });
      if (losePayoutResponseOnce) { losePayoutResponseOnce = false; throw new Error('Injected lost payout response'); }
      return Response.json({ results: [{ claimPda: state.claim, status: 'settled', settleTx: signature }] });
    }
    if (!paid) return quoteResponse();
    return Response.json({ storeReceipt: badReceipt ? 'malformed' : signed({ version: 1, network: realQuote.accepts[0].network,
      resourceUrl: realUrl, payer: vault.toBase58(), issuedAt: Math.floor(Date.now() / 1000) }, realKey, 'did:web:dexter.cash#books-quote-1') });
  };
  t.after(() => {
    Object.assign(Connection.prototype, priorRpc); globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.DEXTER_INTERNAL_TOKEN; else process.env.DEXTER_INTERNAL_TOKEN = previousToken;
  });
  return { vault: vault.toBase58(), rpc, state, calls };
}

async function setupPurchase(t, changes = {}) {
  const dir = directory(t), options = requestOptions(dir);
  const record = await request(options, quoteDependencies);
  const didFile = join(dir, 'did.json'); writeFileSync(didFile, realFile);
  const fake = cloneStandIn(t, record, changes);
  const buyOptions = { ...options, 'did-file': didFile, 'check-seller': true, 'pay-claim': true,
    vault: fake.vault, rpc: 'http://127.0.0.1:27899', facilitator: 'http://127.0.0.1:27901',
    reason: 'Fixture purchase', receipt: join(dir, 'purchase.json') };
  return { fake, options: buyOptions, dir };
}

test('buy waits for the locked claim before closing', async t => {
  const { fake, options } = await setupPurchase(t);
  const result = await buy(options, { pause: async () => {} });
  assert.equal(result.stage, 'settled');
  assert.equal(result.storeReceipt.verified, true);
  assert.ok(result.claim.pendingAt); assert.ok(result.claim.closedAt);
  assert.ok(fake.calls.indexOf('claim-not-yet') < fake.calls.indexOf('claim-Pending'));
  assert.ok(fake.calls.indexOf('claim-Pending') < fake.calls.indexOf('/tab/settle'));
  assert.equal(fake.calls.filter(c => c === '/books paid').length, 1);
});

test('buy passes its facilitator env file to the existing reservation fence', async t => {
  const { options } = await setupPurchase(t);
  delete process.env.DEXTER_INTERNAL_TOKEN;
  const file = join(directory(t), 'facilitator.env');
  writeFileSync(file, 'DEXTER_INTERNAL_TOKEN=disposable-file-token\n', { mode: 0o600 });
  const result = await buy({ ...options, 'env-file': file }, { pause: async () => {} });
  assert.equal(result.stage, 'settled');
});

test('buy records a store receipt that fails verification and does not pay again', async t => {
  const { fake, options } = await setupPurchase(t, { badReceipt: true });
  await assert.rejects(buy(options), /Store receipt verification failed/);
  const journal = JSON.parse(readFileSync(options.receipt, 'utf8'));
  assert.equal(journal.stage, 'delivered'); assert.equal(journal.storeReceipt.verified, false);
  await assert.rejects(buy({ ...options, receipt: join(directory(t), 'second.json') }), /Unfinished purchase/);
  assert.equal(fake.calls.filter(c => c === '/books paid').length, 1);
  assert.equal(fake.calls.includes('/tab/lock/settle'), false);
});

test('a failed store receipt remains recorded when resume discovers a later payout', async t => {
  const { fake, options } = await setupPurchase(t, { badReceipt: true });
  await assert.rejects(buy(options, { pause: async () => {} }), /Store receipt verification failed/);
  const delivered = JSON.parse(readFileSync(options.receipt, 'utf8'));
  assert.ok(delivered.claim.pendingAt);
  await globalThis.fetch('http://127.0.0.1:27901/tab/lock/settle');
  const result = await resume(options, purchaseLifecycle(options, { pause: async () => {} }));
  assert.equal(result.stage, 'settled'); assert.equal(result.storeReceipt.verified, false);
  assert.equal(fake.calls.filter(c => c === '/books paid').length, 1);
  assert.equal(fake.calls.filter(c => c === '/tab/open').length, 1);
  assert.equal(fake.calls.filter(c => c === '/tab/lock/settle').length, 1);
});

test('the hold is set and read back inside the reservation hook before the reservation is sent', async t => {
  const { fake, options } = await setupPurchase(t);
  const seen = [];
  const redis = (_options, command) => { seen.push(command[0]); assert.equal(fake.calls.includes('/tab/open'), false); return command[0] === 'SET' ? 'OK' : 'case-three'; };
  const result = await buy({ ...options, 'pay-claim': false, 'hold-settlement': true }, { redis, pause: async () => {} });
  assert.deepEqual(seen, ['SET', 'GET']);
  assert.equal(result.stage, 'delivered'); assert.ok(result.claim.pendingAt); assert.equal(result.hold.readBack, 'case-three');
  assert.equal(fake.calls.includes('/tab/settle'), false);
});

test('a failed hold read-back stops before reservation or delivery', async t => {
  const { fake, options } = await setupPurchase(t);
  const redis = (_options, command) => command[0] === 'SET' ? 'OK' : 'another-owner';
  await assert.rejects(buy({ ...options, 'pay-claim': false, 'hold-settlement': true }, { redis }), /hold read-back failed/);
  assert.equal(fake.calls.includes('/tab/open'), false);
  assert.equal(fake.calls.includes('/books paid'), false);
});

test('Redis password is passed only through REDISCLI_AUTH and child errors hide credentials', t => {
  const dir = directory(t), envFile = join(dir, 'facilitator.env');
  writeFileSync(envFile, 'REDIS_URL=redis://test-user:fixture-password@127.0.0.1:6379/2\n');
  const execute = (file, argv, child) => {
    assert.equal(file, '/usr/bin/redis-cli'); assert.equal(child.env.REDISCLI_AUTH, 'fixture-password');
    assert.equal(argv.some(value => value.includes('fixture-password') || value.includes('redis://')), false);
    return 'case-three\n';
  };
  assert.equal(redisCommand({ 'env-file': envFile }, ['GET', 'a-key'], execute), 'case-three');
  assert.throws(() => redisCommand({ 'env-file': envFile }, ['GET', 'a-key'], () => { throw new Error('fixture-password'); }), error => error.message === 'Redis hold command failed');
});

test('settle-held deletes the hold only after the claim closes and a payout record exists', async t => {
  const { fake, options, dir } = await setupPurchase(t);
  const heldOptions = { ...options, 'pay-claim': false, 'hold-settlement': true };
  const redis = (_options, command) => command[0] === 'SET' ? 'OK' : 'case-three';
  const journal = await buy(heldOptions, { redis, pause: async () => {} });
  const payout = join(dir, 'payout.json');
  const deletion = (_options, command) => {
    if (command[0] === 'DEL') {
      assert.equal(fake.state.closed, true);
      const saved = JSON.parse(readFileSync(payout, 'utf8'));
      assert.ok(saved.signature); assert.ok(saved.closedAt); assert.equal(saved.holdDeletedAt, null);
      return '1';
    }
    return 'case-three';
  };
  const result = await settleHeld({ ...options, 'pay-claim': false, claim: journal.claim.address, payout }, { redis: deletion, pause: async () => {} });
  assert.ok(result.holdDeletedAt);
  assert.equal(JSON.parse(readFileSync(options.grant, 'utf8')).pendingReceipt, undefined);
});

test('settle-held recovers a lost payout response without requesting a second payout', async t => {
  const { fake, options, dir } = await setupPurchase(t, { losePayoutResponseOnce: true });
  let deleted = 0;
  const redis = (_options, command) => {
    if (command[0] === 'SET') return 'OK';
    if (command[0] === 'DEL') { deleted++; return '1'; }
    return 'case-three';
  };
  const held = await buy({ ...options, 'pay-claim': false, 'hold-settlement': true }, { redis, pause: async () => {} });
  const settle = { ...options, 'pay-claim': false, claim: held.claim.address, payout: join(dir, 'payout.json') };
  await assert.rejects(settleHeld(settle, { redis, pause: async () => {} }), /Injected lost payout response/);
  assert.equal(fake.state.closed, true); assert.equal(deleted, 0);
  const result = await settleHeld(settle, { redis, pause: async () => {} });
  assert.ok(result.signature); assert.ok(result.closedAt); assert.equal(deleted, 1);
  assert.equal(fake.calls.filter(c => c === '/tab/lock/settle').length, 1);
});

test('waitPending rejects another claim amount before closing', async t => {
  const { fake, options } = await setupPurchase(t);
  const lifecycle = purchaseLifecycle({ ...options, 'pay-claim': false, 'hold-settlement': true, 'no-hold': true }, { pause: async () => {} });
  assert.equal(lifecycle.stopAfterDelivery, true);
  const journal = await buy({ ...options, 'pay-claim': false, 'hold-settlement': true, 'no-hold': true }, { pause: async () => {} });
  journal.reservationInput.reservationAmountAtomic = '999999';
  await assert.rejects(waitPending(fake.rpc, journal, options.receipt), /Claim does not match/);
});
