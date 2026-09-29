import type { SettleResponse } from '../types';

export function isSettlementUnknown(receipt: SettleResponse): boolean {
  return receipt.errorCode === 'settlement_unknown' || receipt.errorReason === 'settlement_unknown';
}

/** Remove internal response evidence before exposing a settlement receipt to a buyer. */
export function publicSettlementReceipt(receipt: SettleResponse): SettleResponse {
  if (isSettlementUnknown(receipt)) {
    const transaction = typeof receipt.transaction === 'string'
      && /^(?:0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/.test(receipt.transaction)
      ? receipt.transaction : undefined;
    return {
      success: false,
      network: receipt.network,
      errorCode: 'settlement_unknown',
      ...(transaction ? { transaction } : {}),
    };
  }
  const { facilitatorResponse: _evidence, ...publicReceipt } = receipt;
  return publicReceipt;
}
