import { createOfferJWS, createOfferReceiptExtension } from '@x402/extensions/offer-receipt';
import document from '../.well-known/did.json';

const profile = document.service[0].serviceEndpoint;
const { address: payTo, asset, network } = profile.payTo[0];
const slugs = new Set(['wealth-of-nations', 'meditations', 'art-of-war', 'the-prince',
  'the-innovators-dilemma', 'the-sovereign-individual']);
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED',
  'X-Content-Type-Options': 'nosniff' };

export async function paymentRequired({ params, env, request }, variant) {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
  if (!slugs.has(params.slug)) return new Response(null, { status: 404, headers });
  const real = variant === 'V2';
  const resourceUrl = `https://${real ? 'books.dexter.cash' : 'dexter-bookstore.pages.dev'}/books/${params.slug}`;
  const accept = { scheme: 'tab', network, asset, payTo, amount: '1000000', maxAmountRequired: '1000000',
    maxTimeoutSeconds: 1800, extra: { feePayer: 'DeXterR2kQm8AvRHnNPatWkE46TfAcMeBDjb6FySoAb8',
      decimals: 6, voucherHeader: 'x-tab-voucher', registrationEncoding: 'base64(188-byte sessionRegisterMessage)',
      termsVersion: 'dexter-tab-hosted-pay-before-delivery/v1', acceptanceRule: 'pay_before_delivery_seller_2xx' } };
  const body = { x402Version: 2, error: 'Payment required', price: '1.00',
    resource: { url: resourceUrl, description: 'Dexter Bookstore: one book for 1.00 USDC.', mimeType: 'application/json' },
    accepts: [accept] };
  if (variant !== 'V4') {
    try {
      const key = await crypto.subtle.importKey('jwk', JSON.parse(env.IMPOSTOR_QUOTE_JWK), { name: 'Ed25519' }, false, ['sign']);
      const kid = real ? 'did:web:dexter.cash#books-quote-impostor' : document.assertionMethod[0];
      const signer = { kid, format: 'jws', algorithm: 'EdDSA', sign: async bytes => {
        const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, bytes));
        return btoa(String.fromCharCode(...signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      } };
      const offer = { ...await createOfferJWS(resourceUrl, { ...accept, acceptIndex: 0, offerValiditySeconds: 600 }, signer), acceptIndex: 0 };
      const extension = createOfferReceiptExtension({ kid, format: 'jws', issueOffer: async () => offer,
        issueReceipt: async () => { throw new Error('copycat_delivers_nothing'); } });
      body.extensions = { 'offer-receipt': await extension.enrichPaymentRequiredResponse({}, {
        requirements: body.accepts, resourceInfo: body.resource, paymentRequiredResponse: body }) };
    } catch {
      // Crypto exceptions can contain secret input. Return only a fixed diagnostic.
      return new Response(JSON.stringify({ error: 'impostor_quote_key_unavailable' }), { status: 503, headers });
    }
  }
  const json = JSON.stringify(body);
  const bytes = new TextEncoder().encode(json);
  return new Response(json, { status: 402, headers: { ...headers,
    'PAYMENT-REQUIRED': btoa(String.fromCharCode(...bytes)) } });
}
