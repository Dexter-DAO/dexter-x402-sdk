import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { canonicalBytes, parseCanonical } from './jcs';
import { sellerBindingNonce } from './nonce';
import { screenSeller, type ScreenInput } from './screen';
import { SELLER_BINDING_VERSION } from './types';
import type { KnownSeller, ScreenDecision, ScreenNotice, SellerBindingV1, SellerHistoryEntry, SignedSeller } from './types';

/** Kept equal to package.json's version by a test. */
export const SELLER_CHECKER = '@dexterai/x402@6.1.0/seller';
export const SELLER_BINDING_MAX_BYTES = 8192;

const noticeKey = (n: { rule: string; code: string; knownHost: string }) => `${n.rule}:${n.code}:${n.knownHost}`;
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * The binding for a signed seller the owner is about to approve. It reruns screenSeller on the same inputs and refuses to
 * build unless that reproduces the decision on screen, so the binding records the complete decision and its inputs.
 * Every notice on screen must be in `confirmed`.
 */
export function buildSellerBinding(input: {
  check: SignedSeller;
  screen: ScreenInput;
  decision: Extract<ScreenDecision, { approve: 'allowed' | 'confirm' }>;
  confirmed: readonly ScreenNotice[];
  vault: string;
  /** 'dexter-fe@<sourceCommit>', or 'dexter-fe@dev' in local builds. */
  page: string;
}): SellerBindingV1 {
  const { check, screen, decision } = input;
  const replay = screenSeller(check, screen);
  if (replay.approve === 'refused' || replay.approve !== decision.approve || decision.seller.kind !== 'website' ||
      decision.seller.host !== check.host || !sameList(replay.notices.map(noticeKey), decision.notices.map(noticeKey))) {
    throw new Error('seller_binding_decision_mismatch');
  }
  if (!sameList(decision.notices.map(noticeKey).sort(), input.confirmed.map(noticeKey).sort())) throw new Error('seller_binding_notices_unconfirmed');
  const relation = decision.seller.relation;
  if (relation !== 'known' && relation !== 'first-payment' && relation !== 'unknown') throw new Error('seller_binding_decision_mismatch');
  const known = screen.history === 'loaded' ? screen.known : [];
  // A saved-path binding has no profile; it carries his store's label forward so later R4 checks keep it.
  const label = check.profile?.name ?? known.find((entry) => entry.host === check.host)?.label ?? null;

  return {
    v: SELLER_BINDING_VERSION,
    vault: input.vault,
    counterparty: check.offer.payTo,
    sessionPubkey: screen.sessionPubkey,
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
    label,
    source: check.source,
    savedFrom: check.savedFrom ? { ...check.savedFrom } : null,
    request: { appName: screen.request.appName, expectedHost: screen.request.seller?.expectedHost ?? null },
    history: screen.history,
    knownStores: known.map((entry) => ({ host: entry.host, registerTx: entry.lastRegisterTx, bindingSha256: entry.bindingSha256 }))
      .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)),
    approve: decision.approve,
    replaces: decision.agent.replaces?.sessionPubkey ?? null,
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

type Kind = 'string' | 'number' | 'nullable' | 'object';
const FIELDS: Record<keyof SellerBindingV1, Kind> = {
  v: 'string', vault: 'string', counterparty: 'string', sessionPubkey: 'string', calledUrl: 'string', host: 'string',
  registrableDomain: 'string', did: 'string', kid: 'string', key: 'object', keyThumbprint: 'string',
  didDocumentSha256: 'string', addresses: 'object', addressListSha256: 'string', offerJwsSha256: 'string', offer: 'object',
  label: 'nullable', source: 'string', savedFrom: 'object', request: 'object', history: 'string', knownStores: 'object',
  approve: 'string', replaces: 'nullable', relation: 'string', notices: 'object', checkedAt: 'number', checker: 'string', page: 'string',
};
const OFFER_FIELDS = ['amount', 'asset', 'network', 'payTo', 'resourceUrl', 'scheme', 'validUntil', 'version'];
type Obj = Record<string, unknown>;
const exactKeys = (value: unknown, keys: readonly string[]): value is Obj =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const strings = (value: Obj, keys: string[]) => keys.every((key) => typeof value[key] === 'string');

/** Strict: the bytes must be the canonical encoding of a well-formed binding. Throws otherwise. */
export function decodeSellerBinding(bytes: Uint8Array): SellerBindingV1 {
  if (bytes.length > SELLER_BINDING_MAX_BYTES) throw new Error('seller_binding_too_large');
  const value = parseCanonical(bytes);
  const fail = (): never => { throw new Error('seller_binding_invalid'); };
  if (!exactKeys(value, Object.keys(FIELDS))) fail();
  const b = value as Obj;
  for (const [field, kind] of Object.entries(FIELDS)) {
    const v = b[field];
    if (kind === 'string' && typeof v !== 'string') fail();
    if (kind === 'number' && !Number.isSafeInteger(v)) fail();
    if (kind === 'nullable' && v !== null && typeof v !== 'string') fail();
  }
  if (b.v !== SELLER_BINDING_VERSION || !['live', 'saved'].includes(b.source as string) ||
      !['known', 'first-payment', 'unknown'].includes(b.relation as string) ||
      !['loaded', 'unavailable'].includes(b.history as string) || !['allowed', 'confirm'].includes(b.approve as string)) fail();
  const key = b.key as Obj;
  if (!exactKeys(key, ['crv', 'kty', 'x']) || key.kty !== 'OKP' || key.crv !== 'Ed25519' || typeof key.x !== 'string') fail();
  if (!Array.isArray(b.addresses) || !b.addresses.every((a) => typeof a === 'string')) fail();
  const offer = b.offer as Obj;
  if (!exactKeys(offer, OFFER_FIELDS) || offer.version !== 1 || !Number.isSafeInteger(offer.validUntil) ||
      !strings(offer, ['amount', 'asset', 'network', 'payTo', 'resourceUrl', 'scheme'])) fail();
  const saved = b.savedFrom as Obj | null;
  if ((b.source === 'saved') !== (saved !== null)) fail();
  if (saved !== null && (!exactKeys(saved, ['bindingSha256', 'registerTx']) || !strings(saved, ['bindingSha256', 'registerTx']))) fail();
  const request = b.request as Obj;
  if (!exactKeys(request, ['appName', 'expectedHost']) || typeof request.appName !== 'string' ||
      (request.expectedHost !== null && typeof request.expectedHost !== 'string')) fail();
  if (!Array.isArray(b.knownStores) || !b.knownStores.every((s) => exactKeys(s, ['bindingSha256', 'host', 'registerTx']) &&
      strings(s, ['bindingSha256', 'host', 'registerTx']))) fail();
  if ((b.relation === 'unknown') !== (b.history === 'unavailable')) fail();
  if (!Array.isArray(b.notices) || !b.notices.every((n) => exactKeys(n, ['code', 'confirmed', 'knownHost', 'rule']) &&
      (n.rule === 'R4' || n.rule === 'R5') && typeof n.code === 'string' && typeof n.knownHost === 'string' && n.confirmed === true)) fail();
  if ((b.approve === 'confirm') !== ((b.notices as unknown[]).length > 0)) fail();
  return value as SellerBindingV1;
}

export const sellerBindingSha256 = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

/**
 * The owner's stores, from his own registered approvals. A row is admitted only if its binding decodes strictly,
 * names this vault, and its committed nonce equals sellerBindingNonce(binding, salt). Everything else is skipped.
 * One entry per host: key, addresses and file hash from the latest approval, first approval date from the earliest.
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
      bindingSha256: sellerBindingSha256(entry.binding),
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
