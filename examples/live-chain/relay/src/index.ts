/**
 * live-chain relay — entry point.
 *
 * HTTP shape:
 *   GET /healthz                 → liveness; reports mux stats
 *   GET /stream/:account         → SSE; gated by Tab seller middleware
 *                                  Streams batched ChainEvent windows via
 *                                  openSse(); each batch calls meter.charge().
 *
 * The seller middleware verifies the buyer's session registration ONCE on
 * the first request of the session (one on-chain RPC call), caches it, and
 * verifies session-key signatures on every subsequent voucher in O(1) with
 * no chain hits.
 *
 * On the streaming endpoint, the relay batches events per the configured
 * cadence (N events OR M ms) and emits one SSE chunk per batch. Each
 * batch is metered via SseMeter.charge() — the buyer's cumulative voucher
 * total must keep up or the meter rejects.
 */

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
const VOUCHER_BATCH_EVENTS = Number(process.env.VOUCHER_BATCH_EVENTS ?? 10);
const VOUCHER_BATCH_MS = Number(process.env.VOUCHER_BATCH_MS ?? 500);
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

// Liveness + ops view.
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    seller: seller.publicKey.toBase58(),
    voucher: { batchEvents: VOUCHER_BATCH_EVENTS, batchMs: VOUCHER_BATCH_MS },
    pricing: {
      perEventUsdc: EVENT_PRICE_USDC,
      perBatchUsdc: humanMul(EVENT_PRICE_USDC, VOUCHER_BATCH_EVENTS),
      maxTabUsdc: MAX_TAB_USDC,
    },
    mux: mux.stats(),
  });
});

// ── Streaming endpoint ─────────────────────────────────────────────────
//
// SSE per buyer-account pair. The Tab middleware sits in front. The first
// request on a session does the on-chain registration check; subsequent
// vouchers verify in-memory. The relay batches events per cadence; the
// SDK's openSse helper handles the actual response framing + metering.

const sellerMiddleware = tabMiddleware({
  connection,
  sellerPubkey: seller.publicKey,
  network: 'solana:mainnet',
  // perUnit is the price per ONE event. The relay batches multiple events
  // per SSE chunk and meter.charge(batchSize) charges accordingly.
  perUnit: EVENT_PRICE_USDC,
  // Settle on tab close — the common case. Periodic settlement is a
  // different demo entirely.
  settle: 'on-close',
});

app.get('/stream/:account', sellerMiddleware, async (req: Request, res: Response) => {
  const tab = requireTab(req);
  const account = req.params.account;

  // Validate the account is a real pubkey before subscribing.
  try {
    new PublicKey(account);
  } catch {
    res.status(400).json({ error: 'invalid account pubkey' });
    return;
  }

  // Hand the response to the SDK's SSE helper. The meter enforces the
  // voucher cumulative-amount invariant via charge() before each send().
  const meter = openSse(res, { tab, perUnit: EVENT_PRICE_USDC });

  // Per-connection voucher-window state.
  let pending: ChainEvent[] = [];
  let lastEmit = Date.now();
  let stopped = false;

  const flush = async () => {
    if (stopped || pending.length === 0) return;
    const batch = pending;
    pending = [];
    lastEmit = Date.now();
    try {
      // charge() may throw if the buyer's voucher cumulative hasn't kept up.
      await meter.charge(batch.length);
      meter.send(JSON.stringify({ events: batch, channelId: tab.channelId }));
    } catch (err) {
      // Most likely cause: buyer fell behind on vouchers. Close the stream.
      console.warn(`[live-chain] meter.charge failed for ${tab.channelId}:`, err);
      stopped = true;
      meter.end();
    }
  };

  const periodic = setInterval(() => {
    if (Date.now() - lastEmit >= VOUCHER_BATCH_MS) void flush();
  }, Math.max(50, Math.floor(VOUCHER_BATCH_MS / 2)));

  // Register listener on the mux. The relay multiplexes from ONE Laserstream
  // subscription per account, no matter how many buyers are connected.
  const unsubscribe = mux.subscribeAccount(account, tab.channelId, (event) => {
    if (stopped) return;
    pending.push(event);
    if (pending.length >= VOUCHER_BATCH_EVENTS) void flush();
  });

  req.on('close', () => {
    stopped = true;
    clearInterval(periodic);
    unsubscribe();
    meter.end();
  });
});

// ── Helpers ────────────────────────────────────────────────────────────

function humanMul(humanAmount: string, count: number): string {
  // Multiply a 6-decimal human amount by an integer count, returning the
  // human form. Cheap arithmetic that avoids importing the SDK's helpers.
  if (!/^\d+(\.\d+)?$/.test(humanAmount)) return '0';
  const [whole, frac = ''] = humanAmount.split('.');
  const padded = `${whole}${frac.padEnd(6, '0')}`.replace(/^0+(?=\d)/, '') || '0';
  const product = (BigInt(padded) * BigInt(count)).toString().padStart(7, '0');
  const w = product.slice(0, -6).replace(/^0+(?=\d)/, '') || '0';
  const f = product.slice(-6).replace(/0+$/, '');
  return f ? `${w}.${f}` : w;
}

// ── Start ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[live-chain-relay] up on :${PORT}`);
  console.log(`  seller: ${seller.publicKey.toBase58()}`);
  console.log(`  cadence: every ${VOUCHER_BATCH_EVENTS} events OR ${VOUCHER_BATCH_MS}ms`);
  console.log(`  pricing: ${EVENT_PRICE_USDC} USDC/event, max tab ${MAX_TAB_USDC} USDC`);
});
