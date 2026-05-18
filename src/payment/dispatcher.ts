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
  let probe: Response;
  try {
    // Probe with a fresh request — body, if any, must be a string so it
    // can be re-sent on the paid retry.
    probe = await fetch(url, {
      ...requestInit,
      body:
        typeof requestInit.body === 'string' ? requestInit.body : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      detail: (err as Error).message,
    };
  }

  if (probe.status !== 402) {
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
