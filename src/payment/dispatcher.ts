/**
 * The x402 version dispatcher — the ONLY code in the stack that decides
 * v1 vs v2. It probes the endpoint once; if the response is a 402, it
 * asks each strategy to parse it (v2 first, since v2 is current) and
 * routes to whichever recognises it. Callers use payAndFetch and never
 * branch on protocol version themselves.
 */
import type { PaymentStrategy, PayResult, PayAndFetchOptions } from './types';
import type { WalletSet } from '../adapters/types';
import { v2Strategy } from './v2-strategy';
import { v1Strategy } from './v1-strategy';

// v2 first: it is the current protocol version. v1 is the fallback.
const STRATEGIES: PaymentStrategy[] = [v2Strategy, v1Strategy];

/**
 * Given a 402 Response, return the strategy that recognises it, or null.
 * Exported for testing; payAndFetch is the normal entrypoint.
 */
export async function detectStrategy(
  res: Response,
): Promise<PaymentStrategy | null> {
  for (const strategy of STRATEGIES) {
    const challenge = await strategy.parseChallenge(res.clone());
    if (challenge) return strategy;
  }
  return null;
}

/**
 * Pay for and fetch a resource. Probes once; if the endpoint demands
 * payment, detects the protocol version, and pays via the matching
 * strategy. Returns a typed PayResult — never throws for an expected
 * failure.
 */
export async function payAndFetch(
  url: string,
  requestInit: RequestInit,
  wallets: WalletSet,
  opts: PayAndFetchOptions,
): Promise<PayResult> {
  // Non-string bodies (Buffer, FormData, URLSearchParams, ReadableStream)
  // cannot be safely re-sent on the paid retry — fail loudly rather than
  // silently drop the body and probe without it.
  if (
    requestInit.body !== undefined &&
    requestInit.body !== null &&
    typeof requestInit.body !== 'string'
  ) {
    return {
      ok: false,
      reason: 'error',
      detail:
        'payAndFetch requires a string body; non-string bodies (Buffer, FormData, URLSearchParams, ReadableStream) cannot be safely re-sent on the paid retry',
    };
  }

  let probe: Response;
  try {
    // Probe with the original requestInit — body is guaranteed to be a
    // string-or-nullish by the guard above, so it is safe to re-send.
    probe = await fetch(url, { ...requestInit });
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (probe.status !== 402) {
    // not-applicable placeholder — a proper fix needs a types.ts change,
    // out of Task 8 scope
    return {
      ok: true,
      response: probe,
      amountPaid: '0',
      network: { caip2: '', bare: '', family: 'evm' },
    };
  }

  for (const strategy of STRATEGIES) {
    const challenge = await strategy.parseChallenge(probe.clone());
    if (challenge) {
      return strategy.pay(url, requestInit, challenge, wallets, opts);
    }
  }
  return { ok: false, reason: 'no_payment_options' };
}
