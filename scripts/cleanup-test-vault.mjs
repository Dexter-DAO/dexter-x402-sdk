/**
 * Clean the OTS-e2e TEST vault after the proof-of-loop iterations:
 *   1. Revoke the stranded live session (clears it + decrements live_session_count).
 *   2. settle_voucher(decrement) to clear the stranded pending_voucher_count
 *      (an unmatched tab-open arm from a run that died before close).
 * Leaves the vault pristine: count 0, sessions 0.
 *
 * Run: node scripts/cleanup-test-vault.mjs
 */
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';

import { buildRevokeSessionKeyInstruction, buildSettleVoucherInstruction } from '@dexterai/vault/instructions';
import { buildSecp256r1VerifyInstruction } from '@dexterai/vault/precompile';
import { sessionRevokeMessage } from '@dexterai/vault/messages';
import { fetchSessionAccount, fetchVaultSessionAccounts } from '@dexterai/vault/session';
import { readVaultOnchain } from '@dexterai/vault/reader';
import { passkeySignerFromP256Keypair } from '@dexterai/x402/tab/adapters/solana';

const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=8fd1a2cd-76e7-4462-b38b-1026960edd40';
const VAULT = new PublicKey('EbMJhiKN2MuUXLZ2mMqGKwtV11FDWEmZGyvhrFScY54y');
const CRED = '/home/branchmanager/websites/dexter-facilitator/scripts/ots-e2e/test-credentials/2026-06-05T23-11-28-918Z-e2e-test-1780701079880-c743910c.json';
const FEE_PAYER_FILE = '/home/branchmanager/.config/solana/dexter-vault/upgrade-authority.json';
const FAC_ENV = '/home/branchmanager/websites/dexter-facilitator/.env';

const log = (...a) => console.log('[cleanup]', ...a);
const conn = new Connection(HELIUS, 'confirmed');

// ── keys ────────────────────────────────────────────────────────────────
const cred = JSON.parse(readFileSync(CRED, 'utf8'));
const passkey = passkeySignerFromP256Keypair({
  publicKey: Uint8Array.from(Buffer.from(cred.passkeyPublicKeyBase64, 'base64')),
  privateKey: Uint8Array.from(Buffer.from(cred.passkeyPrivateKeyBase64, 'base64')),
});
const feePayer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(FEE_PAYER_FILE, 'utf8'))));

// session master (3SWJ) from the facilitator env — bs58 32-byte seed.
const envLine = readFileSync(FAC_ENV, 'utf8').split('\n').find((l) => l.startsWith('DEXTER_SESSION_MASTER_KEY='));
if (!envLine) throw new Error('DEXTER_SESSION_MASTER_KEY not found in facilitator .env');
const seed = bs58.decode(envLine.split('=')[1].trim().replace(/^["']|["']$/g, ''));
const master = Keypair.fromSeed(Buffer.from(seed).subarray(0, 32));
log('fee payer   :', feePayer.publicKey.toBase58());
log('session mstr:', master.publicKey.toBase58());

async function send(ixs, signers, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  log(`${label}: ${sig}`);
  return sig;
}

async function main() {
  const before = await readVaultOnchain(conn, VAULT);
  const sessions = await fetchVaultSessionAccounts(conn, VAULT);
  log('BEFORE — pendingVoucherCount:', before.pendingVoucherCount, '| live sessions:', sessions.length);

  // 1. Revoke each live session.
  for (const s of sessions) {
    const counterparty = new PublicKey(s.session.allowedCounterparty);
    const msg = sessionRevokeMessage({
      programId: new PublicKey('Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc'),
      vaultPda: VAULT,
      sessionPubkey: s.session.sessionPubkey,
    });
    const signed = await passkey.signOperation(msg);
    const precompileIx = buildSecp256r1VerifyInstruction(passkey.publicKey, signed.signature, signed.precompileMessage);
    const revokeIx = buildRevokeSessionKeyInstruction({
      vaultPda: VAULT,
      allowedCounterparty: counterparty,
      clientDataJSON: signed.clientDataJSON,
      authenticatorData: signed.authenticatorData,
    });
    await send([precompileIx, revokeIx], [feePayer], `revoke session ${counterparty.toBase58().slice(0, 8)}…`);
  }

  // 2. Drain the stranded pending_voucher_count to 0 (one decrement per unit).
  // Read at 'finalized' between decrements to avoid the read-replica race that
  // would re-issue a decrement against an already-0 count (NoPendingWithdrawal).
  const finalConn = new Connection(HELIUS, 'finalized');
  const readCount = async () => (await readVaultOnchain(finalConn, VAULT)).pendingVoucherCount ?? 0;
  let count = await readCount();
  while (count > 0) {
    const decIx = buildSettleVoucherInstruction({
      vaultPda: VAULT,
      dexterAuthority: master.publicKey,
      allowedCounterparty: VAULT, // ignored on the decrement path (no session read)
      amount: 0n,
      increment: false,
    });
    try {
      await send([decIx], [feePayer, master], `decrement pending_voucher_count (${count} -> ${count - 1})`);
    } catch (e) {
      if (String(e).includes('NoPendingWithdrawal') || String(e).includes('0x1772')) break; // already 0
      throw e;
    }
    count = await readCount();
  }

  const after = await readVaultOnchain(conn, VAULT);
  const sAfter = await fetchVaultSessionAccounts(conn, VAULT);
  log('AFTER  — pendingVoucherCount:', after.pendingVoucherCount, '| live sessions:', sAfter.length);
  console.log('\n===== CLEANUP RESULT =====');
  console.log(JSON.stringify({ pendingVoucherCount: after.pendingVoucherCount, liveSessions: sAfter.length, clean: after.pendingVoucherCount === 0 && sAfter.length === 0 }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('[cleanup] FAILED:', e?.stack || e); process.exit(1); });
