#!/usr/bin/env node
// One process owns a grant at a time. Secrets never enter an HTTP request.
import { constants, closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { requestSpendGrant, encodeSpendGrantRequest } from '@dexterai/vault/grant';
import { fetchSessionAccount } from '@dexterai/vault/session';
import { tabFromGrant, humanToAtomic, resolveTabOffer, voucherToHeader } from '@dexterai/x402/tab';
import { verifySolanaFinalVoucherV2Reservation } from '@dexterai/x402/tab/adapters/solana';
import { createReservationFence } from './case-two-reservation.mjs';
import { readKey } from './case-two-key.mjs';
export { readKey };

export function save(path, value, exclusive = false) {
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, JSON.stringify(value, (_key, item) => item instanceof Uint8Array ? Array.from(item) : item, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  if (!exclusive) renameSync(target, path);
  const directory = openSync(dirname(resolve(path)), constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

// A crashed owner deliberately leaves its lock. Inspect the recorded process
// before removing that exact lock; a new process never guesses it is stale.
export async function withGrantLock(grant, operation) {
  const lockPath = `${resolve(grant)}.lock`;
  let lock;
  try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Grant is locked: ${lockPath}; inspect its owner before recovery`);
    throw error;
  }
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
    fsyncSync(lock);
    return await operation(JSON.parse(readFileSync(grant, 'utf8')));
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

export function makeRequest(options, now = Math.floor(Date.now() / 1000)) {
  const key = Keypair.generate();
  const capAtomic = humanToAtomic(options.cap ?? '5');
  const maxSingleAtomic = humanToAtomic(options['max-single'] ?? '1.50');
  const revolvingCapacityAtomic = humanToAtomic(options.revolving ?? options['max-single'] ?? '1.50');
  if (BigInt(maxSingleAtomic) <= 0n || BigInt(maxSingleAtomic) > BigInt(capAtomic)) throw new Error('Invalid max-single');
  const request = requestSpendGrant({
    app: { name: 'Claude', domain: options.domain ?? 'claude.ai' },
    counterparty: new PublicKey(options.merchant).toBase58(),
    capAtomic, revolvingCapacityAtomic, expiresAtUnix: now + 7 * 86400,
    sessionPubkey: key.publicKey.toBase58(), requestId: randomUUID(),
  });
  // Create without overwriting an existing private key or grant.
  save(options.key, Array.from(key.secretKey), true);
  key.secretKey.fill(0);
  const record = { request, maxSingleAtomic, keyPath: resolve(options.key) };
  save(options.grant, record, true);
  return { consentUrl: `https://dexter.cash/tabs/new?req=${encodeSpendGrantRequest(request)}`, ...record };
}

export function assertLocalUnlessLive(url, live) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid endpoint');
  if (!live && !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Non-local endpoints require --live; this job must use only the clone');
  }
}

export async function approvedGrant(connection, vault, record, key) {
  const state = await fetchSessionAccount(connection, new PublicKey(vault), new PublicKey(record.request.counterparty));
  if (!state || state.version !== 1) throw new Error('No approved on-chain session; Branch must approve the consent URL first');
  const s = state.session;
  if (new PublicKey(s.sessionPubkey).toBase58() !== key.publicKey.toBase58()
      || key.publicKey.toBase58() !== record.request.sessionPubkey) throw new Error('Approved agent key differs from local request');
  if (s.maxAmount > BigInt(record.request.proposed.capAtomic)
      || s.maxRevolvingCapacity > BigInt(record.request.proposed.revolvingCapacityAtomic)
      || s.expiresAt > record.request.proposed.expiresAtUnix) throw new Error('Approved scope exceeds requested scope');
  return {
    counterparty: record.request.counterparty, sessionPubkey: key.publicKey.toBase58(),
    maxAmountAtomic: s.maxAmount.toString(), maxRevolvingCapacityAtomic: s.maxRevolvingCapacity.toString(),
    expiresAtUnix: s.expiresAt, nonce: s.nonce,
  };
}

export function readInternalToken(options) {
  const environmentToken = process.env.DEXTER_INTERNAL_TOKEN?.trim();
  if (environmentToken) return environmentToken;
  if (!options['token-env-file']) throw new Error('Set DEXTER_INTERNAL_TOKEN or --token-env-file');
  const line = readFileSync(options['token-env-file'], 'utf8').split('\n').find(line => /^DEXTER_INTERNAL_TOKEN=/.test(line));
  if (!line) throw new Error('DEXTER_INTERNAL_TOKEN missing in env file');
  const token = line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!token) throw new Error('DEXTER_INTERNAL_TOKEN is empty');
  return token;
}

export function voucherFromJournal(journal) {
  return { ...journal.reservationInput.voucher, reservationReceipt: journal.reservationReceipt,
    sessionPublicKey: Uint8Array.from(Object.values(journal.reservationInput.voucher.sessionPublicKey)),
    sessionSignature: Uint8Array.from(Object.values(journal.reservationInput.voucher.sessionSignature)),
    sessionRegistration: Uint8Array.from(Object.values(journal.reservationInput.voucher.sessionRegistration)) };
}

function reservationFence(options, journal, receipt) {
  return createReservationFence({ facilitatorUrl: options.facilitator, internalToken: readInternalToken(options),
    readRecord: async key => journal.reservations?.[key],
    writeRecord: async (key, record) => { journal.reservations ??= {}; journal.reservations[key] = record; save(receipt, journal); } });
}

async function settledFrontier(connection, journal) {
  const state = await fetchSessionAccount(connection, new PublicKey(journal.vault), new PublicKey(journal.merchant));
  if (!state || state.version !== 1 || state.session.nonce !== journal.reservationInput.sessionNonce) throw new Error('Session replaced or missing; inspect receipt');
  const s = state.session;
  return { state, covered: (s.spent > s.crystallizedCumulative ? s.spent : s.crystallizedCumulative)
      >= BigInt(journal.reservationInput.voucher.payload.cumulativeAmount) && s.currentOutstanding === 0n };
}

// Recovery never signs another voucher or retries an unknown merchant delivery.
export async function recoverSettlement(connection, journal, receipt) {
  if (!journal.reservationInput || !['delivering', 'delivered', 'settled'].includes(journal.stage)) throw new Error('No delivered voucher to settle');
  if (journal.stage === 'delivering') journal.deliveryOutcome ??= 'unknown';
  if (!(await settledFrontier(connection, journal)).covered) {
    const v = voucherFromJournal(journal);
    const response = await fetch(`${journal.facilitator}/tab/settle`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptedAmount: journal.reservationInput.reservationAmountAtomic,
        ...v.payload, sessionPublicKey: Buffer.from(v.sessionPublicKey).toString('hex'),
        sessionSignature: Buffer.from(v.sessionSignature).toString('hex'),
        sessionRegistration: Buffer.from(v.sessionRegistration).toString('hex'), network: 'solana:mainnet' }),
    });
    const body = await response.json();
    journal.settlement = body;
    save(receipt, journal);
    if (!response.ok) throw new Error(`Settlement HTTP ${response.status}; saved response in receipt`);
    if (!(await settledFrontier(connection, journal)).covered) throw new Error('Settlement did not clear the exact outstanding obligation');
  }
  journal.stage = 'settled'; save(receipt, journal);
  return journal;
}

export async function purchase(options) {
  for (const url of [options.rpc, options.endpoint, options.facilitator]) assertLocalUnlessLive(url, options.live);
  const receipt = resolve(options.receipt);
  return withGrantLock(options.grant, async record => {
  let key;
  try {
    key = readKey(record.keyPath);
    if (record.pendingReceipt) throw new Error(`Unfinished purchase: ${record.pendingReceipt}; recover it before another purchase`);
    const connection = new Connection(options.rpc, 'confirmed');
    const params = await approvedGrant(connection, options.vault, record, key);
    const body = options.body ? readFileSync(options.body, 'utf8') : undefined;
    const init = { method: body !== undefined ? 'POST' : 'GET', redirect: 'error', headers: body !== undefined ? { 'content-type': 'application/json' } : {}, ...(body !== undefined ? { body } : {}) };
    const resolved = await resolveTabOffer(options.endpoint, init);
    if (resolved.kind !== 'offer') throw new Error(`Merchant has no payable tab offer: ${resolved.kind}`);
    const offer = resolved.offer;
    if (offer.payTo !== params.counterparty || offer.asset !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' || offer.networkCaip2 !== 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') throw new Error('Merchant offer is outside approved seller/USDC/network');
    if (BigInt(offer.amountAtomic) > BigInt(record.maxSingleAtomic)) throw new Error('Merchant price exceeds local maximum single purchase');
    const journal = { stage: 'created', vault: options.vault, merchant: params.counterparty,
      endpoint: options.endpoint, facilitator: options.facilitator, reason: options.reason,
      requestBody: body ?? null, createdAt: new Date().toISOString() };
    save(receipt, journal, true);
    // One unfinished purchase blocks further signing, even after a crash.
    record.pendingReceipt = receipt; save(options.grant, record);
    const tab = await tabFromGrant({
      sessionSecretKey: key.secretKey, params, vaultPda: options.vault, connection,
      perUnitCapAtomic: record.maxSingleAtomic, sellerUrl: options.endpoint,
      facilitatorUrl: options.facilitator,
      reserveFinalVoucherV2: async input => {
        journal.reservationInput = input; journal.stage = 'signed'; save(receipt, journal);
        const reservation = await reservationFence(options, journal, receipt)(input);
        journal.reservationReceipt = reservation; journal.stage = 'reserved'; save(receipt, journal);
        return reservation;
      },
    });
    const voucher = await tab.signNextVoucher(offer.amountAtomic);
    journal.stage = 'delivering'; journal.deliveryOutcome = 'unknown'; save(receipt, journal);
    const response = await fetch(options.endpoint, { ...init,
      headers: { ...init.headers, 'X-Tab-Voucher': voucherToHeader(voucher) } });
    const delivery = Buffer.from(await response.arrayBuffer());
    save(`${receipt}.delivery.json`, { status: response.status, contentType: response.headers.get('content-type'),
      sha256: createHash('sha256').update(delivery).digest('hex'), base64: delivery.toString('base64') }, true);
    journal.deliveryStatus = response.status; journal.deliveryOutcome = 'response-recorded'; journal.stage = 'delivered'; save(receipt, journal);
    // Preserve and settle the signed obligation even if merchant delivery failed.
    journal.settlement = await tab.close();
    if (!(await settledFrontier(connection, journal)).covered) throw new Error('Purchase still has an outstanding obligation');
    journal.stage = 'settled'; save(receipt, journal);
    delete record.pendingReceipt; save(options.grant, record);
    if (!response.ok) throw new Error(`Merchant HTTP ${response.status}; obligation settled; inspect saved delivery`);
    return journal;
  } finally { key?.secretKey.fill(0); }
  });
}

export async function resume(options) {
  return withGrantLock(options.grant, async record => {
  const receipt = resolve(options.receipt);
  if (record.pendingReceipt !== receipt) throw new Error('Receipt is not the pending purchase for this grant');
  const journal = JSON.parse(readFileSync(receipt, 'utf8'));
  for (const url of [options.rpc, journal.facilitator, journal.endpoint]) assertLocalUnlessLive(url, options.live);
  const connection = new Connection(options.rpc, 'confirmed');
  if (journal.stage === 'created') {
    // No signature was written or released, so no obligation can exist.
    delete record.pendingReceipt; save(options.grant, record);
    journal.stage = 'cancelled-before-signing'; save(receipt, journal);
    return journal;
  }
  if (['signed', 'reserved'].includes(journal.stage)) {
    // The facilitator or merchant may have settled while this process was down.
    // Reconcile that obligation without dispatching a delivery after payment.
    if ((await settledFrontier(connection, journal)).covered) {
      journal.stage = 'settled'; journal.deliveryOutcome = 'not-dispatched'; save(receipt, journal);
      delete record.pendingReceipt; save(options.grant, record);
      return journal;
    }
    options.facilitator = journal.facilitator;
    const input = { ...journal.reservationInput, voucher: voucherFromJournal(journal) };
    delete input.voucher.reservationReceipt;
    const reservation = await reservationFence(options, journal, receipt)(input);
    await verifySolanaFinalVoucherV2Reservation(connection, input, reservation);
    journal.reservationReceipt = reservation; journal.stage = 'delivering'; journal.deliveryOutcome = 'unknown'; save(receipt, journal);
    const response = await fetch(journal.endpoint, { method: journal.requestBody === null ? 'GET' : 'POST', redirect: 'error',
      headers: { ...(journal.requestBody === null ? {} : { 'content-type': 'application/json' }), 'X-Tab-Voucher': voucherToHeader(voucherFromJournal(journal)) },
      ...(journal.requestBody === null ? {} : { body: journal.requestBody }) });
    const delivery = Buffer.from(await response.arrayBuffer());
    save(`${receipt}.delivery.json`, { status: response.status, sha256: createHash('sha256').update(delivery).digest('hex'), base64: delivery.toString('base64') }, true);
    journal.deliveryStatus = response.status; journal.deliveryOutcome = 'response-recorded'; journal.stage = 'delivered'; save(receipt, journal);
  }
  // A crash during delivery leaves its outcome unknown. Settle the existing
  // obligation and preserve that gap; never send the merchant request twice.
  const result = await recoverSettlement(connection, journal, receipt);
  delete record.pendingReceipt; save(options.grant, record);
  return result;
  });
}

/** The exact body and X-Tab-Voucher a purchase sent, rebuilt from its journal. */
export function savedPaidRequest(journal) {
  if (!['delivering', 'delivered', 'settled'].includes(journal.stage) || !journal.reservationReceipt) {
    throw new Error('This receipt never sent a paid request; use resume');
  }
  return { body: journal.requestBody, header: voucherToHeader(voucherFromJournal(journal)) };
}

// After a failed or unknown delivery, send the identical saved request once. A
// seller that recorded the order returns its saved receipt; nothing is signed,
// reserved or settled here, so the buyer never pays again.
export async function resend(options) {
  const receipt = resolve(options.receipt);
  const journal = JSON.parse(readFileSync(receipt, 'utf8'));
  assertLocalUnlessLive(journal.endpoint, options.live);
  const { body, header } = savedPaidRequest(journal);
  const outcome = `${receipt}.resend.json`;
  save(outcome, { stage: 'sending', startedAt: new Date().toISOString() }, true);
  const response = await fetch(journal.endpoint, { method: body === null ? 'GET' : 'POST', redirect: 'error',
    headers: { ...(body === null ? {} : { 'content-type': 'application/json' }), 'X-Tab-Voucher': header },
    ...(body === null ? {} : { body }) });
  const delivery = Buffer.from(await response.arrayBuffer());
  save(outcome, { stage: 'response-recorded', status: response.status, contentType: response.headers.get('content-type'),
    sha256: createHash('sha256').update(delivery).digest('hex'), base64: delivery.toString('base64') });
  return { status: response.status, outcome };
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    key: { type: 'string' }, grant: { type: 'string' }, merchant: { type: 'string' }, cap: { type: 'string' },
    revolving: { type: 'string' }, 'max-single': { type: 'string' }, domain: { type: 'string' },
    rpc: { type: 'string', default: 'http://127.0.0.1:27899' }, vault: { type: 'string' },
    endpoint: { type: 'string' }, facilitator: { type: 'string', default: 'http://127.0.0.1:27901' },
    receipt: { type: 'string' }, body: { type: 'string' }, reason: { type: 'string' },
    'token-env-file': { type: 'string' }, live: { type: 'boolean', default: false },
  } });
  const command = positionals[0];
  const required = command === 'request' ? ['key', 'grant', 'merchant']
    : command === 'buy' ? ['grant', 'vault', 'endpoint', 'receipt', 'reason']
      : command === 'resume' ? ['grant', 'receipt'] : command === 'resend' ? ['receipt'] : [];
  if (!required.length) throw new Error('Use request, buy, resume, or resend (see scripts/CASE-TWO.md)');
  for (const name of required) if (!values[name]) throw new Error(`--${name} is required`);
  let result;
  if (command === 'request') result = makeRequest(values);
  if (command === 'buy') result = await purchase(values);
  if (command === 'resume') result = await resume(values);
  if (command === 'resend') result = await resend(values);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
