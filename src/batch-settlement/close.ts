import { formatUnits } from 'viem';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { BatchSettlementEvmScheme as BatchSettlementServerScheme } from '@x402/evm/batch-settlement/server';
import type { CloseReceipt } from './types';

/** USDC has 6 decimals on all supported chains. */
const USDC_DECIMALS = 6;

/**
 * The slice of the upstream `BatchSettlementChannelManager` that close() drives.
 *
 * These shapes are verified against `@x402/evm` 2.12.0:
 * - `claimAndSettle()` resolves to `{ claims, settle? }`. `claims` is one
 *   `ClaimResult` per submitted voucher batch (`settle` is omitted when there
 *   was nothing to claim).
 * - `refund(channelIds)` resolves to one `RefundResult` per refunded channel.
 *
 * The upstream manager returns only transaction hashes — it does NOT surface
 * settled/refunded amounts — so the human-unit amounts on `CloseReceipt` come
 * from the channel's own accounting (passed to `runClose` as atomic strings),
 * not from the manager.
 */
export interface ClaimResultLike {
  /** Number of vouchers included in this claim batch. */
  vouchers: number;
  /** On-chain claim transaction hash. */
  transaction: string;
}

export interface SettleResultLike {
  /** On-chain settle transaction hash. */
  transaction: string;
}

export interface RefundResultLike {
  /** Channel id that was refunded. */
  channel: string;
  /** On-chain refund transaction hash. */
  transaction: string;
}

export interface ChannelManagerLike {
  claimAndSettle(): Promise<{ claims: ClaimResultLike[]; settle?: SettleResultLike }>;
  refund(channelIds: string[]): Promise<RefundResultLike[]>;
}

/** Atomic-unit (6-decimal USDC) amounts the close caller already knows from channel accounting. */
export interface CloseAmounts {
  /** Amount claimed/settled to the seller, atomic units (e.g. "160000" === "0.16"). */
  settledAtomic: string;
  /** Unspent escrow returned to the buyer, atomic units (e.g. "140000" === "0.14"). */
  refundedAtomic: string;
}

/**
 * Runs the close sequence: claimAndSettle (claim + settle on-chain) then refund.
 * The facilitator's fee-payer pays gas for all three transactions. Any failure
 * throws — close() never reports a partial success.
 *
 * `claimTx`/`settleTx` are empty strings only when the channel had nothing to
 * claim (a fully-unspent channel). If the channel's accounting expected a
 * settled amount but the facilitator reported no claim, `runClose` throws
 * rather than returning an inconsistent receipt.
 *
 * The upstream manager reports only transaction hashes, so the seller/buyer
 * amounts are taken from the channel's own accounting via `amounts` and
 * converted from atomic units to USDC human units.
 */
export async function runClose(
  manager: ChannelManagerLike,
  channelId: string,
  amounts: CloseAmounts,
): Promise<CloseReceipt> {
  const { claims, settle } = await manager.claimAndSettle();
  if (claims.length === 0 && BigInt(amounts.settledAtomic) > 0n) {
    throw new Error(
      `batch-settlement close inconsistency: channel accounting expected a settled amount of ${amounts.settledAtomic} atomic units, but the facilitator's claimAndSettle reported no claim transaction (claims was empty)`,
    );
  }
  const refunds = await manager.refund([channelId]);
  const refund = refunds[0];
  return {
    claimTx: claims[0]?.transaction ?? '',
    settleTx: settle?.transaction ?? '',
    refundTx: refund?.transaction ?? '',
    settledAmount: formatUnits(BigInt(amounts.settledAtomic), USDC_DECIMALS),
    refundedAmount: formatUnits(BigInt(amounts.refundedAtomic), USDC_DECIMALS),
  };
}

/**
 * Builds the upstream channel manager: a server scheme + an HTTPFacilitatorClient
 * pointed at the facilitator, which submits the claim/settle/refund transactions
 * and pays their gas. `receiver` is the seller's payout address (the channel's
 * payTo); the upstream server scheme requires it at construction.
 */
export function buildChannelManager(
  facilitatorUrl: string,
  network: string,
  receiver: string,
): ChannelManagerLike {
  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const serverScheme = new BatchSettlementServerScheme(receiver as `0x${string}`);
  return serverScheme.createChannelManager(
    facilitatorClient,
    network as `${string}:${string}`,
  ) as unknown as ChannelManagerLike;
}
