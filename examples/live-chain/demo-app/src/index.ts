/**
 * live-chain demo — buyer CLI.
 *
 * Opens a Tab against the relay. Streams events. Prints a live ticker. On
 * SIGINT (Ctrl+C), closes the tab cleanly — settlement tx lands on mainnet
 * before the process exits.
 *
 * One process == one tab. Run multiple terminals to demo concurrent tabs
 * from the same vault (which is exactly what live-vault demonstrates at
 * its third panel).
 */

import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

import { openTab, humanToAtomic, atomicToHuman } from '@dexterai/x402/tab';
import {
  createSolanaVaultAdapter,
  passkeySignerFromP256Keypair,
} from '@dexterai/x402/tab/adapters/solana';

// Mirror of the SDK's internal P256Keypair shape. The SDK takes this shape
// in `passkeySignerFromP256Keypair`, but doesn't export the type — defined
// locally to keep the demo's import surface clean.
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

// Load the buyer's passkey (P-256). For this demo it's a software keypair
// from the scripted-enrollment harness. In the browser/iPhone path it would
// be a WebAuthn-backed signer; the adapter accepts both.
const passkeyKp: P256Keypair = JSON.parse(readFileSync(PASSKEY_KEY_FILE, 'utf8'));
const passkeySigner = passkeySignerFromP256Keypair({
  privateKey: Uint8Array.from(passkeyKp.privateKey),
  publicKey: Uint8Array.from(passkeyKp.publicKey),
});

// Load the fee payer (covers register/revoke gas, NOT settlement).
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
});

console.log('tab open. channel id:', tab.channelId);
console.log('streaming events. Ctrl+C to close + settle.');
console.log('');

// ── Stream + ticker ────────────────────────────────────────────────────

let totalEvents = 0;
let cumulativeAtomic = '0';

const stream = await tab.stream(`${RELAY_URL}/stream/${encodeURIComponent(WATCH_ACCOUNT)}`, {
  method: 'GET',
});

const decoder = new TextDecoder();
let buffer = '';

(async () => {
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    // SSE events are delimited by blank lines (\n\n). Pull complete frames.
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6)).join('');
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        const events = parsed.events as Array<{ signature: string; slot: number }>;
        totalEvents += events.length;
        // The Tab SDK manages cumulativeAtomic internally based on
        // per-batch metering from the seller. We mirror it locally for
        // the ticker.
        cumulativeAtomic = String(BigInt(humanToAtomic(PER_BATCH_CAP_USDC)) * BigInt(Math.ceil(totalEvents / 10)));
        process.stdout.write(
          `\r  ${totalEvents.toString().padStart(5)} events   ` +
          `${atomicToHuman(cumulativeAtomic)} USDC accrued   ` +
          `latest slot ${events.at(-1)?.slot ?? '—'}        `,
        );
      } catch (err) {
        console.error('\n[demo] failed to parse SSE frame:', err);
      }
    }
  }
})();

// ── Clean shutdown — close the tab + settle ────────────────────────────

process.on('SIGINT', async () => {
  console.log('\n\nclosing tab + settling…');
  try {
    const result = await tab.close();
    console.log('  total settled:', result.settledAmount, 'USDC');
    console.log('  settlement tx:', result.settleTx);
    if (result.settleTx) {
      console.log('  solscan:      ', `https://solscan.io/tx/${result.settleTx}`);
    }
  } catch (err) {
    console.error('  close failed:', err);
    process.exitCode = 1;
  }
  process.exit(0);
});
