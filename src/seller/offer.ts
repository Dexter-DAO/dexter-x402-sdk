import { decodeCompactJws, decodeOfferPayload } from './jws';
import type { SignedOfferJws } from './types';

// Select by signed-payload terms; checkSellerOffer must still verify the signature.
export function sellerOfferFromPaymentRequired(
  body: unknown,
  accept: { scheme: string; network: string; asset: string; payTo: string; amount: string },
): SignedOfferJws | null {
  if (!body || typeof body !== 'object') return null;
  const offers = (body as { extensions?: { 'offer-receipt'?: { info?: { offers?: unknown } } } })
    .extensions?.['offer-receipt']?.info?.offers;
  if (!Array.isArray(offers)) return null;
  for (const offer of offers) {
    if (!offer || typeof offer !== 'object' || offer.format !== 'jws' || typeof offer.signature !== 'string') continue;
    const decoded = decodeCompactJws(offer.signature);
    if (typeof decoded === 'string') continue;
    const payload = decodeOfferPayload(decoded.payload);
    if (typeof payload === 'string') continue;
    if (['scheme', 'network', 'asset', 'payTo', 'amount'].every((field) => (
      payload[field as keyof typeof accept] === accept[field as keyof typeof accept]
    ))) return { format: 'jws', signature: offer.signature };
  }
  return null;
}
