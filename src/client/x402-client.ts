/**
 * Dexter x402 v2 Client
 *
 * A fetch wrapper that automatically handles x402 payments:
 * 1. Makes initial request
 * 2. On 402, reads PAYMENT-REQUIRED header
 * 3. Builds and signs Solana transaction
 * 4. Retries with PAYMENT-SIGNATURE header
 */

import type { PaymentRequired, PaymentAccept, PaymentSignature } from '../types';
import { X402Error, SOLANA_MAINNET_NETWORK } from '../types';
import { buildPaymentTransaction, serializeTransaction } from './transaction-builder';
import { getDefaultRpcUrl, isSolanaNetwork } from '../utils';

/**
 * Wallet interface compatible with @solana/wallet-adapter
 */
export interface X402Wallet {
  publicKey: { toBase58(): string } | null;
  signTransaction<T>(tx: T): Promise<T>;
}

/**
 * Configuration for the x402 client
 */
export interface X402ClientConfig {
  /** Wallet with signTransaction capability */
  wallet: X402Wallet;
  /** CAIP-2 network identifier (defaults to Solana mainnet) */
  network?: string;
  /** Solana RPC URL (optional, uses public RPC if not provided) */
  rpcUrl?: string;
  /** Maximum payment amount in atomic units (optional cap) */
  maxAmountAtomic?: string;
  /** Custom fetch implementation (for proxies/CORS) */
  fetch?: typeof fetch;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * x402 Client instance
 */
export interface X402Client {
  /** Make a fetch request with automatic 402 handling */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/**
 * Create an x402 client for making paid API requests
 *
 * @example
 * ```ts
 * const client = createX402Client({
 *   wallet,
 *   network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
 * });
 *
 * const response = await client.fetch('https://api.example.com/paid-endpoint', {
 *   method: 'POST',
 *   body: JSON.stringify({ query: 'example' }),
 * });
 * ```
 */
export function createX402Client(config: X402ClientConfig): X402Client {
  const {
    wallet,
    network = SOLANA_MAINNET_NETWORK,
    rpcUrl,
    maxAmountAtomic,
    fetch: customFetch = globalThis.fetch,
    verbose = false,
  } = config;

  const resolvedRpcUrl = rpcUrl || getDefaultRpcUrl(network);
  const log = verbose ? console.log.bind(console, '[x402]') : () => {};

  async function x402Fetch(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    log('Making request:', url);

    // Initial request
    const response = await customFetch(input, init);

    // If not 402, return as-is
    if (response.status !== 402) {
      return response;
    }

    log('Received 402, reading payment requirements...');

    // Read payment requirements from PAYMENT-REQUIRED header
    const paymentRequiredHeader = response.headers.get('PAYMENT-REQUIRED');
    if (!paymentRequiredHeader) {
      throw new X402Error(
        'missing_payment_required_header',
        'Server returned 402 but no PAYMENT-REQUIRED header'
      );
    }

    // Parse requirements
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

    log('Payment requirements:', JSON.stringify(requirements, null, 2));

    // Find a Solana payment option that matches our network
    const accept = requirements.accepts.find(
      (a): a is PaymentAccept =>
        a.scheme === 'exact' && isSolanaNetwork(a.network) && a.network === network
    );

    if (!accept) {
      // Try to find any Solana option
      const anySolana = requirements.accepts.find(
        (a): a is PaymentAccept => a.scheme === 'exact' && isSolanaNetwork(a.network)
      );
      
      if (anySolana) {
        throw new X402Error(
          'unsupported_network',
          `Server requires ${anySolana.network} but client configured for ${network}`,
          { serverNetwork: anySolana.network, clientNetwork: network }
        );
      }

      throw new X402Error(
        'no_solana_accept',
        `No Solana payment option found. Available networks: ${requirements.accepts.map(a => a.network).join(', ')}`
      );
    }

    // Validate required fields
    if (!accept.extra?.feePayer) {
      throw new X402Error('missing_fee_payer', 'Payment option missing feePayer in extra');
    }
    if (typeof accept.extra?.decimals !== 'number') {
      throw new X402Error('missing_decimals', 'Payment option missing decimals in extra');
    }

    // Check max amount
    if (maxAmountAtomic && BigInt(accept.amount) > BigInt(maxAmountAtomic)) {
      throw new X402Error(
        'amount_exceeds_max',
        `Payment amount ${accept.amount} exceeds maximum ${maxAmountAtomic}`,
        { amount: accept.amount, max: maxAmountAtomic }
      );
    }

    // Check wallet
    if (!wallet.publicKey) {
      throw new X402Error(
        'wallet_missing_sign_transaction',
        'Wallet not connected'
      );
    }

    log('Building payment transaction...');

    // Build and sign the transaction
    let signedTx;
    try {
      signedTx = await buildPaymentTransaction(wallet, accept, resolvedRpcUrl);
    } catch (err) {
      throw new X402Error(
        'transaction_build_failed',
        `Failed to build payment transaction: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    log('Transaction signed successfully');

    // Serialize transaction to base64
    const transactionBase64 = serializeTransaction(signedTx);

    // Build PaymentSignature payload
    const paymentSignature: PaymentSignature = {
      x402Version: 2,
      resource: requirements.resource,
      accepted: accept,
      payload: {
        transaction: transactionBase64,
      },
    };

    // Encode for header
    const paymentSignatureHeader = btoa(JSON.stringify(paymentSignature));

    log('Retrying with PAYMENT-SIGNATURE header...');

    // Retry with PAYMENT-SIGNATURE header
    const retryInit: RequestInit = {
      ...init,
      headers: {
        ...(init?.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : init?.headers || {}),
        'PAYMENT-SIGNATURE': paymentSignatureHeader,
      },
    };

    const retryResponse = await customFetch(input, retryInit);

    log('Retry response status:', retryResponse.status);

    // Check if payment was rejected
    if (retryResponse.status === 402) {
      throw new X402Error(
        'payment_rejected',
        'Payment was rejected by the server',
        { status: retryResponse.status }
      );
    }

    return retryResponse;
  }

  return {
    fetch: x402Fetch,
  };
}
