#!/usr/bin/env node
// Case three adds seller and claim checks to the case-two single-purchase journal.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { DISCRIMINATORS } from '@dexterai/vault/constants';
import { deriveLockedClaimPda } from '@dexterai/vault/instructions';
import { contextBoundVoucherV2Message } from '@dexterai/vault/messages';
import { decodeLockedClaim } from '@dexterai/vault/reader';
import { resolveTabOffer } from '@dexterai/x402/tab';
import { checkSellerOffer, defaultFetchDidDocument, sellerOfferFromPaymentRequired, SOLANA_MAINNET, USDC_MINT, verifySellerReceipt } from '@dexterai/x402/seller';
import { assertLocalUnlessLive, makeRequest, purchase, readInternalToken, resend, resume, save, withGrantLock } from './case-two-self-held.mjs';
import { checkBinding, impostorLinks, linksFresh } from './case-three-seller-tools.mjs';

const ENV = '/home/branchmanager/.config/dexter-facilitator/facilitator.env';
const PROGRAM = new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');
const now = () => Math.floor(Date.now() / 1000);
const pause = ms => new Promise(done => setTimeout(done, ms));
const sha = bytes => createHash('sha256').update(bytes).digest();

export function expiry(options, at = now()) {
  if (!!options['expires-at'] === !!options['expiry-rule']) throw new Error('Choose --expires-at or --expiry-rule 2.5h');
  if (options['expiry-rule'] && options['expiry-rule'] !== '2.5h') throw new Error('The expiry rule is 2.5h');
  const unix = options['expires-at'] ? Number(options['expires-at']) : Math.ceil((at + 9000) / 1800) * 1800;
  if (!Number.isSafeInteger(unix) || unix <= at) throw new Error('Expiry must be a future unix second');
  return { unix, ET: new Date(unix * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }) };
}

function cloneOnly(options) {
  assertLocalUnlessLive(options.facilitator, false);
}

// The signed resource stays canonical when its clone transport is loopback.
export async function checkedQuote(options, merchant, init = {}, dependencies = {}) {
  const endpoint = options.endpoint ?? options['seller-url'];
  const calledUrl = options['seller-url'] ?? endpoint;
  assertLocalUnlessLive(endpoint, true);
  const response = await (dependencies.fetch ?? fetch)(endpoint, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (response.status !== 402) throw new Error(`Expected book quote HTTP 402; received ${response.status}`);
  const retained = response.clone();
  const body = await response.json();
  const accept = body.accepts?.find(a => a.scheme === 'tab' && a.network === SOLANA_MAINNET && a.asset === USDC_MINT);
  if (!accept) throw new Error('No Solana USDC Tab acceptance');
  const offer = sellerOfferFromPaymentRequired(body, accept);
  if (!offer) throw new Error('Unsigned quote or unsigned accepts terms differ from signed quote');
  const seller = { calledUrl, offer, expectedHost: options['expected-host'] ?? 'books.dexter.cash' };
  if (options['did-file']) assertLocalUnlessLive(endpoint, false);
  const check = await checkSellerOffer({ counterparty: merchant, appName: 'Claude', seller,
    scheme: 'tab', network: SOLANA_MAINNET, asset: USDC_MINT }, {
    now: dependencies.now ?? now(),
    fetchDidDocument: dependencies.fetchDidDocument ?? (options['did-file']
      ? async () => new Uint8Array(readFileSync(options['did-file'])) : defaultFetchDidDocument),
  });
  if (check.status !== 'signed') throw new Error(`Seller quote ${check.status}: ${check.refusal?.code ?? check.reason}`);
  // resolveTabOffer selects this same acceptance, from the same retained 402.
  const resolved = await resolveTabOffer(endpoint, init, async () => retained);
  if (resolved.kind !== 'offer' || resolved.offer.payTo !== check.offer.payTo || accept.payTo !== check.offer.payTo
    || resolved.offer.amountAtomic !== check.offer.amount || resolved.offer.asset !== check.offer.asset || resolved.offer.networkCaip2 !== check.offer.network) {
    throw new Error('Unsigned accepts terms differ from signed quote');
  }
  return { seller, check, resolved };
}

export async function request(options, dependencies = {}) {
  const at = dependencies.now ?? now();
  const expires = expiry(options, at);
  const { seller, check } = await checkedQuote(options, options.merchant, {}, dependencies);
  // The beside-grant check and grant/key are exclusive files. A failed quote creates none.
  save(`${options.grant}.seller-check.json`, { schema: 'case-three/seller-check/v1', ...check }, true);
  const record = makeRequest({ cap: '3', revolving: '1.50', 'max-single': '1.50', ...options }, at,
    { expiresAtUnix: expires.unix, seller, record: { schema: 'case-three/grant/v1' } });
  return { ...record, expiresAt: expires };
}

export function claimFor(input) {
  const p = input.voucher.payload;
  const message = contextBoundVoucherV2Message({ programId: new PublicKey(input.programId), vaultPda: new PublicKey(input.vaultPda),
    sessionPda: new PublicKey(input.sessionPda), seller: new PublicKey(input.seller), sessionNonce: input.sessionNonce,
    channelId: Buffer.from(p.channelId, 'hex'), cumulativeAmount: BigInt(p.cumulativeAmount), sequenceNumber: p.sequenceNumber });
  return deriveLockedClaimPda(new PublicKey(input.vaultPda), sha(message)).toBase58();
}

function envValue(file, name) {
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find(line => line.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing in facilitator environment`);
  return line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
}

export function redisCommand(options, command, execute = execFileSync) {
  // Never place a Redis URL or password in argv, stderr, or a thrown child error.
  const url = new URL(envValue(options['env-file'] ?? ENV, 'REDIS_URL'));
  if (!['redis:', 'rediss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Redis must be loopback');
  const args = ['-h', url.hostname, '-p', url.port || '6379', '--raw'];
  if (url.protocol === 'rediss:') args.push('--tls');
  if (url.username) args.push('--user', decodeURIComponent(url.username));
  if (url.pathname && url.pathname !== '/') {
    if (!/^\/\d+$/.test(url.pathname)) throw new Error('Invalid Redis database');
    args.push('-n', url.pathname.slice(1));
  }
  const env = { ...process.env };
  delete env.REDISCLI_AUTH;
  if (url.password) env.REDISCLI_AUTH = decodeURIComponent(url.password);
  try { return execute('/usr/bin/redis-cli', [...args, ...command], { encoding: 'utf8', timeout: 5000, env, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('Redis hold command failed'); }
}

export async function setHold(options, input, journal, receipt, redis = redisCommand) {
  const claim = claimFor(input);
  const key = `x402:settle:hold:${claim}`;
  if (journal.hold) {
    if (journal.hold.key !== key || journal.hold.readBack !== 'case-three' || journal.hold.deletedAt
      || redis(options, ['GET', key]) !== 'case-three') throw new Error('Saved claim hold is missing or differs; reservation not sent');
    return;
  }
  if (redis(options, ['SET', key, 'case-three', 'EX', '3600', 'NX']) !== 'OK') throw new Error('Could not exclusively set claim hold; reservation not sent');
  if (redis(options, ['GET', key]) !== 'case-three') throw new Error('Claim hold read-back failed; reservation not sent');
  journal.hold = { key, setAt: now(), readBack: 'case-three' };
  journal.claim = { address: claim };
  save(receipt, journal);
}

export async function waitPending(connection, journal, receipt, dependencies = {}) {
  const address = journal.claim?.address ?? claimFor(journal.reservationInput);
  const deadline = Date.now() + (dependencies.timeoutMs ?? 60000);
  while (Date.now() < deadline) {
    const account = await connection.getAccountInfo(new PublicKey(address), 'confirmed');
    if (account) {
      if (!account.owner.equals(PROGRAM)) throw new Error('Claim has wrong owner');
      const claim = decodeLockedClaim(address, account.data);
      if (claim.status !== 'Pending' || claim.vault !== journal.vault || claim.allowedCounterparty !== journal.merchant
        || BigInt(claim.amount) !== BigInt(journal.reservationInput.reservationAmountAtomic)) throw new Error('Claim does not match Pending purchase');
      journal.claim = { ...journal.claim, address, pendingAt: now(), amountAtomic: claim.amount.toString() };
      const signatures = await connection.getSignaturesForAddress(new PublicKey(address), { limit: 5 }, 'confirmed');
      for (const { signature, err } of signatures) {
        if (err) continue;
        const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (!tx || tx.meta?.err) continue;
        const message = tx.transaction.message, keys = message.staticAccountKeys ?? message.accountKeys;
        if ((message.compiledInstructions ?? message.instructions).some(ix => keys[ix.programIdIndex]?.equals(PROGRAM)
          && Buffer.from(typeof ix.data === 'string' ? bs58.decode(ix.data) : ix.data).subarray(0, 8).equals(Buffer.from(DISCRIMINATORS.lock_voucher)))) {
          journal.claim.lockSignature = signature; break;
        }
      }
      save(receipt, journal);
      return claim;
    }
    await (dependencies.pause ?? pause)(250);
  }
  throw new Error('Locked claim not observed before close; purchase remains pending. Do not pay again');
}

export async function waitClosed(connection, journal, receipt, dependencies = {}) {
  if (!journal.claim?.pendingAt) throw new Error('Cannot prove closure without first observing Pending claim');
  const address = new PublicKey(journal.claim.address);
  const deadline = Date.now() + (dependencies.timeoutMs ?? 120000);
  while (Date.now() < deadline) {
    if (!(await connection.getAccountInfo(address, 'finalized'))) {
      const signatures = await connection.getSignaturesForAddress(address, { limit: 10 }, 'finalized');
      const candidates = journal.claim.payoutSignature ? [{ signature: journal.claim.payoutSignature }] : signatures.filter(s => !s.err);
      let signature;
      for (const candidate of candidates) {
        const tx = await connection.getTransaction(candidate.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
        if (!tx || tx.meta?.err) continue;
        const message = tx.transaction.message;
        const keys = message.staticAccountKeys ?? message.accountKeys;
        const instructions = message.compiledInstructions ?? message.instructions;
        if (instructions.some(ix => keys[ix.programIdIndex]?.equals(PROGRAM)
          && Buffer.from(typeof ix.data === 'string' ? bs58.decode(ix.data) : ix.data).equals(Buffer.from(DISCRIMINATORS.settle_locked_voucher))
          && keys[(ix.accountKeyIndexes ?? ix.accounts)[2]]?.equals(address))) {
          signature = candidate.signature; break;
        }
      }
      if (!signature) throw new Error('Claim closed but successful locked payout unavailable; inspect the purchase');
      journal.claim.closedAt = now(); journal.claim.payoutSignature = signature;
      save(receipt, journal);
      return signature;
    }
    await (dependencies.pause ?? pause)(500);
  }
  throw new Error('Claim payout not yet finalized; purchase remains pending. Do not pay again');
}

export async function checkDeliveredReceipt(journal, receipt) {
  const delivery = JSON.parse(readFileSync(`${receipt}.delivery.json`, 'utf8'));
  let jws, checked;
  try {
    const body = JSON.parse(Buffer.from(delivery.base64, 'base64url').toString('utf8'));
    jws = typeof body.storeReceipt === 'string' ? body.storeReceipt : body.storeReceipt?.signature;
    const check = journal.quote.check;
    checked = await verifySellerReceipt({ receiptJws: jws, didDocument: Buffer.from(check.didDocument, 'base64url'), kid: check.kid,
      expected: { resourceUrl: check.offer.resourceUrl, payer: journal.vault, network: SOLANA_MAINNET,
        issuedAtMin: Math.floor(Date.parse(journal.createdAt) / 1000), issuedAtMax: now() } });
  } catch { checked = { ok: false, code: 'receipt_malformed' }; }
  journal.storeReceipt = { jws: jws ?? null, verified: checked.ok, ...(!checked.ok ? { code: checked.code } : {}) };
  save(receipt, journal);
  // Record after delivery and stop. Recovery may settle the existing obligation; no new payment is made.
  if (!checked.ok) throw new Error(`Store receipt verification failed: ${checked.code}; delivered purchase retained. Do not pay again`);
}

async function payClaim(options, connection, journal, receipt, dependencies = {}) {
  // Recover an earlier payout whose HTTP response was lost, without another POST.
  if (!(await connection.getAccountInfo(new PublicKey(journal.claim.address), 'confirmed'))) {
    return waitClosed(connection, journal, receipt, dependencies);
  }
  const token = readInternalToken({ 'token-env-file': options['env-file'] ?? ENV, ...options });
  const response = await (dependencies.fetch ?? fetch)(new URL('/tab/lock/settle', options.facilitator), {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-internal-token': token },
    body: JSON.stringify({ network: SOLANA_MAINNET, vaultPda: journal.vault, seller: journal.merchant, claimPdas: [journal.claim.address] }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.json();
  journal.claim.payoutResponse = body; save(receipt, journal);
  const result = body.results?.find(result => result.claimPda === journal.claim.address);
  if (!response.ok || result?.status !== 'settled' || !result.settleTx) throw new Error(`Named claim payout not confirmed (HTTP ${response.status}); inspect saved response`);
  journal.claim.payoutSignature = result.settleTx; save(receipt, journal);
  return waitClosed(connection, journal, receipt, dependencies);
}

export function purchaseLifecycle(options, dependencies = {}) {
  let quoted;
  return {
    resolveOffer: async (endpoint, init, record) => {
      quoted = await checkedQuote({ ...options, endpoint, 'seller-url': options['seller-url'] ?? record.request.seller?.calledUrl,
        'expected-host': options['expected-host'] ?? record.request.seller?.expectedHost }, record.request.counterparty, init, dependencies);
      return quoted.resolved;
    },
    prepareJournal: journal => {
      journal.schema = 'case-three/journal/v1';
      // Persist bytes once, base64url, while retaining the complete signed check for receipt verification.
      const check = quoted.check;
      journal.quote = { jws: quoted.seller.offer.signature, checkedAt: check.checkedAt,
        check: { ...check, payTo: check.offer.payTo, didDocument: Buffer.from(check.didDocument).toString('base64url') } };
    },
    beforeReserve: async (input, journal, receipt) => {
      journal.claim = { address: claimFor(input) }; save(receipt, journal);
      if (options['hold-settlement'] && !options['no-hold']) await setHold(options, input, journal, receipt, dependencies.redis);
    },
    afterDelivery: async (connection, journal, receipt) => {
      await waitPending(connection, journal, receipt, dependencies);
      await checkDeliveredReceipt(journal, receipt);
    },
    beforeClose: (_connection, journal) => {
      if (!journal.claim?.pendingAt) throw new Error('Pending claim must be observed before close');
    },
    stopAfterDelivery: !!options['hold-settlement'],
    afterClose: async (connection, journal, receipt) => {
      if (options['pay-claim']) await payClaim(options, connection, journal, receipt, dependencies);
      else await waitClosed(connection, journal, receipt, dependencies);
    },
    beforeRecovery: async (connection, journal, receipt) => {
      if (!journal.claim?.pendingAt) await waitPending(connection, journal, receipt, dependencies);
      await waitClosed(connection, journal, receipt, dependencies);
    },
  };
}

export async function buy(options, dependencies = {}) {
  options = { ...options, 'token-env-file': options['token-env-file'] ?? options['env-file'] ?? ENV };
  if (!options['check-seller']) throw new Error('Case three requires --check-seller');
  if (options['pay-claim']) cloneOnly(options);
  if (options['no-hold']) {
    cloneOnly(options);
    if (!options['hold-settlement']) throw new Error('--no-hold requires --hold-settlement for buy');
  }
  if (options['pay-claim'] && options['hold-settlement']) throw new Error('Use --pay-claim or --hold-settlement');
  return purchase(options, purchaseLifecycle(options, dependencies));
}

export async function settleHeld(options, dependencies = {}) {
  options = { ...options, 'token-env-file': options['token-env-file'] ?? options['env-file'] ?? ENV };
  if (options['no-hold']) cloneOnly(options);
  assertLocalUnlessLive(options.facilitator, options.live); assertLocalUnlessLive(options.rpc, options.live);
  const payout = resolve(options.payout ?? `${options.receipt}.payout.json`);
  // The journal itself fences new purchases; payout progress is durable through the same grant lock.
  await withGrantLock(options.grant, async record => {
    const receipt = resolve(options.receipt ?? record.pendingReceipt);
    if (record.pendingReceipt !== receipt) throw new Error('Held receipt is not the pending purchase');
    const journal = JSON.parse(readFileSync(receipt, 'utf8'));
    if (journal.schema !== 'case-three/journal/v1' || journal.claim?.address !== options.claim || claimFor(journal.reservationInput) !== options.claim
      || !journal.claim.pendingAt) throw new Error('Claim differs from the delivered purchase');
    if (journal.facilitator !== options.facilitator) throw new Error('Facilitator differs from delivered purchase');
    const redis = dependencies.redis ?? redisCommand;
    if (!options['no-hold'] && (journal.hold?.readBack !== 'case-three' || redis(options, ['GET', journal.hold.key]) !== 'case-three')) throw new Error('Claim hold is missing; stop and inspect');
    const connection = dependencies.connection ?? new Connection(options.rpc, 'confirmed');
    if (existsSync(payout)) {
      const saved = JSON.parse(readFileSync(payout, 'utf8'));
      if (saved.claim !== options.claim || saved.seller !== journal.merchant) throw new Error('Payout record identity differs');
    } else save(payout, { schema: 'case-three/payout/v1', claim: options.claim, seller: journal.merchant, amountAtomic: journal.claim.amountAtomic, stage: 'paying' }, true);
    if (!journal.claim.closedAt) await (dependencies.payClaim ?? payClaim)(options, connection, journal, receipt, dependencies);
    else await waitClosed(connection, journal, receipt, dependencies);
    const statuses = await connection.getSignatureStatuses([journal.claim.payoutSignature], { searchTransactionHistory: true });
    const status = statuses.value[0];
    if (!status || status.err || status.confirmationStatus !== 'finalized') throw new Error('Payout signature is not finalized');
    // First retain the closed claim and signature, then release its hold.
    const result = { schema: 'case-three/payout/v1', claim: options.claim, seller: journal.merchant, amountAtomic: journal.claim.amountAtomic,
      signature: journal.claim.payoutSignature, slot: status.slot, closedAt: journal.claim.closedAt, holdDeletedAt: null };
    save(payout, result);
    if (!options['no-hold']) {
      if (redis(options, ['DEL', journal.hold.key]) !== '1') throw new Error('Claim closed; hold deletion did not confirm. Inspect hold and resume');
      journal.hold.deletedAt = now(); result.holdDeletedAt = journal.hold.deletedAt; save(receipt, journal); save(payout, result);
    }
  });
  await resume(options, purchaseLifecycle(options, dependencies));
  return JSON.parse(readFileSync(payout, 'utf8'));
}

export function resumePurchase(options, dependencies = {}) {
  options = { ...options, 'token-env-file': options['token-env-file'] ?? options['env-file'] ?? ENV };
  return resume(options, purchaseLifecycle(options, dependencies));
}

export async function main(args = process.argv.slice(2)) {
  const string = ['key', 'grant', 'merchant', 'cap', 'revolving', 'max-single', 'domain', 'rpc', 'vault', 'endpoint', 'facilitator', 'receipt', 'body', 'reason',
    'token-env-file', 'env-file', 'seller-url', 'expected-host', 'expires-at', 'expiry-rule', 'did-file', 'claim', 'payout', 'variants', 'variant', 'impostor-base', 'impostor', 'real', 'out', 'dir', 'row', 'register-tx'];
  const boolean = ['live', 'check-seller', 'hold-settlement', 'pay-claim', 'no-hold'];
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: Object.fromEntries([...string.map(name => [name, { type: 'string' }]), ...boolean.map(name => [name, { type: 'boolean', default: false }])]) });
  values.rpc ??= 'http://127.0.0.1:27899'; values.facilitator ??= 'http://127.0.0.1:27901';
  const command = positionals[0];
  const required = { request: ['key', 'grant', 'merchant', 'seller-url'], buy: ['grant', 'vault', 'endpoint', 'receipt', 'reason'],
    resume: ['grant', 'receipt'], resend: ['receipt'], 'settle-held': ['grant', 'receipt', 'claim'],
    'impostor-links': ['impostor', 'real', 'out'], 'links-fresh': ['dir'], 'check-binding': ['row', 'register-tx', 'rpc'] }[command];
  if (!required || positionals.length !== 1) throw new Error('Use request, buy, resume, resend, settle-held, impostor-links, links-fresh or check-binding');
  for (const name of required) if (!values[name]) throw new Error(`--${name} required`);
  const run = { request, buy, resume: resumePurchase, resend, 'settle-held': settleHeld,
    'impostor-links': impostorLinks, 'links-fresh': linksFresh, 'check-binding': checkBinding }[command];
  const result = await run(values);
  console.log(JSON.stringify(result, null, 2));
  if (command === 'check-binding' && !result.verified) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
