import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, Transaction, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { deriveSessionPda } from '@dexterai/vault/session';
import {
  sessionRegisterMessage,
  sessionRevokeMessage,
  sessionVoucherV2Nonce,
} from '@dexterai/vault/messages';
import { validatePasskeyAuthorizationClientData } from '@dexterai/vault';

import { createSolanaVaultAdapter } from '../adapters/solana/index';
import {
  generateP256Keypair,
  passkeySignerFromP256Keypair,
} from '../adapters/solana/passkey-noble';
import { DEXTER_VAULT_PROGRAM_ID } from '../instructions';
import { generateSessionKeypair, makeSessionKey } from '../sessions';
import type { SessionKey, SessionScope } from '../types';

const VAULT = Keypair.generate().publicKey;
const SWIG = Keypair.generate().publicKey;
const SELLER = Keypair.generate().publicKey;
const FEE_PAYER = Keypair.generate();
const SESSION_PDA = deriveSessionPda(VAULT, SELLER)[0];
const AUTHORIZATION_NONCE = 23n;
const SESSION_NONCE = sessionVoucherV2Nonce(AUTHORIZATION_NONCE);
const EXPIRES_AT = Math.floor(Date.now() / 1_000) + 3_600;
const MAX_AMOUNT = 2_000_000n;
const MAX_REVOLVING_CAPACITY = 1_500_000n;
const FINAL_CUMULATIVE = 1_000_000n;

function createSession(): SessionKey {
  const keypair = generateSessionKeypair();
  const scope: SessionScope = {
    channelId: 'c'.repeat(64),
    maxAmountAtomic: MAX_AMOUNT.toString(),
    revolvingCapacityAtomic: MAX_REVOLVING_CAPACITY.toString(),
    expiresAtUnix: EXPIRES_AT,
    allowedCounterparty: SELLER.toBase58(),
  };
  const registration = sessionRegisterMessage({
    programId: DEXTER_VAULT_PROGRAM_ID,
    vaultPda: VAULT,
    sessionPubkey: keypair.publicKey,
    maxAmount: MAX_AMOUNT,
    expiresAt: BigInt(EXPIRES_AT),
    allowedCounterparty: SELLER,
    nonce: SESSION_NONCE,
    maxRevolvingCapacity: MAX_REVOLVING_CAPACITY,
  });
  return makeSessionKey(keypair, scope, registration);
}

function createConnection(confirmationError: unknown = null) {
  const sentRaw: Uint8Array[] = [];
  const connection = {
    sentRaw,
    getSlot: vi.fn(async () => 800),
    getBlockHeight: vi.fn(async () => 90),
    getMinimumLedgerSlot: vi.fn(async () => 0),
    getSignatureStatuses: vi.fn(async () => ({ value: [null] })),
    getTransaction: vi.fn(async () => null),
    isBlockhashValid: vi.fn(async () => ({
      context: { slot: 900 },
      value: false,
    })),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k',
      lastValidBlockHeight: 100,
    })),
    sendRawTransaction: vi.fn(async (raw: Uint8Array) => {
      sentRaw.push(raw);
      const transaction = Transaction.from(raw);
      if (!transaction.signature) throw new Error('unsigned test transaction');
      return bs58.encode(transaction.signature);
    }),
    confirmTransaction: vi.fn(async () => ({
      value: { err: confirmationError },
    })),
  };
  return connection as unknown as Connection & { sentRaw: Uint8Array[] };
}

function exactSnapshot(session: SessionKey) {
  return {
    contextSlot: 900,
    programId: DEXTER_VAULT_PROGRAM_ID,
    vaultPda: VAULT,
    sessionPda: SESSION_PDA,
    sessionPubkey: session.publicKey,
    maxAmount: MAX_AMOUNT,
    expiresAt: BigInt(EXPIRES_AT),
    allowedCounterparty: SELLER,
    nonce: SESSION_NONCE,
    spent: FINAL_CUMULATIVE,
    currentOutstanding: 0n,
    maxRevolvingCapacity: MAX_REVOLVING_CAPACITY,
    crystallizedCumulative: FINAL_CUMULATIVE - 50_000n,
    lastLockedSequence: 4,
    expectedPendingVoucherCount: 7,
  };
}

function createFixture(
  snapshot: ReturnType<typeof exactSnapshot>,
  confirmationError: unknown = null,
) {
  const connection = createConnection(confirmationError);
  const passkey = passkeySignerFromP256Keypair(generateP256Keypair(), {
    ceremonyNonce: () => new Uint8Array(32).fill(0x5a),
    resolveAuthorizationContext: async () => ({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vault: VAULT,
      nonce: AUTHORIZATION_NONCE + 1n,
    }),
  });
  const signOperation = vi.spyOn(passkey, 'signOperation');
  const readCloseRevocationSnapshot = vi.fn(async () => snapshot);
  const adapter = createSolanaVaultAdapter({
    connection,
    swigAddress: SWIG,
    vaultPda: VAULT,
    passkeySigner: passkey,
    feePayer: FEE_PAYER,
    seams: { readCloseRevocationSnapshot },
  });
  return {
    adapter,
    connection,
    signOperation,
    readCloseRevocationSnapshot,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Solana adapter close — Vault 0.43.2 exact-state revocation', () => {
  it('signs the authoritative post-settlement snapshot and carries the exact pending count', async () => {
    const session = createSession();
    const snapshot = exactSnapshot(session);
    const fixture = createFixture(snapshot);

    const message = await fixture.adapter.signCloseTab(
      session,
      session.scope.channelId,
      FINAL_CUMULATIVE.toString(),
    );

    const expectedMessage = sessionRevokeMessage(snapshot);
    expect(message).toEqual(expectedMessage);
    expect(fixture.signOperation).toHaveBeenCalledOnce();
    expect(fixture.signOperation).toHaveBeenCalledWith(expectedMessage);
    expect(fixture.readCloseRevocationSnapshot).toHaveBeenCalledWith({
      connection: fixture.connection,
      vaultPda: VAULT,
      allowedCounterparty: SELLER,
      programId: DEXTER_VAULT_PROGRAM_ID,
      commitment: 'finalized',
    });

    const ceremony = await fixture.signOperation.mock.results[0]!.value;
    const authorization = validatePasskeyAuthorizationClientData({
      clientDataJSON: ceremony.clientDataJSON,
      operationMessage: expectedMessage,
      expectedVault: VAULT,
      expectedProgramId: DEXTER_VAULT_PROGRAM_ID,
    });
    expect(authorization.nonce).toBe(AUTHORIZATION_NONCE + 1n);

    expect(fixture.connection.sentRaw).toHaveLength(1);
    const transaction = Transaction.from(fixture.connection.sentRaw[0]!);
    expect(transaction.instructions).toHaveLength(2);
    const revokeData = Buffer.from(transaction.instructions[1]!.data);
    // Anchor discriminator (8) + allowed_counterparty (32) precede the u32.
    expect(revokeData.readUInt32LE(40)).toBe(
      snapshot.expectedPendingVoucherCount,
    );
  });

  it('fails before the passkey prompt if the same-slot snapshot no longer matches the registration', async () => {
    const session = createSession();
    const snapshot = {
      ...exactSnapshot(session),
      maxAmount: MAX_AMOUNT + 1n,
    };
    const fixture = createFixture(snapshot);

    await expect(
      fixture.adapter.signCloseTab(
        session,
        session.scope.channelId,
        FINAL_CUMULATIVE.toString(),
      ),
    ).rejects.toThrow('session revocation snapshot identity mismatch');
    expect(fixture.signOperation).not.toHaveBeenCalled();
    expect(fixture.connection.sentRaw).toHaveLength(0);
  });

  it('fails before the passkey prompt when the RPC snapshot is behind final settlement', async () => {
    const session = createSession();
    const snapshot = {
      ...exactSnapshot(session),
      spent: FINAL_CUMULATIVE - 1n,
      crystallizedCumulative: FINAL_CUMULATIVE - 2n,
    };
    const fixture = createFixture(snapshot);

    await expect(
      fixture.adapter.signCloseTab(
        session,
        session.scope.channelId,
        FINAL_CUMULATIVE.toString(),
      ),
    ).rejects.toThrow('session revocation snapshot is behind final settlement');
    expect(fixture.signOperation).not.toHaveBeenCalled();
    expect(fixture.connection.sentRaw).toHaveLength(0);
  });

  it('rejects an on-chain revoke error instead of reporting confirmation success', async () => {
    const session = createSession();
    const confirmationError = {
      InstructionError: [1, { Custom: 6012 }],
    };
    const fixture = createFixture(
      exactSnapshot(session),
      confirmationError,
    );

    await expect(
      fixture.adapter.signCloseTab(
        session,
        session.scope.channelId,
        FINAL_CUMULATIVE.toString(),
      ),
    ).rejects.toThrow(
      `session revoke transaction failed: ${JSON.stringify(confirmationError)}`,
    );
    expect(fixture.connection.sentRaw).toHaveLength(1);
    expect(fixture.connection.confirmTransaction).toHaveBeenCalledOnce();
    expect(fixture.connection.confirmTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ signature: expect.any(String) }),
      'finalized',
    );
  });

  it('reconciles the same exact revoke to finalized after confirmation transport ambiguity', async () => {
    const session = createSession();
    const fixture = createFixture(exactSnapshot(session));
    vi.mocked(fixture.connection.confirmTransaction)
      .mockRejectedValueOnce(new Error('rpc timeout after broadcast'));
    vi.mocked(fixture.connection.getSignatureStatuses)
      .mockResolvedValueOnce({
        context: { slot: 901 },
        value: [{
          err: null,
          confirmationStatus: 'confirmed',
          confirmations: 1,
          slot: 901,
        }],
      })
      .mockResolvedValueOnce({
        context: { slot: 902 },
        value: [{
          err: null,
          confirmationStatus: 'finalized',
          confirmations: null,
          slot: 901,
        }],
      });

    await expect(
      fixture.adapter.signCloseTab(
        session,
        session.scope.channelId,
        FINAL_CUMULATIVE.toString(),
      ),
    ).rejects.toThrow('session revoke finality unresolved');

    const exactWire = Uint8Array.from(fixture.connection.sentRaw[0]!);
    const message = await fixture.adapter.signCloseTab(
      session,
      session.scope.channelId,
      FINAL_CUMULATIVE.toString(),
    );

    expect(message).toEqual(sessionRevokeMessage(exactSnapshot(session)));
    expect(fixture.signOperation).toHaveBeenCalledOnce();
    expect(fixture.connection.sentRaw).toHaveLength(1);
    expect(fixture.connection.sentRaw[0]).toEqual(exactWire);
  });

  it('never replaces an exact revoke that is still observed on a confirmed fork after blockhash expiry', async () => {
    const session = createSession();
    const fixture = createFixture(exactSnapshot(session));
    vi.mocked(fixture.connection.confirmTransaction)
      .mockRejectedValueOnce(new Error('rpc timeout after broadcast'));
    vi.mocked(fixture.connection.getSignatureStatuses)
      .mockResolvedValue({
        context: { slot: 901 },
        value: [{
          err: null,
          confirmationStatus: 'confirmed',
          confirmations: 1,
          slot: 901,
        }],
      });
    vi.mocked(fixture.connection.getBlockHeight).mockResolvedValue(101);

    await expect(
      fixture.adapter.signCloseTab(
        session,
        session.scope.channelId,
        FINAL_CUMULATIVE.toString(),
      ),
    ).rejects.toThrow('session revoke finality unresolved');

    await expect(
      fixture.adapter.signCloseTab(
        session,
        session.scope.channelId,
        FINAL_CUMULATIVE.toString(),
      ),
    ).rejects.toThrow('session revoke finality unresolved');

    expect(fixture.signOperation).toHaveBeenCalledOnce();
    expect(fixture.connection.sentRaw).toHaveLength(1);
    expect(fixture.connection.getBlockHeight).not.toHaveBeenCalled();
  });

  it('rebroadcasts only the preserved exact wire while its blockhash remains valid', async () => {
    const session = createSession();
    const fixture = createFixture(exactSnapshot(session));
    vi.mocked(fixture.connection.confirmTransaction)
      .mockRejectedValueOnce(new Error('rpc timeout after broadcast'));
    vi.mocked(fixture.connection.isBlockhashValid)
      .mockResolvedValue({ context: { slot: 902 }, value: true });

    await expect(
      fixture.adapter.signCloseTab(
        session,
        session.scope.channelId,
        FINAL_CUMULATIVE.toString(),
      ),
    ).rejects.toThrow('session revoke finality unresolved');
    const firstWire = Uint8Array.from(fixture.connection.sentRaw[0]!);

    await expect(
      fixture.adapter.signCloseTab(
        session,
        session.scope.channelId,
        FINAL_CUMULATIVE.toString(),
      ),
    ).resolves.toEqual(sessionRevokeMessage(exactSnapshot(session)));

    expect(fixture.signOperation).toHaveBeenCalledOnce();
    expect(fixture.connection.sentRaw).toHaveLength(2);
    expect(fixture.connection.sentRaw[1]).toEqual(firstWire);
  });

  it('treats a finalized replacement as success and never revokes the replacement', async () => {
    const session = createSession();
    const original = exactSnapshot(session);
    const replacement = {
      ...original,
      sessionPubkey: generateSessionKeypair().publicKey,
      nonce: sessionVoucherV2Nonce(AUTHORIZATION_NONCE + 10n),
    };
    const fixture = createFixture(original);
    fixture.readCloseRevocationSnapshot
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(replacement);
    vi.mocked(fixture.connection.confirmTransaction)
      .mockRejectedValueOnce(new Error('rpc timeout after broadcast'));
    vi.mocked(fixture.connection.getSignatureStatuses)
      .mockResolvedValue({
        context: { slot: 901 },
        value: [{
          err: null,
          confirmationStatus: 'confirmed',
          confirmations: 1,
          slot: 901,
        }],
      });

    await expect(
      fixture.adapter.signCloseTab(
        session,
        session.scope.channelId,
        FINAL_CUMULATIVE.toString(),
      ),
    ).rejects.toThrow('session revoke finality unresolved');

    await expect(
      fixture.adapter.signCloseTab(
        session,
        session.scope.channelId,
        FINAL_CUMULATIVE.toString(),
      ),
    ).resolves.toEqual(sessionRevokeMessage(original));
    expect(fixture.signOperation).toHaveBeenCalledOnce();
    expect(fixture.connection.sentRaw).toHaveLength(1);
  });

  it('creates a fresh revoke only after finalized expiry and exact history-covered absence', async () => {
    const session = createSession();
    const fixture = createFixture(exactSnapshot(session));
    const nextBlockhash = Keypair.generate().publicKey.toBase58();
    vi.mocked(fixture.connection.getLatestBlockhash)
      .mockResolvedValueOnce({
        blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k',
        lastValidBlockHeight: 100,
      })
      .mockResolvedValueOnce({
        blockhash: nextBlockhash,
        lastValidBlockHeight: 200,
      });
    vi.mocked(fixture.connection.confirmTransaction)
      .mockRejectedValueOnce(new Error('rpc timeout after broadcast'));
    vi.mocked(fixture.connection.getBlockHeight)
      .mockResolvedValueOnce(90)
      .mockResolvedValueOnce(101);

    await expect(
      fixture.adapter.signCloseTab(
        session,
        session.scope.channelId,
        FINAL_CUMULATIVE.toString(),
      ),
    ).rejects.toThrow('session revoke finality unresolved');
    expect(fixture.signOperation).toHaveBeenCalledOnce();
    expect(fixture.connection.sentRaw).toHaveLength(1);

    await expect(
      fixture.adapter.signCloseTab(
        session,
        session.scope.channelId,
        FINAL_CUMULATIVE.toString(),
      ),
    ).resolves.toEqual(sessionRevokeMessage(exactSnapshot(session)));
    expect(fixture.signOperation).toHaveBeenCalledTimes(2);
    expect(fixture.connection.sentRaw).toHaveLength(2);
    expect(fixture.connection.sentRaw[1]).not.toEqual(
      fixture.connection.sentRaw[0],
    );
  });
});
