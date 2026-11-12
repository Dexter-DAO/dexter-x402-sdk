// Copycat links retain public requests and the exact documents checked. No agent secret is saved.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { encodeSpendGrantRequest, requestSpendGrant } from '@dexterai/vault/grant';
import { readMandate, verifyMandateApproval } from '@dexterai/vault/mandate';
import {
  SOLANA_MAINNET, USDC_MINT, checkSellerOffer, decodeCompactJws, decodeSellerBinding,
  defaultFetchDidDocument, sellerOfferFromPaymentRequired, verifySellerEvidence,
} from '@dexterai/x402/seller';
import { save } from './case-two-self-held.mjs';

const EXPECTED = {
  V1: { approve: 'confirm', rule: 'R4', code: 'lookalike_name' },
  V2: { approve: 'refused', rule: 'R1', code: 'kid_not_listed' },
  V3: { approve: 'refused', rule: 'R2', code: 'payto_mismatch' },
  V4: { approve: 'confirm', rule: 'R4', code: 'lookalike_name' },
  V5: { approve: 'confirm', rule: 'R5', code: 'unsigned_known_host' },
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const seconds = () => Math.floor(Date.now() / 1000);

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Expected an HTTPS URL without credentials or a port');
  return url;
}

export async function fetchSellerQuote(url, fetcher = fetch) {
  const response = await fetcher(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (response.status !== 402) throw new Error(`Expected HTTP 402 from the book URL; received ${response.status}`);
  const body = await response.json();
  const accept = body.accepts?.find(entry => entry.scheme === 'tab' && entry.network === SOLANA_MAINNET && entry.asset === USDC_MINT);
  if (!accept) throw new Error('No Solana USDC Tab acceptance in the quote');
  return { body, accept, offer: sellerOfferFromPaymentRequired(body, accept) };
}

export async function impostorLinks(options, dependencies = {}) {
  const now = dependencies.now ?? seconds();
  const real = httpsUrl(options.real);
  const base = httpsUrl(options['impostor-base'] ?? 'https://dexter-bookstore.pages.dev');
  if (!/^\/books\/[^/]+\/?$/.test(real.pathname) || real.search || real.hash || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Use an exact /books/<slug> real URL and an impostor origin');
  }
  const impostor = new PublicKey(options.impostor).toBase58();
  if (options.variant && options.variants) throw new Error('Use --variant or --variants');
  const variants = (options.variant ?? options.variants ?? 'V1,V2,V3,V4,V5').split(',');
  if (!variants.length || new Set(variants).size !== variants.length || variants.some(v => !EXPECTED[v])) throw new Error('Unknown or repeated variant');
  const copycat = `${base.origin}${real.pathname}`;
  const quoteUrls = {
    V1: copycat, V2: `${base.origin}/v2${real.pathname}`, V3: real.href,
    V4: `${base.origin}/v4${real.pathname}`, V5: null,
  };
  // Start every quote fetch together; every seller check uses this same timestamp.
  const quotes = await Promise.all(variants.map(v => quoteUrls[v] ? fetchSellerQuote(quoteUrls[v], dependencies.fetch) : null));
  mkdirSync(options.out, { recursive: true, mode: 0o700 });
  const records = [];
  for (const [index, variant] of variants.entries()) {
    const quote = quotes[index];
    const offer = variant === 'V4' || variant === 'V5' ? null : quote.offer;
    if (variant !== 'V4' && variant !== 'V5' && !offer) throw new Error(`${variant}: signed offer missing`);
    if (variant === 'V4' && quote.offer) throw new Error('V4 must have no signed offer');
    const key = Keypair.generate();
    const sessionPubkey = key.publicKey.toBase58();
    key.secretKey.fill(0);
    const calledUrl = variant === 'V1' ? copycat : variant === 'V4' ? quoteUrls.V4 : real.href;
    const app = variant === 'V4'
      ? { name: 'Dexter Bookstore', domain: base.hostname }
      : { name: 'Claude', domain: 'claude.ai' };
    const request = requestSpendGrant({ app, counterparty: impostor, capAtomic: '10000', revolvingCapacityAtomic: '10000',
      expiresAtUnix: now + 3600, sessionPubkey, requestId: randomUUID(), seller: { calledUrl, ...(offer ? { offer } : {}) } });
    const documents = [];
    const check = await checkSellerOffer({ counterparty: impostor, appName: app.name, seller: request.seller,
      scheme: 'tab', network: SOLANA_MAINNET, asset: USDC_MINT }, {
      now,
      fetchDidDocument: async (url, signal) => {
        const bytes = await (dependencies.fetchDidDocument ?? defaultFetchDidDocument)(url, signal);
        documents.push({ url, bytes: Buffer.from(bytes).toString('base64url'), sha256: digest(bytes) });
        return bytes;
      },
    });
    const expectedStatus = variant === 'V1' ? 'signed' : variant === 'V2' || variant === 'V3' ? 'refused' : 'unsigned';
    if (check.status !== expectedStatus || (check.status === 'refused' && check.refusal.code !== EXPECTED[variant].code)) {
      throw new Error(`${variant}: expected ${expectedStatus}${EXPECTED[variant].approve === 'refused' ? ` ${EXPECTED[variant].code}` : ''}; received ${check.status}${check.status === 'refused' ? ` ${check.refusal.code}` : ''}`);
    }
    const decoded = offer ? decodeCompactJws(offer.signature) : null;
    const validUntil = decoded && typeof decoded !== 'string' ? decoded.payload.validUntil : null;
    const record = { schema: 'case-three/copycat-link/v1', variant, generatedAt: now, validUntil,
      request, consentUrl: `https://dexter.cash/tabs/new?req=${encodeSpendGrantRequest(request)}`, impostor,
      documents, expected: { ...EXPECTED[variant] } };
    const path = resolve(options.out, `${variant}.json`);
    save(path, record, true);
    records.push({ path, ...record });
  }
  return records;
}

export function linksFresh(options, dependencies = {}) {
  const now = dependencies.now ?? seconds();
  return readdirSync(options.dir, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json')).flatMap(entry => {
    const path = resolve(options.dir, entry.name);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.schema !== 'case-three/copycat-link/v1') return [];
    if (!Number.isSafeInteger(record.generatedAt)) throw new Error(`Invalid generatedAt in ${entry.name}`);
    const ageSeconds = now - record.generatedAt;
    const stale = ageSeconds > 360;
    const expired = record.validUntil !== null && record.validUntil <= now;
    return stale || expired ? [{ path, variant: record.variant, ageSeconds, stale, expired, consentUrl: record.consentUrl }] : [];
  });
}

function bytes(value, name, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} must be base64url`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || (length !== undefined && decoded.length !== length)) throw new Error(`${name} has invalid encoding or length`);
  return decoded;
}

export async function checkBinding(options, dependencies = {}) {
  const row = JSON.parse(readFileSync(options.row, 'utf8'));
  const checks = [];
  let phase = 'record';
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  try {
    add('row', row.schema === 'seller-binding-row/v1' && row.registerTx === options['register-tx'], 'Binding row names this registration');
    if (!checks.every(c => c.ok)) return { verified: false, checks };
    const bindingBytes = bytes(row.binding, 'binding');
    const binding = decodeSellerBinding(bindingBytes);
    const salt = bytes(row.salt, 'salt', 32);
    const didDocument = row.didDocument === null ? null : bytes(row.didDocument, 'didDocument');
    if (!/^[0-9a-f]{64}$/.test(row.ceremonyNonce)) throw new Error('ceremonyNonce must be lowercase hex32');
    phase = 'registration';
    const connection = dependencies.connection ?? new Connection(options.rpc, 'finalized');
    const reading = await (dependencies.readMandate ?? readMandate)(connection, { vault: row.vaultPda, counterparty: binding.counterparty });
    const approval = await (dependencies.verifyMandateApproval ?? verifyMandateApproval)(connection, reading, { registrationSignature: options['register-tx'] });
    checks.push(...approval.checks.map(c => ({ ...c, name: `approval.${c.name}` })));
    add('approval', approval.verified && approval.signature === options['register-tx'] && !!reading.terms, 'Finalized registration verifies');
    add('ceremony_nonce', !!approval.ceremonyNonce && approval.ceremonyNonce === row.ceremonyNonce, 'Stored nonce equals the verified approval nonce');
    if (!checks.every(c => c.ok)) return { verified: false, checks };
    phase = 'evidence';
    const evidence = await verifySellerEvidence({ binding: bindingBytes, salt, didDocument, offerJws: row.offerJws,
      ceremonyNonce: Buffer.from(approval.ceremonyNonce, 'hex'),
      registration: { vault: reading.terms.vault, counterparty: reading.terms.payee, sessionPubkey: reading.terms.agent } });
    checks.push(...evidence.checks.map(c => ({ ...c, name: `seller.${c.name}` })));
    return { verified: evidence.verified && checks.every(c => c.ok), checks };
  } catch (error) {
    add('binding_check', false, phase === 'registration' ? 'Finalized registration lookup failed; provider details omitted'
      : error instanceof Error ? error.message : 'Binding check failed');
    return { verified: false, checks };
  }
}
