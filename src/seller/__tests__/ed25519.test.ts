import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { verifyEd25519Strict } from '../ed25519';
// RFC 8032 section 7.1, tests 1, 2 and 3.
const vectors = [
  ['d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '', 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'],
  ['3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72', '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'],
  ['fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025', 'af82', '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'],
];
describe('strict Ed25519', () => {
  it.each(vectors)('accepts RFC 8032 vector %s', (key, message, signature) => {
    expect(verifyEd25519Strict(hexToBytes(signature), hexToBytes(message), hexToBytes(key))).toBe(true);
  });
  it('rejects changed messages and noncanonical S plus the group order', () => {
    const [key, message, signature] = vectors[0];
    const sig = hexToBytes(signature);
    const order = (1n << 252n) + 27742317777372353535851937790883648493n;
    let s = BigInt('0x' + Array.from(sig.slice(32)).reverse().map((b) => b.toString(16).padStart(2, '0')).join('')) + order;
    for (let i = 32; i < 64; i++) { sig[i] = Number(s & 255n); s >>= 8n; }
    expect(verifyEd25519Strict(sig, hexToBytes(message), hexToBytes(key))).toBe(false);
    expect(verifyEd25519Strict(hexToBytes(signature), new Uint8Array([1]), hexToBytes(key))).toBe(false);
  });
  it('rejects small-order and noncanonical keys, malformed lengths and noncanonical R', () => {
    const sig = new Uint8Array(64); sig[0] = 1;
    const identity = new Uint8Array(32); identity[0] = 1;
    expect(verifyEd25519Strict(sig, new Uint8Array(), identity)).toBe(false);
    const noncanonical = hexToBytes('eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f');
    expect(verifyEd25519Strict(sig, new Uint8Array(), noncanonical)).toBe(false);
    expect(verifyEd25519Strict(sig.slice(1), new Uint8Array(), identity)).toBe(false);
    const changedR = hexToBytes(vectors[0][2]); changedR.set(noncanonical);
    expect(verifyEd25519Strict(changedR, new Uint8Array(), hexToBytes(vectors[0][0]))).toBe(false);
  });
});
