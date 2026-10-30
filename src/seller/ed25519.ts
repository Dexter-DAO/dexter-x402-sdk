import { ed25519 } from '@noble/curves/ed25519';

export function verifyEd25519Strict(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    if (signature.length !== 64 || publicKey.length !== 32) return false;
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch { return false; }
}
