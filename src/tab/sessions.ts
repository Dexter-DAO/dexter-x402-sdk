/**
 * Session-key lifecycle: generation, voucher signing, in-memory hygiene.
 *
 * A session key is an ed25519 keypair generated in process memory at tab
 * open. The buyer's passkey signs a 180-byte registration message endorsing
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
import type { PublicKey } from '@solana/web3.js';
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
