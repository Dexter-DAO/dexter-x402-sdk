/**
 * Raw Solana instruction builders for the OTS session-key layer.
 *
 * These mirror the on-chain Anchor program (dexter-vault v2) without
 * pulling in the @coral-xyz/anchor IDL dependency — the SDK stays
 * lightweight and ships with the discriminator/account layout hard-coded.
 *
 * The discriminator bytes come straight from the program IDL
 * (target/idl/dexter_vault.json). They are sha256("global:<ix_name>")[..8].
 * Verified against target/idl/dexter_vault.json at SDK build time.
 *
 * The instruction layout (account order, sysvar binding) is fixed by the
 * #[derive(Accounts)] structs in the Rust handlers. Any change there is a
 * wire-format breaking change.
 */

import {
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';

// ── Constants ──────────────────────────────────────────────────────────

/** Deployed dexter-vault program on Solana mainnet. */
export const DEXTER_VAULT_PROGRAM_ID = new PublicKey(
  'Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc',
);

/** SIMD-0075 secp256r1 sigverify precompile. Mainnet-only. */
export const SECP256R1_PROGRAM_ID = new PublicKey(
  'Secp256r1SigVerify1111111111111111111111111',
);

/** Solana instructions sysvar — the address-constrained account every
 *  passkey-signed vault instruction reads to introspect its precompile
 *  sibling. */
export const INSTRUCTIONS_SYSVAR_ID = new PublicKey(
  'Sysvar1nstructions1111111111111111111111111',
);

// Anchor discriminators: sha256("global:<ix_name>")[..8].
// Cross-checked against target/idl/dexter_vault.json.
const REGISTER_SESSION_KEY_DISC = new Uint8Array([69, 94, 60, 44, 49, 199, 183, 233]);
const REVOKE_SESSION_KEY_DISC = new Uint8Array([81, 192, 32, 110, 104, 116, 144, 151]);

// ── Borsh encoding helpers ─────────────────────────────────────────────
// Borsh's Vec<u8> = 4-byte little-endian length prefix + bytes.
// All other args here are fixed-width primitives.

function encodeU64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return buf;
}

function encodeI64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, value, true);
  return buf;
}

function encodeU32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value >>> 0, true);
  return buf;
}

function encodeVecU8(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length >>> 0, true);
  out.set(bytes, 4);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ── secp256r1 precompile builder ───────────────────────────────────────
//
// SIMD-0075 format. Exactly one offsets entry; signature in compact (r||s)
// 64-byte form; compressed 33-byte SEC1 pubkey; message immediately follows.
//
// This is a direct port of dexter-vault/tests/helpers/secp256r1.ts to keep
// the SDK and the on-chain test helper byte-identical.

const SIGNATURE_SERIALIZED_SIZE = 64;
const COMPRESSED_PUBKEY_SERIALIZED_SIZE = 33;
const SIGNATURE_OFFSETS_SERIALIZED_SIZE = 14;
const DATA_START = 2;

export function buildSecp256r1VerifyInstruction(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): TransactionInstruction {
  if (publicKey.length !== COMPRESSED_PUBKEY_SERIALIZED_SIZE) {
    throw new Error(`expected ${COMPRESSED_PUBKEY_SERIALIZED_SIZE}-byte compressed pubkey`);
  }
  if (signature.length !== SIGNATURE_SERIALIZED_SIZE) {
    throw new Error(`expected ${SIGNATURE_SERIALIZED_SIZE}-byte signature`);
  }

  const signatureOffset = DATA_START + SIGNATURE_OFFSETS_SERIALIZED_SIZE;
  const publicKeyOffset = signatureOffset + SIGNATURE_SERIALIZED_SIZE;
  const messageOffset = publicKeyOffset + COMPRESSED_PUBKEY_SERIALIZED_SIZE;
  const messageSize = message.length;

  const totalLen = messageOffset + messageSize;
  const data = new Uint8Array(totalLen);

  data[0] = 1; // 1 signature entry
  data[1] = 0; // padding

  const view = new DataView(data.buffer);
  view.setUint16(DATA_START + 0, signatureOffset, true);
  view.setUint16(DATA_START + 2, 0xffff, true);          // sig instruction index — same tx
  view.setUint16(DATA_START + 4, publicKeyOffset, true);
  view.setUint16(DATA_START + 6, 0xffff, true);          // pubkey instruction index — same tx
  view.setUint16(DATA_START + 8, messageOffset, true);
  view.setUint16(DATA_START + 10, messageSize, true);
  view.setUint16(DATA_START + 12, 0xffff, true);          // message instruction index — same tx

  data.set(signature, signatureOffset);
  data.set(publicKey, publicKeyOffset);
  data.set(message, messageOffset);

  return new TransactionInstruction({
    keys: [],
    programId: SECP256R1_PROGRAM_ID,
    data: Buffer.from(data),
  });
}

// ── register_session_key ───────────────────────────────────────────────
//
// Accounts (in declaration order — Anchor is strict):
//   0. [writable]            vault                — the Vault PDA being mutated
//   1. [readonly]            instructions_sysvar  — address-constrained
//
// Args (Borsh-serialized after the 8-byte discriminator):
//   session_pubkey: [u8; 32]
//   max_amount: u64
//   expires_at: i64
//   allowed_counterparty: Pubkey (32 bytes)
//   nonce: u32
//   client_data_json: Vec<u8>
//   authenticator_data: Vec<u8>

export interface BuildRegisterSessionKeyArgs {
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;        // 32 bytes, ed25519
  maxAmount: bigint;
  expiresAt: bigint;                 // i64 seconds
  allowedCounterparty: PublicKey;
  nonce: number;                     // u32
  clientDataJSON: Uint8Array;        // WebAuthn ceremony output
  authenticatorData: Uint8Array;     // WebAuthn ceremony output
}

export function buildRegisterSessionKeyInstruction(
  args: BuildRegisterSessionKeyArgs,
): TransactionInstruction {
  if (args.sessionPubkey.length !== 32) {
    throw new Error(`sessionPubkey must be 32 bytes, got ${args.sessionPubkey.length}`);
  }

  const data = concatBytes(
    REGISTER_SESSION_KEY_DISC,
    args.sessionPubkey,
    encodeU64LE(args.maxAmount),
    encodeI64LE(args.expiresAt),
    args.allowedCounterparty.toBytes(),
    encodeU32LE(args.nonce),
    encodeVecU8(args.clientDataJSON),
    encodeVecU8(args.authenticatorData),
  );

  return new TransactionInstruction({
    keys: [
      { pubkey: args.vaultPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    programId: DEXTER_VAULT_PROGRAM_ID,
    data: Buffer.from(data),
  });
}

// ── revoke_session_key ─────────────────────────────────────────────────
//
// Accounts: same as register (vault, instructions_sysvar).
//
// Args (Borsh after the 8-byte discriminator):
//   client_data_json: Vec<u8>
//   authenticator_data: Vec<u8>
//
// IMPORTANT: there is NO session_pubkey arg. The on-chain handler reads
// the session pubkey from vault.active_session directly. The session
// pubkey IS part of the 128-byte signed message (the program rebuilds it
// from on-chain state), but it is NOT a tx arg.

export interface BuildRevokeSessionKeyArgs {
  vaultPda: PublicKey;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

export function buildRevokeSessionKeyInstruction(
  args: BuildRevokeSessionKeyArgs,
): TransactionInstruction {
  const data = concatBytes(
    REVOKE_SESSION_KEY_DISC,
    encodeVecU8(args.clientDataJSON),
    encodeVecU8(args.authenticatorData),
  );

  return new TransactionInstruction({
    keys: [
      { pubkey: args.vaultPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    programId: DEXTER_VAULT_PROGRAM_ID,
    data: Buffer.from(data),
  });
}
