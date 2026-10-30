import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { verifyEd25519Strict } from './ed25519';
import { defaultFetchDidDocument } from './fetch';
import { addressListSha256, parseSellerDocument, profileForHost, verifyAddressProofs } from './document';
import { parseDidWebKid, parseSellerUrl } from './host';
import { decodeCompactJws, decodeOfferPayload } from './jws';
import { ed25519JwkToBytes, jwkThumbprint } from './jwk';
import {
  CLOCK_SKEW_SECONDS, DID_DOCUMENT_MAX_BYTES, MAX_OFFER_LIFETIME_SECONDS, SOLANA_MAINNET, USDC_MINT,
} from './types';
import type {
  FetchDidDocument, KnownSeller, OfferPayloadV1, R1Code, R2Code, SellerCheck, SellerRefusal, SellerRequest,
} from './types';

const ASCII = new TextEncoder();

function refused(rule: 'R1', code: R1Code, detail: string, claimedHost: string | null, checkedAt: number): SellerCheck;
function refused(rule: 'R2', code: R2Code, detail: string, claimedHost: string | null, checkedAt: number): SellerCheck;
function refused(rule: 'R3', code: 'expected_host_mismatch', detail: string, claimedHost: string | null, checkedAt: number): SellerCheck;
function refused(rule: SellerRefusal['rule'], code: string, detail: string, claimedHost: string | null, checkedAt: number): SellerCheck {
  return { status: 'refused', refusal: { rule, code, detail } as SellerRefusal, claimedHost, checkedAt };
}

function sameKey(a: string, b: string): boolean {
  try {
    const x = bs58.decode(a);
    const y = bs58.decode(b);
    return x.length === 32 && y.length === 32 && x.every((byte, i) => byte === y[i]);
  } catch {
    return false;
  }
}

/** True when the bytes are JSON at all; anything else counts as an unreadable file, not an invalid one. */
function isJson(bytes: Uint8Array): boolean {
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks a store's signed quote against the store file on its registrable domain (SPEC section 2, steps 1-14).
 * The first failure wins. Refusals fire only where the evidence contradicts itself; an unreadable file is
 * unsigned at first contact and checked against the owner's saved key for a store he already uses.
 */
export async function checkSellerOffer(
  request: SellerRequest,
  options: { now?: number; fetchDidDocument?: FetchDidDocument; known?: readonly KnownSeller[]; signal?: AbortSignal } = {},
): Promise<SellerCheck> {
  const checkedAt = options.now ?? Math.floor(Date.now() / 1000);
  const seller = request.seller;
  const called = seller ? parseSellerUrl(seller.calledUrl) : null;

  // 1. No quote: unsigned. The called URL is kept only for the screen's comparison with known hosts.
  if (!seller?.offer) {
    return { status: 'unsigned', reason: 'no_offer', calledUrl: called?.href ?? null, host: called?.host ?? null, checkedAt };
  }
  // 2. The URL the agent called.
  if (!called) return refused('R1', 'called_url_invalid', 'the called URL is not a plain https URL on a public host', null, checkedAt);
  const claimedHost = called.host;

  // 3. Offer shape.
  if (seller.offer.format !== 'jws') return refused('R1', 'offer_format_unsupported', 'the quote is not a JWS', claimedHost, checkedAt);
  const offerJws = seller.offer.signature;
  const jws = decodeCompactJws(offerJws);
  if (typeof jws === 'string') return refused('R1', 'offer_malformed', 'the quote is not a compact JWS', claimedHost, checkedAt);
  if (jws.header.alg !== 'EdDSA') return refused('R1', 'offer_alg_unsupported', `alg ${jws.header.alg} is not EdDSA`, claimedHost, checkedAt);
  // A missing or null validUntil is reported at step 8, not as a malformed payload.
  const raw = jws.payload as Record<string, unknown> | null;
  const payload = decodeOfferPayload(raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...raw, validUntil: raw.validUntil ?? 0 } : raw);
  if (typeof payload === 'string') return refused('R1', 'offer_malformed', 'the quote payload is not an x402 offer v1', claimedHost, checkedAt);

  // 4. kid.
  const kid = parseDidWebKid(jws.header.kid);
  if (kid === 'did_method_unsupported') return refused('R1', kid, 'only did:web keys listed on the store website are accepted', claimedHost, checkedAt);
  if (kid === 'kid_not_did_url') return refused('R1', kid, 'kid is not did:web:<host>#<fragment>', claimedHost, checkedAt);

  // 5. The quote's resource URL and the URL the agent called.
  const resource = parseSellerUrl(payload.resourceUrl);
  if (!resource) return refused('R1', 'resource_url_invalid', 'the quote resourceUrl is not a plain https URL on a public host', claimedHost, checkedAt);
  if (resource.host !== called.host) {
    return refused('R1', 'resource_host_mismatch', `the quote is for ${resource.host}, the agent called ${called.host}`, claimedHost, checkedAt);
  }
  // 6. The key must belong to the registrable domain itself.
  if (kid.host !== resource.registrableDomain) {
    return refused('R1', 'did_not_registrable_domain', `${kid.did} is not did:web:${resource.registrableDomain}`, claimedHost, checkedAt);
  }
  // 7. Terms.
  if (payload.scheme !== 'tab' || payload.network !== SOLANA_MAINNET || payload.asset !== USDC_MINT ||
      payload.scheme !== request.scheme || payload.network !== request.network || payload.asset !== request.asset) {
    return refused('R1', 'offer_terms_mismatch', 'the quote is not a Tab on Solana in USDC', claimedHost, checkedAt);
  }
  // 8. Time.
  if (payload.validUntil === 0) return refused('R1', 'offer_validity_missing', 'the quote has no validUntil', claimedHost, checkedAt);
  if (payload.validUntil <= checkedAt) return refused('R1', 'offer_expired', 'the quote has expired', claimedHost, checkedAt);
  if (payload.validUntil > checkedAt + MAX_OFFER_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS) {
    return refused('R1', 'offer_validity_too_long', 'the quote is valid for more than 10 minutes', claimedHost, checkedAt);
  }

  const offerJwsSha256 = bytesToHex(sha256(ASCII.encode(offerJws)));
  const common = {
    calledUrl: called.href, host: resource.host, registrableDomain: resource.registrableDomain,
    did: kid.did, kid: jws.header.kid, offerJws, offerJwsSha256, offer: payload,
  };

  // 9. The store file on the registrable domain.
  let didDocument: Uint8Array | null = null;
  try {
    const fetchDocument = options.fetchDidDocument ?? defaultFetchDidDocument;
    const bytes = await fetchDocument(`https://${resource.registrableDomain}/.well-known/did.json`, options.signal);
    if (bytes instanceof Uint8Array && bytes.length <= DID_DOCUMENT_MAX_BYTES && isJson(bytes)) didDocument = bytes;
  } catch {
    didDocument = null;
  }
  if (!didDocument) {
    const saved = options.known?.find((entry) => entry.host === resource.host && entry.kid === jws.header.kid);
    if (!saved) return { status: 'unsigned', reason: 'did_document_unavailable', calledUrl: called.href, host: called.host, checkedAt };
    // Saved path: the key and addresses he approved before; no file, so no proof step.
    if (!verifyEd25519Strict(jws.signature, jws.signingInput, ed25519JwkToBytes(saved.key))) {
      return refused('R1', 'signature_invalid', `the quote does not verify under the key you approved for ${saved.host}`, claimedHost, checkedAt);
    }
    const r2 = payToRule(payload, request.counterparty, saved.addresses, claimedHost, checkedAt);
    if (r2) return r2;
    const r3 = expectedHostRule(seller.expectedHost, resource.host, claimedHost, checkedAt);
    if (r3) return r3;
    return {
      status: 'signed', source: 'saved', checkedAt, ...common,
      key: saved.key, keyThumbprint: saved.keyThumbprint,
      didDocument: null, didDocumentSha256: saved.didDocumentSha256, profile: null,
      addresses: [...saved.addresses], addressListSha256: saved.addressListSha256,
    };
  }

  // 10. File rules.
  const parsed = parseSellerDocument(didDocument, kid.did);
  if (parsed === 'did_document_invalid') return refused('R1', parsed, `${resource.registrableDomain}'s file breaks the store-file rules`, claimedHost, checkedAt);
  if (parsed === 'key_invalid') return refused('R1', parsed, `${resource.registrableDomain}'s file lists a key that is not Ed25519`, claimedHost, checkedAt);
  const profile = profileForHost(parsed, resource.host);
  if (profile === 'host_not_listed') return refused('R1', profile, `${resource.registrableDomain}'s file does not list ${resource.host}`, claimedHost, checkedAt);
  if (profile === 'did_document_invalid') return refused('R1', profile, `${resource.host} appears in more than one store profile`, claimedHost, checkedAt);
  const method = parsed.doc.verificationMethod.find((entry) => entry.id === jws.header.kid);
  if (!method || !parsed.doc.assertionMethod.includes(jws.header.kid) || !profile.signingKeys.includes(jws.header.kid)) {
    return refused('R1', 'kid_not_listed', `the key that signed this quote is not listed by ${resource.registrableDomain}`, claimedHost, checkedAt);
  }
  // 11. Signature.
  if (!verifyEd25519Strict(jws.signature, jws.signingInput, ed25519JwkToBytes(method.publicKeyJwk))) {
    return refused('R1', 'signature_invalid', 'the quote signature does not verify under the listed key', claimedHost, checkedAt);
  }
  // 12. R2.
  const addresses = profile.payTo
    .filter((entry) => entry.network === payload.network && entry.asset === payload.asset)
    .map((entry) => entry.address)
    .sort();
  const r2 = payToRule(payload, request.counterparty, addresses, claimedHost, checkedAt);
  if (r2) return r2;
  if (!verifyAddressProofs(profile, kid.did)) {
    return refused('R2', 'address_proof_invalid', `an address in ${resource.registrableDomain}'s file has no valid control proof`, claimedHost, checkedAt);
  }
  // 13. R3.
  const r3 = expectedHostRule(seller.expectedHost, resource.host, claimedHost, checkedAt);
  if (r3) return r3;

  // 14. Signed.
  const key = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: method.publicKeyJwk.x };
  return {
    status: 'signed', source: 'live', checkedAt, ...common,
    key, keyThumbprint: jwkThumbprint(key),
    didDocument, didDocumentSha256: bytesToHex(sha256(didDocument)), profile,
    addresses, addressListSha256: addressListSha256(profile.payTo),
  };
}

function payToRule(offer: OfferPayloadV1, counterparty: string, listed: readonly string[], claimedHost: string, checkedAt: number): SellerCheck | null {
  if (!sameKey(offer.payTo, counterparty)) {
    return refused('R2', 'payto_mismatch', `this request pays a different address than ${claimedHost} signed`, claimedHost, checkedAt);
  }
  if (!listed.some((address) => sameKey(address, offer.payTo))) {
    return refused('R2', 'payto_not_listed', `${claimedHost} does not list the address its quote names`, claimedHost, checkedAt);
  }
  return null;
}

function expectedHostRule(expectedHost: string | undefined, host: string, claimedHost: string, checkedAt: number): SellerCheck | null {
  if (expectedHost !== undefined && expectedHost !== host) {
    return refused('R3', 'expected_host_mismatch', `the request expects ${expectedHost}, the quote is from ${host}`, claimedHost, checkedAt);
  }
  return null;
}
