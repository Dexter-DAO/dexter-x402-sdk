/**
 * Step-3c CONNECT proof: a human authorizes a tab against a service URL via
 * dexter.cash/tab/connect with ONE passkey tap, and the agent — holding ONLY
 * its ed25519 session secret (no vault credentials, no passkey, no
 * dexter-authority key) — pays the LIVE service and settles real USDC.
 *
 *   STEP 1  agent key + DEEP LINK printed (the human's whole job: click, read, tap)
 *   STEP 2  waitForSession: the grant lands on-chain carrying OUR session pubkey
 *   STEP 3  arm via the PUBLIC facilitator POST /tab/open (freeze protection)
 *   STEP 4  voucher signed by the session secret -> X-Tab-Voucher -> live route 200
 *   STEP 5  POST /tab/settle -> settleTx; poll session meter + seller USDC delta
 *   STEP 6  receipts JSON
 *
 * Run (ORCHESTRATOR ONLY — mainnet; Branch taps the passkey):
 *   node scripts/proof-of-connect.mjs --vault <vaultPda>
 *
 * Mechanics are the proven D1 harness (dexter-vault/tests/prove-leg2-e2e.ts)
 * per RESEARCH-step3c-spend-path-2026-06-12.md (R8): the 188-byte registration
 * is REBUILT from on-chain session state — no passkey signature is ever needed
 * by the spend path; the on-chain SessionAccount is the witness.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import crypto from 'node:crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

import { buildVoucherMessage, sessionRegisterMessage } from '@dexterai/vault/messages';
import { fetchSessionAccount, waitForSession, isSessionLive } from '@dexterai/vault/session';
import { readVaultFull } from '@dexterai/vault/reader';
import { DEXTER_VAULT_PROGRAM_ID } from '@dexterai/vault/constants';
import { NodeEd25519Signer } from '@dexterai/vault/signers/node';

// ── Constants (the LIVE service; nothing local) ─────────────────────────────
const TICK_URL = 'https://api.dexter.cash/api/x402/tab-demo/tick';
const SELLER = new PublicKey('FKF63wLt122SLDNPBfpDgrMcQzxtdLfLyrUS1KziRR1h'); // tab-demo counterparty
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'https://x402.dexter.cash';
const CONNECT_ORIGIN = process.env.CONNECT_ORIGIN ?? 'https://dexter.cash';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DELTA = 10_000n; // $0.01 — one tick; clears the 354-atomic floor AND the fee gate

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = join(SCRIPTS_DIR, 'receipts');
const DEFAULT_AGENT_KEY = join(homedir(), '.config/solana/dexter-connect-proof-agent.json');

const log = (...a) => console.log('[connect-proof]', ...a);

// ── Usage / args ─────────────────────────────────────────────────────────────
const USAGE = `proof-of-connect — Step-3c e2e: deep link -> human tap -> granted agent pays the live route

Usage: node scripts/proof-of-connect.mjs --vault <vaultPda> [options]

  --vault <pda>       REQUIRED. The human's vault PDA — MUST be the vault that
                      dexter.cash/tab shows for the identity that will approve
                      (a wrong vault strands a live grant and times out here).
  --agent-key <path>  ed25519 session keypair JSON array (default:
                      ${DEFAULT_AGENT_KEY}
                      — generated mode 600 if absent).
  --wait-mins <n>     Minutes to wait for the human passkey tap (default 10).
  --help              Print this and exit.

Env:
  SOLANA_RPC_URL    write-capable Solana RPC (else read from dexter-api/.env
                    SOLANA_RPC_ENDPOINT on the operator box — never hardcoded)
  FACILITATOR_URL   default ${FACILITATOR_URL}
  CONNECT_ORIGIN    default ${CONNECT_ORIGIN}

What it proves: the agent holds ONLY its session secret. Consent is one passkey
tap on ${CONNECT_ORIGIN}/tab/connect; spend + settle are real mainnet USDC
against ${TICK_URL}.`;

function parseArgs(argv) {
  const args = { agentKey: DEFAULT_AGENT_KEY, waitMins: 10, vault: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else if (a === '--vault') args.vault = argv[++i];
    else if (a === '--agent-key') args.agentKey = argv[++i];
    else if (a === '--wait-mins') args.waitMins = Number(argv[++i]);
    else { console.error(`unknown argument: ${a}\n\n${USAGE}`); process.exit(1); }
  }
  return args;
}

// Write-capable Solana RPC (this proof SENDS settle through the facilitator
// but the script itself only READS chain — same resolution as the other
// proofs for consistency). The key never lives in this repo: SOLANA_RPC_URL
// env wins, else read the operator box's dexter-api env. NEVER mainnet-beta.
function resolveRpcUrl() {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  const apiEnv = readFileSync('/home/branchmanager/websites/dexter-api/.env', 'utf8');
  const m = apiEnv.match(/^SOLANA_RPC_ENDPOINT=(.+)$/m);
  if (!m) throw new Error('set SOLANA_RPC_URL to a Solana RPC URL');
  return m[1].trim();
}

function loadOrCreateAgentKey(p) {
  if (existsSync(p)) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
    log('agent key: loaded existing', p);
    return kp;
  }
  const kp = Keypair.generate();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  log('agent key: GENERATED fresh (mode 600)', p);
  return kp;
}

// ── Receipts: accumulate + flush after every step (a crash keeps the trail) ──
const startedAt = new Date();
const RECEIPTS_FILE = join(
  RECEIPTS_DIR,
  `proof-of-connect-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`,
);
const receipts = { startedAt: startedAt.toISOString(), tickUrl: TICK_URL, facilitator: FACILITATOR_URL };
function receipt(key, value) {
  receipts[key] = value;
  mkdirSync(RECEIPTS_DIR, { recursive: true });
  writeFileSync(RECEIPTS_FILE, JSON.stringify(receipts, null, 2));
  log(`[receipt] ${key}:`, typeof value === 'string' ? value : JSON.stringify(value));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (bytes) => Buffer.from(bytes).toString('hex');

async function sellerUsdcBalance(conn, ata) {
  try { return BigInt((await conn.getTokenAccountBalance(ata)).value.amount); }
  catch { return null; }
}

let STEP = 'STEP 0 (preflight)';

async function main() {
  const args = parseArgs(process.argv);
  if (!args.vault) { console.error(`--vault is REQUIRED\n\n${USAGE}`); process.exit(1); }
  if (!Number.isFinite(args.waitMins) || args.waitMins <= 0) {
    throw new Error('--wait-mins must be a positive number');
  }
  const vaultPda = new PublicKey(args.vault);
  const conn = new Connection(resolveRpcUrl(), 'confirmed');

  // ───────────────────────────────────────────────────────────────────────────
  STEP = 'STEP 1 (agent key + deep link)';
  log('═══ STEP 1 — agent key + deep link ═══');
  const agent = loadOrCreateAgentKey(args.agentKey);
  const agentPubkey = agent.publicKey.toBase58();
  log('agent session pubkey:', agentPubkey, '(the ONLY secret the agent holds)');
  receipt('agentPubkey', agentPubkey);
  receipt('vaultPda', vaultPda.toBase58());

  // Preflight BEFORE asking for the human tap — a doomed run must not burn one.
  const vault = await readVaultFull(conn, vaultPda);
  if (!vault.exists) throw new Error(`vault ${vaultPda.toBase58()} does not exist on-chain`);
  if (!vault.swigAddress) throw new Error('vault has no swigAddress (not production-enrolled?)');
  // Settle does NOT create the seller ATA (R8 breaker 8) — verify it pre-exists.
  const sellerAta = getAssociatedTokenAddressSync(USDC_MINT, SELLER);
  const sellerBalAtStart = await sellerUsdcBalance(conn, sellerAta);
  if (sellerBalAtStart === null) {
    throw new Error(`seller USDC ATA ${sellerAta.toBase58()} does not exist — settle would strand`);
  }
  receipt('preflight', {
    swigAddress: vault.swigAddress,
    sellerAta: sellerAta.toBase58(),
    sellerUsdcAtStart: sellerBalAtStart.toString(),
  });

  // Aborted-prior-run trap (D1 lesson): if a live session for this (vault,
  // seller) ALREADY carries our pubkey, the wait would resolve instantly —
  // that is a real grant, just not a fresh tap. Say so honestly.
  const prior = await fetchSessionAccount(conn, vaultPda, SELLER);
  const priorIsOurs = prior !== null && prior.version !== 0
    && Buffer.from(prior.session.sessionPubkey).equals(agent.publicKey.toBuffer());
  receipt('grantPreexisting', priorIsOurs);
  if (prior !== null && prior.version !== 0 && !priorIsOurs) {
    log('NOTE: a live grant for another session key exists — approving will REPLACE it.');
  }

  const deepLink = `${CONNECT_ORIGIN}/tab/connect?url=${encodeURIComponent(TICK_URL)}&agent=${agentPubkey}`;
  receipt('deepLink', deepLink);
  console.log('\n════════════════════════ HUMAN STEP ════════════════════════');
  console.log(deepLink);
  console.log('═════════════════════════════════════════════════════════════');
  console.log('Open this link, review the terms, approve with your passkey.');
  console.log('Waiting for the grant on-chain…\n');

  // ───────────────────────────────────────────────────────────────────────────
  STEP = 'STEP 2 (wait for the grant on-chain)';
  log(`═══ STEP 2 — waiting up to ${args.waitMins} min for the sponsored register ═══`);
  if (priorIsOurs) log('(grant already live with our pubkey — resolving immediately, no tap needed)');
  const state = await waitForSession(conn, vaultPda, SELLER, {
    expectedSessionPubkey: agent.publicKey.toBytes(),
    timeoutMs: Math.round(args.waitMins * 60_000),
    pollIntervalMs: 5_000,
  });
  if (!isSessionLive(state.session)) throw new Error('session found but not live (expired?)');
  // The assertion that the deep link carried the key through the ENTIRE
  // ceremony: the on-chain session_pubkey IS our agent pubkey.
  if (!Buffer.from(state.session.sessionPubkey).equals(agent.publicKey.toBuffer())) {
    throw new Error('on-chain sessionPubkey != our agent pubkey — deep link did not carry the key');
  }
  receipt('grant', {
    sessionPda: state.address,
    cap: state.session.maxAmount.toString(),
    expiresAt: state.session.expiresAt,
    nonce: state.session.nonce,
    spent: state.session.spent.toString(),
    maxRevolvingCapacity: state.session.maxRevolvingCapacity.toString(),
  });
  log('grant LANDED — on-chain session_pubkey == our agent pubkey ✓');

  // ───────────────────────────────────────────────────────────────────────────
  STEP = 'STEP 3 (arm via facilitator /tab/open)';
  log('═══ STEP 3 — arm freeze protection via PUBLIC facilitator /tab/open ═══');
  const openRes = await fetch(`${FACILITATOR_URL}/tab/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      buyer_swig_address: vault.swigAddress,
      seller: SELLER.toBase58(),
      max_amount_atomic: DELTA.toString(),
      network: 'solana:mainnet',
    }),
  });
  const openBody = await openRes.json();
  receipt('arm', { status: openRes.status, body: openBody });
  // R8 breaker 5: failures come back HTTP 200 — the body is the truth.
  if (openRes.status !== 200 || openBody.success !== true) {
    throw new Error(`/tab/open did not arm: ${openRes.status} ${JSON.stringify(openBody)}`);
  }
  // The-poll-is-the-assertion: confirm the outstanding actually rose on-chain.
  {
    const deadline = Date.now() + 60_000;
    let s = await fetchSessionAccount(conn, vaultPda, SELLER);
    while ((s === null || s.session.currentOutstanding < DELTA) && Date.now() < deadline) {
      await sleep(2_000);
      s = await fetchSessionAccount(conn, vaultPda, SELLER);
    }
    if (s === null || s.session.currentOutstanding < DELTA) {
      throw new Error('armed per /tab/open but currentOutstanding never reached the arm amount');
    }
    receipt('outstandingAfterArm', s.session.currentOutstanding.toString());
  }
  log('armed ✓ tx:', openBody.signature);

  // ───────────────────────────────────────────────────────────────────────────
  STEP = 'STEP 4 (pay the live route with a session-signed voucher)';
  log('═══ STEP 4 — voucher -> X-Tab-Voucher -> GET the live route ═══');
  // Fresh read AFTER arming: cumulative MUST anchor to on-chain spent (R8 breaker 2).
  const fresh = await fetchSessionAccount(conn, vaultPda, SELLER);
  if (fresh === null || !isSessionLive(fresh.session)) throw new Error('session vanished before spend');
  const cumulative = fresh.session.spent + DELTA;
  const channelId = crypto.randomBytes(32); // FRESH per run — seller cache is keyed by channelId (R8 breaker 3)
  const sequenceNumber = 1;
  const voucherMsg = buildVoucherMessage(channelId, cumulative, sequenceNumber);
  const sessionSignature = await new NodeEd25519Signer(agent.secretKey).sign(voucherMsg);
  // Rebuild the 188-byte registration from LIVE on-chain values — no passkey
  // signature exists or is needed; the on-chain SessionAccount is the witness.
  const registration = sessionRegisterMessage({
    programId: DEXTER_VAULT_PROGRAM_ID,
    vaultPda,
    sessionPubkey: fresh.session.sessionPubkey,
    maxAmount: fresh.session.maxAmount,
    expiresAt: BigInt(fresh.session.expiresAt),
    allowedCounterparty: SELLER,
    nonce: fresh.session.nonce,
    maxRevolvingCapacity: fresh.session.maxRevolvingCapacity,
  });
  // Seller header fields are HEX ONLY (R8 breaker 4 — settle is flexible, this is not).
  const voucherHeader = Buffer.from(JSON.stringify({
    payload: {
      channelId: hex(channelId),
      cumulativeAmount: cumulative.toString(),
      sequenceNumber,
    },
    sessionPublicKey: hex(agent.publicKey.toBytes()),
    sessionRegistration: hex(registration),
    sessionSignature: hex(sessionSignature),
  })).toString('base64');

  const payRes = await fetch(TICK_URL, {
    method: 'GET',
    headers: { 'X-Tab-Voucher': voucherHeader },
  });
  const payBody = await payRes.text(); // SSE stream: data event(s) then `event: end`
  receipt('paid', { status: payRes.status, contentType: payRes.headers.get('content-type'), body: payBody.slice(0, 1000) });
  if (payRes.status !== 200) {
    throw new Error(`live route rejected the voucher: HTTP ${payRes.status} — ${payBody.slice(0, 500)}`);
  }
  // Parse the SSE data event and verify it is OUR tab on the TAB rail.
  const dataLine = payBody.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) throw new Error(`200 but no SSE data event in body: ${payBody.slice(0, 500)}`);
  const tick = JSON.parse(dataLine.slice(5).trim());
  if (tick.paidVia !== 'tab') throw new Error(`expected paidVia 'tab', got: ${JSON.stringify(tick)}`);
  if (tick.channelId && tick.channelId !== hex(channelId)) {
    throw new Error(`tick channelId ${tick.channelId} != ours ${hex(channelId)}`);
  }
  log('PAID ✓ the live route served the tick over the tab rail:');
  console.log(payBody.trim());

  // ───────────────────────────────────────────────────────────────────────────
  STEP = 'STEP 5 (settle real USDC via facilitator /tab/settle)';
  log('═══ STEP 5 — settle the voucher through the facilitator ═══');
  const sellerBefore = await sellerUsdcBalance(conn, sellerAta);
  const settleRes = await fetch(`${FACILITATOR_URL}/tab/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      network: SOLANA_MAINNET_CAIP2,
      channelId: Buffer.from(channelId).toString('base64'),
      cumulativeAmount: cumulative.toString(),
      sequenceNumber,
      sessionPublicKey: agent.publicKey.toBase58(),
      sessionSignature: Buffer.from(sessionSignature).toString('base64'),
      sessionRegistration: Buffer.from(registration).toString('base64'),
    }),
  });
  const settleBody = await settleRes.json();
  receipt('settle', { status: settleRes.status, body: settleBody });
  if (settleRes.status !== 200 || typeof settleBody.settleTx !== 'string') {
    throw new Error(`/tab/settle failed: ${settleRes.status} ${JSON.stringify(settleBody)}`);
  }
  log('settleTx:', settleBody.settleTx);

  // The-poll-is-the-assertion (never one-shot after a write — load-balanced RPC):
  // (a) the session meter advances to our cumulative…
  {
    const deadline = Date.now() + 90_000;
    let after = await fetchSessionAccount(conn, vaultPda, SELLER);
    while ((after === null || after.session.spent !== cumulative) && Date.now() < deadline) {
      await sleep(2_000);
      after = await fetchSessionAccount(conn, vaultPda, SELLER);
    }
    if (after === null || after.session.spent !== cumulative) {
      throw new Error(`session meter never advanced to ${cumulative} (last: ${after?.session.spent})`);
    }
    receipt('meterAfterSettle', {
      spent: after.session.spent.toString(),
      currentOutstanding: after.session.currentOutstanding.toString(),
    });
  }
  // …and (b) the seller's USDC ATA grows by the NET transfer (fee live since
  // 2026-06-11: seller receives gross − fee = transferAmount).
  const expectedDelta = BigInt(settleBody.transferAmount ?? settleBody.netAmount);
  {
    const deadline = Date.now() + 60_000;
    let sellerAfter = await sellerUsdcBalance(conn, sellerAta);
    while ((sellerAfter ?? 0n) - (sellerBefore ?? 0n) !== expectedDelta && Date.now() < deadline) {
      await sleep(2_000);
      sellerAfter = await sellerUsdcBalance(conn, sellerAta);
    }
    const delta = (sellerAfter ?? 0n) - (sellerBefore ?? 0n);
    receipt('sellerDelta', delta.toString());
    if (delta !== expectedDelta) {
      throw new Error(`seller USDC delta ${delta} != expected net ${expectedDelta}`);
    }
  }
  log('settled ✓ meter advanced AND seller USDC landed');

  // ───────────────────────────────────────────────────────────────────────────
  STEP = 'STEP 6 (receipts)';
  receipts.result = 'ALL GREEN';
  receipts.finishedAt = new Date().toISOString();
  receipt('summary', {
    deepLink: receipts.deepLink,
    grant: receipts.grant,
    armTx: openBody.signature,
    paidStatus: 200,
    settleTx: settleBody.settleTx,
    grossAmount: String(settleBody.grossAmount ?? ''),
    feeAmount: String(settleBody.feeAmount ?? ''),
    netAmount: String(settleBody.netAmount ?? ''),
    sellerDelta: receipts.sellerDelta,
  });

  console.log('\n===== PROOF-OF-CONNECT RESULT (STEP 3c) =====');
  console.log('One passkey tap on /tab/connect; the agent held ONLY its session secret.');
  console.log('Receipts:', RECEIPTS_FILE);
  console.log(JSON.stringify(receipts.summary, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n[connect-proof] FAILED at ${STEP}:`, e?.stack || e);
  try {
    receipts.result = `FAILED at ${STEP}`;
    receipts.error = String(e?.message ?? e);
    mkdirSync(RECEIPTS_DIR, { recursive: true });
    writeFileSync(RECEIPTS_FILE, JSON.stringify(receipts, null, 2));
    console.error('[connect-proof] partial receipts kept:', RECEIPTS_FILE);
  } catch { /* receipts are best-effort on the failure path */ }
  process.exit(1);
});
