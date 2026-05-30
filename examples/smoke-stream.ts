/**
 * Phase 3 mainnet smoke: end-to-end paid streaming.
 *
 * Spins up an in-process Express server with tabMiddleware, then opens a
 * tab from a buyer client and streams paid tokens against the seller.
 *
 * Flow:
 *   1. Enroll a fresh test vault on mainnet (same as Phase 2 smoke).
 *   2. Start an Express server with tabMiddleware that verifies vouchers
 *      against the live program.
 *   3. Buyer opens a tab against the server (one passkey ceremony, one
 *      on-chain register_session_key).
 *   4. Buyer calls tab.stream() — sends a signed voucher in the header,
 *      seller verifies it locally, drives an SSE meter that streams 10
 *      tokens back at the configured per-token rate.
 *   5. Buyer reads all chunks, prints them.
 *   6. Buyer closes the tab — one passkey, one on-chain revoke.
 *
 * What this proves: the entire request path — buyer signs voucher, sends
 * over HTTP, seller verifies locally with no chain call after the
 * one-time on-chain registration check, streams chunks back. The seller
 * never touches the buyer's keys; the seller never moves funds.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { AddressInfo } from 'node:net';
import express from 'express';
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
import {
  tabMiddleware,
  requireTab,
  openSse,
} from '../src/tab/seller/index';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY ?? '8fd1a2cd-76e7-4462-b38b-1026960edd40';
const RPC_URL = process.env.RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const FEE_PAYER_PATH = (process.env.FEE_PAYER_KEYPAIR ?? `${homedir()}/.config/solana/dexter-vault/upgrade-authority.json`).replace(/^~/, homedir());

const INIT_VAULT_DISC = new Uint8Array([48, 191, 163, 44, 71, 129, 63, 164]);

function buildInitializeVaultIx(args: {
  vault: PublicKey;
  payer: PublicKey;
  dexterAuthority: PublicKey;
  passkeyPubkey: Uint8Array;
  coolingOffSeconds: number;
  identityClaim: Uint8Array;
}): TransactionInstruction {
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

function deriveVaultPda(identityClaim: Uint8Array): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), Buffer.from(identityClaim.slice(0, 16))],
    DEXTER_VAULT_PROGRAM_ID,
  );
  return pda;
}

async function pollAccountExists(conn: Connection, pubkey: PublicKey, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await conn.getAccountInfo(pubkey, 'finalized');
    if (info) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`pollAccountExists: ${pubkey.toBase58()} did not appear in ${timeoutMs}ms`);
}

async function main() {
  console.log('=== Phase 3 mainnet smoke: paid streaming ===\n');

  // --- Setup -----------------------------------------------------------

  const feePayerSecret = JSON.parse(readFileSync(FEE_PAYER_PATH, 'utf8'));
  const feePayer = Keypair.fromSecretKey(Uint8Array.from(feePayerSecret));
  const connection = new Connection(RPC_URL, 'confirmed');
  const balance = await connection.getBalance(feePayer.publicKey, 'confirmed');
  console.log(`[1] Fee payer: ${feePayer.publicKey.toBase58()} (${(balance / 1e9).toFixed(4)} SOL)`);
  if (balance < 5_000_000) throw new Error('fee payer needs at least 0.005 SOL');

  // --- Seller setup ----------------------------------------------------

  const sellerKeypair = Keypair.generate();
  console.log(`[2] Seller pubkey: ${sellerKeypair.publicKey.toBase58()}`);

  const app = express();
  app.post('/inference',
    tabMiddleware({
      connection,
      sellerPubkey: sellerKeypair.publicKey,
      perUnit: '0.00003',
      network: 'solana:mainnet',
      settle: 'on-close',
    }),
    async (req, res) => {
      const tab = requireTab(req);
      const meter = openSse(res, { tab, perUnit: '0.00003' });
      const tokens = ['The ', 'quick ', 'brown ', 'fox ', 'jumped ', 'over ', 'the ', 'lazy ', 'dog.', '\n'];
      try {
        for (const token of tokens) {
          await meter.charge(1);
          meter.send(token);
        }
        meter.end();
      } catch (err: any) {
        console.error('  [seller] charge error:', err.message);
        try { meter.end(); } catch {}
      }
    },
  );

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const sellerUrl = `http://127.0.0.1:${port}`;
  console.log(`    Seller listening on ${sellerUrl}`);

  try {
    // --- Enroll vault on mainnet ---------------------------------------

    const passkey = generateP256Keypair();
    const identityClaim = new Uint8Array(32);
    crypto.getRandomValues(identityClaim);
    const vaultPda = deriveVaultPda(identityClaim);
    console.log(`\n[3] Test vault: ${vaultPda.toBase58()}`);

    const dexterAuthority = Keypair.generate();
    const initTx = new Transaction().add(
      buildInitializeVaultIx({
        vault: vaultPda,
        payer: feePayer.publicKey,
        dexterAuthority: dexterAuthority.publicKey,
        passkeyPubkey: passkey.publicKey,
        coolingOffSeconds: 0,
        identityClaim,
      }),
    );
    initTx.feePayer = feePayer.publicKey;
    const initBlockhash = await connection.getLatestBlockhash('confirmed');
    initTx.recentBlockhash = initBlockhash.blockhash;
    initTx.sign(feePayer, dexterAuthority);
    const initSig = await connection.sendRawTransaction(initTx.serialize());
    await connection.confirmTransaction({ signature: initSig, ...initBlockhash }, 'confirmed');
    console.log(`    Init tx: https://solscan.io/tx/${initSig}`);
    await pollAccountExists(connection, vaultPda);

    // --- Buyer opens tab against the seller ----------------------------

    const adapter = createSolanaVaultAdapter({
      connection,
      swigAddress: SystemProgram.programId.toBase58(),
      vaultPda,
      passkeySigner: passkeySignerFromP256Keypair(passkey),
      feePayer,
    });

    console.log(`\n[4] openTab() — passkey signs the 180-byte registration...`);
    const tab = await openTab({
      vault: adapter,
      network: 'solana:mainnet',
      seller: sellerKeypair.publicKey.toBase58(),
      perUnitCap: '0.001',   // per-stream budget (the voucher header authorizes this)
      totalCap: '0.10',
      sessionDuration: 600,
    });
    console.log(`    channelId: ${tab.channelId.slice(0, 16)}…`);

    // --- Paid stream ---------------------------------------------------

    console.log(`\n[5] tab.stream() against ${sellerUrl}/inference ...`);
    const stream = await tab.stream(`${sellerUrl}/inference`, { method: 'POST' });
    const decoder = new TextDecoder();
    let accumulated = '';
    for await (const chunk of stream) {
      const text = decoder.decode(chunk);
      accumulated += text;
      process.stdout.write(`    [chunk] "${text}"\n`);
    }
    console.log(`\n    Full response: "${accumulated.trim()}"`);
    console.log(`    Tab state.spent: ${tab.state.spent}`);

    // --- Close ---------------------------------------------------------

    console.log(`\n[6] tab.close() — passkey signs the 128-byte revocation...`);
    const closeResult = await tab.close();
    console.log(`    settledAmount: ${closeResult.settledAmount}`);
    console.log(`\n=== SMOKE PASSED ===`);
  } finally {
    server.close();
  }
}

main().catch((e) => {
  console.error('\n=== SMOKE FAILED ===');
  console.error(e);
  process.exit(1);
});
