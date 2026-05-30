/**
 * Byte-deterministic message builders for the OTS session-key layer.
 *
 * These MUST match the on-chain Rust handlers in dexter-vault byte-for-byte:
 *   - register_session_key.rs::build_registration_message → sessionRegisterMessage
 *   - revoke_session_key.rs::build_revocation_message     → sessionRevokeMessage
 *
 * If either side drifts, the secp256r1 precompile verifies a different
 * message than the on-chain program reconstructs and every signature looks
 * forged. Treat any change here as a wire-format breaking change.
 *
 * The reference implementation tests live at
 * dexter-vault/tests/helpers/secp256r1.ts (sessionRegisterMessage /
 * sessionRevokeMessage). Keep the two in lockstep.
 */

import type { PublicKey } from '@solana/web3.js';

// ── Domain separators ──────────────────────────────────────────────────
// 32-byte fixed-width labels. The Rust constants are:
//   b"OTS_SESSION_REGISTER_V1\0\0\0\0\0\0\0\0\0" (23 + 9 NUL = 32)
//   b"OTS_SESSION_REVOKE_V1\0\0\0\0\0\0\0\0\0\0\0" (21 + 11 NUL = 32)
// Bump the trailing version any time you change the message layout.

const REGISTER_DOMAIN: Uint8Array = (() => {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode('OTS_SESSION_REGISTER_V1'), 0);
  return buf;
})();

const REVOKE_DOMAIN: Uint8Array = (() => {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode('OTS_SESSION_REVOKE_V1'), 0);
  return buf;
})();

// ── Registration message: 180 bytes ────────────────────────────────────
//
// Layout (offset / size / field):
//    0   32  domain separator (REGISTER_DOMAIN)
//   32   32  program_id (Pubkey)
//   64   32  vault_pda (Pubkey)
//   96   32  session_pubkey (caller-generated ed25519 / 32 bytes)
//  128    8  max_amount (u64 LE) — cumulative cap in atomic units
//  136    8  expires_at (i64 LE) — wall-clock unix seconds, must be future
//  144   32  allowed_counterparty (Pubkey) — the seller this session is for
//  176    4  nonce (u32 LE)
//                                    ────
//                                    180

export interface SessionRegisterMessageArgs {
  programId: PublicKey;
  vaultPda: PublicKey;
  /** 32 bytes; the ed25519 public key of the in-memory session keypair. */
  sessionPubkey: Uint8Array;
  /** Cumulative cap, atomic units. */
  maxAmount: bigint;
  /** i64 seconds since unix epoch. Must be strictly in the future. */
  expiresAt: bigint;
  /** Seller this session is bound to. */
  allowedCounterparty: PublicKey;
  /** Per-session nonce (caller-chosen). */
  nonce: number;
}

export function sessionRegisterMessage(args: SessionRegisterMessageArgs): Uint8Array {
  if (args.sessionPubkey.length !== 32) {
    throw new Error(`sessionPubkey must be 32 bytes, got ${args.sessionPubkey.length}`);
  }
  const buf = new Uint8Array(180);
  const view = new DataView(buf.buffer);
  let o = 0;
  buf.set(REGISTER_DOMAIN, o); o += 32;
  buf.set(args.programId.toBytes(), o); o += 32;
  buf.set(args.vaultPda.toBytes(), o); o += 32;
  buf.set(args.sessionPubkey, o); o += 32;
  view.setBigUint64(o, args.maxAmount, true); o += 8;
  view.setBigInt64(o, args.expiresAt, true); o += 8;
  buf.set(args.allowedCounterparty.toBytes(), o); o += 32;
  view.setUint32(o, args.nonce >>> 0, true); o += 4;
  if (o !== 180) {
    throw new Error(`internal: session register message wrong length ${o}, expected 180`);
  }
  return buf;
}

// ── Revocation message: 128 bytes ──────────────────────────────────────
//
// Layout:
//    0   32  domain separator (REVOKE_DOMAIN)
//   32   32  program_id
//   64   32  vault_pda
//   96   32  session_pubkey — MUST match active_session.session_pubkey on
//             chain. The on-chain handler rejects with SessionPubkeyMismatch
//             otherwise, which defeats stale-revocation replay against a
//             newer session.
//                                    ────
//                                    128

export interface SessionRevokeMessageArgs {
  programId: PublicKey;
  vaultPda: PublicKey;
  /** 32 bytes; the exact session pubkey being revoked. */
  sessionPubkey: Uint8Array;
}

export function sessionRevokeMessage(args: SessionRevokeMessageArgs): Uint8Array {
  if (args.sessionPubkey.length !== 32) {
    throw new Error(`sessionPubkey must be 32 bytes, got ${args.sessionPubkey.length}`);
  }
  const buf = new Uint8Array(128);
  let o = 0;
  buf.set(REVOKE_DOMAIN, o); o += 32;
  buf.set(args.programId.toBytes(), o); o += 32;
  buf.set(args.vaultPda.toBytes(), o); o += 32;
  buf.set(args.sessionPubkey, o); o += 32;
  if (o !== 128) {
    throw new Error(`internal: session revoke message wrong length ${o}, expected 128`);
  }
  return buf;
}

// ── Voucher payload: what the session key signs per stream chunk ──────
//
// This is NOT verified on chain — the seller's middleware verifies it
// locally against the registration. But the encoding still needs to be
// canonical so seller and buyer agree on what was signed.
//
// Layout:
//    0   32  channel_id (caller-defined 32 bytes; typically sha256 of
//             buyer-vault || seller-url || nonce)
//   32    8  cumulative_amount (u64 LE, atomic units)
//   40    4  sequence_number (u32 LE)
//                                    ───
//                                    44

export interface VoucherPayloadBytes {
  channelId: Uint8Array;        // 32 bytes
  cumulativeAmount: bigint;     // atomic units
  sequenceNumber: number;       // monotonically increasing within the tab
}

export function voucherPayloadMessage(p: VoucherPayloadBytes): Uint8Array {
  if (p.channelId.length !== 32) {
    throw new Error(`channelId must be 32 bytes, got ${p.channelId.length}`);
  }
  const buf = new Uint8Array(44);
  const view = new DataView(buf.buffer);
  let o = 0;
  buf.set(p.channelId, o); o += 32;
  view.setBigUint64(o, p.cumulativeAmount, true); o += 8;
  view.setUint32(o, p.sequenceNumber >>> 0, true); o += 4;
  if (o !== 44) {
    throw new Error(`internal: voucher payload wrong length ${o}, expected 44`);
  }
  return buf;
}
