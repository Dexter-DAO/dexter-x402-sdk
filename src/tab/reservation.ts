import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import type {
  FinalVoucherV2ReservationInput,
  FinalVoucherV2ReservationReceipt,
  SignedVoucher,
} from './types';

const HEX_32 = /^[0-9a-f]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TRANSACTION_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/;

/** Canonical network carried by the managed native-Tab transaction record. */
export const FINAL_VOUCHER_V2_SOLANA_MAINNET_CAIP2 =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** Domain for the authority-signed transaction binding. Changing any bound
 * field requires a new domain/version rather than silently changing bytes. */
export const FINAL_VOUCHER_V2_RESERVATION_BINDING_DOMAIN =
  'dexter-native-tab-v2-reservation/v1';

/** UTF-8 prefix stored by the SPL Memo instruction. */
export const FINAL_VOUCHER_V2_RESERVATION_MEMO_PREFIX =
  `${FINAL_VOUCHER_V2_RESERVATION_BINDING_DOMAIN}:`;

/** Shared economic identity committed by the authority-signed Memo. This is
 * intentionally independent of provider lifecycle IDs and SDK retry keys so
 * the SDK and facilitator can derive identical bytes from their common facts. */
export interface FinalVoucherV2ReservationBindingIdentity {
  network: string;
  programId: string;
  buyerSwigAddress: string;
  vaultPda: string;
  sessionPda: string;
  seller: string;
  channelId: string;
  sessionNonce: number;
  reservationAmountAtomic: string;
  previousCumulativeAtomic: string;
  voucherDigest: string;
  cumulativeAmountAtomic: string;
  sequenceNumber: number;
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical_non_finite_number');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  throw new Error('canonical_value_unsupported');
}

function canonicalIdentity(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

/** Normalize the SDK's historical Solana alias to the CAIP-2 value persisted
 * by the managed facilitator. No other alias is accepted by this contract. */
export function canonicalFinalVoucherV2ReservationNetwork(
  network: string,
): string {
  if (
    network === 'solana:mainnet'
    || network === FINAL_VOUCHER_V2_SOLANA_MAINNET_CAIP2
  ) {
    return FINAL_VOUCHER_V2_SOLANA_MAINNET_CAIP2;
  }
  throw new Error('native_tab_v2_reservation_network_unsupported');
}

/**
 * Byte-for-byte mirror of the facilitator's voucher identity digest. It binds
 * the complete signed voucher, not merely its amount or local counter.
 */
export function finalVoucherV2Digest(voucher: SignedVoucher): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalIdentity({
    channelId: voucher.payload.channelId,
    cumulativeAmount: voucher.payload.cumulativeAmount,
    sequenceNumber: voucher.payload.sequenceNumber,
    sessionPublicKey: bytesToHex(voucher.sessionPublicKey),
    sessionSignature: bytesToHex(voucher.sessionSignature),
    sessionRegistration: bytesToHex(voucher.sessionRegistration),
  }))));
}

export function finalVoucherV2ReservationIdentity(voucher: SignedVoucher): {
  voucherDigest: string;
  idempotencyKey: string;
} {
  const voucherDigest = finalVoucherV2Digest(voucher);
  return {
    voucherDigest,
    idempotencyKey: `native-tab-v2:${voucherDigest}`,
  };
}

/**
 * Low-level cross-system digest over the shared reservation identity. This
 * helper exists so transaction builders and verifiers can lock byte-for-byte
 * parity without manufacturing a SignedVoucher for an already-derived digest.
 */
export function finalVoucherV2ReservationBindingDigestFromIdentity(
  identity: FinalVoucherV2ReservationBindingIdentity,
): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalIdentity({
    contract: FINAL_VOUCHER_V2_RESERVATION_BINDING_DOMAIN,
    network: canonicalFinalVoucherV2ReservationNetwork(identity.network),
    programId: identity.programId,
    buyerSwigAddress: identity.buyerSwigAddress,
    vaultPda: identity.vaultPda,
    sessionPda: identity.sessionPda,
    seller: identity.seller,
    channelId: identity.channelId,
    sessionNonce: identity.sessionNonce,
    reservationAmountAtomic: identity.reservationAmountAtomic,
    previousCumulativeAtomic: identity.previousCumulativeAtomic,
    voucherDigest: identity.voucherDigest,
    cumulativeAmountAtomic: identity.cumulativeAmountAtomic,
    sequenceNumber: identity.sequenceNumber,
  }))));
}

/**
 * Digest that must be carried by the same Dexter-authority-signed Solana
 * transaction as the exact `settle_voucher(increment=true)` reservation.
 *
 * The Vault instruction binds the on-chain amount and account identities. This
 * separate domain binds that economic effect to the complete FINAL voucher and
 * shared economic identity. Provider lifecycle, receipt, and retry identifiers
 * are deliberately excluded. The digest is computed locally from the voucher
 * bytes; a provider-supplied `voucherDigest` is never trusted as the source of
 * this transaction binding.
 */
export function finalVoucherV2ReservationBindingDigest(
  input: FinalVoucherV2ReservationInput,
): string {
  const voucherDigest = finalVoucherV2Digest(input.voucher);
  return finalVoucherV2ReservationBindingDigestFromIdentity({
    network: input.network,
    programId: input.programId,
    buyerSwigAddress: input.buyerSwigAddress,
    vaultPda: input.vaultPda,
    sessionPda: input.sessionPda,
    seller: input.seller,
    channelId: input.channelId,
    sessionNonce: input.sessionNonce,
    reservationAmountAtomic: input.reservationAmountAtomic,
    previousCumulativeAtomic: input.previousCumulativeAtomic,
    voucherDigest,
    cumulativeAmountAtomic: input.voucher.payload.cumulativeAmount,
    sequenceNumber: input.voucher.payload.sequenceNumber,
  });
}

/** Exact UTF-8 SPL Memo payload required in the reservation transaction. */
export function finalVoucherV2ReservationMemo(
  input: FinalVoucherV2ReservationInput,
): string {
  return `${FINAL_VOUCHER_V2_RESERVATION_MEMO_PREFIX}${
    finalVoucherV2ReservationBindingDigest(input)
  }`;
}

function invalid(field: string): never {
  throw new Error(`native_tab_v2_reservation_receipt_invalid:${field}`);
}

function requireSafeNonnegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid(field);
}

/**
 * Validate the provider's immutable voucher-bound receipt before asking the
 * chain adapter to prove the post-state independently. A receipt is evidence
 * of the provider's durable lifecycle record; it is not a substitute for the
 * adapter's chain read.
 */
export function assertFinalVoucherV2ReservationReceipt(
  input: FinalVoucherV2ReservationInput,
  receipt: FinalVoucherV2ReservationReceipt,
): void {
  if (!receipt || typeof receipt !== 'object') invalid('missing');

  const expectedDigest = finalVoucherV2Digest(input.voucher);
  if (!HEX_32.test(input.voucherDigest) || input.voucherDigest !== expectedDigest) {
    invalid('input_voucher_digest');
  }
  if (
    input.idempotencyKey !== `native-tab-v2:${expectedDigest}`
  ) {
    invalid('input_idempotency_identity');
  }

  const cumulative = BigInt(input.voucher.payload.cumulativeAmount);
  const previous = BigInt(input.previousCumulativeAtomic);
  const reservation = BigInt(input.reservationAmountAtomic);
  if (
    cumulative <= previous
    || cumulative - previous !== reservation
    || reservation <= 0n
  ) {
    invalid('input_reservation_delta');
  }
  if (
    input.voucher.payload.channelId !== input.channelId
    || (input.voucher.payload.sequenceNumber & 0x8000_0000) === 0
    || (input.sessionNonce & 0x8000_0000) === 0
    || input.voucher.sessionPublicKey.length !== 32
    || input.voucher.sessionSignature.length !== 64
    || input.voucher.sessionRegistration.length !== 188
  ) {
    invalid('input_voucher_identity');
  }

  if (
    receipt.contract !== 'dexter-native-tab-open-receipt/v1'
    && receipt.contract !== 'dexter-native-tab-open-receipt/v2'
  ) {
    invalid('contract');
  }
  if (!HEX_32.test(receipt.operationId)) invalid('operation_id');
  if (!OPERATION_ID.test(receipt.callerOperationId)) invalid('caller_operation_id');
  if (!TRANSACTION_SIGNATURE.test(receipt.transaction)) invalid('transaction');
  if (
    receipt.commitment !== 'confirmed'
    && receipt.commitment !== 'finalized'
  ) {
    invalid('commitment');
  }
  requireSafeNonnegativeInteger(receipt.confirmationSlot, 'confirmation_slot');
  requireSafeNonnegativeInteger(receipt.postStateSlot, 'post_state_slot');
  if (
    receipt.confirmationSlot === 0
    || receipt.postStateSlot < receipt.confirmationSlot
  ) {
    invalid('post_state_slot');
  }

  let inputNetwork: string;
  let receiptNetwork: string;
  try {
    inputNetwork = canonicalFinalVoucherV2ReservationNetwork(input.network);
    receiptNetwork = canonicalFinalVoucherV2ReservationNetwork(receipt.network);
  } catch {
    return invalid('network');
  }

  if (
    receiptNetwork !== inputNetwork
    || receipt.buyerSwigAddress !== input.buyerSwigAddress
    || receipt.vaultPda !== input.vaultPda
    || receipt.sessionPda !== input.sessionPda
    || receipt.seller !== input.seller
    || receipt.channelId !== input.channelId
    || receipt.sessionPublicKey !== bytesToHex(input.voucher.sessionPublicKey)
    || receipt.voucherDigest !== expectedDigest
    || receipt.cumulativeAmountAtomic
      !== input.voucher.payload.cumulativeAmount
    || receipt.sequenceNumber !== input.voucher.payload.sequenceNumber
    || !OPERATION_ID.test(receipt.providerReceiptId)
    || receipt.reservationAmountAtomic !== input.reservationAmountAtomic
    || receipt.currentOutstandingBeforeAtomic !== '0'
    || receipt.currentOutstandingAfterAtomic !== input.reservationAmountAtomic
  ) {
    invalid('economic_identity');
  }

  requireSafeNonnegativeInteger(
    receipt.pendingVoucherCountBefore,
    'pending_voucher_count_before',
  );
  requireSafeNonnegativeInteger(
    receipt.pendingVoucherCountAfter,
    'pending_voucher_count_after',
  );
  // This is a Vault-global counter, not a session-local monotonic value.
  // Sibling sessions may open or close between the provider's pre/post reads,
  // so the receipt records both observations but cannot require `after =
  // before + 1`. The exact reservation is instead proven by this session's
  // `currentOutstanding` transition and the adapter's coherent chain read.

  if (receipt.contract === 'dexter-native-tab-open-receipt/v1') {
    if (receipt.callerOperationId !== input.idempotencyKey) {
      invalid('idempotency_key');
    }
  } else if (
    receipt.rootOperationId !== input.idempotencyKey
    || !Number.isSafeInteger(receipt.generation)
    || Number(receipt.generation) < 2
    || !receipt.predecessorCallerOperationId
    || !receipt.predecessorLifecycleOperationId
    || !receipt.predecessorReleaseDigest
    || !receipt.stableReservationId
    || !receipt.economicEffectDigest
  ) {
    invalid('successor_identity');
  }
}
