/**
 * Thin proof-of-loop, Step-3a edition: ONE real seller, ONE real buyer, a
 * real HTTP 402 tab exchange, settled on Solana mainnet — and the buyer is
 * given ONLY A URL. No seller pubkey anywhere in the buyer's inputs; the
 * counterparty is discovered from the URL's own standard x402 402 challenge.
 *
 * Single process: the seller (Express + tabChallengeMiddleware +
 * tabMiddleware) listens on localhost; the buyer (payUrlWithTab -> close)
 * pays it over real HTTP. The on-chain bits (session register, freeze arm,
 * settle) are REAL mainnet txs.
 *
 *   buyer GET url          -> seller answers standard 402 {accepts:[{scheme:'tab', payTo, ...}]}
 *   buyer resolves payTo   -> openTab (passkey ceremony + facilitator arms freeze)
 *   buyer pays w/ voucher  -> seller verifies (V6 session PDA), charges, serves
 *   buyer close()          -> POST /tab/settle -> on-chain USDC swig->seller + fee split
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

import { tabMiddleware, tabChallengeMiddleware, requireTab, openSse } from '@dexterai/x402/tab/seller';
import { payUrlWithTab } from '@dexterai/x402/tab';
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
// PRIVATE keypair file, NOT a deterministic seed: the original fill(7) seller
// was a weak key and a bot swept its settle proceeds within the hour.
const SELLER_FILE = `${process.env.HOME}/.config/solana/dexter-proof-seller.json`;
const seller = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(SELLER_FILE, 'utf8'))));
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

  // 2. Stand up the seller. tabChallengeMiddleware answers voucher-less
  //    requests with the STANDARD x402 v2 challenge (so a stranger can
  //    discover the counterparty); tabMiddleware verifies vouchers.
  const app = express();
  const challenge = tabChallengeMiddleware({
    sellerPubkey: seller.publicKey,
    network: NETWORK,
    perUnit: PER_TICK,
    facilitatorUrl: FACILITATOR,
  });
  const mw = tabMiddleware({
    connection: conn,
    sellerPubkey: seller.publicKey,
    network: NETWORK,
    perUnit: PER_TICK,
    settle: 'on-close',
    facilitatorUrl: FACILITATOR,
  });
  app.get('/paid/tick', challenge, mw, async (req, res) => {
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

  // 3. Buyer: pays the URL knowing NOTHING but the URL. This function must
  //    never reference the `seller` keypair — the counterparty comes off
  //    the wire (the 402 challenge's payTo).
  async function buyerPaysUrl(url) {
    const vault = createSolanaVaultAdapter({
      connection: conn,
      swigAddress: cred.swigAddress,
      vaultPda: cred.vaultPda,
      passkeySigner: passkeySignerFromP256Keypair(passkeyKp),
      feePayer,
    });
    log('buyer: resolving + paying', url, '(zero seller knowledge)…');
    const { result, tab } = await payUrlWithTab(url, { method: 'GET' }, {
      vault,
      perUnitCap: PER_UNIT_CAP,
      totalCap: TOTAL_CAP,
      facilitatorUrl: FACILITATOR,
    });
    if (!result.ok) {
      throw new Error(`payUrlWithTab failed: ${result.reason} ${result.detail ?? ''}`);
    }
    if (!result.paid) throw new Error('expected a PAID response, got free');
    const body = result.response ? await result.response.text() : '';
    log('buyer: paid response received; discovered counterparty:', tab.counterparty);
    log('buyer: closing tab (settle on mainnet)…');
    const closeResult = await tab.close();
    log('buyer: close result:', JSON.stringify(closeResult));
    return { body, closeResult, discovered: tab.counterparty, channelId: tab.channelId };
  }

  const { body, closeResult: result, discovered, channelId } =
    await buyerPaysUrl(`http://127.0.0.1:${PORT}/paid/tick`);
  log('buyer: received payload:', body.trim());

  // THE STEP-3a ASSERTION: the buyer discovered the seller off the wire.
  if (discovered !== seller.publicKey.toBase58()) {
    throw new Error(`discovery mismatch: buyer resolved ${discovered}, seller is ${seller.publicKey.toBase58()}`);
  }

  // 4. Verify on-chain effect.
  await new Promise((r) => setTimeout(r, 4000));
  const sellerAfter = await usdcBalance(seller.publicKey);
  log('seller USDC after :', sellerAfter);
  log('seller delta      :', (sellerAfter ?? 0n) - (sellerBefore ?? 0n), 'atomic');

  server.close();

  console.log('\n===== PROOF-OF-LOOP RESULT (STEP 3a: pay-a-URL) =====');
  console.log(JSON.stringify({
    sellerPaidPayload: body.trim(),
    settleTx: result.settleTx,
    settledAmount: result.settledAmount,
    feeAmount: result.feeAmount,
    netAmount: result.netAmount,
    sellerUsdcDelta: ((sellerAfter ?? 0n) - (sellerBefore ?? 0n)).toString(),
    seller: seller.publicKey.toBase58(),
    discoveredSeller: discovered,
    sellerHardcodedInBuyer: false,
    channelId,
  }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error('[proof] FAILED:', e?.stack || e); process.exit(1); });
