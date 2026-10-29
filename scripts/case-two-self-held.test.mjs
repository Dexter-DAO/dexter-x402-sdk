import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection, Keypair } from '@solana/web3.js';
import { decodeSpendGrantRequest } from '@dexterai/vault/grant';
import { DEXTER_VAULT_PROGRAM_ID } from '@dexterai/x402/tab';
import { approvedGrant, assertLocalUnlessLive, makeRequest, purchase, readKey, recoverSettlement, resume, save, withGrantLock } from './case-two-self-held.mjs';

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
