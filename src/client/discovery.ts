/**
 * API Discovery — Semantic Capability Search
 *
 * Re-exports from @dexterai/x402-core. All types, formatting logic, and the
 * HTTP client are defined once in x402-core and shared across every consumer
 * surface (this SDK, OpenDexter npm, Open MCP, Auth MCP, ChatGPT widget).
 *
 * This file preserves the SDK's public API contract — users who import from
 * `@dexterai/x402/client` see the same `capabilitySearch`, `CapabilityAPI`,
 * `CapabilitySearchOptions`, `CapabilitySearchResult`, and `NoMatchReason`
 * exports they always have.
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

// Re-export everything from x402-core, aliasing FormattedResource as
// CapabilityAPI for backward compatibility with the SDK's public API.
export { capabilitySearch } from '@dexterai/x402-core';

export type {
  CapabilitySearchOptions,
  CapabilitySearchResult,
  NoMatchReason,
} from '@dexterai/x402-core';

// CapabilityAPI is the SDK's published type name for a formatted resource.
// It's the same type — just aliased for backward compatibility.
export type { FormattedResource as CapabilityAPI } from '@dexterai/x402-core';
