import { describe, expect, it } from 'vitest';
import { sellerOfferFromPaymentRequired } from '../offer';
import { encodeBase64url } from '../encoding';

const accept = { scheme: 'tab', network: 'solana:mainnet', asset: 'mint', payTo: 'seller', amount: '1000000' };
const encode = (value: unknown) => encodeBase64url(new TextEncoder().encode(JSON.stringify(value)));
const offer = (terms = accept, acceptIndex = 0) => ({
  format: 'jws', acceptIndex,
  signature: `${encode({ alg: 'EdDSA', kid: 'did:web:dexter.cash#key' })}.${encode({
    ...terms, version: 1, resourceUrl: 'https://books.dexter.cash/book', validUntil: 123,
  })}.${encodeBase64url(new Uint8Array(64))}`,
});
const body = (offers: unknown) => ({ extensions: { 'offer-receipt': { info: { offers } } } });

describe('sellerOfferFromPaymentRequired', () => {
  it('sellerOfferFromPaymentRequired ignores acceptIndex', () => {
    const wrong = offer({ ...accept, payTo: 'impostor' }, 0);
    const matching = offer(accept, 999);
    expect(sellerOfferFromPaymentRequired(body([wrong, matching]), accept)).toEqual({
      format: 'jws', signature: matching.signature,
    });
  });

  it.each(['scheme', 'network', 'asset', 'payTo', 'amount'])('requires payload %s to match', (field) => {
    expect(sellerOfferFromPaymentRequired(body([offer({ ...accept, [field]: 'other' })]), accept)).toBeNull();
  });

  it('skips malformed offers and returns the first matching payload', () => {
    const matching = offer();
    expect(sellerOfferFromPaymentRequired(body([
      null, {}, { ...matching, format: 'eip712' }, { ...matching, signature: 'bad' }, matching, offer(accept, 1),
    ]), accept)).toEqual({ format: 'jws', signature: matching.signature });
  });

  it('returns null when there is no offers array', () => {
    for (const malformed of [null, [], {}, body(null), body({}), { extensions: null }]) {
      expect(sellerOfferFromPaymentRequired(malformed, accept)).toBeNull();
    }
  });
});
