/**
 * Step-3b dual-rail proof: ONE seller route serving BOTH rails from ONE
 * standard 402. Three legs, all real:
 *   resolve  -> resolveTabTerms(url): terms with zero payment
 *   exact    -> payAndFetch + keypair wallet (the catalog verifier's path)
 *   tab      -> payUrlWithTab -> close -> mainnet settle (the agent's path)
 * Run: node scripts/proof-of-dual.mjs   (ORCHESTRATOR ONLY — mainnet)
 */
import { readFileSync } from 'node:fs';
import express from 'express';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';

import { tabOrExactMiddleware, requireTab, openSse } from '@dexterai/x402/tab/seller';
import { payUrlWithTab, resolveTabTerms } from '@dexterai/x402/tab';
import { payAndFetch, createKeypairWallet } from '@dexterai/x402/client';
import {
  createSolanaVaultAdapter,
  passkeySignerFromP256Keypair,
} from '@dexterai/x402/tab/adapters/solana';

// ── Config (identical to proof-of-loop.mjs except seller seed + port) ──
// Write-capable Solana RPC (the proofs SEND transactions; the public
// rpc.dexter.cash proxy is read-only). The key never lives in this repo:
// SOLANA_RPC_URL env wins, else read the operator box's dexter-api env.
// NEVER mainnet-beta.
function resolveRpcUrl() {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  const apiEnv = readFileSync('/home/branchmanager/websites/dexter-api/.env', 'utf8');
  const m = apiEnv.match(/^SOLANA_RPC_ENDPOINT=(.+)$/m);
  if (!m) throw new Error('set SOLANA_RPC_URL to a write-capable Solana RPC');
  return m[1].trim();
}
const HELIUS = resolveRpcUrl();
const FACILITATOR = 'http://127.0.0.1:4072';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const PER_TICK = '0.01';
const PER_UNIT_CAP = '0.02';
const TOTAL_CAP = '0.02';
const PORT = 4456;

const CRED_FILE = '/home/branchmanager/websites/dexter-facilitator/scripts/ots-e2e/test-credentials/2026-06-05T23-11-28-918Z-e2e-test-1780701079880-c743910c.json';
const FEE_PAYER_FILE = '/home/branchmanager/.config/solana/dexter-vault/upgrade-authority.json';
const DEXTER_API_ENV = '/home/branchmanager/websites/dexter-api/.env';

const log = (...a) => console.log('[dual-proof]', ...a);

const cred = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
const passkeyKp = {
  publicKey: Uint8Array.from(Buffer.from(cred.passkeyPublicKeyBase64, 'base64')),
  privateKey: Uint8Array.from(Buffer.from(cred.passkeyPrivateKeyBase64, 'base64')),
};
const feePayer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(FEE_PAYER_FILE, 'utf8'))));
// FIXED seller from a PRIVATE keypair file — fixed so V6 re-registers replace
// this proof's session in place across runs, private because deterministic
// seeds (fromSeed(fill(N))) are WEAK KEYS: proof-of-loop's fill(7) seller was
// swept by a bot (3a proof money gone, ATA closed) within the hour. Never
// settle real value to a derivable key.
const SELLER_FILE = `${process.env.HOME}/.config/solana/dexter-proof-seller.json`;
const seller = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(SELLER_FILE, 'utf8'))));
const conn = new Connection(HELIUS, 'confirmed');

// The catalog verifier's wallet — the EXACT leg uses the same key the real
// verifier will use against the live route, so this leg IS that rehearsal.
const verifierKeyBs58 = readFileSync(DEXTER_API_ENV, 'utf8')
  .match(/^SOLANA_TEST_PRIVATE_KEY=(.+)$/m)[1].trim();

log('seller (ephemeral):', seller.publicKey.toBase58());
log('tab buyer vault   :', cred.vaultPda);

async function usdcBalance(owner) {
  const ata = getAssociatedTokenAddressSync(USDC_MINT, owner, true);
  try { return BigInt((await conn.getTokenAccountBalance(ata)).value.amount); }
  catch { return null; }
}

async function main() {
  // Seller ATA so both settles have a destination.
  const sellerAta = getAssociatedTokenAddressSync(USDC_MINT, seller.publicKey);
  const ataTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, sellerAta, seller.publicKey, USDC_MINT),
  );
  ataTx.feePayer = feePayer.publicKey;
  ataTx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  ataTx.sign(feePayer);
  const ataSig = await conn.sendRawTransaction(ataTx.serialize());
  await conn.confirmTransaction(ataSig, 'confirmed');
  log('seller ATA ready:', sellerAta.toBase58());

  // The DUAL seller — one middleware, both rails.
  const app = express();
  const dual = tabOrExactMiddleware({
    connection: conn,
    sellerPubkey: seller.publicKey,
    network: 'solana:mainnet',
    perUnit: PER_TICK,
    facilitatorUrl: FACILITATOR,
  });
  app.get('/paid/tick', dual, async (req, res) => {
    if (req.x402) {
      res.json({ message: 'hello, paid world', paidVia: 'exact', tx: req.x402.transaction });
      return;
    }
    const tab = requireTab(req);
    const meter = openSse(res, { tab, perUnit: PER_TICK });
    await meter.charge(1);
    meter.send(JSON.stringify({ message: 'hello, paid world', paidVia: 'tab' }));
    meter.end();
  });
  const server = app.listen(PORT);
  const url = `http://127.0.0.1:${PORT}/paid/tick`;
  log('dual seller listening:', url);

  const before = await usdcBalance(seller.publicKey);

  // LEG 1 — resolve: terms, zero payment.
  const resolved = await resolveTabTerms(url);
  if (resolved.kind !== 'terms') throw new Error(`resolve failed: ${JSON.stringify(resolved)}`);
  if (resolved.terms.counterparty !== seller.publicKey.toBase58()) {
    throw new Error('resolved counterparty mismatch');
  }
  log('LEG 1 resolve OK:', JSON.stringify(resolved.terms));
  const afterResolve = await usdcBalance(seller.publicKey);
  if (afterResolve !== before) throw new Error('resolve MOVED MONEY — must be pre-flight only');

  // LEG 2 — exact: the catalog verifier's path. createKeypairWallet is
  // async (bs58 is dynamically imported inside it); it takes the bs58
  // secret-key string directly.
  const exactWallet = await createKeypairWallet(verifierKeyBs58);
  log('exact buyer (verifier key):', exactWallet.publicKey.toBase58());
  // payAndFetch(url, requestInit, wallets, opts) — opts.maxAmountAtomic caps
  // this leg's spend at exactly one tick; opts.solanaRpcUrl feeds the
  // post-payment settlement-confirmation probe (and v1 signing fallback).
  const exact = await payAndFetch(url, { method: 'GET' }, { solana: exactWallet }, {
    maxAmountAtomic: '10000', // 0.01 USDC — one tick, nothing more
    solanaRpcUrl: HELIUS,
  });
  if (!exact.ok || !exact.paid) throw new Error(`exact leg failed: ${JSON.stringify({ ok: exact.ok, reason: exact.reason, detail: exact.detail })}`);
  if (!exact.response) throw new Error('exact leg paid but merchant never responded (payment confirmed, no body)');
  const exactBody = JSON.parse(await exact.response.text());
  if (exactBody.paidVia !== 'exact') throw new Error('exact leg did not take the exact rail');
  log('LEG 2 exact OK: tx', exactBody.tx, '(client-side txSignature:', exact.txSignature, ')');

  // LEG 3 — tab: the agent's path (3a machinery, dual seller).
  const vault = createSolanaVaultAdapter({
    connection: conn,
    swigAddress: cred.swigAddress,
    vaultPda: cred.vaultPda,
    passkeySigner: passkeySignerFromP256Keypair(passkeyKp),
    feePayer,
  });
  const { result, tab } = await payUrlWithTab(url, { method: 'GET' }, {
    vault, perUnitCap: PER_UNIT_CAP, totalCap: TOTAL_CAP, facilitatorUrl: FACILITATOR,
  });
  if (!result.ok || !result.paid) {
    // Failure after open leaves a non-null tab with the freeze armed —
    // close it (settles anything charged, frees the freeze) before failing.
    try { await tab?.close(); } catch { /* surfaced by the throw below */ }
    throw new Error(`tab leg failed: ${result.reason} ${result.detail ?? ''}`);
  }
  const tabBody = result.response ? (await result.response.text()).trim() : '';
  const closeResult = await tab.close();
  log('LEG 3 tab OK: settle', closeResult.settleTx);

  await new Promise((r) => setTimeout(r, 4000));
  const after = await usdcBalance(seller.publicKey);
  server.close();

  console.log('\n===== PROOF-OF-DUAL RESULT (STEP 3b) =====');
  console.log(JSON.stringify({
    resolvedTerms: resolved.terms,
    exactTx: exactBody.tx,
    exactTxSignature: exact.txSignature,
    exactAmountPaid: exact.amountPaid,
    tabSettleTx: closeResult.settleTx,
    tabNetAmount: closeResult.netAmount,
    tabFeeAmount: closeResult.feeAmount,
    sellerUsdcDelta: ((after ?? 0n) - (before ?? 0n)).toString(),  // expect 10000 (exact) + tab net
    tabBody,
  }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error('[dual-proof] FAILED:', e?.stack || e); process.exit(1); });
