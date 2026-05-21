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
import { buildV1PaymentHeader } from './v1-header';
import { errorDetail, classifyPaidFailure } from './errors';

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
    url: string,
    requestInit: RequestInit,
    challenge: PaymentChallenge,
    wallets: WalletSet,
    opts: PayAndFetchOptions,
  ): Promise<PayResult> {
    // pay() MUST never throw — every path returns a typed PayResult.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 1-5. Build the signed v1 X-PAYMENT header value.
      const headerResult = await buildV1PaymentHeader(challenge, wallets, opts);
      if (!headerResult.ok) {
        return { ok: false, reason: headerResult.reason, detail: headerResult.detail };
      }
      const paymentHeader = headerResult.headerValue;
      const chosen = headerResult.option;

      // 6. Build a FRESH RequestInit — never reuse a consumed body.
      const headers = new Headers(requestInit.headers ?? undefined);
      headers.set('X-PAYMENT', paymentHeader);

      const controller = new AbortController();
      const timeoutMs = opts.timeoutMs ?? 15000;
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const signal =
        requestInit.signal != null
          ? AbortSignal.any([requestInit.signal, controller.signal])
          : controller.signal;

      const freshInit: RequestInit = {
        method: requestInit.method,
        headers,
        signal,
      };
      if (typeof requestInit.body === 'string') {
        freshInit.body = requestInit.body;
      }

      // 7. Send and map the outcome.
      const response = await fetch(url, freshInit);
      if (response.ok) {
        return {
          ok: true,
          paid: true,
          response,
          amountPaid: chosen.amount,
          network: chosen.network,
          txSignature: decodeTxSignature(response),
        };
      }
      // Paid retry still failed — distinguish "merchant rejected our
      // payment" from "merchant accepted it, their settlement failed", and
      // carry their verbatim error so the caller sees whose fault it is.
      return { ok: false, ...(await classifyPaidFailure(response)) };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { ok: false, reason: 'timeout' };
      }
      return {
        ok: false,
        reason: 'error',
        detail: errorDetail(err),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  },
};

/**
 * Extract the settled transaction hash from an X-PAYMENT-RESPONSE header,
 * if present. The header is a base64-encoded JSON settlement receipt.
 * Returns undefined when absent or unparseable — never throws.
 */
function decodeTxSignature(response: Response): string | undefined {
  const raw =
    response.headers.get('x-payment-response') ??
    response.headers.get('X-PAYMENT-RESPONSE');
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    const tx =
      decoded.transaction ?? decoded.txHash ?? decoded.transactionHash;
    return typeof tx === 'string' ? tx : undefined;
  } catch {
    return undefined;
  }
}
