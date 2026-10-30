import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { canonicalBytes } from '../jcs';
import { encodeBase64url } from '../encoding';
import { addressProofMessage } from '../document';
import { SOLANA_MAINNET, USDC_MINT } from '../types';
import type { FetchDidDocument, SellerRequest } from '../types';

export const NOW = 1_793_365_200; // fixed clock for every test

/** Deterministic keys so failures are reproducible. */
export function keyFrom(seed: number) {
  const secret = new Uint8Array(32).fill(seed);
  const publicKey = ed25519.getPublicKey(secret);
  return { secret, publicKey, address: bs58.encode(publicKey), x: encodeBase64url(publicKey) };
}

export interface StoreSpec {
  domain: string;              // registrable domain, e.g. dexter.cash
  hosts: string[];             // e.g. ['books.dexter.cash']
  name: string;
  quoteKey: ReturnType<typeof keyFrom>;
  fragment?: string;
  receiving: Array<ReturnType<typeof keyFrom>>;
  /** Edits applied to the document object before encoding (for malformed-file tests). */
  edit?: (doc: Record<string, any>) => void;
  forgeProofIndex?: number;
}

export function storeDocument(spec: StoreSpec): Uint8Array {
  const did = `did:web:${spec.domain}`;
  const kid = `${did}#${spec.fragment ?? 'books-quote-1'}`;
  const payTo = spec.receiving.map((key, i) => {
    const entry = { address: key.address, asset: USDC_MINT, network: SOLANA_MAINNET };
    const signer = i === spec.forgeProofIndex ? keyFrom(250).secret : key.secret;
    return { ...entry, proof: encodeBase64url(ed25519.sign(addressProofMessage({ ...entry, did }), signer)) };
  });
  const doc: Record<string, any> = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
    assertionMethod: [kid],
    id: did,
    service: [{
      id: `${did}#seller-books`,
      serviceEndpoint: { hosts: spec.hosts, name: spec.name, payTo, signingKeys: [kid], v: 'dexter-seller-profile/v1' },
      type: 'DexterSellerProfile',
    }],
    verificationMethod: [{ controller: did, id: kid, publicKeyJwk: { crv: 'Ed25519', kty: 'OKP', x: spec.quoteKey.x }, type: 'JsonWebKey2020' }],
  };
  spec.edit?.(doc);
  return canonicalBytes(doc);
}

export function signJws(header: Record<string, unknown>, payload: Record<string, unknown>, secret: Uint8Array): string {
  const h = encodeBase64url(new TextEncoder().encode(JSON.stringify(header)));
  const p = encodeBase64url(canonicalBytes(payload));
  const sig = ed25519.sign(new TextEncoder().encode(`${h}.${p}`), secret);
  return `${h}.${p}.${encodeBase64url(sig)}`;
}

export function offerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amount: '1000000', asset: USDC_MINT, network: SOLANA_MAINNET, payTo: REAL.receiving[0].address,
    resourceUrl: 'https://books.dexter.cash/books/meditations', scheme: 'tab', validUntil: NOW + 480, version: 1,
    ...overrides,
  };
}

export function quote(options: { kid?: string; secret?: Uint8Array; header?: Record<string, unknown>; payload?: Record<string, unknown> } = {}): string {
  return signJws(
    options.header ?? { alg: 'EdDSA', kid: options.kid ?? 'did:web:dexter.cash#books-quote-1' },
    options.payload ?? offerPayload(),
    options.secret ?? REAL.quoteKey.secret,
  );
}

export const REAL: StoreSpec = {
  domain: 'dexter.cash', hosts: ['books.dexter.cash'], name: 'Dexter Bookstore',
  quoteKey: keyFrom(1), receiving: [keyFrom(2)],
};
export const IMPOSTOR: StoreSpec = {
  domain: 'dexter-bookstore.pages.dev', hosts: ['dexter-bookstore.pages.dev'], name: 'Dexter Bookstore',
  quoteKey: keyFrom(11), receiving: [keyFrom(12)],
};

/** Serves documents by URL; anything else is unreadable. Records every URL requested. */
export function servedFiles(files: Record<string, Uint8Array | Error>): FetchDidDocument & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const value = files[url];
    if (!value || value instanceof Error) throw value ?? new Error('not served');
    return value;
  }) as FetchDidDocument & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export const REAL_FILE_URL = 'https://dexter.cash/.well-known/did.json';
export const IMPOSTOR_FILE_URL = 'https://dexter-bookstore.pages.dev/.well-known/did.json';

export function request(overrides: Partial<SellerRequest> & { offerJws?: string | null; calledUrl?: string; expectedHost?: string } = {}): SellerRequest {
  const { offerJws, calledUrl, expectedHost, ...rest } = overrides;
  const seller = {
    calledUrl: calledUrl ?? 'https://books.dexter.cash/books/meditations',
    ...(offerJws === null ? {} : { offer: { format: 'jws' as const, signature: offerJws ?? quote() } }),
    ...(expectedHost ? { expectedHost } : {}),
  };
  return {
    counterparty: REAL.receiving[0].address, appName: 'Claude', seller,
    scheme: 'tab', network: SOLANA_MAINNET, asset: USDC_MINT, ...rest,
  };
}
