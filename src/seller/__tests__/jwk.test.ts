import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ed25519JwkToBytes, jwkThumbprint } from '../jwk';
import { decodeBase64url, encodeBase64url } from '../encoding';
const jwk = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' } as const;
describe('Ed25519 JWK', () => {
  it('hashes only required sorted members per RFC 7638', () => {
    const expected = createHash('sha256').update('{"crv":"Ed25519","kty":"OKP","x":"' + jwk.x + '"}').digest('base64url');
    expect(jwkThumbprint({ ...jwk, kid: 'ignored' } as typeof jwk)).toBe(expected);
    expect(ed25519JwkToBytes(jwk)).toHaveLength(32);
  });
  it('rejects wrong curve, noncanonical base64url and keys not 32 bytes', () => {
    for (const value of [{ ...jwk, crv: 'X25519' }, { ...jwk, x: 'AA' }, { ...jwk, x: jwk.x + '=' }, { ...jwk, x: jwk.x.slice(0, -1) + 'p' }]) {
      expect(() => ed25519JwkToBytes(value as typeof jwk)).toThrow('key_invalid');
    }
  });
  it('roundtrips canonical base64url and rejects padding and trailing bits', () => {
    expect(encodeBase64url(decodeBase64url('AP_-'))).toBe('AP_-');
    for (const value of ['A', 'AB', 'AA=', 'a+b/']) expect(() => decodeBase64url(value)).toThrow();
  });
});
