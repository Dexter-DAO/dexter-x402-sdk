import { canonicalBytes, parseCanonical } from './jcs';
import { sellerBindingNonce } from './nonce';
import { SELLER_BINDING_VERSION } from './types';
import type { KnownSeller, ScreenDecision, ScreenNotice, SellerBindingV1, SellerHistoryEntry, SignedSeller } from './types';

/** Kept equal to package.json's version by a test. */
export const SELLER_CHECKER = '@dexterai/x402@6.1.0/seller';
export const SELLER_BINDING_MAX_BYTES = 8192;

export function buildSellerBinding(input: {
  check: SignedSeller;
  decision: Extract<ScreenDecision, { approve: 'allowed' | 'confirm' }>;
  vault: string;
  sessionPubkey: string;
  confirmed: readonly ScreenNotice[];
  /** 'dexter-fe@<sourceCommit>', or 'dexter-fe@dev' in local builds. */
  page: string;
}): SellerBindingV1 {
  const { check, decision } = input;
  if (decision.seller.kind !== 'website' || decision.seller.host !== check.host) throw new Error('seller_binding_decision_mismatch');
  // Every notice on screen must have been confirmed, and nothing else.
  const key = (n: ScreenNotice) => `${n.rule}:${n.code}:${n.knownHost}`;
  const shown = decision.notices.map(key).sort();
  const confirmed = input.confirmed.map(key).sort();
  if (shown.length !== confirmed.length || shown.some((value, i) => value !== confirmed[i])) throw new Error('seller_binding_notices_unconfirmed');
  const relation = decision.seller.relation;
  if (relation !== 'known' && relation !== 'first-payment' && relation !== 'unknown') throw new Error('seller_binding_decision_mismatch');

  return {
    v: SELLER_BINDING_VERSION,
    vault: input.vault,
    counterparty: check.offer.payTo,
    sessionPubkey: input.sessionPubkey,
    calledUrl: check.calledUrl,
    host: check.host,
    registrableDomain: check.registrableDomain,
    did: check.did,
    kid: check.kid,
    key: { kty: 'OKP', crv: 'Ed25519', x: check.key.x },
    keyThumbprint: check.keyThumbprint,
    didDocumentSha256: check.didDocumentSha256,
    addresses: [...check.addresses],
    addressListSha256: check.addressListSha256,
    offerJwsSha256: check.offerJwsSha256,
    offer: { ...check.offer },
    label: check.profile?.name ?? null,
    source: check.source,
    relation,
    notices: input.confirmed.map((n) => ({ rule: n.rule, code: n.code, knownHost: n.knownHost, confirmed: true as const })),
    checkedAt: check.checkedAt,
    checker: SELLER_CHECKER,
    page: input.page,
  };
}

export function encodeSellerBinding(binding: SellerBindingV1): Uint8Array {
  const bytes = canonicalBytes(binding);
  if (bytes.length > SELLER_BINDING_MAX_BYTES) throw new Error('seller_binding_too_large');
  return bytes;
}

const FIELDS: Record<keyof SellerBindingV1, 'string' | 'number' | 'nullable' | 'object'> = {
  v: 'string', vault: 'string', counterparty: 'string', sessionPubkey: 'string', calledUrl: 'string', host: 'string',
  registrableDomain: 'string', did: 'string', kid: 'string', key: 'object', keyThumbprint: 'string',
  didDocumentSha256: 'string', addresses: 'object', addressListSha256: 'string', offerJwsSha256: 'string', offer: 'object',
  label: 'nullable', source: 'string', relation: 'string', notices: 'object', checkedAt: 'number', checker: 'string', page: 'string',
};
const OFFER_FIELDS = ['amount', 'asset', 'network', 'payTo', 'resourceUrl', 'scheme', 'validUntil', 'version'];

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

/** Strict: the bytes must be the canonical encoding of a well-formed binding. Throws otherwise. */
export function decodeSellerBinding(bytes: Uint8Array): SellerBindingV1 {
  if (bytes.length > SELLER_BINDING_MAX_BYTES) throw new Error('seller_binding_too_large');
  const value = parseCanonical(bytes);
  const fail = () => { throw new Error('seller_binding_invalid'); };
  if (!exactKeys(value, Object.keys(FIELDS))) fail();
  const b = value as Record<string, unknown>;
  for (const [field, kind] of Object.entries(FIELDS)) {
    const v = b[field];
    if (kind === 'string' && typeof v !== 'string') fail();
    if (kind === 'number' && !Number.isSafeInteger(v)) fail();
    if (kind === 'nullable' && v !== null && typeof v !== 'string') fail();
  }
  if (b.v !== SELLER_BINDING_VERSION || !['live', 'saved'].includes(b.source as string) ||
      !['known', 'first-payment', 'unknown'].includes(b.relation as string)) fail();
  if (!exactKeys(b.key, ['crv', 'kty', 'x']) || (b.key as Record<string, unknown>).kty !== 'OKP' ||
      (b.key as Record<string, unknown>).crv !== 'Ed25519' || typeof (b.key as Record<string, unknown>).x !== 'string') fail();
  if (!Array.isArray(b.addresses) || !b.addresses.every((a) => typeof a === 'string')) fail();
  if (!exactKeys(b.offer, OFFER_FIELDS) || (b.offer as Record<string, unknown>).version !== 1 ||
      !Number.isSafeInteger((b.offer as Record<string, unknown>).validUntil) ||
      !OFFER_FIELDS.filter((f) => f !== 'version' && f !== 'validUntil').every((f) => typeof (b.offer as Record<string, unknown>)[f] === 'string')) fail();
  if (!Array.isArray(b.notices) || !b.notices.every((n) => exactKeys(n, ['code', 'confirmed', 'knownHost', 'rule']) &&
      (n.rule === 'R4' || n.rule === 'R5') && typeof n.code === 'string' && typeof n.knownHost === 'string' && n.confirmed === true)) fail();
  return value as SellerBindingV1;
}

/**
 * The owner's stores, from his own registered approvals. A row is admitted only if its binding decodes strictly,
 * names this vault, and its committed nonce equals sellerBindingNonce(binding, salt). Everything else is skipped.
 */
export function knownSellers(entries: readonly SellerHistoryEntry[], options: { vault: string }): KnownSeller[] {
  const admitted: Array<{ binding: SellerBindingV1; entry: SellerHistoryEntry }> = [];
  for (const entry of entries) {
    try {
      const binding = decodeSellerBinding(entry.binding);
      if (binding.vault !== options.vault) continue;
      const nonce = sellerBindingNonce(entry.binding, entry.salt);
      if (entry.ceremonyNonce.length !== nonce.length || !nonce.every((byte, i) => byte === entry.ceremonyNonce[i])) continue;
      admitted.push({ binding, entry });
    } catch {
      continue;
    }
  }
  admitted.sort((a, b) => a.entry.registeredAt - b.entry.registeredAt);
  const byHost = new Map<string, KnownSeller>();
  for (const { binding, entry } of admitted) {
    const prior = byHost.get(binding.host);
    byHost.set(binding.host, {
      host: binding.host,
      registrableDomain: binding.registrableDomain,
      did: binding.did,
      kid: binding.kid,
      key: binding.key,
      keyThumbprint: binding.keyThumbprint,
      didDocumentSha256: binding.didDocumentSha256,
      addresses: binding.addresses,
      addressListSha256: binding.addressListSha256,
      label: binding.label ?? prior?.label ?? null,
      firstApprovedAt: prior?.firstApprovedAt ?? entry.registeredAt,
      lastApprovedAt: entry.registeredAt,
      lastRegisterTx: entry.registerTx,
    });
  }
  return [...byHost.values()];
}
