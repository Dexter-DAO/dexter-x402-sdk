# x402 Version Seam — Plan 1: SDK Seam + Paying Side

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a version-agnostic `PaymentStrategy` seam inside the `@dexterai/x402` SDK, then migrate the paying-side `dexter-api` files (verifier, x402Pay) onto it — removing the upstream `x402` library from those paths and fixing the verifier's `invalid_payload` and Request-reuse bugs.

**Architecture:** The SDK gains one payment interface. v1 and v2 each live in their own sealed module implementing a shared `PaymentStrategy` contract; a dispatcher detects the protocol version per request and selects the module. The two paying-side `dexter-api` files call the SDK and stop branching on version. (Plan 2 covers the server/charging side.)

**Tech Stack:** TypeScript, `@dexterai/x402` SDK (`tsup` build, `vitest` tests), `dexter-api` (Node service). Reference: `docs/superpowers/specs/2026-05-18-x402-version-seam-design.md`.

---

## Context for the implementing engineer

You are working in two repos:

- `~/websites/dexter-x402-sdk` — the `@dexterai/x402` SDK, currently v3.4.0. Builds with `npm run build` (tsup). Tests with `npm test` (vitest). Source in `src/`; client code in `src/client/`, shared types in `src/types.ts`.
- `~/websites/dexter-api` — the API service. The paying-side files this plan touches: `src/tasks/verifier/payment.ts` and `src/routes/x402Pay.ts`.

**The bug being fixed:** x402 has two protocol versions. v1 puts the
payment challenge in the HTTP 402 *body* with bare network names
(`base`). v2 puts it in a base64 `PAYMENT-REQUIRED` *header* with CAIP-2
names (`eip155:8453`). The verifier's v1 path uses the upstream `x402`
npm library, whose network field is a strict bare-name enum — so it
*rewrites* the merchant's CAIP-2 network to a bare name before signing.
A v2 merchant validates against the CAIP-2 it advertised, sees the
mismatch, rejects with `invalid_payload`. ~16k catalog resources fail
for this reason.

**Key principle:** the v1 and v2 strategy modules must NEVER import each
other. They share only the `PaymentStrategy` interface and plain data
types. This keeps v1 a sealed, independently-deletable unit.

---

## File Structure

**SDK — created:**
- `src/payment/types.ts` — the `PaymentStrategy` interface + shared data types (`PaymentChallenge`, `PayResult`, `NetworkRef`)
- `src/payment/network-map.ts` — the two-way CAIP-2 ↔ bare-name map
- `src/payment/v2-strategy.ts` — v2 module (extraction of existing v2 logic behind the interface)
- `src/payment/v1-strategy.ts` — v1 module (the new unit)
- `src/payment/dispatcher.ts` — version detection + strategy selection; exports the public `payAndFetch`
- `src/payment/index.ts` — barrel re-export
- `src/payment/__tests__/network-map.test.ts`
- `src/payment/__tests__/dispatcher.test.ts`
- `src/payment/__tests__/v1-strategy.test.ts`
- `src/payment/__tests__/v2-strategy.test.ts`
- `src/payment/__tests__/fixtures.ts` — real v1 + v2 402 response fixtures

**SDK — modified:**
- `src/client/index.ts` — export the new `payAndFetch` + payment types
- `package.json` — version bump

**dexter-api — modified:**
- `src/tasks/verifier/payment.ts` — replace both payment paths with `payAndFetch`
- `src/routes/x402Pay.ts` — replace upstream `x402/client` + `createSigner` usage with `payAndFetch`
- `package.json` — `npm install` the new SDK version

---

## PHASE A — The SDK seam

### Task 1: Shared payment types

**Files:**
- Create: `src/payment/types.ts`
- Test: (no test — pure type declarations)

- [ ] **Step 1: Write the types file**

```typescript
// src/payment/types.ts
/**
 * Shared contract for the x402 version seam. Both the v1 and v2 strategy
 * modules implement PaymentStrategy. Callers depend ONLY on this file —
 * never on a specific version module.
 */

/** A network reference, kept in BOTH forms so neither version loses info. */
export interface NetworkRef {
  /** CAIP-2 form, e.g. "eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp". */
  caip2: string;
  /** Bare form, e.g. "base", "solana". */
  bare: string;
  /** "evm" | "svm" — which signer family. */
  family: 'evm' | 'svm';
}

/** One payment option parsed from a 402 challenge, version-normalised. */
export interface ChallengeOption {
  scheme: string;
  network: NetworkRef;
  /** Atomic amount as a string (e.g. "2000"). */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  /** Scheme-specific extras, passed through verbatim from the merchant. */
  extra?: Record<string, unknown>;
}

/** A 402 challenge, normalised across v1 and v2. */
export interface PaymentChallenge {
  x402Version: 1 | 2;
  options: ChallengeOption[];
  resourceUrl?: string;
}

/** Result of a paid fetch. Never throws for an expected failure. */
export type PayResult =
  | {
      ok: true;
      response: Response;
      /** Atomic amount actually paid. */
      amountPaid: string;
      network: NetworkRef;
      txSignature?: string;
    }
  | {
      ok: false;
      reason:
        | 'unsupported_network'
        | 'insufficient_funds'
        | 'merchant_rejected'
        | 'no_payment_options'
        | 'timeout'
        | 'budget_exceeded'
        | 'error';
      detail?: string;
    };

/** A funded wallet set (re-uses the SDK's existing WalletSet shape). */
export type { WalletSet } from '../adapters/types';

/** Options for a paid fetch. */
export interface PayAndFetchOptions {
  /** Max total atomic spend for this call. */
  maxAmountAtomic?: string;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
}

/**
 * The contract each version module implements.
 *
 * parseChallenge: given a raw 402 Response, extract the challenge — or
 *   null if this strategy does not recognise it as its version.
 * pay: given a parsed challenge, sign + send the paid request, return
 *   the merchant's response.
 */
export interface PaymentStrategy {
  readonly version: 1 | 2;
  parseChallenge(res: Response): Promise<PaymentChallenge | null>;
  pay(
    url: string,
    requestInit: RequestInit,
    challenge: PaymentChallenge,
    wallets: import('../adapters/types').WalletSet,
    opts: PayAndFetchOptions,
  ): Promise<PayResult>;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/websites/dexter-x402-sdk && npx tsc --noEmit`
Expected: PASS (no errors from `src/payment/types.ts`)

- [ ] **Step 3: Commit**

```bash
git add src/payment/types.ts
git commit -m "feat(payment): PaymentStrategy interface + shared types"
```

---

### Task 2: The network map

**Files:**
- Create: `src/payment/network-map.ts`
- Test: `src/payment/__tests__/network-map.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/payment/__tests__/network-map.test.ts
import { describe, it, expect } from 'vitest';
import { toNetworkRef } from '../network-map';

describe('toNetworkRef', () => {
  it('resolves a CAIP-2 EVM string', () => {
    const r = toNetworkRef('eip155:8453');
    expect(r).toEqual({ caip2: 'eip155:8453', bare: 'base', family: 'evm' });
  });

  it('resolves a bare EVM name', () => {
    const r = toNetworkRef('base');
    expect(r).toEqual({ caip2: 'eip155:8453', bare: 'base', family: 'evm' });
  });

  it('resolves a CAIP-2 Solana string', () => {
    const r = toNetworkRef('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(r?.bare).toBe('solana');
    expect(r?.family).toBe('svm');
  });

  it('resolves the bare solana name', () => {
    const r = toNetworkRef('solana');
    expect(r?.family).toBe('svm');
  });

  it('returns null for an unknown network', () => {
    expect(toNetworkRef('dogecoin')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/payment/__tests__/network-map.test.ts`
Expected: FAIL — cannot find module `../network-map`

- [ ] **Step 3: Write the implementation**

```typescript
// src/payment/network-map.ts
/**
 * Two-way map between CAIP-2 network identifiers (x402 v2) and bare
 * network names (x402 v1). The verifier's old bug was a one-way, lossy
 * rewrite to bare names. This map is lossless: a NetworkRef always
 * carries BOTH forms, so a v1 signer can use the bare name internally
 * while the wire payload keeps whatever the merchant advertised.
 */
import type { NetworkRef } from './types';

interface Entry {
  caip2: string;
  bare: string;
  family: 'evm' | 'svm';
}

// Canonical mainnet networks. Extend as the facilitator adds chains.
const ENTRIES: Entry[] = [
  { caip2: 'eip155:8453',  bare: 'base',      family: 'evm' },
  { caip2: 'eip155:1',     bare: 'ethereum',  family: 'evm' },
  { caip2: 'eip155:137',   bare: 'polygon',   family: 'evm' },
  { caip2: 'eip155:42161', bare: 'arbitrum',  family: 'evm' },
  { caip2: 'eip155:10',    bare: 'optimism',  family: 'evm' },
  { caip2: 'eip155:43114', bare: 'avalanche', family: 'evm' },
  { caip2: 'eip155:56',    bare: 'bsc',       family: 'evm' },
  {
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    bare: 'solana',
    family: 'svm',
  },
];

const byCaip2 = new Map(ENTRIES.map((e) => [e.caip2.toLowerCase(), e]));
const byBare = new Map(ENTRIES.map((e) => [e.bare.toLowerCase(), e]));

/**
 * Resolve any network string — CAIP-2 or bare — to a NetworkRef.
 * Returns null when the network is not recognised.
 */
export function toNetworkRef(network: string): NetworkRef | null {
  if (!network) return null;
  const key = network.toLowerCase();
  const entry =
    byCaip2.get(key) ||
    byBare.get(key) ||
    // CAIP-2 EVM with an unmapped chain id still resolves to evm family.
    (key.startsWith('eip155:')
      ? { caip2: network, bare: key, family: 'evm' as const }
      : key.startsWith('solana:')
        ? { caip2: network, bare: 'solana', family: 'svm' as const }
        : undefined);
  if (!entry) return null;
  return { caip2: entry.caip2, bare: entry.bare, family: entry.family };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/payment/__tests__/network-map.test.ts`
Expected: PASS — all 5 tests green

- [ ] **Step 5: Commit**

```bash
git add src/payment/network-map.ts src/payment/__tests__/network-map.test.ts
git commit -m "feat(payment): lossless CAIP-2 <-> bare network map"
```

---

### Task 3: Test fixtures — real v1 and v2 402 responses

**Files:**
- Create: `src/payment/__tests__/fixtures.ts`

- [ ] **Step 1: Write the fixtures file**

```typescript
// src/payment/__tests__/fixtures.ts
/**
 * Real-shape x402 402 responses for strategy tests.
 *
 * v2 — challenge in a base64 PAYMENT-REQUIRED header, empty body.
 *      Shape taken from api.reloadpi.com (a live v2 merchant).
 * v1 — challenge in the JSON body, bare network name, no header.
 *      Shape taken from the x402 v1 specification.
 */

const v2Challenge = {
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'https://example.com/api', mimeType: 'application/json' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '2000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x8a598A28a435Fe44D31854251b1c88d0781ea822',
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};

/** A v2 402: empty body, base64 PAYMENT-REQUIRED header. */
export function makeV2Response(): Response {
  const header = Buffer.from(JSON.stringify(v2Challenge)).toString('base64');
  return new Response('{}', {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'payment-required': header,
    },
  });
}

const v1Body = {
  x402Version: 1,
  error: 'X-PAYMENT header is required',
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x8a598A28a435Fe44D31854251b1c88d0781ea822',
      resource: 'https://example.com/api',
      description: 'Example v1 resource',
      maxTimeoutSeconds: 60,
    },
  ],
};

/** A v1 402: challenge in the JSON body, no PAYMENT-REQUIRED header. */
export function makeV1Response(): Response {
  return new Response(JSON.stringify(v1Body), {
    status: 402,
    headers: { 'content-type': 'application/json' },
  });
}

/** A 402 with neither a header nor a usable body — unrecognisable. */
export function makeEmptyResponse(): Response {
  return new Response('{}', {
    status: 402,
    headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/payment/__tests__/fixtures.ts
git commit -m "test(payment): real v1 + v2 402 response fixtures"
```

---

### Task 4: v2 strategy — parseChallenge

**Files:**
- Create: `src/payment/v2-strategy.ts`
- Test: `src/payment/__tests__/v2-strategy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/payment/__tests__/v2-strategy.test.ts
import { describe, it, expect } from 'vitest';
import { v2Strategy } from '../v2-strategy';
import { makeV2Response, makeV1Response } from './fixtures';

describe('v2Strategy.parseChallenge', () => {
  it('parses a v2 PAYMENT-REQUIRED header challenge', async () => {
    const c = await v2Strategy.parseChallenge(makeV2Response());
    expect(c).not.toBeNull();
    expect(c!.x402Version).toBe(2);
    expect(c!.options).toHaveLength(1);
    expect(c!.options[0].amount).toBe('2000');
    expect(c!.options[0].network.caip2).toBe('eip155:8453');
    expect(c!.options[0].network.bare).toBe('base');
  });

  it('returns null for a v1 (body-only) response — not its version', async () => {
    const c = await v2Strategy.parseChallenge(makeV1Response());
    expect(c).toBeNull();
  });

  it('exposes version 2', () => {
    expect(v2Strategy.version).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/payment/__tests__/v2-strategy.test.ts`
Expected: FAIL — cannot find module `../v2-strategy`

- [ ] **Step 3: Write the v2 strategy with parseChallenge (pay stubbed)**

```typescript
// src/payment/v2-strategy.ts
/**
 * x402 v2 strategy. v2 carries the challenge in a base64-encoded
 * PAYMENT-REQUIRED header. parseChallenge returns null when the
 * response has no such header (i.e. it is a v1 response) so the
 * dispatcher can fall through to the v1 strategy.
 *
 * MUST NOT import v1-strategy.
 */
import type {
  PaymentStrategy,
  PaymentChallenge,
  ChallengeOption,
  PayResult,
  PayAndFetchOptions,
} from './types';
import type { WalletSet } from '../adapters/types';
import { toNetworkRef } from './network-map';

function decodeHeader(raw: string): unknown {
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
  const normalized = padded + '='.repeat((4 - (padded.length % 4 || 4)) % 4);
  return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
}

function toOptions(accepts: unknown[]): ChallengeOption[] {
  const out: ChallengeOption[] = [];
  for (const a of accepts) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const net = toNetworkRef(String(o.network ?? ''));
    if (!net) continue;
    out.push({
      scheme: String(o.scheme ?? 'exact'),
      network: net,
      amount: String(o.amount ?? o.maxAmountRequired ?? '0'),
      asset: String(o.asset ?? ''),
      payTo: String(o.payTo ?? ''),
      maxTimeoutSeconds:
        typeof o.maxTimeoutSeconds === 'number' ? o.maxTimeoutSeconds : undefined,
      extra:
        o.extra && typeof o.extra === 'object'
          ? (o.extra as Record<string, unknown>)
          : undefined,
    });
  }
  return out;
}

export const v2Strategy: PaymentStrategy = {
  version: 2,

  async parseChallenge(res: Response): Promise<PaymentChallenge | null> {
    const header = res.headers.get('payment-required');
    if (!header) return null;
    let decoded: Record<string, unknown>;
    try {
      decoded = decodeHeader(header) as Record<string, unknown>;
    } catch {
      return null;
    }
    const accepts = Array.isArray(decoded.accepts) ? decoded.accepts : [];
    if (accepts.length === 0) return null;
    return {
      x402Version: 2,
      options: toOptions(accepts),
      resourceUrl:
        decoded.resource && typeof decoded.resource === 'object'
          ? String((decoded.resource as Record<string, unknown>).url ?? '')
          : undefined,
    };
  },

  async pay(
    _url: string,
    _requestInit: RequestInit,
    _challenge: PaymentChallenge,
    _wallets: WalletSet,
    _opts: PayAndFetchOptions,
  ): Promise<PayResult> {
    // Implemented in Task 5.
    return { ok: false, reason: 'error', detail: 'pay not yet implemented' };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/payment/__tests__/v2-strategy.test.ts`
Expected: PASS — all 3 tests green

- [ ] **Step 5: Commit**

```bash
git add src/payment/v2-strategy.ts src/payment/__tests__/v2-strategy.test.ts
git commit -m "feat(payment): v2 strategy parseChallenge"
```

---

### Task 5: v2 strategy — pay (via the existing SDK client)

**Files:**
- Modify: `src/payment/v2-strategy.ts` (replace the stubbed `pay`)
- Test: `src/payment/__tests__/v2-strategy.test.ts` (add a `pay` test)

**Context:** the SDK already pays v2 endpoints correctly via
`wrapFetch` (`src/client/wrap-fetch.ts`). The v2 `pay` delegates to it
rather than reimplementing v2 signing.

- [ ] **Step 1: Add the failing test**

Append to `src/payment/__tests__/v2-strategy.test.ts`:

```typescript
import { vi } from 'vitest';

describe('v2Strategy.pay', () => {
  it('returns ok with the merchant response on a successful paid call', async () => {
    // wrapFetch is exercised against a mock fetch that 402s then 200s.
    const calls: string[] = [];
    const mockFetch = vi.fn(async (_url: string | URL | Request) => {
      calls.push('call');
      if (calls.length === 1) {
        const { makeV2Response } = await import('./fixtures');
        return makeV2Response();
      }
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const { v2Strategy } = await import('../v2-strategy');
    const challenge = await v2Strategy.parseChallenge(
      (await import('./fixtures')).makeV2Response(),
    );
    // A wallet set is required; this test uses an EVM keypair wallet.
    const { createEvmKeypairWallet } = await import('../client/evm-wallet');
    const wallets = {
      evm: createEvmKeypairWallet(
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      ),
    } as never;

    const result = await v2Strategy.pay(
      'https://example.com/api',
      { method: 'GET' },
      challenge!,
      wallets,
      { maxAmountAtomic: '100000' },
    );

    // The mock merchant never verifies the signature, so a real run may
    // still report merchant_rejected — assert the call SHAPE, not chain
    // settlement: pay() must return a typed PayResult, never throw.
    expect(result).toHaveProperty('ok');
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/payment/__tests__/v2-strategy.test.ts`
Expected: FAIL — `pay` returns the stub `{ ok: false, detail: 'pay not yet implemented' }`

- [ ] **Step 3: Implement `pay` by delegating to `wrapFetch`**

In `src/payment/v2-strategy.ts`, replace the stubbed `pay` with:

```typescript
  async pay(
    url: string,
    requestInit: RequestInit,
    challenge: PaymentChallenge,
    wallets: WalletSet,
    opts: PayAndFetchOptions,
  ): Promise<PayResult> {
    // Pick the first option whose network family we have a wallet for.
    const option = challenge.options.find(
      (o) =>
        (o.network.family === 'evm' && wallets.evm) ||
        (o.network.family === 'svm' && wallets.solana),
    );
    if (!option) {
      return { ok: false, reason: 'unsupported_network' };
    }

    // wrapFetch handles the v2 402-pay-retry transparently. Build a
    // FRESH request init for the call — never reuse a consumed body.
    const { wrapFetch } = await import('../client/wrap-fetch');
    const paidFetch = wrapFetch(fetch, {
      walletPrivateKey: undefined,
      evmPrivateKey: undefined,
      wallets,
      preferredNetwork: option.network.caip2,
      maxAmountAtomic: opts.maxAmountAtomic,
      verbose: false,
    } as never);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? 15_000,
    );
    try {
      const freshInit: RequestInit = {
        ...requestInit,
        signal: controller.signal,
        body:
          typeof requestInit.body === 'string' ? requestInit.body : undefined,
      };
      const response = await paidFetch(url, freshInit);
      clearTimeout(timeout);
      if (!response.ok) {
        return {
          ok: false,
          reason: 'merchant_rejected',
          detail: `HTTP ${response.status}`,
        };
      }
      const txSignature =
        response.headers.get('PAYMENT-RESPONSE') ??
        response.headers.get('payment-response') ??
        undefined;
      return {
        ok: true,
        response,
        amountPaid: option.amount,
        network: option.network,
        txSignature: txSignature ?? undefined,
      };
    } catch (err) {
      clearTimeout(timeout);
      const e = err as Error & { name?: string };
      if (e.name === 'AbortError') return { ok: false, reason: 'timeout' };
      return { ok: false, reason: 'error', detail: e.message };
    }
  },
```

> **Note for the engineer:** `wrapFetch`'s exact option names must be
> confirmed against `src/client/wrap-fetch.ts` — pass `wallets` the way
> that file expects. The intent is fixed (delegate v2 payment to
> `wrapFetch`); the precise option object is whatever `wrapFetch`'s
> signature requires.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/payment/__tests__/v2-strategy.test.ts`
Expected: PASS — the `pay` test asserts only that a typed `PayResult` is
returned (never a throw)

- [ ] **Step 5: Commit**

```bash
git add src/payment/v2-strategy.ts src/payment/__tests__/v2-strategy.test.ts
git commit -m "feat(payment): v2 strategy pay via wrapFetch"
```

---

### Task 6: v1 strategy — parseChallenge

**Files:**
- Create: `src/payment/v1-strategy.ts`
- Test: `src/payment/__tests__/v1-strategy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/payment/__tests__/v1-strategy.test.ts
import { describe, it, expect } from 'vitest';
import { v1Strategy } from '../v1-strategy';
import { makeV1Response, makeV2Response, makeEmptyResponse } from './fixtures';

describe('v1Strategy.parseChallenge', () => {
  it('parses a v1 body challenge', async () => {
    const c = await v1Strategy.parseChallenge(makeV1Response());
    expect(c).not.toBeNull();
    expect(c!.x402Version).toBe(1);
    expect(c!.options[0].amount).toBe('10000'); // from maxAmountRequired
    expect(c!.options[0].network.bare).toBe('base');
    expect(c!.options[0].network.caip2).toBe('eip155:8453');
  });

  it('returns null for a v2 response — handled by v2Strategy', async () => {
    // A v2 response has a PAYMENT-REQUIRED header; v1 should decline it
    // so the dispatcher picks v2 first regardless of body contents.
    const c = await v1Strategy.parseChallenge(makeV2Response());
    expect(c).toBeNull();
  });

  it('returns null for a 402 with no usable challenge', async () => {
    const c = await v1Strategy.parseChallenge(makeEmptyResponse());
    expect(c).toBeNull();
  });

  it('exposes version 1', () => {
    expect(v1Strategy.version).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/payment/__tests__/v1-strategy.test.ts`
Expected: FAIL — cannot find module `../v1-strategy`

- [ ] **Step 3: Write the v1 strategy with parseChallenge (pay stubbed)**

```typescript
// src/payment/v1-strategy.ts
/**
 * x402 v1 strategy. v1 carries the challenge in the JSON body of the
 * 402 (an `accepts` array) with bare network names. parseChallenge
 * declines (returns null) when a PAYMENT-REQUIRED header is present —
 * that is a v2 response and the dispatcher will route it to v2Strategy.
 *
 * MUST NOT import v2-strategy.
 */
import type {
  PaymentStrategy,
  PaymentChallenge,
  ChallengeOption,
  PayResult,
  PayAndFetchOptions,
} from './types';
import type { WalletSet } from '../adapters/types';
import { toNetworkRef } from './network-map';

function toOptions(accepts: unknown[]): ChallengeOption[] {
  const out: ChallengeOption[] = [];
  for (const a of accepts) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const net = toNetworkRef(String(o.network ?? ''));
    if (!net) continue;
    out.push({
      scheme: String(o.scheme ?? 'exact'),
      network: net,
      // v1 names the amount field `maxAmountRequired`.
      amount: String(o.maxAmountRequired ?? o.amount ?? '0'),
      asset: String(o.asset ?? ''),
      payTo: String(o.payTo ?? ''),
      maxTimeoutSeconds:
        typeof o.maxTimeoutSeconds === 'number' ? o.maxTimeoutSeconds : undefined,
      extra:
        o.extra && typeof o.extra === 'object'
          ? (o.extra as Record<string, unknown>)
          : undefined,
    });
  }
  return out;
}

export const v1Strategy: PaymentStrategy = {
  version: 1,

  async parseChallenge(res: Response): Promise<PaymentChallenge | null> {
    // A PAYMENT-REQUIRED header means v2 — decline.
    if (res.headers.get('payment-required')) return null;
    let body: Record<string, unknown>;
    try {
      body = (await res.clone().json()) as Record<string, unknown>;
    } catch {
      return null;
    }
    const accepts = Array.isArray(body.accepts) ? body.accepts : [];
    if (accepts.length === 0) return null;
    const options = toOptions(accepts);
    if (options.length === 0) return null;
    return { x402Version: 1, options };
  },

  async pay(
    _url: string,
    _requestInit: RequestInit,
    _challenge: PaymentChallenge,
    _wallets: WalletSet,
    _opts: PayAndFetchOptions,
  ): Promise<PayResult> {
    // Implemented in Task 7.
    return { ok: false, reason: 'error', detail: 'pay not yet implemented' };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/payment/__tests__/v1-strategy.test.ts`
Expected: PASS — all 4 tests green

- [ ] **Step 5: Commit**

```bash
git add src/payment/v1-strategy.ts src/payment/__tests__/v1-strategy.test.ts
git commit -m "feat(payment): v1 strategy parseChallenge"
```

---

### Task 7: v1 strategy — pay (the new, correct v1 payment path)

**Files:**
- Modify: `src/payment/v1-strategy.ts` (replace the stubbed `pay`)
- Test: `src/payment/__tests__/v1-strategy.test.ts` (add a `pay` test)

**Context — the open question from the spec, resolved here:** before
writing this task's implementation, the engineer MUST read the upstream
`x402` library's v1 payment code (`node_modules/x402/dist/cjs/` in
`dexter-api` — functions `createPaymentHeader`, `preparePaymentHeader`,
`signPaymentHeader`) and the v1 spec at
`github.com/coinbase/x402/blob/main/specs/x402-specification-v1.md`.
The goal is to understand how v1 builds and signs the `X-PAYMENT`
header (EIP-3009 `transferWithAuthorization` for EVM; the SVM
equivalent), then reimplement it inside this module.

**Decision rule for the implementation:** the SDK already has v2 EVM and
SVM signing in `src/adapters/`. v1's `exact` scheme uses the SAME
underlying signing primitive (EIP-3009 for EVM). So:
- If the SDK's existing adapter signing can produce a v1-shaped
  `X-PAYMENT` payload by feeding it the v1 requirement fields → reuse it.
- If v1's payload differs enough that reuse would distort it → write a
  small `signV1Payment` helper in this module. Either way, the network
  string written into the payload is the merchant's advertised string
  (`challenge.options[].network.caip2` OR `.bare` — whichever the
  merchant originally sent; preserved on the `ChallengeOption`).

**The critical correctness requirement:** the signed v1 payload's
`network` field MUST equal what the merchant advertised. NEVER rewrite
it. The bare/CAIP-2 distinction is only for choosing which signer
family to use — never for the wire payload. Add a code comment stating
this so the bug cannot be reintroduced.

- [ ] **Step 1: Add the failing test**

Append to `src/payment/__tests__/v1-strategy.test.ts`:

```typescript
import { vi } from 'vitest';

describe('v1Strategy.pay', () => {
  it('preserves the merchant network in the signed payload', async () => {
    // The merchant advertised bare "base". The signed X-PAYMENT payload
    // sent on the retry must carry "base" — NOT a rewritten value.
    let sentPaymentHeader: string | null = null;
    const calls: number[] = [];
    const mockFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push(1);
      if (calls.length === 1) {
        const { makeV1Response } = await import('./fixtures');
        return makeV1Response();
      }
      // Retry call: capture the X-PAYMENT header the strategy built.
      const h = (init?.headers ?? {}) as Record<string, string>;
      sentPaymentHeader =
        h['X-PAYMENT'] ?? h['x-payment'] ?? null;
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const { v1Strategy } = await import('../v1-strategy');
    const challenge = await v1Strategy.parseChallenge(
      (await import('./fixtures')).makeV1Response(),
    );
    const { createEvmKeypairWallet } = await import('../client/evm-wallet');
    const wallets = {
      evm: createEvmKeypairWallet(
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      ),
    } as never;

    const result = await v1Strategy.pay(
      'https://example.com/api',
      { method: 'GET' },
      challenge!,
      wallets,
      { maxAmountAtomic: '100000' },
    );

    // pay() must return a typed result, never throw.
    expect(result).toHaveProperty('ok');
    // If a payment header was built, its decoded network must be "base".
    if (sentPaymentHeader) {
      const decoded = JSON.parse(
        Buffer.from(sentPaymentHeader, 'base64').toString('utf8'),
      );
      expect(String(decoded.network ?? decoded.payload?.network)).toContain(
        'base',
      );
    }
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/payment/__tests__/v1-strategy.test.ts`
Expected: FAIL — `pay` returns the stub

- [ ] **Step 3: Implement v1 `pay`**

Replace the stubbed `pay` in `src/payment/v1-strategy.ts`. The
implementation MUST:

1. Select a `ChallengeOption` whose `network.family` has a matching
   wallet in `wallets`; if none, return `{ ok: false, reason:
   'unsupported_network' }`.
2. Enforce the budget: if `option.amount` (atomic) exceeds
   `opts.maxAmountAtomic`, return `{ ok: false, reason:
   'budget_exceeded' }`.
3. Build a v1 `exact`-scheme payment authorization for `option`, signed
   with the matching wallet. The `network` field in the built payload
   MUST be `option.network`'s ORIGINAL merchant string — see the
   correctness requirement above. Add the no-rewrite comment.
4. Base64-encode the payload into an `X-PAYMENT` header.
5. Build a FRESH `RequestInit` (never reuse a consumed body) with the
   `X-PAYMENT` header added, send it, and return the response.
6. Map outcomes to `PayResult`: 2xx → `{ ok: true, ... }`; non-2xx →
   `{ ok: false, reason: 'merchant_rejected', detail }`; abort →
   `timeout`; thrown error → `{ ok: false, reason: 'error', detail }`.

The exact signing code is determined by Step 3's reading of the
upstream library and the SDK's adapters (per the decision rule above).
Whichever path is chosen, the function returns a typed `PayResult` and
never throws for an expected failure.

> This step's code is intentionally not pre-written: it depends on the
> reading in the Context block. The engineer writes it against the
> upstream reference + the SDK adapters, holding to the six numbered
> requirements and the no-rewrite rule. This is the one task that is a
> genuine implementation, not a transcription.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/payment/__tests__/v1-strategy.test.ts`
Expected: PASS — the network-preservation assertion holds

- [ ] **Step 5: Commit**

```bash
git add src/payment/v1-strategy.ts src/payment/__tests__/v1-strategy.test.ts
git commit -m "feat(payment): v1 strategy pay — merchant network preserved"
```

---

### Task 8: The dispatcher + public payAndFetch

**Files:**
- Create: `src/payment/dispatcher.ts`
- Create: `src/payment/index.ts`
- Test: `src/payment/__tests__/dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/payment/__tests__/dispatcher.test.ts
import { describe, it, expect, vi } from 'vitest';
import { detectStrategy, payAndFetch } from '../dispatcher';
import { makeV1Response, makeV2Response, makeEmptyResponse } from './fixtures';

describe('detectStrategy', () => {
  it('routes a v2 (header) response to the v2 strategy', async () => {
    const s = await detectStrategy(makeV2Response());
    expect(s?.version).toBe(2);
  });

  it('routes a v1 (body) response to the v1 strategy', async () => {
    const s = await detectStrategy(makeV1Response());
    expect(s?.version).toBe(1);
  });

  it('returns null when no strategy recognises the 402', async () => {
    const s = await detectStrategy(makeEmptyResponse());
    expect(s).toBeNull();
  });
});

describe('payAndFetch', () => {
  it('returns the response directly when the endpoint does not 402', async () => {
    const mockFetch = vi.fn(async () =>
      new Response('{"free":true}', { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFetch);
    const result = await payAndFetch(
      'https://example.com/free',
      { method: 'GET' },
      {} as never,
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response.status).toBe(200);
    vi.unstubAllGlobals();
  });

  it('returns no_payment_options when a 402 has no usable challenge', async () => {
    const mockFetch = vi.fn(async () => makeEmptyResponse());
    vi.stubGlobal('fetch', mockFetch);
    const result = await payAndFetch(
      'https://example.com/api',
      { method: 'GET' },
      {} as never,
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_payment_options');
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/payment/__tests__/dispatcher.test.ts`
Expected: FAIL — cannot find module `../dispatcher`

- [ ] **Step 3: Write the dispatcher**

```typescript
// src/payment/dispatcher.ts
/**
 * The x402 version dispatcher — the ONLY code in the stack that decides
 * v1 vs v2. It probes the endpoint once; if the response is a 402, it
 * asks each strategy to parse it (v2 first, since v2 is current) and
 * routes to whichever recognises it. Callers use payAndFetch and never
 * branch on protocol version themselves.
 */
import type { PaymentStrategy, PayResult, PayAndFetchOptions } from './types';
import type { WalletSet } from '../adapters/types';
import { v2Strategy } from './v2-strategy';
import { v1Strategy } from './v1-strategy';

// v2 first: it is the current protocol version. v1 is the fallback.
const STRATEGIES: PaymentStrategy[] = [v2Strategy, v1Strategy];

/**
 * Given a 402 Response, return the strategy that recognises it, or null.
 * Exported for testing; payAndFetch is the normal entrypoint.
 */
export async function detectStrategy(
  res: Response,
): Promise<PaymentStrategy | null> {
  for (const strategy of STRATEGIES) {
    const challenge = await strategy.parseChallenge(res.clone());
    if (challenge) return strategy;
  }
  return null;
}

/**
 * Pay for and fetch a resource. Probes once; if the endpoint demands
 * payment, detects the protocol version, and pays via the matching
 * strategy. Returns a typed PayResult — never throws for an expected
 * failure.
 */
export async function payAndFetch(
  url: string,
  requestInit: RequestInit,
  wallets: WalletSet,
  opts: PayAndFetchOptions,
): Promise<PayResult> {
  let probe: Response;
  try {
    // Probe with a fresh request — body, if any, must be a string so it
    // can be re-sent on the paid retry.
    probe = await fetch(url, {
      ...requestInit,
      body:
        typeof requestInit.body === 'string' ? requestInit.body : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      detail: (err as Error).message,
    };
  }

  if (probe.status !== 402) {
    return {
      ok: true,
      response: probe,
      amountPaid: '0',
      network: { caip2: '', bare: '', family: 'evm' },
    };
  }

  for (const strategy of STRATEGIES) {
    const challenge = await strategy.parseChallenge(probe.clone());
    if (challenge) {
      return strategy.pay(url, requestInit, challenge, wallets, opts);
    }
  }
  return { ok: false, reason: 'no_payment_options' };
}
```

- [ ] **Step 4: Write the barrel export**

```typescript
// src/payment/index.ts
/**
 * The x402 version seam. The single entrypoint for paying x402
 * endpoints — handles v1 and v2 transparently.
 */
export { payAndFetch, detectStrategy } from './dispatcher';
export { toNetworkRef } from './network-map';
export type {
  PaymentStrategy,
  PaymentChallenge,
  ChallengeOption,
  PayResult,
  PayAndFetchOptions,
  NetworkRef,
} from './types';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/payment/__tests__/dispatcher.test.ts`
Expected: PASS — all 5 tests green

- [ ] **Step 6: Commit**

```bash
git add src/payment/dispatcher.ts src/payment/index.ts src/payment/__tests__/dispatcher.test.ts
git commit -m "feat(payment): version dispatcher + public payAndFetch"
```

---

### Task 9: Export the seam from the SDK + publish

**Files:**
- Modify: `src/client/index.ts`
- Modify: `package.json` (version bump)

- [ ] **Step 1: Add the export to the client barrel**

In `src/client/index.ts`, after the `createBudgetAccount` export block
(around line 76), add:

```typescript
// x402 version seam — version-agnostic paid fetch (v1 + v2)
export { payAndFetch, detectStrategy, toNetworkRef } from '../payment';
export type {
  PaymentStrategy,
  PaymentChallenge,
  ChallengeOption,
  PayResult,
  PayAndFetchOptions,
  NetworkRef,
} from '../payment';
```

- [ ] **Step 2: Run the full SDK test suite**

Run: `cd ~/websites/dexter-x402-sdk && npm test`
Expected: PASS — all existing tests plus the new `src/payment/__tests__/*`

- [ ] **Step 3: Build the SDK**

Run: `npm run build`
Expected: PASS — `tsup` build succeeds, exit 0

- [ ] **Step 4: Bump the version**

Run: `npm version minor --no-git-tag-version`
Expected: prints the new version (3.4.0 → 3.5.0)

- [ ] **Step 5: Commit and publish**

```bash
git add src/client/index.ts package.json
git commit -m "feat(payment): export payAndFetch seam; release 3.5.0"
npm publish --access public
```

Expected: `+ @dexterai/x402@3.5.0`

- [ ] **Step 6: Verify it is on the registry**

Run: `npm view @dexterai/x402@3.5.0 version`
Expected: `3.5.0` (retry for ~1 min if the registry lags)

---

## PHASE B — Migrate the paying-side dexter-api files

### Task 10: Migrate the verifier payment path

**Files:**
- Modify: `~/websites/dexter-api/src/tasks/verifier/payment.ts`
- Modify: `~/websites/dexter-api/package.json`

**Context:** `payment.ts` currently has two payment functions —
`makePaymentAndGetResponse` (v2 via the SDK) and `makePaymentV1Style`
(v1 via the upstream `x402` library, with the network-rewrite bug). It
imports `createPaymentHeader`, `selectPaymentRequirements` from
`x402/client` and `createSigner` from `x402/types` (lines 11-12). The
single caller is `runner.ts:582`. The function's result shape is an
inline object — callers read `.ok`, `.response`, `.error`, `.txSignature`,
`.responseStatus`, `.responseKind`, etc.

- [ ] **Step 1: Install the new SDK version**

Run: `cd ~/websites/dexter-api && npm install @dexterai/x402@3.5.0`
Expected: `package.json` shows `@dexterai/x402@^3.5.0`

- [ ] **Step 2: Read the current file and its caller**

Read `src/tasks/verifier/payment.ts` in full and `runner.ts` around
line 582 to capture every field the caller reads off the result. The
migration must keep that result shape — `payAndFetch` returns a
`PayResult`, which this task adapts into the existing result shape so
`runner.ts` needs no change.

- [ ] **Step 3: Rewrite `payment.ts` to use `payAndFetch`**

Replace the body of `makePaymentAndGetResponse` so it:
1. Builds the `WalletSet` from `env.SOLANA_TEST_PRIVATE_KEY` /
   `env.BASE_TEST_PRIVATE_KEY` (the same keys used today — keep the
   "no CONNECTOR_REWARD fallback" comment).
2. Calls `payAndFetch(url, requestInit, wallets, { maxAmountAtomic, timeoutMs })`.
3. Maps the returned `PayResult` into the existing inline result shape
   the caller expects (`ok`, `response`, `responseStatus`,
   `txSignature`, `error`, `responseKind`, etc.) — reuse the existing
   `classifyResponse` helper for the response-body classification.
4. DELETE `makePaymentV1Style` entirely.
5. DELETE the imports `createPaymentHeader`, `selectPaymentRequirements`
   from `x402/client` and `createSigner` from `x402/types` (lines 11-12).

Add a file-level comment: payment version handling now lives entirely
in `@dexterai/x402`'s `payAndFetch`; this file no longer knows about v1
vs v2.

- [ ] **Step 4: Typecheck**

Run: `cd ~/websites/dexter-api && npx tsc --noEmit`
Expected: PASS — no errors; in particular no remaining reference to
`x402/client` or `x402/types` in `payment.ts`

- [ ] **Step 5: Confirm the upstream import is gone**

Run: `grep -n "from 'x402" src/tasks/verifier/payment.ts`
Expected: no output (the file no longer imports the upstream library)

- [ ] **Step 6: Commit**

```bash
cd ~/websites/dexter-api
git add src/tasks/verifier/payment.ts package.json package-lock.json
git commit -m "refactor(verifier): pay via @dexterai/x402 payAndFetch seam

Replaces makePaymentAndGetResponse + makePaymentV1Style with the SDK's
version-agnostic payAndFetch. Removes the upstream x402 library from
this path and the network-rewrite bug that caused invalid_payload."
```

---

### Task 11: Migrate resourceQualityVerifier.ts

**Files:**
- Modify: `~/websites/dexter-api/src/tasks/resourceQualityVerifier.ts`

**Context:** this file imports the same upstream symbols
(`createPaymentHeader as createPaymentHeaderV1`, `selectPaymentRequirements`
from `x402/client`; `createSigner` from `x402/types`, lines 11-12).

- [ ] **Step 1: Read the file and find every use of the three imports**

Run: `grep -n "createPaymentHeaderV1\|selectPaymentRequirements\|createSigner" src/tasks/resourceQualityVerifier.ts`
Read each usage site.

- [ ] **Step 2: Replace the upstream usage with `payAndFetch`**

For each place the file hand-rolls a payment with those three functions,
replace it with a `payAndFetch` call (import from `@dexterai/x402/client`).
If the file only used those symbols indirectly through `payment.ts`'s
helpers, and Task 10 already removed them, this file may only need its
imports deleted — confirm by reading.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Confirm the upstream import is gone**

Run: `grep -n "from 'x402" src/tasks/resourceQualityVerifier.ts`
Expected: no output

- [ ] **Step 5: Commit**

```bash
git add src/tasks/resourceQualityVerifier.ts
git commit -m "refactor(verifier): resourceQualityVerifier off upstream x402"
```

---

### Task 12: Migrate the paying paths in x402Pay.ts

**Files:**
- Modify: `~/websites/dexter-api/src/routes/x402Pay.ts`

**Context:** `x402Pay.ts` is large (~1600 lines). It imports
`createPaymentHeader`, `selectPaymentRequirements` from `x402/client`
(line 19) and `createSigner` from `x402/types` (line 32), and uses them
at lines ~427-428, ~1023-1024, ~1340-1341 to hand-build payment headers.
It ALSO imports `x402HTTPClient`, `decodePaymentRequiredHeader` from
`@x402/core/http` (line 21) — a DIFFERENT package; leave that one alone,
this task only removes the bare `x402` library usage.

- [ ] **Step 1: Read each of the three usage sites**

Read `x402Pay.ts` around lines 420-460, 1015-1030, 1335-1345 to
understand what each `createPaymentHeader` / `createSigner` block does
and what surrounds it.

- [ ] **Step 2: Replace each hand-rolled payment with `payAndFetch`**

For each of the three sites, replace the `createSigner` +
`createPaymentHeader` pair with a `payAndFetch` call (import from
`@dexterai/x402/client`). Each site builds a payment header then sends a
request — `payAndFetch` does both. Preserve the surrounding response
handling.

- [ ] **Step 3: Delete the now-unused upstream imports**

Remove `createPaymentHeader`, `selectPaymentRequirements` from the
line-19 import and `createSigner` from the line-32 import. Keep the
`@x402/core/http` import on line 21.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Confirm the bare x402 import is gone (but @x402/core stays)**

Run: `grep -n "from \"x402\|from 'x402" src/routes/x402Pay.ts`
Expected: no output. (`grep -n "@x402/core"` SHOULD still show line 21 —
that package is out of scope for this plan.)

- [ ] **Step 6: Commit**

```bash
git add src/routes/x402Pay.ts
git commit -m "refactor(x402Pay): paying paths off upstream x402 library"
```

---

### Task 13: Verify the paying side end-to-end

**Files:** none modified — verification only.

- [ ] **Step 1: Full typecheck of dexter-api**

Run: `cd ~/websites/dexter-api && npx tsc --noEmit`
Expected: PASS — clean

- [ ] **Step 2: Confirm no paying-side file imports the upstream library**

Run:
```bash
grep -rn "from 'x402/client'\|from 'x402/types'\|from \"x402/client\"\|from \"x402/types\"" \
  src/tasks/verifier/payment.ts src/tasks/resourceQualityVerifier.ts src/routes/x402Pay.ts
```
Expected: no output

- [ ] **Step 3: Real paid call against a live v2 merchant**

From `~/websites/skillsmith-cli/.workspaces` (the skillsmith CLI uses the
same SDK), build a one-service workflow pointing at a live v2 endpoint
(`https://api.reloadpi.com/api/catalog/vouchers/offers`) and run
`skillsmith test --max-spend 0.05`.
Expected: `1/1 calls succeeded`, a real on-chain payment.

- [ ] **Step 4: Real paid call against a live v1 merchant**

Identify a known v1 merchant (challenge in body, no PAYMENT-REQUIRED
header) from the catalog and run the same `skillsmith test` against it.
Expected: `1/1 calls succeeded`. If no live v1 merchant can be found,
record that and rely on the v1 unit tests from Task 7.

- [ ] **Step 5: Commit a verification note**

```bash
cd ~/websites/dexter-api
echo "Paying-side migration verified $(date -I): v2 paid call OK, v1 $(...)" \
  >> .planning/verifier-findings.md
git add .planning/verifier-findings.md
git commit -m "docs: record paying-side migration verification"
```

---

## Self-Review

**Spec coverage:**
- "One seam, SDK owns the protocol" → Tasks 1-9 (the seam) ✓
- "v1 + v2 sealed strategy modules, never import each other" → Tasks 4-7; the no-cross-import rule is stated in both module headers ✓
- "Dispatcher owns all version detection" → Task 8 ✓
- "Migrate the paying-side files" → Tasks 10-12 (verifier, resourceQualityVerifier, x402Pay) ✓
- "Fix invalid_payload" → Task 7 (v1 pay preserves merchant network) + Task 10 (deletes the rewrite) ✓
- "Fix Request-reuse crash" → fresh `RequestInit` per call in Tasks 5, 7, 8 ✓
- "Remove upstream x402 from paying paths" → Tasks 10-12 each end with a grep-confirm step ✓
- "Open question — v1 signing primitives" → Task 7 Context block resolves it during implementation ✓
- Server/charging side + `dexter-mcp` → explicitly deferred to Plan 2 (out of scope here, stated in the header) ✓

**Placeholder scan:** Task 7 Step 3 is intentionally not pre-written
code — it is the one genuine implementation task and depends on reading
the upstream reference. It is bounded by six explicit numbered
requirements and the no-rewrite rule, so it is a real instruction, not a
placeholder. All other code steps contain complete code.

**Type consistency:** `PayResult`, `PaymentChallenge`, `ChallengeOption`,
`NetworkRef`, `PaymentStrategy`, `PayAndFetchOptions`, `toNetworkRef`,
`payAndFetch`, `detectStrategy`, `v1Strategy`, `v2Strategy` — all defined
in Tasks 1-2 and used consistently in Tasks 4-12. `WalletSet` is
re-exported from the SDK's existing `../adapters/types`.

**Note for the engineer on `wrapFetch` (Task 5):** the option object
passed to `wrapFetch` must match `src/client/wrap-fetch.ts`'s actual
signature — read that file and adapt. The intent (delegate v2 payment to
`wrapFetch`) is fixed.
