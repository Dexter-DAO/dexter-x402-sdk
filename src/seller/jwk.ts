import { sha256 } from '@noble/hashes/sha256';
import { canonicalBytes } from './jcs';
import { decodeBase64url, encodeBase64url } from './encoding';
import type { Ed25519PublicJwk } from './types';

export function ed25519JwkToBytes(jwk: Ed25519PublicJwk): Uint8Array {
  try {
    if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') throw new Error();
    const bytes = decodeBase64url(jwk.x);
    if (bytes.length !== 32) throw new Error();
    return bytes;
  } catch { throw new Error('key_invalid'); }
}

export function jwkThumbprint(jwk: Ed25519PublicJwk): string {
  ed25519JwkToBytes(jwk);
  return encodeBase64url(sha256(canonicalBytes({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })));
}
