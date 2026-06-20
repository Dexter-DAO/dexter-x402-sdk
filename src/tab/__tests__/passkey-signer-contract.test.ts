/**
 * Passkey signer CONTRACT proof — vault 0.19 `signOperation(operationMessage)`.
 *
 * After the 0.13 -> 0.19 unification the hashing locus moved INTO the signer:
 * the adapter hands the signer a RAW operation message and the signer computes
 * `challenge = sha256(operationMessage)` itself (previously the adapter
 * pre-hashed and called `sign(challenge)`). This test pins that contract and
 * proves the produced bytes against the REAL verification math the on-chain
 * secp256r1 (SIMD-0075) precompile runs — p256 ECDSA verify over
 * `sha256(authenticatorData || sha256(clientDataJSON))` — NOT a stub.
 *
 * It would FAIL on the exact class of bug that bit the SDK signer earlier: if
 * `signOperation` did not hash the message, the challenge-binding assert below
 * (clientDataJSON.challenge === sha256(operationMessage)) would break, which is
 * precisely what dexter-vault's webauthn.rs enforces on chain.
 */

import { describe, test, expect } from 'vitest';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';

import {
  generateP256Keypair,
  passkeySignerFromP256Keypair,
} from '../adapters/solana/passkey-noble';

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return new Uint8Array(Buffer.from(b64 + pad, 'base64'));
}

/** The precompile verifies p256 ECDSA over sha256(authenticatorData ‖ sha256(clientDataJSON)). */
function precompileMessageHash(
  authenticatorData: Uint8Array,
  clientDataJSON: Uint8Array,
): Uint8Array {
  const cdHash = sha256(clientDataJSON);
  const precompileMessage = new Uint8Array(authenticatorData.length + cdHash.length);
  precompileMessage.set(authenticatorData, 0);
  precompileMessage.set(cdHash, authenticatorData.length);
  return sha256(precompileMessage);
}

describe('node passkey signer — signOperation(operationMessage) contract', () => {
  // A realistic raw operation message (any bytes; the contract is identical).
  const operationMessage = new TextEncoder().encode(
    'dexter-vault:register_session_key:test-op-message-' + 'x'.repeat(64),
  );

  test('exposes vault 0.19 shape: { credentialId, publicKey, signOperation }', () => {
    const kp = generateP256Keypair();
    const signer = passkeySignerFromP256Keypair(kp);
    expect(signer.publicKey).toEqual(kp.publicKey);
    expect(signer.publicKey).toHaveLength(33); // SEC1 compressed
    expect(signer.credentialId).toEqual(new Uint8Array(0)); // node path: empty
    expect(typeof signer.signOperation).toBe('function');
    // The old contract is GONE — no .sign(challenge) on the signer.
    expect((signer as unknown as Record<string, unknown>).sign).toBeUndefined();
  });

  test('binds the WebAuthn challenge to sha256(operationMessage) (the on-chain law)', async () => {
    const kp = generateP256Keypair();
    const signer = passkeySignerFromP256Keypair(kp);

    const { clientDataJSON } = await signer.signOperation(operationMessage);

    const cd = JSON.parse(new TextDecoder().decode(clientDataJSON));
    expect(cd.type).toBe('webauthn.get');
    // The signer hashed internally: challenge MUST decode to sha256(op).
    expect(base64urlDecode(cd.challenge)).toEqual(sha256(operationMessage));
  });

  test('produced bytes verify against the real secp256r1 precompile math', async () => {
    const kp = generateP256Keypair();
    const signer = passkeySignerFromP256Keypair(kp);

    const { signature, clientDataJSON, authenticatorData } =
      await signer.signOperation(operationMessage);

    expect(signature).toHaveLength(64); // compact r‖s
    const msgHash = precompileMessageHash(authenticatorData, clientDataJSON);
    // This is exactly what the on-chain precompile checks. Reverts on chain
    // if false; here it must be true.
    expect(p256.verify(signature, msgHash, kp.publicKey)).toBe(true);
  });

  test('signature does NOT verify under a different operation message (replay/tamper guard)', async () => {
    const kp = generateP256Keypair();
    const signer = passkeySignerFromP256Keypair(kp);

    const { signature, clientDataJSON, authenticatorData } =
      await signer.signOperation(operationMessage);

    // Tamper the clientDataJSON (flip a byte) -> the precompile message hash
    // changes -> the precompile would reject.
    const tampered = Uint8Array.from(clientDataJSON);
    tampered[tampered.length - 2] ^= 0xff;
    const tamperedHash = precompileMessageHash(authenticatorData, tampered);
    expect(p256.verify(signature, tamperedHash, kp.publicKey)).toBe(false);
  });

  test('signature does NOT verify under a different public key', async () => {
    const kp = generateP256Keypair();
    const other = generateP256Keypair();
    const signer = passkeySignerFromP256Keypair(kp);

    const { signature, clientDataJSON, authenticatorData } =
      await signer.signOperation(operationMessage);

    const msgHash = precompileMessageHash(authenticatorData, clientDataJSON);
    expect(p256.verify(signature, msgHash, other.publicKey)).toBe(false);
  });
});
