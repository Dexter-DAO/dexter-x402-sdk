import { formatUnits } from 'viem';
import type { CloseReceipt } from '../types';
import type { SellerCloseResult } from './types';

/** USDC has 6 decimals on all supported chains. */
const USDC_DECIMALS = 6;

/** The slice of the upstream BatchSettlementChannelManager used here. */
export interface ChannelManagerLike {
  claimAndSettle(): Promise<{
    claims: Array<{ vouchers: number; transaction: string }>;
    settle?: { transaction: string };
  }>;
  refund(channelIds: string[]): Promise<Array<{ channel: string; transaction: string }>>;
}

/** The slice of ChannelStorage used here. */
export interface ChannelStoreLike {
  get(channelId: string): Promise<
    { channelId: string; balance?: string; chargedCumulativeAmount?: string } | undefined
  >;
  list(): Promise<Array<{ channelId: string; balance?: string; chargedCumulativeAmount?: string }>>;
}

/**
 * Claims, settles, and refunds one channel. The facilitator's fee-payer pays
 * gas. settledAmount/refundedAmount are derived from the channel's stored
 * accounting (the upstream manager returns only transaction hashes).
 * Any failure throws.
 */
export async function closeChannel(args: {
  manager: ChannelManagerLike;
  store: ChannelStoreLike;
  channelId: string;
}): Promise<CloseReceipt> {
  const { manager, store, channelId } = args;
  const channel = await store.get(channelId);
  const chargedAtomic = BigInt(channel?.chargedCumulativeAmount ?? '0');
  const balanceAtomic = BigInt(channel?.balance ?? '0');
  const refundAtomic = balanceAtomic > chargedAtomic ? balanceAtomic - chargedAtomic : 0n;

  const { claims, settle } = await manager.claimAndSettle();
  const refunds = await manager.refund([channelId]);
  const refund = refunds.find((r) => r.channel === channelId) ?? refunds[0];

  return {
    claimTx: claims[0]?.transaction ?? '',
    settleTx: settle?.transaction ?? '',
    refundTx: refund?.transaction ?? '',
    settledAmount: formatUnits(chargedAtomic, USDC_DECIMALS),
    refundedAmount: formatUnits(refundAtomic, USDC_DECIMALS),
  };
}

/**
 * Settles every channel currently in storage. A per-channel failure is
 * recorded in that channel's result entry; it does not abort the others and
 * the call does not throw.
 */
export async function closeAll(args: {
  manager: ChannelManagerLike;
  store: ChannelStoreLike;
}): Promise<SellerCloseResult[]> {
  const channels = await args.store.list();
  const results: SellerCloseResult[] = [];
  for (const channel of channels) {
    try {
      const receipt = await closeChannel({
        manager: args.manager,
        store: args.store,
        channelId: channel.channelId,
      });
      results.push({ channelId: channel.channelId, ...receipt });
    } catch (err) {
      results.push({
        channelId: channel.channelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
