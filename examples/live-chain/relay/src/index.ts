/**
 * live-chain relay — entry point.
 *
 * HTTP shape:
 *   GET /healthz                 → liveness; reports mux stats
 *   GET /stream/:account         → SSE; gated by Tab seller middleware.
 *                                  Each request comes with ONE voucher
 *                                  bounding the budget for that request.
 *                                  The relay sends events until budget
 *                                  is exhausted, then closes the SSE so
 *                                  the buyer can open a new request with
 *                                  a fresh voucher.
 *
 * Per the SDK's openSse semantics (src/tab/seller/meter.ts), one HTTP
 * request == one voucher == one bounded budget. The buyer is expected to
 * loop tab.stream() to keep streaming. This relay just charges per
 * event within the budget and bows out cleanly when the budget caps.
 */

import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

import {
  tabMiddleware,
  requireTab,
  openSse,
} from '@dexterai/x402/tab/seller';

import { LaserstreamMux, type ChainEvent } from './subscriber.js';

// ── Env ────────────────────────────────────────────────────────────────

const HELIUS_API_KEY = required('HELIUS_API_KEY');
const SOLANA_RPC_URL = required('SOLANA_RPC_URL');
const SELLER_PRIVATE_KEY = required('SELLER_PRIVATE_KEY');
const PORT = Number(process.env.PORT ?? 4400);
const EVENT_PRICE_USDC = process.env.EVENT_PRICE_USDC ?? '0.0001';
const MAX_TAB_USDC = process.env.MAX_TAB_USDC ?? '5.00';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`required env var missing: ${name}`);
  return v;
}

// ── Wiring ─────────────────────────────────────────────────────────────

const seller = Keypair.fromSecretKey(bs58.decode(SELLER_PRIVATE_KEY));
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
const mux = new LaserstreamMux(
  // Helius Laserstream endpoint (mainnet).
  'https://laserstream-mainnet.helius-rpc.com',
  HELIUS_API_KEY,
);

const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    seller: seller.publicKey.toBase58(),
    pricing: { perEventUsdc: EVENT_PRICE_USDC, maxTabUsdc: MAX_TAB_USDC },
    mux: mux.stats(),
  });
});

// ── Streaming endpoint ─────────────────────────────────────────────────

const sellerMiddleware = tabMiddleware({
  connection,
  sellerPubkey: seller.publicKey,
  network: 'solana:mainnet',
  perUnit: EVENT_PRICE_USDC,
  settle: 'on-close',
});

app.get('/stream/:account', sellerMiddleware, async (req: Request, res: Response) => {
  const tab = requireTab(req);
  const account = req.params.account;

  try {
    new PublicKey(account);
  } catch {
    res.status(400).json({ error: 'invalid account pubkey' });
    return;
  }

  console.log(`[live-chain] stream OPEN channel=${tab.channelId} account=${account} budget=${tab.cumulative()}`);

  const meter = openSse(res, { tab, perUnit: EVENT_PRICE_USDC });
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { meter.end(); } catch { /* ignore — already ended */ }
  };

  // Register listener on the mux. The relay multiplexes from ONE Laserstream
  // subscription per account regardless of buyer count.
  const unsubscribe = mux.subscribeAccount(account, tab.channelId, async (event) => {
    if (stopped) return;
    try {
      await meter.charge(1);
      meter.send(JSON.stringify({ event, channelId: tab.channelId }));
    } catch (err) {
      // Most likely: budget exhausted for this request. That's the signal
      // for the buyer to open a fresh tab.stream() call with a new voucher.
      console.log(`[live-chain] budget exhausted channel=${tab.channelId}: ${(err as Error).message}`);
      stop();
    }
  });

  req.on('close', () => {
    console.log(`[live-chain] stream CLOSE channel=${tab.channelId} reason=client-disconnect`);
    unsubscribe();
    stop();
  });
});

// ── Start ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[live-chain-relay] up on :${PORT}`);
  console.log(`  seller: ${seller.publicKey.toBase58()}`);
  console.log(`  pricing: ${EVENT_PRICE_USDC} USDC/event, max tab ${MAX_TAB_USDC} USDC`);
});
