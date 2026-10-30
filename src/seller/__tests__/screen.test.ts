import { describe, expect, it } from 'vitest';
import { checkSellerOffer } from '../check';
import { screenSeller } from '../screen';
import { buildSellerBinding, encodeSellerBinding, knownSellers } from '../binding';
import { sellerBindingNonce } from '../nonce';
import type { KnownSeller, ScreenDecision, SellerRequest } from '../types';
import {
  IMPOSTOR, IMPOSTOR_FILE_URL, NOW, REAL, REAL_FILE_URL, keyFrom, offerPayload, quote, request, servedFiles, storeDocument,
} from './sellerFixtures';

const VAULT = keyFrom(40).address;
const AGENT = keyFrom(41).address;
const files = (overrides: Record<string, Uint8Array> = {}) => servedFiles({
  [REAL_FILE_URL]: storeDocument(REAL), [IMPOSTOR_FILE_URL]: storeDocument(IMPOSTOR), ...overrides,
});

/** His store, exactly as his own committed approval of books.dexter.cash records it. */
async function realStoreHistory(): Promise<KnownSeller[]> {
  const req = request();
  const check = await checkSellerOffer(req, { now: NOW, fetchDidDocument: files() });
  if (check.status !== 'signed') throw new Error('fixture');
  const decision = screenSeller(check, { request: req, sessionPubkey: AGENT, known: [], agentKeys: [], history: 'loaded' });
  if (decision.approve !== 'allowed') throw new Error('fixture');
  const bytes = encodeSellerBinding(buildSellerBinding({ check, decision, vault: VAULT, sessionPubkey: AGENT, confirmed: [], page: 'dexter-fe@test' }));
  const salt = new Uint8Array(32).fill(3);
  return knownSellers([{ binding: bytes, salt, ceremonyNonce: sellerBindingNonce(bytes, salt), registerTx: 'tx-approve', registeredAt: NOW - 86_000 }], { vault: VAULT });
}

async function screen(req: SellerRequest, known: KnownSeller[], extra: Partial<Parameters<typeof screenSeller>[1]> = {}, fetched = files()): Promise<ScreenDecision> {
  const check = await checkSellerOffer(req, { now: NOW, fetchDidDocument: fetched, known });
  return screenSeller(check, { request: req, sessionPubkey: AGENT, known, agentKeys: [], history: 'loaded', ...extra });
}

const impostorAddress = IMPOSTOR.receiving[0].address;
const v1 = () => request({
  counterparty: impostorAddress, calledUrl: 'https://dexter-bookstore.pages.dev/books/meditations',
  offerJws: quote({ kid: 'did:web:dexter-bookstore.pages.dev#books-quote-1', secret: IMPOSTOR.quoteKey.secret,
    payload: offerPayload({ payTo: impostorAddress, resourceUrl: 'https://dexter-bookstore.pages.dev/books/meditations' }) }),
});
const v4 = () => request({ counterparty: impostorAddress, appName: 'Dexter Bookstore', calledUrl: 'https://dexter-bookstore.pages.dev/books/meditations', offerJws: null });
const v5 = () => request({ counterparty: impostorAddress, offerJws: null });
const signedBy = (host: string, seed: number) => {
  const domain = host.split('.').slice(-2).join('.');
  const spec = { domain, hosts: [host], name: 'Books', quoteKey: keyFrom(seed), receiving: [keyFrom(seed + 1)] };
  const url = `https://${host}/books/meditations`;
  return {
    file: { [`https://${domain}/.well-known/did.json`]: storeDocument(spec) },
    req: request({ counterparty: spec.receiving[0].address, calledUrl: url,
      offerJws: quote({ kid: `did:web:${domain}#books-quote-1`, secret: spec.quoteKey.secret, payload: offerPayload({ payTo: spec.receiving[0].address, resourceUrl: url }) }) }),
  };
};

describe('screenSeller: first contact and the real store', () => {
  it('a signed books.dexter.cash request shows the website, first payment, the agent key and Approve', async () => {
    const decision = await screen(request(), []);
    expect(decision).toMatchObject({
      approve: 'allowed',
      seller: { kind: 'website', host: 'books.dexter.cash', mutedPrefix: 'books.', boldDomain: 'dexter.cash', relation: 'first-payment', address: REAL.receiving[0].address },
      agent: { sessionPubkey: AGENT, relation: 'new', claimedName: 'Claude' },
    });
  });
  it('his store again is known, with the date of his first approval', async () => {
    const decision = await screen(request(), await realStoreHistory());
    expect(decision).toMatchObject({ approve: 'allowed', seller: { relation: 'known', knownSince: NOW - 86_000 } });
  });
});

describe('screenSeller: R4', () => {
  it('flags a same-name store on another domain once the owner uses the real store', async () => {
    const decision = await screen(v1(), await realStoreHistory());
    expect(decision.approve).toBe('confirm');
    if (decision.approve !== 'confirm') return;
    expect(decision.notices).toEqual([{ rule: 'R4', code: 'lookalike_name', knownHost: 'books.dexter.cash', knownLabel: 'Dexter Bookstore', matched: 'Dexter Bookstore' }]);
    expect(decision.seller).toMatchObject({ kind: 'website', host: 'dexter-bookstore.pages.dev', relation: 'first-payment' });
  });
  it('does not flag it at first contact', async () => {
    const decision = await screen(v1(), []);
    expect(decision).toMatchObject({ approve: 'allowed', seller: { host: 'dexter-bookstore.pages.dev', relation: 'first-payment' } });
  });
  it('flags a Cyrillic-e lookalike host', async () => {
    const { file, req } = signedBy('books.xn--dextr-2we.cash', 60);
    const decision = await screen(req, await realStoreHistory(), {}, files(file));
    expect(decision).toMatchObject({ approve: 'confirm', notices: [{ rule: 'R4', code: 'lookalike_host', knownHost: 'books.dexter.cash', reason: 'confusable' }] });
    expect(decision.seller.host).toBe('books.xn--dextr-2we.cash');
  });
  it('flags dexter.cash.books-secure.shop', async () => {
    const { file, req } = signedBy('dexter.cash.books-secure.shop', 62);
    const decision = await screen(req, await realStoreHistory(), {}, files(file));
    expect(decision).toMatchObject({ approve: 'confirm', notices: [{ rule: 'R4', code: 'lookalike_host', reason: 'embedded_domain' }] });
  });
  it('flags a one-letter typo host', async () => {
    const { file, req } = signedBy('books.dextor.cash', 64);
    const decision = await screen(req, await realStoreHistory(), {}, files(file));
    expect(decision).toMatchObject({ approve: 'confirm', notices: [{ rule: 'R4', code: 'lookalike_host', reason: 'edit_distance' }] });
  });
  it('does not flag Apple Valley Books against the label Apple', async () => {
    const known: KnownSeller[] = [{ ...(await realStoreHistory())[0], host: 'shop.apple.example', registrableDomain: 'apple.example', label: 'Apple' }];
    const decision = await screen(request({ appName: 'Apple Valley Books' }), known);
    expect(decision.approve).toBe('allowed');
  });
  it('does not flag another host of the same registrable domain', async () => {
    const spec = { ...REAL, hosts: ['books.dexter.cash', 'shop.dexter.cash'] };
    const url = 'https://shop.dexter.cash/books/meditations';
    const decision = await screen(
      request({ calledUrl: url, appName: 'Dexter Bookstore', offerJws: quote({ payload: offerPayload({ resourceUrl: url }) }) }),
      await realStoreHistory(), {}, files({ [REAL_FILE_URL]: storeDocument(spec) }),
    );
    expect(decision).toMatchObject({ approve: 'allowed', seller: { host: 'shop.dexter.cash', relation: 'first-payment' } });
  });
  it("does not flag OpenDexter's request name Dexter against the label Dexter Bookstore", async () => {
    const decision = await screen(request({ appName: 'Dexter', counterparty: keyFrom(70).address, seller: undefined }), await realStoreHistory());
    expect(decision.approve).toBe('allowed');
  });
});

describe('screenSeller: R5', () => {
  it('asks to confirm a new key on a known host', async () => {
    const rotated = { ...REAL, quoteKey: keyFrom(80) };
    const decision = await screen(request({ offerJws: quote({ secret: rotated.quoteKey.secret }) }), await realStoreHistory(), {}, files({ [REAL_FILE_URL]: storeDocument(rotated) }));
    expect(decision).toMatchObject({ approve: 'confirm', notices: [{ rule: 'R5', code: 'key_changed', knownHost: 'books.dexter.cash', since: NOW - 86_000 }] });
  });
  it('asks to confirm a changed address list', async () => {
    const more = { ...REAL, receiving: [REAL.receiving[0], keyFrom(81)] };
    const decision = await screen(request(), await realStoreHistory(), {}, files({ [REAL_FILE_URL]: storeDocument(more) }));
    expect(decision).toMatchObject({ approve: 'confirm', notices: [{ rule: 'R5', code: 'addresses_changed' }] });
  });
  it('names the known store when an unsigned request claims its host and pays another address (V5)', async () => {
    const decision = await screen(v5(), await realStoreHistory());
    expect(decision).toMatchObject({
      approve: 'confirm',
      seller: { kind: 'address', relation: 'unsigned', unsignedReason: 'no_offer', address: impostorAddress },
      notices: [{ rule: 'R5', code: 'unsigned_known_host', knownHost: 'books.dexter.cash', knownAddresses: [REAL.receiving[0].address] }],
    });
    expect(decision.seller.host).toBeUndefined();
  });
  it('names the known store when its file does not load and the quote has a key he never approved', async () => {
    const offer = quote({ kid: 'did:web:dexter.cash#books-quote-2', secret: keyFrom(82).secret });
    const decision = await screen(request({ offerJws: offer }), await realStoreHistory(), {}, servedFiles({}));
    expect(decision).toMatchObject({ approve: 'confirm', seller: { kind: 'address', unsignedReason: 'did_document_unavailable' },
      notices: [{ rule: 'R5', code: 'key_changed_unreadable', knownHost: 'books.dexter.cash' }] });
  });
  it('an unsigned request naming a known host and paying one of its known addresses gets no notice', async () => {
    const decision = await screen(request({ offerJws: null }), await realStoreHistory());
    expect(decision).toMatchObject({ approve: 'allowed', seller: { kind: 'address', relation: 'unsigned' } });
  });
  it('the saved path on a known store shows the website with the saved key and no notice', async () => {
    const decision = await screen(request(), await realStoreHistory(), {}, servedFiles({}));
    expect(decision).toMatchObject({ approve: 'allowed', seller: { kind: 'website', relation: 'known', savedKey: true } });
  });
});

describe('screenSeller: unsigned, copycats V2-V4, history and agent', () => {
  it('shows no-offer requests as an address and keeps them approvable', async () => {
    const decision = await screen(request({ counterparty: keyFrom(90).address, offerJws: null }), []);
    expect(decision).toMatchObject({ approve: 'allowed', seller: { kind: 'address', relation: 'unsigned', unsignedReason: 'no_offer', address: keyFrom(90).address } });
  });
  it('never puts the requested host in an unsigned display', async () => {
    for (const req of [v4(), v5(), request({ offerJws: null })]) {
      const decision = await screen(req, await realStoreHistory());
      expect(JSON.stringify(decision.seller)).not.toContain('dexter');
    }
  });
  it('V2 and V3 are refused with no website shown', async () => {
    const v2 = request({ counterparty: impostorAddress, offerJws: quote({ kid: 'did:web:dexter.cash#books-quote-impostor', secret: IMPOSTOR.quoteKey.secret, payload: offerPayload({ payTo: impostorAddress }) }) });
    for (const [req, codeName] of [[v2, 'kid_not_listed'], [request({ counterparty: impostorAddress }), 'payto_mismatch']] as const) {
      const decision = await screen(req, await realStoreHistory());
      expect(decision).toMatchObject({ approve: 'refused', refusal: { code: codeName }, seller: { kind: 'address', address: impostorAddress } });
    }
  });
  it('V4 gets the name notice and stays unsigned', async () => {
    const decision = await screen(v4(), await realStoreHistory());
    expect(decision).toMatchObject({ approve: 'confirm', seller: { kind: 'address', unsignedReason: 'no_offer' },
      notices: [{ rule: 'R4', code: 'lookalike_name', knownHost: 'books.dexter.cash', matched: 'Dexter Bookstore' }] });
  });
  it('with history unavailable the seller is never shown as a first payment', async () => {
    for (const req of [request(), v1(), v5()]) {
      const decision = await screen(req, await realStoreHistory(), { history: 'unavailable' });
      expect(decision.seller.relation).not.toBe('first-payment');
      expect(decision.agent.relation).toBe('unknown');
      expect(decision.approve).toBe('allowed');
    }
  });
  it('shows a replacement on a known store as replaces key A with key B', async () => {
    const old = keyFrom(42).address;
    const decision = await screen(request(), await realStoreHistory(), {
      liveSessionKey: old, agentKeys: [{ sessionPubkey: old, firstApprovedAt: NOW - 86_000, lastApprovedAt: NOW - 86_000 }],
    });
    expect(decision.agent).toEqual({ sessionPubkey: AGENT, claimedName: 'Claude', relation: 'new', replaces: { sessionPubkey: old, firstApprovedAt: NOW - 86_000 } });
  });
  it("the request's app name is only a quoted claim and never part of the seller display", async () => {
    for (const req of [request({ appName: 'Totally Real Store' }), request({ appName: 'Totally Real Store', offerJws: null })]) {
      const decision = await screen(req, []);
      expect(decision.agent.claimedName).toBe('Totally Real Store');
      expect(JSON.stringify(decision.seller)).not.toContain('Totally');
    }
  });
  it('a known agent key shows its first approval', async () => {
    const decision = await screen(request(), [], { agentKeys: [{ sessionPubkey: AGENT, firstApprovedAt: NOW - 500, lastApprovedAt: NOW - 100 }] });
    expect(decision.agent).toMatchObject({ relation: 'known', firstApprovedAt: NOW - 500 });
  });
});
