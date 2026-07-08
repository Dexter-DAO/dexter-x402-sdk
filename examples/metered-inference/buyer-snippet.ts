/**
 * Buyer side of the metered-inference demo. Three modes:
 *
 *   npx tsx buyer-snippet.ts discover                 # no wallet needed:
 *       probe the endpoint, print the tab offer parsed from the 402
 *
 *   npx tsx buyer-snippet.ts oneshot "your prompt"    # exact rail:
 *       payAndFetch pays the flat sticker price ($0.01) in one shot.
 *       Needs SOLANA_PRIVATE_KEY (base58) holding USDC; without it an
 *       ephemeral keypair is generated so you can watch the payment path
 *       fail cleanly with insufficient_funds.
 *
 *   npx tsx buyer-snippet.ts tab "your prompt"        # tab rail:
 *       open a tab, stream the completion token-by-token while the meter
 *       ticks, then close -> ONE on-chain settle for exactly the tokens
 *       served. Needs a funded Swig vault (BUYER_SWIG, BUYER_VAULT_PDA,
 *       PASSKEY_KEY_FILE, FEE_PAYER_KEY_FILE) — same credentials as
 *       examples/live-chain/demo-app.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

import { payAndFetch, createKeypairWallet } from '@dexterai/x402/client';
import { openTab, resolveTabOffer, atomicToHuman } from '@dexterai/x402/tab';
import {
  createSolanaVaultAdapter,
  passkeySignerFromP256Keypair,
} from '@dexterai/x402/tab/adapters/solana';
import { decodeFrame } from './sse-frame.js';

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:4021';
const COMPLETE_URL = `${SERVER_URL}/v1/complete`;
const RPC_URL =
  process.env.HELIUS_RPC_URL ??
  process.env.SOLANA_RPC_ENDPOINT ??
  'https://api.mainnet-beta.solana.com';

// Per-request budget the buyer will sign per tab.stream() call. Must cover
// the request's worst case: maxTokens x per-token price. 0.01 USDC = 1000
// tokens at the demo's 0.000010/token — the server's own ceiling.
const PER_REQUEST_CAP_USDC = process.env.PER_REQUEST_CAP_USDC ?? '0.01';
const TOTAL_TAB_CAP_USDC = process.env.TOTAL_TAB_CAP_USDC ?? '0.05';

const mode = process.argv[2] ?? 'discover';
const prompt = process.argv[3] ?? 'In one sentence: why do agents prefer tabs over prepaid balances?';

function requestInit(maxTokens: number): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, maxTokens }),
  };
}

// ── discover: read the offer out of the 402 (no wallet, no payment) ─────────

async function discover(): Promise<void> {
  const result = await resolveTabOffer(COMPLETE_URL, requestInit(256));
  if (result.kind !== 'offer') {
    console.error('no tab offer:', JSON.stringify(result));
    process.exitCode = 1;
    return;
  }
  const { offer } = result;
  console.log('tab offer resolved from 402:');
  console.log('  seller (payTo)  ', offer.payTo);
  console.log('  network (CAIP-2)', offer.networkCaip2);
  console.log('  asset           ', offer.asset);
  console.log('  sticker amount  ', offer.amountAtomic, 'atomic =', atomicToHuman(offer.amountAtomic), 'USDC per request');
  console.log('  resource        ', offer.resourceUrl ?? COMPLETE_URL);
  console.log('');
  console.log('the sticker is the flat exact-rail price; on the tab rail the');
  console.log('meter bills per output token actually served.');
}

// ── oneshot: exact rail via payAndFetch ─────────────────────────────────────

async function oneshot(): Promise<void> {
  let solana;
  if (process.env.SOLANA_PRIVATE_KEY) {
    solana = await createKeypairWallet(process.env.SOLANA_PRIVATE_KEY);
  } else {
    const ephemeral = Keypair.generate();
    console.log('SOLANA_PRIVATE_KEY not set — using an ephemeral unfunded keypair');
    console.log('(the payment attempt will fail with insufficient_funds; set a');
    console.log('funded key to actually buy the completion)');
    solana = await createKeypairWallet(bs58.encode(ephemeral.secretKey));
  }

  const result = await payAndFetch(COMPLETE_URL, requestInit(400), { solana }, {
    maxAmountAtomic: '10000', // refuse anything above the $0.01 sticker
    solanaRpcUrl: RPC_URL,
  });

  if (result.ok && result.paid) {
    const body = (await result.response?.json()) as {
      text: string;
      outputTokens: number;
      model: string;
    };
    console.log(`paid ${result.amountPaid} atomic via exact${result.txSignature ? ` (tx ${result.txSignature})` : ''}`);
    console.log(`model ${body.model} — ${body.outputTokens} output tokens`);
    console.log('');
    console.log(body.text);
  } else if (result.ok) {
    console.log('endpoint answered without demanding payment (unexpected here)');
  } else {
    console.error(`payAndFetch failed: ${result.reason}${result.detail ? ` — ${result.detail}` : ''}`);
    process.exitCode = 1;
  }
}

// ── tab: open a tab, stream tokens, close + settle ──────────────────────────

interface P256Keypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`tab mode needs env var ${name} (see .env.example; same Swig-vault`);
    console.error('credentials as examples/live-chain/demo-app)');
    process.exit(1);
  }
  return v;
}

async function tabStream(): Promise<void> {
  const BUYER_SWIG = required('BUYER_SWIG');
  const BUYER_VAULT_PDA = required('BUYER_VAULT_PDA');
  const PASSKEY_KEY_FILE = required('PASSKEY_KEY_FILE');
  const FEE_PAYER_KEY_FILE = required('FEE_PAYER_KEY_FILE');

  const connection = new Connection(RPC_URL, 'confirmed');
  const credential = JSON.parse(readFileSync(PASSKEY_KEY_FILE, 'utf8')) as {
    passkeyPublicKeyBase64: string;
    passkeyPrivateKeyBase64: string;
  };
  const passkeyKp: P256Keypair = {
    publicKey: Uint8Array.from(Buffer.from(credential.passkeyPublicKeyBase64, 'base64')),
    privateKey: Uint8Array.from(Buffer.from(credential.passkeyPrivateKeyBase64, 'base64')),
  };
  const feePayer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(FEE_PAYER_KEY_FILE, 'utf8')) as number[]),
  );

  const vault = createSolanaVaultAdapter({
    connection,
    swigAddress: BUYER_SWIG,
    vaultPda: BUYER_VAULT_PDA,
    passkeySigner: passkeySignerFromP256Keypair(passkeyKp),
    feePayer,
  });

  // Discover the seller from the 402 itself — never hardcode accepts[0]
  // assumptions; resolveTabOffer picks the tab-scheme entry.
  const offer = await resolveTabOffer(COMPLETE_URL, requestInit(256));
  if (offer.kind !== 'offer') {
    console.error('no tab offer:', JSON.stringify(offer));
    process.exit(1);
  }

  const tab = await openTab({
    vault,
    network: 'solana:mainnet',
    seller: offer.offer.payTo,
    perUnitCap: PER_REQUEST_CAP_USDC, // budget signed per stream() call
    totalCap: TOTAL_TAB_CAP_USDC,
    // facilitatorUrl omitted -> https://x402.dexter.cash
  });
  console.log('tab open. channel:', tab.channelId);
  console.log('');

  try {
    const stream = await tab.stream(COMPLETE_URL, requestInit(400));
    const decoder = new TextDecoder();
    let lastTicker = '';
    for await (const chunk of stream) {
      // SDK already unwrapped SSE framing; each chunk is one data: payload —
      // base64-wrapped JSON (`b64:...`), NOT raw JSON: the 5.3.1 SSE meter
      // corrupts raw JSON whose text contains "\n" (see sse-frame.ts), and
      // multi-line completions would be silently dropped here otherwise.
      const parsed = decodeFrame<{
        text?: string;
        tokensCharged?: number;
        usdcAccrued?: string;
        done?: boolean;
        outputTokens?: number;
        settledUsdc?: string;
      }>(decoder.decode(chunk));
      if (!parsed) continue; // not one of our frames
      if (parsed.done) {
        console.log('\n');
        console.log(`provider says ${parsed.outputTokens} output tokens; meter settled ${parsed.settledUsdc} USDC`);
      } else if (parsed.text !== undefined) {
        process.stdout.write(parsed.text);
        lastTicker = `${parsed.tokensCharged} tokens · ${parsed.usdcAccrued} USDC`;
      }
    }
    console.log(`meter ticker at end of stream: ${lastTicker}`);
  } finally {
    // ALWAYS close, even on stream failure — vouchers are bearer claims;
    // settle what was delivered and revoke the session.
    const result = await tab.close();
    console.log('');
    console.log('tab closed.');
    console.log('  settled:', result.settledAmount, 'USDC');
    if (result.settleTx) {
      console.log('  settle tx:', result.settleTx);
      console.log('  solscan:  ', `https://solscan.io/tx/${result.settleTx}`);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

switch (mode) {
  case 'discover':
    await discover();
    break;
  case 'oneshot':
    await oneshot();
    break;
  case 'tab':
    await tabStream();
    break;
  default:
    console.error(`unknown mode "${mode}" — use discover | oneshot | tab`);
    process.exit(1);
}
