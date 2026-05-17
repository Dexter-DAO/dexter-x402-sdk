/**
 * Batch-settlement seller runtime for the @dexterai/x402 SDK.
 *
 * A seller accepts batch-settlement payments (incoming vouchers are verified
 * and accumulated into durable channel storage) and collects them
 * (claim -> settle -> refund), automatically on a background loop and on
 * explicit demand.
 *
 * This is NOT streaming. Dexter's streaming product is Tab/OTS, a separate
 * project.
 *
 * @example
 * ```ts
 * import { createBatchSettlementSeller } from '@dexterai/x402/batch-settlement/seller';
 *
 * const seller = createBatchSettlementSeller({
 *   payTo: '0xSellerAddress',
 *   network: 'eip155:8453',
 *   price: '0.08',
 * });
 * app.use('/api/data', seller);   // the seller object is itself the handler
 * // ...later, on shutdown:
 * await seller.stop();
 * ```
 */
export { createBatchSettlementSeller } from './seller';
export type {
  BatchSettlementSeller,
  BatchSettlementSellerConfig,
  SellerCloseResult,
} from './types';
