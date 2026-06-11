/**
 * Thin proof-of-loop: ONE real seller, ONE real buyer, a real HTTP 402 tab
 * exchange, settled on Solana mainnet. The receipt the thesis lacked —
 * "a real service billed a real buyer through a tab, fee kept, buyer couldn't rug."
 *
 * Single process: the seller (Express + tabMiddleware) listens on localhost; the
 * buyer (openTab -> stream -> close) pays it over real HTTP. The on-chain bits
 * (session register, freeze arm, settle) are REAL mainnet txs.
 *
 *   buyer openTab  -> passkey ceremony registers session + facilitator arms freeze
 *   buyer stream() -> signs a voucher, opens SSE to the seller
 *   seller verify  -> on-chain session check + voucher verify, charges, sends 1 tick
 *   buyer close()  -> POST /tab/settle -> on-chain USDC swig->seller + fee split
 *
 * Run: node scripts/proof-of-loop.mjs
 */
import { readFileSync } from 'node:fs';
import express from 'express';
import {
  Connection, Keypair, PublicKey, Transaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';

import { tabMiddleware, requireTab, openSse } from '@dexterai/x402/tab/seller';
import { openTab } from '@dexterai/x402/tab';
import {
  createSolanaVaultAdapter,
  passkeySignerFromP256Keypair,
} from '@dexterai/x402/tab/adapters/solana';

// ── Config ──────────────────────────────────────────────────────────────
const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=8fd1a2cd-76e7-4462-b38b-1026960edd40';
const FACILITATOR = 'http://127.0.0.1:4072';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const NETWORK = 'solana:mainnet';           // SDK v1 alias; facilitator normalizes -> v2 CAIP-2
const PER_TICK = '0.01';                     // gross per tick (>fee floor 354 atomic)
const PER_UNIT_CAP = '0.02';
const TOTAL_CAP = '0.02';                     // small: leaves overcommit headroom vs the 0.13 vault
const PORT = 4455;

const CRED_FILE = '/home/branchmanager/websites/dexter-facilitator/scripts/ots-e2e/test-credentials/2026-06-05T23-11-28-918Z-e2e-test-1780701079880-c743910c.json';
const FEE_PAYER_FILE = '/home/branchmanager/.config/solana/dexter-vault/upgrade-authority.json';

const log = (...a) => console.log('[proof]', ...a);

// ── Identities ──────────────────────────────────────────────────────────
const cred = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
const passkeyKp = {
  publicKey: Uint8Array.from(Buffer.from(cred.passkeyPublicKeyBase64, 'base64')),
  privateKey: Uint8Array.from(Buffer.from(cred.passkeyPrivateKeyBase64, 'base64')),
};
const feePayer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(FEE_PAYER_FILE, 'utf8'))));
// Fixed seller so re-runs REPLACE the session for this counterparty in place
// (V6 re-register replaces) instead of leaking a new live session each run.
const seller = Keypair.fromSeed(new Uint8Array(32).fill(7));
const conn = new Connection(HELIUS, 'confirmed');

log('buyer swig   :', cred.swigAddress);
log('buyer vault  :', cred.vaultPda);
log('seller       :', seller.publicKey.toBase58(), '(ephemeral)');
log('fee payer    :', feePayer.publicKey.toBase58());

// ── helpers ───────────────────────────────────────────────────────────
async function usdcBalance(owner) {
  const ata = getAssociatedTokenAddressSync(USDC_MINT, owner, true);
  try {
    const bal = await conn.getTokenAccountBalance(ata);
    return BigInt(bal.value.amount);
  } catch { return null; }
}

async function main() {
  // 1. Pre-create the seller's USDC ATA so settle has a destination.
  const sellerAta = getAssociatedTokenAddressSync(USDC_MINT, seller.publicKey);
  const ataTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, sellerAta, seller.publicKey, USDC_MINT),
  );
  ataTx.feePayer = feePayer.publicKey;
  ataTx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  ataTx.sign(feePayer);
  const ataSig = await conn.sendRawTransaction(ataTx.serialize());
  await conn.confirmTransaction(ataSig, 'confirmed');
  log('seller USDC ATA ready:', sellerAta.toBase58(), 'tx', ataSig.slice(0, 12) + '…');

  // 2. Stand up the seller.
  const app = express();
  const mw = tabMiddleware({
    connection: conn,
    sellerPubkey: seller.publicKey,
    network: NETWORK,
    perUnit: PER_TICK,
    settle: 'on-close',
    facilitatorUrl: FACILITATOR,
  });
  app.get('/paid/tick', mw, async (req, res) => {
    const tab = requireTab(req);
    log('seller: request in, channel', tab.channelId);
    const meter = openSse(res, { tab, perUnit: PER_TICK });
    await meter.charge(1);
    meter.send(JSON.stringify({ message: 'hello, paid world', servedBy: seller.publicKey.toBase58() }));
    log('seller: charged 1 tick, sent payload, closing');
    meter.end();
  });
  const server = app.listen(PORT);
  log('seller listening on', PORT);

  // balances before
  const sellerBefore = await usdcBalance(seller.publicKey);
  log('seller USDC before:', sellerBefore);

  // 3. Buyer opens a tab and pays.
  const vault = createSolanaVaultAdapter({
    connection: conn,
    swigAddress: cred.swigAddress,
    vaultPda: cred.vaultPda,
    passkeySigner: passkeySignerFromP256Keypair(passkeyKp),
    feePayer,
  });

  log('buyer: opening tab (passkey ceremony + facilitator arm)…');
  const tab = await openTab({
    vault,
    network: NETWORK,
    seller: seller.publicKey.toBase58(),
    perUnitCap: PER_UNIT_CAP,
    totalCap: TOTAL_CAP,
    facilitatorUrl: FACILITATOR,
  });
  log('buyer: tab open, channel', tab.channelId);

  log('buyer: streaming /paid/tick …');
  const stream = await tab.stream(`http://127.0.0.1:${PORT}/paid/tick`, { method: 'GET' });
  let body = '';
  for await (const chunk of stream) body += new TextDecoder().decode(chunk);
  log('buyer: received payload:', body.trim());

  log('buyer: closing tab (settle on mainnet)…');
  const result = await tab.close();
  log('buyer: close result:', JSON.stringify(result));

  // 4. Verify on-chain effect.
  await new Promise((r) => setTimeout(r, 4000));
  const sellerAfter = await usdcBalance(seller.publicKey);
  log('seller USDC after :', sellerAfter);
  log('seller delta      :', (sellerAfter ?? 0n) - (sellerBefore ?? 0n), 'atomic');

  server.close();

  console.log('\n===== PROOF-OF-LOOP RESULT =====');
  console.log(JSON.stringify({
    sellerPaidPayload: body.trim(),
    settleTx: result.settleTx,
    settledAmount: result.settledAmount,
    feeAmount: result.feeAmount,
    netAmount: result.netAmount,
    sellerUsdcDelta: ((sellerAfter ?? 0n) - (sellerBefore ?? 0n)).toString(),
    seller: seller.publicKey.toBase58(),
    channelId: tab.channelId,
  }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error('[proof] FAILED:', e?.stack || e); process.exit(1); });
