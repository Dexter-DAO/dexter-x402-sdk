import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { DEXTER_VAULT_PROGRAM_ID } from '../instructions';
import {
  finalVoucherV2Sequence,
  sessionRegisterMessage,
  sessionVoucherV2Nonce,
} from '@dexterai/vault/messages';
import { deriveSessionPda } from '@dexterai/vault/session';
import {
  signContextBoundFinalVoucherV2,
  signVoucher,
} from '../sessions';
import { verifyVoucherSignature } from '../seller/verify';
import type { SessionKey, SignedVoucher } from '../types';

const VAULT = Keypair.generate().publicKey;
const SELLER = Keypair.generate().publicKey;
const SESSION = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
const NONCE = sessionVoucherV2Nonce(7n);
const CHANNEL = '11'.repeat(32);
const REGISTRATION = sessionRegisterMessage({
  programId: DEXTER_VAULT_PROGRAM_ID,
  vaultPda: VAULT,
  sessionPubkey: SESSION.publicKey,
  maxAmount: 1_000n,
  expiresAt: 2_000_000_000n,
  allowedCounterparty: SELLER,
  nonce: NONCE,
  maxRevolvingCapacity: 500n,
});
const [SESSION_PDA] = deriveSessionPda(
  VAULT,
  SELLER,
  DEXTER_VAULT_PROGRAM_ID,
);

describe('Native Tab V2 x402 signer and seller verifier', () => {
  it('signs one FINAL context-bound obligation that the seller verifies', () => {
    const signed = signContextBoundFinalVoucherV2({
      programId: DEXTER_VAULT_PROGRAM_ID.toBase58(),
      vaultPda: VAULT.toBase58(),
      sessionPda: SESSION_PDA.toBase58(),
      seller: SELLER.toBase58(),
      sessionNonce: NONCE,
      channelId: CHANNEL,
      cumulativeAmountAtomic: '125',
      sequenceOrdinal: 1,
      sessionPrivateKey: SESSION.secretKey,
      sessionPublicKey: SESSION.publicKey,
      sessionRegistration: REGISTRATION,
    });

    expect(signed.sequenceNumber).toBe(finalVoucherV2Sequence(1));
    expect(signed.sessionPublicKey).toBe(
      Buffer.from(SESSION.publicKey).toString('hex'),
    );
    const voucher: SignedVoucher = {
      payload: {
        channelId: CHANNEL,
        cumulativeAmount: signed.cumulativeAmount,
        sequenceNumber: signed.sequenceNumber,
      },
      sessionPublicKey: SESSION.publicKey,
      sessionSignature: Uint8Array.from(
        Buffer.from(signed.sessionSignature, 'hex'),
      ),
      sessionRegistration: REGISTRATION,
    };
    expect(() =>
      verifyVoucherSignature(
        voucher,
        Uint8Array.from(Buffer.from(CHANNEL, 'hex')),
      ),
    ).not.toThrow();
  });

  it('rejects context drift and the legacy signer on a V2 registration', () => {
    const otherVault = Keypair.generate().publicKey;
    const [otherSessionPda] = deriveSessionPda(
      otherVault,
      SELLER,
      DEXTER_VAULT_PROGRAM_ID,
    );
    expect(() =>
      signContextBoundFinalVoucherV2({
        programId: DEXTER_VAULT_PROGRAM_ID.toBase58(),
        vaultPda: otherVault.toBase58(),
        sessionPda: otherSessionPda.toBase58(),
        seller: SELLER.toBase58(),
        sessionNonce: NONCE,
        channelId: CHANNEL,
        cumulativeAmountAtomic: '125',
        sequenceOrdinal: 1,
        sessionPrivateKey: SESSION.secretKey,
        sessionPublicKey: SESSION.publicKey,
        sessionRegistration: REGISTRATION,
      }),
    ).toThrow(/registration_identity_mismatch/);

    const legacyShape: SessionKey = {
      publicKey: SESSION.publicKey,
      privateKey: SESSION.secretKey,
      registration: REGISTRATION,
      scope: {
        channelId: CHANNEL,
        maxAmountAtomic: '1000',
        expiresAtUnix: 2_000_000_000,
        allowedCounterparty: SELLER.toBase58(),
      },
    };
    expect(() =>
      signVoucher(
        legacyShape,
        {
          channelId: CHANNEL,
          cumulativeAmount: '125',
          sequenceNumber: 1,
        },
        Uint8Array.from(Buffer.from(CHANNEL, 'hex')),
      ),
    ).toThrow(/durable reservation/);
  });
});
