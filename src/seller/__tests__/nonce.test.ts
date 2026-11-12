import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { newSellerBindingSalt, sellerBindingNonce } from '../nonce';
import { SELLER_BINDING_DOMAIN } from '../types';

describe('seller binding nonce', () => {
  it('matches the fixed SHA-256 commitment vector', () => {
    // Independently calculated with Python hashlib, literal domain is 24 bytes.
    // binding hex: 7b2276223a226465787465722d73656c6c65722d62696e64696e672f7631227d
    // salt hex: 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
    // SHA256(binding): e66252ec1f1a9d957c23bded2a642cb1a64b0292fd700b6b1ae0614ae45dcf3b
    const binding = new TextEncoder().encode('{"v":"dexter-seller-binding/v1"}');
    const salt = Uint8Array.from({ length: 32 }, (_, index) => index);
    expect(new TextEncoder().encode(SELLER_BINDING_DOMAIN).length).toBe(24);
    expect(bytesToHex(sellerBindingNonce(binding, salt)))
      .toBe('b18099f623b777f97950549b3c184f31e2d7dc168a3b8bf22b4eaf1459ef8297');
    expect(sellerBindingNonce(new Uint8Array([...binding, 32]), salt)).not.toEqual(sellerBindingNonce(binding, salt));
    expect(sellerBindingNonce(binding, new Uint8Array(32))).not.toEqual(sellerBindingNonce(binding, salt));
  });

  it('rejects every salt length other than 32', () => {
    for (const size of [0, 16, 31, 33, 64]) {
      expect(() => sellerBindingNonce(new Uint8Array(), new Uint8Array(size))).toThrow('seller_binding_salt_invalid');
    }
  });

  it('creates a fresh 32-byte cryptographic salt', () => {
    const first = newSellerBindingSalt();
    const second = newSellerBindingSalt();
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first.length).toBe(32);
    expect(second.length).toBe(32);
    expect(first).not.toEqual(second);
  });
});
