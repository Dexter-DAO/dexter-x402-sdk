/**
 * live-chain demo — buyer CLI.
 *
 * Opens a Tab against the relay. Inside the tab, calls tab.stream() in a
 * loop — each call buys ONE perUnitCap-sized budget and streams events
 * until that budget is exhausted (the relay closes the SSE cleanly), then
 * the loop buys another round until totalCap or until the user hits
 * Ctrl+C.
 *
 * On SIGINT, closes the tab. Since `@dexterai/x402@3.10.0`, `tab.close()`
 * POSTs the final session-signed voucher to the facilitator's
 * `POST /tab/settle` endpoint — the on-chain settle (USDC swig → seller
 * ATA + `vault.active_session.spent` advance + `pending_voucher_count`
 * decrement, atomic) lands BEFORE the session revoke. The Solscan link
 * printed at the end is the real settlement tx.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Connection, Keypair } from '@solana/web3.js';

import { openTab } from '@dexterai/x402/tab';
import {
  createSolanaVaultAdapter,
  passkeySignerFromP256Keypair,
} from '@dexterai/x402/tab/adapters/solana';

// Mirror of the SDK's internal P256Keypair shape.
interface P256Keypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

// ── Env ────────────────────────────────────────────────────────────────

const RELAY_URL = required('RELAY_URL');
const SELLER_PUBKEY = required('SELLER_PUBKEY');
const SOLANA_RPC_URL = required('SOLANA_RPC_URL');
const BUYER_SWIG = required('BUYER_SWIG');
const BUYER_VAULT_PDA = required('BUYER_VAULT_PDA');
const PASSKEY_KEY_FILE = required('PASSKEY_KEY_FILE');
const FEE_PAYER_KEY_FILE = required('FEE_PAYER_KEY_FILE');
const PER_BATCH_CAP_USDC = process.env.PER_BATCH_CAP_USDC ?? '0.01';
const TOTAL_TAB_CAP_USDC = process.env.TOTAL_TAB_CAP_USDC ?? '0.50';
const WATCH_ACCOUNT = required('WATCH_ACCOUNT');
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? undefined;

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`required env var missing: ${name}`);
    process.exit(1);
  }
  return v;
}

// ── Wiring ─────────────────────────────────────────────────────────────

const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

interface CredentialFile {
  passkeyPublicKeyBase64: string;
  passkeyPrivateKeyBase64: string;
}
const credential: CredentialFile = JSON.parse(readFileSync(PASSKEY_KEY_FILE, 'utf8'));
const passkeyKp: P256Keypair = {
  publicKey: Uint8Array.from(Buffer.from(credential.passkeyPublicKeyBase64, 'base64')),
  privateKey: Uint8Array.from(Buffer.from(credential.passkeyPrivateKeyBase64, 'base64')),
};
const passkeySigner = passkeySignerFromP256Keypair(passkeyKp);

const feePayer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(FEE_PAYER_KEY_FILE, 'utf8'))),
);

const vault = createSolanaVaultAdapter({
  connection,
  swigAddress: BUYER_SWIG,
  vaultPda: BUYER_VAULT_PDA,
  passkeySigner,
  feePayer,
});

// ── Open the tab ───────────────────────────────────────────────────────

console.log('opening tab against', RELAY_URL);
console.log('  buyer vault:    ', BUYER_VAULT_PDA);
console.log('  seller:         ', SELLER_PUBKEY);
console.log('  watching account:', WATCH_ACCOUNT);
console.log('  per-batch cap:  ', PER_BATCH_CAP_USDC, 'USDC');
console.log('  total cap:      ', TOTAL_TAB_CAP_USDC, 'USDC');
console.log('');

const tab = await openTab({
  vault,
  network: 'solana:mainnet',
  seller: SELLER_PUBKEY,
  perUnitCap: PER_BATCH_CAP_USDC,
  totalCap: TOTAL_TAB_CAP_USDC,
  ...(FACILITATOR_URL ? { facilitatorUrl: FACILITATOR_URL } : {}),
});

console.log('tab open. channel id:', tab.channelId);
console.log('streaming. Ctrl+C to close + settle.');
console.log('');

// ── Streaming loop ─────────────────────────────────────────────────────
//
// Each tab.stream() call buys ONE per-batch budget. When the relay
// exhausts that budget it ends the SSE cleanly, the iterator completes,
// and we loop to buy another round. Loop terminates when SIGINT closes
// the tab or totalCap is reached.

let totalEvents = 0;
let rounds = 0;
let shuttingDown = false;

const streamUrl = `${RELAY_URL}/stream/${encodeURIComponent(WATCH_ACCOUNT)}`;

(async () => {
  while (!shuttingDown) {
    rounds++;
    let roundEvents = 0;
    try {
      const stream = await tab.stream(streamUrl, { method: 'GET' });
      for await (const chunk of stream) {
        // The SDK's decodeSseChunks already unwrapped the SSE framing —
        // chunk is the raw `data:` payload as bytes. Our relay sends JSON.
        const text = new TextDecoder().decode(chunk);
        try {
          const parsed = JSON.parse(text);
          if (parsed.event) {
            totalEvents++;
            roundEvents++;
            const slot = parsed.event.slot;
            const sig = parsed.event.signature.slice(0, 12) + '…';
            process.stdout.write(
              `\r  round ${rounds.toString().padStart(2)} · ` +
              `${totalEvents.toString().padStart(5)} events · ` +
              `slot ${slot} · ${sig}      `,
            );
          }
        } catch {
          // Non-JSON frame (e.g. SDK's end-event payload) — ignore.
        }
      }
      // Stream ended cleanly (budget exhausted server-side). Loop for
      // another round.
      if (!shuttingDown) {
        process.stdout.write(`\n  round ${rounds} done (${roundEvents} events). buying next round…\n`);
      }
    } catch (err) {
      if (shuttingDown) break;
      console.error(`\n  stream round ${rounds} errored:`, (err as Error).message);
      // Try once more after a short pause; could be a transient RPC blip.
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
})();

// ── Clean shutdown ─────────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\n\nclosing tab + settling…');
  shuttingDown = true;
  try {
    const result = await tab.close();
    console.log('  total settled:', result.settledAmount, 'USDC');
    console.log('  events received:', totalEvents);
    console.log('  rounds completed:', rounds);
    if (result.settleTx) {
      console.log('  settle tx:', result.settleTx);
      console.log('  solscan:  ', `https://solscan.io/tx/${result.settleTx}`);
    } else {
      console.log('  (no voucher was signed — nothing to settle, session revoked only)');
    }
  } catch (err) {
    console.error('  close failed:', err);
    process.exitCode = 1;
  }
  process.exit(0);
});
