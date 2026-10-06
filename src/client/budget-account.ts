/**
 * Budget Account — Autonomous Agent Spending Controls
 *
 * Wraps the x402 client with a spending limit, per-request cap,
 * per-hour rate limit, and optional domain allowlist. Tracks cumulative
 * spend and exposes remaining budget. When the budget is exhausted,
 * requests throw instead of paying.
 *
 * @example
 * ```typescript
 * import { createBudgetAccount } from '@dexterai/x402/client';
 *
 * const agent = createBudgetAccount({
 *   walletPrivateKey: process.env.SOLANA_PRIVATE_KEY,
 *   budget: {
 *     total: '50.00',       // $50 total budget
 *     perRequest: '1.00',   // max $1 per request
 *     perHour: '10.00',     // max $10/hour
 *   },
 *   allowedDomains: ['api.example.com', 'data.example.com'],
 * });
 *
 * const response = await agent.fetch('https://api.example.com/data');
 * console.log(agent.spent);       // '$0.05'
 * console.log(agent.remaining);   // '$49.95'
 * console.log(agent.payments);    // 1
 * ```
 */

import { wrapFetch, type WrapFetchOptions } from './wrap-fetch';
import { X402Error } from '../types';
import type { PaymentAccept } from '../types';

/** Budget configuration */
export interface BudgetConfig {
  /** Total spending limit in USD (e.g., '50.00') */
  total: string;
  /** Maximum amount per single request in USD (e.g., '1.00'). Optional. */
  perRequest?: string;
  /** Maximum spend per hour in USD (e.g., '10.00'). Optional. */
  perHour?: string;
}

/** Budget Account configuration — extends WrapFetchOptions with spending controls */
export interface BudgetAccountConfig extends WrapFetchOptions {
  /** Spending limits */
  budget: BudgetConfig;
  /** Restrict payments to these domains only. If omitted, all domains allowed. */
  allowedDomains?: string[];
}

/** A payment record in the spend ledger */
export interface PaymentRecord {
  /** Amount authorized in USD; a lost paid response still counts against the budget. */
  amount: number;
  /** Domain that was paid */
  domain: string;
  /** CAIP-2 network used */
  network: string;
  /** Timestamp (ms) */
  timestamp: number;
}

/** Budget Account — fetch with spending controls */
export interface BudgetAccount {
  /** Payment-aware fetch. Rejects if recorded authorizations plus in-flight reservations exceed a limit. */
  fetch: typeof globalThis.fetch;
  /** Authorizations handed to the transport (formatted, e.g., '$12.34'); not confirmed settlement. */
  readonly spent: string;
  /** Unspent budget (formatted, e.g., '$37.66'); includes in-flight reservations. */
  readonly remaining: string;
  /** Number of payment authorizations handed to the transport */
  readonly payments: number;
  /** Authorizations handed to the transport as a raw number; not confirmed settlement. */
  readonly spentAmount: number;
  /** Unspent budget as a raw number; includes in-flight reservations. */
  readonly remainingAmount: number;
  /** Budget held for approvals/signatures that have not reached the transport. */
  readonly reservedAmount: number;
  /** Full payment history */
  readonly ledger: readonly PaymentRecord[];
  /** Authorizations handed to the transport in the last hour */
  readonly hourlySpend: number;
  /** Reset spend history. In-flight reservations remain until dispatched or released. */
  reset: () => void;
}

/**
 * Create a budget-controlled fetch wrapper for autonomous agents.
 *
 * Enforces total spend limit, per-request cap, hourly rate limit,
 * and domain allowlist. Every payment is tracked in an in-memory ledger.
 * In-flight approvals reserve budget. Authorizations handed to the transport
 * count even if it rejects before sending, since an opaque transport may have
 * already delivered the request or retried it internally.
 */
export function createBudgetAccount(config: BudgetAccountConfig): BudgetAccount {
  const { budget, allowedDomains, onPaymentRequired: userOnPayment, ...fetchOptions } = config;

  const totalBudget = parseFloat(budget.total);
  const perRequestMax = budget.perRequest ? parseFloat(budget.perRequest) : Infinity;
  const perHourMax = budget.perHour ? parseFloat(budget.perHour) : Infinity;

  if (isNaN(totalBudget) || totalBudget <= 0) {
    throw new Error('budget.total must be a positive number');
  }

  let ledger: PaymentRecord[] = [];
  // Reserve before awaiting approval/signing so concurrent requests cannot
  // each spend the same remaining budget.
  const reservations = new Set<PaymentRecord>();

  function getSpent(): number {
    return ledger.reduce((sum, r) => sum + r.amount, 0);
  }

  function getHourlySpend(): number {
    const cutoff = Date.now() - 3600_000;
    return ledger.filter(r => r.timestamp >= cutoff).reduce((sum, r) => sum + r.amount, 0);
  }

  function getReserved(): number {
    let amount = 0;
    for (const reservation of reservations) amount += reservation.amount;
    return amount;
  }

  const innerFetch = wrapFetch(fetch, fetchOptions);

  const budgetFetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let domain = 'unknown';
    try { domain = new URL(url).hostname; } catch {}

    if (allowedDomains) {
      if (!allowedDomains.some(d => domain === d || domain.endsWith(`.${d}`))) {
        throw new X402Error('payment_rejected', `Domain "${domain}" not in allowed domains`);
      }
    }

    let reservation: PaymentRecord | undefined;
    function releaseReservation() {
      if (reservation) reservations.delete(reservation);
      reservation = undefined;
    }

    const onPaymentRequired = async (accept: PaymentAccept) => {
      // A failed access-pass purchase can fall back to another payment.
      // Release its unsigned reservation before inspecting the new attempt.
      releaseReservation();
      const decimals = accept.extra?.decimals ?? 6;
      const scale = Math.pow(10, decimals);
      const amountUsd = Number(accept.amount ?? accept.maxAmountRequired) / scale;
      if (!Number.isInteger(decimals) || decimals < 0 || !Number.isFinite(scale)
        || !Number.isFinite(amountUsd) || amountUsd < 0) {
        throw new X402Error('invalid_payment_required', 'Payment amount must be finite and non-negative with valid decimals');
      }

      // Per-request cap
      if (amountUsd > perRequestMax) {
        throw new X402Error(
          'amount_exceeds_max',
          `$${amountUsd.toFixed(4)} exceeds per-request limit of $${perRequestMax.toFixed(2)}`
        );
      }

      // Total budget
      const spent = getSpent();
      const pending = getReserved();
      if (spent + pending + amountUsd > totalBudget) {
        throw new X402Error(
          'amount_exceeds_max',
          `Budget exceeded. Spent $${spent.toFixed(2)} (+$${pending.toFixed(2)} pending) of $${totalBudget.toFixed(2)}, payment: $${amountUsd.toFixed(4)}`
        );
      }

      // Hourly limit
      const hourly = getHourlySpend();
      if (hourly + pending + amountUsd > perHourMax) {
        throw new X402Error(
          'amount_exceeds_max',
          `Hourly limit ($${perHourMax.toFixed(2)}) exceeded. Spent $${hourly.toFixed(2)} (+$${pending.toFixed(2)} pending) this hour`
        );
      }

      reservation = { amount: amountUsd, domain, network: accept.network, timestamp: Date.now() };
      reservations.add(reservation);

      try {
        const approved = userOnPayment ? await userOnPayment(accept) : true;
        if (!approved) releaseReservation();
        return approved;
      } catch (error) {
        releaseReservation();
        throw error;
      }
    };

    try {
      return await innerFetch(input, init, {
        onPaymentRequired,
        onPaymentDispatched: () => {
          if (!reservation) return;
          // Once handed to the transport, an authorization may settle even
          // if fetch rejects. Keep it counted; custom transports can retry or
          // process a response internally before throwing.
          ledger.push({ ...reservation, timestamp: Date.now() });
          releaseReservation();
        },
      });
    } finally {
      // Approval rejection and signing failures have not dispatched payment.
      releaseReservation();
    }
  }) as typeof globalThis.fetch;

  return {
    fetch: budgetFetch,
    get spent() { return `$${getSpent().toFixed(2)}`; },
    get remaining() { return `$${(totalBudget - getSpent()).toFixed(2)}`; },
    get payments() { return ledger.length; },
    get spentAmount() { return getSpent(); },
    get remainingAmount() { return totalBudget - getSpent(); },
    get reservedAmount() { return getReserved(); },
    get ledger() { return ledger as readonly PaymentRecord[]; },
    get hourlySpend() { return getHourlySpend(); },
    reset() { ledger = []; },
  };
}
