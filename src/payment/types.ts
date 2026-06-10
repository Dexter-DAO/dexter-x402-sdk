// src/payment/types.ts
/**
 * Shared contract for the x402 version seam. Both the v1 and v2 strategy
 * modules implement PaymentStrategy. Callers depend ONLY on this file —
 * never on a specific version module.
 */

import type { WalletSet } from '../adapters/types';
import type { Tab } from '../tab/types';

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

/**
 * Result of a paid fetch. Never throws for an expected failure.
 *
 * The `ok: true` branch is further discriminated by `paid`:
 *   - `paid: true`  — the endpoint demanded payment and we paid; `amountPaid`
 *                     and `network` are present, `txSignature` optional.
 *                     `response` is usually the merchant's response, but is
 *                     `undefined` when the payment settled and the merchant
 *                     never delivered a response before the deadline (a
 *                     confirmed-but-unanswered payment — see `payment_unconfirmed`
 *                     below for the unconfirmed counterpart).
 *   - `paid: false` — the endpoint returned a non-402 directly; no payment
 *                     was attempted. Only `response` is present, because no
 *                     payment-related fields are meaningful in that case.
 *
 * Callers should narrow on `paid` before reading payment fields. Previously
 * (3.8.x and earlier) the dispatcher returned a phantom `network` placeholder
 * on the unpaid branch; the discriminator forces a correct read.
 */
export type PayResult =
  | {
      ok: true;
      paid: true;
      /**
       * The merchant's response. `undefined` when the payment was confirmed
       * settled but the merchant did not respond before the deadline — you
       * paid, the merchant never answered. Always check before use.
       */
      response: Response | undefined;
      /** Atomic amount actually paid. */
      amountPaid: string;
      network: NetworkRef;
      txSignature?: string;
    }
  | {
      ok: true;
      paid: false;
      response: Response;
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
        /** No payment was sent before the deadline — the unpaid probe (or
         *  build/sign) ran past the pre-payment timeout. No money moved;
         *  safe to retry. */
        | 'timeout'
        /** The payment authorization WAS sent to the merchant, the merchant
         *  did not respond before the deadline, and settlement could not be
         *  confirmed. The payment MAY have settled on-chain. DO NOT
         *  blind-retry — a retry signs a fresh authorization and can pay
         *  again. `detail` explains the state. */
        | 'payment_unconfirmed'
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
  /**
   * Pre-payment timeout in ms — the deadline for the unpaid probe and the
   * build/sign step, i.e. everything BEFORE the payment authorization is
   * sent. Exceeding it yields `reason: 'timeout'` (no money moved, safe to
   * retry). Default 15000.
   *
   * This does NOT bound the wait for the merchant's response once payment
   * has been dispatched — see `responseTimeoutMs`. The two phases have
   * separate deadlines on purpose: once the payment is out the door,
   * aborting the wait does not un-spend the money.
   */
  timeoutMs?: number;
  /**
   * Post-payment timeout in ms — the deadline for the merchant's response
   * AFTER the payment authorization has been sent. Exceeding it does not
   * yield `'timeout'`; it yields `'payment_unconfirmed'` (or, once on-chain
   * confirmation lands, a confirmed `paid: true`). Default 120000.
   *
   * Generous by design: research / scout / agent endpoints routinely take
   * tens of seconds, and the money is already committed once this phase
   * begins — there is no benefit to a tight deadline here.
   */
  responseTimeoutMs?: number;
  /**
   * Solana RPC endpoint for v1 SVM payment signing. v1 Solana `exact`
   * signing builds a real transaction and needs RPC access (mint lookup,
   * recent blockhash). Ignored for EVM-only flows. Defaults to the public
   * Solana RPC when omitted — callers should pass their own for
   * reliability.
   */
  solanaRpcUrl?: string;
  /**
   * An open spend-tab to pay `tab`-scheme accepts entries with. Used only
   * when the 402 offers scheme "tab" AND the option's payTo matches the
   * counterparty this tab was opened against — otherwise ignored and the
   * normal exact/batch path runs.
   */
  tab?: Tab;
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
