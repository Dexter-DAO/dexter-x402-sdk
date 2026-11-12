#!/usr/bin/env node
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import {
  canonicalBytes, parseSellerDocument, verifyAddressProofs, addressProofMessage,
  SELLER_PROFILE_TYPE, SELLER_PROFILE_VERSION, SOLANA_MAINNET, USDC_MINT,
} from '../dist/seller/index.js';

function required(options, name) {
  if (typeof options[name] !== 'string' || !options[name]) throw new Error(`missing --${name}`);
  return options[name];
}
function quoteFormat(options) {
  const format = required(options, 'quote-format');
  if (!['pkcs8-b64', 'jwk'].includes(format)) throw new Error('invalid --quote-format');
  return format;
}
function exclusiveWrite(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
}
function publicX(key) { return createPublicKey(key).export({ format: 'jwk' }).x; }

export function runIdentity(argv) {
  const [command, ...args] = argv;
  if (command === 'keys') {
    const { values } = parseArgs({ args, options: {
      'receiving-out': { type: 'string' }, 'quote-out': { type: 'string' }, 'quote-format': { type: 'string' },
    } });
    const receivingPath = required(values, 'receiving-out');
    const quotePath = required(values, 'quote-out');
    const format = quoteFormat(values);
    // Reserve both destinations before generating secrets; remove only files this invocation created on failure.
    const opened = [];
    try {
      for (const path of [receivingPath, quotePath]) opened.push({ path, fd: openSync(path, 'wx', 0o600) });
      const seed = randomBytes(32);
      const receivingPublic = ed25519.getPublicKey(seed);
      const receiving = new Uint8Array([...seed, ...receivingPublic]);
      const { privateKey } = generateKeyPairSync('ed25519');
      const x = publicX(privateKey);
      writeFileSync(opened[0].fd, JSON.stringify(Array.from(receiving)));
      writeFileSync(opened[1].fd, format === 'jwk' ? JSON.stringify(privateKey.export({ format: 'jwk' })) :
        privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
      seed.fill(0); receiving.fill(0);
      return { receivingAddress: bs58.encode(receivingPublic), quotePublicX: x };
    } catch (error) {
      for (const entry of opened) unlinkSync(entry.path);
      throw error;
    } finally { for (const entry of opened) closeSync(entry.fd); }
  }
  if (command === 'document') {
    const { values } = parseArgs({ args, options: {
      did: { type: 'string' }, host: { type: 'string', multiple: true }, name: { type: 'string' },
      'receiving-key': { type: 'string' }, 'quote-key': { type: 'string' }, 'quote-format': { type: 'string' },
      kid: { type: 'string' }, out: { type: 'string' },
    } });
    const did = required(values, 'did');
    const fragment = required(values, 'kid');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(fragment)) throw new Error('invalid --kid fragment');
    const kid = `${did}#${fragment}`;
    const name = required(values, 'name');
    const out = required(values, 'out');
    const receivingJson = JSON.parse(readFileSync(required(values, 'receiving-key'), 'utf8'));
    if (!Array.isArray(receivingJson) || receivingJson.length !== 64 ||
        !receivingJson.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('invalid receiving key');
    const receiving = Uint8Array.from(receivingJson);
    const receivingPublic = ed25519.getPublicKey(receiving.subarray(0, 32));
    if (!receivingPublic.every((byte, index) => byte === receiving[index + 32])) throw new Error('invalid receiving key');
    const address = bs58.encode(receivingPublic);
    const quoteText = readFileSync(required(values, 'quote-key'), 'utf8').trim();
    const quoteKey = quoteFormat(values) === 'jwk' ? createPrivateKey({ key: JSON.parse(quoteText), format: 'jwk' }) :
      createPrivateKey({ key: Buffer.from(quoteText, 'base64'), format: 'der', type: 'pkcs8' });
    if (quoteKey.asymmetricKeyType !== 'ed25519') throw new Error('invalid quote key');
    const quotePublicX = publicX(quoteKey);
    const receivingKey = createPrivateKey({ format: 'jwk', key: {
      kty: 'OKP', crv: 'Ed25519', x: Buffer.from(receivingPublic).toString('base64url'),
      d: Buffer.from(receiving.subarray(0, 32)).toString('base64url'),
    } });
    const entry = { address, asset: USDC_MINT, network: SOLANA_MAINNET };
    const proof = sign(null, addressProofMessage({ ...entry, did }), receivingKey).toString('base64url');
    const doc = {
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
      assertionMethod: [kid], id: did,
      service: [{ id: `${did}#seller-books`, type: SELLER_PROFILE_TYPE, serviceEndpoint: {
        v: SELLER_PROFILE_VERSION, name, hosts: values.host ?? [], signingKeys: [kid], payTo: [{ ...entry, proof }],
      } }],
      verificationMethod: [{ controller: did, id: kid, type: 'JsonWebKey2020',
        publicKeyJwk: { crv: 'Ed25519', kty: 'OKP', x: quotePublicX } }],
    };
    const bytes = canonicalBytes(doc);
    const parsed = parseSellerDocument(bytes, did);
    if (typeof parsed === 'string' || !parsed.profiles.every((profile) => verifyAddressProofs(profile, did))) {
      throw new Error(typeof parsed === 'string' ? parsed : 'address_proof_invalid');
    }
    receiving.fill(0);
    exclusiveWrite(out, bytes);
    return { path: out, sha256: createHash('sha256').update(bytes).digest('hex'), receivingAddress: address, quotePublicX };
  }
  throw new Error('usage: seller-identity.mjs keys|document [options]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(runIdentity(process.argv.slice(2)))); }
  catch (error) {
    // Key parsing exceptions may include input details. Keep diagnostics bounded to known CLI errors.
    const message = error?.code === 'EEXIST' ? 'output_exists' :
      /^(missing --|invalid --|invalid receiving key$|invalid quote key$|did_document_invalid$|key_invalid$|address_proof_invalid$|usage:)/.test(error?.message ?? '') ? error.message : 'seller_identity_failed';
    console.error(message); process.exitCode = 1;
  }
}
