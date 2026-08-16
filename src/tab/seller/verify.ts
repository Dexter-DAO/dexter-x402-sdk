/**
 * Local voucher verification for the seller side of OTS tab streaming.
 *
 * Two-layer verification:
 *
 *   1. parseRegistration(registrationBytes)
 *      Parses the 188-byte V2 registration message into a scope. Synchronous,
 *      no I/O. This gives the seller everything they need to enforce limits
 *      LOCALLY (cap, expiry, counterparty) and to know which vault to read
 *      for passkey verification.
 *
 *   2. verifyRegistrationOnChain(connection, registration, programId)
 *      Reads the authoritative SessionAccount and verifies that the complete
 *      registration still matches it. Historical V1 sellers may cache this;
 *      Native Tab V2 sellers must repeat it for every reserved voucher because
 *      currentOutstanding is the per-voucher delivery fence.
 *
 *   3. verifyVoucherSignature(voucher, sessionPublicKey, channelIdBytes)
 *      Verifies the session-key signature over the 44-byte voucher payload.
 *      Synchronous, no I/O, microsecond latency. This is what runs PER
 *      CHUNK during streaming.
 *
 * The seller's per-chunk hot path is (3) only. (1) and (2) run once per
 * session.
 */

import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import { p256 } from '@noble/curves/p256';
import { Connection, PublicKey } from '@solana/web3.js';

import type { SignedVoucher, AtomicAmount } from '../types';
import { voucherPayloadMessage } from '../messages';
import { DEXTER_VAULT_PROGRAM_ID } from '../instructions';
// V6: sessions live in their own per-counterparty PDA, not inline in the vault.
import {
  decodeSessionAccount,
  deriveSessionPda,
  isSessionLive,
} from '@dexterai/vault/session';
import {
  contextBoundVoucherV2Message,
  sessionVoucherV2AuthorizationNonce,
  voucherV2SequenceOrdinal,
} from '@dexterai/vault/messages';

// ── Registration parsing ───────────────────────────────────────────────
//
// Registration layout (188 bytes, MUST match messages.ts sessionRegisterMessage):
//    0   32  domain separator (OTS_SESSION_REGISTER_V2 + NUL padding)
//   32   32  program_id
//   64   32  vault_pda
//   96   32  session_pubkey
//  128    8  max_amount (u64 LE)
//  136    8  expires_at (i64 LE)
//  144   32  allowed_counterparty
//  176    4  nonce (u32 LE)
//  180    8  max_revolving_capacity (u64 LE)
//                                    ────
//                                    188

const REGISTER_DOMAIN_PREFIX = 'OTS_SESSION_REGISTER_V2';

export interface ParsedRegistration {
  programId: PublicKey;
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;        // 32 bytes
  maxAmount: bigint;
  expiresAt: bigint;                // unix seconds
  allowedCounterparty: PublicKey;
  nonce: number;
  maxRevolvingCapacity: bigint;     // u64 at [180..188)
}

export type NativeTabWireVersion = 1 | 2;

/** Both the registration nonce and voucher sequence reserve their high bit as
 * the Native Tab V2 wire marker. Keeping this conversion shared prevents the
 * seller from interpreting a V1 registration with a V2 voucher (or vice
 * versa) under different signature/settlement rules. */
export function nativeTabWireVersion(taggedU32: number): NativeTabWireVersion {
  return taggedU32 >= 0x8000_0000 ? 2 : 1;
}

export class InvalidRegistrationError extends Error {
  constructor(
    public readonly reason:
      | 'wrong_length'
      | 'wrong_domain'
      | 'wrong_program'
      | 'expiry_in_past'
      | 'cap_zero',
    detail?: string,
  ) {
    super(`Invalid registration: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'InvalidRegistrationError';
  }
}

/**
 * Parse the raw registration bytes the buyer presents with their first
 * voucher. Synchronous, pure. Validates structural correctness only — the
 * passkey signature check is a separate on-chain step.
 */
export function parseRegistration(registration: Uint8Array): ParsedRegistration {
  if (registration.length !== 188) {
    throw new InvalidRegistrationError('wrong_length', `expected 188, got ${registration.length}`);
  }

  // Domain check: first 23 bytes are "OTS_SESSION_REGISTER_V2", rest of 32 are NUL.
  const domainPrefix = new TextDecoder().decode(registration.slice(0, REGISTER_DOMAIN_PREFIX.length));
  if (domainPrefix !== REGISTER_DOMAIN_PREFIX) {
    throw new InvalidRegistrationError('wrong_domain', `got "${domainPrefix}"`);
  }
  // Bytes 23..32 must be NUL.
  for (let i = REGISTER_DOMAIN_PREFIX.length; i < 32; i++) {
    if (registration[i] !== 0) {
      throw new InvalidRegistrationError('wrong_domain', `non-NUL padding at byte ${i}`);
    }
  }

  const view = new DataView(registration.buffer, registration.byteOffset, registration.byteLength);
  const programId = new PublicKey(registration.slice(32, 64));
  const vaultPda = new PublicKey(registration.slice(64, 96));
  const sessionPubkey = registration.slice(96, 128);
  const maxAmount = view.getBigUint64(128, true);
  const expiresAt = view.getBigInt64(136, true);
  const allowedCounterparty = new PublicKey(registration.slice(144, 176));
  const nonce = view.getUint32(176, true);
  const maxRevolvingCapacity = view.getBigUint64(180, true);

  if (!programId.equals(DEXTER_VAULT_PROGRAM_ID)) {
    throw new InvalidRegistrationError(
      'wrong_program',
      `${programId.toBase58()} is not ${DEXTER_VAULT_PROGRAM_ID.toBase58()}`,
    );
  }
  if (maxAmount === 0n) {
    throw new InvalidRegistrationError('cap_zero');
  }
  return {
    programId,
    vaultPda,
    sessionPubkey: new Uint8Array(sessionPubkey),
    maxAmount,
    expiresAt,
    allowedCounterparty,
    nonce,
    maxRevolvingCapacity,
  };
}

// ── On-chain registration verification ─────────────────────────────────
//
// The 188-byte registration was signed by the buyer's passkey. The vault
// account stores the passkey pubkey. To verify the registration the seller:
//
//   1. Reads the vault account
//   2. Extracts vault.passkey_pubkey (33 bytes at offset 10, after 8-byte
//      Anchor disc + 1 version + 1 bump)
//   3. Asserts vault.active_session.session_pubkey == registration.sessionPubkey
//      (otherwise this is a stale registration vs a rotated session)
//   4. The WebAuthn ceremony itself can't be replayed locally — the seller
//      doesn't have the clientDataJSON / authenticatorData. Instead, the
//      seller trusts that the program already verified it (the active_session
//      being present on chain IS the verification).
//
// So the on-chain check reduces to: does the vault's currently-active
// session match this registration's session pubkey? If yes, the buyer's
// passkey definitely authorized this session (because the program wouldn't
// have set active_session otherwise). If no, the registration is stale or
// forged.

export class OnChainVerificationError extends Error {
  constructor(
    public readonly reason:
      | 'vault_not_found'
      | 'session_not_active'
      | 'session_pubkey_mismatch'
      | 'registration_state_mismatch'
      | 'wire_version_mismatch'
      | 'wrong_program',
    detail?: string,
  ) {
    super(`On-chain verification failed: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'OnChainVerificationError';
  }
}

/** The session's authoritative on-chain delivery evidence.
 * `frontierAtomic` = max(spent, crystallized), the floor below which no voucher
 * can ever settle or lock again. V2 additionally requires
 * `currentOutstandingAtomic` to equal the voucher's uncovered delta. */
export interface OnChainSessionFrontier {
  /** Program account layout version. A live SessionAccount is currently 1. */
  sessionAccountVersion: number;
  /** V1/V2 authorization wire selected by the active registration nonce. */
  wireVersion: NativeTabWireVersion;
  frontierAtomic: AtomicAmount;
  spentAtomic: AtomicAmount;
  currentOutstandingAtomic: AtomicAmount;
  crystallizedCumulativeAtomic: AtomicAmount;
}

/**
 * Verify a registration against on-chain state. Throws on any mismatch;
 * on success returns the session's live version, terminal frontier, and exact
 * outstanding reservation.
 *
 * V6: a session is its own PDA ([b"session", vault, allowed_counterparty]),
 * NOT an inline field on the vault. We read that SessionAccount and confirm it
 * is live (version 1 + unexpired) AND carries the same session pubkey the
 * registration claims. If the program accepted the register_session_key tx
 * (which is what wrote the PDA), the passkey signature was already verified by
 * the secp256r1 precompile inside that tx — the seller just confirms the
 * on-chain witness still holds.
 *
 * The seller reads the exact derived SessionAccount PDA at `finalized`; a
 * confirmed-only reservation is intentionally insufficient for delivery.
 */
export async function verifyRegistrationOnChain(
  connection: Connection,
  registration: ParsedRegistration,
): Promise<OnChainSessionFrontier> {
  const [expectedSessionPda] = deriveSessionPda(
    registration.vaultPda,
    registration.allowedCounterparty,
    registration.programId,
  );
  // Vault 0.43.2's fetchSessionAccount hardcodes `confirmed`. Do not use it
  // here: seller delivery is irreversible and V2 reservation admission must
  // be rooted in finalized state.
  const account = await connection.getAccountInfo(
    expectedSessionPda,
    'finalized',
  );

  if (!account) {
    throw new OnChainVerificationError(
      'session_not_active',
      'no finalized SessionAccount PDA for this (vault, counterparty) — reservation may be confirmed-only, revoked, expiry-swept, or never registered',
    );
  }
  if (!account.owner.equals(registration.programId)) {
    throw new OnChainVerificationError(
      'wrong_program',
      `SessionAccount owner ${account.owner.toBase58()} != ${registration.programId.toBase58()}`,
    );
  }

  let state: ReturnType<typeof decodeSessionAccount>;
  try {
    state = decodeSessionAccount(expectedSessionPda, account.data);
  } catch (error) {
    throw new OnChainVerificationError(
      'registration_state_mismatch',
      `finalized SessionAccount decode failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (state.version === 0) {
    throw new OnChainVerificationError(
      'session_not_active',
      'finalized SessionAccount is cleared',
    );
  }

  if (!isSessionLive(state)) {
    throw new OnChainVerificationError(
      'session_not_active',
      'SessionAccount PDA is present but expired',
    );
  }

  if (!bytesEqual(state.session.sessionPubkey, registration.sessionPubkey)) {
    throw new OnChainVerificationError(
      'session_pubkey_mismatch',
      `on-chain ${bytesToHex(state.session.sessionPubkey)} != registration ${bytesToHex(registration.sessionPubkey)}`,
    );
  }

  const registrationWireVersion = nativeTabWireVersion(registration.nonce);
  const activeWireVersion = nativeTabWireVersion(state.session.nonce);
  if (activeWireVersion !== registrationWireVersion) {
    throw new OnChainVerificationError(
      'wire_version_mismatch',
      `active SessionAccount is V${activeWireVersion}, voucher registration is V${registrationWireVersion}`,
    );
  }

  // The SessionAccount is the passkey-verified source of truth for EVERY
  // immutable field in the 188-byte registration, not merely the session
  // public key.  A caller can freely edit the registration bytes carried in a
  // voucher; trusting a forged cap/expiry/nonce/revolving limit here lets the
  // seller deliver under authority the chain never granted, even though the
  // eventual terminal transaction rejects it.  Exact-compare the complete
  // immutable witness before the middleware caches this registration or
  // releases seller output.  Mutable meters (spent/outstanding/crystallized/
  // lastLockedSequence) are intentionally excluded because they advance after
  // registration.
  const expiryIsExact =
    Number.isSafeInteger(state.session.expiresAt)
    && BigInt(state.session.expiresAt) === registration.expiresAt;
  const immutableFieldsMatch =
    state.address === expectedSessionPda.toBase58()
    && state.vault === registration.vaultPda.toBase58()
    && state.session.maxAmount === registration.maxAmount
    && expiryIsExact
    && state.session.allowedCounterparty
      === registration.allowedCounterparty.toBase58()
    && state.session.nonce === registration.nonce
    && state.session.maxRevolvingCapacity
      === registration.maxRevolvingCapacity;
  if (!immutableFieldsMatch) {
    throw new OnChainVerificationError(
      'registration_state_mismatch',
      '188-byte registration does not exactly match the active SessionAccount immutable fields',
    );
  }

  // Surface the terminal odometers we just paid an RPC read for. spent
  // advances on settle, crystallizedCumulative on lock; a voucher at or below
  // max(spent, crystallized) is dead on arrival at the facilitator, so the
  // seller must never deliver under it as if it were fresh budget.
  const spent = state.session.spent;
  const crystallized = state.session.crystallizedCumulative;
  const frontier = spent > crystallized ? spent : crystallized;
  return {
    sessionAccountVersion: state.version,
    wireVersion: activeWireVersion,
    frontierAtomic: frontier.toString(),
    spentAtomic: spent.toString(),
    currentOutstandingAtomic: state.session.currentOutstanding.toString(),
    crystallizedCumulativeAtomic: crystallized.toString(),
  };
}

// ── Per-voucher signature verification (the per-chunk hot path) ────────

export class InvalidVoucherSignatureError extends Error {
  constructor(detail?: string) {
    super(`Invalid voucher signature${detail ? `: ${detail}` : ''}`);
    this.name = 'InvalidVoucherSignatureError';
  }
}

/**
 * Verify the session-key signature on a voucher. This is the hot-path
 * check, called on every chunk during streaming. Pure ed25519
 * verification, microsecond latency.
 *
 * The channelIdBytes must be the canonical 32-byte channel id the buyer
 * derived (typically sha256(vault_pda || seller_url || nonce)). The
 * caller is responsible for either deriving it the same way or accepting
 * whatever the buyer presents on the first voucher (treating it as the
 * channel handle for the session).
 */
export function verifyVoucherSignature(
  voucher: SignedVoucher,
  channelIdBytes: Uint8Array,
): void {
  if (channelIdBytes.length !== 32) {
    throw new InvalidVoucherSignatureError(`channelIdBytes must be 32 bytes, got ${channelIdBytes.length}`);
  }
  if (voucher.sessionPublicKey.length !== 32) {
    throw new InvalidVoucherSignatureError(`sessionPublicKey must be 32 bytes, got ${voucher.sessionPublicKey.length}`);
  }
  if (voucher.sessionSignature.length !== 64) {
    throw new InvalidVoucherSignatureError(`sessionSignature must be 64 bytes, got ${voucher.sessionSignature.length}`);
  }

  const registration = parseRegistration(voucher.sessionRegistration);
  if (!bytesEqual(registration.sessionPubkey, voucher.sessionPublicKey)) {
    throw new InvalidVoucherSignatureError(
      'registration session key does not match voucher session key',
    );
  }
  const v2 = registration.nonce >= 0x8000_0000;
  const registrationWireVersion = nativeTabWireVersion(registration.nonce);
  const voucherWireVersion = nativeTabWireVersion(
    voucher.payload.sequenceNumber,
  );
  if (registrationWireVersion !== voucherWireVersion) {
    throw new InvalidVoucherSignatureError(
      `voucher wire V${voucherWireVersion} does not match registration wire V${registrationWireVersion}`,
    );
  }
  let message: Uint8Array;
  if (v2) {
    sessionVoucherV2AuthorizationNonce(registration.nonce);
    voucherV2SequenceOrdinal(voucher.payload.sequenceNumber);
    const [sessionPda] = deriveSessionPda(
      registration.vaultPda,
      registration.allowedCounterparty,
      registration.programId,
    );
    message = contextBoundVoucherV2Message({
      programId: registration.programId,
      vaultPda: registration.vaultPda,
      sessionPda,
      seller: registration.allowedCounterparty,
      sessionNonce: registration.nonce,
      channelId: channelIdBytes,
      cumulativeAmount: BigInt(voucher.payload.cumulativeAmount),
      sequenceNumber: voucher.payload.sequenceNumber,
    });
  } else {
    // Historical V1 verification remains seller-side and read-only for
    // obligations already issued by an older compatible deployment. V6 does
    // not open or reconstruct a buyer-side V1 Tab; new admission requires V2.
    message = voucherPayloadMessage({
      channelId: channelIdBytes,
      cumulativeAmount: BigInt(voucher.payload.cumulativeAmount),
      sequenceNumber: voucher.payload.sequenceNumber,
    });
  }

  const ok = nacl.sign.detached.verify(
    message,
    voucher.sessionSignature,
    voucher.sessionPublicKey,
  );
  if (!ok) {
    throw new InvalidVoucherSignatureError('ed25519 verify rejected');
  }
}

// ── Scope enforcement ──────────────────────────────────────────────────
//
// Separate from signature check because the seller may want to combine
// signature verification (cheap, per-chunk) with periodic scope re-checks
// (also cheap but conceptually distinct).

export class ScopeViolationError extends Error {
  constructor(
    public readonly reason:
      | 'cumulative_exceeds_cap'
      | 'session_expired'
      | 'wrong_counterparty'
      | 'non_monotonic',
    detail?: string,
  ) {
    super(`Scope violation: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ScopeViolationError';
  }
}

export function enforceScope(args: {
  registration: ParsedRegistration;
  voucher: SignedVoucher;
  expectedCounterparty: PublicKey;
  previousCumulativeAtomic?: AtomicAmount;
}): void {
  const cumulative = BigInt(args.voucher.payload.cumulativeAmount);
  if (cumulative > args.registration.maxAmount) {
    throw new ScopeViolationError(
      'cumulative_exceeds_cap',
      `${cumulative} > ${args.registration.maxAmount}`,
    );
  }

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (nowSec >= args.registration.expiresAt) {
    throw new ScopeViolationError(
      'session_expired',
      `now=${nowSec} >= expiresAt=${args.registration.expiresAt}`,
    );
  }

  if (!args.registration.allowedCounterparty.equals(args.expectedCounterparty)) {
    throw new ScopeViolationError(
      'wrong_counterparty',
      `${args.registration.allowedCounterparty.toBase58()} != ${args.expectedCounterparty.toBase58()}`,
    );
  }

  if (args.previousCumulativeAtomic !== undefined) {
    const prev = BigInt(args.previousCumulativeAtomic);
    if (cumulative <= prev) {
      throw new ScopeViolationError(
        'non_monotonic',
        `cumulative=${cumulative} not > previous=${prev}`,
      );
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (const x of b) out += x.toString(16).padStart(2, '0');
  return out;
}

// noble-curves p256 is not used in the hot path (registration verify is
// reduced to an on-chain read), but kept imported so future deep-verify
// modes (e.g. simulate the precompile locally) have it at hand.
void p256;
void sha256;
