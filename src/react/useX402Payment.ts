/**
 * React Hook for x402 v2 Payments
 *
 * Chain-agnostic hook that manages payment state, wallet connection,
 * and balances across Solana and EVM chains.
 *
 * @example
 * ```tsx
 * import { useX402Payment } from '@dexterai/x402/react';
 *
 * function PayButton() {
 *   const {
 *     fetch,
 *     isLoading,
 *     status,
 *     error,
 *     balances,
 *     connectedChains,
 *     transactionUrl,
 *   } = useX402Payment({
 *     wallets: {
 *       solana: solanaWallet,
 *       evm: evmWallet,
 *     },
 *   });
 *
 *   return (
 *     <button onClick={() => fetch(url)} disabled={isLoading}>
 *       {isLoading ? 'Paying...' : 'Pay $0.05'}
 *     </button>
 *   );
 * }
 * ```
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { createX402Client } from '../client/x402-client';
import type { X402Client } from '../client/x402-client';
import type { WalletSet, BalanceInfo } from '../adapters/types';
import { createSolanaAdapter, createEvmAdapter, isSolanaWallet, isEvmWallet } from '../adapters';
import { X402Error, SOLANA_MAINNET_NETWORK, BASE_MAINNET_NETWORK, USDC_MINT, USDC_BASE } from '../types';
import { getChainName, getExplorerUrl } from '../utils';

// ============================================================================
// Types
// ============================================================================

/** Payment flow status */
export type PaymentStatus = 'idle' | 'pending' | 'success' | 'error';

/** Which chains are connected */
export interface ConnectedChains {
  solana: boolean;
  evm: boolean;
}

/** Configuration for the hook */
export interface UseX402PaymentConfig {
  /**
   * Wallets for each chain type.
   * Pass the wallets from your wallet adapter(s).
   */
  wallets?: WalletSet;

  /**
   * Legacy: Single Solana wallet.
   * Use `wallets` for multi-chain support.
   */
  wallet?: unknown;

  /**
   * Preferred network when multiple options are available.
   * CAIP-2 format (e.g., 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
   */
  preferredNetwork?: string;

  /**
   * Custom RPC URLs by network
   */
  rpcUrls?: Record<string, string>;

  /**
   * Enable verbose logging
   */
  verbose?: boolean;
}

/** Return value from the hook */
export interface UseX402PaymentReturn {
  /**
   * Fetch function with automatic x402 payment handling.
   * Same signature as global fetch.
   */
  fetch: X402Client['fetch'];

  /** Whether a payment is in progress */
  isLoading: boolean;

  /** Current payment status */
  status: PaymentStatus;

  /** Error if payment failed */
  error: Error | null;

  /** Transaction signature/hash on success */
  transactionId: string | null;

  /** Network the payment was made on */
  transactionNetwork: string | null;

  /** Explorer URL for the transaction */
  transactionUrl: string | null;

  /** Token balances across chains */
  balances: BalanceInfo[];

  /** Which chains have connected wallets */
  connectedChains: ConnectedChains;

  /** Whether any wallet is connected */
  isAnyWalletConnected: boolean;

  /** Reset state (clear errors, transaction info) */
  reset: () => void;

  /** Refresh balances manually */
  refreshBalances: () => Promise<void>;
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * React hook for managing x402 v2 payments across chains
 */
export function useX402Payment(config: UseX402PaymentConfig): UseX402PaymentReturn {
  const {
    wallets: walletSet,
    wallet: legacyWallet,
    preferredNetwork,
    rpcUrls = {},
    verbose = false,
  } = config;

  // State
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<PaymentStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [transactionNetwork, setTransactionNetwork] = useState<string | null>(null);
  const [balances, setBalances] = useState<BalanceInfo[]>([]);

  // Logging
  const log = useCallback((...args: unknown[]) => {
    if (verbose) console.log('[useX402Payment]', ...args);
  }, [verbose]);

  // Build wallet set
  const wallets: WalletSet = useMemo(() => {
    const w: WalletSet = { ...walletSet };
    if (legacyWallet && !w.solana && isSolanaWallet(legacyWallet)) {
      w.solana = legacyWallet;
    }
    if (legacyWallet && !w.evm && isEvmWallet(legacyWallet)) {
      w.evm = legacyWallet;
    }
    return w;
  }, [walletSet, legacyWallet]);

  // Create adapters
  const adapters = useMemo(() => [
    createSolanaAdapter({ verbose, rpcUrls }),
    createEvmAdapter({ verbose, rpcUrls }),
  ], [verbose, rpcUrls]);

  // Check connected chains
  const connectedChains = useMemo((): ConnectedChains => ({
    solana: wallets.solana ? isSolanaWallet(wallets.solana) && adapters[0].isConnected(wallets.solana) : false,
    evm: wallets.evm ? isEvmWallet(wallets.evm) && adapters[1].isConnected(wallets.evm) : false,
  }), [wallets, adapters]);

  const isAnyWalletConnected = connectedChains.solana || connectedChains.evm;

  // Refresh balances
  const refreshBalances = useCallback(async () => {
    const newBalances: BalanceInfo[] = [];

    // Solana balance
    if (connectedChains.solana && wallets.solana) {
      try {
        const solanaAdapter = adapters.find(a => a.name === 'Solana');
        if (solanaAdapter) {
          const accept = {
            scheme: 'exact' as const,
            network: SOLANA_MAINNET_NETWORK,
            amount: '0',
            asset: USDC_MINT,
            payTo: '',
            maxTimeoutSeconds: 60,
            extra: { feePayer: '', decimals: 6 },
          };
          const balance = await solanaAdapter.getBalance(accept, wallets.solana);
          newBalances.push({
            network: SOLANA_MAINNET_NETWORK,
            chainName: getChainName(SOLANA_MAINNET_NETWORK),
            balance,
            asset: 'USDC',
          });
        }
      } catch (e) {
        log('Failed to fetch Solana balance:', e);
      }
    }

    // Base balance
    if (connectedChains.evm && wallets.evm) {
      try {
        const evmAdapter = adapters.find(a => a.name === 'EVM');
        if (evmAdapter) {
          const accept = {
            scheme: 'exact' as const,
            network: BASE_MAINNET_NETWORK,
            amount: '0',
            asset: USDC_BASE,
            payTo: '',
            maxTimeoutSeconds: 60,
            extra: { feePayer: '', decimals: 6 },
          };
          const balance = await evmAdapter.getBalance(accept, wallets.evm);
          newBalances.push({
            network: BASE_MAINNET_NETWORK,
            chainName: getChainName(BASE_MAINNET_NETWORK),
            balance,
            asset: 'USDC',
          });
        }
      } catch (e) {
        log('Failed to fetch Base balance:', e);
      }
    }

    setBalances(newBalances);
  }, [connectedChains, wallets, adapters, log]);

  // Refresh balances on mount and when wallets change
  useEffect(() => {
    refreshBalances();
    const interval = setInterval(refreshBalances, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [refreshBalances]);

  // Reset state
  const reset = useCallback(() => {
    setIsLoading(false);
    setStatus('idle');
    setError(null);
    setTransactionId(null);
    setTransactionNetwork(null);
  }, []);

  // Create client
  const client = useMemo(() => createX402Client({
    adapters,
    wallets,
    preferredNetwork,
    rpcUrls,
    verbose,
  }), [adapters, wallets, preferredNetwork, rpcUrls, verbose]);

  // Wrapped fetch
  const fetchWithPayment = useCallback(async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    setIsLoading(true);
    setStatus('pending');
    setError(null);
    setTransactionId(null);
    setTransactionNetwork(null);

    if (!isAnyWalletConnected) {
      const connError = new X402Error('wallet_not_connected', 'No wallet connected');
      setError(connError);
      setStatus('error');
      setIsLoading(false);
      throw connError;
    }

    try {
      const response = await client.fetch(input, init);

      // Try to extract transaction info from response
      const paymentResponse = response.headers.get('PAYMENT-RESPONSE');
      if (paymentResponse) {
        try {
          const decoded = JSON.parse(atob(paymentResponse));
          if (decoded.transaction) {
            setTransactionId(decoded.transaction);
          }
          if (decoded.network) {
            setTransactionNetwork(decoded.network);
          }
        } catch {
          log('Could not parse PAYMENT-RESPONSE header');
        }
      }

      setStatus('success');
      return response;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      setStatus('error');
      throw err;
    } finally {
      setIsLoading(false);
      // Refresh balances after payment attempt
      setTimeout(refreshBalances, 2000);
    }
  }, [client, isAnyWalletConnected, log, refreshBalances]);

  // Transaction URL
  const transactionUrl = useMemo(() => {
    if (!transactionId) return null;
    const network = transactionNetwork || preferredNetwork || SOLANA_MAINNET_NETWORK;
    return getExplorerUrl(transactionId, network);
  }, [transactionId, transactionNetwork, preferredNetwork]);

  return {
    fetch: fetchWithPayment,
    isLoading,
    status,
    error,
    transactionId,
    transactionNetwork,
    transactionUrl,
    balances,
    connectedChains,
    isAnyWalletConnected,
    reset,
    refreshBalances,
  };
}
