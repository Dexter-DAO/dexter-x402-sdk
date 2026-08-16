import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { sessionRegisterMessage } from '@dexterai/vault/messages';
import { DEXTER_VAULT_PROGRAM_ID } from '../../instructions';
import type { SignedVoucher } from '../../types';
import { verifyVoucherSignature } from '../verify';

const VAULT = Keypair.generate().publicKey;
const SELLER = Keypair.generate().publicKey;
const SESSION = Keypair.generate().publicKey.toBytes();
const CHANNEL = new Uint8Array(32).fill(7);

function voucher(registrationNonce: number, sequenceNumber: number): SignedVoucher {
  return {
    payload: {
      channelId: Buffer.from(CHANNEL).toString('hex'),
      cumulativeAmount: '1',
      sequenceNumber,
    },
    sessionPublicKey: SESSION,
    sessionRegistration: sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: VAULT,
      sessionPubkey: SESSION,
      maxAmount: 100n,
      expiresAt: 2_000_000_000n,
      allowedCounterparty: SELLER,
      nonce: registrationNonce,
      maxRevolvingCapacity: 100n,
    }),
    sessionSignature: new Uint8Array(64),
  };
}

describe('seller voucher wire-version binding', () => {
  it('rejects a V1 sequence under an active V2 registration', () => {
    expect(() => verifyVoucherSignature(
      voucher(0x8000_0007, 1),
      CHANNEL,
    )).toThrow(/voucher wire V1 does not match registration wire V2/);
  });

  it('rejects a V2 sequence under an active historical V1 registration', () => {
    expect(() => verifyVoucherSignature(
      voucher(7, 0x8000_0001),
      CHANNEL,
    )).toThrow(/voucher wire V2 does not match registration wire V1/);
  });
});
