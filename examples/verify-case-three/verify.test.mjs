import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { SOLANA_MAINNET, USDC_MINT, addressProofMessage, buildSellerBinding, canonicalBytes,
  checkSellerOffer, encodeSellerBinding, knownSellers, screenSeller, sellerBindingNonce } from '@dexterai/x402/seller';
import { archiveRawUrl, fetchPublicBytes, publicHttps, saveArchive, sha256 } from './archive.mjs';
import { bytes, rerunCopycat, requireProgramLog, verifyCopycatHistory, verifyRecord, verifySellerRecord, verifyScreenshot, verifyReceipt } from './verify.mjs';

const b64 = input => Buffer.from(input).toString('base64url');
const now = 1793327400;
function signingKey() {
  const pair = generateKeyPairSync('ed25519');
  const jwk = pair.publicKey.export({format: 'jwk'});
  return {...pair, jwk, address: new PublicKey(Buffer.from(jwk.x, 'base64url')).toBase58()};
}
function jws(payload, pair, kid) {
  const prefix = `${b64(Buffer.from(JSON.stringify({alg: 'EdDSA', kid})))}.${b64(canonicalBytes(payload))}`;
  return `${prefix}.${b64(sign(null, Buffer.from(prefix), pair.privateKey))}`;
}
function profile(domain, host, pair, seller) {
  const did = `did:web:${domain}`, kid = `${did}#quote-1`;
  const entry = {network: SOLANA_MAINNET, asset: USDC_MINT, address: seller.address};
  return canonicalBytes({'@context': ['https://www.w3.org/ns/did/v1'], id: did, assertionMethod: [kid],
    verificationMethod: [{id: kid, controller: did, type: 'JsonWebKey2020', publicKeyJwk: pair.jwk}],
    service: [{id: `${did}#seller`, type: 'DexterSellerProfile', serviceEndpoint: {v: 'dexter-seller-profile/v1',
      name: 'Dexter Bookstore', hosts: [host], signingKeys: [kid], payTo: [{...entry,
        proof: b64(sign(null, addressProofMessage({...entry, did}), seller.privateKey))}]}}]});
}
async function fixture() {
  const store = signingKey(), seller = signingKey(), copycat = signingKey(), impostor = signingKey();
  const realDocument = profile('dexter.cash', 'books.dexter.cash', store, seller);
  const copycatDocument = profile('dexter-bookstore.pages.dev', 'dexter-bookstore.pages.dev', copycat, impostor);
  const realUrl = 'https://books.dexter.cash/books/the-innovators-dilemma';
  const fakeUrl = 'https://dexter-bookstore.pages.dev/books/the-innovators-dilemma';
  const fileUrl = 'https://dexter.cash/.well-known/did.json';
  const fakeFileUrl = 'https://dexter-bookstore.pages.dev/.well-known/did.json';
  const offer = (url, pair, kid, payTo) => ({format: 'jws', signature: jws({version: 1, resourceUrl: url,
    scheme: 'tab', network: SOLANA_MAINNET, asset: USDC_MINT, payTo, amount: '1000000', validUntil: now + 480}, pair, kid)});
  const realOffer = offer(realUrl, store, 'did:web:dexter.cash#quote-1', seller.address);
  const fakeOffer = offer(fakeUrl, copycat, 'did:web:dexter-bookstore.pages.dev#quote-1', impostor.address);
  const v2Offer = offer(realUrl, copycat, 'did:web:dexter.cash#not-listed', impostor.address);
  const agent = Keypair.generate().publicKey.toBase58(), vault = Keypair.generate().publicKey.toBase58();
  const request = {counterparty: seller.address, appName: 'Claude', seller: {calledUrl: realUrl, offer: realOffer},
    scheme: 'tab', network: SOLANA_MAINNET, asset: USDC_MINT};
  const check = await checkSellerOffer(request, {now, fetchDidDocument: async () => realDocument});
  assert.equal(check.status, 'signed');
  const screen = {request, sessionPubkey: agent, known: [], agentKeys: [], history: 'loaded'};
  const decision = screenSeller(check, screen);
  const binding = buildSellerBinding({check, screen, decision, confirmed: [], vault, page: 'dexter-fe@dev'});
  const bindingBytes = encodeSellerBinding(binding), salt = Buffer.alloc(32, 7), nonce = sellerBindingNonce(bindingBytes, salt);
  const registerTx = '4'.repeat(88);
  const record = {schema: 'dexter-mandate-case/v1', caseId: 'fixture', manifest: {schema: 'dexter-standing-case-manifest/v2',
    account: {vault}, permission: {executionKey: agent, seller: seller.address, registrationSignature: registerTx,
      network: SOLANA_MAINNET, assetMint: USDC_MINT}, seller: {bindingSha256: sha256(bindingBytes), host: binding.host, registrableDomain: binding.registrableDomain, did: binding.did, kid: binding.kid}},
    seller: {binding: b64(bindingBytes), salt: b64(salt), bindingSha256: sha256(bindingBytes), ceremonyNonce: Buffer.from(nonce).toString('hex'),
      didDocument: b64(realDocument), offerJws: realOffer.signature, registerTx}};
  const known = knownSellers([{binding: bindingBytes, salt, ceremonyNonce: nonce, registerTx, registeredAt: now}], {vault});
  const document = (url, data) => ({url, bytes: b64(data), sha256: sha256(data)});
  const attempt = (variant, calledUrl, signedOffer, documents, expected, name = 'Claude') => ({variant, checkedAt: now, validUntil: signedOffer ? now + 480 : null,
    request: {counterparty: impostor.address, app: {name}, sessionPubkey: agent,
      seller: {calledUrl, ...(signedOffer ? {offer: signedOffer} : {})}}, documents, expected});
  const attempts = [
    attempt('V1', fakeUrl, fakeOffer, [document(fakeFileUrl, copycatDocument)], {approve: 'confirm', rule: 'R4', code: 'lookalike_name'}),
    attempt('V2', realUrl, v2Offer, [document(fileUrl, realDocument)], {approve: 'refused', rule: 'R1', code: 'kid_not_listed'}),
    attempt('V3', realUrl, realOffer, [document(fileUrl, realDocument)], {approve: 'refused', rule: 'R2', code: 'payto_mismatch'}),
    attempt('V4', fakeUrl, null, [], {approve: 'confirm', rule: 'R4', code: 'lookalike_name'}, 'Dexter Bookstore'),
    attempt('V5', realUrl, null, [], {approve: 'confirm', rule: 'R5', code: 'unsigned_known_host'}),
  ];
  return {record, binding, store, seller, approval: {verified: true, ceremonyNonce: Buffer.from(nonce).toString('hex')}, known, attempts,
    realDocument, copycatDocument, document, fileUrl, fakeFileUrl};
}

test('seller evidence and retained base64url salt verify with the approval nonce', async () => {
  const {record, approval} = await fixture();
  const result = await verifySellerRecord(record, approval);
  assert.equal(result.verified, true);
  assert.equal(result.checks.every(row => row.ok), true);
  assert.equal(bytes(record.seller.salt, 'salt', 32).length, 32);
});

test('one changed binding byte fails commitment', async () => {
  const {record, approval} = await fixture();
  const binding = JSON.parse(Buffer.from(record.seller.binding, 'base64url'));
  binding.checkedAt++;
  record.seller.binding = b64(encodeSellerBinding(binding));
  const result = await verifySellerRecord(record, approval);
  assert.equal(result.verified, false);
  assert.equal(result.checks.find(check => check.name === 'commitment').ok, false);
});

test('changed salt, nonce, file and quote each fail seller evidence', async t => {
  for (const field of ['salt', 'ceremonyNonce', 'didDocument', 'offerJws']) await t.test(field, async () => {
    const {record, approval} = await fixture();
    if (field === 'ceremonyNonce') record.seller[field] = '00'.repeat(32);
    else if (field === 'offerJws') {const parts = record.seller[field].split('.'); const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1; parts[2] = b64(signature); record.seller[field] = parts.join('.');}
    else {const value = bytes(record.seller[field], field); value[0] ^= 1; record.seller[field] = b64(value);}
    const result = await verifySellerRecord(record, approval);
    assert.equal(result.verified, false);
  });
});

test('V1 to V5 replay their saved approve, rule and code', async () => {
  const {attempts, known} = await fixture();
  for (const attempt of attempts) await rerunCopycat(attempt, known);
});

test('a copycat rerun with dexter.cash file swapped for copycat file fails', async () => {
  const {attempts, known, realDocument, document, fakeFileUrl} = await fixture();
  attempts[0].documents = [document(fakeFileUrl, realDocument)];
  await assert.rejects(rerunCopycat(attempts[0], known), /Copycat approve, rule or code differs/);
});

test('missing, duplicated, altered-hash and unused saved documents fail', async t => {
  for (const mutation of ['missing', 'duplicate', 'hash', 'unused']) await t.test(mutation, async () => {
    const {attempts, known, document, realDocument, fileUrl} = await fixture();
    const attempt = attempts[0];
    if (mutation === 'missing') attempt.documents = [];
    if (mutation === 'duplicate') attempt.documents.push(attempt.documents[0]);
    if (mutation === 'hash') attempt.documents[0].sha256 = '00'.repeat(32);
    if (mutation === 'unused') attempt.documents.push(document(fileUrl, realDocument));
    await assert.rejects(rerunCopycat(attempt, known));
  });
});

test('first-contact V1 allows a first payment with empty history', async () => {
  const {attempts} = await fixture();
  const firstContact = {...attempts[0], expected: {approve: 'allowed', relation: 'first-payment'}};
  const result = await rerunCopycat(firstContact, [], {firstContact: true});
  assert.equal(result.seller.relation, 'first-payment');
});

test('copycat history follows every page to the empty end', async () => {
  const a = Keypair.generate().publicKey.toBase58(), b = Keypair.generate().publicKey.toBase58();
  const pages = [[{signature: 'first', err: {InstructionError: [1, {Custom: 3012}]}}], [{signature: 'second', err: 'failed'}], []];
  const calls = [];
  const result = await verifyCopycatHistory({getSignaturesForAddress: async (_, options) => {calls.push(options); return pages.shift();},
    getAccountInfo: async () => null}, a, b);
  assert.equal(result.failedSignatures, 2);
  assert.deepEqual(calls.map(call => call.before), [undefined, 'first', 'second']);
});

test('a history with one successful transaction fails', async () => {
  const a = Keypair.generate().publicKey.toBase58(), b = Keypair.generate().publicKey.toBase58();
  await assert.rejects(verifyCopycatHistory({getSignaturesForAddress: async () => [{signature: 'success', err: null}]}, a, b), /Successful/);
});

test('an existing copycat account fails', async () => {
  const a = Keypair.generate().publicKey.toBase58(), b = Keypair.generate().publicKey.toBase58();
  await assert.rejects(verifyCopycatHistory({getSignaturesForAddress: async () => [], getAccountInfo: async () => ({data: Buffer.alloc(1)})}, a, b), /account exists/);
});

test('refusal requires the exact program log retained by the record', () => {
  const programLog = 'Program log: AnchorError thrown in programs/dexter-vault/src/instructions/settle_voucher.rs:108. Error Code: RevolvingCapacityExceeded. Error Number: 6013. Error Message: Revolving capacity exceeded.';
  const refusal = {programLog, error: {code: 6013, name: 'RevolvingCapacityExceeded'}};
  assert.equal(requireProgramLog({meta: {logMessages: [programLog]}}, refusal), programLog);
  assert.throws(() => requireProgramLog({meta: {logMessages: [programLog + ' ']}}, refusal), /differs/);
  assert.throws(() => requireProgramLog({meta: {logMessages: [programLog]}}, {...refusal, programLog: undefined}), /differs/);
});

test('Wayback comparison uses decoded id_ bytes and prints timestamp and both hashes', async () => {
  const body = Buffer.from('{"store":"fixture"}');
  const source = 'https://dexter.cash/.well-known/did.json';
  const snapshot = 'https://web.archive.org/web/20261030025000/https://dexter.cash/.well-known/did.json';
  const fetcher = async url => url.includes('/save/')
    ? new Response('', {headers: {'content-location': snapshot}})
    : new Response(body);
  const saved = await saveArchive(source, {fetcher});
  assert.equal(saved.timestamp, '20261030025000');
  assert.equal(saved.url, snapshot.replace('/20261030025000/', '/20261030025000id_/'));
  assert.equal(saved.liveSha256, sha256(body));
  assert.equal(saved.archiveSha256, sha256(body));
  assert.equal(saved.matched, true);
  assert.equal(archiveRawUrl(saved.url), saved.url);
});

test('native fetch decodes compressed HTTP bytes once', async () => {
  const body = Buffer.from('{"store":"gzip fixture"}');
  const server = createServer((_, response) => {response.writeHead(200, {'content-encoding': 'gzip'}); response.end(gzipSync(body));});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const {bytes: decoded} = await fetchPublicBytes('https://example.com/did.json', {
      fetcher: (_, options) => fetch(`http://127.0.0.1:${server.address().port}`, options)});
    assert.deepEqual(decoded, body);
  } finally {await new Promise(resolve => server.close(resolve));}
});

test('archive byte mismatch fails and unsafe or untimestamped URLs are rejected', async () => {
  const source = 'https://dexter.cash/.well-known/did.json';
  const saved = await saveArchive(source, {fetcher: async url => url.includes('/save/')
    ? new Response('', {headers: {'content-location': '/web/20261030025000id_/https://dexter.cash/.well-known/did.json'}})
    : new Response(url.includes('/web/') ? 'changed' : 'original')});
  assert.equal(saved.matched, false);
  for (const url of ['http://example.com/', 'https://localhost/', 'https://127.0.0.1/', 'https://user:pass@example.com/']) {
    assert.throws(() => publicHttps(url));
  }
  assert.throws(() => archiveRawUrl('https://web.archive.org/web/https://example.com/'));
});

test('direct records and the downloaded envelope are both consumed; incomplete proof exits failed', async () => {
  const {record} = await fixture();
  for (const input of [record, {format: 'dexter-mandate-case-record/v1', case: record}]) {
    const rows = [];
    const result = await verifyRecord(input, {connection: {getGenesisHash: async () => 'wrong-network'}, emit: line => rows.push(line)});
    assert.equal(result.ok, false);
    assert.ok(rows.some(row => row.startsWith('PASS record:')));
    assert.ok(rows.some(row => row.startsWith('FAIL network:')));
  }
});


test('a screenshot with another hash fails', async () => {
  const screenshot = Buffer.from('fixture-png');
  const firstContact = {screenshot: {path: '/proof/case-three/first-contact-v1.png', sha256: sha256(screenshot)}};
  assert.equal(await verifyScreenshot(firstContact, async () => new Response(screenshot)), sha256(screenshot));
  firstContact.screenshot.sha256 = '00'.repeat(32);
  await assert.rejects(verifyScreenshot(firstContact, async () => new Response(screenshot)), /Screenshot hash differs/);
});

test('published approval and two purchases verify through the pinned public SDKs', async () => {
  const {readFile} = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/published-case-two-payments.json', import.meta.url), 'utf8'));
  const {Connection} = await import('@solana/web3.js');
  const {verifyApproval, verifyPurchase} = await import('./verify.mjs');
  const connection = new Connection('https://recorded-public-rpc.example', {commitment: 'finalized',
    fetch: async (_, init) => {
      const {id, method, params} = JSON.parse(init.body);
      const result = method === 'getSlot' ? 463100000
        : method === 'getTransaction' ? fixture.transactions[params[0]]?.[params[1]?.encoding ?? 'json'] : null;
      return Response.json({jsonrpc: '2.0', id, result});
    }});
  const approval = await verifyApproval(connection, fixture.record);
  assert.equal(approval.verified, true);
  assert.equal(approval.slot, 462937382);
  for (const [index, purchase] of fixture.record.manifest.purchases.entries()) {
    const result = await verifyPurchase(connection, fixture.record, fixture.record.actions[index], purchase, approval);
    assert.equal(result.verified, true);
    assert.equal(result.dexterAuthority, '3SWJTQ4FBDveFQGQbqd8pxyBxa2PKqkega4QzxgPMWMG');
  }
});


test('store receipts bind book URL, payer, network and verified reservation-to-lock times', async t => {
  for (const mutation of ['none', 'url', 'payer', 'network', 'issuedAt', 'signature', 'orderBytes']) await t.test(mutation, async () => {
    const {record, binding, store, seller} = await fixture();
    const order = {orderId: 'fixture-order', productId: 'book:the-innovators-dilemma', quantity: 1, totalAmountAtomic: '1000000'};
    const rawOrder = JSON.stringify(order), resourceUrl = binding.calledUrl;
    const payload = {version: 1, resourceUrl, network: SOLANA_MAINNET, payer: record.manifest.account.vault, issuedAt: now};
    if (mutation === 'url') payload.resourceUrl += '-other';
    if (mutation === 'payer') payload.payer = seller.address;
    if (mutation === 'network') payload.network = 'other-network';
    if (mutation === 'issuedAt') payload.issuedAt = now - 1000;
    const receipt = {schema: 'dexter-books-receipt/v1', resourceUrl, order, payment: {seller: seller.address,
      channelId: '11'.repeat(32), sequenceNumber: 2147483649, cumulativeAtomic: '1000000', amountAtomic: '1000000'},
      storeReceipt: {format: 'jws', signature: jws(payload, store, binding.kid)}};
    if (mutation === 'signature') {const parts = receipt.storeReceipt.signature.split('.'); const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1; parts[2] = b64(signature); receipt.storeReceipt.signature = parts.join('.');}
    const body = JSON.stringify(receipt);
    // Different object-key order can result from parsing the shared schema; byte hashing still uses the original body.
    const retained = Object.fromEntries(Object.entries(receipt).reverse());
    const action = {amountAtomic: '1000000', proof: {voucher: {channelId: '11'.repeat(32), sequenceNumber: 2147483649,
      cumulativeAmount: '1000000'}}, deliveryProof: {bookstoreReceipt: retained, resourceUrl, responseBody: body, responseDigest: sha256(Buffer.from(body))}};
    const purchase = {requestedAction: {resourceUrl, bookstoreOrder: order, orderRequestBody: rawOrder, payloadDigest: sha256(Buffer.from(rawOrder))}};
    if (mutation === 'orderBytes') purchase.requestedAction.orderRequestBody += ' ';
    const payment = {verified: true, reservationBlockTime: now - 10, lockBlockTime: now + 10};
    const check = () => verifyReceipt(record, action, purchase, payment, binding);
    if (mutation === 'none') assert.equal((await check()).ok, true);
    else await assert.rejects(check());
  });
});

test('retained copycat session and signatures must agree with the complete enumeration', async t => {
  const {deriveSessionPda} = await import('@dexterai/vault');
  const vault = Keypair.generate().publicKey.toBase58(), impostor = Keypair.generate().publicKey.toBase58();
  const sessionAddress = deriveSessionPda(new PublicKey(vault), new PublicKey(impostor))[0].toBase58();
  for (const mutation of ['none', 'session', 'signature', 'err', 'duplicate', 'account']) await t.test(mutation, async () => {
    const retained = {impostor, sessionAddress, signatures: [{signature: 'recorded-failure', err: true}], accountExists: false, slot: 100};
    if (mutation === 'session') retained.sessionAddress = Keypair.generate().publicKey.toBase58();
    if (mutation === 'signature') retained.signatures[0].signature = 'absent-from-node';
    if (mutation === 'err') retained.signatures[0].err = false;
    if (mutation === 'duplicate') retained.signatures.push({...retained.signatures[0]});
    if (mutation === 'account') retained.accountExists = true;
    let page = 0;
    const connection = {getSignaturesForAddress: async () => page++ === 0
      ? [{signature: 'newer-failure', err: {InstructionError: [1, {Custom: 3012}]}}, {signature: 'recorded-failure', err: 'failed'}] : [],
      getAccountInfo: async () => null};
    const check = () => verifyCopycatHistory(connection, vault, impostor, retained);
    if (mutation === 'none') assert.equal((await check()).failedSignatures, 2);
    else await assert.rejects(check(), /Retained copycat history differs/);
  });
});

test('actual case-three clone approval, payments, receipts and refusals verify from archived signed messages', async t => {
  const {readFile} = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/case-three-clone-run-9.json', import.meta.url), 'utf8'));
  const {archivedConnection} = await import('./fixtures/archived-transactions.mjs');
  const {verifyApproval, verifyPurchase, verifyRedirect, verifyLimitRefusal} = await import('./verify.mjs');
  const record = fixture.record, connection = archivedConnection(fixture);
  assert.equal(fixture.provenance.softwarePasskey, true);
  assert.equal(fixture.provenance.sellerBindingCommitted, false);
  assert.equal(fixture.provenance.screenRendered, false);
  const approval = await verifyApproval(connection, record);
  assert.equal(approval.verified, true);
  assert.equal(approval.slot, 57);
  // This software-passkey approval supplies no seller commitment or claim about a rendered approval screen.
  await assert.rejects(verifySellerRecord(record, approval));
  const payments = [];
  for (const [index, purchase] of record.manifest.purchases.entries()) await t.test(`purchase ${index + 1} and receipt`, async () => {
    payments[index] = await verifyPurchase(connection, record, record.actions[index], purchase, approval);
    assert.equal(payments[index].verified, true);
    assert.equal((await verifyReceipt(record, record.actions[index], purchase, payments[index], fixture.receiptKey)).ok, true);
  });
  for (const refusal of record.redirectRefusals) await t.test(`redirect ${refusal.error.code}`, async () => {
    assert.equal(await verifyRedirect(connection, record, refusal, payments, approval), refusal.programLog);
  });
  await t.test('3012 voucher binds the attempted increment after prior verified locks', async () => {
    const refusal = structuredClone(record.redirectRefusals[0]);
    assert.equal(refusal.agentRequest.cumulativeAmount, '3000000');
    assert.equal(refusal.attemptedAmountAtomic, '1000000');
    refusal.agentRequest.cumulativeAmount = '1000000';
    await assert.rejects(verifyRedirect(connection, record, refusal, payments, approval), /matching copycat voucher/);
  });
  await t.test('a redirect with another Swig fails despite the same signed transaction', async () => {
    const other = structuredClone(record);
    other.manifest.account.swig = Keypair.generate().publicKey.toBase58();
    await assert.rejects(verifyRedirect(connection, other, other.redirectRefusals[1], payments, approval), /different vault Swig/);
  });
  await t.test('6013 proves the signed refusal and exact program log', async () => {
    const refusal = record.refusals.find(row => row.error.code === 6013);
    assert.equal(await verifyLimitRefusal(connection, record, refusal, payments, approval), refusal.programLog);
  });
  await t.test('6009 proves a program refusal but fails one-ledger history after the clone restart', async () => {
    const refusal = record.refusals.find(row => row.error.code === 6009);
    assert.equal(refusal.slot, 8);
    await assert.rejects(verifyLimitRefusal(connection, record, refusal, payments, approval), /wrong time/);
    const sdk = await import('@dexterai/vault/mandate');
    const {verifySolanaEd25519Strict} = await import('@dexterai/vault/precompile');
    const tx = await connection.getTransaction(refusal.signature);
    const decoded = sdk.verifyCaseFailedTransaction(tx, refusal.signature, {
      program: refusal.program, code: 6009, attempt: {instruction: 'settle_voucher', vault: record.manifest.account.vault,
        counterparty: record.manifest.permission.seller, authority: payments[0].dexterAuthority,
        amount: BigInt(refusal.attemptedAmountAtomic)}});
    const request = refusal.agentRequest, publicKey = new PublicKey(record.manifest.permission.executionKey).toBytes();
    const message = Buffer.from(request.message, 'hex'), signature = Buffer.from(request.sessionSignature, 'hex');
    sdk.verifyCaseVoucherInstruction(decoded.top[decoded.failedInstructionIndex - 1], {key: publicKey, signature, message});
    const {contextBoundVoucherV2Message} = await import('@dexterai/vault/messages');
    const expected = contextBoundVoucherV2Message({programId: new PublicKey(refusal.program), vaultPda: new PublicKey(record.manifest.account.vault),
      sessionPda: new PublicKey(record.manifest.permission.sessionAddress), seller: new PublicKey(record.manifest.permission.seller),
      sessionNonce: record.manifest.permission.nonce, channelId: Buffer.from(request.voucher.channelId, 'hex'),
      cumulativeAmount: BigInt(request.voucher.cumulativeAmount), sequenceNumber: request.voucher.sequenceNumber});
    assert.deepEqual(message, Buffer.from(expected));
    assert.equal(verifySolanaEd25519Strict(message, signature, publicKey), true);
    assert.equal(requireProgramLog(tx, refusal), refusal.programLog);
    assert.ok(decoded.blockTime > record.manifest.permission.expiresAtUnix);
  });
});
