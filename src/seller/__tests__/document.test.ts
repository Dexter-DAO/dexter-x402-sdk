import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { canonicalBytes } from '../jcs';
import { encodeBase64url } from '../encoding';
import { addressListSha256, addressProofMessage, parseSellerDocument, profileForHost, verifyAddressProofs } from '../document';
import { SOLANA_MAINNET, USDC_MINT } from '../types';

const did = 'did:web:dexter.cash';
const seed = new Uint8Array(32).fill(7);
function fixture() {
  const address = bs58.encode(ed25519.getPublicKey(seed));
  const entry = { address, asset: USDC_MINT, network: SOLANA_MAINNET };
  const proof = encodeBase64url(ed25519.sign(addressProofMessage({ ...entry, did }), seed));
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
    id: did, assertionMethod: [did + '#books-quote-1'],
    verificationMethod: [{ id: did + '#books-quote-1', controller: did, type: 'JsonWebKey2020',
      publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: encodeBase64url(ed25519.getPublicKey(new Uint8Array(32).fill(8))) } }],
    service: [{ id: did + '#seller-books', type: 'DexterSellerProfile', serviceEndpoint: {
      v: 'dexter-seller-profile/v1', name: 'Dexter Bookstore', hosts: ['books.dexter.cash'],
      signingKeys: [did + '#books-quote-1'], payTo: [{ ...entry, proof }],
    } }],
  };
}
function parse(doc = fixture()) { return parseSellerDocument(canonicalBytes(doc), did); }
describe('seller document', () => {
  it('parses the exact store shape and verifies address control', () => {
    const parsed = parse(); if (typeof parsed === 'string') throw new Error(parsed);
    expect(parsed.doc.id).toBe(did);
    expect(profileForHost(parsed, 'books.dexter.cash')).toEqual(fixture().service[0].serviceEndpoint);
    expect(verifyAddressProofs(parsed.profiles[0], did)).toBe(true);
    expect(verifyAddressProofs(parsed.profiles[0], 'did:web:other.cash')).toBe(false);
    expect(profileForHost(parsed, 'other.dexter.cash')).toBe('host_not_listed');
  });
  it('refuses an id for another DID and a key that is not 32 bytes', () => {
    const wrong = fixture(); wrong.id = 'did:web:other.cash'; expect(parse(wrong)).toBe('did_document_invalid');
    const short = fixture(); short.verificationMethod[0].publicKeyJwk.x = 'AA'; expect(parse(short)).toBe('key_invalid');
  });
  it('refuses nonregistrable DID, malformed JSON, invalid UTF-8 and oversized files', () => {
    expect(parseSellerDocument(canonicalBytes(fixture()), 'did:web:books.dexter.cash')).toBe('did_document_invalid');
    for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode('{'), new Uint8Array(65_537)]) {
      expect(parseSellerDocument(bytes, did)).toBe('did_document_invalid');
    }
  });
  it('refuses malformed methods and ambiguous identifiers', () => {
    for (const mutate of [
      (d: ReturnType<typeof fixture>) => { d.verificationMethod[0].controller = 'did:web:other.cash'; },
      (d: ReturnType<typeof fixture>) => { d.verificationMethod[0].type = 'Other'; },
      (d: ReturnType<typeof fixture>) => { d.verificationMethod.push(d.verificationMethod[0]); },
      (d: ReturnType<typeof fixture>) => { d.assertionMethod = [{} as string]; },
      (d: ReturnType<typeof fixture>) => { d.service.push(d.service[0]); },
    ]) { const d = fixture(); mutate(d); expect(parse(d)).toBe('did_document_invalid'); }
    const extra = fixture(); Object.assign(extra.verificationMethod[0].publicKeyJwk, { d: 'private' }); expect(parse(extra)).toBe('key_invalid');
  });
  it('enforces every profile bound and registrable-domain host restriction', () => {
    const invalid = [
      { v: 'v2' }, { name: '' }, { name: 'a'.repeat(65) }, { name: 'Cyrillic е' },
      { hosts: [] }, { hosts: ['evil.cash'] }, { hosts: ['BOOKS.dexter.cash'] },
      { hosts: ['books.dexter.cash.'] }, { hosts: ['books.dexter.cash/path'] },
      { hosts: Array.from({ length: 33 }, (_, i) => `h${i}.dexter.cash`) },
      { signingKeys: [] }, { signingKeys: ['did:key:a#b'] }, { signingKeys: ['did:web:other.cash#a'] },
      { signingKeys: Array.from({ length: 9 }, (_, i) => `${did}#key${i}`) },
      { payTo: [] }, { payTo: Array(17).fill(fixture().service[0].serviceEndpoint.payTo[0]) },
    ];
    for (const fields of invalid) {
      const d = fixture(); Object.assign(d.service[0].serviceEndpoint, fields);
      // JSON input may contain Unicode; document validation owns that check.
      expect(parseSellerDocument(new TextEncoder().encode(JSON.stringify(d)), did), JSON.stringify(fields)).toBe('did_document_invalid');
    }
  });
  it('refuses malformed address fields and proofs', () => {
    for (const fields of [{ network: 'solana' }, { asset: 'AA' }, { address: 'invalid0' }, { proof: 'AA' }, { proof: 'a='.repeat(32) }]) {
      const d = fixture(); Object.assign(d.service[0].serviceEndpoint.payTo[0], fields); expect(parse(d)).toBe('did_document_invalid');
    }
  });
  it('refuses ambiguous host coverage across distinct profiles', () => {
    const d = fixture(); d.service.push({ ...d.service[0], id: did + '#second' });
    const parsed = parse(d); if (typeof parsed === 'string') throw new Error(parsed);
    expect(profileForHost(parsed, 'books.dexter.cash')).toBe('did_document_invalid');
  });
  it('verifyAddressProofs refuses one forged entry even when another is valid', () => {
    const profile = fixture().service[0].serviceEndpoint;
    const forged = { ...profile.payTo[0], proof: encodeBase64url(new Uint8Array(64)) };
    profile.payTo.push(forged);
    expect(verifyAddressProofs(profile as Parameters<typeof verifyAddressProofs>[0], did)).toBe(false);
  });
  it('hashes addresses sorted by network, asset, address while omitting proofs', () => {
    const a = fixture().service[0].serviceEndpoint.payTo[0];
    const b = { ...a, address: bs58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(9))) };
    const sorted = [a, b].map(({ network, asset, address }) => ({ network, asset, address })).sort((x, y) => x.address < y.address ? -1 : 1);
    const expected = createHash('sha256').update(canonicalBytes(sorted)).digest('hex');
    expect(addressListSha256([b, a])).toBe(expected);
    expect(addressListSha256([a, { ...b, proof: 'changed' }])).toBe(expected);
  });
});
