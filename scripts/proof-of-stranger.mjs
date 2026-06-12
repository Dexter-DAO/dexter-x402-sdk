/**
 * Step-3b STRANGER proof: a buyer with ONLY a PUBLIC URL pays a live,
 * deployed Dexter tab-metered service through a freeze-protected mainnet
 * tab — no localhost seller, no facilitator override, no seller knowledge.
 *
 *   resolveTabTerms(url)  -> the terms a consent UI would show (no payment)
 *   payUrlWithTab(url)    -> discover counterparty off the wire, open tab
 *                            (freeze arms via the PUBLIC facilitator), pay
 *   tab.close()           -> settle USDC on mainnet
 *
 * The buyer never references the seller. The facilitator is the SDK
 * default (https://x402.dexter.cash). This is the "any agent, any URL"
 * claim, executed literally.
 *
 * Run: node scripts/proof-of-stranger.mjs   (ORCHESTRATOR ONLY — mainnet)
 */
import { readFileSync } from 'node:fs';
import { Connection, Keypair } from '@solana/web3.js';

import { payUrlWithTab, resolveTabTerms } from '@dexterai/x402/tab';
import {
  createSolanaVaultAdapter,
  passkeySignerFromP256Keypair,
} from '@dexterai/x402/tab/adapters/solana';

const URL_UNDER_TEST = 'https://api.dexter.cash/api/x402/tab-demo/tick';
const HELIUS = process.env.SOLANA_RPC_URL || 'https://rpc.dexter.cash'; // Dexter RPC proxy (key server-side); NEVER mainnet-beta
const PER_UNIT_CAP = '0.02';
const TOTAL_CAP = '0.02';

const CRED_FILE = '/home/branchmanager/websites/dexter-facilitator/scripts/ots-e2e/test-credentials/2026-06-05T23-11-28-918Z-e2e-test-1780701079880-c743910c.json';
const FEE_PAYER_FILE = '/home/branchmanager/.config/solana/dexter-vault/upgrade-authority.json';

const log = (...a) => console.log('[stranger]', ...a);

const cred = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
const passkeyKp = {
  publicKey: Uint8Array.from(Buffer.from(cred.passkeyPublicKeyBase64, 'base64')),
  privateKey: Uint8Array.from(Buffer.from(cred.passkeyPrivateKeyBase64, 'base64')),
};
const feePayer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(FEE_PAYER_FILE, 'utf8'))));
const conn = new Connection(HELIUS, 'confirmed');

async function main() {
  log('url      :', URL_UNDER_TEST);
  log('buyer    :', cred.vaultPda, '(test vault; knows NOTHING about the seller)');

  // 1. The consent-UI view: terms without paying.
  const resolved = await resolveTabTerms(URL_UNDER_TEST);
  if (resolved.kind !== 'terms') throw new Error(`resolve failed: ${JSON.stringify(resolved)}`);
  log('terms    :', JSON.stringify(resolved.terms));

  // 2. Pay it. No facilitatorUrl (SDK default = the PUBLIC facilitator),
  //    no seller, no localhost — just the URL and the buyer's own caps.
  const vault = createSolanaVaultAdapter({
    connection: conn,
    swigAddress: cred.swigAddress,
    vaultPda: cred.vaultPda,
    passkeySigner: passkeySignerFromP256Keypair(passkeyKp),
    feePayer,
  });
  const { result, tab } = await payUrlWithTab(URL_UNDER_TEST, { method: 'GET' }, {
    vault, perUnitCap: PER_UNIT_CAP, totalCap: TOTAL_CAP,
  });
  if (!result.ok || !result.paid) {
    try { await tab?.close(); } catch { /* surfaced below */ }
    throw new Error(`payUrlWithTab failed: ${result.reason} ${result.detail ?? ''}`);
  }
  const body = result.response ? (await result.response.text()).trim() : '';
  log('paid body:', body);

  // 3. Settle on mainnet.
  const closeResult = await tab.close();
  log('settle   :', closeResult.settleTx);

  if (tab.counterparty !== resolved.terms.counterparty) {
    throw new Error('counterparty drift between resolve and pay');
  }

  console.log('\n===== PROOF-OF-STRANGER RESULT (STEP 3b, PUBLIC URL) =====');
  console.log(JSON.stringify({
    url: URL_UNDER_TEST,
    facilitator: 'https://x402.dexter.cash (SDK default — no override)',
    discoveredSeller: tab.counterparty,
    sellerHardcodedInBuyer: false,
    terms: resolved.terms,
    settleTx: closeResult.settleTx,
    grossAmount: closeResult.grossAmount,
    feeAmount: closeResult.feeAmount,
    netAmount: closeResult.netAmount,
    paidBody: body,
  }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error('[stranger] FAILED:', e?.stack || e); process.exit(1); });
