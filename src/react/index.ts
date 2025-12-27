/**
 * @dexterai/x402 React
 *
 * React hooks for x402 v2 payments.
 * Works with Solana and EVM wallets.
 *
 * @example
 * ```tsx
 * import { useX402Payment } from '@dexterai/x402/react';
 * import { useWallet } from '@solana/wallet-adapter-react';
 * import { useAccount } from 'wagmi';
 *
 * function PayButton() {
 *   const solanaWallet = useWallet();
 *   const evmWallet = useAccount();
 *
 *   const {
 *     fetch,
 *     isLoading,
 *     balances,
 *     connectedChains,
 *   } = useX402Payment({
 *     wallets: {
 *       solana: solanaWallet,
 *       evm: evmWallet,
 *     },
 *   });
 *
 *   return (
 *     <div>
 *       <p>Solana: {connectedChains.solana ? '✅' : '❌'}</p>
 *       <p>Base: {connectedChains.evm ? '✅' : '❌'}</p>
 *       {balances.map(b => (
 *         <p key={b.network}>{b.chainName}: ${b.balance.toFixed(2)} {b.asset}</p>
 *       ))}
 *       <button onClick={() => fetch(url)} disabled={isLoading}>
 *         Pay
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */

export { useX402Payment } from './useX402Payment';
export type {
  UseX402PaymentConfig,
  UseX402PaymentReturn,
  PaymentStatus,
  ConnectedChains,
} from './useX402Payment';

// Re-export useful types
export type { BalanceInfo, WalletSet } from '../adapters/types';
export { X402Error } from '../types';
