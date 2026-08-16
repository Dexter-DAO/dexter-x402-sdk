import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';

const mocks = vi.hoisted(() => ({
  fetchSessionAccount: vi.fn(),
}));

vi.mock('@dexterai/vault/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dexterai/vault/session')>();
  return {
    ...actual,
    fetchSessionAccount: mocks.fetchSessionAccount,
  };
});

import { sessionRegisterMessage } from '@dexterai/vault/messages';
import { deriveSessionPda } from '@dexterai/vault/session';
import { DEXTER_VAULT_PROGRAM_ID } from '../../instructions';
import {
  OnChainVerificationError,
  parseRegistration,
  verifyRegistrationOnChain,
} from '../verify';

const VAULT = Keypair.generate().publicKey;
const SELLER = Keypair.generate().publicKey;
const SESSION = Keypair.generate().publicKey.toBytes();
const EXPIRY = Math.floor(Date.now() / 1_000) + 3_600;
const [SESSION_PDA] = deriveSessionPda(
  VAULT,
  SELLER,
  DEXTER_VAULT_PROGRAM_ID,
);

const immutable = {
  vault: VAULT,
  seller: SELLER,
  sessionPubkey: SESSION,
  maxAmount: 1_000n,
  expiresAt: EXPIRY,
  nonce: 0x8000_0007,
  maxRevolvingCapacity: 500n,
};

function registration(overrides: Partial<typeof immutable> = {}) {
  const value = { ...immutable, ...overrides };
  return parseRegistration(sessionRegisterMessage({
    programId: DEXTER_VAULT_PROGRAM_ID,
    vaultPda: value.vault,
    sessionPubkey: value.sessionPubkey,
    maxAmount: value.maxAmount,
    expiresAt: BigInt(value.expiresAt),
    allowedCounterparty: value.seller,
    nonce: value.nonce,
    maxRevolvingCapacity: value.maxRevolvingCapacity,
  }));
}

function activeState() {
  return {
    address: SESSION_PDA.toBase58(),
    version: 1,
    bump: 255,
    vault: VAULT.toBase58(),
    session: {
      sessionPubkey: SESSION,
      maxAmount: immutable.maxAmount,
      expiresAt: immutable.expiresAt,
      allowedCounterparty: SELLER.toBase58(),
      nonce: immutable.nonce,
      spent: 10n,
      currentOutstanding: 0n,
      maxRevolvingCapacity: immutable.maxRevolvingCapacity,
      crystallizedCumulative: 20n,
      lastLockedSequence: 0x8000_0001,
    },
  };
}

describe('verifyRegistrationOnChain exact immutable registration witness', () => {
  beforeEach(() => {
    mocks.fetchSessionAccount.mockReset();
    mocks.fetchSessionAccount.mockResolvedValue(activeState());
  });

  it('accepts the exact 188-byte registration and returns only mutable frontier data', async () => {
    await expect(verifyRegistrationOnChain(
      {} as Connection,
      registration(),
    )).resolves.toEqual({
      frontierAtomic: '20',
      spentAtomic: '10',
      crystallizedCumulativeAtomic: '20',
    });
    expect(mocks.fetchSessionAccount).toHaveBeenCalledWith(
      expect.anything(),
      VAULT,
      SELLER,
      DEXTER_VAULT_PROGRAM_ID,
    );
  });

  it.each([
    ['session key', { sessionPubkey: Keypair.generate().publicKey.toBytes() }],
    ['cap', { maxAmount: 1_000_000n }],
    ['expiry', { expiresAt: EXPIRY + 600 }],
    ['nonce', { nonce: 0x8000_0008 }],
    ['revolving capacity', { maxRevolvingCapacity: 900n }],
  ] as const)('rejects a forged %s before seller delivery', async (_label, forged) => {
    const error = await verifyRegistrationOnChain(
      {} as Connection,
      registration(forged),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OnChainVerificationError);
    expect(error).toMatchObject({
      reason: 'sessionPubkey' in forged
        ? 'session_pubkey_mismatch'
        : 'registration_state_mismatch',
    });
  });
});
