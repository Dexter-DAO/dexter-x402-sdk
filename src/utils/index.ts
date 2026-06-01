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
  getChainDisplayName,
  getExplorerUrl,
  getDefaultRpcUrl,
  type ChainFamily,
} from '../utils';

// RPC URL maps — the single source of truth for which endpoint each network
// resolves to. Exported so consumers (e.g. the OpenDexter MCP wallet reader)
// can resolve the same Dexter-proxied RPC the payment path uses, instead of
// hardcoding their own divergent map. Mainnet EVM + Solana route through the
// Dexter proxy; see constants.ts for the per-chain rationale.
export { SOLANA_RPC_URLS, EVM_RPC_URLS } from '../constants';
