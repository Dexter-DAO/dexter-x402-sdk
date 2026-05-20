/**
 * Type definitions for the bazaar discovery extension.
 *
 * Shapes follow the x402 bazaar spec (specs/extensions/bazaar.md). HTTP
 * only — MCP-tool discovery is intentionally out of scope for v1 and can
 * be added as a discriminated branch later without an API break.
 */

/** HTTP methods that carry input as query parameters. */
export type QueryMethod = 'GET' | 'HEAD' | 'DELETE';
/** HTTP methods that carry input as a request body. */
export type BodyMethod = 'POST' | 'PUT' | 'PATCH';

/** A JSON-Schema-ish object describing a parameter map. */
export interface ParamSchema {
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Output declaration: an example response and optional schema. */
export interface OutputDeclaration {
  example?: unknown;
  schema?: Record<string, unknown>;
}

/** Declaration config for a query-method (GET/HEAD/DELETE) route. */
export interface QueryDiscoveryConfig {
  method: QueryMethod;
  /** Example query-parameter values. */
  input?: Record<string, unknown>;
  /** JSON Schema for the query parameters. */
  inputSchema?: ParamSchema;
  /** JSON Schema for path parameters (e.g. `:address`). */
  pathParamsSchema?: ParamSchema;
  output?: OutputDeclaration;
}

/** Declaration config for a body-method (POST/PUT/PATCH) route. */
export interface BodyDiscoveryConfig {
  method: BodyMethod;
  bodyType: 'json' | 'form-data' | 'text';
  /** Example request body. */
  input?: Record<string, unknown>;
  /** JSON Schema for the request body. */
  inputSchema?: ParamSchema;
  /** JSON Schema for path parameters. */
  pathParamsSchema?: ParamSchema;
  output?: OutputDeclaration;
}

/** Either kind of HTTP discovery config. */
export type DiscoveryConfig = QueryDiscoveryConfig | BodyDiscoveryConfig;

/** The `extensions.bazaar` block emitted on a 402. */
export interface DiscoveryExtension {
  info: {
    input: Record<string, unknown>;
    output?: { type: string; format?: string; example?: unknown };
  };
  schema: Record<string, unknown>;
  routeTemplate?: string;
}

/** Type guard: is this a body-method config? */
export function isBodyConfig(c: DiscoveryConfig): c is BodyDiscoveryConfig {
  return c.method === 'POST' || c.method === 'PUT' || c.method === 'PATCH';
}
