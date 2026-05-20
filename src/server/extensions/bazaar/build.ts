/**
 * Builds the `extensions.bazaar` block for a 402 PaymentRequired response.
 *
 * Produces `{ info, schema, routeTemplate? }` per the x402 bazaar spec
 * (specs/extensions/bazaar.md). `info.input` is discriminated by HTTP
 * method: query methods (GET/HEAD/DELETE) carry `queryParams`; body
 * methods (POST/PUT/PATCH) carry `bodyType` + `body`. `schema` is a JSON
 * Schema (Draft 2020-12) validating `info`.
 */

import { isValidRouteTemplate } from './route-template';
import { isBodyConfig } from './types';
import type {
  DiscoveryConfig,
  DiscoveryExtension,
  QueryMethod,
  BodyMethod,
} from './types';

const QUERY_METHODS: QueryMethod[] = ['GET', 'HEAD', 'DELETE'];
const BODY_METHODS: BodyMethod[] = ['POST', 'PUT', 'PATCH'];

/** Per-request context: concrete path params and the route template. */
export interface BuildContext {
  /** Concrete path-parameter values for this request. */
  pathParams?: Record<string, string>;
  /** The canonical route template, e.g. "/trust/wallet/:address". */
  routeTemplate?: string;
}

/**
 * Build the bazaar discovery extension object from a route's declared
 * config plus per-request context.
 */
export function buildDiscoveryExtension(
  config: DiscoveryConfig,
  context: BuildContext,
): DiscoveryExtension {
  const hasPathParams =
    context.pathParams !== undefined &&
    Object.keys(context.pathParams).length > 0;

  // --- info.input -----------------------------------------------------
  const input: Record<string, unknown> = {
    type: 'http',
    method: config.method,
  };
  if (isBodyConfig(config)) {
    input.bodyType = config.bodyType;
    input.body = config.input ?? {};
  } else if (config.input !== undefined) {
    input.queryParams = config.input;
  }
  if (hasPathParams) {
    input.pathParams = context.pathParams;
  }

  // --- info.output ----------------------------------------------------
  const output =
    config.output?.example !== undefined
      ? { type: 'json', example: config.output.example }
      : undefined;

  // --- schema ---------------------------------------------------------
  const methodEnum = isBodyConfig(config) ? BODY_METHODS : QUERY_METHODS;
  const inputSchemaProps: Record<string, unknown> = {
    type: { type: 'string', const: 'http' },
    method: { type: 'string', enum: methodEnum },
  };
  if (isBodyConfig(config)) {
    inputSchemaProps.bodyType = {
      type: 'string',
      enum: ['json', 'form-data', 'text'],
    };
    inputSchemaProps.body = { type: 'object', ...(config.inputSchema ?? {}) };
  } else if (config.inputSchema) {
    inputSchemaProps.queryParams = {
      type: 'object',
      ...config.inputSchema,
    };
  }
  if (config.pathParamsSchema) {
    inputSchemaProps.pathParams = {
      type: 'object',
      ...config.pathParamsSchema,
    };
  }

  const schemaProperties: Record<string, unknown> = {
    input: {
      type: 'object',
      properties: inputSchemaProps,
      required: isBodyConfig(config)
        ? ['type', 'method', 'bodyType', 'body']
        : ['type', 'method'],
      additionalProperties: false,
    },
  };
  if (output) {
    schemaProperties.output = {
      type: 'object',
      properties: {
        type: { type: 'string' },
        example: { type: 'object', ...(config.output?.schema ?? {}) },
      },
      required: ['type'],
    };
  }

  const schema: Record<string, unknown> = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: schemaProperties,
    required: ['input'],
  };

  // --- assemble -------------------------------------------------------
  const extension: DiscoveryExtension = {
    info: { input, ...(output ? { output } : {}) },
    schema,
  };
  if (isValidRouteTemplate(context.routeTemplate)) {
    extension.routeTemplate = context.routeTemplate;
  }
  return extension;
}
