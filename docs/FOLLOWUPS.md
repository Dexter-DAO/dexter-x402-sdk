# Follow-ups — found, deferred, not lost

Issues discovered while doing other work, deliberately NOT fixed in the PR
that found them (to keep that PR scoped), and parked here so they survive a
context reset. Each entry says what it is, why it was deferred, and what
fixing it would take.

This file is the durable record. "I'm keeping track of it" in a chat message
is not tracking — this is.

---

## F1 — The EVM pre-payment balance check is not covered by the pre-payment timeout

**Found:** 2026-05-21, while implementing PR 5 (two-phase timeout). A test mock
that hung on every `fetch` revealed it.

**What it is:** `payAndFetch` → `v2-strategy.ts` → `createX402Client` →
`x402-client.ts` runs an ERC-20 balance check (`adapter.getBalance`,
`x402-client.ts` ~line 711) *before* signing and sending the payment. That
check makes its own `fetch` to an RPC endpoint (`evm.ts` ~line 251,
`eth_call`). It does **not** receive the composed abort signal that the
two-phase timeout arms — it uses the adapter's own RPC path.

**Consequence:** if the RPC endpoint hangs, the pre-payment phase runs
unbounded. The `timeoutMs` (15s) pre-payment deadline does not bound it. A
slow/dead RPC can hang `payAndFetch` well past 15s before any payment is even
attempted.

**Severity:** low–moderate. It is not the double-charge bug — no money is at
risk here, the payment hasn't been built yet. Worst case is a hung call, not
a lost or mis-reported payment. But it undercuts the "pre-payment phase has a
short, honest deadline" guarantee PR 5 advertises.

**Why deferred:** it is a distinct defect from the double-charge. Folding an
RPC-timeout fix into PR 5 (or PR 6) would be scope creep on a money-loss fix.

**What fixing it takes:** thread the pre-payment abort signal (or a derived
RPC timeout) into `adapter.getBalance` so the `eth_call` fetch is bounded.
`getBalance`'s signature would need to accept an optional `AbortSignal`, or
the adapter's RPC helper would need its own timeout. Small, contained — but
it touches the `ChainAdapter` surface, so it deserves its own PR, not a
silent rider.

**Status:** OPEN. Not scheduled. Candidate for the 3.9 cycle if cheap, or a
fast-follow after publish.

---

## F2 — dexter-api verifier must adapt to the new `PayResult` shape (PR 9b)

**Found:** 2026-05-21, while scoping the `payment_unconfirmed` consumer fixes.

**What it is:** `dexter-api/src/tasks/verifier/payment.ts` is one of the two
real `payAndFetch` consumers. PR 5 + PR 6 changed the `PayResult` contract:
the `ok: true; paid: true` branch's `response` is now `Response | undefined`
(a confirmed-but-unanswered payment has no response body), and there is a new
`ok: false` reason `'payment_unconfirmed'`. The verifier does not handle
either:

- `r.response.status` at the 405-retry check (~line 215) crashes when
  `response` is `undefined`.
- Every post-result read (`response.headers.get`, `response.arrayBuffer()`,
  `response.ok` — roughly lines 267-317) assumes a defined `Response`.

**Correct behavior:** the verifier is an automated endpoint quality-tester,
not an interactive agent. A `payment_unconfirmed` outcome, or a confirmed
`paid: true` with `response: undefined`, means the merchant took the money
and returned nothing — that is a **failed verification of the endpoint**. It
should be recorded as a verification failure (and NOT scored as a healthy
endpoint), not crashed.

**Severity:** moderate. Until fixed, a slow merchant in a verifier run can
crash the task or mis-score the endpoint.

**Why deferred:** it is a consumer fix and cannot typecheck until
`@dexterai/x402@3.9` is published — the new types do not exist before then.
It is PR 9b in `docs/PLAN.md`.

**OWNER:** the OpenDexter / dexter-api agent (NOT the SDK agent). Confirmed
in the 2026-05-21 coordination thread — that agent is already working in
`dexter-api` on the learned-input / service-profile wiring, so it holds PR
9b. The SDK agent's job ends at publishing 3.9.

**Status:** OPEN, OWNED, BLOCKED on `@dexterai/x402@3.9` being on npm. Full
spec in `docs/PLAN.md` (PR 9b) and `docs/DESIGN-timeout-double-charge.md`.

---

## F3 — `dexter-facilitator` SDK pin is stale text; do NOT drop the dependency

**Found:** 2026-05-21, while scoping PR 7 (consumer dep cleanup).

**What it is:** the SDK audit claimed `dexter-facilitator`'s `@dexterai/x402`
dependency was "not imported in source — drop it." That is **wrong**. Three
`scripts/` files import it:

- `scripts/test-smart-wallet-e2e.mjs` (git-tracked) — `@dexterai/x402/client`
- `scripts/test-metaplex-core-e2e.mjs` (git-tracked) — `@dexterai/x402/client`
- `scripts/batch-settlement-sdk-smoke.ts` (untracked local file) — `@dexterai/x402/batch-settlement`

The `package.json` pin reads `^1.7.2` but `node_modules` has `3.3.0` (the `^`
resolved forward). So the pin *number* is misleading stale text; the
dependency itself is real and used.

**What NOT to do:** do not drop the dependency. It breaks two git-tracked
E2E scripts.

**What to do (low priority):** bump the pin `^1.7.2` → `^3.8.x` (or `^3.9.x`
once 3.9 is published) so the pin text matches reality. The scripts use
`createKeypairWallet`, `wrapFetch`, `SOLANA_MAINNET`, `openBatchChannel` —
all still exported by 3.8+. A bump cannot break the imports. NOT verified by
running the scripts (they hit mainnet).

**Why deferred:** pure cosmetic hygiene. Nothing depends on it. It is not on
the critical path to the 3.9 publish. PR 7 was dropped from the 3.9 cycle
for exactly this reason — see PLAN.md.

**Status:** OPEN, low priority, unowned. Fast-follow whenever convenient.

---

*Add new entries as `F4`, `F5`, … Keep each one self-contained — assume the
reader has zero context.*
