/**
 * x402 v2 Client
 *
 * Chain-agnostic client for x402 v2 payments.
 * Automatically detects 402 responses, finds a matching payment option,
 * builds the transaction with the appropriate chain adapter, and retries.
 *
 * @example
 * ```typescript
 * import { createX402Client } from '@dexterai/x402/client';
 * import { createSolanaAdapter, createEvmAdapter } from '@dexterai/x402/adapters';
 *
 * const client = createX402Client({
 *   adapters: [createSolanaAdapter(), createEvmAdapter()],
 *   wallets: {
 *     solana: solanaWallet,
 *     evm: evmWallet,
 *   },
 * });
 *
 * const response = await client.fetch(url);
 * ```
 */

import type { ChainAdapter, WalletSet } from '../adapters/types';
import type {
  PaymentRequired,
  PaymentAccept,
} from '../types';
import { X402Error } from '../types';
import { createSolanaAdapter, createEvmAdapter, isSolanaWallet, isEvmWallet } from '../adapters';

/**
 * Client configuration
 */
export interface X402ClientConfig {
  /**
   * Chain adapters to use for building transactions.
   * If not provided, uses Solana and EVM adapters by default.
   */
  adapters?: ChainAdapter[];

  /**
   * Wallets for each chain type.
   * Can also pass a single wallet for backwards compatibility.
   */
  wallets?: WalletSet;

  /**
   * Legacy: Single wallet (Solana).
   * Use `wallets` for multi-chain support.
   */
  wallet?: unknown;

  /**
   * Preferred network to use when multiple options are available.
   * CAIP-2 format (e.g., 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'eip155:8453')
   */
  preferredNetwork?: string;

  /**
   * Custom RPC URLs by network
   */
  rpcUrls?: Record<string, string>;

  /**
   * Maximum payment amount allowed (in atomic units).
   * Rejects payments exceeding this amount.
   */
  maxAmountAtomic?: string;

  /**
   * Custom fetch implementation
   */
  fetch?: typeof globalThis.fetch;

  /**
   * Enable verbose logging
   */
  verbose?: boolean;
}

/**
 * x402 Client interface
 */
export interface X402Client {
  /**
   * Fetch with automatic x402 payment handling.
   * If the server returns 402, handles payment automatically and retries.
   */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/**
 * Result of finding a payment option
 */
interface MatchedPayment {
  accept: PaymentAccept;
  adapter: ChainAdapter;
  wallet: unknown;
}

/**
 * Create an x402 v2 client
 */
export function createX402Client(config: X402ClientConfig): X402Client {
  const {
    adapters = [createSolanaAdapter({ verbose: config.verbose }), createEvmAdapter({ verbose: config.verbose })],
    wallets: walletSet,
    wallet: legacyWallet,
    preferredNetwork,
    rpcUrls = {},
    maxAmountAtomic,
    fetch: customFetch = globalThis.fetch,
    verbose = false,
  } = config;

  const log = verbose
    ? console.log.bind(console, '[x402]')
    : () => {};

  // Build wallet set from legacy format if needed
  const wallets: WalletSet = walletSet || {};
  if (legacyWallet && !wallets.solana && isSolanaWallet(legacyWallet)) {
    wallets.solana = legacyWallet;
  }
  if (legacyWallet && !wallets.evm && isEvmWallet(legacyWallet)) {
    wallets.evm = legacyWallet;
  }

  /**
   * Find a payment option we can handle
   * Prioritizes:
   * 1. Preferred network (if specified)
   * 2. Networks where we have a connected wallet
   * 3. First available option
   */
  function findPaymentOption(accepts: PaymentAccept[]): MatchedPayment | null {
    // Filter to options we can handle
    const candidates: MatchedPayment[] = [];

    for (const accept of accepts) {
      const adapter = adapters.find(a => a.canHandle(accept.network));
      if (!adapter) continue;

      // Find the right wallet for this adapter
      let wallet: unknown;
      if (adapter.name === 'Solana') {
        wallet = wallets.solana;
      } else if (adapter.name === 'EVM') {
        wallet = wallets.evm;
      }

      if (wallet && adapter.isConnected(wallet)) {
        candidates.push({ accept, adapter, wallet });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    // Prefer the specified network
    if (preferredNetwork) {
      const preferred = candidates.find(c => c.accept.network === preferredNetwork);
      if (preferred) return preferred;
    }

    // Return first available
    return candidates[0];
  }

  /**
   * Get RPC URL for a network
   */
  function getRpcUrl(network: string, adapter: ChainAdapter): string {
    return rpcUrls[network] || adapter.getDefaultRpcUrl(network);
  }

  /**
   * Main fetch function with x402 payment handling
   */
  async function x402Fetch(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    log('Making request:', input);

    // Make initial request
    const response = await customFetch(input, init);

    // If not 402, return as-is
    if (response.status !== 402) {
      return response;
    }

    log('Received 402 Payment Required');

    // Parse PAYMENT-REQUIRED header
    const paymentRequiredHeader = response.headers.get('PAYMENT-REQUIRED');
    if (!paymentRequiredHeader) {
      throw new X402Error(
        'missing_payment_required_header',
        'Server returned 402 but no PAYMENT-REQUIRED header'
      );
    }

    let requirements: PaymentRequired;
    try {
      const decoded = atob(paymentRequiredHeader);
      requirements = JSON.parse(decoded);
    } catch {
      throw new X402Error(
        'invalid_payment_required',
        'Failed to decode PAYMENT-REQUIRED header'
      );
    }

    log('Payment requirements:', requirements);

    // Find a payment option we can use
    const match = findPaymentOption(requirements.accepts);
    if (!match) {
      const availableNetworks = requirements.accepts.map(a => a.network).join(', ');
      throw new X402Error(
        'no_matching_payment_option',
        `No connected wallet for any available network: ${availableNetworks}`
      );
    }

    const { accept, adapter, wallet } = match;
    log(`Using ${adapter.name} for ${accept.network}`);

    // Validate fee payer (Solana only - EVM users pay their own gas)
    if (adapter.name === 'Solana' && !accept.extra?.feePayer) {
      throw new X402Error(
        'missing_fee_payer',
        'Solana payment option missing feePayer in extra'
      );
    }

    // Validate decimals
    if (typeof accept.extra?.decimals !== 'number') {
      throw new X402Error(
        'missing_decimals',
        'Payment option missing decimals in extra'
      );
    }

    // Check amount limit
    if (maxAmountAtomic && BigInt(accept.amount) > BigInt(maxAmountAtomic)) {
      throw new X402Error(
        'amount_exceeds_max',
        `Payment amount ${accept.amount} exceeds maximum ${maxAmountAtomic}`
      );
    }

    // Check balance before signing
    const rpcUrl = getRpcUrl(accept.network, adapter);
    log('Checking balance...');
    const balance = await adapter.getBalance(accept, wallet, rpcUrl);
    const requiredAmount = Number(accept.amount) / Math.pow(10, accept.extra.decimals);
    
    if (balance < requiredAmount) {
      const network = adapter.name === 'EVM' ? 'Base' : 'Solana';
      throw new X402Error(
        'insufficient_balance',
        `Insufficient USDC balance on ${network}. Have $${balance.toFixed(4)}, need $${requiredAmount.toFixed(4)}`
      );
    }
    log(`Balance OK: $${balance.toFixed(4)} >= $${requiredAmount.toFixed(4)}`);

    // Build and sign transaction
    log('Building transaction...');
    const signedTx = await adapter.buildTransaction(accept, wallet, rpcUrl);
    log('Transaction signed');

    // Build PAYMENT-SIGNATURE payload
    // Solana uses payload.transaction (base64 serialized tx)
    // EVM uses payload directly (authorization + signature object)
    let payload: Record<string, unknown>;
    if (adapter.name === 'EVM') {
      // EVM: payload is the authorization + signature object
      payload = JSON.parse(signedTx.serialized);
    } else {
      // Solana: payload.transaction is the base64 tx
      payload = { transaction: signedTx.serialized };
    }

    const paymentSignature = {
      x402Version: 2,
      resource: requirements.resource,
      accepted: accept,
      payload,
    };

    const paymentSignatureHeader = btoa(JSON.stringify(paymentSignature));

    // Retry request with payment
    log('Retrying request with payment...');
    const retryResponse = await customFetch(input, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        'PAYMENT-SIGNATURE': paymentSignatureHeader,
      },
    });

    log('Retry response status:', retryResponse.status);

    if (retryResponse.status === 402) {
      // Try to get rejection reason from body
      let reason = 'unknown';
      try {
        const body = (await retryResponse.clone().json()) as Record<string, unknown>;
        reason = String(body.error || body.message || JSON.stringify(body));
        log('Rejection reason:', reason);
      } catch {
        // Ignore
      }
      throw new X402Error(
        'payment_rejected',
        `Payment was rejected by the server: ${reason}`
      );
    }

    return retryResponse;
  }

  return {
    fetch: x402Fetch,
  };
}

// Re-export types for convenience
export type { ChainAdapter, WalletSet } from '../adapters/types';
export { X402Error } from '../types';
