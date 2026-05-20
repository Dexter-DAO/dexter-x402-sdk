# Bazaar Discovery Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `ResourceServerExtension` system to `@dexterai/x402` with a `bazaar` discovery extension, so an `x402Middleware`-built 402 response can carry `extensions.bazaar` — making Dexter x402 HTTP servers discoverable via the official x402 bazaar standard.

**Architecture:** Three layers. (1) A generic extension contract (`ResourceServerExtension` interface + `PaymentRequiredContext`) ported from upstream `@x402/core`. (2) A registry that runs each registered extension's `enrichPaymentRequiredResponse` hook during 402 construction and collects the outputs. (3) The `bazaar` extension itself — a pure builder turning a route's declared discovery config into the spec-compliant `{info, schema, routeTemplate?}` block. `x402Middleware` gains optional `extensions` + `declarations` config; when present, the 402 carries `extensions`. Fully backward compatible.

**Tech Stack:** TypeScript, ESM, strict mode. SDK repo `dexter-x402-sdk`, published as `@dexterai/x402`. Test runner: vitest (already configured). Build: tsup (`npm run build`).

---

## Spec

`dexter-x402-sdk/docs/superpowers/specs/2026-05-19-bazaar-discovery-extension-design.md`. Read it first.

## Working directory

All paths relative to `/home/branchmanager/websites/dexter-x402-sdk`. Run all `npm`/`npx` commands from there.

## Reference material (read-only, in `/tmp/x402-spec`)

- Bazaar spec: `/tmp/x402-spec/specs/extensions/bazaar.md`
- Upstream interface: `/tmp/x402-spec/typescript/packages/core/src/types/extensions.ts`
- Upstream bazaar builders: `/tmp/x402-spec/typescript/packages/extensions/src/bazaar/http/resourceService.ts`
- Upstream `isValidRouteTemplate`: `/tmp/x402-spec/typescript/packages/extensions/src/bazaar/facilitator.ts` (~line 47)
- Upstream bazaar test (oracle): `/tmp/x402-spec/typescript/packages/extensions/test/bazaar.test.ts`

## File structure

| File | Responsibility | Action |
|------|---------------|--------|
| `src/server/extensions/types.ts` | `ResourceServerExtension`, `PaymentRequiredContext` | Create |
| `src/server/extensions/registry.ts` | `applyExtensions()` — run hooks, collect outputs, isolate failures | Create |
| `src/server/extensions/bazaar/types.ts` | bazaar config + extension types | Create |
| `src/server/extensions/bazaar/route-template.ts` | `isValidRouteTemplate()` | Create |
| `src/server/extensions/bazaar/build.ts` | `buildDiscoveryExtension()` — config → `{info,schema}` | Create |
| `src/server/extensions/bazaar/declare.ts` | `declareDiscoveryExtension()` helper | Create |
| `src/server/extensions/bazaar/index.ts` | `bazaarExtension()` factory | Create |
| `src/server/middleware.ts` | add `extensions`/`declarations` config; wire registry into 402 | Modify |
| `src/server/index.ts` | export the new public symbols | Modify |
| `src/server/__tests__/route-template.test.ts` | `isValidRouteTemplate` tests | Create |
| `src/server/__tests__/bazaar-build.test.ts` | `buildDiscoveryExtension` tests | Create |
| `src/server/__tests__/extension-registry.test.ts` | `applyExtensions` tests | Create |
| `src/server/__tests__/bazaar-middleware.test.ts` | end-to-end 402-carries-bazaar test | Create |

---

## Task 1: Generic extension contract — `types.ts`

**Files:**
- Create: `src/server/extensions/types.ts`

- [ ] **Step 1: Create the extension types file**

Create `src/server/extensions/types.ts` with EXACTLY:

```typescript
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "extensions/types" || echo "extensions/types clean"`
Expected: `extensions/types clean`. (`PaymentRequired` is exported from `src/types.ts` — confirmed.)

- [ ] **Step 3: Commit**

```bash
git add src/server/extensions/types.ts
git commit -m "feat(server): add ResourceServerExtension contract"
```

---

## Task 2: Extension registry — `applyExtensions()`

**Files:**
- Create: `src/server/extensions/registry.ts`
- Test: `src/server/__tests__/extension-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/__tests__/extension-registry.test.ts` with EXACTLY:

```typescript
import { describe, it, expect } from 'vitest';
import { applyExtensions } from '../extensions/registry';
import type { ResourceServerExtension, PaymentRequiredContext } from '../extensions/types';
import type { PaymentRequired } from '../../types';

const ctx: PaymentRequiredContext = {
  response: { x402Version: 2, accepts: [] } as unknown as PaymentRequired,
  request: { method: 'GET', path: '/x' },
};

describe('applyExtensions', () => {
  it('returns undefined when there are no extensions', async () => {
    expect(await applyExtensions([], {}, ctx)).toBeUndefined();
  });

  it('returns undefined when no extension produces output', async () => {
    const ext: ResourceServerExtension = { key: 'noop' };
    expect(await applyExtensions([ext], { noop: {} }, ctx)).toBeUndefined();
  });

  it('collects one extension output under its key', async () => {
    const ext: ResourceServerExtension = {
      key: 'demo',
      enrichPaymentRequiredResponse: () => ({ hello: 'world' }),
    };
    expect(await applyExtensions([ext], { demo: {} }, ctx)).toEqual({
      demo: { hello: 'world' },
    });
  });

  it('collects multiple extensions, each under its own key', async () => {
    const a: ResourceServerExtension = {
      key: 'a',
      enrichPaymentRequiredResponse: () => ({ v: 1 }),
    };
    const b: ResourceServerExtension = {
      key: 'b',
      enrichPaymentRequiredResponse: async () => ({ v: 2 }),
    };
    expect(await applyExtensions([a, b], { a: {}, b: {} }, ctx)).toEqual({
      a: { v: 1 },
      b: { v: 2 },
    });
  });

  it('skips an extension with no matching declaration', async () => {
    const ext: ResourceServerExtension = {
      key: 'demo',
      enrichPaymentRequiredResponse: () => ({ hello: 'world' }),
    };
    expect(await applyExtensions([ext], {}, ctx)).toBeUndefined();
  });

  it('omits an extension whose hook returns undefined', async () => {
    const a: ResourceServerExtension = {
      key: 'a',
      enrichPaymentRequiredResponse: () => undefined,
    };
    const b: ResourceServerExtension = {
      key: 'b',
      enrichPaymentRequiredResponse: () => ({ v: 2 }),
    };
    expect(await applyExtensions([a, b], { a: {}, b: {} }, ctx)).toEqual({
      b: { v: 2 },
    });
  });

  it('isolates a throwing extension — others still produce, no throw', async () => {
    const bad: ResourceServerExtension = {
      key: 'bad',
      enrichPaymentRequiredResponse: () => {
        throw new Error('boom');
      },
    };
    const good: ResourceServerExtension = {
      key: 'good',
      enrichPaymentRequiredResponse: () => ({ ok: true }),
    };
    const out = await applyExtensions([bad, good], { bad: {}, good: {} }, ctx);
    expect(out).toEqual({ good: { ok: true } });
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run src/server/__tests__/extension-registry.test.ts`
Expected: FAIL — `../extensions/registry` does not exist.

- [ ] **Step 3: Create `registry.ts`**

Create `src/server/extensions/registry.ts` with EXACTLY:

```typescript
/**
 * Extension registry — runs resource-server extensions while a 402
 * PaymentRequired response is being built and collects their outputs.
 */

import type { ResourceServerExtension, PaymentRequiredContext } from './types';

/**
 * Run each registered extension's `enrichPaymentRequiredResponse` hook and
 * collect the results into an object keyed by extension `key`.
 *
 * - An extension with no `enrichPaymentRequiredResponse` hook is skipped.
 * - An extension with no entry in `declarations` is skipped (nothing to do).
 * - An extension whose hook returns `undefined` contributes no key.
 * - An extension whose hook throws is caught, logged, and skipped — a
 *   broken extension degrades the 402 to bare-but-valid, never throws.
 *
 * @returns the assembled `extensions` object, or `undefined` when nothing
 *   was produced (so the caller omits the `extensions` key entirely).
 */
export async function applyExtensions(
  extensions: ResourceServerExtension[],
  declarations: Record<string, unknown>,
  context: PaymentRequiredContext,
): Promise<Record<string, unknown> | undefined> {
  const collected: Record<string, unknown> = {};

  for (const ext of extensions) {
    if (!ext.enrichPaymentRequiredResponse) continue;
    if (!(ext.key in declarations)) continue;
    try {
      const result = await ext.enrichPaymentRequiredResponse(
        declarations[ext.key],
        context,
      );
      if (result !== undefined) {
        collected[ext.key] = result;
      }
    } catch (e) {
      console.warn(`[x402:extensions] extension "${ext.key}" failed:`, e);
    }
  }

  return Object.keys(collected).length > 0 ? collected : undefined;
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run src/server/__tests__/extension-registry.test.ts`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/extensions/registry.ts src/server/__tests__/extension-registry.test.ts
git commit -m "feat(server): add extension registry with failure isolation"
```

---

## Task 3: `routeTemplate` validator

**Files:**
- Create: `src/server/extensions/bazaar/route-template.ts`
- Test: `src/server/__tests__/route-template.test.ts`

The bazaar spec's `routeTemplate` validation rules (`/tmp/x402-spec/specs/extensions/bazaar.md`): non-empty string, starts with `/`, matches `^/[a-zA-Z0-9_/:.\-~%]+$`, no `..`, no `://`, percent-decoded before the `..`/`://` checks.

- [ ] **Step 1: Write the failing test**

Create `src/server/__tests__/route-template.test.ts` with EXACTLY:

```typescript
import { describe, it, expect } from 'vitest';
import { isValidRouteTemplate } from '../extensions/bazaar/route-template';

describe('isValidRouteTemplate', () => {
  it('accepts a valid static template', () => {
    expect(isValidRouteTemplate('/trust/wallet')).toBe(true);
  });

  it('accepts a valid parameterized template', () => {
    expect(isValidRouteTemplate('/trust/wallet/:address')).toBe(true);
    expect(isValidRouteTemplate('/weather/:country/:city')).toBe(true);
  });

  it('rejects undefined and empty string', () => {
    expect(isValidRouteTemplate(undefined)).toBe(false);
    expect(isValidRouteTemplate('')).toBe(false);
  });

  it('rejects a template not starting with /', () => {
    expect(isValidRouteTemplate('trust/wallet')).toBe(false);
  });

  it('rejects path traversal', () => {
    expect(isValidRouteTemplate('/trust/../admin')).toBe(false);
  });

  it('rejects percent-encoded path traversal', () => {
    expect(isValidRouteTemplate('/trust/%2e%2e/admin')).toBe(false);
  });

  it('rejects a URL scheme injection', () => {
    expect(isValidRouteTemplate('/x/http://evil.com')).toBe(false);
  });

  it('rejects disallowed characters', () => {
    expect(isValidRouteTemplate('/trust/wallet?q=1')).toBe(false);
    expect(isValidRouteTemplate('/trust/wallet $')).toBe(false);
  });

  it('rejects a value that fails to percent-decode', () => {
    expect(isValidRouteTemplate('/trust/%ZZ')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run src/server/__tests__/route-template.test.ts`
Expected: FAIL — `../extensions/bazaar/route-template` does not exist.

- [ ] **Step 3: Create `route-template.ts`**

Create `src/server/extensions/bazaar/route-template.ts` with EXACTLY:

```typescript
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

  // Decode percent-encoding before the traversal/scheme checks so that
  // e.g. %2e%2e is caught.
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (decoded.includes('..')) return false;
  if (decoded.includes('://')) return false;
  return true;
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run src/server/__tests__/route-template.test.ts`
Expected: PASS — all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/extensions/bazaar/route-template.ts src/server/__tests__/route-template.test.ts
git commit -m "feat(bazaar): add routeTemplate validator"
```

---

## Task 4: Bazaar types

**Files:**
- Create: `src/server/extensions/bazaar/types.ts`

- [ ] **Step 1: Create `types.ts`**

Create `src/server/extensions/bazaar/types.ts` with EXACTLY:

```typescript
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "bazaar/types" || echo "bazaar/types clean"`
Expected: `bazaar/types clean`.

- [ ] **Step 3: Commit**

```bash
git add src/server/extensions/bazaar/types.ts
git commit -m "feat(bazaar): add discovery config + extension types"
```

---

## Task 5: Bazaar builder — `buildDiscoveryExtension()`

Turns a `DiscoveryConfig` (+ optional concrete path params + route template) into the spec-compliant `{info, schema, routeTemplate?}` block. Shapes mirror upstream's `createQueryDiscoveryExtension` / `createBodyDiscoveryExtension`.

**Files:**
- Create: `src/server/extensions/bazaar/build.ts`
- Test: `src/server/__tests__/bazaar-build.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/__tests__/bazaar-build.test.ts` with EXACTLY:

```typescript
import { describe, it, expect } from 'vitest';
import { buildDiscoveryExtension } from '../extensions/bazaar/build';

describe('buildDiscoveryExtension — GET / query methods', () => {
  it('builds info + schema for a GET with path params', () => {
    const ext = buildDiscoveryExtension(
      {
        method: 'GET',
        pathParamsSchema: {
          properties: { address: { type: 'string' } },
          required: ['address'],
        },
        output: { example: { ok: true } },
      },
      { pathParams: { address: 'X4o2' }, routeTemplate: '/trust/wallet/:address' },
    );
    expect(ext.info.input.type).toBe('http');
    expect(ext.info.input.method).toBe('GET');
    expect(ext.info.input.pathParams).toEqual({ address: 'X4o2' });
    expect(ext.info.output).toEqual({ type: 'json', example: { ok: true } });
    expect(ext.routeTemplate).toBe('/trust/wallet/:address');
    expect(ext.schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('builds info for a GET with query params', () => {
    const ext = buildDiscoveryExtension(
      {
        method: 'GET',
        input: { verdict: 'wash' },
        inputSchema: { properties: { verdict: { type: 'string' } } },
      },
      {},
    );
    expect(ext.info.input.queryParams).toEqual({ verdict: 'wash' });
    expect(ext.routeTemplate).toBeUndefined();
  });

  it('omits routeTemplate when it is invalid', () => {
    const ext = buildDiscoveryExtension(
      { method: 'GET' },
      { routeTemplate: '/trust/../admin' },
    );
    expect(ext.routeTemplate).toBeUndefined();
  });

  it('omits output when no example is given', () => {
    const ext = buildDiscoveryExtension({ method: 'GET' }, {});
    expect(ext.info.output).toBeUndefined();
  });
});

describe('buildDiscoveryExtension — POST / body methods', () => {
  it('builds info + schema for a POST with a json body', () => {
    const ext = buildDiscoveryExtension(
      {
        method: 'POST',
        bodyType: 'json',
        input: { addresses: ['a', 'b'] },
        inputSchema: {
          properties: { addresses: { type: 'array', items: { type: 'string' } } },
          required: ['addresses'],
        },
        output: { example: { count: 2 } },
      },
      {},
    );
    expect(ext.info.input.type).toBe('http');
    expect(ext.info.input.method).toBe('POST');
    expect(ext.info.input.bodyType).toBe('json');
    expect(ext.info.input.body).toEqual({ addresses: ['a', 'b'] });
    expect(ext.info.output).toEqual({ type: 'json', example: { count: 2 } });
  });
});

describe('buildDiscoveryExtension — schema self-consistency', () => {
  it('produces a schema with input required', () => {
    const ext = buildDiscoveryExtension({ method: 'GET' }, {});
    expect((ext.schema as { required: string[] }).required).toContain('input');
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run src/server/__tests__/bazaar-build.test.ts`
Expected: FAIL — `../extensions/bazaar/build` does not exist.

- [ ] **Step 3: Create `build.ts`**

Create `src/server/extensions/bazaar/build.ts` with EXACTLY:

```typescript
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
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run src/server/__tests__/bazaar-build.test.ts`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/extensions/bazaar/build.ts src/server/__tests__/bazaar-build.test.ts
git commit -m "feat(bazaar): add discovery extension builder"
```

---

## Task 6: `declareDiscoveryExtension()` + `bazaarExtension()`

The two server-facing pieces: the declaration helper and the extension factory.

**Files:**
- Create: `src/server/extensions/bazaar/declare.ts`
- Create: `src/server/extensions/bazaar/index.ts`
- Test: extend `src/server/__tests__/bazaar-build.test.ts`

- [ ] **Step 1: Write the failing test (append to bazaar-build.test.ts)**

Append to `src/server/__tests__/bazaar-build.test.ts`:

```typescript
import { declareDiscoveryExtension } from '../extensions/bazaar/declare';
import { bazaarExtension } from '../extensions/bazaar/index';
import type { PaymentRequiredContext } from '../extensions/types';
import type { PaymentRequired } from '../../types';

describe('declareDiscoveryExtension', () => {
  it('wraps a config under the "bazaar" key', () => {
    const decl = declareDiscoveryExtension({ method: 'GET' });
    expect(Object.keys(decl)).toEqual(['bazaar']);
    expect((decl.bazaar as { method: string }).method).toBe('GET');
  });
});

describe('bazaarExtension', () => {
  const baseCtx: PaymentRequiredContext = {
    response: { x402Version: 2, accepts: [] } as unknown as PaymentRequired,
    request: { method: 'GET', path: '/trust/wallet/:address', params: { address: 'X4o2' } },
  };

  it('has key "bazaar"', () => {
    expect(bazaarExtension().key).toBe('bazaar');
  });

  it('produces a spec-shaped block from a declaration + context', async () => {
    const ext = bazaarExtension();
    const decl = declareDiscoveryExtension({
      method: 'GET',
      pathParamsSchema: { properties: { address: { type: 'string' } }, required: ['address'] },
      output: { example: { ok: true } },
    });
    const out = (await ext.enrichPaymentRequiredResponse!(decl.bazaar, baseCtx)) as {
      info: { input: Record<string, unknown> };
      routeTemplate?: string;
    };
    expect(out.info.input.method).toBe('GET');
    expect(out.info.input.pathParams).toEqual({ address: 'X4o2' });
    expect(out.routeTemplate).toBe('/trust/wallet/:address');
  });

  it('uses the request method when the declaration omits it', async () => {
    const ext = bazaarExtension();
    // declaration with no method — the extension stamps it from the request
    const out = (await ext.enrichPaymentRequiredResponse!(
      { output: { example: { ok: 1 } } },
      { ...baseCtx, request: { method: 'POST', path: '/trust/batch' } },
    )) as { info: { input: Record<string, unknown> } };
    expect(out.info.input.method).toBe('POST');
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run src/server/__tests__/bazaar-build.test.ts`
Expected: FAIL — `../extensions/bazaar/declare` and `../extensions/bazaar/index` do not exist.

- [ ] **Step 3: Create `declare.ts`**

Create `src/server/extensions/bazaar/declare.ts` with EXACTLY:

```typescript
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
```

- [ ] **Step 4: Create `index.ts`**

Create `src/server/extensions/bazaar/index.ts` with EXACTLY:

```typescript
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
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `npx vitest run src/server/__tests__/bazaar-build.test.ts`
Expected: PASS — all tests (the 7 from Task 5 plus the 4 new).

- [ ] **Step 6: Commit**

```bash
git add src/server/extensions/bazaar/declare.ts src/server/extensions/bazaar/index.ts src/server/__tests__/bazaar-build.test.ts
git commit -m "feat(bazaar): add declareDiscoveryExtension helper + bazaarExtension factory"
```

---

## Task 7: Wire the registry into `x402Middleware`

Add `extensions` + `declarations` to the config, and call `applyExtensions` in the 402-build path so the response carries `extensions`.

**Files:**
- Modify: `src/server/middleware.ts`

Read the full current `src/server/middleware.ts` first. Key spots: the `X402MiddlewareConfig` interface (~line 41), the config destructure (~line 302), and the no-payment 402 block (~lines 366-420).

- [ ] **Step 1: Add imports**

At the top of `src/server/middleware.ts`, with the other imports, add:

```typescript
import { applyExtensions } from './extensions/registry';
import type { ResourceServerExtension } from './extensions/types';
```

- [ ] **Step 2: Add config fields to `X402MiddlewareConfig`**

In the `X402MiddlewareConfig` interface, after the `mimeType` field (find `mimeType` in the interface), add:

```typescript
  /**
   * Resource-server extensions to run when building a 402 response.
   * Each extension's output is placed under `extensions[extension.key]`.
   * Pair with `declarations`. Example: `[bazaarExtension()]`.
   */
  extensions?: ResourceServerExtension[];

  /**
   * Per-route extension declaration data, keyed by extension key.
   * Build it with the extension's declare helper, e.g.
   * `declarations: { ...declareDiscoveryExtension({ method: 'GET', ... }) }`.
   */
  declarations?: Record<string, unknown>;
```

- [ ] **Step 3: Destructure the new fields**

In the config destructure block (`const { payTo, amount, ... } = config;`), add `extensions` and `declarations`:

```typescript
  const {
    payTo,
    amount,
    asset,
    description,
    resourceUrl: staticResourceUrl,
    mimeType,
    timeoutSeconds,
    verbose = false,
    getResourceUrl,
    getAmount,
    getDescription,
    extensions: configuredExtensions,
    declarations: configuredDeclarations,
  } = config;
```

- [ ] **Step 4: Call the registry in the 402-build path**

In the no-payment 402 block, the code currently is:

```typescript
        requirements = { ...requirements, accepts: allAccepts };
        const encoded = primaryServer.encodeRequirements(requirements);

        res.setHeader('PAYMENT-REQUIRED', encoded);
        res.status(402).json({
          error: 'Payment required',
          accepts: requirements.accepts,
          resource: requirements.resource,
        });
        return;
```

Replace that block with:

```typescript
        requirements = { ...requirements, accepts: allAccepts };

        // Run resource-server extensions (e.g. bazaar discovery). Their
        // collected output is attached as `extensions` on BOTH the encoded
        // PAYMENT-REQUIRED header and the JSON body, so a facilitator and a
        // client see the same thing. A failing extension is isolated by
        // applyExtensions — the 402 still goes out, just without that key.
        if (configuredExtensions && configuredExtensions.length > 0) {
          const ext = await applyExtensions(
            configuredExtensions,
            configuredDeclarations ?? {},
            {
              response: requirements,
              request: {
                method: req.method,
                path: (req.route?.path as string | undefined) ?? req.path,
                params: req.params as Record<string, string> | undefined,
              },
            },
          );
          if (ext) {
            requirements = { ...requirements, extensions: ext };
          }
        }

        const encoded = primaryServer.encodeRequirements(requirements);

        res.setHeader('PAYMENT-REQUIRED', encoded);
        res.status(402).json({
          error: 'Payment required',
          accepts: requirements.accepts,
          resource: requirements.resource,
          ...(requirements.extensions
            ? { extensions: requirements.extensions }
            : {}),
        });
        return;
```

NOTE: `req.route?.path` gives the Express route template (e.g. `/trust/wallet/:address`); `req.params` gives the concrete values. Both are standard Express request fields. `requirements.extensions` is a valid field — `PaymentRequired.extensions?: Record<string, unknown>` already exists in `src/types.ts`.

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit 2>&1 | grep "middleware.ts" || echo "middleware clean"`
Expected: `middleware clean`.

Run: `npm run build 2>&1 | tail -3`
Expected: build succeeds.

- [ ] **Step 6: Run the full test suite — no regressions**

Run: `npx vitest run 2>&1 | tail -6`
Expected: all tests pass (the existing ~244 + the new ones from Tasks 2/3/5/6).

- [ ] **Step 7: Commit**

```bash
git add src/server/middleware.ts
git commit -m "feat(server): run resource-server extensions in the 402 build path"
```

---

## Task 8: Export the public API + end-to-end test

**Files:**
- Modify: `src/server/index.ts`
- Test: `src/server/__tests__/bazaar-middleware.test.ts`

- [ ] **Step 1: Export the new symbols**

In `src/server/index.ts`, after the `x402Middleware` export line (`export { x402Middleware } from './middleware';`), add:

```typescript
export { bazaarExtension } from './extensions/bazaar/index';
export { declareDiscoveryExtension } from './extensions/bazaar/declare';
export type {
  ResourceServerExtension,
  PaymentRequiredContext,
} from './extensions/types';
export type {
  DiscoveryConfig,
  QueryDiscoveryConfig,
  BodyDiscoveryConfig,
  DiscoveryExtension,
} from './extensions/bazaar/types';
export type { DeclareDiscoveryConfig } from './extensions/bazaar/declare';
```

- [ ] **Step 2: Write the end-to-end test**

Create `src/server/__tests__/bazaar-middleware.test.ts` with EXACTLY:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { x402Middleware } from '../middleware';
import { bazaarExtension } from '../extensions/bazaar/index';
import { declareDiscoveryExtension } from '../extensions/bazaar/declare';

// Mock the facilitator: the middleware's 402 path resolves /supported via
// fetch. Return a minimal supported payload so the test runs offline.
const MOCK_SUPPORTED = {
  kinds: [
    {
      x402Version: 2,
      scheme: 'exact',
      network: 'eip155:8453',
      extra: { feePayer: '0xFee', decimals: 6, name: 'USD Coin', version: '2' },
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => MOCK_SUPPORTED,
    })),
  );
});

/** Minimal Express-like req/res doubles for driving the middleware. */
function makeReqRes(routePath: string, params: Record<string, string>) {
  const req = {
    method: 'GET',
    headers: {},
    path: routePath,
    route: { path: routePath },
    params,
    protocol: 'https',
    originalUrl: routePath,
    get: () => 'api.example.com',
  } as unknown as Parameters<ReturnType<typeof x402Middleware>>[0];

  let statusCode = 0;
  let body: unknown;
  const res = {
    statusCode: 0,
    setHeader: () => {},
    status(c: number) {
      statusCode = c;
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      body = b;
      return this;
    },
  } as unknown as Parameters<ReturnType<typeof x402Middleware>>[1];

  return { req, res, getStatus: () => statusCode, getBody: () => body };
}

describe('x402Middleware + bazaar extension', () => {
  it('emits a 402 carrying extensions.bazaar when configured', async () => {
    const mw = x402Middleware({
      payTo: '0x402Feee072D655B85e08f1751AF9ddbCd249521f',
      network: 'eip155:8453',
      amount: '0.05',
      facilitatorUrl: 'https://facilitator.test',
      extensions: [bazaarExtension()],
      declarations: {
        ...declareDiscoveryExtension({
          method: 'GET',
          pathParamsSchema: {
            properties: { address: { type: 'string' } },
            required: ['address'],
          },
          output: { example: { address: 'X4o2', verdict: { wash_score: 0 } } },
        }),
      },
    });

    const { req, res, getStatus, getBody } = makeReqRes('/trust/wallet/:address', {
      address: 'X4o2',
    });
    await mw(req, res, () => {});

    expect(getStatus()).toBe(402);
    const body = getBody() as {
      accepts: unknown[];
      extensions?: { bazaar?: { info: { input: Record<string, unknown> }; schema: unknown; routeTemplate?: string } };
    };
    expect(body.accepts.length).toBeGreaterThan(0);
    expect(body.extensions).toBeDefined();
    expect(body.extensions!.bazaar).toBeDefined();
    expect(body.extensions!.bazaar!.info.input.method).toBe('GET');
    expect(body.extensions!.bazaar!.info.input.pathParams).toEqual({ address: 'X4o2' });
    expect(body.extensions!.bazaar!.routeTemplate).toBe('/trust/wallet/:address');
    expect(body.extensions!.bazaar!.schema).toBeDefined();
  });

  it('emits a 402 with NO extensions key when none configured (backward-compat)', async () => {
    const mw = x402Middleware({
      payTo: '0x402Feee072D655B85e08f1751AF9ddbCd249521f',
      network: 'eip155:8453',
      amount: '0.05',
      facilitatorUrl: 'https://facilitator.test',
    });

    const { req, res, getStatus, getBody } = makeReqRes('/trust/wallet/:address', {
      address: 'X4o2',
    });
    await mw(req, res, () => {});

    expect(getStatus()).toBe(402);
    expect((getBody() as Record<string, unknown>).extensions).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the end-to-end test**

Run: `npx vitest run src/server/__tests__/bazaar-middleware.test.ts`
Expected: PASS — both tests.

If the test fails because the mock `fetch` shape does not match what the facilitator client expects, inspect `src/server/__tests__/multichain-decimals.test.ts` (it mocks the same `/supported` path successfully) and align the `MOCK_SUPPORTED` shape and the network choice to whatever that test uses. Do not weaken the assertions — fix the mock.

- [ ] **Step 4: Typecheck + full suite + build**

Run: `npx tsc --noEmit 2>&1 | head -5`
Expected: no errors.

Run: `npx vitest run 2>&1 | tail -6`
Expected: all tests pass.

Run: `npm run build 2>&1 | tail -3`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/server/__tests__/bazaar-middleware.test.ts
git commit -m "feat(server): export bazaar extension API + end-to-end 402 test"
```

---

## Task 9: Cross-check against the upstream spec oracle

**Files:** none modified — this task verifies shape-correctness against the official spec.

- [ ] **Step 1: Compare emitted `info`/`schema` against the spec examples**

Read `/tmp/x402-spec/specs/extensions/bazaar.md` — the "Example: GET Endpoint" and "Example: POST Endpoint" JSON blocks. Compare field-by-field against what `buildDiscoveryExtension` produces (use the `bazaar-build.test.ts` assertions as the reference for our output shape):

- `info.input.type` === `"http"` ✓ must match
- `info.input.method` present ✓
- GET → `queryParams` (not `body`); POST → `bodyType` + `body` ✓
- `info.output` === `{ type: "json", example: ... }` ✓
- `schema.$schema` === `"https://json-schema.org/draft/2020-12/schema"` ✓
- `schema.properties.input.required` — GET: `["type","method"]`; POST: `["type","method","bodyType","body"]` ✓
- `schema.required` === `["input"]` ✓
- `routeTemplate` uses `:param` syntax, top-level ✓

Write down any field where our output diverges from the spec example.

- [ ] **Step 2: Compare against the upstream test oracle**

Read `/tmp/x402-spec/typescript/packages/extensions/test/bazaar.test.ts`. It asserts the exact `info`/`schema` shapes upstream produces. Confirm our `buildDiscoveryExtension` output is structurally equivalent for the GET-with-path-params and POST-with-body cases. Differences in our *config surface* (we accept `DiscoveryConfig`, upstream accepts its own config types) are fine and expected — only the *emitted `info`/`schema`* must match the spec.

- [ ] **Step 3: If a divergence was found, fix it**

If Steps 1-2 found any field where our emitted `info` or `schema` does not match the spec, fix `build.ts`, update the affected test in `bazaar-build.test.ts` to assert the corrected shape, re-run `npx vitest run src/server/__tests__/bazaar-build.test.ts`, and commit:

```bash
git add src/server/extensions/bazaar/build.ts src/server/__tests__/bazaar-build.test.ts
git commit -m "fix(bazaar): align emitted info/schema with the x402 spec"
```

If no divergence was found, there is nothing to commit — the build is spec-correct.

- [ ] **Step 4: Report**

State plainly: does our emitted `extensions.bazaar` match the official x402 bazaar spec, field for field? If a fix was needed, what was it.

---

## Notes for the implementer

- **Backward compatibility is a hard requirement.** A `x402Middleware` call with no `extensions`/`declarations` MUST emit a 402 byte-identical to today. Task 8's second test pins this — do not let it regress.
- **The `extensions` object goes into `requirements` BEFORE `encodeRequirements`.** The PAYMENT-REQUIRED header is the encoded `requirements`; the JSON body is built separately. Both must carry `extensions` — Task 7 Step 4 does both. Do not put it only in the JSON body.
- **Failure isolation, not failure propagation.** A throwing extension must never 500 the payment path — `applyExtensions` catches and logs. This mirrors the per-network try/catch already in `middleware.ts`.
- **HTTP only.** No MCP-tool discovery (`input.type: "mcp"`). It is a deliberate scope cut — a clean discriminated-union add-on later, not this plan.
- **Do not touch the Trust API or x402-ads.** This plan gives the SDK the capability. Wiring bazaar declarations into those servers is separate follow-up work.
- The `PaymentRequired.extensions` field already exists in `src/types.ts:158` — Task 7 populates it, does not define it.
- After all tasks: the SDK has the bazaar capability but is NOT yet published. Publishing (version bump + `npm publish`) and consumer wiring are out of scope for this plan — flag them as the next steps.
