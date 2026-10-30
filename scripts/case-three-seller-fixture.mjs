import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { SOLANA_MAINNET, USDC_MINT, addressProofMessage, canonicalBytes } from '@dexterai/x402/seller';

const now = Math.floor(Date.now() / 1000);
const realUrl = 'https://books.dexter.cash/books/the-innovators-dilemma';
const fakeBase = 'https://dexter-bookstore.pages.dev';
const fakeUrl = `${fakeBase}/books/the-innovators-dilemma`;
const fileUrl = 'https://dexter.cash/.well-known/did.json';
const fakeFileUrl = `${fakeBase}/.well-known/did.json`;
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const realKey = Keypair.generate(), fakeKey = Keypair.generate();
const payee = Keypair.generate(), impostor = Keypair.generate();

function signed(payload, key, kid) {
  const prefix = `${b64(Buffer.from(JSON.stringify({ alg: 'EdDSA', kid })))}.${b64(canonicalBytes(payload))}`;
  return `${prefix}.${b64(ed25519.sign(Buffer.from(prefix), key.secretKey.subarray(0, 32)))}`;
}
function document(domain, host, key, seller) {
  const did = `did:web:${domain}`, kid = `${did}#books-quote-1`;
  const address = seller.publicKey.toBase58();
  const entry = { address, asset: USDC_MINT, network: SOLANA_MAINNET };
  return canonicalBytes({ '@context': ['https://www.w3.org/ns/did/v1'], id: did, assertionMethod: [kid],
    verificationMethod: [{ id: kid, controller: did, type: 'JsonWebKey2020', publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: b64(key.publicKey.toBytes()) } }],
    service: [{ id: `${did}#seller-books`, type: 'DexterSellerProfile', serviceEndpoint: { v: 'dexter-seller-profile/v1', name: 'Dexter Bookstore',
      hosts: [host], signingKeys: [kid], payTo: [{ ...entry, proof: b64(ed25519.sign(addressProofMessage({ ...entry, did }), seller.secretKey.subarray(0, 32))) }] } }] });
}
const realFile = document('dexter.cash', 'books.dexter.cash', realKey, payee);
const fakeFile = document('dexter-bookstore.pages.dev', 'dexter-bookstore.pages.dev', fakeKey, impostor);
function quote(url, key, kid, seller) {
  const accept = { scheme: 'tab', network: SOLANA_MAINNET, asset: USDC_MINT, payTo: seller.publicKey.toBase58(), amount: '1000000' };
  const signature = signed({ ...accept, version: 1, resourceUrl: url, validUntil: now + 600 }, key, kid);
  return { x402Version: 2, resource: { url }, accepts: [{ ...accept, maxTimeoutSeconds: 1800 }], extensions: { 'offer-receipt': { info: { offers: [{ format: 'jws', signature }] } } } };
}
const realQuote = quote(realUrl, realKey, 'did:web:dexter.cash#books-quote-1', payee);
const copyQuote = quote(fakeUrl, fakeKey, 'did:web:dexter-bookstore.pages.dev#books-quote-1', impostor);
const v2Quote = quote(realUrl, fakeKey, 'did:web:dexter.cash#books-quote-impostor', impostor);
const files = { [fileUrl]: realFile, [fakeFileUrl]: fakeFile };
const fetchDidDocument = async url => { assert.ok(files[url], `Unexpected document ${url}`); return files[url]; };
const fetcher = async url => {
  const body = url === realUrl ? realQuote : url === fakeUrl ? copyQuote : url.includes('/v2/') ? v2Quote : { accepts: copyQuote.accepts };
  return new Response(JSON.stringify(body), { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(body)).toString('base64') } });
};

export { now, realUrl, fakeBase, fakeUrl, fileUrl, fakeFileUrl, b64, realKey, fakeKey, payee, impostor, signed, document, quote, realFile, fakeFile, realQuote, copyQuote, v2Quote, files, fetchDidDocument, fetcher };
