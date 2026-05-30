/**
 * Phase 2 mainnet smoke: open a session against the live dexter-vault
 * program, verify active_session is recorded, then revoke it.
 *
 * Flow:
 *   1. Generate a fresh P-256 keypair (acts as the "passkey" for this test)
 *   2. Generate a fresh test identity_claim
 *   3. Enroll a new test vault on mainnet bound to that keypair
 *   4. (Skip set_swig — open-tab doesn't need it; the on-chain handler
 *       has no swig dependency for register_session_key)
 *   5. Call openTab() against the SDK — this is the actual code path we're testing
 *   6. Read the vault account, confirm active_session is present
 *   7. Call tab.close() — should revoke the session
 *   8. Read the vault account again, confirm active_session is gone
 *
 * Cost: roughly 0.003 SOL of rent + fees for the test vault. The vault
 * account is small (~285 bytes) but rent-exempt rent is real.
 *
 * Requires:
 *   - HELIUS_API_KEY env var (or RPC override)
 *   - FEE_PAYER_KEYPAIR env var: path to a Solana keypair JSON file with
 *     ~0.01 SOL on it to cover rent + fees
 *
 * Run:
 *   FEE_PAYER_KEYPAIR=~/.config/solana/dexter-vault/upgrade-authority.json \
 *     npx tsx examples/smoke-open-tab.ts
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import {
  createSolanaVaultAdapter,
  passkeySignerFromP256Keypair,
} from '../src/tab/adapters/solana/index';
import {
  generateP256Keypair,
} from '../src/tab/adapters/solana/passkey-noble';
import {
  DEXTER_VAULT_PROGRAM_ID,
} from '../src/tab/instructions';
import { openTab } from '../src/tab/index';

// ── Env + config ───────────────────────────────────────────────────────

const HELIUS_API_KEY = process.env.HELIUS_API_KEY ?? '8fd1a2cd-76e7-4462-b38b-1026960edd40';
const RPC_URL = process.env.RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const FEE_PAYER_PATH = (process.env.FEE_PAYER_KEYPAIR ?? `${homedir()}/.config/solana/dexter-vault/upgrade-authority.json`).replace(/^~/, homedir());

// ── Helpers: raw web3.js initialize_vault builder ──────────────────────
//
// The SDK's Phase 2 scope is open/revoke. Enrolling a vault is dexter-api's
// job, but for a self-contained smoke we need to mint a test vault inline.
// This is a one-shot helper, not part of the SDK surface.

const INIT_VAULT_DISC = new Uint8Array([48, 191, 163, 44, 71, 129, 63, 164]);

function buildInitializeVaultIx(args: {
  vault: PublicKey;
  payer: PublicKey;
  dexterAuthority: PublicKey;
  passkeyPubkey: Uint8Array;       // 33 bytes
  coolingOffSeconds: number;        // u32
  identityClaim: Uint8Array;        // 32 bytes
}): TransactionInstruction {
  if (args.passkeyPubkey.length !== 33) throw new Error('passkeyPubkey must be 33');
  if (args.identityClaim.length !== 32) throw new Error('identityClaim must be 32');

  const data = new Uint8Array(8 + 33 + 4 + 32);
  const view = new DataView(data.buffer);
  let o = 0;
  data.set(INIT_VAULT_DISC, o); o += 8;
  data.set(args.passkeyPubkey, o); o += 33;
  view.setUint32(o, args.coolingOffSeconds >>> 0, true); o += 4;
  data.set(args.identityClaim, o); o += 32;

  return new TransactionInstruction({
    keys: [
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.dexterAuthority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: DEXTER_VAULT_PROGRAM_ID,
    data: Buffer.from(data),
  });
}

/**
 * Read the active_session Option tag from a v2 Vault account.
 *
 * Layout up to active_session (offsets include the 8-byte Anchor disc):
 *   8           version (1)
 *   9           bump (1)
 *   10..43      passkey_pubkey (33)
 *   43..75      swig_address (32)
 *   75..79      cooling_off_seconds (u32)
 *   79..83      pending_voucher_count (u32)
 *   83          pending_withdrawal Option tag (1)
 *   84..        if tag==1: amount(8) + dest(32) + requested_at(8) = 48
 *   then:       identity_claim (32)
 *   then:       dexter_authority (32)
 *   then:       active_session Option tag (1)
 *
 * Borsh's None is the bare tag byte (no payload). So when pending_withdrawal
 * is None, the layout is compact; when Some, everything downstream shifts
 * by 48 bytes. Account allocation is fixed-max via InitSpace; the data
 * actually written follows Borsh's variable-size rules.
 */
function readActiveSessionTag(data: Buffer): number {
  const pendingTag = data[83];
  const pendingSize = pendingTag === 1 ? 48 : 0;
  const identityStart = 84 + pendingSize;
  const dexterAuthStart = identityStart + 32;
  const activeSessionTagOffset = dexterAuthStart + 32;
  return data[activeSessionTagOffset];
}

/** Same as the dexter-vault test helper. Mainnet read replicas can lag
 *  even finalized writes by 1-2s; poll until the account materializes. */
async function pollAccountExists(
  conn: Connection,
  pubkey: PublicKey,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await conn.getAccountInfo(pubkey, 'finalized');
    if (info) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`pollAccountExists: ${pubkey.toBase58()} did not appear in ${timeoutMs}ms`);
}

/** Poll the vault until active_session.tag == expected. */
async function pollUntilTag(
  conn: Connection,
  pubkey: PublicKey,
  expected: number,
  timeoutMs = 15_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await conn.getAccountInfo(pubkey, 'finalized');
    if (info) {
      const tag = readActiveSessionTag(info.data);
      if (tag === expected) return tag;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`pollUntilTag: tag did not become ${expected} within ${timeoutMs}ms`);
}

function deriveVaultPda(identityClaim: Uint8Array): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), Buffer.from(identityClaim.slice(0, 16))],
    DEXTER_VAULT_PROGRAM_ID,
  );
  return { pda, bump };
}

// ── Smoke ──────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Phase 2 mainnet smoke: openTab + revoke ===\n');

  // Load fee payer.
  const feePayerSecret = JSON.parse(readFileSync(FEE_PAYER_PATH, 'utf8'));
  const feePayer = Keypair.fromSecretKey(Uint8Array.from(feePayerSecret));
  console.log(`[1] Fee payer: ${feePayer.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, 'confirmed');
  const balance = await connection.getBalance(feePayer.publicKey, 'confirmed');
  console.log(`    Balance: ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 5_000_000) {
    throw new Error('fee payer needs at least 0.005 SOL');
  }

  // Mint test passkey + identity_claim, derive vault PDA.
  const passkey = generateP256Keypair();
  const identityClaim = new Uint8Array(32);
  crypto.getRandomValues(identityClaim);
  const { pda: vaultPda } = deriveVaultPda(identityClaim);
  console.log(`\n[2] Generated test vault:`);
  console.log(`    Passkey pubkey:  ${Buffer.from(passkey.publicKey).toString('hex').slice(0, 16)}…`);
  console.log(`    Vault PDA:       ${vaultPda.toBase58()}`);

  // Enroll the test vault on mainnet.
  console.log(`\n[3] Enrolling vault on mainnet...`);
  const dexterAuthority = Keypair.generate(); // unused for Phase 2; just needs to sign init
  const initIx = buildInitializeVaultIx({
    vault: vaultPda,
    payer: feePayer.publicKey,
    dexterAuthority: dexterAuthority.publicKey,
    passkeyPubkey: passkey.publicKey,
    coolingOffSeconds: 0,
    identityClaim,
  });
  const initTx = new Transaction().add(initIx);
  initTx.feePayer = feePayer.publicKey;
  const initBlockhash = await connection.getLatestBlockhash('confirmed');
  initTx.recentBlockhash = initBlockhash.blockhash;
  initTx.sign(feePayer, dexterAuthority);
  const initSig = await connection.sendRawTransaction(initTx.serialize());
  await connection.confirmTransaction(
    { signature: initSig, ...initBlockhash },
    'confirmed',
  );
  console.log(`    Init tx: https://solscan.io/tx/${initSig}`);
  await pollAccountExists(connection, vaultPda);
  console.log(`    Vault visible on chain ✓`);

  // Build the SDK adapter against the freshly-enrolled vault.
  const adapter = createSolanaVaultAdapter({
    connection,
    swigAddress: SystemProgram.programId.toBase58(), // unused for Phase 2 open/revoke
    vaultPda,
    passkeySigner: passkeySignerFromP256Keypair(passkey),
    feePayer,
  });

  // openTab — the real SDK code path under test.
  console.log(`\n[4] openTab() — passkey signs the 180-byte registration...`);
  const sellerKey = Keypair.generate().publicKey;
  const tab = await openTab({
    vault: adapter,
    network: 'solana:mainnet',
    seller: sellerKey.toBase58(),
    perUnitCap: '0.001',
    totalCap: '0.10',
    sessionDuration: 600,
  });
  console.log(`    channelId:  ${tab.channelId.slice(0, 16)}…`);
  console.log(`    isOpen:     ${tab.state.isOpen}`);
  console.log(`    totalCap:   ${tab.state.spent} / ${tab.state.remaining} remaining`);
  console.log(`    expires in: ${tab.state.expiresInSec}s`);

  // Read the vault account, verify active_session is set.
  console.log(`\n[5] Reading vault account to confirm active_session...`);
  const activeTag = await pollUntilTag(connection, vaultPda, 1);
  console.log(`    active_session tag: ${activeTag} ✓ session present`);

  // Sign a voucher with the session key — no passkey prompt, no on-chain call.
  console.log(`\n[6] Signing a voucher with the session key (no chain, no prompt)...`);
  const voucher = await (tab as any).signNextVoucher('500'); // 0.0005 USDC atomic
  console.log(`    sequenceNumber: ${voucher.payload.sequenceNumber}`);
  console.log(`    cumulative:     ${voucher.payload.cumulativeAmount} atomic`);
  console.log(`    sig length:     ${voucher.sessionSignature.length} bytes (ed25519 ✓)`);
  console.log(`    state.spent:    ${tab.state.spent}`);

  // close() — revokes the session on chain.
  console.log(`\n[7] tab.close() — passkey signs the 128-byte revocation...`);
  const closeResult = await tab.close();
  console.log(`    settledAmount: ${closeResult.settledAmount}`);

  // Re-read vault account, verify active_session is cleared.
  console.log(`\n[8] Reading vault account again to confirm session revoked...`);
  const activeTag2 = await pollUntilTag(connection, vaultPda, 0);
  console.log(`    active_session tag: ${activeTag2} ✓ cleared`);

  console.log(`\n=== SMOKE PASSED ===`);
  console.log(`Vault: https://solscan.io/account/${vaultPda.toBase58()}`);
}

main().catch((e) => {
  console.error('\n=== SMOKE FAILED ===');
  console.error(e);
  process.exit(1);
});
