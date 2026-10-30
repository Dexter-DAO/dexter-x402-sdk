import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { Keypair, SystemProgram, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { executeRefusal, refusalJson } from './case-two-refusal.mjs';
import { assertNoOtherPendingClaims, readPendingClaim, runCaseThreeRefusal } from './case-three-refusal.mjs';

function fixture(t, { code = 6013, index = 1, logs = [], send = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'case-three-refusal-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const payer = Keypair.generate();
  const receipt = join(dir, 'attempt.json');
  let sends = 0;
  const account = { owner: SystemProgram.programId, data: Buffer.from([255, 254, 253]), lamports: 10, executable: false };
  const err = { InstructionError: [index, { Custom: code }] };
  const connection = {
    getMultipleAccountsInfo: async () => [account],
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    simulateTransaction: async () => ({ value: { err, logs } }),
    sendRawTransaction: async raw => {
      sends++;
      const saved = JSON.parse(readFileSync(receipt, 'utf8'));
      assert.equal(saved.sent, false);
      assert.equal(saved.signedTransactionBase64, Buffer.from(raw).toString('base64url'));
      return bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);
    },
    confirmTransaction: async () => ({}),
    getTransaction: async () => ({ slot: 50, meta: { err, fee: 5000, logMessages: logs } }),
  };
  const ix = new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(0) });
  const options = { connection, instructions: [ix, ix], signers: [payer], feePayer: payer,
    expected: { code, instructionIndex: index }, protectedKeys: [Keypair.generate().publicKey],
    protectedLabels: ['protectedAccount'], record: { kind: 'over-limit', sent: false },
    receipt, send, bytesEncoding: 'base64url' };
  return { options, connection, receipt, sends: () => sends, account, err };
}

test('refuses to send when the simulation error differs', async t => {
  const f = fixture(t, { send: true });
  f.connection.simulateTransaction = async () => ({ value: { err: { InstructionError: [1, { Custom: 6009 }] }, logs: [] } });
  await assert.rejects(executeRefusal(f.options), /wrong reason/);
  assert.equal(f.sends(), 0);
  assert.equal(JSON.parse(readFileSync(f.receipt)).simulation.decoded.code, 6009);
});

test('refuses a second attempt on the same receipt path before RPC or send', async t => {
  const f = fixture(t);
  await executeRefusal(f.options);
  f.connection.getMultipleAccountsInfo = () => assert.fail('reused receipt must stop before RPC');
  await assert.rejects(executeRefusal(f.options), /second attempt/);
  assert.equal(f.sends(), 0);
  assert.equal(statSync(f.receipt).mode & 0o777, 0o600);
});

test('simulation-only records the expected failure and sends nothing', async t => {
  const f = fixture(t, { code: 6070, index: 0 });
  const result = await executeRefusal(f.options);
  assert.equal(result.simulation.decoded.code, 6070);
  assert.equal(result.sent, false);
  assert.equal(f.sends(), 0);
  assert.equal(result.protectedBefore[0].data, '__79');
  assert.deepEqual(result.simulation.stateUnchanged, { protectedAccount: true });
  assert.equal(result.stateUnchanged, undefined);
});

test('retained Buffer and Uint8Array bytes use base64url', () => {
  assert.deepEqual(JSON.parse(refusalJson({ buffer: Buffer.from([255, 254, 253]), bytes: Uint8Array.of(255, 254, 253) }, 'base64url')),
    { buffer: '__79', bytes: '__79' });
});

test('persist-before-send, landed failure and unchanged-state checks use one attempt', async t => {
  const f = fixture(t, { send: true, code: 6070, index: 0 });
  f.options.record.kind = 'payout-redirect';
  const result = await executeRefusal(f.options);
  assert.equal(f.sends(), 1);
  assert.equal(result.sent, true);
  assert.equal(result.landed.decoded.code, 6070);
  assert.deepEqual(result.stateUnchanged, { protectedAccount: true });
  assert.equal(result.claimAfter, '__79');
  assert.deepEqual(JSON.parse(readFileSync(f.receipt)), result);
});

test('3012 requires the session-specific Anchor log before transport', async t => {
  const f = fixture(t, { send: true, code: 3012 });
  f.options.requireLog = 'AnchorError caused by account: session';
  await assert.rejects(executeRefusal(f.options), /wrong reason/);
  assert.equal(f.sends(), 0);
});

test('6070 at another instruction index is refused before transport', async t => {
  const f = fixture(t, { send: true, code: 6070, index: 0 });
  f.options.expected.instructionIndex = 1;
  await assert.rejects(executeRefusal(f.options), /wrong reason/);
  assert.equal(f.sends(), 0);
});

test('a new Pending claim found after simulation prevents transport', async t => {
  const f = fixture(t, { send: true });
  f.options.assertReady = async () => { throw new Error('another claim is Pending'); };
  await assert.rejects(executeRefusal(f.options), /another claim is Pending/);
  assert.equal(f.sends(), 0);
});

test('a changed protected account after simulation prevents transport', async t => {
  const f = fixture(t, { send: true });
  f.options.assertReady = async () => { f.account.data = Buffer.from('changed'); };
  await assert.rejects(executeRefusal(f.options), /changed after simulation/);
  assert.equal(f.sends(), 0);
});

test('a changed protected account after a landed refusal is recorded as a failure', async t => {
  const f = fixture(t, { send: true });
  const landed = f.connection.getTransaction;
  f.connection.getTransaction = async () => { f.account.data = Buffer.from('changed'); return landed(); };
  await assert.rejects(executeRefusal(f.options), /changed vault/);
  assert.equal(f.sends(), 1);
  assert.match(JSON.parse(readFileSync(f.receipt)).error, /changed vault/);
});

function claimFixture(status = 0) {
  const vault = Keypair.generate().publicKey, seller = Keypair.generate().publicKey, holder = Keypair.generate();
  const address = Keypair.generate().publicKey;
  const data = Buffer.alloc(224);
  createHash('sha256').update('account:LockedClaim').digest().subarray(0, 8).copy(data);
  data[8] = 1;
  vault.toBuffer().copy(data, 10);
  Keypair.generate().publicKey.toBuffer().copy(data, 42);
  data.writeBigUInt64LE(1000000n, 106);
  holder.publicKey.toBuffer().copy(data, 124);
  data[156] = status;
  data[159] = 1;
  seller.toBuffer().copy(data, 160);
  return { vault, seller, holder, address, data };
}

test('every kind refuses to start while another claim is Pending', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'case-three-guard-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const c = claimFixture();
  for (const kind of ['no-permission', 'payout-redirect', 'over-limit', 'expired']) {
    const connection = { getProgramAccounts: async () => [{ pubkey: c.address, account: { data: c.data } }] };
    await assert.rejects(runCaseThreeRefusal({ connection, vault: c.vault, kind,
      receipt: join(dir, `${kind}.json`), claim: Keypair.generate().publicKey }), /another claim is Pending/);
  }
});

test('the targeted Pending claim is permitted while settled siblings are ignored', async () => {
  const c = claimFixture();
  const settled = claimFixture(1);
  const connection = { getProgramAccounts: async () => [
    { pubkey: c.address, account: { data: c.data } }, { pubkey: settled.address, account: { data: settled.data } },
  ] };
  await assertNoOtherPendingClaims(connection, c.vault, c.address);
});

test('redirect refuses a missing, settled or differently bound claim', async () => {
  const c = claimFixture();
  const program = new (await import('@solana/web3.js')).PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');
  await assert.rejects(readPendingClaim({ getAccountInfo: async () => null }, c.vault, c.address, c.seller, c.holder), /missing/);
  const connection = { getAccountInfo: async () => ({ owner: program, data: c.data }) };
  const result = await readPendingClaim(connection, c.vault, c.address, c.seller, c.holder);
  assert.equal(result.claim.amount, '1000000');
  assert.equal(result.data, c.data.toString('base64url'));
  await assert.rejects(readPendingClaim(connection, c.vault, c.address, Keypair.generate().publicKey, c.holder), /differs/);
  c.data[156] = 1;
  await assert.rejects(readPendingClaim(connection, c.vault, c.address, c.seller, c.holder), /no longer Pending/);
});
