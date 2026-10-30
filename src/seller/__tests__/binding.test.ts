import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import { checkSellerOffer } from '../check';
import { screenSeller } from '../screen';
import { buildSellerBinding, decodeSellerBinding, encodeSellerBinding, knownSellers } from '../binding';
import { sellerBindingNonce } from '../nonce';
import { verifySellerEvidence, verifySellerReceipt, liveSellerStatus } from '../verify';
import { canonicalBytes } from '../jcs';
import type { SellerBindingV1 } from '../types';
import { NOW, REAL, REAL_FILE_URL, keyFrom, offerPayload, request, servedFiles, signJws, storeDocument } from './sellerFixtures';

const VAULT = keyFrom(40).address;
const AGENT = keyFrom(41).address;
const SALT = new Uint8Array(32).fill(9);

async function approval(page = 'dexter-fe@abc123') {
  const req = request();
  const didDocument = storeDocument(REAL);
  const check = await checkSellerOffer(req, { now: NOW, fetchDidDocument: servedFiles({ [REAL_FILE_URL]: didDocument }) });
  if (check.status !== 'signed') throw new Error('fixture');
  const screenInput = { request: req, sessionPubkey: AGENT, known: [], agentKeys: [], history: 'loaded' as const };
  const decision = screenSeller(check, screenInput);
  if (decision.approve === 'refused') throw new Error('fixture');
  const binding = buildSellerBinding({ check, screen: screenInput, decision, vault: VAULT, confirmed: [], page });
  const bytes = encodeSellerBinding(binding);
  return { binding, bytes, didDocument, offerJws: check.offerJws, nonce: sellerBindingNonce(bytes, SALT) };
}

describe('binding', () => {
  it('encodes deterministic RFC 8785 bytes', async () => {
    const a = await approval();
    const b = await approval();
    expect(bytesToHex(a.bytes)).toBe(bytesToHex(b.bytes));
    const text = new TextDecoder().decode(a.bytes);
    expect(text.startsWith('{"addressListSha256":"')).toBe(true);
    expect(text).not.toMatch(/[\n\r\t]|": |, "/);
    expect(decodeSellerBinding(a.bytes)).toEqual(a.binding);
  });
  it('rejects non-ASCII and non-integer values', async () => {
    const { binding } = await approval();
    expect(() => encodeSellerBinding({ ...binding, label: 'Dеxter' })).toThrow();
    expect(() => encodeSellerBinding({ ...binding, checkedAt: 1.5 })).toThrow();
  });
  it('computes the nonce from the 24-byte domain, binding digest and salt', () => {
    const bytes = new TextEncoder().encode('{"v":"x"}');
    const domain = new TextEncoder().encode('DEXTER_SELLER_BINDING_V1');
    expect(domain.length).toBe(24);
    const expected = sha256(concatBytes(domain, sha256(bytes), SALT));
    expect(bytesToHex(sellerBindingNonce(bytes, SALT))).toBe(bytesToHex(expected));
  });
  it('decode refuses non-canonical bytes', async () => {
    const { bytes } = await approval();
    const spaced = new TextEncoder().encode(new TextDecoder().decode(bytes).replace('{"addressListSha256"', '{ "addressListSha256"'));
    expect(() => decodeSellerBinding(spaced)).toThrow();
    const extra = canonicalBytes({ ...decodeSellerBinding(bytes), extra: 'x' });
    expect(() => decodeSellerBinding(extra)).toThrow();
  });
  it('records the page release in page', async () => {
    expect((await approval('dexter-fe@16063bbf')).binding.page).toBe('dexter-fe@16063bbf');
  });
  it('refuses to build a binding whose notices were not all confirmed, or whose decision differs from a rerun', async () => {
    const rotated = { ...REAL, quoteKey: keyFrom(80) };
    const files = servedFiles({ [REAL_FILE_URL]: storeDocument(rotated) });
    const first = await approval();
    const known = knownSellers([{ binding: first.bytes, salt: SALT, ceremonyNonce: first.nonce, registerTx: 'tx1', registeredAt: NOW - 100 }], { vault: VAULT });
    const req = request({ offerJws: signJws({ alg: 'EdDSA', kid: 'did:web:dexter.cash#books-quote-1' }, offerPayload(), rotated.quoteKey.secret) });
    const check = await checkSellerOffer(req, { now: NOW, fetchDidDocument: files, known });
    if (check.status !== 'signed') throw new Error('fixture');
    const screenInput = { request: req, sessionPubkey: AGENT, known, agentKeys: [], history: 'loaded' as const };
    const decision = screenSeller(check, screenInput);
    if (decision.approve !== 'confirm') throw new Error('fixture');
    expect(() => buildSellerBinding({ check, screen: screenInput, decision, vault: VAULT, confirmed: [], page: 'p' })).toThrow('seller_binding_notices_unconfirmed');
    const allowed = { ...decision, approve: 'allowed' as const, notices: [] as [] };
    expect(() => buildSellerBinding({ check, screen: screenInput, decision: allowed, vault: VAULT, confirmed: [], page: 'p' })).toThrow('seller_binding_decision_mismatch');
    const binding = buildSellerBinding({ check, screen: screenInput, decision, vault: VAULT, confirmed: decision.notices, page: 'p' });
    expect(binding).toMatchObject({ approve: 'confirm', history: 'loaded', relation: 'known',
      notices: [{ rule: 'R5', code: 'key_changed', knownHost: 'books.dexter.cash', confirmed: true }],
      knownStores: [{ host: 'books.dexter.cash', registerTx: 'tx1', bindingSha256: known[0].bindingSha256 }] });
  });
});

describe('knownSellers', () => {
  it('a row whose binding does not match its committed nonce is not known', async () => {
    const { bytes, nonce } = await approval();
    const wrong = new Uint8Array(nonce); wrong[0] ^= 1;
    expect(knownSellers([{ binding: bytes, salt: SALT, ceremonyNonce: wrong, registerTx: 't', registeredAt: NOW }], { vault: VAULT })).toEqual([]);
    expect(knownSellers([{ binding: bytes, salt: SALT, ceremonyNonce: nonce, registerTx: 't', registeredAt: NOW }], { vault: VAULT })).toHaveLength(1);
  });
  it('a row for another vault is ignored', async () => {
    const { bytes, nonce } = await approval();
    expect(knownSellers([{ binding: bytes, salt: SALT, ceremonyNonce: nonce, registerTx: 't', registeredAt: NOW }], { vault: keyFrom(43).address })).toEqual([]);
  });
  it('keeps the first approval date and the latest key per host', async () => {
    const { bytes, nonce } = await approval();
    const rows = [
      { binding: bytes, salt: SALT, ceremonyNonce: nonce, registerTx: 'later', registeredAt: NOW + 10 },
      { binding: bytes, salt: SALT, ceremonyNonce: nonce, registerTx: 'first', registeredAt: NOW },
    ];
    expect(knownSellers(rows, { vault: VAULT })).toMatchObject([{ host: 'books.dexter.cash', firstApprovedAt: NOW, lastApprovedAt: NOW + 10, lastRegisterTx: 'later', label: 'Dexter Bookstore' }]);
  });
});

describe('after the fact', () => {
  const registration = { vault: VAULT, counterparty: REAL.receiving[0].address, sessionPubkey: AGENT };

  it('verifySellerEvidence passes on the approval record and fails on each one-field change', async () => {
    const a = await approval();
    const base = { binding: a.bytes, salt: SALT, ceremonyNonce: a.nonce, didDocument: a.didDocument, offerJws: a.offerJws, registration };
    const ok = await verifySellerEvidence(base);
    expect(ok.verified).toBe(true);
    expect(ok.checks.map((c) => c.name)).toEqual(['binding_bytes', 'registration_match', 'commitment', 'did_document_hash',
      'did_document_valid', 'key_listed', 'host_listed', 'offer_signature', 'offer_terms', 'payto_listed', 'address_proofs']);

    const flip = (bytes: Uint8Array) => { const c = new Uint8Array(bytes); c[c.length - 1] ^= 1; return c; };
    const rebind = (edit: Partial<SellerBindingV1>) => encodeSellerBinding({ ...a.binding, ...edit });
    const cases: Array<[string, Partial<typeof base>, string]> = [
      ['salt', { salt: flip(SALT) }, 'commitment'],
      ['nonce', { ceremonyNonce: flip(a.nonce) }, 'commitment'],
      ['vault', { registration: { ...registration, vault: keyFrom(43).address } }, 'registration_match'],
      ['counterparty', { registration: { ...registration, counterparty: keyFrom(44).address } }, 'registration_match'],
      ['agent', { registration: { ...registration, sessionPubkey: keyFrom(45).address } }, 'registration_match'],
      ['file', { didDocument: storeDocument({ ...REAL, receiving: [REAL.receiving[0], keyFrom(46)] }) }, 'did_document_hash'],
      ['quote', { offerJws: signJws({ alg: 'EdDSA', kid: 'did:web:dexter.cash#books-quote-1' }, { ...a.binding.offer, amount: '2000000' }, REAL.quoteKey.secret) }, 'offer_signature'],
      ['binding host', { binding: rebind({ host: 'shop.dexter.cash' }) }, 'commitment'],
    ];
    for (const [name, change, failing] of cases) {
      const result = await verifySellerEvidence({ ...base, ...change });
      expect(result.verified, name).toBe(false);
      expect(result.checks.find((c) => c.name === failing)?.ok, `${name} -> ${failing}`).toBe(false);
    }
  });

  it('verifySellerReceipt refuses a receipt for another book, payer or time', async () => {
    const didDocument = storeDocument(REAL);
    const kid = 'did:web:dexter.cash#books-quote-1';
    const payload = { issuedAt: NOW, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', payer: VAULT, resourceUrl: 'https://books.dexter.cash/books/meditations', version: 1 };
    const expected = { resourceUrl: payload.resourceUrl, payer: VAULT, network: payload.network, issuedAtMin: NOW - 120, issuedAtMax: NOW + 120 };
    const receipt = (p = payload, secret = REAL.quoteKey.secret) => signJws({ alg: 'EdDSA', kid }, p, secret);
    expect(await verifySellerReceipt({ receiptJws: receipt(), didDocument, kid, expected })).toMatchObject({ ok: true });
    expect(await verifySellerReceipt({ receiptJws: receipt({ ...payload, resourceUrl: 'https://books.dexter.cash/books/the-prince' }), didDocument, kid, expected })).toEqual({ ok: false, code: 'receipt_terms_mismatch' });
    expect(await verifySellerReceipt({ receiptJws: receipt({ ...payload, payer: keyFrom(47).address }), didDocument, kid, expected })).toEqual({ ok: false, code: 'receipt_terms_mismatch' });
    expect(await verifySellerReceipt({ receiptJws: receipt({ ...payload, issuedAt: NOW + 121 }), didDocument, kid, expected })).toEqual({ ok: false, code: 'receipt_time_out_of_range' });
    expect(await verifySellerReceipt({ receiptJws: receipt(payload, keyFrom(48).secret), didDocument, kid, expected })).toEqual({ ok: false, code: 'receipt_signature_invalid' });
  });

  it('liveSellerStatus reports still listed, changed, removed and unreadable', async () => {
    const { binding } = await approval();
    const status = (file?: Uint8Array) => liveSellerStatus(binding, { fetchDidDocument: servedFiles(file ? { [REAL_FILE_URL]: file } : {}) });
    expect(await status(storeDocument(REAL))).toBe('still_listed');
    expect(await status(storeDocument({ ...REAL, receiving: [REAL.receiving[0], keyFrom(49)] }))).toBe('changed');
    expect(await status(storeDocument({ ...REAL, hosts: ['shop.dexter.cash'] }))).toBe('removed');
    expect(await status()).toBe('unreadable');
  });

  it('a saved-path approval verifies through the earlier approval it names, and not without it', async () => {
    const first = await approval();
    const firstEntry = { binding: first.bytes, salt: SALT, ceremonyNonce: first.nonce, registerTx: 'tx-first', registeredAt: NOW - 100 };
    const known = knownSellers([firstEntry], { vault: VAULT });
    const req = request();
    const check = await checkSellerOffer(req, { now: NOW, fetchDidDocument: servedFiles({}), known });
    if (check.status !== 'signed' || check.source !== 'saved') throw new Error('fixture');
    const screenInput = { request: req, sessionPubkey: AGENT, known, agentKeys: [], history: 'loaded' as const };
    const decision = screenSeller(check, screenInput);
    if (decision.approve !== 'allowed') throw new Error('fixture');
    const bytes = encodeSellerBinding(buildSellerBinding({ check, screen: screenInput, decision, vault: VAULT, confirmed: [], page: 'p' }));
    const salt = new Uint8Array(32).fill(4);
    const earlier = { binding: first.bytes, salt: SALT, ceremonyNonce: first.nonce, didDocument: first.didDocument, offerJws: first.offerJws, registration };
    const base = { binding: bytes, salt, ceremonyNonce: sellerBindingNonce(bytes, salt), didDocument: null, offerJws: check.offerJws, registration };
    const ok = await verifySellerEvidence({ ...base, saved: { registerTx: 'tx-first', registeredAt: NOW - 100, evidence: earlier }, history: [firstEntry] });
    expect(ok.verified).toBe(true);
    expect(ok.binding?.label).toBe('Dexter Bookstore');
    expect(ok.checks.find((c) => c.name === 'saved_basis')?.ok).toBe(true);
    expect((await verifySellerEvidence(base)).verified).toBe(false);
    const tampered = { ...earlier, didDocument: storeDocument({ ...REAL, receiving: [REAL.receiving[0], keyFrom(50)] }) };
    expect((await verifySellerEvidence({ ...base, saved: { registerTx: 'tx-first', registeredAt: NOW - 100, evidence: tampered } })).verified).toBe(false);
    expect((await verifySellerEvidence({ ...base, saved: { registerTx: 'tx-other', registeredAt: NOW - 100, evidence: earlier } })).verified).toBe(false);
  });

  it('replays the screen decision from the history bindings the approval names', async () => {
    const first = await approval();
    const firstEntry = { binding: first.bytes, salt: SALT, ceremonyNonce: first.nonce, registerTx: 'tx-first', registeredAt: NOW - 100 };
    const known = knownSellers([firstEntry], { vault: VAULT });
    const rotated = { ...REAL, quoteKey: keyFrom(80) };
    const didDocument = storeDocument(rotated);
    const req = request({ offerJws: signJws({ alg: 'EdDSA', kid: 'did:web:dexter.cash#books-quote-1' }, offerPayload(), rotated.quoteKey.secret) });
    const check = await checkSellerOffer(req, { now: NOW, fetchDidDocument: servedFiles({ [REAL_FILE_URL]: didDocument }), known });
    if (check.status !== 'signed') throw new Error('fixture');
    const screenInput = { request: req, sessionPubkey: AGENT, known, agentKeys: [], history: 'loaded' as const };
    const decision = screenSeller(check, screenInput);
    if (decision.approve !== 'confirm') throw new Error('fixture');
    const bytes = encodeSellerBinding(buildSellerBinding({ check, screen: screenInput, decision, vault: VAULT, confirmed: decision.notices, page: 'p' }));
    const base = { binding: bytes, salt: SALT, ceremonyNonce: sellerBindingNonce(bytes, SALT), didDocument, offerJws: check.offerJws, registration };
    const replay = (history: typeof firstEntry[]) => verifySellerEvidence({ ...base, history }).then((r) => r.checks.find((c) => c.name === 'screen_decision'));
    expect(await replay([firstEntry])).toMatchObject({ ok: true, detail: 'replayed: confirm with R5:key_changed:books.dexter.cash' });
    expect((await replay([]))?.ok).toBe(false);
    expect((await verifySellerEvidence(base)).checks.some((c) => c.name === 'screen_decision')).toBe(false);
  });
});
