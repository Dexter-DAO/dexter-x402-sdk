# Bazaar Discovery Extension for `@dexterai/x402` — Design

**Date:** 2026-05-19
**Repo:** `dexter-x402-sdk` (`@dexterai/x402`)
**Status:** design approved, ready for implementation plan

## Problem

The x402 protocol's official discovery mechanism is the **`bazaar` extension**
(`/tmp/x402-spec/specs/extensions/bazaar.md`, formalized in x402 v2). A resource
server attaches an `extensions.bazaar` object to its **402 Payment Required**
response; the object declares how to call the endpoint (input shape + JSON
Schema) and what it returns (output example). A facilitator harvests that block
from the echoed payment payload and catalogs the resource.

The Dexter facilitator already consumes bazaar correctly — it imports
`@x402/extensions/bazaar`, registers the extension, extracts discovery info on
settle, and serves a live `GET /discovery/resources`. The gap is entirely on the
**SDK side**: `@dexterai/x402` (v3.7.8) has no bazaar support. `buildRequirements`
emits a fixed four-field 402 — `{ x402Version, resource, accepts, error }` — and
there is no extension mechanism. The `PaymentRequired.extensions` field exists in
`src/types.ts` but the server-side build path never populates it.

Consequence: every Dexter x402 server running this SDK — x402gle's Trust API,
x402-ads — emits 402s with no `extensions.bazaar`, so they are invisible to the
official discovery layer.

OpenAPI / `/.well-known/x402` based discovery (as used by x402scan / AgentCash)
is **not** part of the x402 standard — the spec never mentions OpenAPI. This
design implements the standard mechanism only: bazaar in the 402.

## Decision

Add a **`ResourceServerExtension` system** to `@dexterai/x402`, mirroring the
upstream `@x402/core` extension model, with the **`bazaar` extension** as its
first consumer. `x402Middleware` gains an optional extension registry and an
optional per-route declaration; when configured, the 402 response carries
`extensions.bazaar`.

The full registry was chosen over a one-off `bazaar` config field so the SDK
gains a real, spec-shaped extension point — future extensions (offer-receipt,
payment-identifier, etc.) plug in the same way.

This is **SDK-only**. Wiring bazaar declarations into the Trust API and x402-ads
is explicit follow-up work (they consume the new capability) and is out of scope
here.

## Scope

In scope, all in `dexter-x402-sdk/src/server/`:

- A generic extension layer: `ResourceServerExtension` interface,
  `PaymentRequiredContext`, and a registry that runs extensions during 402
  construction.
- `x402Middleware` config gains `extensions` (a list of `ResourceServerExtension`)
  and `declarations` (per-route extension declaration data).
- `middleware.ts` 402-build path attaches the collected extension outputs as
  `response.extensions`.
- The `bazaar` extension: `bazaarExtension()` factory + `declareDiscoveryExtension()`
  helper + the info/schema builders.
- Tests for all of the above.

Out of scope:

- Any change to the Trust API or x402-ads servers.
- MCP-tool bazaar discovery — HTTP only for v1 (the SDK serves HTTP x402
  resources; MCP-tool declaration can be added later without an API break).
- `enrichSettlementResponse` / settlement-side extension hooks — the bazaar
  extension only needs `enrichPaymentRequiredResponse`. The interface will
  declare `enrichSettlementResponse?` as optional for forward-compatibility but
  no extension implements it and the registry's settlement path is not built.
- Facilitator changes — the facilitator side already works.

## Architecture

Three layers.

### Layer 1 — generic extension contract (`src/server/extensions/`)

`types.ts` ports the upstream interface (`/tmp/x402-spec/typescript/packages/core/src/types/extensions.ts`):

```typescript
export interface ResourceServerExtension {
  key: string;
  enrichDeclaration?: (declaration: unknown, transportContext: unknown) => unknown;
  enrichPaymentRequiredResponse?: (
    declaration: unknown,
    context: PaymentRequiredContext,
  ) => Promise<unknown> | unknown;
  enrichSettlementResponse?: (
    declaration: unknown,
    context: unknown,
  ) => Promise<unknown> | unknown;
}

export interface PaymentRequiredContext {
  /** The PaymentRequired response being built (resource, accepts, etc.). */
  response: PaymentRequired;
  /** The route's HTTP request, for deriving method / path / params. */
  request: { method: string; path: string; params?: Record<string, string> };
}
```

Note: upstream's `enrichPaymentRequiredResponse` is `async` only; ours accepts
sync-or-async returns (`Promise<unknown> | unknown`) so a pure builder like
bazaar need not be needlessly async — the registry `await`s either.

### Layer 2 — registry (`src/server/extensions/registry.ts`)

```typescript
export async function applyExtensions(
  extensions: ResourceServerExtension[],
  declarations: Record<string, unknown>,
  context: PaymentRequiredContext,
): Promise<Record<string, unknown> | undefined>;
```

For each registered extension with an `enrichPaymentRequiredResponse` hook and a
matching declaration (`declarations[extension.key]`), it calls the hook and
collects the return under `extension.key`. Returns the assembled
`extensions` object, or `undefined` when nothing was produced (so the 402 omits
the key entirely rather than carrying an empty object).

**Failure isolation:** a hook that throws is caught and logged; that extension
is skipped; other extensions and the 402 itself are unaffected. Mirrors the
per-network try/catch already in `middleware.ts`.

### Layer 3 — the bazaar extension (`src/server/extensions/bazaar/`)

- `index.ts` — `bazaarExtension(): ResourceServerExtension` factory. `key: "bazaar"`.
  Its `enrichPaymentRequiredResponse(declaration, context)` returns the
  `{ info, schema, routeTemplate? }` block.
- `declare.ts` — `declareDiscoveryExtension(config)`: pure helper, API-compatible
  with upstream's. Returns `{ bazaar: <declaration> }` for the `declarations` map.
- `build.ts` — `buildInfo()` / `buildSchema()`: turn a declaration into the
  spec-compliant `info` (discriminated by HTTP method) and its validating JSON
  Schema (Draft 2020-12).
- `types.ts` — `DiscoveryExtension`, the query/body config unions, discriminators.

## Server-facing API

```typescript
import {
  x402Middleware,
  bazaarExtension,
  declareDiscoveryExtension,
} from "@dexterai/x402/server";

x402Middleware({
  payTo: { "solana:*": SOL_ADDR, "eip155:*": EVM_ADDR },
  network: [...ACCEPTED_NETWORKS],
  amount: "0.05",
  facilitatorUrl: FACILITATOR_URL,

  // The extension registry — a list of ResourceServerExtension.
  extensions: [bazaarExtension()],

  // Per-route declaration data, keyed by extension key.
  declarations: {
    ...declareDiscoveryExtension({
      method: "GET",
      pathParamsSchema: {
        properties: { address: { type: "string", description: "Wallet address" } },
        required: ["address"],
      },
      output: {
        example: { address: "...", verdict: { wash_score: 12, wash_label: "clean" } },
      },
    }),
  },
});
```

`declareDiscoveryExtension` returns `{ bazaar: {...} }`, so spreading it into
`declarations` keys the declaration under `"bazaar"` — the same key
`bazaarExtension()` reads. For a POST route: `method: "POST"`, `bodyType: "json"`,
`input` (example) + `inputSchema`.

**Design choices:**

1. **`declarations` is a flat per-middleware map, not upstream's route-string
   map.** Upstream couples declaration to a `"GET /path": {...}` route map
   because its `paymentMiddleware` handles many routes. Our `x402Middleware`
   produces one middleware instance per Express route already, so the
   declaration attaches to that instance directly. Same 402 output, better fit
   to our codebase.
2. **`bazaarExtension()` is a factory, not a singleton** — matches upstream and
   leaves room for future config (e.g. a schema-validation toggle) without an
   API break.
3. **Backward compatible** — omit `extensions`/`declarations` and the 402 is
   byte-identical to today. The `extensions` response key appears only when an
   extension produces output.

## The 402 output

Today:
```json
{ "x402Version": 2, "error": "Payment required", "resource": {...}, "accepts": [...] }
```

With a bazaar declaration on a parameterized GET route:
```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": { "url": "...", "description": "...", "mimeType": "application/json" },
  "accepts": [ ... ],
  "extensions": {
    "bazaar": {
      "info": {
        "input": { "type": "http", "method": "GET", "pathParams": { "address": "..." } },
        "output": { "type": "json", "example": { "address": "...", "verdict": {...} } }
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": { "input": { ... }, "output": { ... } },
        "required": ["input"]
      },
      "routeTemplate": "/trust/wallet/:address"
    }
  }
}
```

`info.input` is discriminated by method per the spec:
- `GET` / `HEAD` / `DELETE` → `{ type:"http", method, queryParams?, headers? }`
- `POST` / `PUT` / `PATCH` → `{ type:"http", method, bodyType, body, queryParams?, headers? }`
- parameterized routes add `info.input.pathParams` and a top-level `routeTemplate`.

`routeTemplate` uses `:param` form and is validated against the spec's rules
(`/tmp/x402-spec/specs/extensions/bazaar.md` — "routeTemplate Validation Rules"):
non-empty, starts with `/`, matches `^/[a-zA-Z0-9_/:.\-~%]+$`, no `..`, no `://`,
percent-decoded before the `..`/`://` checks. A template that fails any rule is
dropped (absent `routeTemplate`).

`schema` is a JSON Schema Draft 2020-12 validating `info`, generated from the
declaration's `inputSchema` / `pathParamsSchema`, exactly as the spec's examples
show.

## Error handling

- A bazaar (or any extension) `enrichPaymentRequiredResponse` that throws is
  caught by `applyExtensions`, logged, and skipped — the 402 degrades to
  bare-but-valid (`accepts` + `resource`), never 500s the payment path.
- An invalid `routeTemplate` is dropped, not fatal.
- No `extensions` / `declarations` configured → no `extensions` key on the 402.

## Testing

- `build.test.ts` — `buildInfo` / `buildSchema` for GET (query + path params),
  POST (body), HEAD/DELETE; schema correctness; `routeTemplate` validation
  (each rule: empty, no leading `/`, bad chars, `..`, `://`, percent-encoded
  traversal).
- `registry.test.ts` — `applyExtensions` with zero / one / multiple extensions;
  a throwing extension is isolated (others still produce, no exception escapes);
  `undefined` returned when nothing produced.
- `bazaar.test.ts` — `bazaarExtension()` end-to-end: given a declaration +
  context, produces a spec-valid `{info, schema}`; assert `info` validates
  against its own emitted `schema` (self-consistency — the strongest check).
- A middleware-level test: an `x402Middleware` configured with
  `bazaarExtension()` + a declaration emits a 402 whose `extensions.bazaar` is
  present and schema-valid; and one with no extensions emits a 402 with no
  `extensions` key (backward-compat).
- Reference oracle: upstream's `bazaar.test.ts` at
  `/tmp/x402-spec/typescript/packages/extensions/test/bazaar.test.ts` — use it to
  cross-check expected `info`/`schema` shapes; do not copy it blindly, our config
  surface differs.

## Reference

- Bazaar spec: `/tmp/x402-spec/specs/extensions/bazaar.md`
- Extensions model: `/tmp/x402-spec/docs/extensions/overview.mdx`
- Upstream interface: `/tmp/x402-spec/typescript/packages/core/src/types/extensions.ts`
- Upstream bazaar impl: `/tmp/x402-spec/typescript/packages/extensions/src/bazaar/`
- Upstream server example: `/tmp/x402-spec/examples/typescript/servers/bazaar/index.ts`
- Current SDK 402-build path: `dexter-x402-sdk/src/server/middleware.ts` (the
  402 block ~lines 380-420) and `src/server/x402-server.ts` (`buildRequirements`).
- `PaymentRequired.extensions` already exists: `dexter-x402-sdk/src/types.ts`.
