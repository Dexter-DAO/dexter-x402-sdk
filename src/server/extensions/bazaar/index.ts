/**
 * The bazaar discovery extension — a ResourceServerExtension that adds
 * `extensions.bazaar` to a 402 PaymentRequired response.
 */

import type { ResourceServerExtension, PaymentRequiredContext } from '../types';
import { buildDiscoveryExtension } from './build';
import type { DiscoveryConfig, QueryMethod, BodyMethod } from './types';

const VALID_METHODS = ['GET', 'HEAD', 'DELETE', 'POST', 'PUT', 'PATCH'];

/**
 * Create the bazaar discovery extension.
 *
 * Its `enrichPaymentRequiredResponse` takes the route's declared discovery
 * config and the request context, and returns the spec-compliant
 * `{ info, schema, routeTemplate? }` block. If the declaration omits
 * `method`, the actual request method is used.
 */
export function bazaarExtension(): ResourceServerExtension {
  return {
    key: 'bazaar',
    enrichPaymentRequiredResponse: (
      declaration: unknown,
      context: PaymentRequiredContext,
    ) => {
      if (declaration === undefined || declaration === null) return undefined;

      // The declaration is a discovery config; method may be absent.
      const decl = declaration as Partial<DiscoveryConfig> & {
        method?: string;
      };
      const method = (decl.method ?? context.request.method).toUpperCase();
      if (!VALID_METHODS.includes(method)) return undefined;

      const config = { ...decl, method } as DiscoveryConfig;

      return buildDiscoveryExtension(config, {
        pathParams: context.request.params,
        routeTemplate: context.request.path,
      });
    },
  };
}

/** Re-exported method types for convenience. */
export type { QueryMethod, BodyMethod };
