#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { createTransferCheckedInstruction } from '@solana/spl-token';
import * as mandate from '@dexterai/vault/mandate';
import * as instructions from '@dexterai/vault/instructions';
import { contextBoundVoucherV2Message } from '@dexterai/vault/messages';
import { verifySolanaEd25519Strict } from '@dexterai/vault/precompile';
import { deriveSessionPda } from '@dexterai/vault';
import { finalVoucherV2ReservationBindingDigest } from '@dexterai/x402/tab';
import { SOLANA_MAINNET, USDC_MINT, checkSellerOffer, decodeCompactJws, knownSellers,
  liveSellerStatus, screenSeller, verifySellerEvidence, verifySellerReceipt } from '@dexterai/x402/seller';
import { archiveRawUrl, fetchPublicBytes, publicHttps, sha256 } from './archive.mjs';

const PROGRAM = 'Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SCREENSHOT = 'https://dexter.cash/proof/case-three/first-contact-v1.png';
const variants = ['V1', 'V2', 'V3', 'V4', 'V5'];
const requireCheck = (condition, message) => { if (!condition) throw new Error(message); };
const key = value => new PublicKey(value);
const equal = isDeepStrictEqual;
const atomic = value => ({baseUnits: value, usdc: `${BigInt(value) / 1_000_000n}.${(BigInt(value) % 1_000_000n).toString().padStart(6, '0')}`});
const ata = owner => PublicKey.findProgramAddressSync([key(owner).toBuffer(), TOKEN.toBuffer(), key(USDC_MINT).toBuffer()], ATA)[0];
export function bytes(value, name, length) {
  requireCheck(typeof value === 'string' && /^[A-Za-z0-9_-]*$/.test(value), `${name}: expected base64url`);
  const out = Buffer.from(value, 'base64url');
  requireCheck(out.toString('base64url') === value && (length === undefined || out.length === length), `${name}: invalid bytes`);
  return out;
}
const hex = (value, length = 32) => {
  requireCheck(typeof value === 'string' && new RegExp(`^[0-9a-f]{${length * 2}}$`).test(value), 'Expected lowercase hex');
  return Buffer.from(value, 'hex');
};
const txOptions = {commitment: 'finalized', maxSupportedTransactionVersion: 0};
const sameInstruction = (actual, wanted, trailing = false) => actual.programId.equals(wanted.programId)
  && actual.data.equals(wanted.data) && (trailing ? actual.keys.length >= wanted.keys.length : actual.keys.length === wanted.keys.length)
  && wanted.keys.every((entry, i) => actual.keys[i].pubkey.equals(entry.pubkey)
    && (!entry.isSigner || actual.keys[i].isSigner) && (!entry.isWritable || actual.keys[i].isWritable));

export function requireProgramLog(tx, refusal) {
  requireCheck(typeof refusal.programLog === 'string' && refusal.programLog.startsWith('Program log: AnchorError ')
    && refusal.programLog.includes(`Error Number: ${refusal.error.code}.`)
    && refusal.programLog.includes(`Error Code: ${refusal.error.name}.`)
    && (tx?.meta?.logMessages ?? []).includes(refusal.programLog), 'Retained program log differs from the node');
  return refusal.programLog;
}

export function registrationOf(record) {
  const p = record.manifest.permission;
  return {vault: record.manifest.account.vault, sessionAddress: p.sessionAddress, executionKey: p.executionKey, seller: p.seller,
    ownerPublicKey: record.ownerPublicKeySec1Base64url, registrationSignature: p.registrationSignature,
    capAtomic: p.capAtomic, revolvingCapAtomic: p.revolvingCapacityAtomic, expiresAtUnix: p.expiresAtUnix, nonce: p.nonce};
}
export async function verifyApproval(connection, record) {
  const r = registrationOf(record);
  const reading = {program: PROGRAM, mandate: r.sessionAddress, slot: await connection.getSlot('finalized'), status: 'live', terms: {
    vault: r.vault, approverPasskey: bytes(r.ownerPublicKey, 'owner key', 33).toString('hex'), agent: r.executionKey, payee: r.seller,
    maxAmount: atomic(r.capAtomic), maxRevolvingCapacity: atomic(r.revolvingCapAtomic), expiresAt: {
      unix: r.expiresAtUnix, iso: new Date(r.expiresAtUnix * 1000).toISOString()}, nonce: r.nonce,
    spent: atomic('0'), remaining: atomic(r.capAtomic), currentOutstanding: atomic('0'),
  }};
  const approval = await mandate.verifyMandateApproval(connection, reading, {registrationSignature: r.registrationSignature});
  requireCheck(approval.verified && approval.signature === r.registrationSignature && approval.slot !== null
    && approval.checks.length > 0 && approval.checks.every(check => check.ok), 'Approval signature or permission terms failed');
  return approval;
}

export async function verifySellerRecord(record, approval) {
  requireCheck(approval?.verified && approval.ceremonyNonce, 'A verified approval ceremony nonce is required');
  const r = registrationOf(record), s = record.seller;
  const evidence = await verifySellerEvidence({binding: bytes(s.binding, 'binding'), salt: bytes(s.salt, 'salt', 32),
    ceremonyNonce: hex(approval.ceremonyNonce), didDocument: s.didDocument === null ? null : bytes(s.didDocument, 'store file'),
    offerJws: s.offerJws, registration: {vault: r.vault, counterparty: r.seller, sessionPubkey: r.executionKey}, history: []});
  const retained = sha256(bytes(s.binding, 'binding')) === s.bindingSha256 && s.registerTx === r.registrationSignature
    && s.ceremonyNonce === approval.ceremonyNonce;
  evidence.checks.push({name: 'retained_binding', ok: retained, detail: 'Saved binding hash, registration and nonce equal the verified approval'});
  const manifest = record.manifest.seller, binding = evidence.binding;
  const manifestMatches = !!binding && manifest.bindingSha256 === s.bindingSha256 && manifest.host === binding.host
    && manifest.registrableDomain === binding.registrableDomain && manifest.did === binding.did && manifest.kid === binding.kid;
  evidence.checks.push({name: 'manifest_seller', ok: manifestMatches, detail: 'The manifest names the same binding, host, domain, DID and key'});
  evidence.verified &&= retained && manifestMatches;
  return evidence;
}

export async function rerunCopycat(attempt, known, {firstContact = false} = {}) {
  const grant = attempt.request;
  const request = {counterparty: grant.counterparty, appName: grant.app?.name ?? '', seller: grant.seller,
    scheme: 'tab', network: SOLANA_MAINNET, asset: USDC_MINT};
  requireCheck(Number.isSafeInteger(attempt.checkedAt) && attempt.checkedAt > 0, 'Invalid recorded check time');
  if (!firstContact) {
    const offer = request.seller?.offer;
    const decoded = offer ? decodeCompactJws(offer.signature) : null;
    requireCheck(attempt.validUntil === (decoded && typeof decoded !== 'string' ? decoded.payload.validUntil : null),
      'Saved quote expiry differs from its signed payload');
  }
  const documents = new Map();
  for (const document of attempt.documents) {
    const saved = bytes(document.bytes, 'saved document');
    requireCheck(sha256(saved) === document.sha256 && !documents.has(document.url), 'Saved document hash or URL differs');
    documents.set(document.url, saved);
  }
  const fetched = new Set(), missing = new Set();
  const check = await checkSellerOffer(request, {now: attempt.checkedAt, known,
    fetchDidDocument: async url => {
      if (!documents.has(url)) {missing.add(url); throw new Error('Document was not saved');}
      fetched.add(url); return documents.get(url);
    }});
  const decision = screenSeller(check, {request, sessionPubkey: grant.sessionPubkey, known,
    agentKeys: [], history: 'loaded'});
  requireCheck(missing.size === 0 && fetched.size === documents.size, 'The saved documents do not match the URLs fetched');
  if (firstContact) {
    requireCheck(attempt.expected.approve === 'allowed' && attempt.expected.relation === 'first-payment'
      && decision.approve === 'allowed' && decision.seller.relation === 'first-payment', 'First-contact outcome differs');
  } else {
    const outcome = decision.approve === 'refused' ? decision.refusal : decision.approve === 'confirm' ? decision.notices[0] : undefined;
    requireCheck(decision.approve === attempt.expected.approve && outcome?.rule === attempt.expected.rule
      && outcome?.code === attempt.expected.code, 'Copycat approve, rule or code differs');
  }
  return decision;
}

export async function verifyCopycatHistory(connection, vault, impostor, retained) {
  const session = deriveSessionPda(key(vault), key(impostor))[0];
  let before;
  let count = 0;
  const seen = new Set();
  for (;;) {
    const page = await connection.getSignaturesForAddress(session, {limit: 1000, ...(before ? {before} : {})}, 'finalized');
    if (!page.length) break;
    for (const row of page) {
      requireCheck(row.err !== null && row.err !== undefined && !seen.has(row.signature), 'Successful or repeated copycat history entry');
      seen.add(row.signature); count++;
    }
    before = page.at(-1).signature;
  }
  requireCheck(await connection.getAccountInfo(session, 'finalized') === null, 'The copycat session account exists');
  if (retained !== undefined) {
    requireCheck(retained.impostor === impostor && retained.sessionAddress === session.toBase58() && retained.accountExists === false
      && Number.isSafeInteger(retained.slot) && retained.slot > 0 && Array.isArray(retained.signatures)
      && new Set(retained.signatures.map(row => row.signature)).size === retained.signatures.length
      && retained.signatures.every(row => row.err === true && seen.has(row.signature)),
      'Retained copycat history differs from the enumerated session history');
  }
  return {sessionAddress: session.toBase58(), failedSignatures: count};
}

const voucherMessage = (r, proof, seller = r.seller, session = r.sessionAddress) => contextBoundVoucherV2Message({
  programId: key(PROGRAM), vaultPda: key(r.vault), sessionPda: key(session), seller: key(seller), sessionNonce: r.nonce,
  channelId: hex(proof.channelId), cumulativeAmount: BigInt(proof.cumulativeAmount), sequenceNumber: proof.sequenceNumber,
});

/** Decode the signed Swig payload through the public vault SDK and compare pure SPL-built TransferChecked instructions. */
export function verifyPayoutTransfers(payout, expected) {
  const {swig, wallet, source, transfers} = expected;
  requireCheck(transfers.length >= 1 && transfers.length <= 2 && source.equals(ata(wallet))
    && payout.keys[0]?.pubkey.equals(swig) && payout.keys[1]?.pubkey.equals(wallet), 'Payout wallet or transfer count differs');
  const decoded = instructions.decodeOwnerCompoundInstructions(payout, transfers.length);
  requireCheck(decoded.roleId === 6, 'Payout does not use the claim-settlement Swig role');
  for (const [index, transfer] of transfers.entries()) {
    requireCheck(transfer.amount > 0n, 'Payout transfer amount must be positive');
    const wanted = createTransferCheckedInstruction(source, key(USDC_MINT), transfer.destination, wallet, transfer.amount, 6, [], TOKEN);
    // Swig signs for the wallet during the CPI; its outer transport carries that wallet as a non-signer.
    wanted.keys[3].isSigner = false;
    requireCheck(sameInstruction(decoded.instructions[index], wanted), 'Signed payout transfer differs from the approved destination or amount');
  }
  return decoded;
}

export async function verifyPurchase(connection, record, action, purchase, approval) {
  const r = registrationOf(record), proof = action.proof, expected = action.expected;
  requireCheck(proof?.schema === 'dexter-tab-locked-action-v1' && action.status === 'confirmed' && action.reservation
    && action.id === purchase.id && action.seller === r.seller && action.reference === proof.settlementSignature
    && action.signatureReference === proof.lockSignature && expected.amountAtomic === action.amountAtomic
    && proof.amountAtomic === action.amountAtomic && purchase.requestedAction.amountAtomic === action.amountAtomic
    && proof.voucher.channelId === expected.channelId && equal(proof.voucher.channelId, purchase.voucher.channelId)
    && proof.voucher.sequenceNumber === purchase.voucher.sequenceNumber
    && proof.voucher.cumulativeAmount === purchase.voucher.cumulativeAmount
    && proof.previousCumulativeAmount === purchase.voucher.previousCumulativeAmount, 'Purchase does not match the manifest');
  const amount = BigInt(proof.amountAtomic), fee = amount * BigInt(record.manifest.feePolicy.bps) / 10000n;
  requireCheck(amount > 0n && amount <= BigInt(r.revolvingCapAtomic)
    && BigInt(proof.voucher.cumulativeAmount) <= BigInt(r.capAtomic)
    && BigInt(proof.voucher.cumulativeAmount) - BigInt(proof.previousCumulativeAmount) === amount
    && proof.voucher.sessionNonce === r.nonce && key(hex(proof.voucher.sessionPublicKey)).toBase58() === r.executionKey
    && expected.feeAtomic === fee.toString() && proof.feeAtomic === fee.toString()
    && expected.sellerNetAmountAtomic === (amount - fee).toString() && proof.sellerNetAmountAtomic === (amount - fee).toString()
    && proof.feeRecipient === (fee > 0n ? record.manifest.feePolicy.recipient : null)
    && expected.feeRecipient === proof.feeRecipient, 'Purchase exceeds permission or changes the fee');
  const message = voucherMessage(r, proof.voucher), signature = hex(proof.voucher.sessionSignature, 64), publicKey = key(r.executionKey).toBytes();
  requireCheck(verifySolanaEd25519Strict(message, signature, publicKey), 'Agent voucher signature failed');
  const hash = sha256(message), claim = instructions.deriveLockedClaimPda(key(r.vault), hex(hash));
  requireCheck(hash === proof.voucherHash && claim.toBase58() === proof.claimAddress, 'Claim does not match the signed voucher');
  const lockTx = await connection.getTransaction(proof.lockSignature, txOptions);
  const lock = mandate.decodeCaseTransaction(lockTx, proof.lockSignature);
  requireCheck(lock.top.length === lock.start + 2, 'Unexpected lock transaction instructions');
  mandate.verifyCaseVoucherInstruction(lock.top[lock.start], {key: publicKey, signature, message});
  const lockIx = lock.top[lock.start + 1], authority = lockIx.keys[7]?.pubkey, holder = lockIx.keys[6]?.pubkey;
  const swig = key(record.manifest.account.swig), wallet = instructions.deriveSwigWalletAddress(swig), source = ata(wallet);
  const wantedLock = instructions.buildLockVoucherInstruction({vaultPda: key(r.vault), vaultUsdcAta: source, swigAddress: swig,
    sellerHolder: holder, dexterAuthority: authority, payer: lockIx.keys[8]?.pubkey, allowedCounterparty: key(r.seller),
    channelId: hex(proof.voucher.channelId), cumulativeAmount: BigInt(proof.voucher.cumulativeAmount),
    sequenceNumber: proof.voucher.sequenceNumber, voucherHash: hex(hash), maturityAt: null, holderRecoveryAt: null});
  requireCheck(sameInstruction(lockIx, wantedLock), 'Lock instruction differs from the SDK instruction');
  const claimIndex = Array.from({length: lock.keys.length}, (_, i) => lock.keys.get(i)).findIndex(k => k.equals(claim));
  requireCheck(claimIndex >= 0 && lockTx.meta.preBalances[claimIndex] === 0 && lockTx.meta.postBalances[claimIndex] > 0,
    'The lock did not create this claim');
  const tx = await connection.getTransaction(proof.settlementSignature, txOptions);
  const settled = mandate.decodeCaseTransaction(tx, proof.settlementSignature);
  const wantedSettle = instructions.buildSettleLockedVoucherInstruction({swigAddress: swig, claimPda: claim,
    vaultPda: key(r.vault), vaultUsdcAta: source, holder, dexterAuthority: authority});
  const settleIndex = settled.top.findIndex(ix => sameInstruction(ix, wantedSettle));
  requireCheck(settleIndex >= settled.start && settleIndex === settled.top.length - 2, 'The payout did not settle this claim');
  const swigCalls = instructions.inspectSwigInstructions(new VersionedTransaction(tx.transaction.message));
  const payout = settled.top[settleIndex + 1];
  requireCheck(swigCalls.length === 1 && swigCalls[0].discriminator === 11 && swigCalls[0].roleId === 6
    && payout.keys[0]?.pubkey.equals(swig) && payout.keys[1]?.pubkey.equals(wallet), 'Payout does not use the claim-settlement Swig role');
  const settledClaim = Array.from({length: settled.keys.length}, (_, i) => settled.keys.get(i)).findIndex(k => k.equals(claim));
  requireCheck(settledClaim >= 0 && tx.meta.preBalances[settledClaim] > 0 && tx.meta.postBalances[settledClaim] === 0,
    'The payout did not close this claim');
  const legs = [{account: source, owner: wallet, delta: -amount}, {account: ata(r.seller), owner: key(r.seller), delta: amount - fee},
    ...(fee > 0n ? [{account: ata(proof.feeRecipient), owner: key(proof.feeRecipient), delta: fee}] : [])];
  verifyPayoutTransfers(payout, {swig, wallet, source, transfers: legs.slice(1).map(leg => ({destination: leg.account, amount: leg.delta}))});
  // The signed payload is checked above. The SDK checks exact canonical token-account deltas reported by the node.
  // A newly created destination has no pre-balance row.
  const existing = [];
  for (const leg of legs) {
    const index = Array.from({length: settled.keys.length}, (_, i) => settled.keys.get(i)).findIndex(k => k.equals(leg.account));
    const before = (tx.meta.preTokenBalances ?? []).filter(row => row.accountIndex === index);
    if (before.length) {existing.push(leg); continue;}
    const after = (tx.meta.postTokenBalances ?? []).filter(row => row.accountIndex === index);
    requireCheck(leg.delta > 0n && index >= 0 && tx.meta.preBalances[index] === 0 && tx.meta.postBalances[index] > 0
      && after.length === 1 && after[0].mint === USDC_MINT && after[0].owner === leg.owner.toBase58()
      && after[0].programId === TOKEN.toBase58() && after[0].uiTokenAmount.decimals === 6
      && after[0].uiTokenAmount.amount === leg.delta.toString(), 'New token destination does not receive the exact purchase amount');
  }
  mandate.verifyCaseTokenDeltas(tx, proof.settlementSignature, existing);
  const reservationTx = await connection.getTransaction(action.reservation.signature, txOptions);
  const reservation = mandate.decodeCaseTransaction(reservationTx, action.reservation.signature);
  requireCheck(reservation.start === 0 && reservation.top.length === 2, 'Unexpected reservation instructions');
  const reserve = instructions.buildSettleVoucherInstruction({vaultPda: key(r.vault), dexterAuthority: authority,
    allowedCounterparty: key(r.seller), swigAddress: swig, vaultUsdcAta: source, amount, increment: true});
  requireCheck(sameInstruction(reservation.top[0], reserve, true), 'Reservation instruction differs from the SDK instruction');
  const v = proof.voucher;
  const binding = finalVoucherV2ReservationBindingDigest({network: SOLANA_MAINNET, programId: PROGRAM,
    buyerSwigAddress: swig.toBase58(), vaultPda: r.vault, sessionPda: r.sessionAddress, seller: r.seller,
    channelId: v.channelId, sessionNonce: v.sessionNonce, reservationAmountAtomic: action.amountAtomic,
    previousCumulativeAtomic: proof.previousCumulativeAmount, voucherDigest: '', idempotencyKey: '', voucher: {
      payload: {channelId: v.channelId, cumulativeAmount: v.cumulativeAmount, sequenceNumber: v.sequenceNumber},
      sessionPublicKey: hex(v.sessionPublicKey), sessionSignature: signature, sessionRegistration: hex(action.reservation.sessionRegistration, 188)}});
  const memo = reservation.top[1];
  requireCheck(memo.programId.toBase58() === MEMO && memo.keys.length === 1 && memo.keys[0].pubkey.equals(authority)
    && memo.keys[0].isSigner && memo.data.toString() === `dexter-native-tab-v2-reservation/v1:${binding}`, 'Reservation voucher memo differs');
  requireCheck(reservationTx.slot === action.reservation.slot && approval.slot < reservationTx.slot
    && reservationTx.slot <= lockTx.slot && lockTx.slot <= tx.slot && lockTx.blockTime <= r.expiresAtUnix
    && reservationTx.blockTime <= lockTx.blockTime && lockTx.blockTime <= tx.blockTime, 'Purchase chain order or expiry differs');
  return {verified: true, signature: proof.settlementSignature, slot: tx.slot, blockTime: tx.blockTime,
    lockSlot: lockTx.slot, lockBlockTime: lockTx.blockTime, reservationBlockTime: reservationTx.blockTime,
    claimAddress: claim.toBase58(), holder: holder.toBase58(), dexterAuthority: authority.toBase58(), seller: r.seller};
}

export async function verifyReceipt(record, action, purchase, payment, binding) {
  const delivery = action.deliveryProof, receipt = delivery?.bookstoreReceipt;
  requireCheck(payment?.verified && receipt?.schema === 'dexter-books-receipt/v1' && receipt.storeReceipt?.format === 'jws'
    && receipt.resourceUrl === purchase.requestedAction.resourceUrl && delivery.resourceUrl === receipt.resourceUrl
    && sha256(Buffer.from(delivery.responseBody)) === delivery.responseDigest
    && equal(JSON.parse(delivery.responseBody), receipt) && equal(receipt.order, purchase.requestedAction.bookstoreOrder)
    && receipt.payment.seller === binding.counterparty && receipt.payment.channelId === action.proof.voucher.channelId
    && receipt.payment.sequenceNumber === action.proof.voucher.sequenceNumber
    && receipt.payment.cumulativeAtomic === action.proof.voucher.cumulativeAmount
    && receipt.payment.amountAtomic === action.amountAtomic, 'Receipt, order and payment differ');
  requireCheck(sha256(Buffer.from(purchase.requestedAction.orderRequestBody)) === purchase.requestedAction.payloadDigest
    && equal(JSON.parse(purchase.requestedAction.orderRequestBody), receipt.order), 'Order bytes differ from the manifest');
  const result = await verifySellerReceipt({receiptJws: receipt.storeReceipt.signature,
    didDocument: bytes(record.seller.didDocument, 'store file'), kid: binding.kid, expected: {
      resourceUrl: purchase.requestedAction.resourceUrl, payer: record.manifest.account.vault,
      network: SOLANA_MAINNET, issuedAtMin: payment.reservationBlockTime - 120, issuedAtMax: payment.lockBlockTime + 120}});
  requireCheck(result.ok, `Store receipt: ${result.code}`);
  return result;
}

export async function verifyRedirect(connection, record, refusal, payments, approval) {
  const r = registrationOf(record), tx = await connection.getTransaction(refusal.signature, txOptions);
  const payment = payments[1];
  requireCheck(payment?.verified, 'Purchase 2 must verify before its redirect');
  const authority = payment.dexterAuthority;
  const locked = refusal.kind === 'payout-redirect';
  requireCheck(refusal.error.code === (locked ? 6070 : 3012), 'Wrong redirect refusal code');
  requireCheck(refusal.impostor !== r.seller, 'Redirect recipient equals the approved seller');
  if (locked) requireCheck(refusal.claimAddress === payment.claimAddress && refusal.attemptedAmountAtomic === record.actions[1].amountAtomic,
    'Redirect does not name purchase 2');
  const session = deriveSessionPda(key(r.vault), key(refusal.impostor))[0].toBase58();
  if (!locked) {
    const used = record.actions.reduce((max, action, index) => {
      const payment = payments[index];
      const cumulative = payment?.verified && payment.lockSlot < refusal.slot ? BigInt(action.proof.voucher.cumulativeAmount) : 0n;
      return cumulative > max ? cumulative : max;
    }, 0n);
    requireCheck(refusal.sessionAddress === session && refusal.agentRequest
      && BigInt(refusal.agentRequest.cumulativeAmount) - used === BigInt(refusal.attemptedAmountAtomic), 'Redirect has no matching copycat voucher');
  }
  const decoded = mandate.verifyCaseFailedTransaction(tx, refusal.signature, {program: PROGRAM, code: refusal.error.code,
    attempt: locked ? {instruction: 'settle_locked_voucher', vault: r.vault, claim: payment.claimAddress,
      holder: payment.holder, authority, destinationOwner: refusal.impostor, amount: BigInt(refusal.attemptedAmountAtomic)}
      : {instruction: 'settle_voucher', vault: r.vault, counterparty: refusal.impostor,
        authority, amount: BigInt(refusal.attemptedAmountAtomic)}});
  requireCheck(decoded.failedInstruction.keys[locked ? 0 : 4]?.pubkey.toBase58() === record.manifest.account.swig,
    'Redirect names a different vault Swig');
  requireCheck(decoded.slot === refusal.slot && decoded.slot > approval.slot
    && (refusal.blockTime === null || decoded.blockTime === refusal.blockTime), 'Redirect slot or time differs');
  if (locked) requireCheck(decoded.slot > payment.lockSlot && decoded.slot < payment.slot, 'The redirect did not precede the same claim payout');
  else {
    const request = refusal.agentRequest;
    const channelId = bytes(request.channelId, 'redirect channelId', 32);
    const message = voucherMessage(r, {...request, channelId: channelId.toString('hex')}, refusal.impostor, session);
    const signature = bytes(request.sessionSignature, 'redirect sessionSignature', 64), publicKey = key(r.executionKey).toBytes();
    requireCheck(decoded.failedInstructionIndex - 1 >= decoded.start, 'Redirect has no preceding agent instruction');
    mandate.verifyCaseVoucherInstruction(decoded.top[decoded.failedInstructionIndex - 1], {key: publicKey, signature, message});
    requireCheck(verifySolanaEd25519Strict(message, signature, publicKey), 'Copycat voucher signature failed');
  }
  return requireProgramLog(tx, refusal);
}

export async function verifyScreenshot(firstContact, fetcher = fetch) {
  requireCheck(firstContact?.screenshot.path === '/proof/case-three/first-contact-v1.png', 'Unexpected first-contact screenshot path');
  const {bytes: screenshot} = await fetchPublicBytes(SCREENSHOT, {fetcher});
  requireCheck(sha256(screenshot) === firstContact.screenshot.sha256, 'Screenshot hash differs');
  return firstContact.screenshot.sha256;
}

export async function verifyLimitRefusal(connection, record, refusal, payments, approval) {
  const r = registrationOf(record), request = refusal.agentRequest;
  requireCheck([6013, 6009].includes(refusal.error.code) && refusal.program === PROGRAM && request
    && request.executionKey === r.executionKey && refusal.instruction === 'settle_voucher', 'Refusal is not this agent reservation');
  const tx = await connection.getTransaction(refusal.signature, txOptions);
  const decoded = mandate.verifyCaseFailedTransaction(tx, refusal.signature, {program: PROGRAM, code: refusal.error.code,
    attempt: {instruction: 'settle_voucher', vault: r.vault, counterparty: r.seller,
      authority: payments[0]?.dexterAuthority, amount: BigInt(refusal.attemptedAmountAtomic)}});
  requireCheck(payments[0]?.verified && decoded.slot === refusal.slot && decoded.slot > approval.slot
    && (refusal.blockTime === null || decoded.blockTime === refusal.blockTime), 'Refusal has no verified authority or wrong time');
  const message = hex(request.message), signature = hex(request.sessionSignature, 64), publicKey = key(r.executionKey).toBytes();
  requireCheck(decoded.failedInstructionIndex - 1 >= decoded.start, 'Refusal has no preceding agent instruction');
  mandate.verifyCaseVoucherInstruction(decoded.top[decoded.failedInstructionIndex - 1], {key: publicKey, signature, message});
  requireCheck(verifySolanaEd25519Strict(message, signature, publicKey), 'Refusal agent signature failed');
  const prior = record.actions.map((action, index) => ({action, payment: payments[index]})).filter(row => row.payment?.verified && row.payment.lockSlot < decoded.slot);
  const locked = prior.reduce((max, row) => BigInt(row.action.proof.voucher.cumulativeAmount) > max ? BigInt(row.action.proof.voucher.cumulativeAmount) : max, 0n);
  const cap = BigInt(r.capAtomic), spent = BigInt(refusal.capacity.spentAtomic), used = spent > locked ? spent : locked;
  const remaining = cap > used ? cap - used : 0n;
  requireCheck(refusal.capacity.capAtomic === r.capAtomic && refusal.capacity.lockedAtomic === locked.toString()
    && refusal.capacity.usedAtomic === used.toString() && refusal.capacity.remainingAtomic === remaining.toString()
    && refusal.remainingCapacityAtomic === remaining.toString(), 'Refusal capacity differs from verified locks');
  if (request.voucher) requireCheck(Buffer.from(voucherMessage(r, request.voucher)).equals(message)
    && BigInt(request.voucher.cumulativeAmount) - used === BigInt(refusal.attemptedAmountAtomic)
    && prior.every(row => row.action.proof.voucher.sequenceNumber < request.voucher.sequenceNumber), 'Refusal voucher message differs');
  if (refusal.error.code === 6009) requireCheck(decoded.blockTime > r.expiresAtUnix, 'Expiry refusal predates expiry');
  return requireProgramLog(tx, refusal);
}

export async function verifyRecord(download, {connection, fetcher = fetch, emit = console.log} = {}) {
  const record = download.format === 'dexter-mandate-case-record/v1' ? download.case : download;
  const results = [];
  const report = (name, ok, detail, live = false) => {
    const row = {name, ok, detail: String(detail), live}; results.push(row);
    emit(`${live ? 'LIVE' : ok ? 'PASS' : 'FAIL'} ${name}: ${row.detail}`);
  };
  const run = async (name, callback) => {
    try {const detail = await callback(); report(name, true, typeof detail === 'string' ? detail : JSON.stringify(detail)); return detail;}
    catch (error) {report(name, false, error.message); return null;}
  };
  if (!await run('record', async () => {
    requireCheck(record?.schema === 'dexter-mandate-case/v1' && record.manifest?.schema === 'dexter-standing-case-manifest/v2'
      && record.seller && record.manifest.permission.network === SOLANA_MAINNET && record.manifest.permission.assetMint === USDC_MINT,
      'Expected a complete case-three record download');
    requireCheck(record.seller.bindingSha256 === record.manifest.seller.bindingSha256, 'Manifest seller binding hash differs');
    return record.caseId;
  })) return {ok: false, results};
  if (!await run('network', async () => { requireCheck(await connection.getGenesisHash() === GENESIS, 'RPC is not Solana mainnet'); return GENESIS; })) return {ok: false, results};
  const r = registrationOf(record);
  const approval = await run('approval', () => verifyApproval(connection, record));
  if (approval) for (const check of approval.checks) report(`approval.${check.name}`, check.ok, check.detail);
  let binding;
  await run('seller', async () => {
    const evidence = await verifySellerRecord(record, approval);
    for (const check of evidence.checks) report(`seller.${check.name}`, check.ok, check.detail);
    requireCheck(evidence.verified && evidence.binding, 'Seller evidence failed');
    binding = evidence.binding;
    return `nonce ${approval.ceremonyNonce}`;
  });
  await run('archive', async () => {
    requireCheck(binding && record.seller.archive, 'A verified seller and archive snapshot are required');
    const archive = record.seller.archive, raw = archiveRawUrl(archive.url);
    requireCheck(raw.endsWith(`/https://${binding.registrableDomain}/.well-known/did.json`), 'Archive URL names a different store file');
    const response = await fetchPublicBytes(raw, {fetcher, limit: 65_536}), hash = sha256(response.bytes);
    requireCheck(hash === binding.didDocumentSha256 && hash === archive.sha256, 'Decoded archive bytes differ from the signed binding');
    return `${raw} sha256 ${hash}`;
  });
  const payments = [];
  await run('purchases.complete', async () => {
    requireCheck(record.actions?.length === 2 && record.manifest.purchases.length === 2, 'Expected both purchases');
    const cited = record.actions.flatMap(action => [action.reference, action.signatureReference, action.reservation?.signature]);
    requireCheck(cited.every(Boolean) && new Set(cited).size === cited.length && new Set(record.actions.map(action => action.id)).size === 2,
      'A purchase reuses a signature or id');
    requireCheck(new Set(record.actions.map(action => action.proof.voucher.channelId)).size === 2
      && record.actions[1].proof.voucher.sequenceNumber > record.actions[0].proof.voucher.sequenceNumber
      && BigInt(record.actions[1].proof.previousCumulativeAmount) >= BigInt(record.actions[0].proof.voucher.cumulativeAmount),
      'Purchase voucher ranges overlap or reuse a channel');
    return 'two distinct purchase records';
  });
  for (const [index, purchase] of record.manifest.purchases.entries()) {
    const action = record.actions[index];
    payments[index] = await run(`purchase.${index + 1}.settlement`, async () => {
      requireCheck(approval, 'Approval must verify'); return verifyPurchase(connection, record, action, purchase, approval);
    });
    await run(`purchase.${index + 1}.receipt`, async () => {
      requireCheck(binding, 'Seller binding must verify'); return verifyReceipt(record, action, purchase, payments[index], binding);
    });
  }
  let known = [];
  await run('copycats.history_binding', async () => {
    requireCheck(binding && approval, 'Verified seller history required');
    known = knownSellers([{binding: bytes(record.seller.binding, 'binding'), salt: bytes(record.seller.salt, 'salt', 32),
      ceremonyNonce: hex(approval.ceremonyNonce), registerTx: r.registrationSignature, registeredAt: approval.blockTime}], {vault: r.vault});
    requireCheck(known.length === 1, 'Saved binding did not enter seller history'); return known[0].host;
  });
  await run('copycats.complete', async () => {
    requireCheck(record.impostorAttempts?.length === 5 && variants.every(v => record.impostorAttempts.filter(a => a.variant === v).length === 1),
      'Expected one copycat attempt for each V1 to V5'); return variants.join(', ');
  });
  for (const attempt of record.impostorAttempts ?? []) await run(`copycat.${attempt.variant}`, async () => {
    requireCheck(known.length === 1 && attempt.impostor === attempt.request.counterparty
      && attempt.knownBindingSha256 === record.seller.bindingSha256, 'Copycat does not name the approved history or its counterparty');
    const decision = await rerunCopycat(attempt, known);
    return `${decision.approve} ${decision.refusal?.rule ?? decision.notices?.[0]?.rule ?? ''} ${decision.refusal?.code ?? decision.notices?.[0]?.code ?? ''}`;
  });
  await run('first_contact', async () => {
    requireCheck(record.firstContact, 'First-contact record missing');
    await rerunCopycat(record.firstContact, [], {firstContact: true}); return 'allowed, first-payment';
  });
  await run('first_contact.screenshot', () => verifyScreenshot(record.firstContact, fetcher));
  const impostors = [...new Set((record.impostorAttempts ?? []).map(attempt => attempt.impostor))];
  await run('copycat_history.complete', async () => {
    requireCheck(record.impostorHistory?.length === impostors.length && impostors.length > 0
      && impostors.every(impostor => record.impostorHistory.filter(history => history.impostor === impostor).length === 1),
      'Retained history is required once for every copycat');
    return `${impostors.length} retained copycat histories`;
  });
  for (const impostor of impostors) await run(`copycat_history.${impostor}`, async () => {
    const retained = record.impostorHistory?.filter(history => history.impostor === impostor);
    requireCheck(retained?.length === 1, 'Retained copycat history is missing or duplicated');
    return verifyCopycatHistory(connection, r.vault, impostor, retained[0]);
  });
  await run('redirects.complete', async () => {
    requireCheck(record.redirectRefusals?.length === 2 && ['no-permission', 'payout-redirect'].every(kind => record.redirectRefusals.filter(a => a.kind === kind).length === 1),
      'Expected both redirect refusals'); return '3012 and 6070';
  });
  for (const refusal of record.redirectRefusals ?? []) await run(`redirect.${refusal.kind}`, async () => {
    requireCheck(approval && impostors.includes(refusal.impostor), 'Redirect does not name a recorded copycat');
    return verifyRedirect(connection, record, refusal, payments, approval);
  });
  await run('refusals.complete', async () => {
    requireCheck(record.refusals?.length === 2 && [6013, 6009].every(code => record.refusals.filter(refusal => refusal.error.code === code).length === 1),
      'Expected the over-budget and after-expiry refusals'); return '6013 and 6009';
  });
  for (const refusal of record.refusals ?? []) await run(`refusal.${refusal.error.code}`, async () => {
    requireCheck(approval, 'Approval must verify'); return verifyLimitRefusal(connection, record, refusal, payments, approval);
  });
  if (binding) report('store_file', true, await liveSellerStatus(binding, {fetchDidDocument: async url =>
    (await fetchPublicBytes(url, {fetcher, limit: 65_536})).bytes}), true);
  else report('store_file', true, 'unreadable (seller binding did not verify)', true);
  return {ok: results.filter(row => !row.live).every(row => row.ok), results};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireCheck(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24 or newer required');
    const {values, positionals} = parseArgs({options: {rpc: {type: 'string', default: 'https://api.mainnet-beta.solana.com'}}, allowPositionals: true});
    requireCheck(positionals.length === 1, 'Usage: node verify.mjs <record.json> [--rpc <https-url>]');
    const rpc = publicHttps(values.rpc).href;
    const connection = new Connection(rpc, {commitment: 'finalized', disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(publicHttps(url).href, {...init, redirect: 'error', signal: AbortSignal.timeout(20_000)})});
    const record = JSON.parse(await readFile(positionals[0], 'utf8'));
    const result = await verifyRecord(record, {connection});
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {console.error(`FAIL verifier: ${error.message}`); process.exitCode = 1;}
}
