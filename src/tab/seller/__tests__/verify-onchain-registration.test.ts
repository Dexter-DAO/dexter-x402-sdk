import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';

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

function accountData(state = activeState()): Buffer {
  const data = Buffer.alloc(162);
  Buffer.from([74, 34, 65, 133, 96, 163, 80, 69]).copy(data, 0);
  data.writeUInt8(state.version, 8);
  data.writeUInt8(state.bump, 9);
  new PublicKey(state.vault).toBuffer().copy(data, 10);
  Buffer.from(state.session.sessionPubkey).copy(data, 42);
  data.writeBigUInt64LE(state.session.maxAmount, 74);
  data.writeBigInt64LE(BigInt(state.session.expiresAt), 82);
  new PublicKey(state.session.allowedCounterparty).toBuffer().copy(data, 90);
  data.writeUInt32LE(state.session.nonce, 122);
  data.writeBigUInt64LE(state.session.spent, 126);
  data.writeBigUInt64LE(state.session.currentOutstanding, 134);
  data.writeBigUInt64LE(state.session.maxRevolvingCapacity, 142);
  data.writeBigUInt64LE(state.session.crystallizedCumulative, 150);
  data.writeUInt32LE(state.session.lastLockedSequence, 158);
  return data;
}

function accountInfo(
  state = activeState(),
  owner: PublicKey = DEXTER_VAULT_PROGRAM_ID,
) {
  return {
    data: accountData(state),
    owner,
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  };
}

const getAccountInfo = vi.fn();
const connection = { getAccountInfo } as unknown as Connection;

describe('verifyRegistrationOnChain exact immutable registration witness', () => {
  beforeEach(() => {
    getAccountInfo.mockReset();
    getAccountInfo.mockResolvedValue(accountInfo());
  });

  it('accepts the exact 188-byte registration and returns the authoritative V2 reservation state', async () => {
    await expect(verifyRegistrationOnChain(
      connection,
      registration(),
    )).resolves.toEqual({
      sessionAccountVersion: 1,
      wireVersion: 2,
      frontierAtomic: '20',
      spentAtomic: '10',
      currentOutstandingAtomic: '0',
      crystallizedCumulativeAtomic: '20',
    });
    expect(getAccountInfo).toHaveBeenCalledWith(
      SESSION_PDA,
      'finalized',
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
      connection,
      registration(forged),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OnChainVerificationError);
    expect(error).toMatchObject({
      reason: 'sessionPubkey' in forged
        ? 'session_pubkey_mismatch'
        : 'registration_state_mismatch',
    });
  });

  it('rejects a V2 voucher registration when the active SessionAccount is V1', async () => {
    const state = activeState();
    state.session.nonce = 7;
    getAccountInfo.mockResolvedValue(accountInfo(state));

    const error = await verifyRegistrationOnChain(
      connection,
      registration(),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OnChainVerificationError);
    expect(error).toMatchObject({ reason: 'wire_version_mismatch' });
  });

  it('rejects a reservation visible only at confirmed commitment', async () => {
    getAccountInfo.mockImplementation(async (_address, commitment) => (
      commitment === 'confirmed' ? accountInfo() : null
    ));

    const error = await verifyRegistrationOnChain(
      connection,
      registration(),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OnChainVerificationError);
    expect(error).toMatchObject({ reason: 'session_not_active' });
    expect(getAccountInfo).toHaveBeenCalledOnce();
    expect(getAccountInfo).toHaveBeenCalledWith(SESSION_PDA, 'finalized');
  });

  it('rejects a finalized PDA owned by any program other than the registration program', async () => {
    getAccountInfo.mockResolvedValue(accountInfo(
      activeState(),
      Keypair.generate().publicKey,
    ));

    const error = await verifyRegistrationOnChain(
      connection,
      registration(),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OnChainVerificationError);
    expect(error).toMatchObject({ reason: 'wrong_program' });
  });
});
