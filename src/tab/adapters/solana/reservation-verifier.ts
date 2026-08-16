/**
 * Independent Solana proof for a FINAL Native Tab V2 reservation.
 *
 * The transaction must contain exactly two top-level instructions: the exact
 * Vault `settle_voucher(increment=true)` reservation followed by an SPL Memo
 * carrying the domain-separated digest of the complete FINAL voucher and its
 * reservation identity. The Vault's recorded Dexter authority must sign both
 * instruction accounts. Provider-local lifecycle identifiers are only checked
 * for receipt shape/consistency: economic authority comes from the finalized
 * transaction, exact Memo, and one coherent post-state read fenced by the
 * independently fetched transaction slot.
 */

import {
  Connection,
  PublicKey,
} from '@solana/web3.js';
import { bytesToHex } from '@noble/hashes/utils';
import {
  deriveGraphConfigPda,
  deriveSwigVaultBindingPda,
} from '@dexterai/vault/credit';
import {
  DEXTER_VAULT_PROGRAM_ID,
  DISCRIMINATORS,
} from '@dexterai/vault/constants';
import { deriveSwigWalletAddress } from '@dexterai/vault/instructions';
import { decodeVaultFull } from '@dexterai/vault/reader';
import {
  decodeSessionAccount,
  deriveSessionPda,
} from '@dexterai/vault/session';

import {
  assertFinalVoucherV2ReservationReceipt,
  finalVoucherV2ReservationMemo,
} from '../../reservation';
import type {
  FinalVoucherV2ReservationInput,
  FinalVoucherV2ReservationReceipt,
  VerifyFinalVoucherV2Reservation,
} from '../../types';

const SWIG_VAULT_BINDING_DISCRIMINATOR = Uint8Array.from([
  56, 67, 4, 209, 238, 143, 0, 129,
]);
const SWIG_VAULT_BINDING_BYTES = 8 + 1 + 1 + 32 + 32;
const SUPPORTED_BINDING_VERSIONS = new Set([1, 2]);
const SESSION_REGISTRATION_BYTES = 188;
const SPL_MEMO_V2_PROGRAM_ID = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);
const SESSION_REGISTER_V2_DOMAIN = (() => {
  const value = Buffer.alloc(32);
  value.write('OTS_SESSION_REGISTER_V2', 'ascii');
  return value;
})();

export class SolanaFinalVoucherV2ReservationError extends Error {
  constructor(
    public readonly code: string,
    detail?: string,
  ) {
    super(
      `native_tab_v2_solana_reservation_invalid:${code}`
      + (detail ? `:${detail}` : ''),
    );
    this.name = 'SolanaFinalVoucherV2ReservationError';
  }
}

function invalid(code: string, detail?: string): never {
  throw new SolanaFinalVoucherV2ReservationError(code, detail);
}

function publicKey(value: string, field: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    return invalid(field);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

interface TransactionAccountEvidence {
  address: string;
  signer: boolean;
  writable: boolean;
}

interface TransactionInstructionEvidence {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

export interface SolanaReservationTransactionEvidence {
  slot: number;
  err: unknown | null;
  signatures: string[];
  accountKeys: TransactionAccountEvidence[];
  instructions: TransactionInstructionEvidence[];
}

export interface SolanaReservationPostStateEvidence {
  contextSlot: number;
  binding: {
    address: string;
    owner: string;
    version: number;
    bump: number;
    swig: string;
    vault: string;
  };
  vault: {
    owner: string;
    exists: boolean;
    version: number;
    swigAddress: string | null;
    dexterAuthority: string | null;
    pendingVoucherCount: number;
  };
  session: {
    owner: string;
    version: number;
    bump: number;
    vault: string;
    sessionPublicKey: string;
    maxAmount: bigint;
    expiresAt: number;
    seller: string;
    nonce: number;
    spent: bigint;
    currentOutstanding: bigint;
    maxRevolvingCapacity: bigint;
    crystallizedCumulative: bigint;
  };
}

interface ReadTransactionArgs {
  connection: Connection;
  signature: string;
  commitment: 'finalized';
}

interface ReadPostStateArgs {
  connection: Connection;
  input: FinalVoucherV2ReservationInput;
  /** Independently observed finalized reservation-transaction slot. Never a
   * provider/buyer supplied postStateSlot. */
  minimumSlot: number;
}

export interface SolanaReservationVerifierSeams {
  readTransaction?: (
    args: ReadTransactionArgs,
  ) => Promise<SolanaReservationTransactionEvidence | null>;
  readPostState?: (
    args: ReadPostStateArgs,
  ) => Promise<SolanaReservationPostStateEvidence>;
}

async function readTransaction(
  args: ReadTransactionArgs,
): Promise<SolanaReservationTransactionEvidence | null> {
  // Use the raw compiled message. `jsonParsed` may replace Memo bytes and
  // account indexes with an RPC-specific parsed shape, which is insufficient
  // for an exact transaction binding.
  const response = await args.connection.getTransaction(args.signature, {
    commitment: args.commitment,
    maxSupportedTransactionVersion: 0,
  });
  if (!response) return null;
  if (!response.meta) invalid('transaction_meta_missing');

  const message = response.transaction.message;
  const accountKeys = message.version === 0
    ? message.getAccountKeys({
        accountKeysFromLookups: response.meta.loadedAddresses ?? null,
      })
    : message.getAccountKeys();
  const keyAt = (index: number, field: string): PublicKey => {
    const key = accountKeys.get(index);
    if (!key) invalid(field);
    return key;
  };

  return {
    slot: response.slot,
    err: response.meta.err,
    signatures: [...response.transaction.signatures],
    accountKeys: Array.from({ length: accountKeys.length }, (_, index) => ({
      address: keyAt(index, 'transaction_account_key').toBase58(),
      signer: message.isAccountSigner(index),
      writable: message.isAccountWritable(index),
    })),
    instructions: message.compiledInstructions.map((instruction) => ({
      programId: keyAt(
        instruction.programIdIndex,
        'transaction_program_id',
      ).toBase58(),
      accounts: instruction.accountKeyIndexes.map((index) =>
        keyAt(index, 'transaction_instruction_account').toBase58()),
      data: Uint8Array.from(instruction.data),
    })),
  };
}

function decodeBinding(
  address: PublicKey,
  expectedBump: number,
  owner: PublicKey,
  data: Buffer,
): SolanaReservationPostStateEvidence['binding'] {
  if (data.length !== SWIG_VAULT_BINDING_BYTES) {
    invalid('binding_length');
  }
  if (!equalBytes(data.subarray(0, 8), SWIG_VAULT_BINDING_DISCRIMINATOR)) {
    invalid('binding_discriminator');
  }
  const version = data.readUInt8(8);
  const bump = data.readUInt8(9);
  if (!SUPPORTED_BINDING_VERSIONS.has(version)) invalid('binding_version');
  if (bump !== expectedBump) invalid('binding_bump');
  return {
    address: address.toBase58(),
    owner: owner.toBase58(),
    version,
    bump,
    swig: new PublicKey(data.subarray(10, 42)).toBase58(),
    vault: new PublicKey(data.subarray(42, 74)).toBase58(),
  };
}

async function readPostState(
  args: ReadPostStateArgs,
): Promise<SolanaReservationPostStateEvidence> {
  const programId = publicKey(args.input.programId, 'program_id');
  const swig = publicKey(args.input.buyerSwigAddress, 'buyer_swig');
  const vaultPda = publicKey(args.input.vaultPda, 'vault_pda');
  const seller = publicKey(args.input.seller, 'seller');
  const [bindingPda, bindingBump] = deriveSwigVaultBindingPda(swig, programId);
  const [sessionPda] = deriveSessionPda(vaultPda, seller, programId);

  const response = await args.connection.getMultipleAccountsInfoAndContext(
    [bindingPda, vaultPda, sessionPda],
    {
      commitment: 'finalized',
      minContextSlot: args.minimumSlot,
    },
  );
  const [bindingAccount, vaultAccount, sessionAccount] = response.value;
  if (!bindingAccount) invalid('binding_missing');
  if (!vaultAccount) invalid('vault_missing');
  if (!sessionAccount) invalid('session_missing');

  let vault: ReturnType<typeof decodeVaultFull>;
  let session: ReturnType<typeof decodeSessionAccount>;
  try {
    vault = decodeVaultFull(Buffer.from(vaultAccount.data));
    session = decodeSessionAccount(sessionPda, sessionAccount.data);
  } catch (error) {
    return invalid(
      'post_state_decode',
      error instanceof Error ? error.message : String(error),
    );
  }

  const registration = session.session;
  return {
    contextSlot: response.context.slot,
    binding: decodeBinding(
      bindingPda,
      bindingBump,
      bindingAccount.owner,
      Buffer.from(bindingAccount.data),
    ),
    vault: {
      owner: vaultAccount.owner.toBase58(),
      exists: vault.exists,
      version: vault.version,
      swigAddress: vault.swigAddress,
      dexterAuthority: vault.dexterAuthority,
      pendingVoucherCount: vault.pendingVoucherCount,
    },
    session: {
      owner: sessionAccount.owner.toBase58(),
      version: session.version,
      bump: session.bump,
      vault: session.vault,
      sessionPublicKey: bytesToHex(registration.sessionPubkey),
      maxAmount: registration.maxAmount,
      expiresAt: registration.expiresAt,
      seller: registration.allowedCounterparty,
      nonce: registration.nonce,
      spent: registration.spent,
      currentOutstanding: registration.currentOutstanding,
      maxRevolvingCapacity: registration.maxRevolvingCapacity,
      crystallizedCumulative: registration.crystallizedCumulative,
    },
  };
}

interface RegistrationEvidence {
  programId: string;
  vaultPda: string;
  sessionPublicKey: string;
  maxAmount: bigint;
  expiresAt: bigint;
  seller: string;
  nonce: number;
  maxRevolvingCapacity: bigint;
}

function decodeRegistration(input: FinalVoucherV2ReservationInput): RegistrationEvidence {
  const data = Buffer.from(input.voucher.sessionRegistration);
  if (data.length !== SESSION_REGISTRATION_BYTES) {
    invalid('registration_length');
  }
  if (!equalBytes(data.subarray(0, 32), SESSION_REGISTER_V2_DOMAIN)) {
    invalid('registration_domain');
  }
  return {
    programId: new PublicKey(data.subarray(32, 64)).toBase58(),
    vaultPda: new PublicKey(data.subarray(64, 96)).toBase58(),
    sessionPublicKey: bytesToHex(data.subarray(96, 128)),
    maxAmount: data.readBigUInt64LE(128),
    expiresAt: data.readBigInt64LE(136),
    seller: new PublicKey(data.subarray(144, 176)).toBase58(),
    nonce: data.readUInt32LE(176),
    maxRevolvingCapacity: data.readBigUInt64LE(180),
  };
}

function requireAccount(
  transaction: SolanaReservationTransactionEvidence,
  address: string,
  field: string,
): TransactionAccountEvidence {
  const matches = transaction.accountKeys.filter((key) => key.address === address);
  if (matches.length !== 1) invalid(`${field}_account_key`);
  return matches[0];
}

function inspectReservationTransaction(
  input: FinalVoucherV2ReservationInput,
  receipt: FinalVoucherV2ReservationReceipt,
  transaction: SolanaReservationTransactionEvidence,
): string {
  if (!Number.isSafeInteger(transaction.slot) || transaction.slot <= 0) {
    invalid('transaction_slot');
  }
  if (transaction.slot !== receipt.confirmationSlot) {
    invalid('transaction_confirmation_slot');
  }
  if (transaction.err !== null) invalid('transaction_failed');
  // Solana's transaction identifier is the fee-payer signature at index 0.
  // A matching secondary signer does not identify the transaction requested
  // by the receipt and must not inherit its reservation authority.
  if (transaction.signatures[0] !== receipt.transaction) {
    invalid('transaction_signature');
  }
  // Exact transaction contract: one economic reservation followed by one
  // authority-signed voucher-binding Memo. No transfer, compute-budget,
  // duplicate Memo, or unrelated instruction may inherit this approval.
  if (transaction.instructions.length !== 2) {
    invalid('transaction_instruction_count');
  }

  const programId = publicKey(input.programId, 'program_id');
  const swig = publicKey(input.buyerSwigAddress, 'buyer_swig');
  const vault = publicKey(input.vaultPda, 'vault_pda');
  const seller = publicKey(input.seller, 'seller');
  const session = publicKey(input.sessionPda, 'session_pda');
  const [expectedSession] = deriveSessionPda(vault, seller, programId);
  const expectedBinding = deriveSwigVaultBindingPda(swig, programId)[0];
  const expectedSwigWallet = deriveSwigWalletAddress(swig);
  const expectedGraphConfig = deriveGraphConfigPda(programId)[0];
  if (!session.equals(expectedSession)) invalid('session_pda_derivation');

  const discriminator = Buffer.from(DISCRIMINATORS.settle_voucher);
  const candidates = transaction.instructions.filter((instruction) => {
    if (instruction.programId !== input.programId) return false;
    const data = instruction.data;
    return data.length >= discriminator.length
      && equalBytes(data.subarray(0, discriminator.length), discriminator);
  });
  if (candidates.length !== 1) invalid('settle_voucher_instruction_count');

  const instruction = candidates[0];
  if (transaction.instructions[0] !== instruction) {
    invalid('settle_voucher_instruction_order');
  }
  const data = Buffer.from(instruction.data);
  if (data.length !== 8 + 8 + 1 + 32) invalid('settle_voucher_instruction_length');
  if (data.readBigUInt64LE(8).toString() !== input.reservationAmountAtomic) {
    invalid('settle_voucher_amount');
  }
  if (data.readUInt8(16) !== 1) invalid('settle_voucher_increment');
  if (!new PublicKey(data.subarray(17, 49)).equals(seller)) {
    invalid('settle_voucher_seller');
  }
  if (instruction.accounts.length < 8) invalid('settle_voucher_accounts');

  const expectedCore = [
    vault.toBase58(),
    null,
    session.toBase58(),
    null,
    swig.toBase58(),
    expectedSwigWallet.toBase58(),
    expectedBinding.toBase58(),
    expectedGraphConfig.toBase58(),
  ];
  expectedCore.forEach((expected, index) => {
    if (expected !== null && instruction.accounts[index] !== expected) {
      invalid(`settle_voucher_account_${index}`);
    }
  });

  const authority = instruction.accounts[1];
  if (!authority) invalid('dexter_authority');
  const vaultKey = requireAccount(transaction, instruction.accounts[0], 'vault');
  const authorityKey = requireAccount(transaction, authority, 'dexter_authority');
  const sessionKey = requireAccount(transaction, instruction.accounts[2], 'session');
  if (!vaultKey.writable || vaultKey.signer) invalid('vault_privileges');
  if (!authorityKey.signer) invalid('dexter_authority_signature');
  if (!sessionKey.writable || sessionKey.signer) invalid('session_privileges');

  for (let index = 3; index < Math.min(instruction.accounts.length, 8); index += 1) {
    const key = requireAccount(transaction, instruction.accounts[index], `account_${index}`);
    if (key.signer) invalid(`settle_voucher_account_${index}_signer`);
  }
  for (let index = 8; index < instruction.accounts.length; index += 1) {
    const key = requireAccount(transaction, instruction.accounts[index], `sibling_${index - 8}`);
    if (!key.writable || key.signer) invalid('settle_voucher_sibling_privileges');
  }

  const memo = transaction.instructions[1];
  if (memo.programId !== SPL_MEMO_V2_PROGRAM_ID.toBase58()) {
    invalid('reservation_memo_program');
  }
  if (memo.accounts.length !== 1 || memo.accounts[0] !== authority) {
    invalid('reservation_memo_authority');
  }
  const memoAuthority = requireAccount(
    transaction,
    authority,
    'reservation_memo_authority',
  );
  if (!memoAuthority.signer) invalid('reservation_memo_authority_signature');
  const expectedMemo = new TextEncoder().encode(
    finalVoucherV2ReservationMemo(input),
  );
  if (!equalBytes(memo.data, expectedMemo)) {
    invalid('reservation_memo_digest');
  }
  return authority;
}

function inspectPostState(
  input: FinalVoucherV2ReservationInput,
  minimumSlot: number,
  authority: string,
  state: SolanaReservationPostStateEvidence,
): void {
  const programId = publicKey(input.programId, 'program_id');
  const swig = publicKey(input.buyerSwigAddress, 'buyer_swig');
  const vaultPda = publicKey(input.vaultPda, 'vault_pda');
  const seller = publicKey(input.seller, 'seller');
  const [bindingPda, bindingBump] = deriveSwigVaultBindingPda(swig, programId);
  const [sessionPda, sessionBump] = deriveSessionPda(vaultPda, seller, programId);

  if (
    !Number.isSafeInteger(state.contextSlot)
    || state.contextSlot < minimumSlot
  ) {
    invalid('post_state_slot');
  }
  if (
    state.binding.address !== bindingPda.toBase58()
    || state.binding.owner !== input.programId
    || state.binding.bump !== bindingBump
    || !SUPPORTED_BINDING_VERSIONS.has(state.binding.version)
    || state.binding.swig !== input.buyerSwigAddress
    || state.binding.vault !== input.vaultPda
  ) {
    invalid('binding_identity');
  }
  if (
    state.vault.owner !== input.programId
    || !state.vault.exists
    || state.vault.version !== 7
    || state.vault.swigAddress !== input.buyerSwigAddress
    || state.vault.dexterAuthority !== authority
  ) {
    invalid('vault_post_state');
  }
  if (
    input.sessionPda !== sessionPda.toBase58()
    || state.session.owner !== input.programId
    || state.session.version !== 1
    || state.session.bump !== sessionBump
    || state.session.vault !== input.vaultPda
    || state.session.sessionPublicKey !== bytesToHex(input.voucher.sessionPublicKey)
    || state.session.seller !== input.seller
    || state.session.nonce !== input.sessionNonce
    || state.session.currentOutstanding.toString()
      !== input.reservationAmountAtomic
  ) {
    invalid('session_post_state');
  }

  const registration = decodeRegistration(input);
  if (
    registration.programId !== input.programId
    || registration.vaultPda !== input.vaultPda
    || registration.sessionPublicKey !== state.session.sessionPublicKey
    || registration.seller !== input.seller
    || registration.nonce !== input.sessionNonce
    || registration.maxAmount !== state.session.maxAmount
    || registration.expiresAt !== BigInt(state.session.expiresAt)
    || registration.maxRevolvingCapacity
      !== state.session.maxRevolvingCapacity
  ) {
    invalid('registration_post_state');
  }

  const frontier = state.session.spent > state.session.crystallizedCumulative
    ? state.session.spent
    : state.session.crystallizedCumulative;
  if (frontier.toString() !== input.previousCumulativeAtomic) {
    invalid('session_frontier');
  }
}

export async function verifySolanaFinalVoucherV2Reservation(
  connection: Connection,
  input: FinalVoucherV2ReservationInput,
  receipt: FinalVoucherV2ReservationReceipt,
  seams: SolanaReservationVerifierSeams = {},
): Promise<void> {
  try {
    assertFinalVoucherV2ReservationReceipt(input, receipt);
  } catch (error) {
    return invalid(
      'provider_receipt',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (input.network !== 'solana:mainnet') invalid('network');
  if (input.programId !== DEXTER_VAULT_PROGRAM_ID.toBase58()) {
    invalid('program_id');
  }

  const transaction = await (seams.readTransaction ?? readTransaction)({
    connection,
    signature: receipt.transaction,
    commitment: receipt.commitment,
  });
  if (!transaction) invalid('transaction_missing');
  const authority = inspectReservationTransaction(input, receipt, transaction);

  const state = await (seams.readPostState ?? readPostState)({
    connection,
    input,
    minimumSlot: transaction.slot,
  });
  inspectPostState(input, transaction.slot, authority, state);
}

export function createSolanaFinalVoucherV2ReservationVerifier(
  connection: Connection,
  seams: SolanaReservationVerifierSeams = {},
): VerifyFinalVoucherV2Reservation {
  return (input, receipt) => verifySolanaFinalVoucherV2Reservation(
    connection,
    input,
    receipt,
    seams,
  );
}

/** Production program ID is exported here only as a caller-side convenience;
 * verification itself always uses the programId explicitly bound in input. */
export const SOLANA_FINAL_VOUCHER_V2_PROGRAM_ID = DEXTER_VAULT_PROGRAM_ID;
export const SOLANA_FINAL_VOUCHER_V2_MEMO_PROGRAM_ID = SPL_MEMO_V2_PROGRAM_ID;
