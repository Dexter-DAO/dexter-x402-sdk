/**
 * x402 Client — Core Implementation
 *
 * TODO: Implement the full client that:
 * - Wraps fetch with 402 auto-handling
 * - Reads PAYMENT-REQUIRED header
 * - Builds and signs TransferChecked tx
 * - Retries with PAYMENT-SIGNATURE header
 */

import type { PaymentRequired, PaymentAccept } from '../types';
import { X402Error, SOLANA_MAINNET_NETWORK } from '../types';

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
 */
export function createX402Client(config: X402ClientConfig): X402Client {
  const {
    wallet,
    network = SOLANA_MAINNET_NETWORK,
    rpcUrl: _rpcUrl,
    maxAmountAtomic,
    fetch: customFetch = globalThis.fetch,
    verbose = false,
  } = config;

  // TODO: Use rpcUrl for building transactions
  void _rpcUrl;

  const log = verbose ? console.log.bind(console, '[x402]') : () => {};

  async function x402Fetch(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    log('Making request:', input);

    // Initial request
    const response = await customFetch(input, init);

    // If not 402, return as-is
    if (response.status !== 402) {
      return response;
    }

    log('Received 402, reading PAYMENT-REQUIRED header');

    // Read payment requirements from header
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

    log('Payment requirements:', requirements);

    // Find a Solana payment option
    const accept = requirements.accepts.find(
      (a): a is PaymentAccept =>
        a.scheme === 'exact' && a.network === network
    );

    if (!accept) {
      throw new X402Error(
        'no_solana_accept',
        `No payment option for network ${network}`
      );
    }

    // Validate required fields
    if (!accept.extra?.feePayer) {
      throw new X402Error('missing_fee_payer', 'Payment option missing feePayer');
    }
    if (typeof accept.extra?.decimals !== 'number') {
      throw new X402Error('missing_decimals', 'Payment option missing decimals');
    }

    // Check max amount
    if (maxAmountAtomic && BigInt(accept.amount) > BigInt(maxAmountAtomic)) {
      throw new X402Error(
        'amount_exceeds_max',
        `Amount ${accept.amount} exceeds max ${maxAmountAtomic}`
      );
    }

    // Check wallet
    if (!wallet.publicKey) {
      throw new X402Error(
        'wallet_missing_sign_transaction',
        'Wallet not connected'
      );
    }

    // TODO: Build and sign the transaction
    // This is where we'd:
    // 1. Create ComputeBudget instructions
    // 2. Create TransferChecked instruction
    // 3. Build and sign the transaction
    // 4. Encode to base64

    throw new X402Error(
      'transaction_build_failed',
      'Transaction building not yet implemented'
    );

    // TODO: Retry with PAYMENT-SIGNATURE header
    // const paymentSignature: PaymentSignature = { ... };
    // const retryResponse = await customFetch(input, {
    //   ...init,
    //   headers: {
    //     ...init?.headers,
    //     'PAYMENT-SIGNATURE': btoa(JSON.stringify(paymentSignature)),
    //   },
    // });
    // return retryResponse;
  }

  return {
    fetch: x402Fetch,
  };
}

