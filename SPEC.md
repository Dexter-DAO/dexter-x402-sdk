# Dexter x402 v2 SDK — Spec + Build Brief

Purpose: define a **clean, correct, developer‑friendly** SDK for Dexter's x402
v2 Solana payments (header‑based), so third parties can integrate in minutes
without mis‑implementing the protocol.

Status: Draft spec (authoritative for build). v2‑only.

---

## Progress Tracker

| Section | Status | Notes |
|---------|--------|-------|
| 1) Scope | ✅ Defined | — |
| 2) Non-goals | ✅ Defined | — |
| 3) Dexter-specific realities | ⚠️ Needs update | `X-X402-Version: 2` header may be removed (non-standard) |
| 4) Client API | 🔨 Scaffolded | `createX402Client()` stubbed, tx building TODO |
| 5) Server API | 🔨 Scaffolded | `createX402Server()` stubbed, verify/settle TODO |
| 6) Payload structure | ✅ Defined | Types implemented in `src/types.ts` |
| 7) Error handling | ✅ Defined | `X402Error` class + codes implemented |
| 8) Tests | ⏳ Not started | — |
| 9) Packaging | ✅ Done | `package.json`, `tsup`, builds to ESM+CJS |
| 10) Team ownership | ✅ Defined | — |
| 11) Acceptance criteria | ⏳ Pending | Need to validate against live endpoints |

---

## 1) Scope (what we are building)

Deliver a public SDK that wraps the **v2 header‑based** x402 flow:

- **Client SDK** (browser or Node):
  - One‑line setup that **auto‑handles 402**.
  - Reads **PAYMENT‑REQUIRED header**, signs with wallet, retries with
    **PAYMENT‑SIGNATURE**.
- **Server helper** (Node/Express/Next/Fastify):
  - Create correct **PaymentRequirements** for Dexter v2.
  - Provide a helper to **verify + settle** via the facilitator.

We are **not** shipping a facilitator in this SDK.

---

## 2) Non‑goals

- No v1 support (no `X‑PAYMENT`).
- No managed‑wallet flow.
- No auto‑payment on chains other than Solana.
- No UI components (SDK only).

---

## 3) Dexter‑specific realities the SDK must respect

- **~~v2 opt‑in header is required~~** *(under review)*:
  - ~~Clients must send `X‑X402‑Version: 2` on the initial request to
    hit v2 routes in dexter‑api.~~
  - **UPDATE:** This header requirement is being reconsidered since it's
    non-standard. The SDK should be prepared to work without it.
- **402 details are delivered via header**:
  - Dexter v2 uses `PAYMENT‑REQUIRED` header; body can be `{}`.
- **Payment signature header is `PAYMENT‑SIGNATURE`** (not `X‑PAYMENT`).
- **Decimals are in `accepts[].price.extra.decimals`** in v2.
- **feePayer is required** in `accepts[].extra.feePayer`.

---

## 4) API Surface (Client)

### 4.1 Primary API

```ts
import { createX402Client } from '@dexter/x402-solana/client';

const client = createX402Client({
  wallet,               // wallet adapter with signTransaction
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  rpcUrl,               // optional
  maxAmountAtomic,      // optional: cap in smallest units
  fetch,                // optional: custom fetch (proxy/CORS)
  verbose,              // optional
});

const res = await client.fetch('https://api.dexter.cash/api/shield/create', {
  method: 'POST',
  headers: { 'X-X402-Version': '2', 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
```

### 4.2 Required behavior

On a 402:
- Read `PAYMENT‑REQUIRED` header.
- Decode and select a **Solana exact** requirement.
- Validate:
  - `amount` <= `maxAmountAtomic` (if provided).
  - `price.extra.decimals` present (required for TransferChecked).
- Build and sign a **TransferChecked** transaction:
  - ComputeBudget **setComputeUnitLimit** (default 12,000).
  - ComputeBudget **setComputeUnitPrice** (default 1 µlamport).
  - `payer` = `feePayer` from requirements.
  - `source ATA` = user ATA for mint.
  - `dest ATA` = payTo ATA for mint.
- Retry with `PAYMENT‑SIGNATURE` header.

### 4.3 Default constants

- **computeUnitLimit**: 12,000
- **computeUnitPrice**: 1 µlamport
- **maxTimeoutSeconds**: from requirements (server supplied)

The SDK must allow overrides, but defaults must be safe under Dexter policy.

---

## 5) API Surface (Server)

### 5.1 Payment requirement builder

```ts
import { createX402Server } from '@dexter/x402-solana/server';

const server = createX402Server({
  facilitatorUrl: 'https://x402.dexter.cash',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  payTo: 'DevFFy...',
  asset: { mint: 'EPjFW...', decimals: 6 },
  defaultTimeoutSeconds: 60,
});

const reqs = server.buildRequirements({
  amountAtomic: '30000',
  resourceUrl: 'https://api.dexter.cash/api/shield/create',
  description: 'Create Dexter Shield session',
  mimeType: 'application/json',
});
```

### 5.2 402 response helper

The server helper must generate:

- `PAYMENT‑REQUIRED` header containing the v2 PaymentRequired payload.
- Body `{}` or an optional JSON payload.

### 5.3 Verify + Settle helpers

Provide methods to:
- `verifyPayment(paymentSignatureHeader, requirements)`
- `settlePayment(paymentSignatureHeader, requirements)`

These are thin wrappers around the facilitator `/verify` and `/settle`.

---

## 6) Correct v2 payload structure

### 6.1 PaymentRequired (header)

```
{
  x402Version: 2,
  resource: { url, description, mimeType },
  accepts: [
    {
      scheme: "exact",
      network: "solana:5eykt4...",
      amount: "30000",
      asset: "EPjFW...",
      payTo: "DevFFy...",
      maxTimeoutSeconds: 60,
      extra: { feePayer: "...", decimals: 6 }
    }
  ],
  error: "Payment required"
}
```

### 6.2 PaymentSignature (retry header)

```
{
  x402Version: 2,
  resource: { url, description, mimeType },
  accepted: <one of accepts[]>,
  payload: { transaction: "<base64 tx>" }
}
```

---

## 7) Error handling contract

### Client SDK errors (examples)

- `missing_payment_required_header`
- `unsupported_network`
- `missing_fee_payer`
- `missing_decimals`
- `amount_exceeds_max`
- `wallet_missing_sign_transaction`
- `transaction_build_failed`

### Server helper errors (examples)

- `invalid_payment_signature`
- `facilitator_verify_failed`
- `facilitator_settle_failed`
- `no_matching_requirement`

---

## 8) Tests (required)

- **Unit**: header encode/decode (PAYMENT‑REQUIRED / PAYMENT‑SIGNATURE).
- **Unit**: transaction builder produces correct ComputeBudget + TransferChecked.
- **Unit**: `maxAmountAtomic` enforcement.
- **Integration**: real call to `https://api.dexter.cash/api/shield/create`
  using v2 flow (skippable in CI).

---

## 9) Packaging + Docs

- Package name: `@dexter/x402-solana`
- Entry points:
  - `@dexter/x402-solana/client`
  - `@dexter/x402-solana/server`
- README with 5‑minute setup.
- Example apps:
  - React wallet‑pay demo
  - Express server example

---

## 10) Team ownership (recommended)

- **Backend/facilitator**: spec correctness + server helper + docs.
- **Frontend**: client SDK wrapper + wallet adapters + example UI.
- **Shared**: integration tests + release checklist.

---

## 11) Acceptance criteria (must pass)

- Works with Dexter v2 endpoints without manual header hacks.
- ~~Sends `X‑X402‑Version: 2` on initial request.~~ *(under review — may not be required)*
- Uses `PAYMENT‑REQUIRED` header (not body).
- Retries with `PAYMENT‑SIGNATURE`.
- No reliance on v1 (`X‑PAYMENT`).

