/**
 * Step-3b pre-flight resolution: resolve a URL to its TAB TERMS without
 * paying. Built on resolveTabOffer (the standard-402 read); adds the
 * human-denominated price and the Dexter tab settlement descriptor so a
 * directory, a consent UI (Connect-a-Tab), or a decide-before-call agent
 * can show what a tab to this URL means BEFORE any chain action.
 *
 * One network round-trip per URL (the 402 probe). Pass a caller-owned
 * `cache` Map to browse many URLs cheaply — same ownership pattern as
 * payUrlWithTab's `tabs` Map; the caller decides when entries go stale.
 */
import { resolveTabOffer, type TabOffer } from './resolve';
import { atomicToHuman } from './tab';

export interface TabTerms {
  /** Seller counterparty (base58) — read off the wire, never caller-supplied. */
  counterparty: string;
  /** Per-request price the seller quoted. */
  perRequest: { atomic: string; human: string };
  asset: string;
  network: { caip2: string };
  scheme: 'tab';
  /**
   * How a Dexter tab settles — properties of scheme 'tab' as shipped, not
   * seller-configurable: openTab is fail-closed on freeze arming (the buyer
   * cannot drain mid-tab), funds stay in the buyer's vault until settle
   * (non-custodial), and settlement happens at tab close.
   */
  settlement: {
    custody: 'non-custodial';
    protection: 'freeze';
    settleOn: 'close';
  };
  /** Credit terms (Product 2). Reserved; always null today. */
  credit: null;
  resourceUrl?: string;
}

export type TabTermsResult =
  | { kind: 'terms'; terms: TabTerms }
  /** Resource answered without demanding payment; caller owns the live body. */
  | { kind: 'free'; response: Response }
  | { kind: 'no_tab'; schemesOffered: string[] }
  | { kind: 'error'; detail: string };

export interface ResolveTabTermsOptions {
  /** Caller-owned cache keyed by URL. Only 'terms' results are cached. */
  cache?: Map<string, TabTerms>;
  fetchImpl?: typeof fetch;
}

function offerToTerms(offer: TabOffer): TabTerms {
  return {
    counterparty: offer.payTo,
    perRequest: { atomic: offer.amountAtomic, human: atomicToHuman(offer.amountAtomic) },
    asset: offer.asset,
    network: { caip2: offer.networkCaip2 },
    scheme: 'tab',
    settlement: { custody: 'non-custodial', protection: 'freeze', settleOn: 'close' },
    credit: null,
    ...(offer.resourceUrl !== undefined ? { resourceUrl: offer.resourceUrl } : {}),
  };
}

/**
 * Resolve a URL's tab terms without paying. Never throws for expected
 * failures (same contract as resolveTabOffer).
 */
export async function resolveTabTerms(
  url: string,
  init: RequestInit = {},
  opts: ResolveTabTermsOptions = {},
): Promise<TabTermsResult> {
  const cached = opts.cache?.get(url);
  if (cached) return { kind: 'terms', terms: cached };

  const result = await resolveTabOffer(url, init, opts.fetchImpl ?? fetch);
  if (result.kind !== 'offer') return result;

  const terms = offerToTerms(result.offer);
  opts.cache?.set(url, terms);
  return { kind: 'terms', terms };
}
