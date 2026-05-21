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

## F2 — dexter-api verifier must adapt to the new `PayResult` shape (PR 9b) — ✅ DONE

**Resolved:** 2026-05-21, commit `ce9267e` in `dexter-api`
(`fix(verifier): adapt payment.ts to x402 3.9 PayResult contract`). The
verifier now guards `r.response` before reading it, has an explicit
`payment_unconfirmed` branch, handles the `!result.response` and
`!result.paid` cases, and the SDK pin is bumped to `^3.9.0`. No action
remaining. Kept here for the record.

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

## F4 — dexter-api verifier: a NUL byte breaks the Postgres write

**Found:** 2026-05-21, while debugging the refueler (unrelated subsystem, same
PM2 log stream).

**What it is:** `dexter-api`'s verifier task stores a paid endpoint's response
body into Postgres. When that body contains a NUL byte — the Unicode code
point `U+0000` — the write fails:
`PostgresError 22P05 — unsupported Unicode escape sequence, cannot be
converted to text`. Tagged `verifier-threw` / `resource-verification-error`
in the logs. It is spamming the dexter-api log stream.

(Note: this FOLLOWUPS.md file itself was briefly corrupted on 2026-05-21
because an earlier edit wrote a real `U+0000` byte into this very entry,
flipping git to binary-diff mode. Refer to the NUL by code-point name only;
never paste the literal byte.)

**Where:** the verifier response-storage path — `src/tasks/verifier/payment.ts`
builds `storedResponse` (~line 294) from `classified.summary`; that string
reaches a Prisma write somewhere downstream with the NUL byte intact.
`src/tasks/verifier/types.ts` already contains null-stripping logic, so a
fix attempt exists but does not cover this path.

**Severity:** moderate. The verification result for that endpoint is lost
(the write throws), and the log noise obscures real errors.

**Why not fixed here:** it is a verifier bug, a different subsystem from the
refueler work that surfaced it. The dexter-api / OpenDexter agent owns the
verifier (they shipped `ce9267e` fixing `payment.ts` for the 3.9 contract).
Fixing it means finding which write path skips the existing `types.ts`
null-strip and routing it through the sanitizer.

**Status:** OPEN. Belongs to the dexter-api / verifier owner, not the SDK
agent.

---

## F5 — dexter-facilitator E2E scripts not yet verified on SDK 3.9

**Found:** 2026-05-21, while running the E2E scripts after the 3.9 publish.

**What it is:** `dexter-facilitator/scripts/` has three scripts that import
`@dexterai/x402`: `test-smart-wallet-e2e.mjs`, `test-metaplex-core-e2e.mjs`,
`batch-settlement-sdk-smoke.ts`. The SDK pin was bumped `^1.7.2 → ^3.9.0`
and `node_modules` now has 3.9.0. Import resolution verified (all needed
exports present on 3.9).

`batch-settlement-sdk-smoke.ts` was run end-to-end on Base mainnet: the SDK
3.9 batch-settlement client worked correctly through every step (channel
created, 402 parsed, payment header built, request sent). It FAILED only
because the test buyer wallet `0x7e571E959cC7C75Ccdd2eAC24f8775ea2eAa2F09`
was empty ($0.0004 USDC, needs $0.30) — a funding problem, not a code
problem. See F-note below: that wallet is a refueler destination
(`base`/`verifier`/`usdc`) and was empty because the refueler source wallet
was itself out of USDC.

The other two scripts (`test-smart-wallet-e2e`, `test-metaplex-core-e2e` —
Solana mainnet) have NOT been run on 3.9 yet.

**What's left:** once the refueler source wallet
(`DeXXoNdyKk7fEJkoTDkfVwCe8j8hjXxsPGLdk31gJsMk`) is funded and the Base test
wallet refills, re-run `batch-settlement-sdk-smoke.ts` to confirm a green
end-to-end pass. Then run the two Solana scripts and fix whatever each
surfaces.

**Status:** OPEN. Blocked on the refueler source wallet being funded.

UPDATE 2026-05-21: the refueler source wallet was funded; `batch-settlement-sdk-smoke.ts`
was re-run against a funded Base wallet ($31.45 USDC). It got further —
the SDK 3.9 batch-settlement client opened the channel, parsed the 402,
built the payment header, and the facilitator VERIFIED it (`payment-verified`).
It then failed at the on-chain deposit step. That failure is now its own
entry — see **F6**. The SDK 3.9 client side is verified working up to the
point the facilitator takes over; the two Solana E2E scripts
(`test-smart-wallet-e2e`, `test-metaplex-core-e2e`) still have not been run.

---

## F6 — Batch-settlement smoke test failures — RESOLVED (not real bugs)

> **UPDATE 2026-05-21 — both failures explained; nothing wrong with the SDK or facilitator settlement.**
> The deposit failure below was caused by a **stale facilitator process**, NOT
> nonceManager drift. The running `dexter-facilitator` PM2 process was created
> `2026-05-19 01:55` and ran 22h with 0 restarts; `dist/` was rebuilt
> `2026-05-20 04:41` (picking up the batch-settlement fixes `c613a9df`,
> `c35f9ba9`, `2293baab`, `92255c7a`) but the process was **never restarted**.
> It executed pre-fix code. Rebuilding (`npm run build`, clean tsc) and
> `pm2 restart dexter-facilitator` fixed it.
>
> Re-run after restart: **all 3 paid `channel.fetch()` calls returned 200**,
> the buyer's $0.30 deposit landed on-chain (buyer balance -0.30 USDC),
> channel state tracked correctly (`deposited 0.3, spent 0.24, remaining
> 0.06`). The deposit + paid-call path is now PROVEN working on the live
> facilitator.
>
> **The "settle failure" that looked new is NOT a bug — it is the smoke test
> misusing the SDK API.** Diagnosed 2026-05-21 (corrects an earlier wrong
> entry here that called it an undiagnosed `@x402/evm` settle-path bug):
>
> - The buyer-side SDK `channel.close()` returns `CloseResult` —
>   `{ closed: true }`. By design it does ONE thing: deletes the channel
>   from local storage. It is an *intent signal*. It does NOT claim, settle,
>   or refund, and it never calls the facilitator. (Confirmed in the
>   compiled SDK: `close(){ ... n.delete(...), {closed:!0} }`. Confirmed in
>   the README: "this is an intent signal, not a settlement; it does not
>   move funds.")
> - Settlement (claim → settle → refund, which DOES produce on-chain tx
>   hashes and a `CloseReceipt`) is the **seller's** job — the
>   `createBatchSettlementSeller` background loop, or `seller.closeChannel()`
>   / `seller.closeAll()`.
> - `batch-settlement-sdk-smoke.ts` (~line 378) does `receipt = await
>   channel.close()` then reads `receipt.claimTx` / `.settleTx` /
>   `.refundTx`. Those fields belong to `CloseReceipt` (seller side), not to
>   the `CloseResult` the buyer's `close()` actually returns — so they are
>   `undefined`, and the script fails its own assertion. The facilitator
>   correctly logged no batch claim/settle because the buyer's `close()`,
>   correctly, never asked it to.
>
> **Net: nothing is wrong with the facilitator settlement.** The deposit +
> paid-call path is proven working (above). The buyer `close()` works as
> designed. The defect is in the smoke-test script — it checks the wrong
> object for tx hashes. To verify settlement end-to-end the script must
> drive the SELLER (`seller.closeChannel()` / the auto-settle loop) and
> check the seller's on-chain USDC collection, not the buyer's `close()`
> return value.
>
> **F6 is effectively CLOSED as a facilitator/SDK bug.** What remains is a
> script fix in `dexter-facilitator/scripts/batch-settlement-sdk-smoke.ts`
> (low priority — it is a test harness). The two-hypotheses analysis below
> (nonceManager drift vs. `@x402/evm` broadcast-error) is moot: the deposit
> root cause was the un-restarted process; the "settle failure" was the
> script. Kept below only as a record of the investigation.

**Found:** 2026-05-21, running `batch-settlement-sdk-smoke.ts` against a
funded Base wallet (the F5 re-run).

**This is NOT an `@dexterai/x402` SDK bug and NOT a regression from the 3.9
cycle.** The 3.9 timeout fix lives in `payment/` (the `payAndFetch` path).
Batch-settlement is a separate, thin re-export of upstream `@x402/evm`. The
3.9 work never touched this path. This entry is logged here only because the
investigation started from the SDK E2E scripts; the actual defect is in
`dexter-facilitator` and/or upstream `@x402/evm`.

### What happened

The smoke test's first paid `channel.fetch()`:
1. SDK opened the channel, parsed the 402, built the payment header — all OK.
2. Facilitator VERIFIED the payment (`result.type=payment-verified`).
3. Facilitator submitted the on-chain escrow **deposit** transaction
   (`0x19db55f7cf0238829f27c0d9a880ea1564b1c3fecfca4c7d3d2888c346f926e4`).
4. Facilitator returned `invalid_batch_settlement_evm_deposit_transaction_failed`
   — *"Timed out while waiting for transaction … to be confirmed."*
5. Upstream `@x402/evm`'s batch-settlement client then **crashed** parsing
   that error response — `TypeError: Cannot read properties of undefined
   (reading 'toLowerCase')` at
   `@x402/evm/src/batch-settlement/client/channel.ts:97`. The error response
   carries `transaction: ""` and a downstream field is undefined.

### On-chain evidence (all verified, Base mainnet)

- Deposit tx `0x19db55f7…` is in **no block** — `getTransactionReceipt` →
  not found.
- Facilitator fee-payer `0x402Feee072D655B85e08f1751AF9ddbCd249521f`:
  nonce `latest` == `pending` == `15477` — **no nonce consumed, nothing
  stuck pending**. The deposit never entered the mempool.
- Fee-payer has ETH (~0.0026 ETH, ~$8-10) — gas is not the problem.
- Facilitator: up 22h, 0 restarts — the in-process `nonceManager` counter
  is not stale from a restart.
- Facilitator and the smoke test use the **same** Base RPC (QuikNode
  `maximum-delicate-flower…`) — not an RPC-mismatch.
- Buyer balance unchanged before/after ($31.45) — no money moved.
- The facilitator logs the final `EVM_SETTLE_RESULT_FAIL` but logs
  **nothing** about the deposit broadcast — that `@x402/evm` code path is
  silent.

### Two surviving hypotheses (cannot be distinguished from outside the process)

1. **`nonceManager` drift.** The facilitator builds the fee-payer account
   with viem's in-process `nonceManager` (`server.ts:520`,
   `batchSettlementRegistration.ts:199-204`). That counter is shared per
   `(address, chain)` across the regular/upto AND batch-settlement schemes.
   If anything ever submitted a tx from `0x402F…` *outside* that counter,
   the in-memory nonce diverges from chain; the deposit gets signed with a
   stale/used nonce, `eth_sendRawTransaction` is rejected, viem still has a
   hash, `waitForTransactionReceipt` times out on a hash that was never
   accepted. The `batchSettlementRegistration.ts` doc comment explicitly
   flags the assumption: *"Correct while exactly one facilitator process
   owns the fee-payer key."*
2. **`@x402/evm` swallows a broadcast error.** Upstream's batch-settlement
   facilitator code submits the deposit, `eth_sendRawTransaction` errors,
   and `@x402/evm` does not surface it (we have already SEEN `@x402/evm`
   mishandle its own error path — the `channel.ts:97` crash above). Same
   observable symptoms.

Both fit every piece of evidence. Distinguishing them needs the running
facilitator instrumented (log the deposit-path `eth_sendRawTransaction`
call + result) and the failure reproduced.

### Confirmed-real sub-bug (independent of the root cause)

`@x402/evm`'s batch-settlement client crashes on its OWN error path —
`channel.ts:97` calls `.toLowerCase()` on an undefined field when the
settle response is error-shaped (`transaction: ""`). This is an upstream
`@x402/evm` bug; it should be reported upstream regardless of what caused
the deposit to drop. It turns a clean facilitator error into an unhandled
`TypeError` in the consumer.

### What it would take

1. Instrument `dexter-facilitator`'s batch-settlement deposit path to log
   the `eth_sendRawTransaction` call + raw node response. Reproduce. This
   touches a LIVE payment service and needs a restart — deliberate session,
   not a tail-end patch.
2. If hypothesis 1: move the fee-payer nonce source on-chain for that
   account (or otherwise guarantee single-owner nonce truth).
3. If hypothesis 2: file/patch the `@x402/evm` upstream bug.
4. Either way: file the `channel.ts:97` `.toLowerCase()` crash upstream.

### Severity

Moderate-to-high — batch-settlement deposits are currently failing on the
facilitator for Base. But it is a pre-existing facilitator/upstream issue,
not caused by and not blocking the 3.9 SDK release.

**Status:** RESOLVED — see the UPDATE block at the top of this entry. The
deposit failure was a stale facilitator process (fixed: rebuild + restart).
The "settle failure" was the smoke test misreading `channel.close()`'s
return type — not a real bug. Only remaining item: a low-priority fix to
`dexter-facilitator/scripts/batch-settlement-sdk-smoke.ts` so it verifies
settlement via the seller instead of the buyer's `close()`.

---

*Add new entries as `F7`, `F8`, … Keep each one self-contained — assume the
reader has zero context.*
