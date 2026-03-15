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
  /** Amount paid in USD */
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
  /** Payment-aware fetch with budget enforcement */
  fetch: typeof globalThis.fetch;
  /** Total amount spent (formatted, e.g., '$12.34') */
  readonly spent: string;
  /** Remaining budget (formatted, e.g., '$37.66') */
  readonly remaining: string;
  /** Number of payments made */
  readonly payments: number;
  /** Total spent as a raw number */
  readonly spentAmount: number;
  /** Remaining budget as a raw number */
  readonly remainingAmount: number;
  /** Full payment history */
  readonly ledger: readonly PaymentRecord[];
  /** Spend in the last hour */
  readonly hourlySpend: number;
  /** Reset the budget (clears all spend history) */
  reset: () => void;
}

/**
 * Create a budget-controlled fetch wrapper for autonomous agents.
 *
 * Enforces total spend limit, per-request cap, hourly rate limit,
 * and domain allowlist. Every payment is tracked in an in-memory ledger.
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
  // Tracks the amount from the most recent onPaymentRequired call so the
  // post-fetch handler can record it in the ledger
  let pendingAmount = 0;

  function getSpent(): number {
    return ledger.reduce((sum, r) => sum + r.amount, 0);
  }

  function getHourlySpend(): number {
    const cutoff = Date.now() - 3600_000;
    return ledger.filter(r => r.timestamp >= cutoff).reduce((sum, r) => sum + r.amount, 0);
  }

  // Inner fetch — wrapFetch with budget-enforcing onPaymentRequired
  const innerFetch = wrapFetch(fetch, {
    ...fetchOptions,
    onPaymentRequired: async (accept: PaymentAccept) => {
      const decimals = accept.extra?.decimals ?? 6;
      const amountUsd = Number(accept.amount) / Math.pow(10, decimals);

      // Per-request cap
      if (amountUsd > perRequestMax) {
        throw new X402Error(
          'amount_exceeds_max',
          `$${amountUsd.toFixed(4)} exceeds per-request limit of $${perRequestMax.toFixed(2)}`
        );
      }

      // Total budget
      const spent = getSpent();
      if (spent + amountUsd > totalBudget) {
        throw new X402Error(
          'amount_exceeds_max',
          `Budget exceeded. Spent $${spent.toFixed(2)} of $${totalBudget.toFixed(2)}, payment: $${amountUsd.toFixed(4)}`
        );
      }

      // Hourly limit
      const hourly = getHourlySpend();
      if (hourly + amountUsd > perHourMax) {
        throw new X402Error(
          'amount_exceeds_max',
          `Hourly limit ($${perHourMax.toFixed(2)}) exceeded. Spent $${hourly.toFixed(2)} this hour`
        );
      }

      pendingAmount = amountUsd;

      // Chain user's onPaymentRequired if provided
      if (userOnPayment) return userOnPayment(accept);
      return true;
    },
  });

  // Outer fetch — domain check + ledger tracking
  const budgetFetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let domain = 'unknown';
    try { domain = new URL(url).hostname; } catch {}

    // Domain allowlist
    if (allowedDomains) {
      if (!allowedDomains.some(d => domain === d || domain.endsWith(`.${d}`))) {
        throw new X402Error('payment_rejected', `Domain "${domain}" not in allowed domains`);
      }
    }

    pendingAmount = 0;
    const response = await innerFetch(input, init);

    // If onPaymentRequired fired, a payment was made — record it
    if (pendingAmount > 0) {
      let network = 'unknown';
      const paymentHeader = response.headers.get('PAYMENT-RESPONSE');
      if (paymentHeader) {
        try {
          const decoded = JSON.parse(atob(paymentHeader));
          network = decoded.network || network;
        } catch {}
      }
      ledger.push({ amount: pendingAmount, domain, network, timestamp: Date.now() });
      pendingAmount = 0;
    }

    return response;
  }) as typeof globalThis.fetch;

  return {
    fetch: budgetFetch,
    get spent() { return `$${getSpent().toFixed(2)}`; },
    get remaining() { return `$${(totalBudget - getSpent()).toFixed(2)}`; },
    get payments() { return ledger.length; },
    get spentAmount() { return getSpent(); },
    get remainingAmount() { return totalBudget - getSpent(); },
    get ledger() { return ledger as readonly PaymentRecord[]; },
    get hourlySpend() { return getHourlySpend(); },
    reset() { ledger = []; },
  };
}
