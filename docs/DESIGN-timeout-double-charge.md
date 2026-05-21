# Design — fixing the `payAndFetch` timeout double-charge

**Status:** DRAFT — design locked, not yet implemented. Internal planning.
**Companion:** [FINDINGS-pay-timeout-double-charge-2026-05-21.md](../FINDINGS-pay-timeout-double-charge-2026-05-21.md) — the bug report this fixes. Read it first.
**Created:** 2026-05-21.

---

## The bug, in one paragraph

`payAndFetch` arms a single 15s `AbortController` (`v2-strategy.ts:104`) that governs the entire `client.fetch()` call. That call internally probes the endpoint, signs an EIP-3009 payment authorization, sends it as a `PAYMENT-SIGNATURE` header, and awaits the merchant's response. The facilitator settles the on-chain USDC transfer within seconds of receiving that header; a slow merchant (research/scout/agent endpoints routinely take >15s) is still computing when the 15s deadline fires. The abort throws `AbortError`, and `v2-strategy.ts:163-164` returns `{ ok: false, reason: 'timeout' }` — with no consultation of settlement state. The money is on-chain. The SDK says it failed. `x402-mcp-tools` renders `Payment failed: timeout`, which an agent reads as "safe to retry," so it retries and pays a second time. Proven on Base mainnet: two $0.25 settled transfers, same recipient, 9 blocks apart, both reported as failures.

The facilitator in the reported incident was **Coinbase**, not Dexter's — so there is no facilitator-side fix. The SDK is the only place this can be corrected.

---

## Locked decisions

### D1. `payment_unconfirmed` is a new `ok: false` reason — not a fourth `PayResult` variant

`PayResult`'s `ok: false` branch gains one reason:

```ts
| 'payment_unconfirmed'  // The payment authorization was sent to the merchant.
                         // The merchant did not respond before the deadline,
                         // AND the SDK could not confirm settlement on-chain.
                         // The payment MAY have settled. DO NOT blind-retry.
```

**Why a reason and not a variant:** consumers already `switch` on `result.reason`. A fourth top-level variant forces every consumer to re-narrow `PayResult`. `payment_unconfirmed` is semantically a non-success outcome — there is no usable `response` — so it belongs on the `ok: false` side. Its `detail` field will carry an explicit "money likely moved, do not retry, check your wallet" message so it never reads like `timeout`.

This is a third axis layered on the PR 3 work: PR 3 added `paid: true | false` to the `ok: true` branch. This adds `payment_unconfirmed` to the `ok: false` branch. They do not interact.

### D2. The timeout is split into two phases

| Phase | What it covers | Deadline |
|---|---|---|
| Pre-payment | The unpaid probe + build/sign. No money committed. | Short — keep 15s (generous for a probe). |
| Post-payment | The wait for the merchant's response after `PAYMENT-SIGNATURE` was sent. | **120s.** |

**Why 120s:** long enough for any honest research/scout endpoint, short enough that an agent is never hung indefinitely. Once payment is dispatched, aborting the wait does not un-spend the money — there is no value in being aggressive, only downside (the lie). 120s is the ceiling before the SDK gives up waiting and runs the chain check.

`opts.timeoutMs`, when a caller sets it, applies to the **pre-payment** phase only. A new `opts.responseTimeoutMs` (default 120000) governs the post-payment phase. Callers that want the old single-deadline behavior do not get it back — the split is the fix.

### D3. On a post-payment abort, the SDK confirms settlement on-chain before returning

This is the core of the fix. When the post-payment deadline fires, the SDK does NOT immediately return `payment_unconfirmed`. It runs a per-chain settlement check using the funded RPC endpoints, then returns:

- **Settled** → `{ ok: true, paid: true, response: undefined, amountPaid, network, txSignature? }` — "you paid, here is proof, the merchant simply never answered." The agent knows, does not retry, spend is accounted.
- **Not settled** (or the chain check itself failed) → `{ ok: false, reason: 'payment_unconfirmed', detail }`.

`payment_unconfirmed` therefore shrinks from "every slow merchant" to "the chain RPC also failed, or settlement is genuinely stuck" — rare.

Note the settled case returns `paid: true` with `response: undefined`. This is a new shape: a paid result with no merchant response body. The `ok: true; paid: true` variant's `response` field becomes `Response | undefined`. Callers reading `response` on a paid result must tolerate `undefined` (it means "paid, but the merchant never delivered"). This is honest — the alternative is fabricating a response.

### D4. Chain confirmation is per-adapter, via a new `ChainAdapter.confirmSettlement` method

A new optional method on the `ChainAdapter` interface:

```ts
confirmSettlement?(
  authorization: SettlementProbe,
  rpcUrl: string,
): Promise<{ settled: boolean; txSignature?: string }>;
```

`SettlementProbe` carries whatever the adapter needs to identify its own payment (the EVM adapter put the nonce there; the Solana adapter put the source/dest ATA + amount + blockhash). The strategy calls it on a post-payment abort. An adapter that does not implement it (or a scheme it cannot confirm) means the strategy falls back to `payment_unconfirmed` — graceful.

Per-chain capability, graded honestly:

| Chain / scheme | Confirmation mechanism | Quality |
|---|---|---|
| **EVM EIP-3009** (default `exact`) | `USDC.authorizationState(from, nonce) → bool`. One `eth_call`. The nonce is a 32-byte value the SDK itself generated (`evm.ts:359-362`). | **Authoritative, surgical.** Unique nonce, definitive yes/no. |
| EVM Permit2 | `Permit2.nonceBitmap(from, wordPos)` bit check. Permit2 has its own nonce (`evm.ts:672-674`). | Authoritative, slightly more code. |
| EVM exact-approval (BSC) | No clean nonce-based check (plain `approve` + facilitator pull). | Defensive — falls back to `payment_unconfirmed`. |
| **Solana** | `getSignaturesForAddress(destinationAta)`, filtered to the recording window, matched on amount + asset. Bounded tightly by the transaction's blockhash validity (~60s / ~150 slots). | **Strong, not surgical.** The blockhash window prevents a stale duplicate from matching. |

The m01 incident was EVM EIP-3009 on Base — the best-covered case.

### D5. No idempotency ledger

An earlier sketch proposed an in-memory `(url, payTo, amount)` ledger to block a blind retry. **Dropped.** With D3/D4 in place, an EVM retry can check "did my previous authorization's nonce settle" before signing a new one — the chain *is* the idempotency record. The ledger was a workaround for not having chain confirmation; we have it now. (A future PR could add a pre-payment "your last authorization to this endpoint is still unconfirmed — confirm or abort before paying again" guard, but it is not required for this fix and is out of scope here.)

---

## What changes, file by file

### `src/payment/types.ts`
- `PayResult` `ok: false` reason union gains `'payment_unconfirmed'`.
- `PayResult` `ok: true; paid: true` variant: `response` becomes `Response | undefined`.
- New `PayAndFetchOptions.responseTimeoutMs` (default 120000). Existing `timeoutMs` documented as pre-payment-phase only.
- New exported `SettlementProbe` type (the per-adapter confirmation payload).

### `src/adapters/types.ts`
- `ChainAdapter` gains the optional `confirmSettlement` method.
- `SignedTransaction` gains a `settlementProbe?: SettlementProbe` field so `buildTransaction` can hand the strategy what it needs to confirm later.

### `src/adapters/evm.ts`
- `buildTransaction` (EIP-3009 path) populates `settlementProbe` with `{ kind: 'eip3009', from, nonce, asset, chainId }`.
- New `confirmSettlement` implementation: `authorizationState` `eth_call`.
- Permit2 path: `settlementProbe` with the Permit2 nonce; `confirmSettlement` handles the bitmap check.
- exact-approval path: no `settlementProbe` — `confirmSettlement` returns `{ settled: false }` is wrong; it must signal "cannot confirm." Use `settlementProbe: undefined` and the strategy treats absent probe as "fall back to payment_unconfirmed."

### `src/adapters/solana.ts`
- `buildTransaction` populates `settlementProbe` with `{ kind: 'solana', sourceAta, destinationAta, asset, amount, blockhash }`.
- New `confirmSettlement`: `getSignaturesForAddress(destinationAta)` windowed scan.

### `src/payment/v2-strategy.ts`
- Replace the single `AbortController` with two-phase logic: a pre-payment controller (short) and a post-payment controller (`responseTimeoutMs`).
- Track `paymentDispatched: boolean` — set true the moment the `PAYMENT-SIGNATURE` request is sent.
- On `AbortError`:
  - `!paymentDispatched` → `{ ok: false, reason: 'timeout' }` (unchanged).
  - `paymentDispatched` → call `adapter.confirmSettlement(probe, rpcUrl)`:
    - `settled` → `{ ok: true, paid: true, response: undefined, amountPaid, network, txSignature }`.
    - not settled / no probe / confirm threw → `{ ok: false, reason: 'payment_unconfirmed', detail }`.

The hard part: `v2-strategy.ts` currently delegates the whole flow to `client.fetch()` (a `createX402Client` call), which hides the probe/pay seam. The strategy needs visibility into "payment header was sent." Two implementation options — to be decided at implementation time, not now:
  - **(a)** Thread a callback or shared flag through `createX402Client` so the client signals "payment dispatched."
  - **(b)** Have the strategy stop using `createX402Client` and drive the probe + pay steps itself (it already imports the adapters).
  Option (b) is cleaner long-term — `createX402Client` is `@deprecated` anyway — but bigger. Option (a) is smaller. This is a build-time call; flag it in the PR.

### `src/payment/v1-strategy.ts`
- Same two-phase + `confirmSettlement` treatment. v1 uses the same EVM/Solana adapters under the hood, so the chain-confirmation logic is shared; only the request/response framing differs.

### `@dexterai/x402-mcp-tools` (separate repo — `dexter-mcp`)
- The `x402_fetch` handler currently renders `Payment failed: ${payResult.reason}`. It must special-case `payment_unconfirmed`: render a message that says payment likely settled, the agent did NOT receive data, do NOT retry, check the wallet. And `{ ok: true, paid: true, response: undefined }` must be handled — a paid result with no body is not an error.

---

## PR sequence (slots into the 3.9 cycle)

These are PRs 5, 6, 7 of the 3.9 cycle in [PLAN.md](./PLAN.md).

| PR | Scope | Repo |
|---|---|---|
| **3.9 PR 5** | Stop the lie. Two-phase timeout + `paymentDispatched` tracking + `payment_unconfirmed` reason. No chain calls yet — a post-payment abort returns `payment_unconfirmed` unconditionally. This alone stops `x402-mcp-tools` printing "Payment failed" on a settled payment. | SDK |
| **3.9 PR 6** | Chain confirmation. `ChainAdapter.confirmSettlement`, the EVM + Solana implementations, `SettlementProbe` plumbing. Upgrades a post-payment abort from always-`payment_unconfirmed` to `paid: true` wherever the chain can confirm. | SDK |
| **3.9 PR 7** | `x402-mcp-tools` consumer fix — stop rendering `Payment failed:` for `payment_unconfirmed`; handle the `paid: true, response: undefined` shape. | dexter-mcp |

PR 5 and PR 6 both ship in the 3.9 cycle, before the 3.9.0 publish. PR 7 is a paired fix in `dexter-mcp` and can ship independently but should land close to PR 5.

This pushes the dep-cleanup PR and the publish PR back. 3.9 ships a few days later than the cleanup-then-publish path implied. The bug is a money-loss correctness defect on the happy path of an entire endpoint category — it ships in 3.9.

---

## Acceptance

- A merchant that responds in >15s but <120s: `payAndFetch` returns `{ ok: true, paid: true }` with the real response. No false timeout.
- A merchant that never responds, payment settled: `payAndFetch` returns `{ ok: true, paid: true, response: undefined, txSignature }`. Agent knows it paid, does not retry.
- A merchant that never responds, payment genuinely not settled: `{ ok: false, reason: 'payment_unconfirmed' }` with a detail that does not read as "failed."
- A pre-payment timeout (endpoint unreachable, slow to even 402): `{ ok: false, reason: 'timeout' }` — unchanged, still safe to retry.
- The m01 reproduction (EVM EIP-3009 on Base, >15s research endpoint) no longer double-charges: the first call returns `paid: true`, so no retry is triggered.
- Typecheck clean. Test suite green, with new coverage for each branch above.

---

*Design locked 2026-05-21. If a finding here turns out wrong during implementation, correct this doc first, then the PR.*
