import { describe, expect, it } from 'vitest';
import {
  displayHost, hostLookalike, nameMatches, normalizeSellerName,
  parseDidWebKid, parseSellerUrl, registrableDomainOf,
} from '../host';

describe('seller hosts', () => {
  it('parses HTTPS and preserves the URL parser ASCII hostname', () => {
    expect(parseSellerUrl('https://books.dexter.cash/books/meditations')).toEqual({
      href: 'https://books.dexter.cash/books/meditations', host: 'books.dexter.cash', registrableDomain: 'dexter.cash',
    });
    expect(parseSellerUrl('https://bücher.de/')).toMatchObject({ host: 'xn--bcher-kva.de', registrableDomain: 'xn--bcher-kva.de' });
  });

  it.each([
    'http://books.dexter.cash/', 'https://user@books.dexter.cash/',
    'https://user:pass@books.dexter.cash/', 'https://books.dexter.cash:8443/',
    'https://books.dexter.cash:443/', 'https://127.0.0.1/', 'https://2130706433/',
    'https://0x7f000001/', 'https://[::1]/', 'https://localhost/',
    'https://books.dexter.cash./', 'https://bad_host.dexter.cash/',
    'https://books..dexter.cash/', 'https://cash/', 'garbage',
  ])('refuses invalid seller URL %s', (url) => {
    expect(parseSellerUrl(url)).toBeNull();
  });

  it('refuses a host ending in a dot', () => {
    expect(parseSellerUrl('https://books.dexter.cash./')).toBeNull();
  });

  it('uses private suffixes for registrable domains', () => {
    expect(registrableDomainOf('dexter-bookstore.pages.dev')).toBe('dexter-bookstore.pages.dev');
    expect(registrableDomainOf('shop.customer.github.io')).toBe('customer.github.io');
  });

  it('parses a did:web key URL', () => {
    expect(parseDidWebKid('did:web:dexter.cash#books-quote-1')).toEqual({
      did: 'did:web:dexter.cash', host: 'dexter.cash', fragment: 'books-quote-1',
    });
  });

  it.each(['key', 'jwk', 'pkh', 'example', 'ion', 'ethr', 'webvh'])('rejects every non-did:web method: %s', (method) => {
    expect(parseDidWebKid(`did:${method}:example#key`)).toBe('did_method_unsupported');
  });

  it.each([
    'did:web:dexter.cash', 'did:web:dexter.cash#', 'did:web:dexter.cash#bad/key',
    'did:web:dexter.cash%3A443#key', 'did:web:dexter.cash:443#key',
    'did:web:dexter.cash:books#key', 'did:web:dexter.cash/books#key',
    'did:web:dexter.cash.#key', 'did:web:localhost#key', 'did:web:127.0.0.1#key',
    'did:web:déxter.cash#key', `did:web:dexter.cash#${'a'.repeat(65)}`, 'not-a-did',
  ])('refuses malformed did:web key URL %s', (kid) => {
    expect(parseDidWebKid(kid)).toBe('kid_not_did_url');
  });

  it('displayHost keeps the registrable domain whole', () => {
    const host = `${'very-long-subdomain.'.repeat(3)}dexter.cash`;
    const result = displayHost(host, 30);
    expect(result.boldDomain).toBe('dexter.cash');
    expect(result.mutedPrefix.startsWith('…')).toBe(true);
    expect(result.mutedPrefix + result.boldDomain).toHaveLength(30);
    expect(result.truncated).toBe(true);
    expect(displayHost(host, 3)).toEqual({ mutedPrefix: '', boldDomain: 'dexter.cash', truncated: true });
    expect(displayHost('books.dexter.cash')).toEqual({ mutedPrefix: 'books.', boldDomain: 'dexter.cash', truncated: false });
  });

  it('displayHost never decodes punycode', () => {
    expect(displayHost('books.xn--dextr-2we.cash')).toEqual({ mutedPrefix: 'books.', boldDomain: 'xn--dextr-2we.cash', truncated: false });
  });

  it('flags a host whose e in dexter is Cyrillic U+0435', () => {
    expect(hostLookalike('books.xn--dextr-2we.cash', ['books.dexter.cash'])).toEqual({
      knownHost: 'books.dexter.cash', reason: 'confusable',
    });
  });

  it('flags dexter.cash.books-secure.shop', () => {
    expect(hostLookalike('dexter.cash.books-secure.shop', ['books.dexter.cash'])).toEqual({
      knownHost: 'books.dexter.cash', reason: 'embedded_domain',
    });
  });

  it('finds a confusable embedded registrable domain', () => {
    expect(hostLookalike('xn--dextr-2we.cash.books-secure.shop', ['books.dexter.cash'])).toEqual({
      knownHost: 'books.dexter.cash', reason: 'confusable',
    });
  });

  it('does not flag another host of the same domain', () => {
    expect(hostLookalike('secure.dexter.cash', ['books.dexter.cash'])).toBeNull();
    expect(hostLookalike('books.dexter.cash', ['books.dexter.cash'])).toBeNull();
  });

  it('finds adjacent swaps and two edits in sufficiently long hosts', () => {
    expect(hostLookalike('books.dextre.cash', ['books.dexter.cash'])).toEqual({ knownHost: 'books.dexter.cash', reason: 'edit_distance' });
    expect(hostLookalike('books.dexterx.cas', ['books.dexter.cash'])).toEqual({ knownHost: 'books.dexter.cash', reason: 'edit_distance' });
    expect(hostLookalike('a.co', ['b.co'])).toBeNull();
    expect(hostLookalike('books.example.org', ['books.dexter.cash'])).toBeNull();
  });

  it('requires complete labels for embedded domains', () => {
    expect(hostLookalike('notdexter.cash.books-secure.shop', ['books.dexter.cash'])).toBeNull();
    expect(hostLookalike('dexter.cashbook.books-secure.shop', ['books.dexter.cash'])).toBeNull();
  });

  it('ignores malformed punycode while comparing hosts', () => {
    expect(hostLookalike('xn--a.cash', ['dexter.cash'])).toBeNull();
    expect(hostLookalike('xn--.cash', ['dexter.cash'])).toBeNull();
  });

  it('normalizes names through NFKC, lowercase and Unicode confusables', () => {
    expect(normalizeSellerName('ＤＥＸＴＥＲ Bookstore!')).toBe('dexterbookstore');
    expect(normalizeSellerName('Dеxtеr Bookstore')).toBe('dexterbookstore');
    expect(normalizeSellerName('  Dexter-Books 123. ')).toBe('dexterbooksl23'); // UTS #39 maps ASCII 1 to l.
  });

  it('matches equal names or a known normalized label of at least eight characters', () => {
    expect(nameMatches('Dеxtеr Bookstore', 'Dexter Bookstore')).toBe(true);
    expect(nameMatches('Official Dexter Bookstore Shop', 'Dexter Bookstore')).toBe(true);
    expect(nameMatches('Super Books Shop', 'Books')).toBe(false);
    expect(nameMatches('Other Store', 'Dexter Bookstore')).toBe(false);
    expect(nameMatches('', '')).toBe(false);
  });
});
