/**
 * @dexterai/x402-solana/react
 *
 * React hooks for x402 v2 payments on Solana.
 *
 * @example
 * ```tsx
 * import { useX402Payment } from '@dexterai/x402-solana/react';
 * import { useWallet } from '@solana/wallet-adapter-react';
 *
 * function PayButton() {
 *   const wallet = useWallet();
 *   const { fetch, isLoading, balance, transactionUrl } = useX402Payment({
 *     wallet,
 *   });
 *
 *   const handlePay = async () => {
 *     const response = await fetch('https://api.example.com/paid-endpoint');
 *     const data = await response.json();
 *     console.log('Paid!', data);
 *   };
 *
 *   return (
 *     <div>
 *       <p>Balance: ${balance?.toFixed(2) ?? '...'} USDC</p>
 *       <button onClick={handlePay} disabled={isLoading}>
 *         {isLoading ? 'Paying...' : 'Pay'}
 *       </button>
 *       {transactionUrl && <a href={transactionUrl}>View Transaction</a>}
 *     </div>
 *   );
 * }
 * ```
 */

// Main hook
export { useX402Payment } from './useX402Payment';
export type {
  UseX402PaymentConfig,
  UseX402PaymentReturn,
  PaymentStatus,
} from './useX402Payment';

// Re-export useful constants and types from main package
export {
  SOLANA_MAINNET_NETWORK,
  USDC_MINT,
  DEXTER_FACILITATOR_URL,
  X402Error,
} from '../types';

export type {
  PaymentRequired,
  PaymentSignature,
  PaymentAccept,
  X402ErrorCode,
} from '../types';

