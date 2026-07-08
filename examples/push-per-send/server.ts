/**
 * PUSH PER-SEND — your agent can page you. A penny a send, hard-capped.
 *
 * One Express route, POST /send, behind ONE payment middleware
 * (tabOrExactMiddleware from @dexterai/x402@^5.3.1). The same 402 challenge
 * advertises both rails:
 *
 *   scheme 'tab'   — an agent opens a non-custodial, freeze-protected tab,
 *                    pages you N times at $0.01 each, settles once on close.
 *                    The tab's totalCap is the hard cap: the agent can never
 *                    spend past what its owner authorized.
 *   scheme 'exact' — one-shot buyers pay $0.01 per request, settled up front.
 *
 * The server holds NO key material. SELLER_PAYTO is a receive-only pubkey;
 * USDC lands there and nothing in this process can move it.
 *
 * Delivery goes through the dexter-api internal notify relay
 * (POST {DEXTER_API_BASE}/api/internal/notify/push, X-Internal-Auth token) —
 * the same production notifier path dexter-api's own services use. Run with
 * DELIVERY_MODE=mock to try everything without that token, or swap the
 * deliver() function below for your own sender.
 */
import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { Connection } from '@solana/web3.js';
import {
  TAB_VOUCHER_HEADER,
  openSse,
  requireTab,
  tabOrExactMiddleware,
} from '@dexterai/x402/tab/seller';
import { atomicToHuman } from '@dexterai/x402/tab';
import type { X402Request } from '@dexterai/x402/server';

// ─── Config (env is for secrets + deploy knobs; defaults run out of the box) ──

const PORT = Number(process.env.PORT || 4880);

// Any Solana mainnet RPC. Used once per tab session (a registration read on
// open) — never on the 402 path, never per send. Use a real provider
// (e.g. Helius) in production; the public endpoint is fine to try.
const RPC_URL =
  process.env.SOLANA_RPC_ENDPOINT ||
  process.env.HELIUS_RPC_URL ||
  'https://api.mainnet-beta.solana.com';

// Where the USDC goes. Receive-only: no private key exists anywhere near this
// process. The default is Dexter's proven demo seller — replace it with YOUR
// payout pubkey before charging real buyers.
const SELLER_PAYTO =
  process.env.SELLER_PAYTO || 'FKF63wLt122SLDNPBfpDgrMcQzxtdLfLyrUS1KziRR1h';

// Delivery seam. 'live' calls the dexter-api relay; 'mock' logs the page and
// skips the network call so anyone can run the full payment flow locally.
const DELIVERY_MODE = (process.env.DELIVERY_MODE || 'live').toLowerCase();
const DEXTER_API_BASE = (process.env.DEXTER_API_BASE || 'https://api.dexter.cash').replace(/\/$/, '');
const DEXTER_INTERNAL_TOKEN = process.env.DEXTER_INTERNAL_TOKEN || '';

if (DELIVERY_MODE !== 'mock' && !DEXTER_INTERNAL_TOKEN) {
  console.error(
    'DEXTER_INTERNAL_TOKEN is required for live delivery (it authenticates the ' +
      'dexter-api notify relay). Set DELIVERY_MODE=mock to run without it.',
  );
  process.exit(1);
}

// ─── Pricing: integer USDC microunits, decided per request in the handler ────

// $0.01 = 10_000 microunits (USDC has 6 decimals). Integers only — no floats
// near money.
const PRICE_MICRO_PER_SEND = 10_000n;

/**
 * Per-request price, in integer USDC microunits. This example charges a flat
 * penny per send, but this function sees the validated body — vary the return
 * value here if e.g. email should cost more than telegram.
 *
 * Two prices exist on the tab rail: the middleware's perUnit is the STICKER
 * (what the 402 advertises), the meter's perUnit below is the BILL (what
 * charge() actually draws). Keep the sticker honest: one-shot 'exact' buyers
 * pay the sticker before your handler ever runs.
 */
function priceMicroFor(_body: SendBody): bigint {
  return PRICE_MICRO_PER_SEND;
}

const STICKER_HUMAN = atomicToHuman(PRICE_MICRO_PER_SEND.toString()); // '0.01'

// ─── Request shape ────────────────────────────────────────────────────────────

type SendChannel = 'telegram' | 'email';

interface SendBody {
  /** Where to page: 'telegram' or 'email'. */
  channel: SendChannel;
  /** Telegram chat id (for 'telegram') or email address (for 'email'). */
  to: string;
  /** The page text. Max 2000 chars. */
  message: string;
  /** Optional headline. Defaults to 'Your agent paged you'. */
  title?: string;
}

/**
 * Body validation, composed BEFORE the paywall so nobody ever pays for a
 * malformed request. One discovery-friendly carve-out: an UNPAID request (no
 * X-PAYMENT header, no tab voucher) falls through to the paywall even when
 * its body is invalid, so catalog probes and resolveTabOffer() always see the
 * standard 402 challenge. A request that carries payment credentials with a
 * bad body is rejected 400 here — before verification, before any charge.
 */
function validateSendBody(req: Request, res: Response, next: NextFunction): void {
  const problem = sendBodyProblem(req.body);
  if (!problem) {
    next();
    return;
  }
  const carriesPayment = Boolean(req.header('x-payment') || req.header(TAB_VOUCHER_HEADER));
  if (!carriesPayment) {
    next(); // let the paywall answer 402; the buyer fixes the body when it pays
    return;
  }
  res.status(400).json({ error: problem.error, hint: problem.hint });
}

function sendBodyProblem(raw: unknown): { error: string; hint: string } | null {
  const body = (raw ?? {}) as Partial<SendBody>;
  if (body.channel !== 'telegram' && body.channel !== 'email') {
    return { error: 'invalid_channel', hint: "channel must be 'telegram' or 'email'" };
  }
  if (typeof body.to !== 'string' || !body.to.trim()) {
    return { error: 'missing_to', hint: 'to = telegram chat id or email address' };
  }
  if (typeof body.message !== 'string' || !body.message.trim()) {
    return { error: 'missing_message', hint: 'message = the page text' };
  }
  if (body.message.length > 2000) {
    return { error: 'message_too_long', hint: 'message is capped at 2000 chars' };
  }
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 200)) {
    return { error: 'invalid_title', hint: 'title must be a string of at most 200 chars' };
  }
  return null;
}

// ─── Delivery seam ────────────────────────────────────────────────────────────

interface DeliveryOutcome {
  delivered: boolean;
  detail?: string;
}

/**
 * The one function to swap if you are not running Dexter's infrastructure.
 * The shipped default POSTs to dexter-api's internal notify relay, which fans
 * out through the production notifier (Telegram Bot API / SMTP) — this example
 * never hand-rolls a sender or touches bot tokens itself.
 */
async function deliver(body: SendBody): Promise<DeliveryOutcome> {
  const title = body.title?.trim() || 'Your agent paged you';
  if (DELIVERY_MODE === 'mock') {
    console.log(
      `[mock delivery] channel=${body.channel} to=${body.to} title=${JSON.stringify(title)} ` +
        `message=${JSON.stringify(body.message)}`,
    );
    return { delivered: true, detail: 'mock' };
  }
  try {
    const res = await fetch(`${DEXTER_API_BASE}/api/internal/notify/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Auth': DEXTER_INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        title,
        message: body.message,
        channels: [body.channel],
        ...(body.channel === 'telegram' ? { telegramChatId: body.to } : { emailTo: body.to }),
        tags: ['push-per-send'],
        metadata: { example: 'push-per-send' },
      }),
    });
    if (!res.ok) return { delivered: false, detail: `relay_http_${res.status}` };
    const out = (await res.json()) as { ok?: boolean; sent?: boolean };
    if (out.sent !== true) return { delivered: false, detail: 'relay_channel_refused' };
    return { delivered: true };
  } catch (err) {
    return { delivered: false, detail: `relay_unreachable: ${(err as Error).message}` };
  }
}

// ─── The paywall + the route ──────────────────────────────────────────────────

const connection = new Connection(RPC_URL, 'confirmed');

const paywall = tabOrExactMiddleware({
  connection,
  sellerPubkey: SELLER_PAYTO,
  network: 'solana:mainnet',
  perUnit: STICKER_HUMAN,
  description:
    'Page a human over Telegram or email. $0.01 per send. Tab-metered: open a ' +
    'non-custodial, hard-capped spend tab and page as you go, or pay one-shot.',
  // facilitatorUrl omitted -> SDK default https://x402.dexter.cash
  // lockCadence omitted ON PURPOSE: the facilitator owns crystallization
  // cadence. It is a risk dial, not a performance dial. Ship without it.
});

const app = express();
app.use(express.json({ limit: '16kb' }));

// Free description route so humans and crawlers can see the contract.
app.get('/', (_req, res) => {
  res.json({
    service: 'push-per-send',
    what: 'Your agent can page you. A penny a send, hard-capped by the tab.',
    endpoint: 'POST /send',
    body: { channel: "'telegram' | 'email'", to: 'chat id or email address', message: 'text (<=2000 chars)', title: 'optional headline' },
    priceMicroUsdc: PRICE_MICRO_PER_SEND.toString(),
    payTo: SELLER_PAYTO,
    rails: ['tab', 'exact'],
  });
});

// Express 4 does NOT route rejected async handlers to error middleware, and a
// bare throw can kill a whole process with no unhandledRejection hook. This
// example runs express@5 (which does forward rejections), but the try/catch
// stays so the pattern is safe to copy anywhere.
app.post('/send', validateSendBody, paywall, async (req: Request, res: Response) => {
  let sseOpen = false;
  try {
    const body = req.body as SendBody;
    const priceMicro = priceMicroFor(body);

    // ── Rail 1: exact. Payment was verified AND settled by the middleware
    // before this handler ran; deliver and hand back the receipt.
    const paid = (req as X402Request).x402;
    if (paid) {
      const outcome = await deliver(body);
      if (!outcome.delivered) {
        // The exact rail settles up front, so a delivery fault after payment
        // is on the seller to make right. Surface everything the buyer needs.
        res.status(502).json({
          error: 'delivery_failed',
          detail: outcome.detail,
          paidVia: 'exact',
          transaction: paid.transaction,
        });
        return;
      }
      res.json({
        ok: true,
        sent: true,
        channel: body.channel,
        paidVia: 'exact',
        priceMicroUsdc: priceMicro.toString(),
        transaction: paid.transaction,
      });
      return;
    }

    // ── Rail 2: tab. Work first, charge after (same order as the production
    // tab-demo route): a failed delivery costs the buyer nothing, and the
    // seller's exposure is bounded at one un-charged send per tab.
    const tab = requireTab(req);
    const outcome = await deliver(body);
    if (!outcome.delivered) {
      res.status(502).json({ error: 'delivery_failed', detail: outcome.detail });
      return;
    }
    // Per-request price goes on the METER (the bill), not the middleware (the
    // sticker). charge() fails closed: on cap/expiry/non-monotonic it throws
    // before anything is sent.
    const meter = openSse(res, { tab, perUnit: atomicToHuman(priceMicro.toString()) });
    sseOpen = true;
    await meter.charge(1);
    meter.send(
      JSON.stringify({
        ok: true,
        sent: true,
        channel: body.channel,
        paidVia: 'tab',
        priceMicroUsdc: priceMicro.toString(),
        channelId: tab.channelId,
        tabCumulativeUsdc: tab.cumulative(),
      }),
    );
    await meter.end();
  } catch (err) {
    console.error('[push-per-send] send failed:', (err as Error).message);
    if (sseOpen || res.headersSent) {
      res.end();
    } else {
      res.status(502).json({ error: 'send_failed', detail: (err as Error).message });
    }
  }
});

app.listen(PORT, () => {
  console.log(
    `push-per-send listening on :${PORT} — POST /send at $${STICKER_HUMAN}/send ` +
      `(payTo ${SELLER_PAYTO}, delivery=${DELIVERY_MODE})`,
  );
});
