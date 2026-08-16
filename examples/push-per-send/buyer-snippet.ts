/**
 * BUYER SNIPPET for push-per-send — three stages, pick with an argument:
 *
 *   npx tsx buyer-snippet.ts discover   # free: read the 402 offer + terms
 *   npx tsx buyer-snippet.ts oneshot    # pay $0.01 once via payAndFetch (exact rail)
 *   npx tsx buyer-snippet.ts tab        # open a hard-capped tab, page 3x, settle on close
 *   npx tsx buyer-snippet.ts            # all of the above, skipping what lacks credentials
 *
 * discover needs nothing. oneshot needs a Solana keypair holding a little
 * USDC + SOL (BUYER_SOLANA_SECRET_KEY; without it an unfunded throwaway key
 * is used so you can watch the failure shape). tab needs a Dexter Vault
 * (VAULT_* + FEE_PAYER_SECRET_KEY below) — that is the rail built for agents:
 * the vault owner authorizes a session with a TOTAL cap, and no matter how
 * excited the agent gets, it cannot page past that cap.
 */
import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { fetchPasskeyAuthorizationState } from '@dexterai/vault';
import { DEXTER_VAULT_PROGRAM_ID } from '@dexterai/vault/constants';
import { createKeypairWallet, payAndFetch } from '@dexterai/x402/client';
import type { PayResult } from '@dexterai/x402/client';
import {
  atomicToHuman,
  payUrlWithTab,
  resolveTabOffer,
  resolveTabTerms,
  type Tab,
} from '@dexterai/x402/tab';
import {
  createSolanaVaultAdapter,
  passkeySignerFromP256Keypair,
} from '@dexterai/x402/tab/adapters/solana';
import { createManagedReservationProvider } from './native-tab-v2.js';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:4880/send';
const RPC_URL =
  process.env.SOLANA_RPC_ENDPOINT ||
  process.env.HELIUS_RPC_URL ||
  'https://api.mainnet-beta.solana.com';

// What the page says. PAGE_TO must be a real destination before you pay:
// a Telegram chat id for channel 'telegram', an email address for 'email'.
const PAGE_CHANNEL = (process.env.PAGE_CHANNEL || 'telegram') as 'telegram' | 'email';
const PAGE_TO = process.env.PAGE_TO || 'REPLACE_WITH_YOUR_CHAT_ID';
const PAGE_MESSAGE = process.env.PAGE_MESSAGE || 'Paged you from the push-per-send example.';

// POST /send body — the same init is used for discovery and for payment.
function sendInit(message: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: PAGE_CHANNEL, to: PAGE_TO, message }),
  };
}

function describePayResult(result: PayResult): string {
  if (result.ok && result.paid) {
    return `PAID ${result.amountPaid} atomic on ${JSON.stringify(result.network)}` +
      (result.txSignature ? ` (tx ${result.txSignature})` : '');
  }
  if (result.ok) return 'endpoint answered without requiring payment';
  return `NOT paid: ${result.reason}${result.detail ? ` — ${result.detail}` : ''}`;
}

// Accepts a base58 string or a solana-keygen style JSON array.
function keypairFromEnv(name: string): Keypair | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  // createKeypairWallet also takes base58 directly; for a raw Keypair we go
  // through the same JSON-array path users get from solana-keygen.
  throw new Error(`${name}: use a solana-keygen JSON array for this variable`);
}

// ── Stage 1: discovery (free — no wallet, no payment) ────────────────────────

async function discover(): Promise<void> {
  console.log(`\n── discover ── ${SERVER_URL}`);
  const offer = await resolveTabOffer(SERVER_URL, sendInit('(discovery probe)'));
  console.log(`offer kind: ${offer.kind}`);
  if (offer.kind === 'offer') {
    console.log(`  seller (payTo): ${offer.offer.payTo}`);
    console.log(`  network:        ${offer.offer.networkCaip2}`);
    console.log(
      `  per-send:       ${offer.offer.amountAtomic} atomic (${atomicToHuman(offer.offer.amountAtomic)} USDC)`,
    );
  }
  const terms = await resolveTabTerms(SERVER_URL, sendInit('(discovery probe)'));
  console.log(`terms kind: ${terms.kind}`);
  if (terms.kind === 'terms') {
    console.log(`  per-send:       $${terms.terms.perRequest.human} (${terms.terms.perRequest.atomic} atomic)`);
    console.log(`  settlement:     ${JSON.stringify(terms.terms.settlement)}`);
  }
}

// ── Stage 2: one-shot — payAndFetch pays the 'exact' rail ────────────────────

async function oneShot(): Promise<void> {
  console.log('\n── oneshot ── payAndFetch (exact rail, $0.01 settled up front)');
  const secret = process.env.BUYER_SOLANA_SECRET_KEY?.trim();
  if (!secret) {
    console.log('BUYER_SOLANA_SECRET_KEY not set: using an UNFUNDED throwaway key.');
    console.log('The request below will not pay — it shows the failure shape instead.');
  }
  const solana = secret
    ? await createKeypairWallet(secret.startsWith('[') ? JSON.parse(secret) : secret)
    : await createKeypairWallet(Array.from(Keypair.generate().secretKey));

  const result = await payAndFetch(
    SERVER_URL,
    sendInit(PAGE_MESSAGE),
    { solana },
    {
      // Budget guard: never let this call pay more than one penny.
      maxAmountAtomic: '10000',
      solanaRpcUrl: RPC_URL,
    },
  );
  console.log(describePayResult(result));
  if (result.ok && result.response) {
    console.log(`receipt: ${await result.response.text()}`);
  }
}

// ── Stage 3: tab — open once, page repeatedly, settle once ───────────────────

async function tabPath(): Promise<void> {
  console.log('\n── tab ── payUrlWithTab (tab rail: one session, many pages, one settle)');
  const swigAddress = process.env.VAULT_SWIG_ADDRESS;
  const vaultPda = process.env.VAULT_PDA;
  const passkeyPub = process.env.VAULT_PASSKEY_PUBLIC_KEY_B64;
  const passkeyPriv = process.env.VAULT_PASSKEY_PRIVATE_KEY_B64;
  const feePayer = keypairFromEnv('FEE_PAYER_SECRET_KEY');
  if (!swigAddress || !vaultPda || !passkeyPub || !passkeyPriv || !feePayer) {
    console.log('skipped: set VAULT_SWIG_ADDRESS, VAULT_PDA, VAULT_PASSKEY_PUBLIC_KEY_B64,');
    console.log('VAULT_PASSKEY_PRIVATE_KEY_B64 and FEE_PAYER_SECRET_KEY to run the tab rail.');
    console.log('(A Dexter Vault holds the funds; get one at https://dexter.cash.)');
    return;
  }

  const connection = new Connection(RPC_URL, 'confirmed');
  const vault = createSolanaVaultAdapter({
    connection,
    swigAddress,
    vaultPda,
    passkeySigner: passkeySignerFromP256Keypair({
      publicKey: Uint8Array.from(Buffer.from(passkeyPub, 'base64')),
      privateKey: Uint8Array.from(Buffer.from(passkeyPriv, 'base64')),
    }, {
      resolveAuthorizationContext: async () => {
        const authorization = await fetchPasskeyAuthorizationState(
          connection,
          new PublicKey(vaultPda),
        );
        if (!authorization) throw new Error('passkey authorization unavailable');
        return {
          programId: DEXTER_VAULT_PROGRAM_ID,
          vault: authorization.vault,
          nonce: authorization.nonce,
        };
      },
    }),
    feePayer,
  });
  const reserveFinalVoucherV2 = createManagedReservationProvider();

  // The HARD CAP lives here: totalCap is the most this whole session can ever
  // spend, enforced on-chain — 25 pages at a penny each, then the tab is dry.
  const tabs = new Map<string, Tab>(); // reused across calls: open once, pay many
  let tab: Tab | null = null;
  try {
    for (let i = 1; i <= 3; i += 1) {
      const { result, tab: usedTab } = await payUrlWithTab(
        SERVER_URL,
        sendInit(`${PAGE_MESSAGE} (page ${i}/3)`),
        {
          vault,
          perUnitCap: '0.01',
          totalCap: '0.25',
          sessionDuration: 900,
          tabs,
          reserveFinalVoucherV2,
        },
      );
      tab = usedTab ?? tab;
      console.log(`page ${i}: ${describePayResult(result)}`);
      if (!result.ok) break;
    }
  } finally {
    // ALWAYS close: vouchers are bearer claims — settle what was signed and
    // revoke the session, even after a failed page.
    if (tab) {
      const closed = await tab.close();
      console.log(`tab closed: settled ${closed.settledAmount} USDC, settle tx ${closed.settleTx}`);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

const stage = process.argv[2] || 'all';
try {
  if (stage === 'discover' || stage === 'all') await discover();
  if (stage === 'oneshot' || stage === 'all') await oneShot();
  if (stage === 'tab' || stage === 'all') await tabPath();
} catch (err) {
  console.error(`buyer snippet failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
