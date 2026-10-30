import { describe, expect, it } from 'vitest';
import { checkSellerOffer } from '../check';
import { jwkThumbprint } from '../jwk';
import type { KnownSeller, SellerCheck } from '../types';
import {
  IMPOSTOR, IMPOSTOR_FILE_URL, NOW, REAL, REAL_FILE_URL, keyFrom, offerPayload, quote, request, servedFiles, storeDocument,
} from './sellerFixtures';

const realFiles = () => servedFiles({ [REAL_FILE_URL]: storeDocument(REAL) });
const run = (req = request(), fetchDidDocument = realFiles(), known: KnownSeller[] = []) =>
  checkSellerOffer(req, { now: NOW, fetchDidDocument, known });
const code = (check: SellerCheck) => (check.status === 'refused' ? `${check.refusal.rule}:${check.refusal.code}` : check.status);

function knownReal(overrides: Partial<KnownSeller> = {}): KnownSeller {
  const key = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: REAL.quoteKey.x };
  return {
    host: 'books.dexter.cash', registrableDomain: 'dexter.cash', did: 'did:web:dexter.cash', kid: 'did:web:dexter.cash#books-quote-1',
    key, keyThumbprint: jwkThumbprint(key), didDocumentSha256: 'ab'.repeat(32),
    addresses: [REAL.receiving[0].address], addressListSha256: 'cd'.repeat(32), label: 'Dexter Bookstore',
    firstApprovedAt: NOW - 3600, lastApprovedAt: NOW - 3600, lastRegisterTx: 'tx1', ...overrides,
  };
}

describe('checkSellerOffer: signed', () => {
  it('accepts the dexter.cash file and a fresh books.dexter.cash quote', async () => {
    const files = realFiles();
    const check = await run(request(), files);
    expect(check.status).toBe('signed');
    if (check.status !== 'signed') return;
    expect(files.calls).toEqual([REAL_FILE_URL]);
    expect(check).toMatchObject({
      source: 'live', host: 'books.dexter.cash', registrableDomain: 'dexter.cash', did: 'did:web:dexter.cash',
      kid: 'did:web:dexter.cash#books-quote-1', addresses: [REAL.receiving[0].address],
    });
    expect(check.profile?.name).toBe('Dexter Bookstore');
  });
});

describe('checkSellerOffer: R1', () => {
  it('refuses a quote signed by a key the file does not list', async () => {
    const offer = quote({ kid: 'did:web:dexter.cash#books-quote-impostor', secret: IMPOSTOR.quoteKey.secret, payload: offerPayload({ payTo: IMPOSTOR.receiving[0].address }) });
    expect(code(await run(request({ offerJws: offer, counterparty: IMPOSTOR.receiving[0].address })))).toBe('R1:kid_not_listed');
  });
  it('refuses a quote whose signature does not verify under the listed key', async () => {
    expect(code(await run(request({ offerJws: quote({ secret: keyFrom(99).secret }) })))).toBe('R1:signature_invalid');
  });
  it('refuses did:key, did:jwk and did:pkh kids', async () => {
    for (const kid of ['did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', 'did:jwk:eyJrdHkiOiJPS1AifQ#0', 'did:pkh:solana:abc#key']) {
      expect(code(await run(request({ offerJws: quote({ kid }) })))).toBe('R1:did_method_unsupported');
    }
  });
  it('refuses a kid without a fragment', async () => {
    expect(code(await run(request({ offerJws: quote({ kid: 'did:web:dexter.cash' }) })))).toBe('R1:kid_not_did_url');
  });
  it('refuses a kid whose DID is the subdomain, not the registrable domain', async () => {
    expect(code(await run(request({ offerJws: quote({ kid: 'did:web:books.dexter.cash#books-quote-1' }) })))).toBe('R1:did_not_registrable_domain');
  });
  it('refuses when the called host differs from the quote host (relay)', async () => {
    expect(code(await run(request({ calledUrl: 'https://relay.example.com/books/meditations' })))).toBe('R1:resource_host_mismatch');
  });
  it('refuses http, ports, credentials, IP and localhost URLs', async () => {
    for (const calledUrl of ['http://books.dexter.cash/x', 'https://books.dexter.cash:443/x', 'https://books.dexter.cash:8443/x',
      'https://u:p@books.dexter.cash/x', 'https://1.2.3.4/x', 'https://localhost/x']) {
      expect(code(await run(request({ calledUrl })))).toBe('R1:called_url_invalid');
    }
    expect(code(await run(request({ offerJws: quote({ payload: offerPayload({ resourceUrl: 'http://books.dexter.cash/books/meditations' }) }) })))).toBe('R1:resource_url_invalid');
  });
  it('refuses a host ending in a dot', async () => {
    expect(code(await run(request({ calledUrl: 'https://books.dexter.cash./books/meditations' })))).toBe('R1:called_url_invalid');
  });
  it('refuses missing, expired and over-10-minute validUntil', async () => {
    const without = offerPayload();
    delete without.validUntil;
    expect(code(await run(request({ offerJws: quote({ payload: without }) })))).toBe('R1:offer_validity_missing');
    expect(code(await run(request({ offerJws: quote({ payload: offerPayload({ validUntil: 0 }) }) })))).toBe('R1:offer_validity_missing');
    expect(code(await run(request({ offerJws: quote({ payload: offerPayload({ validUntil: NOW }) }) })))).toBe('R1:offer_expired');
    expect(code(await run(request({ offerJws: quote({ payload: offerPayload({ validUntil: NOW + 661 }) }) })))).toBe('R1:offer_validity_too_long');
    expect(code(await run(request({ offerJws: quote({ payload: offerPayload({ validUntil: NOW + 660 }) }) })))).toBe('signed');
  });
  it('refuses alg other than EdDSA and a crit header', async () => {
    expect(code(await run(request({ offerJws: quote({ header: { alg: 'ES256', kid: 'did:web:dexter.cash#books-quote-1' } }) })))).toBe('R1:offer_alg_unsupported');
    expect(code(await run(request({ offerJws: quote({ header: { alg: 'EdDSA', crit: ['b64'], kid: 'did:web:dexter.cash#books-quote-1' } }) })))).toBe('R1:offer_malformed');
  });
  it('refuses a payload with extra or missing fields', async () => {
    expect(code(await run(request({ offerJws: quote({ payload: offerPayload({ extra: 1 }) }) })))).toBe('R1:offer_malformed');
    const missing = offerPayload();
    delete missing.amount;
    expect(code(await run(request({ offerJws: quote({ payload: missing }) })))).toBe('R1:offer_malformed');
  });
  it('refuses a host the profile does not list', async () => {
    const files = servedFiles({ [REAL_FILE_URL]: storeDocument({ ...REAL, hosts: ['shop.dexter.cash'] }) });
    expect(code(await run(request(), files))).toBe('R1:host_not_listed');
  });
  it('refuses a file whose id is another DID', async () => {
    const files = servedFiles({ [REAL_FILE_URL]: storeDocument({ ...REAL, edit: (doc) => { doc.id = 'did:web:evil.example'; } }) });
    expect(code(await run(request(), files))).toBe('R1:did_document_invalid');
  });
  it('refuses a non-Tab, non-Solana or non-USDC quote', async () => {
    expect(code(await run(request({ offerJws: quote({ payload: offerPayload({ scheme: 'exact' }) }) })))).toBe('R1:offer_terms_mismatch');
  });
});

describe('checkSellerOffer: R2 and R3', () => {
  it('refuses a genuine quote presented with a different counterparty', async () => {
    expect(code(await run(request({ counterparty: IMPOSTOR.receiving[0].address })))).toBe('R2:payto_mismatch');
  });
  it('refuses a quote naming an address missing from the list', async () => {
    const other = keyFrom(7).address;
    expect(code(await run(request({ counterparty: other, offerJws: quote({ payload: offerPayload({ payTo: other }) }) })))).toBe('R2:payto_not_listed');
  });
  it('refuses a file with a forged address proof', async () => {
    const files = servedFiles({ [REAL_FILE_URL]: storeDocument({ ...REAL, receiving: [REAL.receiving[0], keyFrom(8)], forgeProofIndex: 1 }) });
    expect(code(await run(request(), files))).toBe('R2:address_proof_invalid');
  });
  it('refuses a quote whose payTo was edited inside the JWS (signature breaks first: R1)', async () => {
    const [h, , s] = quote().split('.');
    const edited = quote({ payload: offerPayload({ payTo: IMPOSTOR.receiving[0].address }) }).split('.')[1];
    expect(code(await run(request({ counterparty: IMPOSTOR.receiving[0].address, offerJws: `${h}.${edited}.${s}` })))).toBe('R1:signature_invalid');
  });
  it('refuses when expectedHost differs', async () => {
    expect(code(await run(request({ expectedHost: 'shop.dexter.cash' })))).toBe('R3:expected_host_mismatch');
    expect(code(await run(request({ expectedHost: 'books.dexter.cash' })))).toBe('signed');
  });
});

describe('checkSellerOffer: unsigned and the saved path', () => {
  it('treats a request without a quote as unsigned', async () => {
    const files = realFiles();
    const check = await run(request({ offerJws: null }), files);
    expect(check).toMatchObject({ status: 'unsigned', reason: 'no_offer', host: 'books.dexter.cash' });
    expect(files.calls).toEqual([]);
  });
  it('treats an unreadable file at first contact as unsigned', async () => {
    for (const files of [servedFiles({}), servedFiles({ [REAL_FILE_URL]: new TextEncoder().encode('<html>') })]) {
      expect(await run(request(), files)).toMatchObject({ status: 'unsigned', reason: 'did_document_unavailable' });
    }
  });
  it('checks an unreadable file for a known host against the saved key', async () => {
    const check = await run(request(), servedFiles({}), [knownReal()]);
    expect(check).toMatchObject({ status: 'signed', source: 'saved', didDocument: null, profile: null, didDocumentSha256: 'ab'.repeat(32) });
  });
  it('refuses an unreadable known host whose quote fails the saved key', async () => {
    const known = knownReal({ key: { kty: 'OKP', crv: 'Ed25519', x: keyFrom(5).x } });
    expect(code(await run(request(), servedFiles({}), [known]))).toBe('R1:signature_invalid');
  });
  it('an unreadable known host with a kid he never approved is unsigned (the screen names the store)', async () => {
    const offer = quote({ kid: 'did:web:dexter.cash#books-quote-2', secret: keyFrom(6).secret });
    expect(await run(request({ offerJws: offer }), servedFiles({}), [knownReal()])).toMatchObject({ status: 'unsigned', reason: 'did_document_unavailable' });
  });
});

describe('checkSellerOffer: copycat variants', () => {
  const both = () => servedFiles({ [REAL_FILE_URL]: storeDocument(REAL), [IMPOSTOR_FILE_URL]: storeDocument(IMPOSTOR) });
  it('V1 is signed by its own site', async () => {
    const offer = quote({ kid: 'did:web:dexter-bookstore.pages.dev#books-quote-1', secret: IMPOSTOR.quoteKey.secret,
      payload: offerPayload({ payTo: IMPOSTOR.receiving[0].address, resourceUrl: 'https://dexter-bookstore.pages.dev/books/meditations' }) });
    const check = await run(request({ counterparty: IMPOSTOR.receiving[0].address, offerJws: offer, calledUrl: 'https://dexter-bookstore.pages.dev/books/meditations' }), both());
    expect(check).toMatchObject({ status: 'signed', host: 'dexter-bookstore.pages.dev', registrableDomain: 'dexter-bookstore.pages.dev' });
  });
  it('V2 claims books.dexter.cash with its own key: R1 kid_not_listed', async () => {
    const offer = quote({ kid: 'did:web:dexter.cash#books-quote-impostor', secret: IMPOSTOR.quoteKey.secret, payload: offerPayload({ payTo: IMPOSTOR.receiving[0].address }) });
    expect(code(await run(request({ counterparty: IMPOSTOR.receiving[0].address, offerJws: offer }), both()))).toBe('R1:kid_not_listed');
  });
  it('V3 reuses the real quote with the copycat address: R2 payto_mismatch', async () => {
    expect(code(await run(request({ counterparty: IMPOSTOR.receiving[0].address }), both()))).toBe('R2:payto_mismatch');
  });
});
