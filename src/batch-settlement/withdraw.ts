/**
 * Buyer withdrawal escape hatch for batch-settlement escrow channels.
 *
 * Normally a buyer's unspent escrow returns via the seller's
 * `refundWithSignature`. If the seller goes dark and never settles, the buyer
 * must be able to reclaim the unspent escrow directly on-chain. The
 * `x402BatchSettlement` contract provides a two-step timed withdrawal:
 *
 *   1. `initiateWithdraw(config, amount)` — starts the `withdrawDelay` timer.
 *   2. `finalizeWithdraw(config)` — after the delay, returns the funds.
 *
 * Both are buyer-submitted and cost the buyer gas. There is deliberately no
 * facilitator-relayed variant: the escape cannot be sponsored by the party
 * being escaped from.
 */
import { formatUnits, type Address } from 'viem';
import { computeChannelId } from '@x402/evm/batch-settlement/client';
import { BATCH_SETTLEMENT_ADDRESS } from '@x402/evm';
import type { ChannelConfig } from '@x402/evm';

/** Thrown by finalizeWithdraw when called before the withdrawDelay elapses. */
export class WithdrawNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WithdrawNotReadyError';
  }
}

/** Result of forceWithdraw — the initiate tx and when finalize becomes possible. */
export interface ForceWithdrawResult {
  /** initiateWithdraw transaction hash. */
  initiateTx: string;
  /** Unix seconds at which finalizeWithdraw becomes callable. */
  finalizableAt: number;
}

/** Result of finalizeWithdraw. */
export interface FinalizeWithdrawResult {
  /** finalizeWithdraw transaction hash. */
  finalizeTx: string;
  /** Amount returned to the buyer, USDC human units. */
  withdrawnAmount: string;
}

/**
 * Unix-seconds timestamp at which a withdrawal initiated at `initiatedAt`
 * becomes finalizable. Returns 0 when `initiatedAt` is 0 (no pending withdrawal).
 */
export function computeFinalizableAt(initiatedAt: number, withdrawDelaySecs: number): number {
  if (initiatedAt === 0) return 0;
  return initiatedAt + withdrawDelaySecs;
}

/** USDC has 6 decimals on every batch-settlement-supported chain. */
const USDC_DECIMALS = 6;

/**
 * The `ChannelConfig` tuple components, in ABI order — mirrors the upstream
 * `channelConfigComponents` (not type-exported from
 * `@x402/evm/batch-settlement/client`, so declared here). The order matches the
 * exported `ChannelConfig` type's keccak-encoded layout.
 */
const channelConfigComponents = [
  { name: 'payer', type: 'address' },
  { name: 'payerAuthorizer', type: 'address' },
  { name: 'receiver', type: 'address' },
  { name: 'receiverAuthorizer', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'withdrawDelay', type: 'uint40' },
  { name: 'salt', type: 'bytes32' },
] as const;

/**
 * The four `x402BatchSettlement` ABI fragments the escape hatch needs. Declared
 * inline because `@x402/evm/batch-settlement/client` exports `computeChannelId`
 * and `buildChannelConfig` but NOT the full `batchSettlementABI`. Signatures are
 * verified against the `batchSettlementABI` in `@x402/evm` 2.12.
 */
const withdrawABI = [
  {
    type: 'function',
    name: 'initiateWithdraw',
    inputs: [
      { name: 'config', type: 'tuple', components: channelConfigComponents },
      { name: 'amount', type: 'uint128' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'finalizeWithdraw',
    inputs: [{ name: 'config', type: 'tuple', components: channelConfigComponents }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'pendingWithdrawals',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [
      { name: 'amount', type: 'uint128' },
      { name: 'initiatedAt', type: 'uint40' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'channels',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [
      { name: 'balance', type: 'uint128' },
      { name: 'totalClaimed', type: 'uint128' },
    ],
    stateMutability: 'view',
  },
] as const;

/**
 * Minimal viem-shaped client surface the escape hatch needs: a wallet that can
 * submit transactions (`writeContract`) plus public reads (`readContract`,
 * `waitForTransactionReceipt`). The buyer's batch-settlement channel already
 * builds exactly such a client (a `createWalletClient(...).extend(publicActions)`).
 */
export interface WithdrawWalletClient {
  writeContract(args: {
    address: Address;
    abi: typeof withdrawABI;
    functionName: 'initiateWithdraw' | 'finalizeWithdraw';
    args: readonly unknown[];
  }): Promise<`0x${string}`>;
  readContract(args: {
    address: Address;
    abi: typeof withdrawABI;
    functionName: 'pendingWithdrawals' | 'channels';
    args: readonly unknown[];
  }): Promise<unknown>;
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<unknown>;
}

/** Arguments for {@link forceWithdraw} and {@link finalizeWithdraw}. */
export interface WithdrawArgs {
  /** The channel's on-chain config tuple. */
  config: ChannelConfig;
  /** CAIP-2 network (e.g. "eip155:8453") or numeric chain id. */
  network: string | number;
  /** Buyer wallet client — submits the tx (buyer pays gas) and reads channel state. */
  client: WithdrawWalletClient;
  /** The channel's withdrawDelay, seconds. Used to compute when finalize unlocks. */
  withdrawDelaySecs: number;
  /**
   * Optional override of the amount to withdraw, atomic USDC units. When
   * omitted, the channel's full unspent balance (`channels(channelId).balance`)
   * is withdrawn.
   */
  amountAtomic?: bigint;
}

/** Decodes a `channels(channelId)` view result into `{ balance, totalClaimed }`. */
function readChannelsResult(raw: unknown): { balance: bigint; totalClaimed: bigint } {
  // viem returns a struct with named outputs as an object, or a tuple as an array.
  if (Array.isArray(raw)) {
    return { balance: BigInt(raw[0] as bigint), totalClaimed: BigInt(raw[1] as bigint) };
  }
  const o = raw as { balance: bigint; totalClaimed: bigint };
  return { balance: BigInt(o.balance), totalClaimed: BigInt(o.totalClaimed) };
}

/** Decodes a `pendingWithdrawals(channelId)` result into `{ amount, initiatedAt }`. */
function readPendingResult(raw: unknown): { amount: bigint; initiatedAt: number } {
  if (Array.isArray(raw)) {
    return { amount: BigInt(raw[0] as bigint), initiatedAt: Number(raw[1] as bigint) };
  }
  const o = raw as { amount: bigint; initiatedAt: bigint | number };
  return { amount: BigInt(o.amount), initiatedAt: Number(o.initiatedAt) };
}

/**
 * Escape hatch step 1 — initiates an on-chain withdrawal of the channel's
 * unspent escrow, starting the `withdrawDelay` timer.
 *
 * Reads the channel's unspent balance via the `channels(channelId)` view (unless
 * `amountAtomic` is supplied), submits `initiateWithdraw(config, amount)` with
 * the buyer's wallet (buyer pays gas), then reads `pendingWithdrawals(channelId)`
 * to learn `initiatedAt` and returns when `finalizeWithdraw` becomes callable.
 *
 * The buyer wallet must hold the chain's native gas token. A `writeContract`
 * failure (e.g. insufficient funds) surfaces directly — it is not swallowed.
 */
export async function forceWithdraw(args: WithdrawArgs): Promise<ForceWithdrawResult> {
  const { config, network, client, withdrawDelaySecs } = args;
  const channelId = computeChannelId(config, network);

  let amount = args.amountAtomic;
  if (amount === undefined) {
    const channel = readChannelsResult(
      await client.readContract({
        address: BATCH_SETTLEMENT_ADDRESS as Address,
        abi: withdrawABI,
        functionName: 'channels',
        args: [channelId],
      }),
    );
    amount = channel.balance;
  }

  const initiateTx = await client.writeContract({
    address: BATCH_SETTLEMENT_ADDRESS as Address,
    abi: withdrawABI,
    functionName: 'initiateWithdraw',
    args: [config, amount],
  });
  await client.waitForTransactionReceipt({ hash: initiateTx });

  const pending = readPendingResult(
    await client.readContract({
      address: BATCH_SETTLEMENT_ADDRESS as Address,
      abi: withdrawABI,
      functionName: 'pendingWithdrawals',
      args: [channelId],
    }),
  );

  return {
    initiateTx,
    finalizableAt: computeFinalizableAt(pending.initiatedAt, withdrawDelaySecs),
  };
}

/**
 * Escape hatch step 2 — finalizes a withdrawal started by {@link forceWithdraw},
 * after `withdrawDelay` has elapsed; the funds return to the buyer.
 *
 * Reads `pendingWithdrawals(channelId)`; throws {@link WithdrawNotReadyError}
 * when no withdrawal is pending or the delay has not yet elapsed. Otherwise
 * submits `finalizeWithdraw(config)` with the buyer's wallet (buyer pays gas)
 * and returns the withdrawn amount in USDC human units.
 *
 * A `writeContract` failure surfaces directly — it is not swallowed.
 */
export async function finalizeWithdraw(args: WithdrawArgs): Promise<FinalizeWithdrawResult> {
  const { config, network, client, withdrawDelaySecs } = args;
  const channelId = computeChannelId(config, network);

  const pending = readPendingResult(
    await client.readContract({
      address: BATCH_SETTLEMENT_ADDRESS as Address,
      abi: withdrawABI,
      functionName: 'pendingWithdrawals',
      args: [channelId],
    }),
  );

  if (pending.initiatedAt === 0) {
    throw new WithdrawNotReadyError(
      `no withdrawal is pending for channel ${channelId} — call forceWithdraw first`,
    );
  }

  const finalizableAt = computeFinalizableAt(pending.initiatedAt, withdrawDelaySecs);
  const nowSecs = Math.floor(Date.now() / 1000);
  if (nowSecs < finalizableAt) {
    throw new WithdrawNotReadyError(
      `withdrawal for channel ${channelId} is not finalizable until ${finalizableAt} ` +
        `(unix seconds) — ${finalizableAt - nowSecs}s remaining`,
    );
  }

  const finalizeTx = await client.writeContract({
    address: BATCH_SETTLEMENT_ADDRESS as Address,
    abi: withdrawABI,
    functionName: 'finalizeWithdraw',
    args: [config],
  });
  await client.waitForTransactionReceipt({ hash: finalizeTx });

  return {
    finalizeTx,
    withdrawnAmount: formatUnits(pending.amount, USDC_DECIMALS),
  };
}
