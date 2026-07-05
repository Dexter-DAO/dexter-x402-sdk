/**
 * tabFromGrant — open a buyer-side Tab from a GRANTED session key.
 *
 * The `/tabs/connect` grant ceremony (@dexterai/vault/grant approveSpendGrant
 * + the sponsor's register endpoint) already did the passkey half of
 * `openTab`: the user consented, the 188-byte registration was passkey-signed,
 * and the sponsor landed the on-chain `register_session_key` tx. What the
 * requesting agent walks away with is exactly two artifacts:
 *
 *   1. the session SECRET (custody mode i: `approveSpendGrant().sessionKeypair`
 *      delivered to it; custody mode ii: it generated the keypair itself and
 *      only the pubkey went into the blob), and
 *   2. the consented `ApprovedSpendGrantParams`.
 *
 * This constructor rebuilds everything else from those two + the chain:
 *
 *   - the 188-byte registration message, byte-exact via the SAME
 *     `sessionRegisterMessage` builder the ceremony used (it rides every
 *     voucher; the seller re-parses it, so any drift = rejected vouchers)
 *   - the resume FRONTIER from the on-chain SessionAccount:
 *     `max(session.spent, session.crystallizedCumulative)` — the cumulative
 *     odometer starts there so the first voucher strictly exceeds everything
 *     the chain has already terminally counted. The chain is the durable
 *     counter; there is no local state store to lose.
 *   - drain-protection arming via the facilitator's `POST /tab/open`,
 *     fail-closed exactly like `openTab` (an unarmed tab is never returned)
 *
 * CUSTODY NOTE — why this constructor may hold a session secret when
 * `resumeTab` refuses to: the passkey path's "session keys are memory-only"
 * doctrine protects the ROOT credential flow. The grant path deliberately
 * relaxes it — the user consented (one passkey tap) to hand a CAPPED,
 * EXPIRING, SINGLE-COUNTERPARTY key to the requesting agent. Exposure is
 * bounded by the consented scope, and the wallet owner can revoke on their
 * own surfaces at any time.
 *
 * CLOSE SEMANTICS — `close()` on a grant tab is SETTLE-ONLY: it posts the
 * final voucher to `/tab/settle`, zeroes the in-memory key, and marks the tab
 * closed. It does NOT revoke the session on chain — revocation is
 * passkey-signed and the grant holder has no passkey. `TabCloseResult`
 * reports this honestly (`sessionRevoked: false`); the session PDA stays live
 * until the wallet owner revokes it or it expiry-sweeps.
 */

import nacl from 'tweetnacl';
import { Connection, PublicKey } from '@solana/web3.js';
import { bytesToHex } from '@noble/hashes/utils';

import type { ApprovedSpendGrantParams } from '@dexterai/vault/grant';
import { fetchSessionAccount, isSessionLive } from '@dexterai/vault/session';
import { readVaultFull } from '@dexterai/vault/reader';

import type {
  Tab,
  TabNetworkId,
  AtomicAmount,
  SessionScope,
  VaultAdapter,
} from './types';
import { sessionRegisterMessage } from './messages';
import { DEXTER_VAULT_PROGRAM_ID } from './instructions';
import {
  makeSessionKey,
  signVoucher,
  parseAtomic,
  deriveChannelId,
} from './sessions';
import { TabImpl, armTabOpen, DEFAULT_FACILITATOR_URL } from './tab';

// Re-exported so consumers can type their grant hand-off without importing
// @dexterai/vault directly.
export type { ApprovedSpendGrantParams };

/**
 * Options for `tabFromGrant`.
 *
 * CONCURRENCY WARNING (TOCTOU) — read this before holding ONE session key
 * across CONCURRENT spend paths: the resume frontier is read from the chain
 * ONCE, at construction. Concurrent holders of the same session key — or a
 * settle/lock racing that read — can make the frontier stale. The failure
 * mode is SAFE REJECTION, never overspend: the seller rejects
 * `non_monotonic` and the chain/facilitator reject `non_monotonic_cumulative`,
 * so a stale tab's vouchers bounce instead of double-spending. But consumers
 * that drive one session key from multiple concurrent spenders (the T4
 * anon/MCP rail is the canonical case) MUST serialize per
 * (vault, counterparty): one live tab per pair, one spend in flight at a time.
 */
export interface TabFromGrantOptions {
  /**
   * The granted session SECRET. Accepts the shapes the grant flow actually
   * produces: a 64-byte nacl `secretKey` (approveSpendGrant custody mode i,
   * or a requester-generated nacl keypair in custody mode ii), or —
   * defensively — a 32-byte ed25519 seed. Validated against
   * `params.sessionPubkey` with a sign/verify self-check before ANY I/O, so
   * a key handed across processes that doesn't actually sign for the granted
   * pubkey fails loudly here instead of as a seller/facilitator rejection.
   *
   * The constructor takes its own copy; the caller should zero their buffer.
   */
  sessionSecretKey: Uint8Array;
  /** The final consented grant values — `approveSpendGrant().params`, verbatim. */
  params: ApprovedSpendGrantParams;
  /** The USER's vault PDA (the grant blob never carries it; the consent page
   *  resolved it from the user's own identity — same value here). */
  vaultPda: string | PublicKey;
  /**
   * RPC for the on-chain reads (frontier + optional swig resolution): a
   * web3.js Connection or an RPC URL. REQUIRED — the SessionAccount is the
   * durable spend counter; there is no offline resume.
   */
  connection: Connection | string;
  /**
   * Max atomic amount a SINGLE voucher may add. REQUIRED and deliberately so:
   * every signed voucher is a bearer claim, so this cap is the blast radius
   * of one request against a misbehaving seller. Callers know their per-call
   * price; set it near that.
   */
  perUnitCapAtomic: AtomicAmount;
  /**
   * Seller URL used for channel-id derivation and `Tab.stream()` routing
   * context. Defaults to `params.counterparty` (matching openTab's Phase-2
   * pubkey-as-seller shape). Either way the tab's `counterparty` — the value
   * `payWithTab` matches against a tab-scheme accept's `payTo` — is ALWAYS
   * `params.counterparty`.
   */
  sellerUrl?: string;
  /**
   * The buyer's Swig STATE address (`vault.swig_address`) for the `/tab/open`
   * arming call. When omitted it is read from the on-chain vault account —
   * one extra RPC read, never a guess.
   */
  swigAddress?: string;
  /** Facilitator base URL. Default: DEFAULT_FACILITATOR_URL (https://x402.dexter.cash). */
  facilitatorUrl?: string;
  /** Vault program id override (test/devnet). Default: DEXTER_VAULT_PROGRAM_ID. */
  programId?: PublicKey;
}

const NETWORK: TabNetworkId = 'solana:mainnet';

/**
 * Construct a live `Tab` from a granted session key. Fail-loud at every step:
 * key/params mismatch, dead or drifted on-chain session, exhausted cap, and
 * unarmed drain protection all THROW — an invalid tab is never returned.
 */
export async function tabFromGrant(options: TabFromGrantOptions): Promise<Tab> {
  const facilitatorUrl = options.facilitatorUrl ?? DEFAULT_FACILITATOR_URL;
  const programId = options.programId ?? DEXTER_VAULT_PROGRAM_ID;
  const vaultPdaKey = new PublicKey(options.vaultPda);
  const counterpartyKey = new PublicKey(options.params.counterparty);

  const perUnitCapAtomic = parseAtomic(options.perUnitCapAtomic);
  if (perUnitCapAtomic <= 0n) {
    throw new Error(`perUnitCapAtomic must be > 0, got ${options.perUnitCapAtomic}`);
  }
  const totalCapAtomic = parseAtomic(options.params.maxAmountAtomic);
  const maxRevolvingCapacity = parseAtomic(options.params.maxRevolvingCapacityAtomic);

  // ── 1. Key ↔ params self-check, BEFORE any I/O ────────────────────────
  // Catches handed-across-process key mixups. Two layers:
  //  (a) derived pubkey must equal params.sessionPubkey;
  //  (b) a sign/verify probe — a corrupted 64-byte secret can carry the
  //      RIGHT pubkey in its [32..64) half while its seed half signs for
  //      something else entirely; only an actual signature exposes that.
  const keypair = keypairFromSecret(options.sessionSecretKey);
  const expectedPubkey = new PublicKey(options.params.sessionPubkey).toBytes();
  if (!bytesEqual(keypair.publicKey, expectedPubkey)) {
    throw new Error(
      'tab_session_key_mismatch: the supplied secret derives ' +
      `${new PublicKey(keypair.publicKey).toBase58()} but params.sessionPubkey is ` +
      `${options.params.sessionPubkey} — wrong key handed to this process`,
    );
  }
  const probe = nacl.randomBytes(32);
  const probeSig = nacl.sign.detached(probe, keypair.secretKey);
  if (!nacl.sign.detached.verify(probe, probeSig, expectedPubkey)) {
    throw new Error(
      'tab_session_key_mismatch: secret key failed the sign/verify self-check ' +
      'against params.sessionPubkey — the seed half does not sign for the granted pubkey',
    );
  }

  // ── 2. Rebuild the 188-byte registration, byte-exact ─────────────────
  // Same canonical builder the grant ceremony used; the seller re-parses
  // these bytes off every voucher, so this MUST reproduce them exactly.
  const registration = sessionRegisterMessage({
    programId,
    vaultPda: vaultPdaKey,
    sessionPubkey: keypair.publicKey,
    maxAmount: totalCapAtomic,
    expiresAt: BigInt(options.params.expiresAtUnix),
    allowedCounterparty: counterpartyKey,
    nonce: options.params.nonce,
    maxRevolvingCapacity,
  });

  // ── 3. On-chain SessionAccount: liveness + identity + FRONTIER ───────
  const connection =
    typeof options.connection === 'string'
      ? new Connection(options.connection, 'confirmed')
      : options.connection;

  const state = await fetchSessionAccount(connection, vaultPdaKey, counterpartyKey, programId);
  if (!state || state.version === 0) {
    throw new Error(
      'tab_session_not_live: no live SessionAccount PDA for this (vault, counterparty) — ' +
      'revoked, expiry-swept, or never registered',
    );
  }
  if (!isSessionLive(state)) {
    // isSessionLive = version === 1 AND unexpired. version 0 was handled
    // above; anything else here is either an expired v1 session or an
    // unsupported/unknown version — name it truthfully, still fail-closed.
    throw new Error(
      state.version !== 1
        ? `tab_session_not_live: SessionAccount has unsupported version ${state.version} — not a live v1 session`
        : `tab_session_not_live: SessionAccount is present but expired (expiresAt=${state.session.expiresAt})`,
    );
  }
  if (!bytesEqual(state.session.sessionPubkey, keypair.publicKey)) {
    throw new Error(
      'tab_session_pubkey_mismatch: the on-chain session carries ' +
      `${new PublicKey(state.session.sessionPubkey).toBase58()} — the grant this key ` +
      'belongs to was replaced by a newer registration',
    );
  }
  // The seller enforces the REGISTRATION's scope while the chain enforces its
  // own — if the params in hand drifted from the on-chain scope (a stale copy
  // after a re-register that reused the session pubkey), vouchers signed here
  // could pass the seller and then die at settle. Refuse to straddle.
  if (
    state.session.maxAmount !== totalCapAtomic ||
    state.session.expiresAt !== options.params.expiresAtUnix ||
    state.session.nonce !== options.params.nonce ||
    state.session.maxRevolvingCapacity !== maxRevolvingCapacity
  ) {
    throw new Error(
      'tab_grant_params_stale: params disagree with the on-chain session scope ' +
      `(chain: maxAmount=${state.session.maxAmount} expiresAt=${state.session.expiresAt} ` +
      `nonce=${state.session.nonce} revolving=${state.session.maxRevolvingCapacity}; ` +
      `params: ${options.params.maxAmountAtomic}/${options.params.expiresAtUnix}/` +
      `${options.params.nonce}/${options.params.maxRevolvingCapacityAtomic}) — ` +
      'refresh the grant hand-off',
    );
  }

  // The frontier: both terminal odometers the chain keeps. A voucher must
  // strictly exceed max(spent, crystallizedCumulative) to settle or lock —
  // starting the tab's cumulative here makes every voucher this tab signs
  // strictly monotonic over the chain's history by construction.
  const frontier =
    state.session.spent > state.session.crystallizedCumulative
      ? state.session.spent
      : state.session.crystallizedCumulative;
  if (frontier >= totalCapAtomic) {
    throw new Error(
      `tab_exhausted: on-chain frontier ${frontier} has consumed the session cap ` +
      `${totalCapAtomic} — no voucher can strictly exceed it; open a new grant`,
    );
  }

  // ── 4. Fresh channel id, exactly as openTab derives it ───────────────
  const sellerUrl = options.sellerUrl ?? options.params.counterparty;
  const nonce = BigInt(Math.floor(Math.random() * 0xffffffff));
  const channelIdBytes = deriveChannelId({
    vaultPda: vaultPdaKey,
    sellerUrl,
    nonce,
  });
  const channelIdHex = bytesToHex(channelIdBytes);

  // ── 5. Arm drain protection — fail-closed, same as openTab ───────────
  let swigAddress = options.swigAddress;
  if (!swigAddress) {
    const vaultFull = await readVaultFull(connection, vaultPdaKey);
    if (!vaultFull.exists || !vaultFull.swigAddress) {
      throw new Error(
        `tab_vault_unreadable: vault ${vaultPdaKey.toBase58()} has no readable ` +
        'swig_address on chain — pass options.swigAddress explicitly',
      );
    }
    swigAddress = vaultFull.swigAddress;
  }
  await armTabOpen(facilitatorUrl, swigAddress, totalCapAtomic, NETWORK, options.params.counterparty);

  // ── 6. Assemble the Tab ───────────────────────────────────────────────
  const scope: SessionScope = {
    channelId: channelIdHex,
    maxAmountAtomic: options.params.maxAmountAtomic,
    revolvingCapacityAtomic: options.params.maxRevolvingCapacityAtomic,
    expiresAtUnix: options.params.expiresAtUnix,
    allowedCounterparty: options.params.counterparty,
  };
  const session = makeSessionKey(
    { publicKey: keypair.publicKey, privateKey: keypair.secretKey },
    scope,
    registration,
  );

  // Grant-scoped adapter: voucher signing is pure local nacl; the two
  // passkey-locked verbs THROW loudly — nothing in this construction path
  // calls them ('settle-only' close never invokes signCloseTab), and any
  // future caller that does must hear "no passkey here", not a silent no-op.
  const vault: VaultAdapter = {
    network: NETWORK,
    swigAddress,
    vaultPda: vaultPdaKey.toBase58(),
    authorizeSession: async () => {
      throw new Error(
        'grant_tab_no_passkey: a grant-held tab cannot authorize sessions — ' +
        'session birth requires the wallet owner\'s passkey ceremony',
      );
    },
    signWithSession: async (s, payload) => signVoucher(s, payload, channelIdBytes),
    signOpenTab: async (s) => s.registration,
    signCloseTab: async () => {
      throw new Error(
        'grant_tab_cannot_revoke: session revocation is passkey-signed and belongs ' +
        'to the wallet owner\'s surfaces — a grant-held tab closes settle-only',
      );
    },
  };

  return new TabImpl({
    vault,
    network: NETWORK,
    seller: sellerUrl,
    counterparty: options.params.counterparty,
    session,
    channelIdHex,
    channelIdBytes,
    perUnitCapAtomic,
    totalCapAtomic,
    expiresAtUnix: options.params.expiresAtUnix,
    facilitatorUrl,
    initialCumulativeAtomic: frontier,
    closeMode: 'settle-only',
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Normalize the granted secret to a nacl keypair (own copy — zeroing the
 *  tab never zeroes the caller's buffer, and vice versa). */
function keypairFromSecret(secret: Uint8Array): nacl.SignKeyPair {
  if (secret.length === 64) return nacl.sign.keyPair.fromSecretKey(secret);
  if (secret.length === 32) return nacl.sign.keyPair.fromSeed(secret);
  throw new Error(
    `tab_session_key_invalid: expected a 64-byte nacl secretKey or a 32-byte ` +
    `ed25519 seed, got ${secret.length} bytes`,
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
