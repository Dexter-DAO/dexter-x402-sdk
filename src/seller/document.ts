import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { canonicalBytes } from './jcs';
import { decodeBase64url } from './encoding';
import { ed25519JwkToBytes } from './jwk';
import { verifyEd25519Strict } from './ed25519';
import { parseDidWebKid, parseSellerUrl, registrableDomainOf } from './host';
import { ADDRESS_PROOF_TYPE, DID_DOCUMENT_MAX_BYTES, SELLER_PROFILE_TYPE, SELLER_PROFILE_VERSION } from './types';
import type { Ed25519PublicJwk, SellerAddress, SellerProfileV1 } from './types';

export interface SellerDocument {
  id: string;
  verificationMethod: Array<{ id: string; type: 'JsonWebKey2020'; controller: string; publicKeyJwk: Ed25519PublicJwk }>;
  assertionMethod: string[];
  service: Array<{ id: string; type: string; serviceEndpoint: unknown }>;
}
export interface ParsedSellerDocument { doc: SellerDocument; profiles: SellerProfileV1[] }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function strings(value: unknown, min: number, max: number): value is string[] {
  return Array.isArray(value) && value.length >= min && value.length <= max &&
    value.every((entry) => typeof entry === 'string') && new Set(value).size === value.length;
}
function ownKid(value: unknown, did: string): boolean {
  if (typeof value !== 'string') return false;
  const kid = parseDidWebKid(value);
  return typeof kid !== 'string' && kid.did === did;
}
function base58Key(value: unknown): value is string {
  try { return typeof value === 'string' && bs58.decode(value).length === 32; }
  catch { return false; }
}

export function parseSellerDocument(bytes: Uint8Array, expectedDid: string): ParsedSellerDocument | 'did_document_invalid' | 'key_invalid' {
  try {
    const did = parseDidWebKid(expectedDid + '#document');
    if (typeof did === 'string' || registrableDomainOf(did.host) !== did.host || bytes.length > DID_DOCUMENT_MAX_BYTES) {
      return 'did_document_invalid';
    }
    const doc: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(doc) || doc.id !== expectedDid || !Array.isArray(doc.verificationMethod) ||
        !Array.isArray(doc.assertionMethod) || !doc.assertionMethod.every((entry) => typeof entry === 'string') ||
        !Array.isArray(doc.service)) return 'did_document_invalid';
    const ids = new Set<string>();
    for (const method of doc.verificationMethod) {
      if (!object(method) || !ownKid(method.id, expectedDid) || method.controller !== expectedDid ||
          method.type !== 'JsonWebKey2020' || ids.has(method.id as string)) return 'did_document_invalid';
      ids.add(method.id as string);
      const jwk = method.publicKeyJwk;
      if (!object(jwk) || Object.keys(jwk).sort().join(',') !== 'crv,kty,x') return 'key_invalid';
      try { ed25519JwkToBytes(jwk as unknown as Ed25519PublicJwk); } catch { return 'key_invalid'; }
    }
    const profiles: SellerProfileV1[] = [];
    const serviceIds = new Set<string>();
    for (const service of doc.service) {
      if (!object(service)) return 'did_document_invalid';
      if (service.type !== SELLER_PROFILE_TYPE) continue;
      if (!ownKid(service.id, expectedDid) || serviceIds.has(service.id as string)) return 'did_document_invalid';
      serviceIds.add(service.id as string);
      const profile = service.serviceEndpoint;
      if (!object(profile) || profile.v !== SELLER_PROFILE_VERSION || typeof profile.name !== 'string' ||
          !/^[\x20-\x7e]{1,64}$/.test(profile.name) || !strings(profile.hosts, 1, 32) ||
          !strings(profile.signingKeys, 1, 8) || !profile.signingKeys.every((kid) => ownKid(kid, expectedDid)) ||
          !Array.isArray(profile.payTo) || profile.payTo.length < 1 || profile.payTo.length > 16) return 'did_document_invalid';
      for (const host of profile.hosts) {
        const parsed = parseSellerUrl('https://' + host);
        if (!parsed || parsed.host !== host || parsed.registrableDomain !== did.host) return 'did_document_invalid';
      }
      for (const entry of profile.payTo) {
        if (!object(entry) || typeof entry.network !== 'string' || !/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(entry.network) ||
            !base58Key(entry.asset) || !base58Key(entry.address) || typeof entry.proof !== 'string') return 'did_document_invalid';
        try { if (decodeBase64url(entry.proof).length !== 64) return 'did_document_invalid'; }
        catch { return 'did_document_invalid'; }
      }
      profiles.push(profile as unknown as SellerProfileV1);
    }
    return { doc: doc as unknown as SellerDocument, profiles };
  } catch { return 'did_document_invalid'; }
}

export function profileForHost(parsed: ParsedSellerDocument, host: string): SellerProfileV1 | 'host_not_listed' | 'did_document_invalid' {
  const profiles = parsed.profiles.filter((profile) => profile.hosts.includes(host));
  return profiles.length === 1 ? profiles[0] : profiles.length === 0 ? 'host_not_listed' : 'did_document_invalid';
}

export function addressProofMessage(input: { did: string; network: string; asset: string; address: string }): Uint8Array {
  return canonicalBytes({ address: input.address, asset: input.asset, did: input.did, network: input.network, type: ADDRESS_PROOF_TYPE });
}

export function verifyAddressProofs(profile: SellerProfileV1, did: string): boolean {
  try {
    return profile.payTo.every((entry) => verifyEd25519Strict(
      decodeBase64url(entry.proof), addressProofMessage({ ...entry, did }), bs58.decode(entry.address),
    ));
  } catch { return false; }
}

export function addressListSha256(entries: readonly SellerAddress[]): string {
  const list = entries.map(({ network, asset, address }) => ({ network, asset, address }));
  list.sort((a, b) => {
    for (const field of ['network', 'asset', 'address'] as const) {
      if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
    }
    return 0;
  });
  return bytesToHex(sha256(canonicalBytes(list)));
}
