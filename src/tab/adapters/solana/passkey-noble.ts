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
 * signature over `authenticatorData || sha256(clientDataJSON)`. For V7,
 * `clientDataJSON.challenge` is the canonical 200-byte authorization envelope
 * binding program, vault, monotonic guard nonce, operation hash, and fresh
 * ceremony entropy.
 *
 * This module mirrors the helper at
 * dexter-vault/tests/helpers/secp256r1.ts (signOperationWithPasskey).
 * Keep them in lockstep.
 */

import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { PublicKey } from '@solana/web3.js';
import {
  buildPasskeyAuthorizationChallenge,
  classifyPasskeyAuthorizationOperation,
} from '@dexterai/vault';
import { sessionVoucherV2AuthorizationNonce } from '@dexterai/vault/messages';

import type { PasskeySignerWithPublicKey } from '@dexterai/vault/signers';

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
 * on-chain verifier parses `challenge` out of this and validates the complete
 * authorization envelope, so the field name and base64url encoding must be
 * exact.
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

export interface NodePasskeyAuthorizationContext {
  programId: PublicKey;
  vault: PublicKey;
  nonce: bigint;
}

export interface NodePasskeySignerOptions {
  /**
   * Optional authoritative nonce resolver for operations whose wire format
   * does not itself carry enough guard-generation context. The session V2
   * register/replace/revoke messages are recognized locally; callers using
   * this development signer for any other V7 operation should provide this.
   */
  resolveAuthorizationContext?: (
    operationMessage: Uint8Array,
  ) => Promise<NodePasskeyAuthorizationContext>;
  /**
   * Explicit opt-in for pre-V7 development fixtures whose challenge was the
   * bare sha256(operation). The safe default is false: an unknown operation
   * must never be signed under a weaker authorization envelope merely because
   * the node helper did not recognize its wire format.
   */
  allowLegacyOperationHash?: boolean;
  /** Deterministic test seam. Production defaults to fresh random 32 bytes. */
  ceremonyNonce?: () => Uint8Array;
}

/**
 * Legacy helper for pre-V7 fixtures whose challenge was exactly
 * `sha256(operation)`. Supported V7 session operations must use
 * `passkeySignerFromP256Keypair`, which constructs the canonical envelope.
 *
 * On the chain side, the program:
 *   1. Reads its sibling precompile instruction from the instructions sysvar
 *   2. Asserts the precompile verified `authenticatorData || sha256(clientDataJSON)`
 *   3. Parses and validates the challenge against the operation the program
 *      reconstructs from its args
 *
 * The "operation message" is one of: setSwig, requestWithdrawal, registerSessionKey, etc.
 * For tab streaming, the operation is the canonical versioned registration,
 * replacement, or revocation message produced by messages.ts.
 */
export function signOperationWithPasskey(
  keypair: P256Keypair,
  operationMessage: Uint8Array,
): SignedPasskeyPayload {
  // The challenge baked into clientDataJSON is sha256(operationMessage).
  // The on-chain handler recomputes this from its args and refuses the
  // tx if it doesn't match. Delegates to signChallenge so the node and
  // unified-signer paths share one byte-exact ceremony.
  const challenge = sha256(operationMessage);
  const { signature, clientDataJSON, authenticatorData } = signChallenge(keypair, challenge);
  const precompileMessage = new Uint8Array(authenticatorData.length + 32);
  precompileMessage.set(authenticatorData, 0);
  precompileMessage.set(sha256(clientDataJSON), authenticatorData.length);
  return { clientDataJSON, authenticatorData, precompileMessage, signature };
}

/**
 * The low-level WebAuthn ceremony for the node path. Builds clientDataJSON /
 * authenticatorData from the GIVEN challenge (legacy hash or canonical V7
 * envelope, as selected by the caller) and returns the same three buffers
 * the vault's browser signer's assertion produces. Crucially it does NOT
 * assemble `precompileMessage` — that's x402-protocol assembly the adapter
 * rebuilds itself, identical on both the node and browser paths.
 *
 * `passkeySignerFromP256Keypair` wraps this with Vault 0.43.1's canonical
 * V7 challenge construction for supported session operations.
 */
export function signChallenge(
  keypair: P256Keypair,
  challenge: Uint8Array,
): { signature: Uint8Array; clientDataJSON: Uint8Array; authenticatorData: Uint8Array } {
  const clientDataJSON = buildClientDataJSON(challenge);
  const authenticatorData = buildAuthenticatorData(1);

  // The precompile verifies authenticatorData || sha256(clientDataJSON);
  // we sign over its sha256. (The adapter rebuilds the same precompile
  // message to feed buildSecp256r1VerifyInstruction.)
  const precompileMessage = new Uint8Array(authenticatorData.length + 32);
  precompileMessage.set(authenticatorData, 0);
  precompileMessage.set(sha256(clientDataJSON), authenticatorData.length);

  // P-256 over sha256(precompileMessage). lowS:true matches the
  // precompile's strict canonical-form check.
  const messageHash = sha256(precompileMessage);
  const sig = p256.sign(messageHash, keypair.privateKey, { lowS: true });
  const signature = sig.toCompactRawBytes();

  return { signature, clientDataJSON, authenticatorData };
}

/**
 * Build a unified `PasskeySignerWithPublicKey` (Vault 0.43.1's canonical shape)
 * from a locally-held P-256 keypair — the node/CLI path. Returns
 * `{ credentialId, publicKey, signOperation(operationMessage) }`. The signer
 * owns canonical challenge construction for recognized V7 session operations,
 * so the adapter hands it the RAW operation message and never pre-hashes.
 * The adapter still rebuilds the precompile message from the returned bytes.
 *
 * `credentialId` is empty for the node path — there is no platform
 * authenticator credential; the on-chain verifier authenticates via the
 * secp256r1 precompile over the clientDataJSON/authenticatorData, not the
 * credentialId, so an empty value is correct here.
 */
export function passkeySignerFromP256Keypair(
  kp: P256Keypair,
  options: NodePasskeySignerOptions = {},
): PasskeySignerWithPublicKey {
  return {
    credentialId: new Uint8Array(0),
    publicKey: kp.publicKey,
    signOperation: async (operationMessage) => {
      const context = options.resolveAuthorizationContext
        ? await options.resolveAuthorizationContext(operationMessage.slice())
        : inferSessionAuthorizationContext(operationMessage);
      if (!context) {
        if (options.allowLegacyOperationHash === true) {
          return signChallenge(kp, sha256(operationMessage));
        }
        throw new Error('passkey_authorization_context_required');
      }
      const ceremonyNonce = options.ceremonyNonce
        ? options.ceremonyNonce()
        : p256.utils.randomPrivateKey();
      if (ceremonyNonce.length !== 32) {
        throw new Error('ceremonyNonce must be exactly 32 bytes');
      }
      const challenge = buildPasskeyAuthorizationChallenge({
        programId: context.programId,
        vault: context.vault,
        nonce: context.nonce,
        operationHash: sha256(operationMessage),
        ceremonyNonce,
      });
      return signChallenge(kp, challenge);
    },
  };
}

function inferSessionAuthorizationContext(
  operationMessage: Uint8Array,
): NodePasskeyAuthorizationContext | null {
  const classified = classifyPasskeyAuthorizationOperation(operationMessage);
  if (classified.kind === 'session_register_v2') {
    return {
      programId: classified.fields.programId,
      vault: classified.fields.vault,
      nonce: BigInt(
        sessionVoucherV2AuthorizationNonce(
          classified.fields.registrationNonce,
        ),
      ),
    };
  }
  if (classified.kind === 'session_replace_v1') {
    return {
      programId: classified.fields.programId,
      vault: classified.fields.vault,
      nonce: classified.fields.authorizationNonce,
    };
  }

  // Revoke V2/V3 deliberately does not infer the live authorization nonce.
  // Other passkey operations may have advanced the guard since session
  // registration, so the caller must resolve the authoritative value at the
  // moment of the close ceremony.
  return null;
}
