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
import type { WalletSet, SettlementProbe } from '../adapters/types';
import type { Tab, SignedVoucher } from '../tab/types';
import { createX402Client } from '../client/x402-client';
import { voucherToHeader } from '../tab/tab';
import { classifyPaidFailure } from './errors';
import { confirmSettlement } from './confirm-settlement';
import { parseV2Challenge, decodePaymentRequiredHeader } from './v2-challenge';

/**
 * Schemes the GENERIC per-request path can actually construct a payment
 * for: 'exact' (EIP-3009 / signed SPL transfer) and 'exact-approval'
 * (approval-based chains, routed inside the EVM adapter). Session-object
 * schemes — 'batch-settlement', 'tab' — are payable only through their own
 * live objects (openBatchChannel / openTab), never by signing a one-shot
 * transfer, so the generic picker must skip them rather than submit a
 * plain transfer against them.
 */
const GENERIC_PAYABLE_SCHEMES = new Set(['exact', 'exact-approval']);

/**
 * Attempt to pay a `tab`-scheme option with the caller's open tab by
 * signing the next cumulative voucher and re-requesting with the
 * X-Tab-Voucher header — no facilitator round-trip.
 *
 * Returns null to signal "fall through to the generic path": the tab could
 * not sign (scope exceeded / closed) or the seller refused the voucher
 * (second 402). Any other outcome is final and returned as a PayResult.
 */
async function payWithTab(
  url: string,
  requestInit: RequestInit,
  option: ChallengeOption,
  tab: Tab,
): Promise<PayResult | null> {
  let signed: SignedVoucher;
  try {
    signed = await tab.signNextVoucher(option.amount);
  } catch {
    // Cap exceeded, session expired, or tab closed — the tab cannot cover
    // this request, but a generic option still might.
    return null;
  }

  const headers = new Headers(requestInit.headers ?? undefined);
  headers.set('X-Tab-Voucher', voucherToHeader(signed));
  const freshInit: RequestInit = {
    method: requestInit.method ?? 'GET',
    headers,
  };
  if (requestInit.signal) freshInit.signal = requestInit.signal;
  if (typeof requestInit.body === 'string') {
    freshInit.body = requestInit.body;
  }

  let response: Response;
  try {
    response = await fetch(url, freshInit);
  } catch (err: unknown) {
    // The voucher counter already advanced — falling through to the generic
    // path would pay a second time for the same request. Surface the error.
    const e = err as { message?: string };
    return { ok: false, reason: 'error', detail: e?.message ?? String(err) };
  }

  if (response.status === 402) {
    // Seller refused the voucher — fall through to the generic path. First,
    // roll the tab's counter back so close() doesn't ALSO settle the refused
    // increment after the generic path pays exact (double-pay). The rollback
    // is internal to TabImpl (not the public Tab interface), so reach it by
    // duck-typing; it only reverts iff the refused voucher is still the
    // tab's most recent one.
    //
    // Trust model: rollback optimizes the HONEST-refusal case. A malicious
    // seller holds a bearer claim on the refused voucher regardless —
    // on-chain cumulative monotonicity means at most one of the {refused,
    // reissued} cumulative-X vouchers settles, bounded by the session cap
    // (the known soft-tail). Note we deliberately do NOT roll back on the
    // fetch-THROW path above: the request may have reached the seller, so
    // that path surfaces an error instead of risking a double-pay.
    const rollback = (
      tab as Tab & { rollbackVoucher?: (v: SignedVoucher) => boolean }
    ).rollbackVoucher;
    rollback?.call(tab, signed);
    return null;
  }
  if (!response.ok) {
    return { ok: false, ...(await classifyPaidFailure(response)) };
  }
  return {
    ok: true,
    paid: true,
    response,
    amountPaid: option.amount,
    network: option.network,
  };
}

export const v2Strategy: PaymentStrategy = {
  version: 2,

  async parseChallenge(res: Response): Promise<PaymentChallenge | null> { return parseV2Challenge(res); },

  async pay(
    url: string,
    requestInit: RequestInit,
    challenge: PaymentChallenge,
    wallets: WalletSet,
    opts: PayAndFetchOptions,
  ): Promise<PayResult> {
    // ── Tab negotiation ────────────────────────────────────────────────
    // When the caller holds an open tab and the merchant offers scheme
    // 'tab' (SVM-only) paying TO the tab's counterparty, pay by voucher
    // header directly — no facilitator round-trip. A refusal (second 402)
    // or a scope-exceeded signing failure falls through to the generic
    // path below.
    if (opts.tab) {
      const tabOption = challenge.options.find(
        o =>
          o.scheme === 'tab' &&
          o.network.family === 'svm' &&
          o.payTo === opts.tab!.counterparty,
      );
      if (tabOption) {
        const tabResult = await payWithTab(url, requestInit, tabOption, opts.tab);
        if (tabResult) return tabResult;
      }
    }

    // ── Generic pick ───────────────────────────────────────────────────
    // Only schemes this path can genuinely pay pass the filter — a 'tab'
    // option without opts.tab (or 'batch-settlement' without a channel) is
    // skipped, never paid as a plain transfer.
    const payable = challenge.options.filter(o =>
      GENERIC_PAYABLE_SCHEMES.has(o.scheme),
    );
    if (payable.length === 0) {
      return {
        ok: false,
        reason: 'no_payment_options',
        detail: `no generically payable scheme offered (got: ${challenge.options.map(o => o.scheme).join(', ')})`,
      };
    }

    // Pick first payable option whose network family has a matching wallet.
    const option: ChallengeOption | undefined = payable.find(o => {
      if (o.network.family === 'evm') return !!wallets.evm;
      if (o.network.family === 'svm') return !!wallets.solana;
      return false;
    });

    if (!option) {
      return { ok: false, reason: 'unsupported_network' };
    }

    // ── Two-phase timeout ──────────────────────────────────────────────
    // One operation, two phases with separate deadlines:
    //   1. pre-payment  — probe + build/sign. No money committed. Short
    //      deadline (`timeoutMs`, 15s). Abort here ⇒ reason 'timeout',
    //      safe to retry.
    //   2. post-payment — the wait for the merchant's response after the
    //      PAYMENT-SIGNATURE header is sent. The facilitator may settle at
    //      any instant. Long deadline (`responseTimeoutMs`, 120s). Abort
    //      here ⇒ reason 'payment_unconfirmed' — the money may be gone.
    //
    // We use a single AbortController and a single composed signal, but
    // reschedule the timer when payment is dispatched: clear the short
    // pre-payment timer, arm the long post-payment one. `paymentDispatched`
    // records which phase we were in when an abort fired.
    const preTimeoutMs = opts.timeoutMs ?? 15000;
    const postTimeoutMs = opts.responseTimeoutMs ?? 120000;

    const controller = new AbortController();
    let timeoutId = setTimeout(() => controller.abort(), preTimeoutMs);
    let paymentDispatched = false;
    let settlementProbe: SettlementProbe | undefined;

    const onPaymentDispatched = (
      _accept: unknown,
      probe?: SettlementProbe,
    ) => {
      // Crossing the seam: the payment is leaving our hands. Swap the short
      // pre-payment deadline for the long post-payment one, and keep the
      // probe so a post-payment abort can confirm settlement on-chain.
      paymentDispatched = true;
      settlementProbe = probe;
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => controller.abort(), postTimeoutMs);
    };

    // Delegate to createX402Client which accepts a WalletSet directly.
    // wrapFetch only accepts private key strings, so we go one level deeper.
    const client = createX402Client({
      wallets,
      preferredNetwork: option.network.caip2,
      maxAmountAtomic: opts.maxAmountAtomic,
      fetch: globalThis.fetch,
      onPaymentDispatched,
    });

    // Compose the caller's own cancellation signal with the timeout signal so
    // neither is lost. AbortSignal.any fires on the first signal to abort.
    const composedSignal = requestInit.signal
      ? AbortSignal.any([requestInit.signal, controller.signal])
      : controller.signal;

    // Build a fresh RequestInit — never reuse a potentially-consumed body.
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
          const decoded = decodePaymentRequiredHeader(paymentResponseHeader) as Record<string, unknown>;
          if (decoded && typeof decoded.transaction === 'string') {
            txSignature = decoded.transaction;
          }
        } catch {
          // Malformed header — leave txSignature undefined.
        }
      }

      return {
        ok: true,
        paid: true,
        response,
        amountPaid: option.amount,
        network: option.network,
        txSignature,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const e = err as { name?: string; message?: string };
      if (e?.name === 'AbortError') {
        // Which phase were we in when the abort fired?
        if (!paymentDispatched) {
          // Pre-payment: no authorization was sent. No money moved. The
          // caller can safely retry.
          return { ok: false, reason: 'timeout' };
        }
        // Post-payment: the PAYMENT-SIGNATURE header was already sent. Ask
        // the chain directly whether the payment settled.
        const confirmation = await confirmSettlement(
          settlementProbe,
          option.network,
          opts.solanaRpcUrl,
        );
        if (confirmation.confirmed) {
          // The money moved. The merchant simply never delivered a response.
          // Report a confirmed payment with no response body — never
          // 'timeout', which would invite a double-charge.
          return {
            ok: true,
            paid: true,
            response: undefined,
            amountPaid: option.amount,
            network: option.network,
            txSignature: confirmation.txSignature,
          };
        }
        // Could not confirm settlement (no probe / RPC failed / no matching
        // transfer found). Report the honest unconfirmed state.
        return {
          ok: false,
          reason: 'payment_unconfirmed',
          detail: confirmation.detail,
        };
      }
      return { ok: false, reason: 'error', detail: e?.message ?? String(err) };
    }
  },
};
