/**
 * CLI / Node passkey signer using @noble/curves/p256.
 *
 * In the browser, the vault's root authority is a WebAuthn credential —
 * the user taps a Touch ID prompt and the browser hands back a
 * clientDataJSON / authenticatorData / signature triple. In CLI and Node
 * environments we have no platform passkey, so we use noble-curves to
 * sign with a locally-stored P-256 keypair, then synthesize the same
 * clientDataJSON / authenticatorData shape the on-chain verifier expects.
 *
 * From the on-chain program's perspective the two paths are
 * indistinguishable: both produce a 64-byte (r||s) low-S secp256r1
 * signature over `authenticatorData || sha256(clientDataJSON)`, where
 * `clientDataJSON.challenge` base64url-decodes to sha256(operation_msg).
 *
 * This module mirrors the helper at
 * dexter-vault/tests/helpers/secp256r1.ts (signOperationWithPasskey).
 * Keep them in lockstep.
 */

import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';

// ── Constants ──────────────────────────────────────────────────────────

/** Relying-party id baked into authenticatorData's rpIdHash. */
const RP_ID = 'dexter.cash';

// ── P-256 keypair ──────────────────────────────────────────────────────

export interface P256Keypair {
  /** 33-byte SEC1 compressed public key (the form the vault stores). */
  publicKey: Uint8Array;
  /** 32-byte raw scalar. NEVER persist this anywhere user-readable. */
  privateKey: Uint8Array;
}

/** Generate a fresh P-256 keypair. The private key is just bytes — the
 *  caller decides where to put it. */
export function generateP256Keypair(): P256Keypair {
  const privateKey = p256.utils.randomPrivateKey();
  const publicKey = p256.getPublicKey(privateKey, true); // compressed
  return { privateKey, publicKey };
}

/** Reconstruct the compressed pubkey for a known private key. Useful when
 *  loading a keypair from a file. */
export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  return p256.getPublicKey(privateKey, true);
}

// ── WebAuthn ceremony synthesis ────────────────────────────────────────

function base64urlEncode(input: Uint8Array): string {
  // Match the browser's WebAuthn base64url: no padding, +/ → -_.
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Synthesize a clientDataJSON with the shape WebAuthn produces. The
 * on-chain verifier parses `challenge` out of this and asserts it matches
 * sha256(operationMessage), so the field name and base64url encoding must
 * be exact.
 */
function buildClientDataJSON(challengeBytes: Uint8Array, origin = `https://${RP_ID}`): Uint8Array {
  const challenge = base64urlEncode(challengeBytes);
  const obj = {
    type: 'webauthn.get',
    challenge,
    origin,
    crossOrigin: false,
  };
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Synthesize the minimal authenticatorData WebAuthn ceremonies produce:
 *   - 32 bytes: rpIdHash = sha256(RP_ID)
 *   - 1 byte:   flags (UP=0x01 | UV=0x04 = 0x05)
 *   - 4 bytes:  signCount (big-endian u32 — yes, big-endian, per WebAuthn)
 */
function buildAuthenticatorData(signCount = 1): Uint8Array {
  const rpIdHash = sha256(new TextEncoder().encode(RP_ID));
  const out = new Uint8Array(32 + 1 + 4);
  out.set(rpIdHash, 0);
  out[32] = 0x05;
  new DataView(out.buffer).setUint32(33, signCount, false); // BE per spec
  return out;
}

// ── Signed payload — the bundle the vault instruction takes ────────────

export interface SignedPasskeyPayload {
  /** Pass straight into the vault instruction's `client_data_json` arg. */
  clientDataJSON: Uint8Array;
  /** Pass straight into the vault instruction's `authenticator_data` arg. */
  authenticatorData: Uint8Array;
  /** Pass to buildSecp256r1VerifyInstruction as `message`. */
  precompileMessage: Uint8Array;
  /** Pass to buildSecp256r1VerifyInstruction as `signature`. */
  signature: Uint8Array;
}

/**
 * Run the full ceremony for a given operation message. The ceremony binds
 * the signature to the operation by way of `challenge = sha256(operation)`
 * embedded in the clientDataJSON.
 *
 * On the chain side, the program:
 *   1. Reads its sibling precompile instruction from the instructions sysvar
 *   2. Asserts the precompile verified `authenticatorData || sha256(clientDataJSON)`
 *   3. Parses `challenge` from clientDataJSON and asserts it == sha256(operation_msg)
 *      that the program itself reconstructs from its args
 *
 * The "operation message" is one of: setSwig, requestWithdrawal, registerSessionKey, etc.
 * For tab streaming, the operation is the 180-byte registration or 128-byte revocation
 * message produced by messages.ts.
 */
export function signOperationWithPasskey(
  keypair: P256Keypair,
  operationMessage: Uint8Array,
): SignedPasskeyPayload {
  // The challenge baked into clientDataJSON is sha256(operationMessage).
  // The on-chain handler recomputes this from its args and refuses the
  // tx if it doesn't match.
  const challenge = sha256(operationMessage);

  const clientDataJSON = buildClientDataJSON(challenge);
  const authenticatorData = buildAuthenticatorData(1);

  // The precompile actually verifies authenticatorData || sha256(clientDataJSON).
  const precompileMessage = new Uint8Array(
    authenticatorData.length + 32,
  );
  precompileMessage.set(authenticatorData, 0);
  precompileMessage.set(sha256(clientDataJSON), authenticatorData.length);

  // P-256 over sha256(precompileMessage). lowS:true matches the
  // precompile's strict canonical-form check.
  const messageHash = sha256(precompileMessage);
  const sig = p256.sign(messageHash, keypair.privateKey, { lowS: true });
  const signature = sig.toCompactRawBytes();

  return {
    clientDataJSON,
    authenticatorData,
    precompileMessage,
    signature,
  };
}
