import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: { origin: { type: 'string' }, checker: { type: 'string' },
  'real-document': { type: 'string' }, live: { type: 'boolean' } } });
if (!values.origin || !values.checker || (!values.live && !values['real-document'])) {
  throw new Error('provide --origin, --checker and either --real-document or --live');
}
const { checkSellerOffer, screenSeller, sellerOfferFromPaymentRequired, canonicalBytes, decodeCompactJws,
  SOLANA_MAINNET, USDC_MINT, jwkThumbprint, addressListSha256 } = await import(pathToFileURL(values.checker));
const origin = values.origin.replace(/\/$/, '');
const docResponse = await fetch(`${origin}/.well-known/did.json`);
assert.equal(docResponse.status, 200);
assert.match(docResponse.headers.get('content-type'), /^application\/did\+json/);
assert.equal(docResponse.headers.get('cache-control'), 'no-store');
assert.equal(docResponse.headers.get('access-control-allow-origin'), '*');
const ownBytes = new Uint8Array(await docResponse.arrayBuffer());
const own = JSON.parse(new TextDecoder().decode(ownBytes));
assert.deepEqual(ownBytes, canonicalBytes(own));
const impostor = own.service[0].serviceEndpoint.payTo[0].address;
const realBytes = values.live ? new Uint8Array(await (await fetch('https://dexter.cash/.well-known/did.json')).arrayBuffer())
  : new Uint8Array(await readFile(values['real-document']));
const real = JSON.parse(new TextDecoder().decode(realBytes));
const realProfile = real.service.find(s => s.serviceEndpoint?.hosts?.includes('books.dexter.cash')).serviceEndpoint;
const fetchDidDocument = async url => {
  if (url === 'https://dexter-bookstore.pages.dev/.well-known/did.json') return ownBytes;
  if (url === 'https://dexter.cash/.well-known/did.json') return realBytes;
  throw new Error(`unexpected document ${url}`);
};
const base = { counterparty: impostor, appName: 'Dexter Bookstore', scheme: 'tab', network: SOLANA_MAINNET, asset: USDC_MINT };
const screenInput = request => ({ request, sessionPubkey: impostor, known: [], agentKeys: [], history: 'loaded' });
const known = [{ host: 'books.dexter.cash', registrableDomain: 'dexter.cash', did: real.id,
  kid: real.assertionMethod[0], key: real.verificationMethod[0].publicKeyJwk,
  keyThumbprint: jwkThumbprint(real.verificationMethod[0].publicKeyJwk),
  didDocumentSha256: createHash('sha256').update(realBytes).digest('hex'), bindingSha256: '00'.repeat(32),
  addresses: realProfile.payTo.map(p => p.address), addressListSha256: addressListSha256(realProfile.payTo),
  label: realProfile.name, firstApprovedAt: 1, lastApprovedAt: 1, lastRegisterTx: 'local-screen-fixture' }];
let checks = 0;
function expectCheck(label, check, status, code) {
  assert.equal(check.status, status, label);
  if (code) assert.equal(check.refusal?.code, code, label);
  console.log(`${label}: ${status}${code ? ` ${check.refusal.rule} ${code}` : ''}`);
  checks++;
}
for (const slug of ['wealth-of-nations', 'meditations', 'art-of-war', 'the-prince', 'the-innovators-dilemma', 'the-sovereign-individual']) {
  for (const [variant, prefix] of [['V1', ''], ['V2', '/v2'], ['V4', '/v4']]) {
    const response = await fetch(`${origin}${prefix}/books/${slug}`);
    assert.equal(response.status, 402);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const body = await response.json();
    assert.deepEqual(JSON.parse(Buffer.from(response.headers.get('payment-required'), 'base64').toString()), body);
    assert.equal(body.accepts[0].payTo, impostor);
    assert.equal(body.accepts[0].amount, '1000000');
    const offer = sellerOfferFromPaymentRequired(body, body.accepts[0]);
    const request = { ...base, seller: { calledUrl: body.resource.url, ...(offer ? { offer } : {}) } };
    const now = Math.floor(Date.now() / 1000);
    const check = await checkSellerOffer(request, { now, fetchDidDocument });
    expectCheck(`${variant}/${slug}`, check, variant === 'V1' ? 'signed' : variant === 'V2' ? 'refused' : 'unsigned',
      variant === 'V2' ? 'kid_not_listed' : undefined);
    if (variant === 'V1' || variant === 'V4') {
      const screen = screenSeller(check, { ...screenInput(request), known });
      assert.equal(screen.approve, 'confirm');
      assert.ok(screen.notices.some(n => n.rule === 'R4' && n.knownHost === 'books.dexter.cash'));
    }
    if (variant === 'V4') assert.equal(body.extensions, undefined);
    else {
      const jws = decodeCompactJws(offer.signature);
      assert.deepEqual(Buffer.from(jws.payloadBytes ?? Buffer.from(offer.signature.split('.')[1], 'base64url')),
        Buffer.from(canonicalBytes(jws.payload)));
      assert.ok(jws.payload.validUntil >= now + 598 && jws.payload.validUntil <= now + 600);
      assert.equal(Object.keys(jws.payload).length, 8);
    }
    if (variant === 'V1') {
      const screen = screenSeller(check, screenInput(request));
      assert.equal(screen.approve, 'allowed');
      assert.equal(screen.seller.host, 'dexter-bookstore.pages.dev');
      assert.equal(screen.seller.relation, 'first-payment');
      expectCheck(`changed-counterparty/${slug}`, await checkSellerOffer({ ...request,
        counterparty: realProfile.payTo[0].address }, { fetchDidDocument }), 'refused', 'payto_mismatch');
      expectCheck(`changed-book/${slug}`, await checkSellerOffer({ ...request, seller: { ...request.seller,
        calledUrl: 'https://dexter-bookstore.pages.dev/books/other-book' } }, { fetchDidDocument }), 'refused', 'resource_url_mismatch');
    }
  }
}
const v5 = { ...base, seller: { calledUrl: 'https://books.dexter.cash/books/the-innovators-dilemma' } };
const v5check = await checkSellerOffer(v5);
expectCheck('V5', v5check, 'unsigned');
const v5screen = screenSeller(v5check, { ...screenInput(v5), known });
assert.equal(v5screen.seller.kind, 'address');
assert.equal(v5screen.seller.host, undefined);
assert.equal(v5screen.approve, 'confirm');
assert.ok(v5screen.notices.some(n => n.rule === 'R5' && n.code === 'unsigned_known_host'));
for (const prefix of ['', '/v2', '/v4']) {
  assert.equal((await fetch(`${origin}${prefix}/books/unknown`)).status, 404);
  assert.equal((await fetch(`${origin}${prefix}/books/meditations`, { method: 'POST' })).status, 405);
}
if (values.live) {
  const response = await fetch('https://books.dexter.cash/books/the-innovators-dilemma');
  assert.equal(response.status, 402);
  const body = await response.json();
  const offer = sellerOfferFromPaymentRequired(body, body.accepts[0]);
  assert.ok(offer);
  expectCheck('V3/real-quote', await checkSellerOffer({ ...base,
    seller: { calledUrl: body.resource.url, offer } }, { fetchDidDocument }), 'refused', 'payto_mismatch');
} else console.log('V3/real-quote: NOT RUN, requires deployed W2 signed quote');
console.log(`${checks} seller decisions passed; headers, signed terms, empty-history and known-seller screen decisions and GET-only routes passed.`);
