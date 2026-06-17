/**
 * Proof-of-firstuse (Step 2b): a FRESH, counterfactual (un-activated) guest
 * vault gets its Swig ACTIVATED and then a spend-grant REGISTERED, in one
 * flow, driven by a SOFTWARE P-256 passkey — no human biometric, no
 * Windows Hello. This is the activate→register sequence the browser consent
 * screen (/tabs/new) runs when a vault's Swig isn't deployed yet, executed
 * end-to-end on mainnet and asserted on-chain. Re-runnable: fresh identity
 * every run (random 16-byte handle + fresh P-256 key), so it never collides
 * with a prior run and never traps the tester on one existing vault.
 *
 *   1. fresh software P-256 passkey + fresh guest handle
 *   2. enroll the credential (DB row, software SEC1 pubkey) + live /initialize
 *      → counterfactual vault, Swig NOT deployed
 *   3. assert Swig NOT deployed (status isActivated=false AND chain probe null)
 *   4. fund the receive address (Swig wallet PDA's USDC ATA) with a small
 *      amount from a local funder key so the grant cap ≤ vault balance
 *   5. ACTIVATE: live POST /warmup with a software-signed set_swig ceremony
 *      → assert the Swig account now exists on-chain
 *   6. REGISTER: live POST /grants/register (anon) with a software-signed
 *      188-byte session-register ceremony against the invited Tab Tick seller
 *   7. ASSERT: fetchSessionAccount shows the session live on-chain with the
 *      right counterparty + cap. PASS/FAIL with all tx sigs + the session.
 *
 * WHY a software key can drive this: the anon WebAuthn enrollment endpoint
 * (/api/passkey-anon/enroll/complete) verifies a REAL attestationObject and a
 * software key cannot forge one — so enrollment falls back to a direct
 * credential-row insert (the SEC1 pubkey is all the on-chain precompile ever
 * checks). Everything downstream — initialize, warmup, register — only ever
 * verifies a secp256r1 precompile signature over a known message plus a
 * challenge-hash match, which the software key produces identically to a real
 * passkey (passkey-noble.ts synthesizes the same clientDataJSON shape).
 *
 * Run: node scripts/proof-of-firstuse.mjs
 *   SOLANA_RPC_URL    write-capable RPC (else dexter-api/.env SOLANA_RPC_ENDPOINT)
 *   API_BASE          default https://api.dexter.cash
 *   FUND_USDC_ATOMIC  amount to seed the vault with (default: auto — min of
 *                     the funder's balance and 10000 = $0.01). The grant cap
 *                     is set to this so the on-chain overcommit gate passes.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';

import { p256 } from '@noble/curves/p256';
import { passkeySignerFromP256Keypair } from '@dexterai/x402/tab/adapters/solana';
import { sessionRegisterMessage, buildSetSwigOperationMessage } from '@dexterai/vault/messages';
import { fetchSessionAccount, isSessionLive } from '@dexterai/vault/session';
import { DEXTER_VAULT_PROGRAM_ID } from '@dexterai/vault/constants';

// `pg` lives in dexter-api's node_modules (this repo doesn't depend on it).
const apiRequire = createRequire('/home/branchmanager/websites/dexter-api/package.json');
const { Client } = apiRequire('pg');

// ── Config ─────────────────────────────────────────────────────────────────
const API_BASE = (process.env.API_BASE ?? 'https://api.dexter.cash').replace(/\/$/, '');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SELLER = new PublicKey('FKF63wLt122SLDNPBfpDgrMcQzxtdLfLyrUS1KziRR1h'); // invited Tab Tick seller
const FUND_CEILING = 10_000n; // $0.01 default seed/cap (kept tiny — USDC is scarce here)
const DEXTER_API_ENV = '/home/branchmanager/websites/dexter-api/.env';

// Candidate local funder keys, richest-first scan. The proof-of-loop seller
// holds a few cents; the upgrade-authority is the proofs' fee payer.
const FUNDER_CANDIDATES = [
  `${process.env.HOME}/.config/solana/dexter-proof-seller.json`,
  '/home/branchmanager/.config/solana/dexter-vault/upgrade-authority.json',
];

const log = (...a) => console.log('[firstuse]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (u8) => Buffer.from(u8).toString('base64');
const b64url = (u8) =>
  Buffer.from(u8).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function resolveRpcUrl() {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  const apiEnv = readFileSync(DEXTER_API_ENV, 'utf8');
  const m = apiEnv.match(/^SOLANA_RPC_ENDPOINT=(.+)$/m);
  if (!m) throw new Error('set SOLANA_RPC_URL to a write-capable Solana RPC');
  return m[1].trim();
}

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const apiEnv = readFileSync(DEXTER_API_ENV, 'utf8');
  const m = apiEnv.match(/^DATABASE_URL=(.+)$/m);
  if (!m) throw new Error('DATABASE_URL not found (set it or dexter-api/.env)');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

async function usdcBalance(conn, owner) {
  const ata = getAssociatedTokenAddressSync(USDC_MINT, owner, true);
  try { return BigInt((await conn.getTokenAccountBalance(ata)).value.amount); }
  catch { return null; }
}

let STEP = 'STEP 0 (preflight)';
const receipts = { startedAt: new Date().toISOString(), apiBase: API_BASE, seller: SELLER.toBase58() };

async function main() {
  const conn = new Connection(resolveRpcUrl(), 'confirmed');

  // ── STEP 0 — preflight: seller invited + a funder with USDC ────────────────
  STEP = 'STEP 0 (preflight)';
  log('═══ STEP 0 — preflight ═══');
  const invite = await getJson(`/api/passkey-vault/grants/invite-status?counterparty=${SELLER.toBase58()}`);
  if (invite.json?.invited !== true) {
    throw new Error(`seller ${SELLER.toBase58()} not invited — seed it before running (got ${JSON.stringify(invite.json)})`);
  }
  log('seller invited as:', invite.json.appName);

  // Scan the candidate keys: pick the richest USDC source as the transfer
  // AUTHORITY, and the richest SOL holder as the FEE PAYER + ATA-rent payer.
  // These can differ (e.g. the proof-seller holds USDC but no SOL).
  let usdcSrc = null; let usdcBal = -1n;
  let feePayer = null; let feeSol = -1;
  for (const p of FUNDER_CANDIDATES) {
    if (!existsSync(p)) continue;
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
    const bal = (await usdcBalance(conn, kp.publicKey)) ?? 0n;
    const sol = await conn.getBalance(kp.publicKey);
    log('funder candidate', kp.publicKey.toBase58(), '= USDC', bal, '/ SOL', (sol / 1e9).toFixed(4));
    if (bal > usdcBal) { usdcBal = bal; usdcSrc = kp; }
    if (sol > feeSol) { feeSol = sol; feePayer = kp; }
  }
  if (!usdcSrc || !feePayer) throw new Error('no local funder keypair found');

  const fundAmount = process.env.FUND_USDC_ATOMIC
    ? BigInt(process.env.FUND_USDC_ATOMIC)
    : (usdcBal < FUND_CEILING ? usdcBal : FUND_CEILING);
  if (fundAmount <= 0n || usdcBal < fundAmount) {
    throw new Error(
      `FUNDING BLOCKER: richest USDC source ${usdcSrc.publicKey.toBase58()} holds ${usdcBal} atomic, ` +
      `need ${fundAmount}. No local key holds enough USDC to seed the vault. ` +
      `Fund it (or set FUND_USDC_ATOMIC lower) and re-run.`,
    );
  }
  if (feeSol < 5_000_000) {
    throw new Error(
      `FUNDING BLOCKER: richest SOL key ${feePayer.publicKey.toBase58()} has only ${(feeSol / 1e9).toFixed(6)} SOL — ` +
      `not enough to pay fees + ATA rent (~0.002 SOL). Fund it and re-run.`,
    );
  }
  const funder = usdcSrc; // the transfer authority (signs the USDC debit)
  const funderBal = usdcBal;
  // The grant cap == funded amount so the on-chain overcommit gate is satisfied.
  const grantCap = fundAmount;
  log('USDC source    :', usdcSrc.publicKey.toBase58(), '(', usdcBal, 'atomic )');
  log('fee payer      :', feePayer.publicKey.toBase58(), '(', (feeSol / 1e9).toFixed(4), 'SOL )');
  log('will seed vault:', fundAmount, 'atomic USDC; grant cap =', grantCap);
  receipts.funder = funder.publicKey.toBase58();
  receipts.feePayer = feePayer.publicKey.toBase58();
  receipts.fundAmountAtomic = fundAmount.toString();
  receipts.grantCapAtomic = grantCap.toString();

  // ── STEP 1 — fresh software passkey + fresh guest handle ───────────────────
  STEP = 'STEP 1 (fresh identity)';
  log('═══ STEP 1 — fresh software passkey + guest handle ═══');
  const privateKey = p256.utils.randomPrivateKey();
  const publicKey = p256.getPublicKey(privateKey, true); // 33-byte SEC1 compressed
  const passkey = passkeySignerFromP256Keypair({ publicKey, privateKey });
  const userHandle = crypto.randomBytes(16); // fresh 16-byte identity each run
  const userHandleB64url = b64url(userHandle);
  const credentialId = `firstuse-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  log('user handle    :', userHandleB64url);
  log('credential id  :', credentialId);
  log('passkey pubkey :', b64(publicKey), '(SEC1 compressed)');
  receipts.userHandle = userHandleB64url;
  receipts.credentialId = credentialId;
  receipts.passkeyPublicKeyB64 = b64(publicKey);

  // ── STEP 2 — enroll credential row + counterfactual /initialize ────────────
  STEP = 'STEP 2 (enroll + initialize)';
  log('═══ STEP 2 — enroll software credential + counterfactual initialize ═══');
  // Supabase serves a cert chain that the new pg's default verify-full rejects.
  // Strip the sslmode hint from the URL and pass TLS explicitly (the connection
  // is to Supabase's managed DB — same trust posture dexter-api itself uses).
  const dbUrl = resolveDatabaseUrl().replace(/([?&])sslmode=[^&]*/i, '$1').replace(/[?&]$/, '');
  const db = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query(
      `INSERT INTO public.passkey_credentials
         (supabase_user_id, user_handle, credential_id, public_key,
          signature_count, transports, attestation_format, aaguid, user_agent, enroll_ip)
       VALUES (NULL, $1, $2, $3, 0, $4::jsonb, $5, NULL, $6, NULL)`,
      [
        Buffer.from(userHandle),
        credentialId,
        Buffer.from(publicKey),
        JSON.stringify([]),
        'software-p256', // attestation_format marks this a synthetic test credential
        'proof-of-firstuse',
      ],
    );
    log('credential row inserted (software-p256, no WebAuthn attestation — by design)');
  } finally {
    await db.end();
  }

  const init = await postJson('/api/passkey-vault-anon/initialize', {
    userHandle: userHandleB64url,
    credentialId,
  });
  if (init.status !== 200 || init.json?.state !== 'initialized') {
    throw new Error(`/initialize failed: ${init.status} ${JSON.stringify(init.json)}`);
  }
  const vaultPda = new PublicKey(init.json.vaultPda);
  const swigStateAddress = init.json.swigStateAddress; // == DB swig_address
  const receiveAddress = new PublicKey(init.json.receiveAddress); // Swig WALLET pda
  log('vault pda      :', vaultPda.toBase58());
  log('swig state     :', swigStateAddress, '(counterfactual — not deployed)');
  log('receive addr   :', receiveAddress.toBase58(), '(Swig wallet PDA = USDC ATA owner)');
  receipts.vaultPda = vaultPda.toBase58();
  receipts.swigStateAddress = swigStateAddress;
  receipts.receiveAddress = receiveAddress.toBase58();
  receipts.initializeTx = init.json.signature ?? null;

  // ── STEP 3 — assert Swig NOT deployed ──────────────────────────────────────
  STEP = 'STEP 3 (assert counterfactual)';
  log('═══ STEP 3 — assert the Swig is NOT deployed yet ═══');
  const status = await getJson(`/api/passkey-vault-anon/status?user_handle=${userHandleB64url}`);
  if (status.status !== 200 || !status.json?.vault) {
    throw new Error(`/status failed: ${status.status} ${JSON.stringify(status.json)}`);
  }
  const swigPk = new PublicKey(swigStateAddress);
  const swigBefore = await conn.getAccountInfo(swigPk);
  if (status.json.vault.isActivated !== false || swigBefore !== null) {
    throw new Error(
      `expected counterfactual (isActivated=false, swig absent) but got ` +
      `isActivated=${status.json.vault.isActivated}, swigAccount=${swigBefore ? 'PRESENT' : 'null'}`,
    );
  }
  log('CONFIRMED counterfactual: status.isActivated=false AND swig account absent on-chain ✓');
  receipts.preWarmup = { isActivated: false, swigAccountPresent: false };

  // ── STEP 4 — fund the receive address (Swig wallet ATA) ────────────────────
  STEP = 'STEP 4 (fund receive address)';
  log('═══ STEP 4 — fund the receive address with USDC ═══');
  const receiveAta = getAssociatedTokenAddressSync(USDC_MINT, receiveAddress, true);
  const funderAta = getAssociatedTokenAddressSync(USDC_MINT, funder.publicKey, true);
  // feePayer pays the tx fee + ATA rent; funder (USDC source) is the transfer
  // authority. They may be different keys, so both sign.
  const fundTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, receiveAta, receiveAddress, USDC_MINT),
    createTransferCheckedInstruction(funderAta, USDC_MINT, receiveAta, funder.publicKey, fundAmount, 6),
  );
  fundTx.feePayer = feePayer.publicKey;
  fundTx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  const fundSigners = funder.publicKey.equals(feePayer.publicKey) ? [funder] : [feePayer, funder];
  fundTx.sign(...fundSigners);
  const fundSig = await conn.sendRawTransaction(fundTx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(fundSig, 'confirmed');
  // Poll the balance (read-replica lag after a write).
  let vaultBal = 0n;
  for (let i = 0; i < 20 && vaultBal < fundAmount; i++) {
    vaultBal = (await usdcBalance(conn, receiveAddress)) ?? 0n;
    if (vaultBal < fundAmount) await sleep(1500);
  }
  if (vaultBal < fundAmount) throw new Error(`vault USDC ${vaultBal} < seeded ${fundAmount} after funding`);
  log('funded ✓ tx', fundSig, '| vault USDC balance now', vaultBal, 'atomic');
  receipts.fundTx = fundSig;
  receipts.vaultUsdcBalance = vaultBal.toString();

  // ── STEP 5 — ACTIVATE via live /warmup (software-signed set_swig) ──────────
  STEP = 'STEP 5 (activate / warmup)';
  log('═══ STEP 5 — ACTIVATE: deploy the Swig via /warmup (set_swig) ═══');
  const setSwigMsg = buildSetSwigOperationMessage(swigStateAddress);
  const setSwigCeremony = await passkey.signOperation(setSwigMsg);
  const warmup = await postJson('/api/passkey-vault-anon/warmup', {
    userHandle: userHandleB64url,
    setSwig: {
      clientDataJSON: b64(setSwigCeremony.clientDataJSON),
      authenticatorData: b64(setSwigCeremony.authenticatorData),
      signature: b64(setSwigCeremony.signature),
    },
  });
  if (warmup.status !== 200 || !warmup.json?.swigAddress) {
    throw new Error(`/warmup failed: ${warmup.status} ${JSON.stringify(warmup.json)}`);
  }
  log('warmup response:', JSON.stringify(warmup.json));
  receipts.warmupTx = warmup.json.signature ?? null;
  receipts.warmupAlreadyActive = !!warmup.json.alreadyActive;

  // Assert the Swig account now exists on-chain (poll for visibility).
  let swigAfter = null;
  for (let i = 0; i < 25 && swigAfter === null; i++) {
    swigAfter = await conn.getAccountInfo(swigPk);
    if (swigAfter === null) await sleep(1500);
  }
  if (swigAfter === null) {
    throw new Error(`warmup reported success but Swig account ${swigStateAddress} is still absent on-chain`);
  }
  log('ACTIVATED ✓ Swig account now exists on-chain:', swigStateAddress,
      `(owner ${swigAfter.owner.toBase58().slice(0, 8)}…, ${swigAfter.data.length} bytes)`);
  receipts.swigDeployed = true;

  // ── STEP 6 — REGISTER a spend-grant (software-signed) ──────────────────────
  STEP = 'STEP 6 (register spend-grant)';
  log('═══ STEP 6 — REGISTER spend-grant against', SELLER.toBase58().slice(0, 8) + '… ═══');
  const sessionKp = Keypair.generate();                  // the ed25519 session key the grant authorizes
  const sessionPubkey = sessionKp.publicKey.toBytes();
  const nonce = Math.floor(Date.now() / 1000) >>> 0;     // u32; program doesn't enforce monotonicity
  const expiresAtUnix = Math.floor(Date.now() / 1000) + 7 * 86400; // +7 days
  const maxAmount = grantCap;
  const maxRevolving = grantCap;

  // The passkey signs the EXACT 188-byte session-register message the
  // sponsor endpoint rebuilds and challenge-checks (vaultGrants.ts step 4).
  const registerMsg = sessionRegisterMessage({
    programId: DEXTER_VAULT_PROGRAM_ID,
    vaultPda,
    sessionPubkey,
    maxAmount,
    expiresAt: BigInt(expiresAtUnix),
    allowedCounterparty: SELLER,
    nonce,
    maxRevolvingCapacity: maxRevolving,
  });
  const regCeremony = await passkey.signOperation(registerMsg);

  const register = await postJson('/api/passkey-vault-anon/grants/register', {
    userHandle: userHandleB64url,
    params: {
      counterparty: SELLER.toBase58(),
      sessionPubkey: new PublicKey(sessionPubkey).toBase58(),
      maxAmountAtomic: maxAmount.toString(),
      expiresAtUnix,
      nonce,
      maxRevolvingCapacityAtomic: maxRevolving.toString(),
    },
    signedPasskeyPayload: {
      clientDataJSON: b64(regCeremony.clientDataJSON),
      authenticatorData: b64(regCeremony.authenticatorData),
      signature: b64(regCeremony.signature),
    },
  });
  if (register.status !== 200 || !register.json?.registerTx) {
    throw new Error(`/grants/register failed: ${register.status} ${JSON.stringify(register.json)}`);
  }
  log('register response:', JSON.stringify(register.json));
  receipts.registerTx = register.json.registerTx;
  receipts.sessionPda = register.json.sessionPda;
  receipts.sessionPubkey = new PublicKey(sessionPubkey).toBase58();

  // ── STEP 7 — ASSERT the session is live on-chain ──────────────────────────
  STEP = 'STEP 7 (assert on-chain session)';
  log('═══ STEP 7 — ASSERT the session on-chain ═══');
  let state = null;
  for (let i = 0; i < 30; i++) {
    state = await fetchSessionAccount(conn, vaultPda, SELLER);
    if (state !== null && state.version !== 0) break;
    state = null;
    await sleep(2000);
  }
  if (state === null) throw new Error('session account never appeared on-chain for (vault, seller)');
  if (!isSessionLive(state)) throw new Error('session found but NOT live (expired / version 0)');

  const onchainCounterparty = state.session.allowedCounterparty;
  const onchainCap = state.session.maxAmount;
  const onchainSessionPubkey = new PublicKey(state.session.sessionPubkey).toBase58();
  if (onchainCounterparty !== SELLER.toBase58()) {
    throw new Error(`counterparty mismatch: on-chain ${onchainCounterparty} != seller ${SELLER.toBase58()}`);
  }
  if (onchainCap !== maxAmount) {
    throw new Error(`cap mismatch: on-chain ${onchainCap} != registered ${maxAmount}`);
  }
  if (onchainSessionPubkey !== new PublicKey(sessionPubkey).toBase58()) {
    throw new Error(`session pubkey mismatch: on-chain ${onchainSessionPubkey} != ours`);
  }
  log('ASSERTED ✓ live on-chain session: counterparty + cap + session pubkey all match');

  const sessionView = {
    sessionPda: state.address,
    counterparty: onchainCounterparty,
    sessionPubkey: onchainSessionPubkey,
    live: isSessionLive(state),
    maxAmount: onchainCap.toString(),
    spent: state.session.spent.toString(),
    currentOutstanding: state.session.currentOutstanding.toString(),
    maxRevolvingCapacity: state.session.maxRevolvingCapacity.toString(),
    expiresAt: state.session.expiresAt,
    nonce: state.session.nonce,
  };
  receipts.onchainSession = sessionView;
  receipts.result = 'PASS';
  receipts.finishedAt = new Date().toISOString();

  console.log('\n===== PROOF-OF-FIRSTUSE RESULT (STEP 2b: counterfactual activate→grant) =====');
  console.log('A FRESH counterfactual vault was ACTIVATED then a spend-grant REGISTERED,');
  console.log('end-to-end, driven by a SOFTWARE passkey — asserted live on-chain.\n');
  console.log(JSON.stringify({
    result: 'PASS',
    vaultPda: vaultPda.toBase58(),
    swigStateAddress,
    receiveAddress: receiveAddress.toBase58(),
    fundAmountAtomic: fundAmount.toString(),
    txSignatures: {
      initialize: receipts.initializeTx,
      fund: fundSig,
      warmup: receipts.warmupTx,
      register: receipts.registerTx,
    },
    warmupAlreadyActive: receipts.warmupAlreadyActive,
    onchainSession: sessionView,
  }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n[firstuse] FAILED at ${STEP}:`, e?.stack || e);
  receipts.result = `FAILED at ${STEP}`;
  receipts.error = String(e?.message ?? e);
  console.error('[firstuse] partial receipts:', JSON.stringify(receipts, null, 2));
  process.exit(1);
});
