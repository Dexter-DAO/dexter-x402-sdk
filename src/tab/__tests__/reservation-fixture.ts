import { bytesToHex } from '@noble/hashes/utils';

import type {
  FinalVoucherV2ReservationInput,
  FinalVoucherV2ReservationReceipt,
} from '../types';

/** Complete deterministic receipt for buyer-runtime unit tests. */
export function finalizedReservationReceipt(
  input: FinalVoucherV2ReservationInput,
): FinalVoucherV2ReservationReceipt {
  return {
    contract: 'dexter-native-tab-open-receipt/v1',
    operationId: 'a'.repeat(64),
    callerOperationId: input.idempotencyKey,
    network: input.network,
    transaction: '5'.repeat(88),
    commitment: 'finalized',
    confirmationSlot: 100,
    postStateSlot: 101,
    buyerSwigAddress: input.buyerSwigAddress,
    vaultPda: input.vaultPda,
    sessionPda: input.sessionPda,
    seller: input.seller,
    channelId: input.channelId,
    sessionPublicKey: bytesToHex(input.voucher.sessionPublicKey),
    voucherDigest: input.voucherDigest,
    cumulativeAmountAtomic: input.voucher.payload.cumulativeAmount,
    sequenceNumber: input.voucher.payload.sequenceNumber,
    providerReceiptId: 'native-tab-provider:attempt-1',
    reservationAmountAtomic: input.reservationAmountAtomic,
    pendingVoucherCountBefore: 0,
    pendingVoucherCountAfter: 1,
    currentOutstandingBeforeAtomic: '0',
    currentOutstandingAfterAtomic: input.reservationAmountAtomic,
  };
}
