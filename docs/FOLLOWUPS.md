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

*Add new entries as `F2`, `F3`, … Keep each one self-contained — assume the
reader has zero context.*
