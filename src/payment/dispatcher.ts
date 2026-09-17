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
import { toSiwxSigner } from './siwx-signer';
import { errorDetail } from './errors';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { SIWxExtension } from '@x402/extensions/sign-in-with-x';

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

type ProbeResult = {
  response: Response;
  paymentUrl: string;
  paymentInit: RequestInit;
};

/** Keep a wallet proof and any following payment at the challenged endpoint. */
async function buildProbeFetch(
  wallets: WalletSet,
): Promise<(url: string, init: RequestInit) => Promise<ProbeResult>> {
  const bareProbe = async (url: string, init: RequestInit): Promise<ProbeResult> => ({
    response: await fetch(url, init), paymentUrl: url, paymentInit: init,
  });
  const signer = toSiwxSigner(wallets);
  if (!signer) return bareProbe;
  let mod: typeof import('@x402/extensions/sign-in-with-x');
  try {
    mod = await import('@x402/extensions/sign-in-with-x');
  } catch (err) {
    console.warn(
      `[x402] SIW-X unavailable — @x402/extensions failed to load; ` +
        `SIW-X merchants will not authenticate. ` +
        `${errorDetail(err)}`,
    );
    return bareProbe;
  }
  return async (url, init) => {
    const request = new Request(url, init);
    const retry = request.clone();
    const response = await fetch(request);
    const original = { response, paymentUrl: url, paymentInit: init };
    if (response.status !== 402) return original;
    const header = response.headers.get('PAYMENT-REQUIRED');
    if (!header) return original;
    const required = decodePaymentRequiredHeader(header);
    const extension = required.extensions?.[mod.SIGN_IN_WITH_X] as SIWxExtension | undefined;
    if (!extension?.supportedChains) return original;
    if (retry.headers.has(mod.SIGN_IN_WITH_X)) {
      throw new Error('SIWX authentication already attempted');
    }
    const network = required.accepts?.[0]?.network;
    const chain = extension.supportedChains.find((candidate) => candidate.chainId === network);
    if (!chain) return original;
    const finalUrl = response.url || request.url;
    if (response.redirected && !['GET', 'HEAD'].includes(request.method)) {
      throw new Error('SIWX cannot safely replay a redirected non-GET/HEAD request; use the final resource URL');
    }
    const info = { ...extension.info, chainId: chain.chainId, type: chain.type };
    // A rejected origin must not become permission to pay another endpoint.
    mod.assertSIWxChallengeBoundToOrigin(info, finalUrl);
    if (response.redirected || new URL(finalUrl).origin !== new URL(request.url).origin) {
      // The response does not reveal intermediate origins. Never restore
      // credentials that Fetch may have removed anywhere along the redirect.
      for (const name of ['authorization', 'cookie', 'cookie2', 'proxy-authorization', 'host']) {
        retry.headers.delete(name);
      }
    }
    const paymentHeaders = new Headers(retry.headers);
    const bound = {
      response,
      paymentUrl: finalUrl,
      paymentInit: { ...init, headers: Object.fromEntries(paymentHeaders), redirect: 'error' as const },
    };
    try {
      const payload = await mod.createSIWxPayload(info, signer, finalUrl);
      retry.headers.set(mod.SIGN_IN_WITH_X, mod.encodeSIWxHeader(payload));
    } catch {
      // Signing may be unavailable; the ordinary paid option stays bound to
      // the same validated merchant. No signed request has been dispatched.
      return bound;
    }
    // Fetch failures (including redirects) escape to payAndFetch's typed
    // error. They must not trigger a new payment or forward the proof.
    const signedRequest = new Request(new Request(finalUrl, retry), { redirect: 'error' });
    return { ...bound, response: await fetch(signedRequest) };
  };
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
  let paymentUrl = url;
  let paymentInit = requestInit;
  try {
    // Probe through a SIW-X-aware fetch — it signs Sign-In-With-X
    // challenges transparently and is a pass-through otherwise. Body is
    // guaranteed string-or-nullish by the guard above, safe to re-send.
    const probeFetch = await buildProbeFetch(wallets);
    const result = await probeFetch(url, { ...requestInit });
    probe = result.response;
    paymentUrl = result.paymentUrl;
    paymentInit = result.paymentInit;
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      detail: errorDetail(err),
    };
  }

  if (probe.status !== 402) {
    // The endpoint didn't demand payment — return the response unchanged and
    // mark the result as unpaid so callers can narrow before reading any
    // payment fields. Previously this returned `amountPaid: '0'` and a
    // phantom `{ caip2: '', bare: '', family: 'evm' }` placeholder, which
    // poisoned downstream analytics that grouped by network.
    return {
      ok: true,
      paid: false,
      response: probe,
    };
  }

  for (const strategy of STRATEGIES) {
    const challenge = await strategy.parseChallenge(probe.clone());
    if (challenge) {
      return strategy.pay(paymentUrl, paymentInit, challenge, wallets, opts);
    }
  }
  return { ok: false, reason: 'no_payment_options' };
}
