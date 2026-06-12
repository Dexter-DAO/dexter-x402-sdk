/**
 * Step-3a URL resolution: given ONLY a URL, discover the tab counterparty
 * from the resource's own standard x402 v2 402 challenge. The seller
 * pubkey always comes off the wire — never from the caller.
 */
import { PublicKey } from '@solana/web3.js';
import { parseV2Challenge } from '../payment/v2-challenge';

export interface TabOffer {
  /** Seller counterparty (base58) read from the challenge's payTo. */
  payTo: string;
  /** Atomic per-request amount the seller quoted (maxAmountRequired). */
  amountAtomic: string;
  asset: string;
  /** CAIP-2 network from the challenge (x402 v2 form). */
  networkCaip2: string;
  resourceUrl?: string;
}

export type TabOfferResult =
  | { kind: 'offer'; offer: TabOffer }
  | { kind: 'free'; response: Response }
  | { kind: 'no_tab'; schemesOffered: string[] }
  | { kind: 'error'; detail: string };

/**
 * Probe a URL and resolve its tab payment offer. Sends the caller's
 * method/headers (and a string body, mirroring payAndFetch's probe rules)
 * WITHOUT any payment attached; a paying caller follows up via
 * payUrlWithTab. Never throws for an expected failure.
 */
export async function resolveTabOffer(
  url: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<TabOfferResult> {
  const probeInit: RequestInit = {
    method: init.method ?? 'GET',
    headers: init.headers,
  };
  if (typeof init.body === 'string') probeInit.body = init.body;

  let res: Response;
  try {
    res = await fetchImpl(url, probeInit);
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { kind: 'error', detail: `probe failed: ${e?.message ?? String(err)}` };
  }

  if (res.status !== 402) {
    if (res.ok) return { kind: 'free', response: res };
    return { kind: 'error', detail: `probe returned HTTP ${res.status}` };
  }

  const challenge = await parseV2Challenge(res);
  if (!challenge) {
    return {
      kind: 'error',
      detail: 'the 402 carries no x402 v2 PAYMENT-REQUIRED challenge',
    };
  }

  const tabOption = challenge.options.find(
    (o) => o.scheme === 'tab' && o.network.family === 'svm',
  );
  if (!tabOption) {
    return { kind: 'no_tab', schemesOffered: challenge.options.map((o) => o.scheme) };
  }

  try {
    new PublicKey(tabOption.payTo); // reject before anything opens a tab to it
  } catch {
    return {
      kind: 'error',
      detail: `tab option payTo is not a valid Solana pubkey: "${tabOption.payTo}"`,
    };
  }

  return {
    kind: 'offer',
    offer: {
      payTo: tabOption.payTo,
      amountAtomic: tabOption.amount,
      asset: tabOption.asset,
      networkCaip2: tabOption.network.caip2,
      resourceUrl: challenge.resourceUrl,
    },
  };
}
