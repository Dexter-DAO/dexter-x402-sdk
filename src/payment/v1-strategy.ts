// src/payment/v1-strategy.ts
/**
 * x402 v1 strategy. v1 carries the challenge in the JSON body of the
 * 402 (an `accepts` array) with bare network names. parseChallenge
 * declines (returns null) when a PAYMENT-REQUIRED header is present —
 * that is a v2 response and the dispatcher will route it to v2Strategy.
 *
 * MUST NOT import v2-strategy.
 */
import type {
  PaymentStrategy,
  PaymentChallenge,
  ChallengeOption,
  PayResult,
  PayAndFetchOptions,
} from './types';
import type { WalletSet } from '../adapters/types';
import { toNetworkRef } from './network-map';

function toOptions(accepts: unknown[]): ChallengeOption[] {
  const out: ChallengeOption[] = [];
  for (const a of accepts) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const net = toNetworkRef(String(o.network ?? ''));
    if (!net) continue;
    out.push({
      scheme: String(o.scheme ?? 'exact'),
      network: net,
      // v1 names the amount field `maxAmountRequired`.
      amount: String(o.maxAmountRequired ?? o.amount ?? '0'),
      asset: String(o.asset ?? ''),
      payTo: String(o.payTo ?? ''),
      maxTimeoutSeconds:
        typeof o.maxTimeoutSeconds === 'number' ? o.maxTimeoutSeconds : undefined,
      extra:
        o.extra && typeof o.extra === 'object'
          ? (o.extra as Record<string, unknown>)
          : undefined,
    });
  }
  return out;
}

export const v1Strategy: PaymentStrategy = {
  version: 1,

  async parseChallenge(res: Response): Promise<PaymentChallenge | null> {
    // A PAYMENT-REQUIRED header means v2 — decline.
    if (res.headers.get('payment-required')) return null;
    let body: Record<string, unknown>;
    try {
      body = (await res.clone().json()) as Record<string, unknown>;
    } catch {
      return null;
    }
    const accepts = Array.isArray(body.accepts) ? body.accepts : [];
    if (accepts.length === 0) return null;
    const options = toOptions(accepts);
    if (options.length === 0) return null;
    return { x402Version: 1, options };
  },

  async pay(
    _url: string,
    _requestInit: RequestInit,
    _challenge: PaymentChallenge,
    _wallets: WalletSet,
    _opts: PayAndFetchOptions,
  ): Promise<PayResult> {
    // Implemented in Task 7.
    return { ok: false, reason: 'error', detail: 'pay not yet implemented' };
  },
};
