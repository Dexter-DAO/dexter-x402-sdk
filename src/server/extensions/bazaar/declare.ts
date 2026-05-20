/**
 * Server-facing helper for declaring a route's bazaar discovery info.
 *
 * Returns `{ bazaar: <config> }` so it can be spread into the
 * `x402Middleware` `declarations` map — keying the declaration under
 * "bazaar", the key the bazaar extension reads.
 *
 * The `method` field is optional in the config: if omitted, the bazaar
 * extension stamps the actual HTTP method from the request at 402 time.
 */

import type { DiscoveryConfig } from './types';

/** A declaration config — like DiscoveryConfig but `method` may be omitted. */
export type DeclareDiscoveryConfig =
  | Omit<Extract<DiscoveryConfig, { method: 'GET' | 'HEAD' | 'DELETE' }>, 'method'> & {
      method?: 'GET' | 'HEAD' | 'DELETE';
    }
  | Omit<Extract<DiscoveryConfig, { method: 'POST' | 'PUT' | 'PATCH' }>, 'method'> & {
      method?: 'POST' | 'PUT' | 'PATCH';
    };

/**
 * Wrap a discovery config for use in `x402Middleware`'s `declarations`.
 *
 * @example
 * declarations: {
 *   ...declareDiscoveryExtension({ method: 'GET', output: { example: {...} } }),
 * }
 */
export function declareDiscoveryExtension(
  config: DeclareDiscoveryConfig,
): Record<string, unknown> {
  return { bazaar: config };
}
