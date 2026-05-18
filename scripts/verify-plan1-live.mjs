/**
 * Plan 1 — Task 13 live end-to-end verification.
 *
 * Pays three real x402 merchants through the SDK's `payAndFetch` seam to
 * prove the version dispatcher works against live endpoints:
 *   - v2 EVM (Base)        — exercises the v2 strategy
 *   - v1 EVM (Base, bare)  — exercises the v1 EIP-3009 path + the no-rewrite fix
 *   - v1 SVM (Solana, bare)— exercises the brand-new v1 SVM signing
 *
 * Wallet keys are read from dexter-api's .env (the verifier test wallet,
 * refueled to ~5 USDC per chain). RPC for v1 SVM signing is the dexter-api
 * SOLANA_RPC_ENDPOINT.
 *
 * Run: node --env-file=<dexter-api>/.env scripts/verify-plan1-live.mjs
 */
import { payAndFetch, createKeypairWallet, createEvmKeypairWallet } from '../dist/client/index.js';

const SOLANA_RPC = process.env.SOLANA_RPC_ENDPOINT;
const EVM_KEY = process.env.BASE_TEST_PRIVATE_KEY;
const SOL_KEY = process.env.SOLANA_TEST_PRIVATE_KEY;

const explorer = (network, sig) => {
  if (!sig) return '(no tx signature returned)';
  const bare = (network?.bare || network || '').toLowerCase();
  if (bare.includes('sol')) return `https://solscan.io/tx/${sig}`;
  if (bare.includes('base')) return `https://basescan.org/tx/${sig}`;
  return sig;
};

async function buildWallets() {
  const wallets = {};
  if (SOL_KEY) {
    const sk = SOL_KEY.trim().startsWith('[')
      ? Uint8Array.from(JSON.parse(SOL_KEY))
      : (await import('bs58')).default.decode(SOL_KEY);
    wallets.solana = await createKeypairWallet(sk);
  }
  if (EVM_KEY) {
    wallets.evm = await createEvmKeypairWallet(EVM_KEY);
  }
  return wallets;
}

async function run(label, url, opts) {
  process.stdout.write(`\n── ${label}\n   ${url}\n`);
  const wallets = await buildWallets();
  const t0 = Date.now();
  let result;
  try {
    result = await payAndFetch(url, { method: 'GET' }, wallets, {
      maxAmountAtomic: '200000', // $0.20 cap — generous, every test merchant is under it
      timeoutMs: 45000,
      solanaRpcUrl: SOLANA_RPC,
      ...opts,
    });
  } catch (err) {
    console.log(`   THREW (payAndFetch must never throw): ${err?.message || err}`);
    return { label, ok: false, threw: true };
  }
  const ms = Date.now() - t0;
  if (result.ok) {
    let bodyPreview = '';
    try {
      const text = await result.response.clone().text();
      bodyPreview = text.slice(0, 160).replace(/\s+/g, ' ');
    } catch { /* binary or consumed */ }
    console.log(`   ✅ PAID — HTTP ${result.response.status} in ${ms}ms`);
    console.log(`      amount paid : ${result.amountPaid}`);
    console.log(`      network     : ${result.network?.bare} (${result.network?.caip2})`);
    console.log(`      settlement  : ${explorer(result.network, result.txSignature)}`);
    console.log(`      response    : ${bodyPreview || '(empty / binary)'}`);
    return { label, ok: true, status: result.response.status, tx: result.txSignature };
  } else {
    console.log(`   ❌ ${result.reason}${result.detail ? ` — ${result.detail}` : ''} (${ms}ms)`);
    return { label, ok: false, reason: result.reason, detail: result.detail };
  }
}

(async () => {
  console.log('Plan 1 — Task 13 live verification');
  console.log('SDK payAndFetch @ ../dist/client/index.js (3.7.0)');
  console.log(`Solana RPC: ${SOLANA_RPC ? 'configured' : 'MISSING'}`);
  console.log(`EVM key: ${EVM_KEY ? 'present' : 'MISSING'}  |  SOL key: ${SOL_KEY ? 'present' : 'MISSING'}`);

  const results = [];
  results.push(await run('v2 EVM  (Base)',   'https://wbgghlia.nx.link/api/top-pnl'));
  results.push(await run('v1 EVM  (Base)',   'https://api.strale.io/x402/gas-price-check'));
  results.push(await run('v1 SVM  (Solana)', 'https://mpp.hyreagent.fun/defi/tvl'));

  console.log('\n════ SUMMARY ════');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}  ${r.ok ? `HTTP ${r.status}` : (r.reason || 'threw')}`);
  }
  const passed = results.filter(r => r.ok).length;
  console.log(`\n  ${passed}/${results.length} live paid calls settled.`);
  process.exit(passed === results.length ? 0 : 1);
})();
