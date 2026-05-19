/**
 * x402 v2 strategy. v2 carries the challenge in a base64-encoded
 * PAYMENT-REQUIRED header. parseChallenge returns null when the
 * response has no such header (i.e. it is a v1 response) so the
 * dispatcher can fall through to the v1 strategy.
 *
 * MUST NOT import v1-strategy.
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
import { createX402Client } from '../client/x402-client';
import { classifyPaidFailure } from './errors';

function decodeHeader(raw: string): unknown {
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
  const normalized = padded + '='.repeat((4 - (padded.length % 4 || 4)) % 4);
  return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
}

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
      amount: String(o.amount ?? o.maxAmountRequired ?? '0'),
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

export const v2Strategy: PaymentStrategy = {
  version: 2,

  async parseChallenge(res: Response): Promise<PaymentChallenge | null> {
    const header = res.headers.get('payment-required');
    if (!header) return null;
    let decoded: Record<string, unknown>;
    try {
      decoded = decodeHeader(header) as Record<string, unknown>;
    } catch {
      return null;
    }
    const accepts = Array.isArray(decoded.accepts) ? decoded.accepts : [];
    if (accepts.length === 0) return null;
    return {
      x402Version: 2,
      options: toOptions(accepts),
      resourceUrl:
        decoded.resource && typeof decoded.resource === 'object'
          ? String((decoded.resource as Record<string, unknown>).url ?? '')
          : undefined,
    };
  },

  async pay(
    url: string,
    requestInit: RequestInit,
    challenge: PaymentChallenge,
    wallets: WalletSet,
    opts: PayAndFetchOptions,
  ): Promise<PayResult> {
    // Pick first option whose network family has a matching wallet.
    const option: ChallengeOption | undefined = challenge.options.find(o => {
      if (o.network.family === 'evm') return !!wallets.evm;
      if (o.network.family === 'svm') return !!wallets.solana;
      return false;
    });

    if (!option) {
      return { ok: false, reason: 'unsupported_network' };
    }

    // Delegate to createX402Client which accepts a WalletSet directly.
    // wrapFetch only accepts private key strings, so we go one level deeper.
    const client = createX402Client({
      wallets,
      preferredNetwork: option.network.caip2,
      maxAmountAtomic: opts.maxAmountAtomic,
      fetch: globalThis.fetch,
    });

    // Build a fresh RequestInit — never reuse a potentially-consumed body.
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? 15000,
    );

    // Compose the caller's own cancellation signal with the timeout signal so
    // neither is lost. AbortSignal.any fires on the first signal to abort.
    const composedSignal = requestInit.signal
      ? AbortSignal.any([requestInit.signal, controller.signal])
      : controller.signal;

    const freshInit: RequestInit = {
      method: requestInit.method ?? 'GET',
      headers: requestInit.headers,
      signal: composedSignal,
    };
    if (typeof requestInit.body === 'string') {
      freshInit.body = requestInit.body;
    }

    try {
      const response = await client.fetch(url, freshInit);
      clearTimeout(timeoutId);

      if (!response.ok) {
        // Paid retry still failed — distinguish "merchant rejected our
        // payment" from "merchant accepted it, their settlement failed",
        // and carry their verbatim error so the caller sees whose fault.
        return { ok: false, ...(await classifyPaidFailure(response)) };
      }

      // The PAYMENT-RESPONSE header is a base64-encoded JSON blob of the form
      // {"success":true,"transaction":"<hash>","network":"..."}.
      // Extract the `transaction` field as the actual tx hash; fall back to
      // undefined rather than exposing the raw base64 blob to callers.
      let txSignature: string | undefined;
      const paymentResponseHeader = response.headers.get('PAYMENT-RESPONSE');
      if (paymentResponseHeader) {
        try {
          const decoded = decodeHeader(paymentResponseHeader) as Record<string, unknown>;
          if (decoded && typeof decoded.transaction === 'string') {
            txSignature = decoded.transaction;
          }
        } catch {
          // Malformed header — leave txSignature undefined.
        }
      }

      return {
        ok: true,
        response,
        amountPaid: option.amount,
        network: option.network,
        txSignature,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const e = err as { name?: string; message?: string };
      if (e?.name === 'AbortError') {
        return { ok: false, reason: 'timeout' };
      }
      return { ok: false, reason: 'error', detail: e?.message ?? String(err) };
    }
  },
};
