#!/usr/bin/env node
// Direct program refusal: the agent signature is checked by Ed25519, then the
// operator requests a tab reservation. No Dexter HTTP checks run on this path.
import { randomBytes } from 'node:crypto';
import { writeFileSync, openSync, closeSync, fsyncSync, renameSync, lstatSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Connection, Ed25519Program, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import nacl from 'tweetnacl';
import { deriveSessionPda, fetchSessionAccount, fetchVaultSessionAccounts, sessionPdasOf } from '@dexterai/vault';
import { buildSettleVoucherInstruction } from '@dexterai/vault/instructions';
import { contextBoundVoucherV2Message, finalVoucherV2Sequence } from '@dexterai/vault/messages';
import { readVaultFull, readGraphConfigOnchain } from '@dexterai/vault/reader';
import { readKey as loadKey } from './case-two-key.mjs';
export { loadKey };

const PROGRAM = new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc');
const SWIG = new PublicKey('swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB');
// Anchor codes from dexter-vault/src/state.rs::VaultError. Expiry is checked
// before capacity in settle_voucher::reserve_one_outstanding.
export const REFUSAL_ERRORS = {
  'over-limit': { code: 6013, name: 'RevolvingCapacityExceeded' },
  expired: { code: 6009, name: 'SessionExpiryInPast' },
  'no-permission': { code: 3012, name: 'AccountNotInitialized' },
  'payout-redirect': { code: 6070, name: 'DebtTransferMismatch' },
};
function persist(file, value, fresh) {
  const target = fresh ? file : `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(target, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, json(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  if (!fresh) renameSync(target, file);
  const directory = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
export const customError = (err) => Array.isArray(err?.InstructionError) && typeof err.InstructionError[1]?.Custom === 'number'
  ? { instructionIndex: err.InstructionError[0], code: err.InstructionError[1].Custom, name: Object.values(REFUSAL_ERRORS).find((x) => x.code === err.InstructionError[1].Custom)?.name ?? null } : null;
export const refusalJson = (x, bytesEncoding) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString()
  : bytesEncoding && (v instanceof Uint8Array || (v?.type === 'Buffer' && Array.isArray(v.data)))
    ? Buffer.from(v instanceof Uint8Array ? v : v.data).toString(bytesEncoding) : v, 2);
const json = x => refusalJson(x);

export function assertFreshReceipt(receipt) {
  if (!receipt) throw new Error('a fresh receipt path is required');
  try { lstatSync(receipt); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('refuses a second attempt on the same receipt path; inspect the saved attempt');
}

export async function runRefusal({ connection, vault, seller, agent, authority, feePayer = authority, amount, kind, send = false, receipt,
  assertReady, recordVersion, bytesEncoding = 'base64' }) {
  assertFreshReceipt(receipt);
  if (assertReady) await assertReady();
  const expected = REFUSAL_ERRORS[kind];
  if (!['over-limit', 'expired'].includes(kind)) throw new Error('kind must be over-limit or expired');
  if (typeof amount !== 'bigint' || amount <= 0n) throw new Error('amount must be positive USDC atomic units');
  if (!agent) throw new Error('agent key is required');
  const state = await readVaultFull(connection, vault);
  if (!state.exists || state.dexterAuthority !== authority.publicKey.toBase58()) throw new Error('authority does not match this vault');
  const session = await fetchSessionAccount(connection, vault, seller);
  if (!session || session.version !== 1) throw new Error('no registered seller session');
  if (!Buffer.from(session.session.sessionPubkey).equals(agent.publicKey.toBuffer())) throw new Error('local agent key does not match approved session');
  const [sessionPda] = deriveSessionPda(vault, seller);
  const swigAddress = new PublicKey(state.swigAddress);
  const [wallet] = PublicKey.findProgramAddressSync([Buffer.from('swig-wallet-address'), swigAddress.toBuffer()], SWIG);
  const graph = await readGraphConfigOnchain(connection);
  const ata = getAssociatedTokenAddressSync(new PublicKey(graph.usdcMint), wallet, true);
  const siblings = sessionPdasOf(await fetchVaultSessionAccounts(connection, vault));
  const protectedKeys = [vault, sessionPda, ata, getAssociatedTokenAddressSync(new PublicKey(graph.usdcMint), seller, true)];
  const channelId = randomBytes(32);
  const sequenceNumber = finalVoucherV2Sequence((session.session.lastLockedSequence & 0x7fffffff) + 1);
  const cumulativeAmount = BigInt(session.session.spent) > BigInt(session.session.crystallizedCumulative)
    ? BigInt(session.session.spent) + amount : BigInt(session.session.crystallizedCumulative) + amount;
  const message = contextBoundVoucherV2Message({ programId: PROGRAM, vaultPda: vault, sessionPda, seller,
    sessionNonce: session.session.nonce, channelId, cumulativeAmount, sequenceNumber });
  const signature = nacl.sign.detached(message, agent.secretKey);
  const instructions = [
    Ed25519Program.createInstructionWithPublicKey({ publicKey: agent.publicKey.toBytes(), message, signature }),
    buildSettleVoucherInstruction({ vaultPda: vault, dexterAuthority: authority.publicKey, allowedCounterparty: seller,
      swigAddress, vaultUsdcAta: (await connection.getAccountInfo(ata)) ? ata : null,
      siblingSessionPdas: siblings, amount, increment: true }),
  ];
  const out = { kind, expected: recordVersion ? { ...expected, instructionIndex: 1 } : expected, vault: vault.toBase58(), sessionPda: sessionPda.toBase58(), seller: seller.toBase58(),
    agent: agent.publicKey.toBase58(), authority: authority.publicKey.toBase58(), attemptedAtomic: amount.toString(),
    before: bytesEncoding === 'base64url' ? JSON.parse(refusalJson(session.session, bytesEncoding)) : session.session,
    voucher: { channelId: channelId.toString(bytesEncoding === 'base64url' ? bytesEncoding : 'hex'), cumulativeAmount: cumulativeAmount.toString(),
      sequenceNumber, message: Buffer.from(message).toString(bytesEncoding === 'base64url' ? bytesEncoding : 'hex'), signature: Buffer.from(signature).toString(bytesEncoding) },
    ...(recordVersion ? { schema: recordVersion, v: recordVersion, bytesEncoding } : {}), sent: false };
  return executeRefusal({ connection, instructions, signers: [authority, feePayer], feePayer,
    expected: { ...expected, instructionIndex: 1 }, protectedKeys,
    protectedLabels: ['vault', 'session', 'buyerTokenAccount', 'sellerTokenAccount'], record: out,
    send, receipt, assertReady, bytesEncoding });
}

// Both case tools use one persist-before-send and unchanged-account lifecycle.
export async function executeRefusal({ connection, instructions, signers, feePayer, expected,
  protectedKeys, protectedLabels, record: out, receipt, send = false, assertReady,
  requireLog, bytesEncoding = 'base64' }) {
  assertFreshReceipt(receipt);
  persist(receipt, out, true);
  const save = () => persist(receipt, out, false);
  const snapshot = async () => (await connection.getMultipleAccountsInfo(protectedKeys))
    .map(a => a ? { owner: a.owner.toBase58(), lamports: a.lamports, executable: a.executable, data: a.data.toString(bytesEncoding) } : null);
  const matches = result => result.decoded?.code === expected.code
    && result.decoded?.instructionIndex === expected.instructionIndex
    && (!requireLog || result.logs?.some(line => line.includes(requireLog)));
  try {
    const protectedBefore = await snapshot();
    out.protectedBefore = protectedBefore;
    const block = await connection.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: feePayer.publicKey,
      recentBlockhash: block.blockhash, instructions }).compileToV0Message());
    tx.sign([...new Map(signers.map(s => [s.publicKey.toBase58(), s])).values()]);
    const simulation = (await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' })).value;
    out.simulation = { err: simulation.err, logs: simulation.logs, decoded: customError(simulation.err) };
    if (!matches(out.simulation)) throw new Error(`simulation refused for the wrong reason: ${json(out.simulation)}`);
    if (send) {
      if (assertReady) await assertReady();
      if (json(await snapshot()) !== json(protectedBefore)) throw new Error('protected account changed after simulation; no transaction sent');
      // Persist the exact signed transaction before transport. A retry should inspect
      // this signature rather than create a second attempt after an uncertain send.
      out.transactionSignature = (await import('bs58')).default.encode(tx.signatures[0]);
      out.signedTransactionBase64 = Buffer.from(tx.serialize()).toString(bytesEncoding);
      out.block = block;
      save();
      const returnedSignature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
      if (returnedSignature !== out.transactionSignature) throw new Error('RPC returned a different transaction signature');
      await connection.confirmTransaction({ signature: returnedSignature, ...block }, 'confirmed');
      const landed = await connection.getTransaction(returnedSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!landed) throw new Error(`transaction not yet readable; inspect ${returnedSignature}`);
      out.landed = { slot: landed.slot, err: landed.meta.err, feeLamports: landed.meta.fee, logs: landed.meta.logMessages,
        decoded: customError(landed.meta.err) };
      if (!matches(out.landed)) throw new Error(`landed error did not match: ${json(out.landed)}`);
      const protectedAfter = await snapshot();
      out.protectedAfter = protectedAfter;
      if (json(protectedAfter) !== json(protectedBefore)) throw new Error('failed attempt changed vault, session or token account data');
      if (out.landed.feeLamports <= 0) throw new Error('failed transaction did not report its fee');
      out.stateUnchanged = Object.fromEntries(protectedLabels.map(label => [label, true]));
      if (out.kind === 'payout-redirect') out.claimAfter = protectedAfter[0].data;
      out.sent = true;
    } else {
      const protectedAfter = await snapshot();
      out.protectedAfter = protectedAfter;
      if (json(protectedAfter) !== json(protectedBefore)) throw new Error('protected accounts changed during simulation; inspect external activity');
      out.simulation.stateUnchanged = Object.fromEntries(protectedLabels.map(label => [label, true]));
    }
    return out;
  } catch (error) { out.error = error.message; throw error; }
  finally { save(); }
}

async function main() {
  const { values: v } = parseArgs({ options: Object.fromEntries(['rpc','vault','seller','agent-key','authority-key','fee-payer-key','amount','kind','receipt'].map((k) => [k,{ type: 'string' }]).concat([['send',{ type: 'boolean', default: false }], ['live',{ type: 'boolean', default: false }]])) });
  for (const k of ['rpc','vault','seller','agent-key','authority-key','amount','kind','receipt']) if (!v[k]) throw new Error(`--${k} is required`);
  if (v.send && !['127.0.0.1','localhost','[::1]'].includes(new URL(v.rpc).hostname) && !v.live) throw new Error('remote send requires --live as well as --send');
  const result = await runRefusal({ connection: new Connection(v.rpc, 'confirmed'), vault: new PublicKey(v.vault), seller: new PublicKey(v.seller),
    agent: loadKey(v['agent-key']), authority: loadKey(v['authority-key']), feePayer: loadKey(v['fee-payer-key'] ?? v['authority-key']),
    amount: BigInt(v.amount), kind: v.kind, send: v.send, receipt: v.receipt });
  console.log(json(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
