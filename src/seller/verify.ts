import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { decodeSellerBinding } from './binding';
import { checkSellerOffer } from './check';
import { verifyEd25519Strict } from './ed25519';
import { defaultFetchDidDocument } from './fetch';
import { addressListSha256, parseSellerDocument, profileForHost } from './document';
import { parseDidWebKid } from './host';
import { decodeCompactJws } from './jws';
import { ed25519JwkToBytes, jwkThumbprint } from './jwk';
import { sellerBindingNonce } from './nonce';
import { SOLANA_MAINNET, USDC_MINT } from './types';
import type { FetchDidDocument, R1Code, R2Code, SellerBindingV1, SellerEvidenceCheck } from './types';

type CheckName = SellerEvidenceCheck['name'];
const FILE_CHECKS: CheckName[] = ['did_document_valid', 'key_listed', 'host_listed', 'offer_signature', 'offer_terms', 'payto_listed', 'address_proofs'];

/** Which evidence row a re-run refusal lands on. */
const REFUSAL_ROW: Record<R1Code | R2Code | 'expected_host_mismatch', CheckName> = {
  called_url_invalid: 'offer_terms', offer_format_unsupported: 'offer_signature', offer_malformed: 'offer_signature',
  offer_alg_unsupported: 'offer_signature', kid_not_did_url: 'key_listed', did_method_unsupported: 'key_listed',
  resource_url_invalid: 'offer_terms', resource_host_mismatch: 'offer_terms', did_not_registrable_domain: 'key_listed',
  offer_terms_mismatch: 'offer_terms', offer_validity_missing: 'offer_terms', offer_expired: 'offer_terms',
  offer_validity_too_long: 'offer_terms', did_document_invalid: 'did_document_valid', host_not_listed: 'host_listed',
  kid_not_listed: 'key_listed', key_invalid: 'did_document_valid', signature_invalid: 'offer_signature',
  payto_mismatch: 'offer_terms', payto_not_listed: 'payto_listed', address_proof_invalid: 'address_proofs',
  expected_host_mismatch: 'offer_terms',
};

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * After the fact: proves that a stored binding is what the passkey committed to and that it holds against the saved
 * store file and quote. The seller rules run once, through checkSellerOffer at the binding's checkedAt, served the
 * saved bytes; this function only compares its result with the binding.
 */
export async function verifySellerEvidence(input: {
  binding: Uint8Array;
  salt: Uint8Array;
  ceremonyNonce: Uint8Array;
  didDocument: Uint8Array | null;
  offerJws: string;
  registration: { vault: string; counterparty: string; sessionPubkey: string };
}): Promise<{ verified: boolean; binding: SellerBindingV1 | null; checks: SellerEvidenceCheck[] }> {
  const checks: SellerEvidenceCheck[] = [];
  const add = (name: CheckName, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); };

  let binding: SellerBindingV1;
  try {
    binding = decodeSellerBinding(input.binding);
    add('binding_bytes', true, `${input.binding.length} canonical bytes, sha256 ${bytesToHex(sha256(input.binding))}`);
  } catch (error) {
    add('binding_bytes', false, error instanceof Error ? error.message : 'seller_binding_invalid');
    return { verified: false, binding: null, checks };
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
  add('commitment', committed, committed ? 'sellerBindingNonce(binding, salt) equals the approval\'s ceremony nonce' : 'the recomputed nonce differs from the approval\'s ceremony nonce');

  const offerHashOk = bytesToHex(sha256(new TextEncoder().encode(input.offerJws))) === binding.offerJwsSha256;

  if (input.didDocument === null) {
    // Saved source: the database keeps no file. The file rows are not applicable and the binding cannot pass on them.
    add('did_document_hash', false, binding.source === 'saved'
      ? 'not applicable: the store file did not load at approval; the check used the key and addresses from his last approval'
      : 'the store file is missing from the evidence');
    for (const name of FILE_CHECKS) add(name, false, 'not applicable without the store file');
    return { verified: false, binding, checks };
  }

  const docHash = bytesToHex(sha256(input.didDocument));
  add('did_document_hash', docHash === binding.didDocumentSha256,
    docHash === binding.didDocumentSha256 ? `sha256 ${docHash} equals the binding` : `sha256 ${docHash} differs from the binding's ${binding.didDocumentSha256}`);

  const rerun = await checkSellerOffer(
    {
      counterparty: binding.counterparty, appName: '',
      seller: { calledUrl: binding.calledUrl, offer: { format: 'jws', signature: input.offerJws } },
      scheme: 'tab', network: SOLANA_MAINNET, asset: USDC_MINT,
    },
    { now: binding.checkedAt, fetchDidDocument: async () => input.didDocument as Uint8Array },
  );

  if (rerun.status !== 'signed') {
    const failed = rerun.status === 'refused' ? REFUSAL_ROW[rerun.refusal.code] : 'did_document_valid';
    const detail = rerun.status === 'refused' ? `${rerun.refusal.rule} ${rerun.refusal.code}: ${rerun.refusal.detail}` : `the saved file did not parse (${rerun.reason})`;
    let reached = true;
    for (const name of FILE_CHECKS) {
      if (name === failed) { add(name, false, detail); reached = false; }
      else add(name, reached, reached ? 'passed before the failing check' : 'not reached');
    }
    return { verified: false, binding, checks };
  }

  const keyOk = rerun.kid === binding.kid && rerun.did === binding.did && rerun.keyThumbprint === binding.keyThumbprint &&
    rerun.key.x === binding.key.x && jwkThumbprint(binding.key) === binding.keyThumbprint;
  const termsOk = offerHashOk && rerun.host === binding.host && rerun.registrableDomain === binding.registrableDomain &&
    JSON.stringify(rerun.offer) === JSON.stringify(binding.offer) && rerun.offer.payTo === binding.counterparty;
  const listOk = rerun.addressListSha256 === binding.addressListSha256 &&
    rerun.addresses.length === binding.addresses.length && rerun.addresses.every((a, i) => a === binding.addresses[i]);

  add('did_document_valid', true, `${binding.did}'s file meets the store-file rules`);
  add('key_listed', keyOk, keyOk ? `${binding.kid} is listed and is the key in the binding` : 'the listed key differs from the binding');
  add('host_listed', true, `${binding.registrableDomain}'s file lists ${binding.host}`);
  add('offer_signature', offerHashOk, offerHashOk ? 'the quote verifies under the listed key and its hash equals the binding' : 'the quote differs from the one in the binding');
  add('offer_terms', termsOk, termsOk ? `the quote names ${binding.counterparty} on ${binding.host}, valid at ${binding.checkedAt}` : 'the quote terms differ from the binding');
  add('payto_listed', listOk, listOk ? `${binding.counterparty} is in the file's address list` : 'the address list differs from the binding');
  add('address_proofs', true, 'every listed address carries a valid control proof');

  return { verified: checks.every((c) => c.ok), binding, checks };
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
