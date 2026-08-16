import { describe, expect, it, vi } from 'vitest';
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  type Connection,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import {
  deriveGraphConfigPda,
  deriveSwigVaultBindingPda,
} from '@dexterai/vault/credit';
import {
  DEXTER_VAULT_PROGRAM_ID,
} from '@dexterai/vault/constants';
import {
  buildSettleVoucherInstruction,
  deriveSwigWalletAddress,
} from '@dexterai/vault/instructions';
import { sessionRegisterMessage } from '@dexterai/vault/messages';
import { deriveSessionPda } from '@dexterai/vault/session';

import {
  finalVoucherV2ReservationMemo,
  finalVoucherV2ReservationIdentity,
} from '../reservation';
import {
  SOLANA_FINAL_VOUCHER_V2_MEMO_PROGRAM_ID,
  SolanaFinalVoucherV2ReservationError,
  verifySolanaFinalVoucherV2Reservation,
} from '../adapters/solana/reservation-verifier';
import type {
  FinalVoucherV2ReservationInput,
  FinalVoucherV2ReservationReceipt,
  SignedVoucher,
} from '../types';

const VAULT_DISCRIMINATOR = Uint8Array.from([
  211, 8, 232, 43, 2, 152, 117, 119,
]);
const SESSION_DISCRIMINATOR = Uint8Array.from([
  74, 34, 65, 133, 96, 163, 80, 69,
]);
const BINDING_DISCRIMINATOR = Uint8Array.from([
  56, 67, 4, 209, 238, 143, 0, 129,
]);
const CONFIRMATION_SLOT = 100;
const POST_STATE_SLOT = 101;
const PREVIOUS_CUMULATIVE = 100n;
const RESERVATION_AMOUNT = 25n;
const SESSION_NONCE = 0x8000_0007;
const VOUCHER_SEQUENCE = 0x8000_0001;
const EXPIRES_AT = 2_000_000_000;
const TRANSACTION_SIGNATURE = '5'.repeat(88);

interface Fixture {
  input: FinalVoucherV2ReservationInput;
  receipt: FinalVoucherV2ReservationReceipt;
  connection: Connection;
  transaction: VersionedTransactionResponse;
  vaultData: Buffer;
  sessionData: Buffer;
  bindingData: Buffer;
  getTransaction: ReturnType<typeof vi.fn>;
  getMultipleAccountsInfoAndContext: ReturnType<typeof vi.fn>;
}

function accountInfo(data: Buffer) {
  return {
    data,
    executable: false,
    lamports: 1,
    owner: DEXTER_VAULT_PROGRAM_ID,
    rentEpoch: 0,
  };
}

function vaultData(args: {
  swig: PublicKey;
  authority: PublicKey;
  pendingVoucherCount?: number;
}): Buffer {
  const data = Buffer.alloc(181);
  Buffer.from(VAULT_DISCRIMINATOR).copy(data, 0);
  data.writeUInt8(7, 8);
  data.writeUInt8(255, 9);
  Buffer.alloc(33, 7).copy(data, 10);
  args.swig.toBuffer().copy(data, 43);
  data.writeUInt32LE(args.pendingVoucherCount ?? 3, 79);
  data.writeUInt8(0, 83); // no pending withdrawal
  args.authority.toBuffer().copy(data, 116);
  data.writeUInt8(1, 148);
  data.writeBigUInt64LE(0n, 149);
  data.writeBigUInt64LE(0n, 157);
  data.writeBigUInt64LE(0n, 165);
  return data;
}

function sessionData(args: {
  vault: PublicKey;
  seller: PublicKey;
  sessionPublicKey: Uint8Array;
  bump: number;
  spent?: bigint;
  crystallized?: bigint;
  currentOutstanding?: bigint;
}): Buffer {
  const data = Buffer.alloc(162);
  Buffer.from(SESSION_DISCRIMINATOR).copy(data, 0);
  data.writeUInt8(1, 8);
  data.writeUInt8(args.bump, 9);
  args.vault.toBuffer().copy(data, 10);
  Buffer.from(args.sessionPublicKey).copy(data, 42);
  data.writeBigUInt64LE(1_000_000n, 74);
  data.writeBigInt64LE(BigInt(EXPIRES_AT), 82);
  args.seller.toBuffer().copy(data, 90);
  data.writeUInt32LE(SESSION_NONCE, 122);
  data.writeBigUInt64LE(args.spent ?? PREVIOUS_CUMULATIVE, 126);
  data.writeBigUInt64LE(
    args.currentOutstanding ?? RESERVATION_AMOUNT,
    134,
  );
  data.writeBigUInt64LE(250_000n, 142);
  data.writeBigUInt64LE(args.crystallized ?? 90n, 150);
  data.writeUInt32LE(0, 158);
  return data;
}

function bindingData(args: {
  swig: PublicKey;
  vault: PublicKey;
  bump: number;
}): Buffer {
  const data = Buffer.alloc(74);
  Buffer.from(BINDING_DISCRIMINATOR).copy(data, 0);
  data.writeUInt8(1, 8);
  data.writeUInt8(args.bump, 9);
  args.swig.toBuffer().copy(data, 10);
  args.vault.toBuffer().copy(data, 42);
  return data;
}

function makeFixture(): Fixture {
  const swig = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const seller = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const sessionPublicKey = new Uint8Array(32).fill(0x41);
  const [sessionPda, sessionBump] = deriveSessionPda(
    vault,
    seller,
    DEXTER_VAULT_PROGRAM_ID,
  );
  const [bindingPda, bindingBump] = deriveSwigVaultBindingPda(
    swig,
    DEXTER_VAULT_PROGRAM_ID,
  );
  const voucher: SignedVoucher = {
    payload: {
      channelId: 'c'.repeat(64),
      cumulativeAmount: (PREVIOUS_CUMULATIVE + RESERVATION_AMOUNT).toString(),
      sequenceNumber: VOUCHER_SEQUENCE,
    },
    sessionPublicKey,
    sessionRegistration: sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: vault,
      sessionPubkey: sessionPublicKey,
      maxAmount: 1_000_000n,
      expiresAt: BigInt(EXPIRES_AT),
      allowedCounterparty: seller,
      nonce: SESSION_NONCE,
      maxRevolvingCapacity: 250_000n,
    }),
    sessionSignature: new Uint8Array(64).fill(0x52),
  };
  const identity = finalVoucherV2ReservationIdentity(voucher);
  const input: FinalVoucherV2ReservationInput = {
    network: 'solana:mainnet',
    programId: DEXTER_VAULT_PROGRAM_ID.toBase58(),
    buyerSwigAddress: swig.toBase58(),
    vaultPda: vault.toBase58(),
    sessionPda: sessionPda.toBase58(),
    seller: seller.toBase58(),
    channelId: voucher.payload.channelId,
    sessionNonce: SESSION_NONCE,
    reservationAmountAtomic: RESERVATION_AMOUNT.toString(),
    previousCumulativeAtomic: PREVIOUS_CUMULATIVE.toString(),
    voucherDigest: identity.voucherDigest,
    idempotencyKey: identity.idempotencyKey,
    voucher,
  };
  const receipt: FinalVoucherV2ReservationReceipt = {
    contract: 'dexter-native-tab-open-receipt/v1',
    operationId: 'a'.repeat(64),
    callerOperationId: input.idempotencyKey,
    network: input.network,
    transaction: TRANSACTION_SIGNATURE,
    commitment: 'finalized',
    confirmationSlot: CONFIRMATION_SLOT,
    postStateSlot: POST_STATE_SLOT,
    buyerSwigAddress: input.buyerSwigAddress,
    vaultPda: input.vaultPda,
    sessionPda: input.sessionPda,
    seller: input.seller,
    channelId: input.channelId,
    sessionPublicKey: Buffer.from(sessionPublicKey).toString('hex'),
    voucherDigest: input.voucherDigest,
    cumulativeAmountAtomic: input.voucher.payload.cumulativeAmount,
    sequenceNumber: input.voucher.payload.sequenceNumber,
    providerReceiptId: 'native-tab-provider:attempt-1',
    reservationAmountAtomic: input.reservationAmountAtomic,
    pendingVoucherCountBefore: 2,
    pendingVoucherCountAfter: 3,
    currentOutstandingBeforeAtomic: '0',
    currentOutstandingAfterAtomic: input.reservationAmountAtomic,
  };

  const instruction = buildSettleVoucherInstruction({
    vaultPda: vault,
    dexterAuthority: authority,
    allowedCounterparty: seller,
    swigAddress: swig,
    vaultUsdcAta: null,
    siblingSessionPdas: [],
    amount: RESERVATION_AMOUNT,
    increment: true,
    programId: DEXTER_VAULT_PROGRAM_ID,
  });
  const memo = new TransactionInstruction({
    programId: SOLANA_FINAL_VOUCHER_V2_MEMO_PROGRAM_ID,
    keys: [{
      pubkey: authority,
      isSigner: true,
      isWritable: false,
    }],
    data: Buffer.from(finalVoucherV2ReservationMemo(input), 'utf8'),
  });
  const message = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: Keypair.fromSeed(
      new Uint8Array(32).fill(0x61),
    ).publicKey.toBase58(),
    instructions: [instruction, memo],
  }).compileToV0Message();
  const transaction = {
    slot: CONFIRMATION_SLOT,
    blockTime: null,
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [],
      postTokenBalances: [],
      logMessages: [],
      loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: {
      signatures: [TRANSACTION_SIGNATURE],
      message,
    },
    version: 0 as const,
  } as unknown as VersionedTransactionResponse;

  const vaultBytes = vaultData({ swig, authority });
  const sessionBytes = sessionData({
    vault,
    seller,
    sessionPublicKey,
    bump: sessionBump,
  });
  const bindingBytes = bindingData({ swig, vault, bump: bindingBump });
  const getTransaction = vi.fn(async () => transaction);
  const getMultipleAccountsInfoAndContext = vi.fn(async () => ({
    context: { apiVersion: '1.18.0', slot: POST_STATE_SLOT },
    value: [
      accountInfo(bindingBytes),
      accountInfo(vaultBytes),
      accountInfo(sessionBytes),
    ],
  }));
  const connection = {
    getTransaction,
    getMultipleAccountsInfoAndContext,
  } as unknown as Connection;

  expect(bindingPda.toBase58()).toBe(
    deriveSwigVaultBindingPda(swig, DEXTER_VAULT_PROGRAM_ID)[0].toBase58(),
  );
  expect(instruction.keys[5].pubkey.equals(deriveSwigWalletAddress(swig))).toBe(true);
  expect(instruction.keys[7].pubkey.equals(
    deriveGraphConfigPda(DEXTER_VAULT_PROGRAM_ID)[0],
  )).toBe(true);

  return {
    input,
    receipt,
    connection,
    transaction,
    vaultData: vaultBytes,
    sessionData: sessionBytes,
    bindingData: bindingBytes,
    getTransaction,
    getMultipleAccountsInfoAndContext,
  };
}

function expectCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({
    name: 'SolanaFinalVoucherV2ReservationError',
    code,
  } satisfies Partial<SolanaFinalVoucherV2ReservationError>);
}

describe('Solana FINAL V2 reservation verifier', () => {
  it('proves the exact successful instruction and one coherent post-state read', async () => {
    const fixture = makeFixture();

    await expect(verifySolanaFinalVoucherV2Reservation(
      fixture.connection,
      fixture.input,
      fixture.receipt,
    )).resolves.toBeUndefined();

    expect(fixture.getTransaction).toHaveBeenCalledWith(
      fixture.receipt.transaction,
      { commitment: 'finalized', maxSupportedTransactionVersion: 0 },
    );
    expect(fixture.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(1);
    expect(fixture.getMultipleAccountsInfoAndContext.mock.calls[0][1]).toEqual({
      commitment: 'finalized',
      minContextSlot: CONFIRMATION_SLOT,
    });
  });

  it('never lets an untrusted receipt postStateSlot control the RPC wait fence', async () => {
    const fixture = makeFixture();
    fixture.receipt.postStateSlot = Number.MAX_SAFE_INTEGER;

    await expect(verifySolanaFinalVoucherV2Reservation(
      fixture.connection,
      fixture.input,
      fixture.receipt,
    )).resolves.toBeUndefined();

    expect(fixture.getMultipleAccountsInfoAndContext.mock.calls[0][1]).toEqual({
      commitment: 'finalized',
      minContextSlot: CONFIRMATION_SLOT,
    });
  });

  it('rejects a reservation transaction visible only at confirmed commitment', async () => {
    const fixture = makeFixture();
    fixture.getTransaction.mockImplementation(async (_signature, options) =>
      options.commitment === 'confirmed' ? fixture.transaction : null);

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'transaction_missing',
    );
    expect(fixture.getTransaction).toHaveBeenCalledWith(
      fixture.receipt.transaction,
      { commitment: 'finalized', maxSupportedTransactionVersion: 0 },
    );
  });

  it('rejects a landed transaction with a program error', async () => {
    const fixture = makeFixture();
    if (!fixture.transaction.meta) throw new Error('fixture meta missing');
    fixture.transaction.meta.err = { InstructionError: [0, 'Custom'] };

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'transaction_failed',
    );
  });

  it('requires the receipt transaction id at signature index zero', async () => {
    const fixture = makeFixture();
    fixture.transaction.transaction.signatures = [
      '6'.repeat(88),
      fixture.receipt.transaction,
    ];

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'transaction_signature',
    );
  });

  it.each([
    ['amount', 8, 26n, 'settle_voucher_amount'],
    ['increment flag', 16, 0n, 'settle_voucher_increment'],
  ] as const)(
    'rejects a settle_voucher instruction with the wrong %s',
    async (_label, offset, value, code) => {
      const fixture = makeFixture();
      const instruction = fixture.transaction.transaction.message
        .compiledInstructions[0];
      if (!instruction) throw new Error('fixture instruction missing');
      const bytes = Buffer.from(instruction.data);
      if (offset === 8) bytes.writeBigUInt64LE(value, offset);
      else bytes.writeUInt8(Number(value), offset);
      instruction.data = Uint8Array.from(bytes);

      await expectCode(
        verifySolanaFinalVoucherV2Reservation(
          fixture.connection,
          fixture.input,
          fixture.receipt,
        ),
        code,
      );
    },
  );

  it('rejects an instruction whose claimed Dexter authority did not sign', async () => {
    const fixture = makeFixture();
    const instruction = fixture.transaction.transaction.message
      .compiledInstructions[0];
    if (!instruction) throw new Error('fixture instruction missing');
    // Repoint the instruction's authority to its non-signer Swig account.
    instruction.accountKeyIndexes[1] = instruction.accountKeyIndexes[4]!;

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'dexter_authority_signature',
    );
  });

  it('rejects a settle_voucher instruction aimed at a different SessionAccount', async () => {
    const fixture = makeFixture();
    const instruction = fixture.transaction.transaction.message
      .compiledInstructions[0];
    if (!instruction) throw new Error('fixture instruction missing');
    instruction.accountKeyIndexes[2] = instruction.accountKeyIndexes[4]!;

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'settle_voucher_account_2',
    );
  });

  it('rejects a provider receipt whose voucher digest is not the local voucher', async () => {
    const fixture = makeFixture();
    fixture.receipt.voucherDigest = '0'.repeat(64);

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'provider_receipt',
    );
    expect(fixture.getTransaction).not.toHaveBeenCalled();
  });

  it('does not require the later global counter to equal the receipt snapshot', async () => {
    const fixture = makeFixture();
    fixture.vaultData.writeUInt32LE(4, 79);

    await expect(verifySolanaFinalVoucherV2Reservation(
      fixture.connection,
      fixture.input,
      fixture.receipt,
    )).resolves.toBeUndefined();
  });

  it('rejects a transaction missing the voucher-binding Memo', async () => {
    const fixture = makeFixture();
    fixture.transaction.transaction.message.compiledInstructions.pop();

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'transaction_instruction_count',
    );
  });

  it('rejects the correct instructions in the wrong order', async () => {
    const fixture = makeFixture();
    fixture.transaction.transaction.message.compiledInstructions.reverse();

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'settle_voucher_instruction_order',
    );
  });

  it('rejects a wrong or replayed voucher-binding Memo digest', async () => {
    const fixture = makeFixture();
    const memo = fixture.transaction.transaction.message
      .compiledInstructions[1];
    if (!memo) throw new Error('fixture memo missing');
    const otherVoucher: SignedVoucher = {
      ...fixture.input.voucher,
      payload: {
        ...fixture.input.voucher.payload,
        cumulativeAmount: '126',
      },
    };
    const otherIdentity = finalVoucherV2ReservationIdentity(otherVoucher);
    memo.data = new TextEncoder().encode(finalVoucherV2ReservationMemo({
      ...fixture.input,
      reservationAmountAtomic: '26',
      ...otherIdentity,
      voucher: otherVoucher,
    }));

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'reservation_memo_digest',
    );
  });

  it('rejects voucher B with the same amount/outstanding against voucher A\'s transaction Memo', async () => {
    const fixture = makeFixture();
    const voucherB: SignedVoucher = {
      ...fixture.input.voucher,
      sessionSignature: new Uint8Array(64).fill(0x53),
    };
    const identityB = finalVoucherV2ReservationIdentity(voucherB);
    const inputB: FinalVoucherV2ReservationInput = {
      ...fixture.input,
      ...identityB,
      voucher: voucherB,
    };
    const receiptB: FinalVoucherV2ReservationReceipt = {
      ...fixture.receipt,
      callerOperationId: identityB.idempotencyKey,
      voucherDigest: identityB.voucherDigest,
    };

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        inputB,
        receiptB,
      ),
      'reservation_memo_digest',
    );
  });

  it('rejects a Memo not naming the exact Dexter authority signer', async () => {
    const fixture = makeFixture();
    const settle = fixture.transaction.transaction.message
      .compiledInstructions[0];
    const memo = fixture.transaction.transaction.message
      .compiledInstructions[1];
    if (!settle || !memo) throw new Error('fixture instructions missing');
    memo.accountKeyIndexes[0] = settle.accountKeyIndexes[4]!;

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'reservation_memo_authority',
    );
  });

  it('rejects any extra economic instruction beside settle + Memo', async () => {
    const fixture = makeFixture();
    const settle = fixture.transaction.transaction.message
      .compiledInstructions[0];
    if (!settle) throw new Error('fixture settle missing');
    fixture.transaction.transaction.message.compiledInstructions.push({
      programIdIndex: settle.programIdIndex,
      accountKeyIndexes: [...settle.accountKeyIndexes],
      data: Uint8Array.from(settle.data),
    });

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'transaction_instruction_count',
    );
  });

  it('rejects a reservation that is not opened immediately above the chain frontier', async () => {
    const fixture = makeFixture();
    fixture.sessionData.writeBigUInt64LE(99n, 126);
    fixture.sessionData.writeBigUInt64LE(90n, 150);

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'session_frontier',
    );
  });

  it('rejects a reservation that was already consumed before seller admission', async () => {
    const fixture = makeFixture();
    fixture.sessionData.writeBigUInt64LE(
      PREVIOUS_CUMULATIVE + RESERVATION_AMOUNT,
      126,
    );
    fixture.sessionData.writeBigUInt64LE(0n, 134);

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'session_post_state',
    );
  });

  it('rejects a reverse binding that points to a different Vault', async () => {
    const fixture = makeFixture();
    Keypair.generate().publicKey.toBuffer().copy(fixture.bindingData, 42);

    await expectCode(
      verifySolanaFinalVoucherV2Reservation(
        fixture.connection,
        fixture.input,
        fixture.receipt,
      ),
      'binding_identity',
    );
  });
});
