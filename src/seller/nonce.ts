import { sha256 } from '@noble/hashes/sha256';
import { concatBytes } from '@noble/hashes/utils';
import { SELLER_BINDING_DOMAIN } from './types';

export function sellerBindingNonce(bindingBytes: Uint8Array, salt: Uint8Array): Uint8Array {
  if (!(salt instanceof Uint8Array) || salt.length !== 32) throw new Error('seller_binding_salt_invalid');
  return sha256(concatBytes(new TextEncoder().encode(SELLER_BINDING_DOMAIN), sha256(bindingBytes), salt));
}

export function newSellerBindingSalt(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}
