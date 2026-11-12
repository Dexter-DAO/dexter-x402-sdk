import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import {
  SOLANA_MAINNET, USDC_MINT, buildSellerBinding,
  checkSellerOffer, encodeSellerBinding, screenSeller, sellerBindingNonce,
} from '@dexterai/x402/seller';
import { checkBinding, impostorLinks, linksFresh } from './case-three-seller-tools.mjs';

import { now, realUrl, fakeBase, fakeFileUrl, fileUrl, b64, payee, impostor, realFile, realQuote, files, fetchDidDocument, fetcher } from './case-three-seller-fixture.mjs';

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'case-three-seller-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('impostor-links builds the five variants and saves the bytes of each URL the check fetched', async t => {
  const out = temporary(t);
  const records = await impostorLinks({ real: realUrl, 'impostor-base': fakeBase, impostor: impostor.publicKey.toBase58(), out },
    { now, fetch: fetcher, fetchDidDocument });
  assert.equal(records.length, 5);
  assert.deepEqual(records.map(r => r.variant), ['V1', 'V2', 'V3', 'V4', 'V5']);
  assert.equal(new Set(records.map(r => r.request.sessionPubkey)).size, 5);
  assert.equal(new Set(records.map(r => r.generatedAt)).size, 1);
  assert.deepEqual(records.map(r => r.documents.map(d => d.url)), [[fakeFileUrl], [fileUrl], [fileUrl], [], []]);
  for (const record of records) {
    assert.equal(record.schema, 'case-three/copycat-link/v1');
    assert.equal(record.request.proposed.capAtomic, '10000');
    assert.equal(record.request.proposed.revolvingCapacityAtomic, '10000');
    assert.equal(record.request.proposed.expiresAtUnix, now + 3600);
    assert.equal(statSync(record.path).mode & 0o777, 0o600);
    const encoded = new URL(record.consentUrl).searchParams.get('req');
    assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64url').toString()), record.request);
    for (const doc of record.documents) {
      assert.equal(doc.bytes, b64(files[doc.url]));
      assert.equal(doc.sha256, createHash('sha256').update(files[doc.url]).digest('hex'));
    }
  }
  assert.equal(records[1].request.seller.calledUrl, realUrl);
  assert.equal(records[2].request.counterparty, impostor.publicKey.toBase58());
  assert.equal(records[3].request.app.name, 'Dexter Bookstore');
  assert.equal(records[3].request.seller.calledUrl, `${fakeBase}/v4/books/the-innovators-dilemma`);
  assert.equal(records[3].request.seller.offer, undefined);
  assert.equal(records[4].request.seller.calledUrl, realUrl);
  assert.equal(records[4].request.seller.offer, undefined);
  assert.deepEqual(readdirSync(out).sort(), ['V1.json', 'V2.json', 'V3.json', 'V4.json', 'V5.json']);
  assert.deepEqual(linksFresh({ dir: out }, { now }), []);
  assert.ok(linksFresh({ dir: out }, { now: now + 361 }).every(r => r.stale));
  await assert.rejects(impostorLinks({ real: realUrl, impostor: impostor.publicKey.toBase58(), out, variant: 'V1' },
    { now, fetch: fetcher, fetchDidDocument }), /EEXIST/);
});

async function bindingFixture(t) {
  const dir = temporary(t), vault = Keypair.generate().publicKey.toBase58(), agent = Keypair.generate().publicKey.toBase58();
  const request = { counterparty: payee.publicKey.toBase58(), appName: 'Claude', scheme: 'tab', network: SOLANA_MAINNET, asset: USDC_MINT,
    seller: { calledUrl: realUrl, expectedHost: 'books.dexter.cash', offer: realQuote.extensions['offer-receipt'].info.offers[0] } };
  const check = await checkSellerOffer(request, { now, fetchDidDocument });
  assert.equal(check.status, 'signed');
  const screen = { request, sessionPubkey: agent, known: [], agentKeys: [], history: 'loaded' };
  const decision = screenSeller(check, screen);
  const binding = encodeSellerBinding(buildSellerBinding({ check, screen, decision, confirmed: [], vault, page: 'dexter-fe@dev' }));
  const salt = new Uint8Array(32).fill(42), nonce = Buffer.from(sellerBindingNonce(binding, salt)).toString('hex');
  const signature = 'registration-signature';
  const row = { schema: 'seller-binding-row/v1', registerTx: signature, vaultPda: vault, ceremonyNonce: nonce,
    salt: b64(salt), binding: b64(binding), didDocument: b64(realFile), offerJws: request.seller.offer.signature };
  const path = join(dir, 'binding.json');
  writeFileSync(path, JSON.stringify(row));
  const dependencies = { connection: {}, readMandate: async () => ({ terms: { vault, payee: payee.publicKey.toBase58(), agent } }),
    verifyMandateApproval: async () => ({ verified: true, signature, ceremonyNonce: nonce,
      checks: [{ name: 'registration', ok: true, detail: 'Injected verified finalized approval' }] }) };
  return { row, path, dependencies, signature };
}

test('check-binding fails when one byte of the binding changes', async t => {
  const { row, path, dependencies, signature } = await bindingFixture(t);
  const options = { row: path, 'register-tx': signature, rpc: 'http://127.0.0.1:27899' };
  assert.equal((await checkBinding(options, dependencies)).verified, true);
  const original = Buffer.from(row.binding, 'base64url');
  const offset = original.indexOf(Buffer.from('"page":"dexter-fe@dev"'));
  assert.ok(offset > 0);
  original[offset + '"page":"dexter-fe@'.length] ^= 1;
  row.binding = b64(original);
  writeFileSync(path, JSON.stringify(row));
  const result = await checkBinding(options, dependencies);
  assert.equal(result.verified, false);
  assert.equal(result.checks.find(c => c.name === 'seller.commitment')?.ok, false);
});

test('check-binding rejects a row nonce that differs from the verified registration', async t => {
  const { path, dependencies, signature } = await bindingFixture(t);
  const row = JSON.parse(readFileSync(path, 'utf8'));
  row.ceremonyNonce = '00'.repeat(32);
  writeFileSync(path, JSON.stringify(row));
  const result = await checkBinding({ row: path, 'register-tx': signature }, dependencies);
  assert.equal(result.verified, false);
  assert.equal(result.checks.find(c => c.name === 'ceremony_nonce')?.ok, false);
});

test('check-binding withholds provider credentials from lookup errors', async t => {
  const { path, dependencies, signature } = await bindingFixture(t);
  dependencies.readMandate = async () => { throw new Error('https://fixture-user:fixture-password@rpc.example'); };
  const result = await checkBinding({ row: path, 'register-tx': signature }, dependencies);
  assert.equal(result.verified, false);
  assert.equal(JSON.stringify(result).includes('fixture-password'), false);
});
