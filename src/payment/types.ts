// src/payment/types.ts
/**
 * Shared contract for the x402 version seam. Both the v1 and v2 strategy
 * modules implement PaymentStrategy. Callers depend ONLY on this file —
 * never on a specific version module.
 */

import type { WalletSet } from '../adapters/types';

/** A network reference, kept in BOTH forms so neither version loses info. */
export interface NetworkRef {
  /** CAIP-2 form, e.g. "eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp". */
  caip2: string;
  /** Bare form, e.g. "base", "solana". */
  bare: string;
  /** "evm" | "svm" — which signer family. */
  family: 'evm' | 'svm';
}

/** One payment option parsed from a 402 challenge, version-normalised. */
export interface ChallengeOption {
  scheme: string;
  network: NetworkRef;
  /** Atomic amount as a string (e.g. "2000"). */
  amount: string;
  asset: string;
  payTo: string;
  /** Optional — v1 challenges may omit it; a strategy supplies a default when absent. */
  maxTimeoutSeconds?: number;
  /** Scheme-specific extras, passed through verbatim from the merchant. */
  extra?: Record<string, unknown>;
}

/** A 402 challenge, normalised across v1 and v2. */
export interface PaymentChallenge {
  x402Version: 1 | 2;
  options: ChallengeOption[];
  resourceUrl?: string;
}

/** Result of a paid fetch. Never throws for an expected failure. */
export type PayResult =
  | {
      ok: true;
      response: Response;
      /** Atomic amount actually paid. */
      amountPaid: string;
      network: NetworkRef;
      txSignature?: string;
    }
  | {
      ok: false;
      reason:
        | 'unsupported_network'
        | 'insufficient_funds'
        /** The merchant rejected the payment itself — bad/declined payload,
         *  failed verification. Our side: check the payment. */
        | 'merchant_rejected'
        /** The merchant ACCEPTED the payment shape but their own settlement
         *  failed (their facilitator errored). Not our payload — a
         *  merchant-side defect. `detail` carries their verbatim error. */
        | 'settlement_failed'
        | 'no_payment_options'
        | 'timeout'
        | 'budget_exceeded'
        | 'error';
      detail?: string;
    };

/** A funded wallet set (re-uses the SDK's existing WalletSet shape). */
export type { WalletSet } from '../adapters/types';

/** Options for a paid fetch. */
export interface PayAndFetchOptions {
  /** Max total atomic spend for this call. */
  maxAmountAtomic?: string;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /**
   * Solana RPC endpoint for v1 SVM payment signing. v1 Solana `exact`
   * signing builds a real transaction and needs RPC access (mint lookup,
   * recent blockhash). Ignored for EVM-only flows. Defaults to the public
   * Solana RPC when omitted — callers should pass their own for
   * reliability.
   */
  solanaRpcUrl?: string;
}

/**
 * The contract each version module implements.
 *
 * parseChallenge: given a raw 402 Response, extract the challenge — or
 *   null if this strategy does not recognise it as its version.
 * pay: given a parsed challenge, sign + send the paid request, return
 *   the merchant's response.
 */
export interface PaymentStrategy {
  readonly version: 1 | 2;
  parseChallenge(res: Response): Promise<PaymentChallenge | null>;
  pay(
    url: string,
    requestInit: RequestInit,
    challenge: PaymentChallenge,
    wallets: WalletSet,
    opts: PayAndFetchOptions,
  ): Promise<PayResult>;
}
