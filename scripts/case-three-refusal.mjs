#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Connection, Ed25519Program, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { deriveSessionPda, fetchSessionAccount, fetchVaultSessionAccounts, sessionPdasOf } from '@dexterai/vault';
import { buildSettleVoucherInstruction } from '@dexterai/vault/instructions';
import { buildInstantPayoutInstructions } from '@dexterai/vault/factoring';
import { DISCRIMINATORS, USDC_MAINNET } from '@dexterai/vault/constants';
import { contextBoundVoucherV2Message, finalVoucherV2Sequence } from '@dexterai/vault/messages';
import { readVaultFull, readGraphConfigOnchain, decodeLockedClaim, fetchVaultLockedClaims } from '@dexterai/vault/reader';
import { assertFreshReceipt, executeRefusal, loadKey, refusalJson, runRefusal } from './case-two-refusal.mjs';

const PROGRAM = new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');
const SWIG = new PublicKey('swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB');
const ENV = '/home/branchmanager/.config/dexter-facilitator/facilitator.env';
const AUTHORITY = '/home/branchmanager/.config/solana/dexter-vault/api-session-master.json';
const bytes = value => Buffer.from(value).toString('base64url');
const json = value => refusalJson(value, 'base64url');

export async function assertNoOtherPendingClaims(connection, vault, targetClaim = null) {
  const pending = await fetchVaultLockedClaims(connection, vault, { status: 'Pending' });
  const other = pending.find(claim => claim.address !== targetClaim?.toBase58());
  if (other) throw new Error(`another claim is Pending: ${other.address}; finish its payout before a refusal`);
}

export function loadHolder(envFile = ENV) {
  const line = readFileSync(envFile, 'utf8').split(/\r?\n/).find(line => /^DEXTER_HOLDER_SECRET_KEY=/.test(line));
  if (!line) throw new Error('facilitator holder seed is missing');
  let seed;
  try {
    seed = bs58.decode(line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2'));
    if (seed.length !== 32) throw new Error('length');
    return Keypair.fromSeed(seed);
  } catch { throw new Error('facilitator holder must be a base58 32-byte seed'); }
  finally { seed?.fill(0); }
}

export async function readPendingClaim(connection, vault, address, seller, holder) {
  const account = await connection.getAccountInfo(address, 'confirmed');
  if (!account || !account.owner.equals(PROGRAM)) throw new Error('target claim is missing or has another owner');
  const claim = decodeLockedClaim(address.toBase58(), account.data);
  if (claim.status !== 'Pending') throw new Error('target claim is no longer Pending; stop and inspect the purchase');
  if (claim.vault !== vault.toBase58() || claim.allowedCounterparty !== seller.toBase58()
    || claim.currentHolder !== holder.publicKey.toBase58()) throw new Error('claim vault, seller or holder differs from this attempt');
  return { claim, data: bytes(account.data) };
}

export async function runCaseThreeRefusal(options) {
  const { connection, vault, seller, kind, receipt, authority, feePayer = authority, agent, amount, send = false } = options;
  assertFreshReceipt(receipt);
  const target = kind === 'payout-redirect' ? options.claim : null;
  const guard = () => assertNoOtherPendingClaims(connection, vault, target);
  if (kind === 'over-limit' || kind === 'expired') return runRefusal({ ...options, assertReady: guard,
    recordVersion: 'case-three/refusal/v1', bytesEncoding: 'base64url' });
  await guard();
  if (!['no-permission', 'payout-redirect'].includes(kind)) throw new Error('unknown refusal kind');
  const state = await readVaultFull(connection, vault);
  if (!state.exists || state.dexterAuthority !== authority.publicKey.toBase58()) throw new Error('authority does not match this vault');
  const swigAddress = new PublicKey(state.swigAddress);
  const [wallet] = PublicKey.findProgramAddressSync([Buffer.from('swig-wallet-address'), swigAddress.toBuffer()], SWIG);
  const graph = await readGraphConfigOnchain(connection);
  const mint = new PublicKey(graph.usdcMint);
  if (mint.toBase58() !== USDC_MAINNET) throw new Error('graph settlement mint is not USDC mainnet');
  const buyerAta = getAssociatedTokenAddressSync(mint, wallet, true);
  const sellerAta = getAssociatedTokenAddressSync(mint, seller, true);
  const [sessionPda] = deriveSessionPda(vault, seller);
  const record = { schema: 'case-three/refusal/v1', v: 'case-three/refusal/v1', bytesEncoding: 'base64url', kind,
    vault: vault.toBase58(), seller: seller.toBase58(), sessionPda: sessionPda.toBase58(),
    authority: authority.publicKey.toBase58(), sent: false };
  let instructions, expected, protectedKeys, protectedLabels, requireLog, assertReady = guard;
  const signers = [authority, feePayer];
  if (kind === 'no-permission') {
    if (!options.approvedSeller || !agent || !amount || amount <= 0n) throw new Error('no-permission requires approved seller, agent and positive amount');
    const [approvedPda] = deriveSessionPda(vault, options.approvedSeller);
    const approved = await fetchSessionAccount(connection, vault, options.approvedSeller);
    if (!approved || approved.version !== 1) throw new Error('approved seller session is missing');
    if (await connection.getAccountInfo(sessionPda)) throw new Error('impostor session already exists');
    if (!Buffer.from(approved.session.sessionPubkey).equals(agent.publicKey.toBuffer())) throw new Error('agent does not match the approved session');
    const channelId = randomBytes(32);
    const sequenceNumber = finalVoucherV2Sequence((approved.session.lastLockedSequence & 0x7fffffff) + 1);
    const cumulativeAmount = (BigInt(approved.session.spent) > BigInt(approved.session.crystallizedCumulative)
      ? BigInt(approved.session.spent) : BigInt(approved.session.crystallizedCumulative)) + amount;
    const message = contextBoundVoucherV2Message({ programId: PROGRAM, vaultPda: vault, sessionPda, seller,
      sessionNonce: approved.session.nonce, channelId, cumulativeAmount, sequenceNumber });
    const signature = nacl.sign.detached(message, agent.secretKey);
    instructions = [Ed25519Program.createInstructionWithPublicKey({ publicKey: agent.publicKey.toBytes(), message, signature }),
      buildSettleVoucherInstruction({ vaultPda: vault, dexterAuthority: authority.publicKey, allowedCounterparty: seller,
        swigAddress, vaultUsdcAta: await connection.getAccountInfo(buyerAta) ? buyerAta : null,
        siblingSessionPdas: sessionPdasOf(await fetchVaultSessionAccounts(connection, vault)), amount, increment: true })];
    expected = { instructionIndex: 1, code: 3012, name: 'AccountNotInitialized' };
    requireLog = 'AnchorError caused by account: session';
    Object.assign(record, { expected, agent: agent.publicKey.toBase58(), attemptedAtomic: amount.toString(),
      impostor: seller.toBase58(), approvedSeller: options.approvedSeller.toBase58(), impostorSessionPda: sessionPda.toBase58(),
      before: JSON.parse(json(approved.session)), voucher: { channelId: bytes(channelId), cumulativeAmount: cumulativeAmount.toString(),
        sequenceNumber, message: bytes(message), signature: bytes(signature) } });
    protectedKeys = [vault, approvedPda, sessionPda, buyerAta, sellerAta,
      getAssociatedTokenAddressSync(mint, options.approvedSeller, true)];
    protectedLabels = ['vault', 'approvedSession', 'impostorSessionAbsent', 'buyerTokenAccount', 'impostorTokenAccount', 'sellerTokenAccount'];
  } else {
    if (!target || !options.redirectTo || !options.holder) throw new Error('payout-redirect requires claim, redirect-to and holder');
    if (options.redirectTo.equals(seller)) throw new Error('redirect-to must differ from the approved seller');
    const holder = options.holder;
    const before = await readPendingClaim(connection, vault, target, seller, holder);
    const redirectAta = getAssociatedTokenAddressSync(mint, options.redirectTo, true);
    instructions = await buildInstantPayoutInstructions({ connection, swigAddress, claimPda: target, vaultPda: vault,
      financier: holder.publicKey, dexterAuthority: authority.publicKey, claimAmount: BigInt(before.claim.amount),
      financierSpread: 0n, sellerAta: redirectAta, financierAta: redirectAta, feePayer: feePayer.publicKey });
    // The SDK builder supplies account order and discriminator; locate its actual instruction.
    const instructionIndex = instructions.findIndex(ix => ix.programId.equals(PROGRAM)
      && Buffer.from(ix.data).equals(Buffer.from(DISCRIMINATORS.settle_locked_voucher)));
    if (instructionIndex < 0) throw new Error('payout builder did not emit settle_locked_voucher');
    expected = { instructionIndex, code: 6070, name: 'DebtTransferMismatch' };
    signers.push(holder);
    Object.assign(record, { expected, agent: before.claim.sessionPubkeyAtLock, attemptedAtomic: before.claim.amount,
      claim: target.toBase58(), redirectTo: options.redirectTo.toBase58(), redirectAta: redirectAta.toBase58(),
      instructionIndex, holder: holder.publicKey.toBase58(),
      before: { ...before.claim, voucherHash: Buffer.from(bs58.decode(before.claim.voucherHash)).toString('hex') }, claimBefore: before.data });
    protectedKeys = [target, vault, buyerAta, sellerAta, redirectAta];
    protectedLabels = ['claim', 'vault', 'buyerTokenAccount', 'sellerTokenAccount', 'impostorTokenAccount'];
    assertReady = async () => {
      await guard();
      const current = await readPendingClaim(connection, vault, target, seller, holder);
      if (current.data !== before.data) throw new Error('target Pending claim changed before send');
    };
  }
  const result = await executeRefusal({ connection, instructions, signers, feePayer, expected, protectedKeys,
    protectedLabels, record, receipt, send, assertReady, requireLog, bytesEncoding: 'base64url' });
  return result;
}

async function main() {
  const { values: v } = parseArgs({ options: Object.fromEntries([
    'rpc', 'vault', 'seller', 'approved-seller', 'agent-key', 'authority-key', 'fee-payer-key', 'amount', 'kind',
    'receipt', 'claim', 'redirect-to', 'holder-key', 'env',
  ].map(k => [k, { type: 'string' }]).concat(['send', 'live', 'simulate-only'].map(k => [k, { type: 'boolean', default: false }]))) });
  for (const k of ['rpc', 'vault', 'seller', 'kind', 'receipt']) if (!v[k]) throw new Error(`--${k} is required`);
  if (v.kind !== 'payout-redirect') for (const k of ['agent-key', 'amount']) if (!v[k]) throw new Error(`--${k} is required`);
  if (v.send && v['simulate-only']) throw new Error('--send and --simulate-only conflict');
  if (v.send && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(v.rpc).hostname) && !v.live) throw new Error('remote send requires --live as well as --send');
  const authority = loadKey(v['authority-key'] ?? AUTHORITY);
  let agent, holder, feePayer;
  try {
    agent = v['agent-key'] ? loadKey(v['agent-key']) : undefined;
    feePayer = v['fee-payer-key'] ? loadKey(v['fee-payer-key']) : authority;
    if (v.kind === 'payout-redirect') holder = v['holder-key'] ? loadKey(v['holder-key']) : loadHolder(v.env);
    const result = await runCaseThreeRefusal({ connection: new Connection(v.rpc, 'confirmed'), vault: new PublicKey(v.vault),
      seller: new PublicKey(v.seller), approvedSeller: v['approved-seller'] ? new PublicKey(v['approved-seller']) : undefined,
      claim: v.claim ? new PublicKey(v.claim) : undefined, redirectTo: v['redirect-to'] ? new PublicKey(v['redirect-to']) : undefined,
      agent, authority, holder, feePayer,
      amount: v.amount ? BigInt(v.amount) : undefined, kind: v.kind, send: v.send, receipt: v.receipt });
    console.log(json(result));
  } finally { authority.secretKey.fill(0); agent?.secretKey.fill(0); holder?.secretKey.fill(0); feePayer?.secretKey.fill(0); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
