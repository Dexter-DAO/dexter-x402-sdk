import { decodeBase64url } from './encoding';
import type { OfferPayloadV1 } from './types';

export interface DecodedCompactJws {
  header: Record<string, unknown> & { alg: string; kid: string };
  payload: unknown;
  signingInput: Uint8Array;
  signature: Uint8Array;
}

export function decodeCompactJws(jws: string): DecodedCompactJws | 'offer_malformed' {
  try {
    if (typeof jws !== 'string') return 'offer_malformed';
    const parts = jws.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
      return 'offer_malformed';
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const header: unknown = JSON.parse(decoder.decode(decodeBase64url(parts[0])));
    const payload: unknown = JSON.parse(decoder.decode(decodeBase64url(parts[1])));
    if (!header || typeof header !== 'object' || Array.isArray(header)
        || typeof (header as Record<string, unknown>).alg !== 'string'
        || typeof (header as Record<string, unknown>).kid !== 'string'
        || Object.prototype.hasOwnProperty.call(header, 'crit')) return 'offer_malformed';
    return {
      header: header as DecodedCompactJws['header'],
      payload,
      signingInput: new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      signature: decodeBase64url(parts[2]),
    };
  } catch {
    return 'offer_malformed';
  }
}

const OFFER_FIELDS = ['version', 'resourceUrl', 'scheme', 'network', 'asset', 'payTo', 'amount', 'validUntil'];

export function decodeOfferPayload(payload: unknown): OfferPayloadV1 | 'offer_malformed' {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'offer_malformed';
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).length !== OFFER_FIELDS.length
      || !OFFER_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(value, field))
      || value.version !== 1
      || !['resourceUrl', 'scheme', 'network', 'asset', 'payTo', 'amount'].every((field) => typeof value[field] === 'string')
      || !/^[0-9]+$/.test(value.amount as string)
      || !Number.isSafeInteger(value.validUntil)) return 'offer_malformed';
  return value as unknown as OfferPayloadV1;
}
