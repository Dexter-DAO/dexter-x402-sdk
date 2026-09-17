/**
 * routeTemplate validation for the bazaar discovery extension.
 *
 * Rules per the x402 bazaar spec (specs/extensions/bazaar.md —
 * "routeTemplate Validation Rules"). The facilitator uses routeTemplate as
 * a catalog key, so a malformed value must be rejected (the facilitator
 * then falls back to the concrete URL path).
 */

/** Only safe URL-path characters plus `:param` identifiers. */
const ROUTE_TEMPLATE_REGEX = /^\/[a-zA-Z0-9_/:.\-~%]+$/;

/**
 * Returns true when `value` is a well-formed routeTemplate:
 * non-empty, starts with `/`, only safe characters, and — after
 * percent-decoding — contains no `..` (traversal) or `://` (scheme).
 */
export function isValidRouteTemplate(value: string | undefined): value is string {
  if (!value) return false;
  if (!ROUTE_TEMPLATE_REGEX.test(value)) return false;

  // Decode to a fixed point: an encoded percent sign can hide a second layer
  // of traversal or a URL scheme. Bound the work and reject unresolved input.
  let decoded = value;
  for (let depth = 0; depth < 5; depth++) {
    if (decoded.includes('..') || decoded.includes('://')) return false;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return true;
      decoded = next;
    } catch {
      return false;
    }
  }
  return false;
}
