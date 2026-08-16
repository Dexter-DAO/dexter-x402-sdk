/**
 * Session-key lifecycle: generation, voucher signing, in-memory hygiene.
 *
 * A session key is an ed25519 keypair generated in process memory at tab
 * open. The buyer's passkey signs a 188-byte V2 registration message endorsing
 * the session pubkey within a scope (counterparty, max amount, expiry).
 * From that point until tab close, the session key signs every voucher; the
 * passkey is never invoked again for the lifetime of the tab.
 *
 * The session keypair is NEVER persisted to disk. A crashed process
 * forfeits the session; the buyer re-prompts the passkey on the next
 * attempt. This is the right default — a session key on disk is a real
 * attack surface, the cost of re-authorizing is a single prompt.
 *
 * Curve choice: ed25519. It's Solana's native signer, every Solana RPC and
 * wallet knows how to verify it, and `tweetnacl` (already a SDK dep) gives
 * us a deterministic implementation that doesn't pull in heavy crypto.
 */

import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import {
  contextBoundVoucherV2Message,
  finalVoucherV2Sequence,
  sessionRegisterMessage,
  sessionVoucherV2AuthorizationNonce,
} from '@dexterai/vault/messages';
import { deriveSessionPda } from '@dexterai/vault/session';
import type {
  SessionKey,
  SessionScope,
  VoucherPayload,
  SignedVoucher,
  AtomicAmount,
} from './types';
import { voucherPayloadMessage } from './messages';

// ── Ephemeral keypair generation ───────────────────────────────────────

/**
 * Generate a fresh ed25519 keypair to act as the session signer. The
 * caller is responsible for getting this keypair endorsed by a passkey via
 * `register_session_key` before any voucher signed with it is acceptable
 * to a seller.
 */
export function generateSessionKeypair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: kp.publicKey,
    privateKey: kp.secretKey, // 64 bytes: 32 seed || 32 pubkey, per nacl
  };
}

/**
 * Construct a complete `SessionKey` once the passkey has produced the
 * registration signature for it. The registration bytes are what the
 * seller verifies the signed voucher against; without them the session
 * keypair is just an unauthorized ed25519 pair.
 */
export function makeSessionKey(
  keypair: { publicKey: Uint8Array; privateKey: Uint8Array },
  scope: SessionScope,
  registration: Uint8Array,
): SessionKey {
  return {
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    scope,
    registration,
  };
}

// ── Voucher signing ────────────────────────────────────────────────────

/**
 * Sign a voucher payload with a session keypair. Returns a `SignedVoucher`
 * the seller can verify locally:
 *   1. sessionSignature is valid for sessionPublicKey over the payload bytes
 *   2. sessionRegistration is the passkey-endorsed scope for sessionPublicKey
 *   3. payload.cumulativeAmount <= scope.maxAmountAtomic
 *   4. now < scope.expiresAtUnix
 *   5. counterparty matches scope.allowedCounterparty
 *
 * This function does NOT enforce scope locally — that's the seller's job —
 * but it does throw on the cap and expiry checks as a defensive client-side
 * guard so a misbehaving caller can't sign vouchers the seller will reject.
 */
export function signVoucher(
  session: SessionKey,
  payload: VoucherPayload,
  channelIdBytes: Uint8Array,
): SignedVoucher {
  if (channelIdBytes.length !== 32) {
    throw new Error(`channelIdBytes must be 32 bytes, got ${channelIdBytes.length}`);
  }
  if (session.registration.length === 188) {
    const registration = new DataView(
      session.registration.buffer,
      session.registration.byteOffset,
      session.registration.byteLength,
    );
    if (registration.getUint32(176, true) >= 0x8000_0000) {
      throw new Error(
        'context-bound V2 sessions require signContextBoundFinalVoucherV2 and a durable reservation',
      );
    }
  }

  const cumulative = BigInt(payload.cumulativeAmount);
  const cap = BigInt(session.scope.maxAmountAtomic);
  if (cumulative > cap) {
    throw new Error(
      `voucher cumulative ${cumulative} exceeds session cap ${cap}`,
    );
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  if (nowUnix >= session.scope.expiresAtUnix) {
    throw new Error(
      `session expired at ${session.scope.expiresAtUnix}, now ${nowUnix}`,
    );
  }

  const message = voucherPayloadMessage({
    channelId: channelIdBytes,
    cumulativeAmount: cumulative,
    sequenceNumber: payload.sequenceNumber,
  });

  const sessionSignature = nacl.sign.detached(message, session.privateKey);

  return {
    payload,
    sessionPublicKey: session.publicKey,
    sessionRegistration: session.registration,
    sessionSignature,
  };
}

export interface SignContextBoundFinalVoucherV2Input {
  programId: string;
  vaultPda: string;
  sessionPda: string;
  seller: string;
  sessionNonce: number;
  channelId: string;
  cumulativeAmountAtomic: string;
  sequenceOrdinal: number;
  sessionPrivateKey: Uint8Array;
  sessionPublicKey: Uint8Array;
  sessionRegistration: Uint8Array;
  /** Testable freshness seam. Defaults to the current Unix second. */
  nowUnixSeconds?: number;
}

export interface SignContextBoundFinalVoucherV2Result {
  channelId: string;
  cumulativeAmount: string;
  sequenceNumber: number;
  sessionPublicKey: string;
  sessionSignature: string;
  sessionRegistration: string;
}

const HEX_32 = /^[0-9a-f]{64}$/;
const U64_MAX = (1n << 64n) - 1n;

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Canonical hosted-purchase signer for Native Tab V2.
 *
 * Every output is a FINAL, context-bound obligation. The function owns bytes
 * only: it validates the complete registration, derived session PDA, expiry,
 * scope, and ed25519 keypair before signing. The caller must durably establish
 * the exact reservation before releasing the resulting voucher.
 */
export function signContextBoundFinalVoucherV2(
  input: SignContextBoundFinalVoucherV2Input,
): SignContextBoundFinalVoucherV2Result {
  if (
    !HEX_32.test(input.channelId)
    || input.sessionPublicKey.length !== 32
    || input.sessionPrivateKey.length !== 64
    || input.sessionRegistration.length !== 188
    || !/^[1-9][0-9]*$/.test(input.cumulativeAmountAtomic)
  ) {
    throw new Error('native_tab_v2_signing_input_invalid');
  }
  const cumulativeAmount = BigInt(input.cumulativeAmountAtomic);
  if (cumulativeAmount > U64_MAX) {
    throw new Error('native_tab_v2_cumulative_amount_invalid');
  }

  const programId = new PublicKey(input.programId);
  const vaultPda = new PublicKey(input.vaultPda);
  const sessionPda = new PublicKey(input.sessionPda);
  const seller = new PublicKey(input.seller);
  const [expectedSessionPda] = deriveSessionPda(
    vaultPda,
    seller,
    programId,
  );
  if (!sessionPda.equals(expectedSessionPda)) {
    throw new Error('native_tab_v2_session_pda_mismatch');
  }

  const registration = input.sessionRegistration;
  const view = new DataView(
    registration.buffer,
    registration.byteOffset,
    registration.byteLength,
  );
  const maxAmount = view.getBigUint64(128, true);
  const expiresAt = view.getBigInt64(136, true);
  const maxRevolvingCapacity = view.getBigUint64(180, true);
  const nowUnixSeconds = input.nowUnixSeconds
    ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(nowUnixSeconds) || nowUnixSeconds < 0) {
    throw new Error('native_tab_v2_signing_time_invalid');
  }
  const exactRegistration = sameBytes(
    registration,
    sessionRegisterMessage({
      programId,
      vaultPda,
      sessionPubkey: input.sessionPublicKey,
      maxAmount,
      expiresAt,
      allowedCounterparty: seller,
      nonce: input.sessionNonce,
      maxRevolvingCapacity,
    }),
  );
  if (!exactRegistration) {
    throw new Error('native_tab_v2_registration_identity_mismatch');
  }
  if (
    maxAmount === 0n
    || maxRevolvingCapacity === 0n
    || maxRevolvingCapacity > maxAmount
    || expiresAt <= BigInt(nowUnixSeconds)
    || expiresAt > 0x7fff_ffff_ffff_ffffn - 604_800n
    || cumulativeAmount > maxAmount
  ) {
    throw new Error('native_tab_v2_registration_semantics_invalid');
  }
  sessionVoucherV2AuthorizationNonce(input.sessionNonce);

  const derived = nacl.sign.keyPair.fromSeed(
    input.sessionPrivateKey.subarray(0, 32),
  );
  let keyMatches = false;
  try {
    keyMatches =
      sameBytes(derived.publicKey, input.sessionPublicKey)
      && sameBytes(
        input.sessionPrivateKey.subarray(32, 64),
        input.sessionPublicKey,
      );
  } finally {
    derived.secretKey.fill(0);
  }
  if (!keyMatches) {
    throw new Error('native_tab_v2_session_key_mismatch');
  }

  const sequenceNumber = finalVoucherV2Sequence(input.sequenceOrdinal);
  const message = contextBoundVoucherV2Message({
    programId,
    vaultPda,
    sessionPda,
    seller,
    sessionNonce: input.sessionNonce,
    channelId: hexToBytes(input.channelId),
    cumulativeAmount,
    sequenceNumber,
  });
  const signature = nacl.sign.detached(message, input.sessionPrivateKey);

  return {
    channelId: input.channelId,
    cumulativeAmount: input.cumulativeAmountAtomic,
    sequenceNumber,
    sessionPublicKey: bytesToHex(input.sessionPublicKey),
    sessionSignature: bytesToHex(signature),
    sessionRegistration: bytesToHex(registration),
  };
}

// ── Helpers for callers building SessionScope ──────────────────────────

/**
 * Convert a `SessionScope` (which uses string AtomicAmount for JSON
 * portability) to the bigint cap actually needed for signing. Throws on
 * malformed input.
 */
export function scopeCapAtomic(scope: SessionScope): bigint {
  return parseAtomic(scope.maxAmountAtomic);
}

export function parseAtomic(s: AtomicAmount): bigint {
  if (!/^\d+$/.test(s)) {
    throw new Error(`atomic amount must be a non-negative integer string, got "${s}"`);
  }
  return BigInt(s);
}

// ── Channel id derivation ──────────────────────────────────────────────
//
// A channel id is a deterministic 32-byte tag identifying a single tab.
// The buyer derives it locally; the seller can also derive it given the
// same inputs. The exact derivation is opaque to the on-chain program (the
// vault never sees channel ids) but seller middleware uses it as a
// session identifier in voucher accounting.
//
// We use sha256(vault_pda || seller_url || nonce_u64_le) — buyer-vault is
// the principal, seller_url is the counterparty, nonce gives uniqueness
// for buyers who open multiple tabs against the same seller.

import { sha256 } from '@noble/hashes/sha256';

export function deriveChannelId(args: {
  vaultPda: PublicKey;
  sellerUrl: string;
  nonce: bigint;
}): Uint8Array {
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, args.nonce, true);
  const sellerBytes = new TextEncoder().encode(args.sellerUrl);
  const out = sha256.create();
  out.update(args.vaultPda.toBytes());
  out.update(sellerBytes);
  out.update(nonceBytes);
  return out.digest();
}
