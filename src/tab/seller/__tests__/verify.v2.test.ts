import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { sessionRegisterMessage } from '@dexterai/vault/messages';
import { parseRegistration, InvalidRegistrationError } from '../verify';
import { DEXTER_VAULT_PROGRAM_ID } from '../../instructions';

describe('parseRegistration V2/188', () => {
  const validBytes = () =>
    sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: new PublicKey('Sysvar1nstructions1111111111111111111111111'),
      sessionPubkey: new Uint8Array(32).fill(0xAA),
      maxAmount: 1_000_000n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      allowedCounterparty: new PublicKey('Ed25519SigVerify111111111111111111111111111'),
      nonce: 42,
      maxRevolvingCapacity: 2_000_000n,
    });

  test('accepts a 188-byte V2 message and parses maxRevolvingCapacity', () => {
    const parsed = parseRegistration(validBytes());
    expect(parsed.maxAmount).toBe(1_000_000n);
    expect(parsed.maxRevolvingCapacity).toBe(2_000_000n);
    expect(parsed.nonce).toBe(42);
  });

  test('rejects a 180-byte (V1) message as wrong_length', () => {
    const short = validBytes().slice(0, 180);
    expect(() => parseRegistration(short)).toThrow(InvalidRegistrationError);
  });
});
