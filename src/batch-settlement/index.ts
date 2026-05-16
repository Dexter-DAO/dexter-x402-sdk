/**
 * Batch-settlement — escrow-channel batching for the @dexterai/x402 SDK.
 *
 * A buyer pre-funds an escrow channel once, makes many DISCRETE paid API
 * calls against it with cheap off-chain vouchers, and closes the channel
 * (settle + refund). It amortizes gas across many discrete purchases.
 *
 * This is NOT a streaming primitive. Dexter's streaming product is Tab/OTS,
 * a separate project.
 *
 * @example
 * ```ts
 * import { openBatchChannel } from '@dexterai/x402/batch-settlement';
 *
 * const channel = await openBatchChannel({
 *   wallet: evmWallet,
 *   network: 'eip155:8453',
 *   deposit: '0.30',
 * });
 * const a = await channel.fetch('https://api.example.com/v1/data');
 * const b = await channel.fetch('https://api.example.com/v1/data');
 * const receipt = await channel.close();
 * ```
 */
export { openBatchChannel, resumeBatchChannel } from './channel';
export {
  createFileChannelStore,
  createLocalStorageChannelStore,
  getDefaultChannelStore,
} from './store';
export {
  InsufficientBalanceError,
  UnsupportedNetworkError,
} from './types';
export type {
  BatchSettlementChannel,
  OpenBatchChannelOptions,
  ResumeBatchChannelOptions,
  ChannelState,
  ChannelStore,
  CloseReceipt,
} from './types';
