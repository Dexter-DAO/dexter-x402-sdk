import { getDomain } from 'tldts';
import { ASCII_CONFUSABLES } from './confusables';

export function registrableDomainOf(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true });
}

function dnsHost(host: string): boolean {
  return host.length <= 253 && host !== 'localhost' && !host.endsWith('.') &&
    host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function parseSellerUrl(value: string): { href: string; host: string; registrableDomain: string } | null {
  try {
    if (typeof value !== 'string') return null;
    const url = new URL(value);
    // URL.port normalizes an explicit :443 away, so inspect the authority too.
    const authority = /^https:\/\/([^/?#\\]*)/i.exec(value.replace(/[\t\r\n]/g, '').trim())?.[1];
    if (!authority || authority.includes(':') || authority.includes('@') || url.protocol !== 'https:' ||
        url.username || url.password || url.port || !dnsHost(url.hostname) || /^\d+(?:\.\d+){3}$/.test(url.hostname)) return null;
    const registrableDomain = registrableDomainOf(url.hostname);
    return registrableDomain ? { href: url.href, host: url.hostname, registrableDomain } : null;
  } catch {
    return null;
  }
}

export function parseDidWebKid(kid: string):
  { did: string; host: string; fragment: string } | 'did_method_unsupported' | 'kid_not_did_url' {
  if (typeof kid !== 'string') return 'kid_not_did_url';
  const method = /^did:([^:]+):/.exec(kid)?.[1];
  if (method && method !== 'web') return 'did_method_unsupported';
  const match = /^did:web:([a-z0-9.-]+)#([A-Za-z0-9._-]{1,64})$/.exec(kid);
  if (!match || !dnsHost(match[1]) || !parseSellerUrl(`https://${match[1]}/`)) return 'kid_not_did_url';
  return { did: `did:web:${match[1]}`, host: match[1], fragment: match[2] };
}

export function displayHost(host: string, maxChars = 40): { mutedPrefix: string; boldDomain: string; truncated: boolean } {
  const boldDomain = registrableDomainOf(host) ?? host;
  const prefix = host.endsWith(`.${boldDomain}`) ? host.slice(0, -boldDomain.length) : '';
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 40;
  const available = Math.max(0, limit - boldDomain.length);
  if (prefix.length <= available) return { mutedPrefix: prefix, boldDomain, truncated: false };
  return { mutedPrefix: available ? `…${available > 1 ? prefix.slice(-(available - 1)) : ''}` : '', boldDomain, truncated: true };
}

// RFC 3492 decoding, used only for comparison. Display text remains ASCII.
function decodePunycode(label: string): string {
  if (!label.startsWith('xn--')) return label;
  const input = label.slice(4);
  const output: number[] = [];
  const delimiter = input.lastIndexOf('-');
  let position = delimiter < 0 ? 0 : delimiter + 1;
  if (delimiter >= 0) for (const ch of input.slice(0, delimiter)) output.push(ch.charCodeAt(0));
  let n = 128, i = 0, bias = 72;
  const adapt = (delta: number, points: number, first: boolean) => {
    delta = first ? Math.floor(delta / 700) : Math.floor(delta / 2);
    delta += Math.floor(delta / points);
    let k = 0;
    while (delta > 455) { delta = Math.floor(delta / 35); k += 36; }
    return k + Math.floor(36 * delta / (delta + 38));
  };
  while (position < input.length) {
    const old = i;
    let weight = 1;
    for (let k = 36; ; k += 36) {
      const cp = input.charCodeAt(position++);
      const digit = cp >= 97 && cp <= 122 ? cp - 97 : cp >= 48 && cp <= 57 ? cp - 22 : 36;
      if (digit >= 36 || !Number.isSafeInteger(i += digit * weight)) throw new Error('punycode_invalid');
      const threshold = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < threshold) break;
      weight *= 36 - threshold;
      if (!Number.isSafeInteger(weight)) throw new Error('punycode_invalid');
    }
    bias = adapt(i - old, output.length + 1, old === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error('punycode_invalid');
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

function skeleton(value: string): string {
  return Array.from(value, (ch) => ASCII_CONFUSABLES[ch.codePointAt(0)!] ?? ch).join('');
}

function hostSkeleton(host: string): string {
  return skeleton(host.split('.').map(decodePunycode).join('.').toLowerCase());
}

function containsDomain(host: string, domain: string): boolean {
  return `.${host}.`.includes(`.${domain}.`);
}

// Damerau-Levenshtein optimal string alignment distance, with adjacent swaps.
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previousPrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], previousPrevious[j - 2] + 1);
      }
    }
    previousPrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

export function hostLookalike(candidate: string, known: readonly string[]):
  { knownHost: string; reason: 'confusable' | 'edit_distance' | 'embedded_domain' } | null {
  const domain = registrableDomainOf(candidate);
  let candidateSkeleton: string;
  try { candidateSkeleton = hostSkeleton(candidate); } catch { return null; }
  for (const knownHost of known) {
    const knownDomain = registrableDomainOf(knownHost);
    if (domain && domain === knownDomain) continue;
    if (knownDomain && containsDomain(candidate, knownDomain)) return { knownHost, reason: 'embedded_domain' };
    let knownSkeleton: string;
    let domainSkeleton: string | null;
    try {
      knownSkeleton = hostSkeleton(knownHost);
      domainSkeleton = knownDomain ? hostSkeleton(knownDomain) : null;
    } catch { continue; }
    if (candidateSkeleton !== candidate && (candidateSkeleton === knownSkeleton ||
        (domainSkeleton !== null && containsDomain(candidateSkeleton, domainSkeleton)))) return { knownHost, reason: 'confusable' };
    if (candidate.length >= 6 && knownHost.length >= 6 && editDistance(candidate, knownHost) <= 2) return { knownHost, reason: 'edit_distance' };
  }
  return null;
}

export function normalizeSellerName(name: string): string {
  return skeleton(name.normalize('NFKC').toLowerCase()).replace(/[^a-z0-9]/g, '');
}

export function nameMatches(candidate: string, label: string): boolean {
  const normalized = normalizeSellerName(candidate);
  const known = normalizeSellerName(label);
  return known.length > 0 && (normalized === known || (known.length >= 8 && normalized.includes(known)));
}
