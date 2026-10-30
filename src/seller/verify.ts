import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { decodeSellerBinding, knownSellers, sellerBindingSha256 } from './binding';
import { screenSeller } from './screen';
import { checkSellerOffer } from './check';
import { verifyEd25519Strict } from './ed25519';
import { defaultFetchDidDocument } from './fetch';
import { addressListSha256, parseSellerDocument, profileForHost } from './document';
import { parseDidWebKid } from './host';
import { decodeCompactJws } from './jws';
import { ed25519JwkToBytes, jwkThumbprint } from './jwk';
import { sellerBindingNonce } from './nonce';
import { SOLANA_MAINNET, USDC_MINT } from './types';
import type {
  FetchDidDocument, KnownSeller, R1Code, R2Code, SellerBindingV1, SellerCheck, SellerEvidenceCheck, SellerHistoryEntry, SellerRequest,
} from './types';

type CheckName = SellerEvidenceCheck['name'];
const FILE_CHECKS: CheckName[] = ['did_document_valid', 'key_listed', 'host_listed', 'offer_signature', 'offer_terms', 'payto_listed', 'address_proofs'];

/** Which evidence row a re-run refusal lands on. */
const REFUSAL_ROW: Record<R1Code | R2Code | 'expected_host_mismatch', CheckName> = {
  called_url_invalid: 'offer_terms', offer_format_unsupported: 'offer_signature', offer_malformed: 'offer_signature',
  offer_alg_unsupported: 'offer_signature', kid_not_did_url: 'key_listed', did_method_unsupported: 'key_listed',
  resource_url_invalid: 'offer_terms', resource_host_mismatch: 'offer_terms', resource_url_mismatch: 'offer_terms', did_not_registrable_domain: 'key_listed',
  offer_terms_mismatch: 'offer_terms', offer_validity_missing: 'offer_terms', offer_expired: 'offer_terms',
  offer_validity_too_long: 'offer_terms', did_document_invalid: 'did_document_valid', host_not_listed: 'host_listed',
  kid_not_listed: 'key_listed', key_invalid: 'did_document_valid', signature_invalid: 'offer_signature',
  payto_mismatch: 'offer_terms', payto_not_listed: 'payto_listed', address_proof_invalid: 'address_proofs',
  expected_host_mismatch: 'offer_terms',
};

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export interface SellerEvidenceInput {
  binding: Uint8Array;
  salt: Uint8Array;
  /** From the finalized approval's clientDataJSON, bytes 168-200 (vault SDK MandateApproval.ceremonyNonce, hex; the caller converts). */
  ceremonyNonce: Uint8Array;
  /** The exact store file fetched at approval; null when the binding's source is 'saved' (the database stores NULL). */
  didDocument: Uint8Array | null;
  offerJws: string;
  registration: { vault: string; counterparty: string; sessionPubkey: string };
  /** source = 'saved': the earlier approval named in the binding's savedFrom, with its own evidence (recursively). */
  saved?: { registerTx: string; registeredAt: number; evidence: SellerEvidenceInput };
  /** The owner's history bindings as served at approval time; when given, the screen decision is replayed. */
  history?: readonly SellerHistoryEntry[];
}

/**
 * After the fact: proves that a stored binding is what the passkey committed to and that it holds against the saved store
 * file and quote. The seller rules run once, through checkSellerOffer and screenSeller at the binding's checkedAt with the
 * saved bytes; this function only compares their results with the binding. A saved-path binding is proven through the
 * earlier approval it names: that approval's own evidence must verify and supply this key, file hash and address list.
 */
export async function verifySellerEvidence(input: SellerEvidenceInput):
  Promise<{ verified: boolean; binding: SellerBindingV1 | null; checks: SellerEvidenceCheck[] }> {
  const checks: SellerEvidenceCheck[] = [];
  const add = (name: CheckName, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); };
  const done = (binding: SellerBindingV1 | null) => ({ verified: binding !== null && checks.every((c) => c.ok), binding, checks });

  let binding: SellerBindingV1;
  try {
    binding = decodeSellerBinding(input.binding);
    add('binding_bytes', true, `${input.binding.length} canonical bytes, sha256 ${sellerBindingSha256(input.binding)}`);
  } catch (error) {
    add('binding_bytes', false, error instanceof Error ? error.message : 'seller_binding_invalid');
    return done(null);
  }

  const r = input.registration;
  const mismatched = [
    binding.vault !== r.vault && 'vault',
    binding.counterparty !== r.counterparty && 'counterparty',
    binding.sessionPubkey !== r.sessionPubkey && 'agent key',
  ].filter(Boolean);
  add('registration_match', mismatched.length === 0,
    mismatched.length ? `differs from the registration: ${mismatched.join(', ')}` : 'vault, counterparty and agent key equal the registration');

  let committed = false;
  try { committed = equalBytes(sellerBindingNonce(input.binding, input.salt), input.ceremonyNonce); } catch { committed = false; }
  add('commitment', committed, committed ? "sellerBindingNonce(binding, salt) equals the approval's ceremony nonce" : "the recomputed nonce differs from the approval's ceremony nonce");

  const offerHashOk = bytesToHex(sha256(new TextEncoder().encode(input.offerJws))) === binding.offerJwsSha256;
  const request: SellerRequest = {
    counterparty: binding.counterparty, appName: binding.request.appName,
    seller: { calledUrl: binding.calledUrl, offer: { format: 'jws', signature: input.offerJws },
      ...(binding.request.expectedHost !== null ? { expectedHost: binding.request.expectedHost } : {}) },
    scheme: 'tab', network: SOLANA_MAINNET, asset: USDC_MINT,
  };
  let rerun: SellerCheck;

  if (binding.source === 'saved') {
    const basis = await savedBasis(binding, input);
    add('saved_basis', basis.ok, basis.detail);
    if (!basis.known) {
      for (const name of FILE_CHECKS) add(name, false, 'not reached: the earlier approval did not verify');
      return done(binding);
    }
    add('did_document_hash', binding.didDocumentSha256 === basis.known.didDocumentSha256,
      `the earlier approval at ${basis.known.lastRegisterTx} recorded file sha256 ${basis.known.didDocumentSha256}`);
    rerun = await checkSellerOffer(request, {
      now: binding.checkedAt, known: [basis.known], fetchDidDocument: async () => { throw new Error('saved path: no file'); },
    });
  } else {
    if (input.didDocument === null) {
      add('did_document_hash', false, 'the store file is missing from the evidence');
      for (const name of FILE_CHECKS) add(name, false, 'not reached without the store file');
      return done(binding);
    }
    const docHash = bytesToHex(sha256(input.didDocument));
    add('did_document_hash', docHash === binding.didDocumentSha256,
      docHash === binding.didDocumentSha256 ? `sha256 ${docHash} equals the binding` : `sha256 ${docHash} differs from the binding's ${binding.didDocumentSha256}`);
    const file = input.didDocument;
    rerun = await checkSellerOffer(request, { now: binding.checkedAt, fetchDidDocument: async () => file });
  }

  if (rerun.status !== 'signed') {
    const failed = rerun.status === 'refused' ? REFUSAL_ROW[rerun.refusal.code] : 'did_document_valid';
    const detail = rerun.status === 'refused' ? `${rerun.refusal.rule} ${rerun.refusal.code}: ${rerun.refusal.detail}` : `the saved file did not parse (${rerun.reason})`;
    let reached = true;
    for (const name of FILE_CHECKS) {
      if (name === failed) { add(name, false, detail); reached = false; }
      else add(name, reached, reached ? 'passed before the failing check' : 'not reached');
    }
    return done(binding);
  }

  const fromEarlier = binding.source === 'saved' ? ` (from the approval at ${binding.savedFrom?.registerTx})` : '';
  const keyOk = rerun.kid === binding.kid && rerun.did === binding.did && rerun.keyThumbprint === binding.keyThumbprint &&
    rerun.key.x === binding.key.x && jwkThumbprint(binding.key) === binding.keyThumbprint;
  const termsOk = offerHashOk && rerun.host === binding.host && rerun.registrableDomain === binding.registrableDomain &&
    rerun.calledUrl === binding.calledUrl && JSON.stringify(rerun.offer) === JSON.stringify(binding.offer) && rerun.offer.payTo === binding.counterparty;
  const listOk = rerun.addressListSha256 === binding.addressListSha256 && rerun.didDocumentSha256 === binding.didDocumentSha256 &&
    rerun.addresses.length === binding.addresses.length && rerun.addresses.every((a, i) => a === binding.addresses[i]);

  add('did_document_valid', true, `${binding.did}'s file meets the store-file rules${fromEarlier}`);
  add('key_listed', keyOk, keyOk ? `${binding.kid} is listed and is the key in the binding${fromEarlier}` : 'the listed key differs from the binding');
  add('host_listed', true, `${binding.registrableDomain}'s file lists ${binding.host}${fromEarlier}`);
  add('offer_signature', offerHashOk, offerHashOk ? 'the quote verifies under the listed key and its hash equals the binding' : 'the quote differs from the one in the binding');
  add('offer_terms', termsOk, termsOk ? `the quote names ${binding.counterparty} for ${binding.offer.resourceUrl}, valid at ${binding.checkedAt}` : 'the quote terms differ from the binding');
  add('payto_listed', listOk, listOk ? `${binding.counterparty} is in the file's address list${fromEarlier}` : 'the address list differs from the binding');
  add('address_proofs', true, `every listed address carries a valid control proof${fromEarlier}`);

  if (input.history) {
    const refs = new Set(binding.knownStores.map((s) => s.bindingSha256));
    const entries = input.history.filter((entry) => refs.has(sellerBindingSha256(entry.binding)));
    const known = knownSellers(entries, { vault: binding.vault });
    const sameStores = JSON.stringify(known.map((k) => [k.host, k.lastRegisterTx, k.bindingSha256]).sort()) ===
      JSON.stringify(binding.knownStores.map((s) => [s.host, s.registerTx, s.bindingSha256]).sort());
    const decision = screenSeller(rerun, { request, sessionPubkey: binding.sessionPubkey, known, agentKeys: [],
      liveSessionKey: binding.replaces, history: binding.history });
    const notices = decision.approve === 'refused' ? null : decision.notices.map((n) => `${n.rule}:${n.code}:${n.knownHost}`).sort();
    const sameDecision = decision.approve === binding.approve && notices !== null &&
      JSON.stringify(notices) === JSON.stringify(binding.notices.map((n) => `${n.rule}:${n.code}:${n.knownHost}`).sort());
    add('screen_decision', sameStores && sameDecision, !sameStores ? 'the supplied history is not exactly the stores the binding names'
      : sameDecision ? `replayed: ${binding.approve}${notices?.length ? ` with ${notices.join(', ')}` : ''}` : `replayed ${decision.approve}, the binding says ${binding.approve}`);
  }

  return done(binding);
}

/** The earlier approval a saved-path binding names: its evidence must verify, for the same vault, and be the binding savedFrom names. */
async function savedBasis(binding: SellerBindingV1, input: SellerEvidenceInput): Promise<{ ok: boolean; detail: string; known: KnownSeller | null }> {
  const saved = input.saved;
  if (!binding.savedFrom || !saved) return { ok: false, detail: 'the earlier approval this check relied on is missing from the evidence', known: null };
  if (saved.registerTx !== binding.savedFrom.registerTx || sellerBindingSha256(saved.evidence.binding) !== binding.savedFrom.bindingSha256) {
    return { ok: false, detail: 'the supplied earlier approval is not the one the binding names', known: null };
  }
  const earlier = await verifySellerEvidence(saved.evidence);
  const known = knownSellers([{ binding: saved.evidence.binding, salt: saved.evidence.salt, ceremonyNonce: saved.evidence.ceremonyNonce,
    registerTx: saved.registerTx, registeredAt: saved.registeredAt }], { vault: binding.vault })[0] ?? null;
  if (!earlier.verified || !known || known.host !== binding.host) {
    return { ok: false, detail: `the earlier approval at ${saved.registerTx} does not verify for this vault and host`, known: null };
  }
  return { ok: true, detail: `the approval at ${saved.registerTx} verifies and supplied this key, file hash and address list`, known };
}

const RECEIPT_FIELDS = ['issuedAt', 'network', 'payer', 'resourceUrl', 'version'];

/** A store-signed x402 receipt, checked against the store file and the expected order. */
export async function verifySellerReceipt(input: {
  receiptJws: string;
  didDocument: Uint8Array;
  kid: string;
  expected: { resourceUrl: string; payer: string; network: string; issuedAtMin: number; issuedAtMax: number };
}): Promise<
  | { ok: true; payload: { version: 1; network: string; resourceUrl: string; payer: string; issuedAt: number } }
  | { ok: false; code: 'receipt_malformed' | 'receipt_kid_mismatch' | 'receipt_signature_invalid' | 'receipt_terms_mismatch' | 'receipt_time_out_of_range' }
> {
  const jws = decodeCompactJws(input.receiptJws);
  if (typeof jws === 'string' || jws.header.alg !== 'EdDSA') return { ok: false, code: 'receipt_malformed' };
  const p = jws.payload as Record<string, unknown>;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).sort().join(',') !== RECEIPT_FIELDS.join(',') ||
      p.version !== 1 || !Number.isSafeInteger(p.issuedAt) ||
      typeof p.network !== 'string' || typeof p.payer !== 'string' || typeof p.resourceUrl !== 'string') return { ok: false, code: 'receipt_malformed' };
  if (jws.header.kid !== input.kid) return { ok: false, code: 'receipt_kid_mismatch' };
  const kid = parseDidWebKid(input.kid);
  if (typeof kid === 'string') return { ok: false, code: 'receipt_kid_mismatch' };
  const parsed = parseSellerDocument(input.didDocument, kid.did);
  if (typeof parsed === 'string') return { ok: false, code: 'receipt_signature_invalid' };
  const method = parsed.doc.verificationMethod.find((entry) => entry.id === input.kid);
  if (!method || !parsed.doc.assertionMethod.includes(input.kid)) return { ok: false, code: 'receipt_kid_mismatch' };
  if (!verifyEd25519Strict(jws.signature, jws.signingInput, ed25519JwkToBytes(method.publicKeyJwk))) return { ok: false, code: 'receipt_signature_invalid' };
  if (p.resourceUrl !== input.expected.resourceUrl || p.payer !== input.expected.payer || p.network !== input.expected.network) {
    return { ok: false, code: 'receipt_terms_mismatch' };
  }
  const issuedAt = p.issuedAt as number;
  if (issuedAt < input.expected.issuedAtMin || issuedAt > input.expected.issuedAtMax) return { ok: false, code: 'receipt_time_out_of_range' };
  return { ok: true, payload: { version: 1, network: p.network, resourceUrl: p.resourceUrl, payer: p.payer, issuedAt } };
}

/** What the store's file says now about the key and address in a binding. Never used to admit or refuse anything. */
export async function liveSellerStatus(binding: SellerBindingV1, options: { fetchDidDocument?: FetchDidDocument } = {}):
  Promise<'still_listed' | 'changed' | 'removed' | 'unreadable'> {
  let bytes: Uint8Array;
  try {
    bytes = await (options.fetchDidDocument ?? defaultFetchDidDocument)(`https://${binding.registrableDomain}/.well-known/did.json`);
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return 'unreadable';
  }
  const parsed = parseSellerDocument(bytes, binding.did);
  if (typeof parsed === 'string') return 'changed';
  const profile = profileForHost(parsed, binding.host);
  if (typeof profile === 'string') return 'removed';
  const method = parsed.doc.verificationMethod.find((entry) => entry.id === binding.kid);
  const listed = profile.payTo.some((entry) => entry.address === binding.counterparty &&
    entry.network === binding.offer.network && entry.asset === binding.offer.asset);
  if (!method || !profile.signingKeys.includes(binding.kid) || !parsed.doc.assertionMethod.includes(binding.kid) || !listed) return 'removed';
  if (method.publicKeyJwk.x !== binding.key.x || addressListSha256(profile.payTo) !== binding.addressListSha256) return 'changed';
  return 'still_listed';
}
