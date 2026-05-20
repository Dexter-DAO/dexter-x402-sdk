/**
 * Resource-server extension contract.
 *
 * Ported from the upstream x402 core extension model
 * (@x402/core — packages/core/src/types/extensions.ts). An extension can
 * add data to a 402 PaymentRequired response under its own `key`. The
 * `bazaar` discovery extension is the first consumer.
 */

import type { PaymentRequired } from '../../types';

/**
 * Context handed to an extension while a 402 PaymentRequired response is
 * being built.
 */
export interface PaymentRequiredContext {
  /** The PaymentRequired response assembled so far (resource, accepts, ...). */
  response: PaymentRequired;
  /** The HTTP request that triggered the 402 — for method / path / params. */
  request: {
    method: string;
    /** The matched route path, e.g. "/trust/wallet/:address" when known. */
    path: string;
    /** Concrete path-parameter values, e.g. { address: "X4o2..." }. */
    params?: Record<string, string>;
  };
}

/**
 * A resource-server extension. `key` namespaces its output inside
 * `PaymentRequired.extensions`. Every hook is optional.
 */
export interface ResourceServerExtension {
  /** Unique identifier — the key under `response.extensions`. */
  key: string;

  /**
   * Refine the route's extension declaration at registration time, given
   * transport context. Optional; bazaar uses it to stamp the HTTP method.
   */
  enrichDeclaration?: (declaration: unknown, transportContext: unknown) => unknown;

  /**
   * Produce the data to place at `response.extensions[key]` for a 402.
   * Return `undefined` to contribute nothing. May be sync or async.
   */
  enrichPaymentRequiredResponse?: (
    declaration: unknown,
    context: PaymentRequiredContext,
  ) => Promise<unknown> | unknown;

  /**
   * Reserved for settlement-response enrichment. Declared for
   * forward-compatibility with the upstream model; no extension in this
   * SDK implements it yet and the registry does not invoke it.
   */
  enrichSettlementResponse?: (
    declaration: unknown,
    context: unknown,
  ) => Promise<unknown> | unknown;
}
