/**
 * useX402Payment - React hook for x402 v2 payments
 *
 * Wraps the x402 client with React state management.
 * Provides balance checking, wallet status, and transaction tracking.
 *
 * @example
 * ```tsx
 * const { fetch, isLoading, balance, transactionUrl } = useX402Payment({
 *   wallet,
 *   network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
 * });
 *
 * const response = await fetch('https://api.example.com/paid-endpoint');
 * ```
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { createX402Client, type X402Wallet } from '../client/x402-client';
import { SOLANA_MAINNET_NETWORK, USDC_MINT } from '../types';
import { getDefaultRpcUrl } from '../utils';

/**
 * Payment status states
 */
export type PaymentStatus = 'idle' | 'pending' | 'success' | 'error';

/**
 * Configuration for useX402Payment hook
 */
export interface UseX402PaymentConfig {
  /** Wallet adapter with publicKey and signTransaction */
  wallet: X402Wallet;
  /** CAIP-2 network identifier (defaults to Solana mainnet) */
  network?: string;
  /** Solana RPC URL (optional) */
  rpcUrl?: string;
  /** Maximum payment amount in atomic units (optional cap) */
  maxAmountAtomic?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Return type for useX402Payment hook
 */
export interface UseX402PaymentReturn {
  /** Make a fetch request with automatic x402 v2 payment handling */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Whether a payment is currently in progress */
  isLoading: boolean;
  /** Current payment status */
  status: PaymentStatus;
  /** Error from last payment attempt */
  error: Error | null;
  /** Transaction signature from last successful payment */
  transactionId: string | null;
  /** Orb Markets link to view the transaction */
  transactionUrl: string | null;
  /** Reset state to idle */
  reset: () => void;
  /** User's USDC balance in human units (e.g., 12.50) */
  balance: number | null;
  /** Whether wallet is connected and ready */
  isWalletConnected: boolean;
  /** Refresh the USDC balance */
  refreshBalance: () => Promise<void>;
}

/**
 * React hook for x402 v2 payments on Solana
 *
 * Features:
 * - Automatic 402 handling with PAYMENT-REQUIRED/PAYMENT-SIGNATURE headers
 * - USDC balance tracking
 * - Wallet connection status
 * - Transaction URL for block explorer
 */
export function useX402Payment(config: UseX402PaymentConfig): UseX402PaymentReturn {
  const {
    wallet,
    network = SOLANA_MAINNET_NETWORK,
    rpcUrl,
    maxAmountAtomic,
    verbose = false,
  } = config;

  // State
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<PaymentStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  // Derived state
  const isWalletConnected = useMemo(() => {
    return wallet?.publicKey !== null && wallet?.publicKey !== undefined;
  }, [wallet?.publicKey]);

  const transactionUrl = useMemo(() => {
    if (!transactionId) return null;
    return `https://www.orbmarkets.io/tx/${transactionId}`;
  }, [transactionId]);

  // RPC connection
  const resolvedRpcUrl = useMemo(() => {
    return rpcUrl || getDefaultRpcUrl(network);
  }, [rpcUrl, network]);

  // Create x402 client
  const client = useMemo(() => {
    return createX402Client({
      wallet,
      network,
      rpcUrl: resolvedRpcUrl,
      maxAmountAtomic,
      verbose,
    });
  }, [wallet, network, resolvedRpcUrl, maxAmountAtomic, verbose]);

  // Fetch USDC balance
  const refreshBalance = useCallback(async () => {
    if (!isWalletConnected || !wallet.publicKey) {
      setBalance(null);
      return;
    }

    try {
      const connection = new Connection(resolvedRpcUrl, 'confirmed');
      const walletPubkey = new PublicKey(wallet.publicKey.toBase58());
      const usdcMint = new PublicKey(USDC_MINT);

      const ata = await getAssociatedTokenAddress(usdcMint, walletPubkey);
      const account = await getAccount(connection, ata);

      // USDC has 6 decimals
      const balanceHuman = Number(account.amount) / 1_000_000;
      setBalance(balanceHuman);
    } catch {
      // Token account doesn't exist or other error
      setBalance(0);
    }
  }, [isWalletConnected, wallet.publicKey, resolvedRpcUrl]);

  // Fetch balance on mount and when wallet changes
  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  // Reset state
  const reset = useCallback(() => {
    setIsLoading(false);
    setStatus('idle');
    setError(null);
    setTransactionId(null);
  }, []);

  // Wrapped fetch with state management
  const wrappedFetch = useCallback(
    async (url: string, init?: RequestInit): Promise<Response> => {
      setIsLoading(true);
      setStatus('pending');
      setError(null);
      setTransactionId(null);

      try {
        const response = await client.fetch(url, init);

        // Try to extract transaction ID from response headers
        const paymentResponse = response.headers.get('X-PAYMENT-RESPONSE');
        if (paymentResponse) {
          try {
            const decoded = JSON.parse(atob(paymentResponse));
            const txId = decoded.transaction || decoded.transactionId || decoded.signature;
            if (txId) {
              setTransactionId(txId);
            }
          } catch {
            // Ignore decode errors
          }
        }

        setStatus('success');
        setIsLoading(false);

        // Refresh balance after successful payment
        refreshBalance();

        return response;
      } catch (err) {
        const paymentError = err instanceof Error ? err : new Error(String(err));
        setError(paymentError);
        setStatus('error');
        setIsLoading(false);
        throw err;
      }
    },
    [client, refreshBalance]
  );

  return {
    fetch: wrappedFetch,
    isLoading,
    status,
    error,
    transactionId,
    transactionUrl,
    reset,
    balance,
    isWalletConnected,
    refreshBalance,
  };
}

