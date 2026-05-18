# x402 Version Seam — Design

**Date:** 2026-05-18
**Status:** approved design, pending implementation plan
**Repos affected:** `dexter-x402-sdk` (`@dexterai/x402`), `dexter-api`, `dexter-mcp`

---

## Problem

x402 has two protocol versions. **v1** carries the payment challenge in
the HTTP 402 *body* with bare network names (`base`, `solana`). **v2**
(launched Dec 2025) carries it in a base64 `PAYMENT-REQUIRED` *header*
with CAIP-2 network identifiers (`eip155:8453`, `solana:5eykt4...`).

Backwards-compatibility for v1 was added months ago — but it was added
**at the call sites**. Today, v1-vs-v2 handling is smeared across **8
files in `dexter-api`**, each with its own slightly-different version
branch or rewrite hack, plus a dependency on the upstream `x402` npm
library. The call-site copies have already drifted apart.

This caused a concrete bug. The verifier's v1 payment path uses the
upstream `x402` library, whose `PaymentRequirements.network` is a strict
Zod enum of bare names only — no CAIP-2. To use it, the verifier
**rewrites** the merchant's advertised network (`eip155:8453` → `base`)
before signing. A v2 merchant validates the signed payload against the
CAIP-2 string it advertised, sees a mismatch, and rejects it:
`invalid_payload`. ~16,000 catalog resources fail verification for this
reason — they are not broken; our payment is malformed.

Compatibility-at-the-call-site always rots. Compatibility behind one
interface does not. This design finishes the job: consolidate all x402
protocol logic into a single seam.

## Goal

The `@dexterai/x402` SDK becomes the **single source of truth** for the
x402 protocol. Every consumer calls the SDK and never branches on
protocol version. v1 stays fully supported — real v1 merchants exist and
must keep working — but its handling lives in exactly one place. The
upstream `x402` library is removed from the stack entirely.

## Architecture — the one seam

```
   8 dexter-api files                  @dexterai/x402 SDK
   (verifier, pay route,               ┌─────────────────────────────┐
    middleware, config…)               │  payment entrypoint          │
        │                              │  (one public interface)      │
        │  "pay this" / "charge this"  │         │                    │
        └─────────────────────────────▶│    version dispatcher        │
                                       │      │            │          │
          no file knows the            │   ┌──▼───┐    ┌───▼──┐        │
          protocol version anymore     │   │  v1  │    │  v2  │        │
                                       │   │module│    │module│        │
                                       │   └──────┘    └──────┘        │
                                       │   sealed       v2-native      │
                                       └─────────────────────────────┘
                                              ▲
                                       upstream `x402` library
                                       DELETED from every package.json
```

The SDK exposes one payment interface. v1 and v2 each live in their own
sealed module implementing a shared `PaymentStrategy` contract. A
dispatcher detects the version per request and selects the module. The
8 `dexter-api` call sites lose every version hack they currently carry.

Both halves of x402 are in scope:

- **Paying side** — code that *makes* x402 payments: the verifier
  (`tasks/verifier/payment.ts`), `routes/x402Pay.ts`.
- **Server / charging side** — code that *charges* for x402:
  `payments/dexterPaymentMiddleware.ts`, `payments/registerX402.ts`,
  `payments/x402Config.ts`, `routes/payments.ts`, `routes/tools/ai.ts`.

## The `PaymentStrategy` interface

The contract both version modules implement.

**Client side (paying)** — one method:

```
payAndFetch(url, requestInit, walletSet, budget) → { response, settlement }
```

The caller passes a URL, a request, a wallet set, and a spend cap. It
receives the paid response and a settlement record. It does **not** pass
a protocol version.

**Server side (charging)** — verify then settle:

```
verifyPayment(incomingRequest, requirements) → { valid, payer, reason }
settlePayment(verifiedPayment) → { settled, txHash }
```

**The dispatcher** — the only code in the entire stack that decides
v1 vs v2. Detection is concrete, not heuristic:

- 402 carrying a `PAYMENT-REQUIRED` **header** → **v2**
- 402 with the challenge in the **body** (`accepts[]`, no header) → **v1**
- Server side: inbound `PAYMENT-SIGNATURE` header → v2; legacy
  `X-PAYMENT` header → v1

This detection exists in exactly one function. Nothing else branches on
version.

**Isolation rule:** the v1 and v2 modules **never import each other**.
They share only the `PaymentStrategy` interface and plain data types.
This makes v1 a sealed unit — deletable in one move the day it is truly
dead — and structurally prevents the call-site rot from returning.

## The version modules

**`v2-payment` module** — primarily *extraction*. The SDK already speaks
v2 correctly (`wrapFetch`, the `PAYMENT-REQUIRED` header path). This
module is that existing, proven logic lifted behind the `PaymentStrategy`
interface.

**`v1-payment` module** — the one genuinely new unit. Built by studying
how the upstream `x402` library performs v1 payments, then
reimplementing that behavior correctly inside our SDK.

> **Open implementation question for the plan:** the v1 module needs v1
> *signing* primitives (EIP-3009 authorization signing for EVM, the SVM
> equivalent). The SDK already has v2 signing — the plan must determine
> whether the v2 signing primitives cover v1's needs as-is, or whether a
> small v1-specific signing path is reimplemented. This is resolved
> during planning, not assumed here.

It handles:

- challenge-in-body parsing (the v1 `accepts[]` shape)
- the v1 header convention (`X-PAYMENT`, `X-PAYMENT-RESPONSE`)
- **network format done right.** The upstream library's bug was a
  strict bare-name enum forcing a lossy rewrite. The v1 module instead
  keeps a clean two-way **CAIP-2 ↔ bare-name map**: it may use bare
  names internally where the v1 signing primitives require them, but
  the payload placed on the wire carries the network string the
  merchant advertised. This is the direct fix to `invalid_payload`.

## Error handling

Every failure returns a typed result — `{ ok: false, reason }` — never a
thrown crash that marks a resource dead. Reasons include
`unsupported_network`, `insufficient_funds`, `merchant_rejected`,
`timeout`. A wallet or chain-coverage gap returns `unsupported_network`,
not a generic failure.

This absorbs two known verifier bugs at no extra cost:

- **`invalid_payload`** — fixed: the v1 module signs against the
  merchant's real advertised network string; the rewrite hack is deleted
  with the old code.
- **Request-reuse crash** — fixed: the unified `payAndFetch` builds a
  fresh request object for every attempt (initial probe, paid retry,
  method-swap retry) by construction. No consumed request is ever
  reused.

## Migration sequence

1. **Build the SDK seam first** — `PaymentStrategy` interface,
   dispatcher, v1 module, v2 module. Each module is tested against real
   merchant fixtures (a real v1 402 response, a real v2 402 response)
   **before** anything depends on it.
2. **Migrate the paying files** — `tasks/verifier/payment.ts`,
   `routes/x402Pay.ts` — onto `payAndFetch`. Delete their version hacks.
3. **Migrate the server / charging files** —
   `dexterPaymentMiddleware.ts`, `registerX402.ts`, `x402Config.ts`,
   `routes/payments.ts`, `routes/tools/ai.ts` — onto the verify/settle
   side of the interface.
4. **Check and migrate `dexter-mcp`'s upstream `x402` usage.**
5. **Remove `x402` from every `package.json`.** Publish `@dexterai/x402`
   with the new v1 module.
6. **Verify** — typecheck and build every touched repo; run a real paid
   call against one live v1 merchant and one live v2 merchant; both must
   settle on-chain.

## Scope boundary

In scope: the `@dexterai/x402` SDK (new modules), the 8 `dexter-api`
files listed above, and `dexter-mcp`'s upstream `x402` dependency. The
upstream `x402` library is deleted everywhere.

Out of scope: the verifier catalog re-run itself (the ~$500–$2k sweep
that re-verifies ~30k resources). This project makes the verifier
*correct*; running it is the immediate next step after, tracked
separately.

## Success criteria

- The upstream `x402` library appears in zero `package.json` files in
  `dexter-api` and `dexter-mcp`.
- No file outside the SDK's dispatcher branches on x402 protocol
  version.
- The SDK pays a real v1 merchant and a real v2 merchant; both settle
  on-chain.
- The verifier's `invalid_payload` and Request-reuse failure modes no
  longer occur.
- Every touched repo typechecks and builds clean.
