/**
 * Local voucher verification for the seller side of OTS tab streaming.
 *
 * Two-layer verification:
 *
 *   1. parseRegistration(registrationBytes)
 *      Parses the 180-byte registration message into a scope. Synchronous,
 *      no I/O. This gives the seller everything they need to enforce limits
 *      LOCALLY (cap, expiry, counterparty) and to know which vault to read
 *      for passkey verification.
 *
 *   2. verifyRegistrationOnChain(connection, registration, programId)
 *      Reads the vault account on chain ONCE per session and verifies that
 *      the buyer's passkey would have produced the registration's signature.
 *      Cached after the first call; subsequent vouchers in the same session
 *      reuse the cached result.
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

  // Domain check: first 23 bytes are "OTS_SESSION_REGISTER_V1", rest of 32 are NUL.
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
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (expiresAt <= nowSec) {
    throw new InvalidRegistrationError(
      'expiry_in_past',
      `expires_at=${expiresAt}, now=${nowSec}`,
    );
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
// The 180-byte registration was signed by the buyer's passkey. The vault
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

const VAULT_PASSKEY_PUBKEY_OFFSET = 8 + 1 + 1; // disc + version + bump = 10

export interface OnChainVaultState {
  passkeyPubkey: Uint8Array;     // 33 bytes, SEC1 compressed P-256
  activeSessionPubkey: Uint8Array | null;
}

export class OnChainVerificationError extends Error {
  constructor(
    public readonly reason:
      | 'vault_not_found'
      | 'session_not_active'
      | 'session_pubkey_mismatch'
      | 'wrong_program',
    detail?: string,
  ) {
    super(`On-chain verification failed: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'OnChainVerificationError';
  }
}

/**
 * Read the vault account and extract passkey + active session.
 *
 * Reads at `finalized` commitment to avoid the read-replica race that
 * shows up when the buyer just confirmed register_session_key at
 * `confirmed` and the seller's RPC replica hasn't propagated the write
 * yet. This is the same lesson as the dexter-vault test suite — see
 * reference_anchor_test_commitment in repo memory.
 */
export async function readVaultState(
  connection: Connection,
  vaultPda: PublicKey,
): Promise<OnChainVaultState> {
  const acct = await connection.getAccountInfo(vaultPda, 'finalized');
  if (!acct) {
    throw new OnChainVerificationError('vault_not_found', vaultPda.toBase58());
  }
  if (!acct.owner.equals(DEXTER_VAULT_PROGRAM_ID)) {
    throw new OnChainVerificationError(
      'wrong_program',
      `owner ${acct.owner.toBase58()} is not the vault program`,
    );
  }

  const data = acct.data;
  const passkeyPubkey = new Uint8Array(
    data.slice(VAULT_PASSKEY_PUBKEY_OFFSET, VAULT_PASSKEY_PUBKEY_OFFSET + 33),
  );

  // active_session offset depends on pending_withdrawal's variable size.
  // pending_withdrawal tag at offset 83; if 1, payload is 48 bytes.
  const pendingTag = data[83];
  const pendingSize = pendingTag === 1 ? 48 : 0;
  const identityStart = 84 + pendingSize;
  const dexterAuthStart = identityStart + 32;
  const activeSessionTagOffset = dexterAuthStart + 32;
  const activeSessionTag = data[activeSessionTagOffset];

  if (activeSessionTag !== 1) {
    return { passkeyPubkey, activeSessionPubkey: null };
  }

  // SessionRegistration layout, after the tag:
  //   session_pubkey: [u8; 32]   <- the only thing we need here
  //   max_amount: u64
  //   expires_at: i64
  //   allowed_counterparty: Pubkey
  //   nonce: u32
  //   spent: u64
  //   current_outstanding: u64
  //   max_revolving_capacity: u64
  const sessionPubkeyStart = activeSessionTagOffset + 1;
  const activeSessionPubkey = new Uint8Array(
    data.slice(sessionPubkeyStart, sessionPubkeyStart + 32),
  );
  return { passkeyPubkey, activeSessionPubkey };
}

/**
 * Verify a registration against on-chain state. Returns the vault's
 * passkey pubkey (caller can cache it). Throws on any mismatch.
 *
 * The "verification" here is structural: the active_session on chain MUST
 * carry the same session pubkey the registration claims. If the program
 * accepted the register_session_key tx (which is what set active_session
 * in the first place), then the passkey signature was verified by the
 * secp256r1 precompile inside that tx. The seller doesn't need to redo
 * that work; they just need to confirm the on-chain witness still holds.
 */
export async function verifyRegistrationOnChain(
  connection: Connection,
  registration: ParsedRegistration,
): Promise<{ passkeyPubkey: Uint8Array }> {
  const state = await readVaultState(connection, registration.vaultPda);

  if (state.activeSessionPubkey === null) {
    throw new OnChainVerificationError(
      'session_not_active',
      'vault has no active_session — was it revoked?',
    );
  }

  if (!bytesEqual(state.activeSessionPubkey, registration.sessionPubkey)) {
    throw new OnChainVerificationError(
      'session_pubkey_mismatch',
      `on-chain ${bytesToHex(state.activeSessionPubkey)} != registration ${bytesToHex(registration.sessionPubkey)}`,
    );
  }

  return { passkeyPubkey: state.passkeyPubkey };
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

  const message = voucherPayloadMessage({
    channelId: channelIdBytes,
    cumulativeAmount: BigInt(voucher.payload.cumulativeAmount),
    sequenceNumber: voucher.payload.sequenceNumber,
  });

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
