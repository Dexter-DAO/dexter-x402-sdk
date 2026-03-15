/**
 * API Discovery — Find x402 Paid APIs
 *
 * Search the Dexter marketplace for x402-enabled APIs. Discover endpoints
 * by category, price range, network, and quality score — then pay for them
 * with the same SDK.
 *
 * @example
 * ```typescript
 * import { searchAPIs } from '@dexterai/x402/client';
 *
 * const results = await searchAPIs({ query: 'sentiment analysis', maxPrice: 0.10 });
 * for (const api of results) {
 *   console.log(`${api.name}: ${api.price} — ${api.description}`);
 * }
 *
 * // Then call one with wrapFetch:
 * const response = await x402Fetch(results[0].url);
 * ```
 */

/**
 * Search options for discovering x402 APIs
 */
export interface SearchAPIsOptions {
  /** Search query (e.g., 'sentiment analysis', 'token price', 'image generation') */
  query?: string;
  /** Filter by category (e.g., 'defi', 'ai', 'data', 'social') */
  category?: string;
  /** Filter by payment network (e.g., 'solana', 'base', 'polygon') */
  network?: string;
  /** Maximum price per call in USDC */
  maxPrice?: number;
  /** Only return verified endpoints (quality score 75+) */
  verifiedOnly?: boolean;
  /** Sort order */
  sort?: 'marketplace' | 'relevance' | 'quality_score' | 'settlements' | 'volume' | 'recent';
  /** Maximum results to return (default 20, max 50) */
  limit?: number;
  /** Marketplace API URL (default: Dexter marketplace) */
  marketplaceUrl?: string;
}

/**
 * A discovered x402 API endpoint
 */
export interface DiscoveredAPI {
  /** API name */
  name: string;
  /** Full resource URL — pass directly to wrapFetch or createX402Client.fetch */
  url: string;
  /** HTTP method */
  method: string;
  /** Price per call (formatted, e.g., '$0.05') */
  price: string;
  /** Price per call in USDC (raw number, null if free) */
  priceUsdc: number | null;
  /** Payment network */
  network: string | null;
  /** Human-readable description */
  description: string;
  /** Category (e.g., 'defi', 'ai', 'data') */
  category: string;
  /** Quality score (0-100, null if unscored) */
  qualityScore: number | null;
  /** Whether the endpoint has been verified */
  verified: boolean;
  /** Total number of settlements (calls) */
  totalCalls: number;
  /** Total volume in USDC (formatted, e.g., '$1,234.56') */
  totalVolume: string | null;
  /** Seller name */
  seller: string | null;
  /** Seller reputation score */
  sellerReputation: number | null;
  /** Whether authentication is required beyond payment */
  authRequired: boolean;
  /** Last time someone called this API */
  lastActive: string | null;
}

const DEFAULT_MARKETPLACE = 'https://x402.dexter.cash/api/facilitator/marketplace/resources';

/**
 * Search the Dexter marketplace for x402 paid APIs.
 *
 * Returns a list of discovered endpoints that can be called directly
 * with `wrapFetch` or `createX402Client.fetch`.
 *
 * @example Find AI APIs under $0.10
 * ```typescript
 * const apis = await searchAPIs({ query: 'ai', maxPrice: 0.10 });
 * ```
 *
 * @example Browse all verified DeFi tools
 * ```typescript
 * const apis = await searchAPIs({ category: 'defi', verifiedOnly: true });
 * ```
 *
 * @example Find cheapest APIs on Solana
 * ```typescript
 * const apis = await searchAPIs({ network: 'solana', sort: 'quality_score' });
 * ```
 */
export async function searchAPIs(options: SearchAPIsOptions = {}): Promise<DiscoveredAPI[]> {
  const {
    query,
    category,
    network,
    maxPrice,
    verifiedOnly,
    sort = 'marketplace',
    limit = 20,
    marketplaceUrl = DEFAULT_MARKETPLACE,
  } = options;

  const params = new URLSearchParams();
  if (query) params.set('search', query);
  if (category) params.set('category', category);
  if (network) params.set('network', network);
  if (maxPrice !== undefined) params.set('maxPrice', String(maxPrice));
  if (verifiedOnly) params.set('verified', 'true');
  params.set('sort', sort);
  params.set('order', 'desc');
  params.set('limit', String(Math.min(limit, 50)));

  const url = `${marketplaceUrl}?${params.toString()}`;

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Marketplace search failed: ${response.status}`);
  }

  const data = await response.json() as {
    resources?: Array<{
      resourceUrl: string;
      displayName?: string;
      description?: string | null;
      method?: string;
      priceUsdc?: number | null;
      priceLabel?: string | null;
      priceNetwork?: string | null;
      qualityScore?: number | null;
      verificationStatus?: string | null;
      totalSettlements?: number;
      totalVolumeUsdc?: number;
      category?: string | null;
      seller?: { displayName?: string | null };
      reputationScore?: number | null;
      authRequired?: boolean;
      lastSettlementAt?: string | null;
    }>;
  };

  if (!data.resources) return [];

  return data.resources.map((r): DiscoveredAPI => ({
    name: r.displayName || r.resourceUrl,
    url: r.resourceUrl,
    method: r.method || 'GET',
    price: r.priceLabel || (r.priceUsdc ? `$${r.priceUsdc.toFixed(4)}` : 'free'),
    priceUsdc: r.priceUsdc ?? null,
    network: r.priceNetwork ?? null,
    description: r.description || '',
    category: r.category || 'uncategorized',
    qualityScore: r.qualityScore ?? null,
    verified: r.verificationStatus === 'pass',
    totalCalls: r.totalSettlements || 0,
    totalVolume: r.totalVolumeUsdc ? `$${r.totalVolumeUsdc.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : null,
    seller: r.seller?.displayName ?? null,
    sellerReputation: r.reputationScore ?? null,
    authRequired: r.authRequired || false,
    lastActive: r.lastSettlementAt ?? null,
  }));
}
