import { describe, it, expect } from 'vitest';
import { toSiwxSigner } from '../siwx-signer';
import { createEvmKeypairWallet } from '../../client/evm-wallet';
import { createKeypairWallet } from '../../client/keypair-wallet';

const EVM_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// A valid 64-byte Solana secret key (throwaway, unfunded).
// The plan's arithmetic sequence was invalid (last 32 bytes must be the Ed25519
// public key derived from the first 32); replaced with a generated valid keypair.
const SOL_KEY = [67,109,148,88,104,130,207,45,132,13,193,14,105,72,246,237,125,209,65,53,3,206,195,178,230,59,117,106,8,61,188,69,239,3,69,216,4,232,166,22,203,56,1,168,39,140,87,30,106,184,169,159,46,190,182,99,157,32,186,152,215,224,0,184];

describe('toSiwxSigner', () => {
  it('returns null for an empty wallet set', () => {
    expect(toSiwxSigner({})).toBeNull();
  });

  it('derives an EVM SIW-X signer that signs strings', async () => {
    const evm = await createEvmKeypairWallet(EVM_KEY);
    const signer = toSiwxSigner({ evm });
    expect(signer).not.toBeNull();
    const sig = await (signer as { signMessage: (a: { message: string }) => Promise<string> })
      .signMessage({ message: 'siwx test' });
    expect(sig).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('prefers EVM when both wallets are present', async () => {
    const evm = await createEvmKeypairWallet(EVM_KEY);
    const solana = await createKeypairWallet(SOL_KEY);
    const signer = toSiwxSigner({ evm, solana });
    expect(typeof (signer as { address?: string }).address).toBe('string');
    expect((signer as { address: string }).address.startsWith('0x')).toBe(true);
  });

  it('derives a Solana SIW-X signer that signs byte messages', async () => {
    const solana = await createKeypairWallet(SOL_KEY);
    const signer = toSiwxSigner({ solana }) as {
      signMessage: (m: Uint8Array) => Promise<Uint8Array>;
      publicKey: { toBase58: () => string };
    };
    expect(signer).not.toBeNull();
    const out = await signer.signMessage(new Uint8Array([1, 2, 3]));
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(64); // Ed25519 signature is 64 bytes.
    expect(typeof signer.publicKey.toBase58()).toBe('string');
  });
});
