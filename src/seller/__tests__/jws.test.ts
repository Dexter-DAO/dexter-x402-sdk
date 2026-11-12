import { describe, expect, it } from 'vitest';
import { decodeCompactJws, decodeOfferPayload } from '../jws';
import { encodeBase64url } from '../encoding';

const payload = {
  version: 1, resourceUrl: 'https://books.dexter.cash/books/meditations', scheme: 'tab',
  network: 'solana:mainnet', asset: 'mint', payTo: 'address', amount: '1000000', validUntil: 123,
};
const json = (value: unknown) => encodeBase64url(new TextEncoder().encode(JSON.stringify(value)));
const header = { alg: 'EdDSA', kid: 'did:web:dexter.cash#books-quote-1' };
const jws = (head: unknown = header, body: unknown = payload) => `${json(head)}.${json(body)}.${encodeBase64url(new Uint8Array(64))}`;

describe('decodeCompactJws', () => {
  it('preserves the exact encoded signing input and decodes the signature', () => {
    const compact = jws();
    const decoded = decodeCompactJws(compact);
    expect(typeof decoded).toBe('object');
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(decoded.header).toEqual(header);
    expect(decoded.payload).toEqual(payload);
    expect(new TextDecoder().decode(decoded.signingInput)).toBe(compact.slice(0, compact.lastIndexOf('.')));
    expect(decoded.signature).toEqual(new Uint8Array(64));
  });

  it('rejects a JWS with padding, four segments or a crit header', () => {
    for (const bad of [jws() + '=', jws() + '.x', jws({ ...header, crit: [] })]) {
      expect(decodeCompactJws(bad)).toBe('offer_malformed');
    }
  });

  it.each([null, [], {}, { alg: 1, kid: 'key' }, { alg: 'EdDSA', kid: 2 }])('rejects malformed header %j', (bad) => {
    expect(decodeCompactJws(jws(bad))).toBe('offer_malformed');
  });

  it('rejects empty segments, non-base64url text, invalid JSON and invalid UTF-8', () => {
    for (const bad of ['', '..', 'a.b.c', `${json(header)}.e30.+w`, `${json(header)}._w.AA`]) {
      expect(decodeCompactJws(bad)).toBe('offer_malformed');
    }
  });

  it('leaves algorithm policy and JSON payload shape to the caller', () => {
    const decoded = decodeCompactJws(jws({ ...header, alg: 'other' }, null));
    expect(typeof decoded === 'string' ? decoded : decoded.header.alg).toBe('other');
    expect(typeof decoded === 'string' ? decoded : decoded.payload).toBeNull();
  });
});

describe('decodeOfferPayload', () => {
  it('accepts exactly the eight typed offer fields', () => {
    expect(decodeOfferPayload(payload)).toEqual(payload);
  });

  it('rejects extra or missing fields and unsupported versions', () => {
    const { validUntil: _validUntil, ...missing } = payload;
    for (const bad of [{ ...payload, acceptIndex: 0 }, missing, { ...payload, version: 2 }, null, []]) {
      expect(decodeOfferPayload(bad)).toBe('offer_malformed');
    }
  });

  it('requires decimal integer amount text and a safe integer validity', () => {
    for (const amount of ['-1', '+1', '1.0', '1e6', '', 1000000]) {
      expect(decodeOfferPayload({ ...payload, amount })).toBe('offer_malformed');
    }
    for (const validUntil of ['123', 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      expect(decodeOfferPayload({ ...payload, validUntil })).toBe('offer_malformed');
    }
  });

  it.each(['resourceUrl', 'scheme', 'network', 'asset', 'payTo'])('requires %s to be text', (field) => {
    expect(decodeOfferPayload({ ...payload, [field]: 1 })).toBe('offer_malformed');
  });
});
