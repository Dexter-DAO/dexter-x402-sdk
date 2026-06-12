/**
 * Step-3a buyer orchestration: pay a URL through a tab with ZERO seller
 * knowledge. Resolution + lifecycle only — composes resolveTabOffer,
 * openTab, and payAndFetch; no new on-chain or settlement code.
 *
 * The caller owns close(): tabs amortize settle cost across requests, so
 * this function never closes the tab it returns — including when payment
 * FAILS after the tab opened (tab is non-null there; close it to settle
 * whatever streamed and free the freeze).
 *
 * Request count: two unpaid GETs precede the paid one — resolveTabOffer
 * probes to discover the offer, then payAndFetch probes again as part of
 * protocol dispatch. Three requests total per call; sellers see the extra
 * probes as ordinary 402s.
 */
import type { Tab, VaultAdapter, HumanAmount } from './types';
import type { PayResult } from '../payment/types';
import { payAndFetch } from '../payment';
import { openTab, humanToAtomic } from './tab';
import { resolveTabOffer } from './resolve';

export interface PayUrlWithTabOptions {
  vault: VaultAdapter;
  /** Max single-voucher spend (human units) — quotes above this are refused. */
  perUnitCap: HumanAmount;
  /** Max cumulative tab spend (human units). */
  totalCap: HumanAmount;
  sessionDuration?: number;
  facilitatorUrl?: string;
  /**
   * Open-tab registry keyed by counterparty base58. Pass the SAME Map across
   * calls to reuse one open tab per seller instead of re-registering
   * (one tab per (vault, counterparty)). Newly opened tabs are added to it.
   */
  tabs?: Map<string, Tab>;
}

export interface PayUrlWithTabResult {
  result: PayResult;
  /** The tab used — caller owns close(). Null when nothing was paid. */
  tab: Tab | null;
}

export async function payUrlWithTab(
  url: string,
  init: RequestInit = {},
  opts: PayUrlWithTabOptions,
): Promise<PayUrlWithTabResult> {
  const resolved = await resolveTabOffer(url, init);

  if (resolved.kind === 'free') {
    return { result: { ok: true, paid: false, response: resolved.response }, tab: null };
  }
  if (resolved.kind === 'no_tab') {
    return {
      result: {
        ok: false,
        reason: 'no_payment_options',
        detail: `no tab option offered (schemes: ${resolved.schemesOffered.join(', ')})`,
      },
      tab: null,
    };
  }
  if (resolved.kind === 'error') {
    return { result: { ok: false, reason: 'error', detail: resolved.detail }, tab: null };
  }
  const { offer } = resolved;

  // Refuse before ANY chain action when the seller quotes above the
  // caller's per-request authorization.
  const perUnitCapAtomic = BigInt(humanToAtomic(opts.perUnitCap));
  if (BigInt(offer.amountAtomic) > perUnitCapAtomic) {
    return {
      result: {
        ok: false,
        reason: 'budget_exceeded',
        detail: `seller quotes ${offer.amountAtomic} atomic; perUnitCap allows ${perUnitCapAtomic}`,
      },
      tab: null,
    };
  }

  // One tab per (vault, counterparty): reuse an open one, else open —
  // openTab registers the session AND arms the freeze (fail-closed).
  let tab = opts.tabs?.get(offer.payTo);
  if (!tab || !tab.state.isOpen) {
    tab = await openTab({
      vault: opts.vault,
      network: 'solana:mainnet',
      seller: offer.payTo,
      perUnitCap: opts.perUnitCap,
      totalCap: opts.totalCap,
      sessionDuration: opts.sessionDuration,
      facilitatorUrl: opts.facilitatorUrl,
    });
    opts.tabs?.set(offer.payTo, tab);
  }

  // Empty WalletSet is deliberate: the tab path needs no wallet, and a tab
  // that can't pay must FAIL here, never silently fall back to 'exact'.
  // Known legibility gap: an EXHAUSTED reused tab surfaces as
  // 'no_payment_options' ("got: tab") because signNextVoucher's refusal
  // falls through to the wallet-less generic path. Check tab.state.remaining
  // when recovering.
  const result = await payAndFetch(url, init, {}, { tab });
  return { result, tab };
}
