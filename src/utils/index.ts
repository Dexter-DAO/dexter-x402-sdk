/**
 * @dexterai/x402 Utils
 *
 * Helper functions for x402 payments.
 *
 * @example
 * ```typescript
 * import { toAtomicUnits, fromAtomicUnits } from '@dexterai/x402/utils';
 *
 * const atomic = toAtomicUnits(0.05, 6); // '50000'
 * const human = fromAtomicUnits('50000', 6); // 0.05
 * ```
 */

export {
  toAtomicUnits,
  fromAtomicUnits,
  getChainFamily,
  getChainName,
  getExplorerUrl,
  type ChainFamily,
} from '../utils';
