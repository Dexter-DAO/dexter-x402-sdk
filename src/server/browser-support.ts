/**
 * x402 Browser Support Middleware
 *
 * Express middleware that automatically renders a branded HTML paywall page
 * when a browser (Accept: text/html) receives a 402 Payment Required response.
 * API clients continue to receive the standard JSON response unchanged.
 *
 * Includes a functional "Pay" button using the Solana Wallet Standard --
 * detects Phantom/Solflare/Backpack, constructs a USDC transfer, signs,
 * and submits the payment automatically.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { x402Middleware, x402BrowserSupport } from '@dexterai/x402/server';
 *
 * const app = express();
 * app.use(express.json());
 * app.use(x402BrowserSupport());
 *
 * app.post('/api/data',
 *   x402Middleware({ payTo: '...', amount: '0.01' }),
 *   (req, res) => res.json({ data: 'protected' })
 * );
 * ```
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Configuration for x402BrowserSupport middleware.
 */
export interface X402BrowserSupportConfig {
  /** Custom title shown on the paywall page. @default 'Payment Required' */
  title?: string;
  /** Custom branding text. @default 'Powered by x402' */
  branding?: string;
  /** URL to link for SDK/documentation. @default 'https://docs.dexter.cash/docs/sdk/' */
  sdkUrl?: string;
  /** Whether to include the request method and path. @default true */
  showEndpoint?: boolean;
  /** Solana RPC URL for wallet transactions. @default 'https://api.dexter.cash/api/solana/rpc' */
  rpcUrl?: string;
}

/* ------------------------------------------------------------------ */
/*  USDC coin icon SVG (inline, use at ~18px)                         */
/* ------------------------------------------------------------------ */
const USDC_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 2000 2000" xmlns="http://www.w3.org/2000/svg"><path d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z" fill="#2775ca"/><path d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z" fill="#fff"/><path d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z" fill="#fff"/></svg>`;

/* ------------------------------------------------------------------ */
/*  Dexter crest SVG (inline, ~40px display)                          */
/* ------------------------------------------------------------------ */
const DEXTER_CREST_SVG = `<svg width="36" height="36" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg"><g><path fill="#F2681A" d="m324.93,313.11c-115.5,0-231,0-350,0l350,0z"/><path fill="#FDFAF5" d="m230.43,50.62c1.1.85 2.19 1.7 3.32 2.57 6.02 4.8 11.77 9.88 17.46 15.07.92.84.92.84 1.86 1.69 1.82 1.69 3.59 3.42 5.35 5.16.61.56 1.22 1.13 1.84 1.71 5.66 5.76 6.18 10.43 6.13 18.3.02 1.16.04 2.32.06 3.52.06 3.83.06 7.65.07 11.48.02 2.68.05 5.35.08 8.03.05 5.6.09 11.21.1 16.81.02 7.15.09 14.31.17 21.46.06 5.53.1 11.05.13 16.58.02 2.64.04 5.27.07 7.91.18 17.58.12 32.82-11.24 47.32-7.35 7.27-16.54 12.06-25.42 17.22-1.97 1.16-3.94 2.33-5.91 3.49-7.16 4.24-14.34 8.44-21.53 12.62-4.8 2.79-9.59 5.6-14.38 8.42-1.25.73-2.5 1.47-3.79 2.23-2.32 1.36-4.64 2.73-6.96 4.1-27.47 16.09-27.47 16.09-42.16 12.93-8.06-2.28-14.94-5.82-22.16-10.02-1.17-.67-2.34-1.34-3.54-2.04-24.55-14.25-43.58-27.03-51.9-55.58-1.07-4.58-1.54-8.92-1.52-13.61.28-9.5.28-9.5-3.3-17.97-1.81-1.49-3.68-2.92-5.59-4.28-9.19-7.06-12.7-20.03-14.18-31.06-.54-5.77-.55-11.56-.6-17.35-.03-1.32-.07-2.63-.1-3.99-.01-1.26-.02-2.53-.03-3.83-.02-1.15-.03-2.29-.05-3.47.72-4.02 1.94-5.36 5.21-7.74 2.89-.53 2.89-.53 6.07-.46 1.71.02 1.71.02 3.46.05 1.19.04 2.37.08 3.59.12 1.2.02 2.41.04 3.65.06 2.97.05 5.93.13 8.9.23.14-1.35.29-2.7.43-4.08.63-5 1.78-9.74 3.14-14.58.22-.79.43-1.59.66-2.4.53-1.92 1.06-3.84 1.6-5.76-1.55-.45-1.55-.45-3.13-.9-9.52-3.52-17.1-10.95-21.37-20.1-3.81-9.26-3.87-20.34-.29-29.68 6.49-13.99 16.36-23.23 30.66-29.01 49.81-17.69 115.79 8.35 155.13 38.85z"/><path fill="#F2671A" d="m142.93,22.62c.86.19 1.73.39 2.62.59 36.12 8.21 68.79 24.98 95.38 50.75 1.02.98 2.03 1.97 3.08 2.98 10.84 10.66 10.84 10.66 11.05 14.62-2.06 3.55-5.44 4.18-9.17 5.3-.79.25-1.59.49-2.41.75-28.13 8.43-60.95 6.37-87.13-7.16-.86-.49-1.71-.97-2.6-1.48-7.37-4.05-12.59-3.36-20.59-1.54-22.76 4-48.47 1.53-68.69-9.74-4.88-3.88-8.23-8.29-10.21-14.22-.93-10.38-.67-18.44 5.83-26.83 19.57-23.38 55.99-20.36 82.83-14z"/><path fill="#F16619" d="m44.93,129.12c27.36-.03 54.72-.05 82.08-.06 12.7-.01 25.41-.01 38.11-.03 11.07-.01 22.14-.02 33.2-.02 5.86 0 11.73-.01 17.59-.01 5.51-.01 11.03-.01 16.54-.01 2.03 0 4.06 0 6.09-.01 2.76-.01 5.52 0 8.28 0 .81 0 1.63-.01 2.47-.01 5.51.02 5.51.02 6.81 1.32.22 3.43.22 3.43 0 7-2.75 2.75-3.42 2.66-7.15 2.82-1.41.07-1.41.07-2.85.14-1.47.05-1.47.05-2.98.11-1.49.07-1.49.07-3 .14-2.45.11-4.9.21-7.35.3-.2 1.3-.4 2.59-.6 3.93-2.57 16.08-5.93 29.89-18.89 40.86-10.35 7.28-21.87 8.49-34.17 7.71-13.11-2.33-22.52-9.19-30.33-19.83-4.49-7.64-4.8-17.05-5.83-25.67-4.24.39-8.47.77-12.83 1.17-.28 1.84-.28 1.84-.56 3.71-2.32 14.39-5.63 23.35-16.95 33.11-2.32 1.67-2.32 1.67-4.65 1.67 4 4.67 9.06 6.59 14.87 8.24 3.79 1.09 3.79 1.09 6.12 3.43-.65 5.31-.65 5.31-2.33 7-8.42-.27-15.13-2.29-22.17-7-1.09-1.21-2.17-2.43-3.25-3.65-2.72-2.81-4.45-3.84-8.36-4.16-1.67-.02-3.34-.02-5.01.01-1.77-.04-3.54-.09-5.3-.15-1.27-.04-1.27-.04-2.56-.08-9.26-.54-17.6-4.56-24.51-10.64-9.58-11.11-11.03-22.56-10.72-36.82.02-1.4.03-2.8.05-4.24.04-3.42.1-6.85.17-10.27z"/><path fill="#F26117" d="m172.68,203.08c7.27.09 13.23 1.97 18.87 6.65 2.88 3.07 3.86 5.12 4.25 9.32-.12 1.01-.24 2.02-.36 3.06-2.55.95-2.55.95-5.83 1.17-3.28-2.84-3.28-2.84-5.83-5.83-.36.58-.71 1.16-1.08 1.75-7.6 11.29-20.06 17.74-33.05 21.09-20.36 3.1-36.81-1.66-53.37-13.73-2.33-2.11-2.33-2.11-4.67-5.61.42-3.45.99-4.49 3.5-7 4.07.37 5.95 2.13 8.75 4.96 9.81 8.93 22.53 11.87 35.51 11.69 11.74-1.05 22.38-5.85 31.57-13.15 2.06-2.45 2.06-2.45 3.5-4.67-1.66.07-1.66.07-3.35.15-3.65-.15-3.65-.15-5.98-2.48.75-6.18 1.46-7.19 7.58-7.36z"/></g></svg>`;

/* ------------------------------------------------------------------ */
/*  Shared CSS for all Dexter-branded pages                           */
/* ------------------------------------------------------------------ */
const DEXTER_STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Orbitron:wght@500;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{max-width:460px;width:100%;background:rgba(20,20,20,.85);border:1px solid rgba(242,107,26,.12);border-radius:8px;padding:2rem 2rem 1.75rem;text-align:center;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.crest{margin:0 auto .75rem}
h1{font-family:'Orbitron',sans-serif;font-size:1.15rem;font-weight:700;color:#f1f5f9;letter-spacing:.04em;margin-bottom:.35rem}
.desc{color:#94a3b8;font-size:.9rem;margin-bottom:1.25rem;line-height:1.5}
.price{font-family:'Orbitron',sans-serif;font-size:1.6rem;font-weight:700;color:#F26B1A;margin:.75rem 0 .25rem;display:inline-flex;align-items:center;gap:.35rem}
.price svg{width:1.3em;height:1.3em;flex-shrink:0}
.chain{color:#525252;font-size:.75rem;margin-bottom:1.25rem;letter-spacing:.03em}
.endpoint{background:rgba(242,107,26,.06);border:1px solid rgba(242,107,26,.12);border-radius:6px;padding:.5rem .75rem;margin-bottom:1.25rem}
.endpoint code{font-family:'SF Mono',Monaco,Consolas,monospace;font-size:.8rem;color:#F26B1A}
.info{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:6px;padding:.85rem 1rem;font-size:.82rem;color:#737373;line-height:1.6;text-align:left}
.info strong{color:#a3a3a3}
.info code{background:rgba(242,107,26,.08);padding:2px 5px;border-radius:3px;font-size:.78rem;color:#F26B1A;font-family:'SF Mono',Monaco,Consolas,monospace}
.info a{color:#F26B1A;text-decoration:none;font-weight:600}
.info a:hover{text-decoration:underline}
.footer{margin-top:1.25rem;display:flex;align-items:center;justify-content:center;gap:.75rem;font-size:.7rem;color:#404040}
.footer a{color:#525252;text-decoration:none}
.footer a:hover{color:#737373}
.sep{width:3px;height:3px;border-radius:50%;background:#333}
`;

/* ------------------------------------------------------------------ */
/*  Pay button styles + states                                        */
/* ------------------------------------------------------------------ */
const PAY_BUTTON_STYLES = `
.pay-section{margin:1.25rem 0}
.pay-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;background:linear-gradient(135deg,#F26B1A,#D13F00);color:#fff;border:none;padding:.65rem 2rem;border-radius:6px;font-family:'Inter',sans-serif;font-size:.95rem;font-weight:600;cursor:pointer;transition:opacity .15s,transform .1s;min-width:180px}
.pay-btn:hover:not(:disabled){opacity:.9;transform:translateY(-1px)}
.pay-btn:active:not(:disabled){transform:translateY(0)}
.pay-btn:disabled{opacity:.6;cursor:not-allowed}
.pay-btn .spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.pay-status{font-size:.8rem;color:#737373;margin-top:.5rem;min-height:1.2em}
.pay-status.error{color:#ef4444}
.pay-status.success{color:#22c55e}
.pay-alt{font-size:.78rem;color:#404040;margin-top:.75rem}
.pay-alt a{color:#F26B1A;text-decoration:none}
.result-box{background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.15);border-radius:6px;padding:.75rem;margin-top:.75rem;text-align:left;font-size:.78rem;max-height:200px;overflow:auto}
.result-box pre{color:#94a3b8;font-family:'SF Mono',Monaco,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.no-wallet{font-size:.82rem;color:#737373;margin:1rem 0}
`;

/* ------------------------------------------------------------------ */
/*  Wallet payment inline script (Solana Wallet Standard)             */
/* ------------------------------------------------------------------ */
const PAY_SCRIPT = `
<script type="module">
// Payment data is embedded in #x402-data attributes
const dataEl = document.getElementById('x402-data');
if (!dataEl) throw new Error('Missing payment data');

const requirements = JSON.parse(atob(dataEl.dataset.requirements));
const requestMethod = dataEl.dataset.method;
const requestUrl = dataEl.dataset.url;
const rpcUrl = dataEl.dataset.rpc || 'https://api.dexter.cash/api/solana/rpc';

// Detect wallet provider
function getWalletProvider() {
  if (window.phantom?.solana?.isPhantom) return { name: 'Phantom', provider: window.phantom.solana };
  if (window.solflare?.isSolflare) return { name: 'Solflare', provider: window.solflare };
  if (window.backpack) return { name: 'Backpack', provider: window.backpack };
  // Generic wallet-standard fallback
  if (window.solana) return { name: 'Wallet', provider: window.solana };
  return null;
}

const walletInfo = getWalletProvider();
const btn = document.getElementById('pay-btn');
const status = document.getElementById('pay-status');
const section = document.getElementById('pay-section');
const noWallet = document.getElementById('no-wallet');

if (walletInfo && btn) {
  section.style.display = 'block';
  if (noWallet) noWallet.style.display = 'none';
} else if (noWallet) {
  noWallet.style.display = 'block';
  if (section) section.style.display = 'none';
}

// Preload Solana libraries in background
let solanaLibs = null;
const preload = (async () => {
  try {
    const [web3, spl] = await Promise.all([
      import('https://esm.sh/@solana/web3.js@1.98.0'),
      import('https://esm.sh/@solana/spl-token@0.4.9'),
    ]);
    solanaLibs = { web3, spl };
  } catch (e) {
    console.warn('[x402] Failed to preload Solana libraries:', e);
  }
})();

function setStatus(msg, type) {
  if (!status) return;
  status.textContent = msg;
  status.className = 'pay-status' + (type ? ' ' + type : '');
}

function setBtnState(text, disabled, loading) {
  if (!btn) return;
  btn.disabled = disabled;
  btn.innerHTML = loading
    ? '<span class="spinner"></span>' + text
    : text;
}

if (btn) {
  btn.addEventListener('click', async () => {
    if (!walletInfo) return;
    const { provider } = walletInfo;

    try {
      // 1. Connect wallet
      setBtnState('Connecting...', true, true);
      setStatus('');
      await provider.connect();

      if (!provider.publicKey) {
        throw new Error('Wallet did not provide a public key');
      }

      // 2. Load Solana libraries (should already be cached from preload)
      setBtnState('Preparing...', true, true);
      await preload;
      if (!solanaLibs) {
        // Retry once
        const [web3, spl] = await Promise.all([
          import('https://esm.sh/@solana/web3.js@1.98.0'),
          import('https://esm.sh/@solana/spl-token@0.4.9'),
        ]);
        solanaLibs = { web3, spl };
      }

      const { web3, spl } = solanaLibs;
      const { PublicKey, Connection, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = web3;
      const { getAssociatedTokenAddress, createTransferCheckedInstruction, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = spl;

      // 3. Parse payment requirements
      const accept = requirements.accepts[0];
      if (!accept) throw new Error('No payment method available');

      const payTo = new PublicKey(accept.payTo);
      const amount = BigInt(accept.amount || accept.maxAmountRequired);
      const mintPubkey = new PublicKey(accept.asset);
      const feePayer = accept.extra?.feePayer ? new PublicKey(accept.extra.feePayer) : provider.publicKey;
      const userPubkey = provider.publicKey;

      // 4. Build transaction
      setBtnState('Building tx...', true, true);
      const connection = new Connection(rpcUrl, 'confirmed');

      const instructions = [];

      // ComputeBudget
      instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 12000 }));
      instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));

      // Determine token program
      const mintInfo = await connection.getAccountInfo(mintPubkey, 'confirmed');
      if (!mintInfo) throw new Error('Token mint not found');
      const programId = mintInfo.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

      const mint = await getMint(connection, mintPubkey, undefined, programId);

      // ATAs
      const sourceAta = await getAssociatedTokenAddress(mintPubkey, userPubkey, false, programId);
      const destAta = await getAssociatedTokenAddress(mintPubkey, payTo, false, programId);

      // Verify source exists
      const sourceInfo = await connection.getAccountInfo(sourceAta, 'confirmed');
      if (!sourceInfo) throw new Error('No USDC token account found. Make sure you have USDC in your wallet.');

      // TransferChecked
      instructions.push(createTransferCheckedInstruction(sourceAta, mintPubkey, destAta, userPubkey, amount, mint.decimals, [], programId));

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const message = new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions }).compileToV0Message();
      const transaction = new VersionedTransaction(message);

      // 5. Sign
      setBtnState('Sign in wallet...', true, true);
      setStatus('Approve the transaction in your wallet');
      const signed = await provider.signTransaction(transaction);
      const serialized = signed.serialize();

      // Convert Uint8Array to base64
      let payload = '';
      const bytes = new Uint8Array(serialized);
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        payload += String.fromCharCode.apply(null, bytes.slice(i, i + chunk));
      }
      payload = btoa(payload);

      // 6. Build payment-signature header (x402 v2 format)
      // Solana: payload must be { transaction: base64Tx } per SDK spec
      const paymentSignature = {
        x402Version: accept.x402Version ?? 2,
        resource: requirements.resource,
        accepted: accept,
        payload: { transaction: payload },
      };
      const paymentHeader = btoa(JSON.stringify(paymentSignature));

      // 7. Submit payment
      setBtnState('Verifying...', true, true);
      setStatus('Payment submitted, verifying...');

      // Use the original request body if available
      const originalBody = dataEl.dataset.body ? atob(dataEl.dataset.body) : '{}';
      const response = await fetch(requestUrl, {
        method: requestMethod,
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-SIGNATURE': paymentHeader,
        },
        body: requestMethod !== 'GET' ? originalBody : undefined,
      });

      if (response.ok) {
        const data = await response.json();
        setBtnState('Paid', true, false);
        setStatus('Payment successful', 'success');
        // Show response
        const resultBox = document.createElement('div');
        resultBox.className = 'result-box';
        resultBox.innerHTML = '<pre>' + JSON.stringify(data, null, 2).replace(/</g, '&lt;') + '</pre>';
        section.appendChild(resultBox);
      } else {
        const err = await response.json().catch(() => ({ error: 'Payment verification failed' }));
        throw new Error(err.error || err.reason || 'Payment failed');
      }
    } catch (err) {
      console.error('[x402] Payment error:', err);
      setBtnState('Pay ' + document.getElementById('price-value').textContent, false, false);
      setStatus(err.message || 'Payment failed', 'error');
    }
  });
}
</script>
`;

/**
 * Generate the Dexter-branded paywall HTML with wallet pay button.
 */
function generatePaywallHtml(
  paymentRequiredHeader: string,
  requestUrl: string,
  method: string,
  config: Required<Pick<X402BrowserSupportConfig, 'title' | 'branding' | 'sdkUrl' | 'showEndpoint'>>,
  rpcUrl: string,
  requestBody?: string,
): string {
  let price = '?';
  let description = 'This resource requires payment';
  let network = '';

  try {
    const decoded = JSON.parse(Buffer.from(paymentRequiredHeader, 'base64').toString());
    const accept = decoded.accepts?.[0];
    if (accept) {
      const amount = accept.amount || accept.maxAmountRequired || '0';
      const decimals = accept.extra?.decimals || 6;
      price = (Number(amount) / Math.pow(10, decimals)).toFixed(decimals > 4 ? 4 : 2);
      network = accept.network || '';
    }
    if (decoded.resource?.description) {
      description = decoded.resource.description;
    }
  } catch {
    // If we can't decode, show generic paywall
  }

  const chainName = network.includes('solana')
    ? 'Solana'
    : network.includes('eip155')
      ? 'Base'
      : '';

  const endpointSection = config.showEndpoint
    ? `<div class="endpoint"><code>${method} ${requestUrl}</code></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${config.title} — ${price} USDC</title>
<style>${DEXTER_STYLES}${PAY_BUTTON_STYLES}</style>
</head>
<body>
<div class="card">
  <div class="crest">${DEXTER_CREST_SVG}</div>
  <h1>${config.title}</h1>
  <p class="desc">${description}</p>
  <div class="price">${USDC_ICON_SVG}<span id="price-value">${price}</span></div>
  <div class="chain">${chainName}${chainName ? ' network' : ''}</div>
  ${endpointSection}

  <div id="pay-section" class="pay-section" style="display:none">
    <button id="pay-btn" class="pay-btn">Pay ${price}</button>
    <div id="pay-status" class="pay-status"></div>
    <div class="pay-alt">or use <a href="${config.sdkUrl}">x402 SDK</a> for programmatic access</div>
  </div>

  <div id="no-wallet" class="no-wallet" style="display:none">
    <div class="info">
      <strong>Access this endpoint:</strong><br><br>
      Use any x402-compatible client or a browser with a Solana wallet extension (Phantom, Solflare, Backpack).<br><br>
      <code>npm install @dexterai/x402</code><br><br>
      <a href="${config.sdkUrl}">x402 SDK docs &rarr;</a>
    </div>
  </div>

  <div class="footer">
    <a href="https://docs.dexter.cash/docs/sdk/">x402</a>
    <span class="sep"></span>
    <a href="https://dexter.cash">Dexter</a>
  </div>
</div>

<div id="x402-data" style="display:none"
  data-requirements="${paymentRequiredHeader}"
  data-method="${method}"
  data-url="${requestUrl}"
  data-rpc="${rpcUrl}"
  data-body="${requestBody ? Buffer.from(requestBody).toString('base64') : ''}"
></div>
${PAY_SCRIPT}
</body>
</html>`;
}

/**
 * Create x402 browser support middleware.
 *
 * Wraps `res.json()` to intercept 402 Payment Required responses.
 * When the request is from a browser (Accept: text/html) and no
 * payment-signature header is present, renders a branded HTML paywall
 * instead of raw JSON.
 *
 * API clients are completely unaffected -- they receive normal JSON.
 */
export function x402BrowserSupport(config: X402BrowserSupportConfig = {}): RequestHandler {
  const resolvedConfig = {
    title: config.title ?? 'Payment Required',
    branding: config.branding ?? 'Powered by <a href="https://docs.dexter.cash/docs/sdk/">Dexter x402</a>',
    sdkUrl: config.sdkUrl ?? 'https://docs.dexter.cash/docs/sdk/',
    showEndpoint: config.showEndpoint ?? true,
  };
  const rpcUrl = config.rpcUrl ?? 'https://api.dexter.cash/api/solana/rpc';

  return (req: Request, res: Response, next: NextFunction): void => {
    const originalJson = res.json.bind(res);

    res.json = function (body: unknown) {
      if (
        res.statusCode === 402 &&
        req.accepts('html') &&
        !req.headers['payment-signature']
      ) {
        const paymentRequired =
          (res.getHeader('PAYMENT-REQUIRED') as string) ||
          (res.getHeader('payment-required') as string);

        if (paymentRequired && typeof paymentRequired === 'string') {
          // Capture the original request body for the pay button
          let bodyStr: string | undefined;
          if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
            try { bodyStr = JSON.stringify(req.body); } catch { /* ignore */ }
          }
          const html = generatePaywallHtml(
            paymentRequired,
            req.originalUrl,
            req.method,
            resolvedConfig,
            rpcUrl,
            bodyStr,
          );
          res.status(402).type('html').send(html);
          return res;
        }
      }

      return originalJson(body);
    } as typeof res.json;

    next();
  };
}
