/**
 * API Discovery — Semantic Capability Search
 *
 * Search the Dexter x402 marketplace for paid APIs using semantic capability
 * search. Queries are embedded with a vector model, filtered by a similarity
 * floor, split into strong and related tiers, and the top strong results are
 * reordered by an LLM cross-encoder. Synonym expansion and alternate phrasing
 * handling happen automatically inside the search backend — pass a natural-
 * language query and let the ranker do the work.
 *
 * @example
 * ```typescript
 * import { capabilitySearch } from '@dexterai/x402/client';
 *
 * const result = await capabilitySearch({ query: 'get ETH spot price' });
 *
 * // Strong matches: high-confidence capability hits
 * for (const api of result.strongResults) {
 *   console.log(`${api.name} (${api.tier}, similarity ${api.similarity}): ${api.why}`);
 * }
 *
 * // Related matches: adjacent services that cleared the similarity floor
 * // but not the strong threshold. Useful as a fallback when strongResults
 * // is empty or sparse.
 * for (const api of result.relatedResults) {
 *   console.log(`${api.name} (related): ${api.description}`);
 * }
 *
 * // Then call one with wrapFetch:
 * const response = await x402Fetch(result.strongResults[0].url);
 * ```
 *
 * @breaking 3.0.0
 * This module was rewritten to target the capability search endpoint at
 * `/api/x402gle/capability` instead of the legacy substring ranker at
 * `/api/facilitator/marketplace/resources`. The old `searchAPIs()` function
 * and `DiscoveredAPI` type have been removed — replaced by `capabilitySearch()`
 * and `CapabilityAPI`. The response is now tiered (strongResults/relatedResults)
 * and each result carries `tier`, `similarity`, and `why` explainers. Filter
 * parameters like `category`, `network`, `maxPrice`, `verifiedOnly`, and `sort`
 * are gone — the ranker handles these semantically rather than as hard filters.
 */

/**
 * Options for semantic capability search.
 *
 * The new pipeline does NOT accept the old hard-filter params (`category`,
 * `network`, `maxPrice`, `verifiedOnly`, `sort`). Those were removed in 3.0.0
 * because they were the source of silent false-empties: e.g. a query for
 * "ETH price" on `network: 'ethereum'` would return zero results because
 * every ETH-price resource accepts payment on Base (Ethereum gas is too
 * expensive). Search ranks by capability relevance; payment rail is a
 * checkout-time concern the caller handles separately.
 */
export interface CapabilitySearchOptions {
  /** Natural-language description of the capability you want. Required. */
  query: string;
  /** Max results across strong + related tiers combined (1-50, default 20) */
  limit?: number;
  /** Include unverified resources (default false) */
  unverified?: boolean;
  /** Include testnet-only resources (default false) */
  testnets?: boolean;
  /**
   * Cross-encoder LLM rerank of the top strong results. Default true.
   * Adds ~1s of latency in exchange for meaningfully better top-of-list
   * ordering on ambiguous queries. Set to false for deterministic order
   * or lowest-latency path.
   */
  rerank?: boolean;
  /**
   * Override the capability search endpoint. Defaults to the Dexter-hosted
   * endpoint. Useful for testing against a local dexter-api instance.
   */
  endpoint?: string;
}

/**
 * A single result from capability search.
 *
 * Fields are flat-ish and designed to round-trip cleanly through LLM tool
 * outputs and UI renderers. `tier`, `similarity`, and `why` are the three
 * new fields that the ranker produces: use them to distinguish high-confidence
 * matches from related suggestions.
 */
export interface CapabilityAPI {
  /** Internal resource UUID in the Dexter catalog */
  resourceId: string;
  /** Display name (falls back to the URL if the resource is unnamed) */
  name: string;
  /** Full resource URL — pass directly to wrapFetch or createX402Client.fetch */
  url: string;
  /** HTTP method the endpoint expects */
  method: string;
  /**
   * Formatted price label ("$0.05", "$0.0011", "free", or "price on request"
   * when the resource has no advertised price).
   */
  price: string;
  /** Raw price in USDC as a number (null when the resource has no advertised price) */
  priceUsdc: number | null;
  /** Payment network the price is quoted on (CAIP-2 or canonical name) */
  network: string | null;
  /** Human-readable description */
  description: string;
  /** Category assigned by the catalog */
  category: string;
  /** Quality score 0-100 (null if unscored) */
  qualityScore: number | null;
  /** Whether the endpoint passed AI verification (alias for verificationStatus === 'pass') */
  verified: boolean;
  /** Full verification status: 'pass' | 'fail' | 'inconclusive' | 'skipped' | 'unverified' */
  verificationStatus: string;
  /** Total number of settlements (calls) observed against this resource */
  totalCalls: number;
  /** Total settled volume in USDC */
  totalVolumeUsdc: number;
  /** Icon URL (favicon or seller logo) */
  iconUrl: string | null;
  /** Host label derived from the URL */
  host: string | null;
  /** Gaming/wash-trading flags — non-empty array means the resource is suspicious */
  gamingFlags: string[];
  /** True when any gaming flag is set */
  gamingSuspicious: boolean;

  // ── New tiered ranking signals ─────────────────────────────────────────

  /** Which tier this result fell into — 'strong' (high confidence) or 'related' (adjacent) */
  tier: 'strong' | 'related';
  /** Raw cosine similarity 0-1 between the query embedding and the resource embedding */
  similarity: number;
  /**
   * One-sentence explanation of why this result ranked where it did. Built
   * from the modular ranking factors (semantic similarity, trust, activity,
   * gaming penalty).
   */
  why: string;
  /** Final combined ranking score in [0, 1] */
  score: number;
}

/**
 * Why a response has no strong matches.
 * - 'below_similarity_threshold': no candidates cleared the similarity floor at all
 * - 'below_strong_threshold': candidates cleared the floor but none reached strong
 * - null: strongResults is non-empty
 */
export type NoMatchReason = 'below_similarity_threshold' | 'below_strong_threshold' | null;

/**
 * Full response from capability search. Tiered shape with telemetry about
 * the ranking pipeline.
 */
export interface CapabilitySearchResult {
  /** The original query string the caller passed */
  query: string;
  /**
   * Strong matches — high-confidence capability hits (similarity >= strong
   * threshold). These are the primary results the caller should surface.
   */
  strongResults: CapabilityAPI[];
  /**
   * Related matches — candidates that cleared the similarity floor but did
   * not reach the strong threshold. Useful as a secondary section when
   * strongResults is empty or sparse.
   */
  relatedResults: CapabilityAPI[];
  /** Count of strong results returned */
  strongCount: number;
  /** Count of related results returned */
  relatedCount: number;
  /** Highest cosine similarity observed across all candidates (null when no candidates) */
  topSimilarity: number | null;
  /** Reason the response has no strong matches (null when strong matches exist) */
  noMatchReason: NoMatchReason;
  /**
   * Cross-encoder rerank telemetry. `applied` is true when the LLM actually
   * reordered the top strong results; `reason` explains any skip.
   */
  rerank: {
    enabled: boolean;
    applied: boolean;
    reason?: string;
  };
  /**
   * The parsed intent the backend extracted. `capabilityText` is the bare
   * capability; `expandedCapabilityText` is the synonym-expanded version that
   * was actually embedded for the vector search.
   */
  intent: {
    capabilityText: string;
    expandedCapabilityText?: string;
  };
  /** Total wall-clock duration of the capability search request in milliseconds */
  durationMs: number;
}

const DEFAULT_CAPABILITY_ENDPOINT = 'https://x402.dexter.cash/api/x402gle/capability';

// ============================================================================
// Response shape returned by /api/x402gle/capability — internal parsing only
// ============================================================================

interface RawCapabilityResult {
  resourceId: string;
  resourceUrl: string;
  displayName: string | null;
  description: string | null;
  category: string | null;
  host: string | null;
  method: string;
  icon: string | null;
  pricing: {
    usdc: number | null;
    network: string | null;
    asset: string | null;
  };
  verification: {
    status: string;
    paid: boolean;
    qualityScore: number | null;
    lastVerifiedAt: string | null;
  };
  usage: {
    totalSettlements: number;
    totalVolumeUsdc: number;
    lastSettlementAt: string | null;
  };
  gaming: {
    flags: string[];
    suspicious: boolean;
  };
  score: number;
  similarity: number;
  why: string;
  tier: 'strong' | 'related';
}

interface RawCapabilityResponse {
  ok: boolean;
  query: string;
  intent: {
    capabilityText: string;
    expandedCapabilityText?: string;
  };
  strongResults: RawCapabilityResult[];
  relatedResults: RawCapabilityResult[];
  strongCount: number;
  relatedCount: number;
  topSimilarity: number | null;
  noMatchReason: NoMatchReason;
  rerank: {
    enabled: boolean;
    applied: boolean;
    reason?: string;
  };
  durationMs: number;
  error?: string;
  stage?: string;
}

function formatPriceLabel(priceUsdc: number | null): string {
  if (priceUsdc == null) return 'price on request';
  if (priceUsdc === 0) return 'free';
  if (priceUsdc < 0.01) return `$${priceUsdc.toFixed(4)}`;
  return `$${priceUsdc.toFixed(2)}`;
}

function mapResult(r: RawCapabilityResult): CapabilityAPI {
  return {
    resourceId: r.resourceId,
    name: r.displayName ?? r.resourceUrl,
    url: r.resourceUrl,
    method: r.method || 'GET',
    price: formatPriceLabel(r.pricing.usdc),
    priceUsdc: r.pricing.usdc,
    network: r.pricing.network,
    description: r.description ?? '',
    category: r.category ?? 'uncategorized',
    qualityScore: r.verification.qualityScore,
    verified: r.verification.status === 'pass',
    verificationStatus: r.verification.status,
    totalCalls: r.usage.totalSettlements,
    totalVolumeUsdc: r.usage.totalVolumeUsdc,
    iconUrl: r.icon,
    host: r.host,
    gamingFlags: r.gaming.flags,
    gamingSuspicious: r.gaming.suspicious,
    tier: r.tier,
    similarity: Math.round(r.similarity * 1000) / 1000,
    why: r.why,
    score: r.score,
  };
}

/**
 * Search the Dexter x402 marketplace using semantic capability search.
 *
 * Returns tiered results (strongResults + relatedResults) plus ranking
 * telemetry. Handles synonym expansion and cross-encoder LLM rerank
 * internally — pass the user's natural-language intent directly.
 *
 * @example Find an ETH price feed
 * ```typescript
 * const result = await capabilitySearch({ query: 'get current ETH spot price' });
 * if (result.strongCount > 0) {
 *   const best = result.strongResults[0];
 *   console.log(`${best.name}: ${best.price} — ${best.why}`);
 * } else if (result.relatedCount > 0) {
 *   console.log(`No exact match. Closest related: ${result.relatedResults[0].name}`);
 * } else {
 *   console.log(`No match. Reason: ${result.noMatchReason}`);
 * }
 * ```
 *
 * @example Skip the LLM rerank for lowest latency
 * ```typescript
 * const result = await capabilitySearch({ query: 'token price', rerank: false });
 * ```
 *
 * @example Include unverified resources (usually omitted)
 * ```typescript
 * const result = await capabilitySearch({ query: 'image generation', unverified: true });
 * ```
 */
export async function capabilitySearch(options: CapabilitySearchOptions): Promise<CapabilitySearchResult> {
  if (!options?.query || !options.query.trim()) {
    throw new Error('capabilitySearch: query is required');
  }

  const {
    query,
    limit = 20,
    unverified,
    testnets,
    rerank,
    endpoint = DEFAULT_CAPABILITY_ENDPOINT,
  } = options;

  const params = new URLSearchParams();
  params.set('q', query);
  params.set('limit', String(Math.min(Math.max(limit, 1), 50)));
  if (unverified) params.set('unverified', 'true');
  if (testnets) params.set('testnets', 'true');
  if (rerank === false) params.set('rerank', 'false');

  const url = `${endpoint}?${params.toString()}`;

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Capability search failed: ${response.status} ${body.slice(0, 400)}`);
  }

  const data = (await response.json()) as RawCapabilityResponse;
  if (!data.ok) {
    throw new Error(
      `Capability search error${data.stage ? ` at stage ${data.stage}` : ''}: ${data.error ?? 'unknown'}`,
    );
  }

  return {
    query: data.query,
    strongResults: data.strongResults.map(mapResult),
    relatedResults: data.relatedResults.map(mapResult),
    strongCount: data.strongCount,
    relatedCount: data.relatedCount,
    topSimilarity: data.topSimilarity,
    noMatchReason: data.noMatchReason,
    rerank: data.rerank,
    intent: data.intent,
    durationMs: data.durationMs,
  };
}
