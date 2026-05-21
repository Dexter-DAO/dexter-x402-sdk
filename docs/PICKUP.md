# PICKUP — post-compact resume document

**For:** a fresh Claude (or Branch) resuming after a `/compact`. Read this top
to bottom. It is self-contained — assume you remember nothing.
**Written:** 2026-05-21, end of a long session.
**`main` HEAD when written:** `0027873` (dexter-x402-sdk). Run `git log -1` to
see if anything moved since.

---

## 1. ONE-LINE STATE

The `@dexterai/x402` **3.9 SDK cycle is COMPLETE and 3.9.0 is PUBLISHED on
npm.** Nothing in the SDK repo is in flight. What remains is consumer-side
work (one OpenDexter fix) and low-priority cleanup — all logged in
`docs/FOLLOWUPS.md`. There is no broken thing demanding attention.

---

## 2. WHAT THIS SESSION DID (the whole arc)

The session started as an SDK cleanup/audit and grew. In order:

1. **3.9 deprecation + cleanup cycle.** Audited the SDK (`docs/AUDIT-2026-05-20.md`),
   planned it (`docs/PLAN.md`), and shipped 6 PRs:
   - PR 1 `1722506` — `@deprecated` JSDoc on 9 v1-era files (access-pass,
     dynamic-pricing, browser-support, stripe-payto, token-pricing,
     model-registry, useAccessPass → 4.0 horizon; wrap-fetch, x402-client →
     5.0 horizon).
   - PR 2 `d332b0e` — reorganized `client/index.ts`, promoted `payAndFetch`.
   - PR 3 `8d72512` — fixed `PayResult` returning a phantom `network` on
     unpaid responses; added the `paid: true | false` discriminator.
   - PR 4 `24b928d` — full README rewrite.
   - PR 5 `200be1d` + PR 6 `26658f8` — the **timeout double-charge fix**
     (see §3).
   - PR 7 (dep cleanup) was **dropped** — the audit's premise was wrong
     (see FOLLOWUPS F3).
   - PR 8 `b50349e` — **published 3.9.0**, tagged `v3.9.0`.

2. **Mid-cycle, a bake-off audit found a money-loss bug** (see §3) — it got
   inserted into the 3.9 cycle as PRs 5/6.

3. **Post-publish, ran the dexter-facilitator E2E scripts** to verify 3.9.
   That rabbit-holed into a refueler bug, a cross-chain bridge, and a
   batch-settlement smoke test. All resolved or logged — see §4 and §5.

---

## 3. THE MONEY-LOSS BUG (the timeout double-charge fix — SHIPPED)

The reason 3.9 grew. Full design: `docs/DESIGN-timeout-double-charge.md`.
Original report: `FINDINGS-pay-timeout-double-charge-2026-05-21.md`.

**The bug:** `payAndFetch` armed one 15s timeout over the whole paid call —
which covers BOTH the on-chain settlement AND the wait for the merchant's
response. A merchant slower than 15s (research/scout endpoints routinely
are) had its payment settle, then the abort fired, and `payAndFetch`
returned `{ ok: false, reason: 'timeout' }`. That reads as "safe to retry"
→ the agent retries → pays a SECOND time. Proven on Base mainnet (2 settled
$0.25 transfers reported as failures).

**The fix (PRs 5 + 6, shipped in 3.9.0):**
- Two-phase timeout: short pre-payment deadline (`timeoutMs`, 15s) for the
  probe/build/sign; long post-payment deadline (new `responseTimeoutMs`,
  120s) for the merchant-response wait.
- New `PayResult` reason `'payment_unconfirmed'` — payment was sent, may
  have settled, DO NOT blind-retry.
- `ok: true; paid: true` variant's `response` is now `Response | undefined`.
- On a post-payment timeout, the SDK confirms settlement **on-chain**
  (EVM EIP-3009 `authorizationState`, Permit2 `nonceBitmap`, Solana
  signature scan) and upgrades to a confirmed `paid: true` when the chain
  says it settled.
- Both v1 and v2 strategies fixed. 278 tests passing.

---

## 4. OPEN ITEMS — all in `docs/FOLLOWUPS.md` (F1–F6)

Read `docs/FOLLOWUPS.md` for full detail. Summary:

- **F1** — EVM pre-payment balance check isn't bounded by the pre-payment
  timeout signal. Low severity (no money at risk, just a possible hang).
  OPEN, unscheduled.
- **F2** — dexter-api verifier `PayResult` adaptation. **DONE** — the
  dexter-api agent shipped `ce9267e`.
- **F3** — `dexter-facilitator`'s `@dexterai/x402` pin. The audit said
  "drop it"; that was WRONG (3 `scripts/` files import it). The pin was
  bumped `^1.7.2 → ^3.9.0` this session. Effectively done.
- **F4** — dexter-api verifier crashes on a `U+0000` byte in a response
  body it stores to Postgres. Verifier-owner's bug, not the SDK's. OPEN.
- **F5** — the three dexter-facilitator E2E scripts on SDK 3.9. The
  batch-settlement one was run (see F6). The two Solana scripts
  (`test-smart-wallet-e2e`, `test-metaplex-core-e2e`) were NOT run.
- **F6** — batch-settlement smoke test. **RESOLVED, both failures
  explained, NOT real bugs** — see §5.

**The one consumer fix still genuinely worth doing (PR 9a):**
`opendexter-ide` `packages/x402-mcp-tools/src/tools/fetch.ts` — it renders
`payment_unconfirmed` as a generic "Payment failed" (which invites the
double-charging retry the SDK fix was meant to prevent) and reads
`payResult.response` unconditionally (crashes on `paid:true,
response:undefined`). 3.9 is published so this is now unblocked. Owned by
the OpenDexter side. NOTE: `dexter-mcp` is NOT a consumer — it uses
`wrapFetch`, which never exposes `PayResult`.

---

## 5. THE BATCH-SETTLEMENT SAGA — RESOLVED, nothing is broken

This ate a lot of the session. Final verdict: **the facilitator
settlement is fine; the SDK is fine.** Two smoke-test failures, neither a
real bug:

1. **Deposit dropped (first run).** Root cause: the `dexter-facilitator`
   PM2 process was running a `dist/` build from BEFORE the batch-settlement
   fixes landed (process up 22h, 0 restarts; `dist/` rebuilt later but
   never restarted onto). Branch's CLAUDE.md rule — always restart PM2
   after a build — had not been followed. **Fixed:** `npm run build` (clean
   tsc) + `pm2 restart dexter-facilitator`. Re-run then got all 3 paid
   calls to 200 and the $0.30 deposit landed on-chain.

2. **`close()` returned undefined tx hashes (second run).** NOT a bug. The
   buyer-side SDK `channel.close()` returns `CloseResult` (`{ closed: true }`)
   — by design it only deletes the local channel record; it is an intent
   signal, never settles, never calls the facilitator. Settlement (claim →
   settle → refund, which produces tx hashes / a `CloseReceipt`) is the
   SELLER's job. The smoke test
   `dexter-facilitator/scripts/batch-settlement-sdk-smoke.ts` reads
   `.claimTx/.settleTx/.refundTx` off `channel.close()`'s return value —
   wrong object — gets `undefined` — fails its own assertion.

**Only leftover:** a low-priority fix to that smoke-test script so it
verifies settlement via the seller (`seller.closeChannel()` / the
auto-settle loop), not the buyer's `close()`. It is a test harness, not
production.

---

## 6. THE POST-3.9 SKETCH — NOT committed work

`docs/PLAN.md` has a "post-3.9 sketch" section (PRs `R1`–`R5`) for
eventually removing the `@deprecated` v1-era helpers. It is a thinking-aid,
NOT a roadmap. Whether removals land as 3.10 / 4.0 / something else is
decided AFTER 3.9 has been in the wild. If you see "4.0" — placeholder
name, not a decided release. Do not start it without Branch saying so.

If the removal cycle IS taken up, the hard rules (from PLAN.md):
- No commit message disparages an old feature; frame forward.
- No removal until the dexter-lab agent-template references are updated
  (it emits `createDynamicPricing` / `x402AccessPass` / `x402BrowserSupport`
  / `createTokenPricing` / `MODEL_PRICING` in generated code — PLAN §D6).
- `model-registry.ts` / `stripe-payto.ts` / `token-pricing.ts` have
  internal SDK consumers — not deletable standalone. See AUDIT §0b.

---

## 7. WORKING-WITH-BRANCH NOTES (learned this session)

- Branch wants the actual answer, not hedging. Do not pad replies with
  context-budget worry — he finds it useless. Investigate, then state the
  finding plainly.
- "Did you or did you not document this" — keep the docs (FOLLOWUPS,
  PICKUP, PLAN) TRUE. A stale doc that says a fixed thing is broken, or an
  open thing is done, is worse than no doc. When a finding changes, edit
  the doc you already wrote — immediately.
- Verify before asserting. The audit was wrong 3 times this session
  (sponsored-access, model-registry, the dexter-facilitator dep). Grep /
  read / check on-chain before claiming.
- A literal `U+0000` byte once corrupted FOLLOWUPS.md (git flagged it
  binary). When writing about NUL bytes, refer to them by code-point name
  only — never paste the byte.

---

## 8. IMMEDIATE NEXT ACTION (if Branch says "keep going")

There is no urgent broken thing. In rough priority:

1. **PR 9a** — fix `opendexter-ide` x402-mcp-tools `fetch.ts` to handle
   `payment_unconfirmed` + the `response: undefined` shape. Unblocked
   (3.9 published). This is the last piece of the money-loss fix actually
   reaching agents. (May be owned by the OpenDexter agent — confirm.)
2. The smoke-test script fix (F6 leftover) — low priority.
3. The two un-run Solana E2E scripts (F5) — verification, not a fix.

Otherwise: the 3.9 cycle is genuinely done. Ask Branch what he wants next.

---

*Everything in this document is committed to `main` as of `0027873`. The
docs (`AUDIT-2026-05-20.md`, `PLAN.md`, `DESIGN-timeout-double-charge.md`,
`FOLLOWUPS.md`, this file) are the source of truth — read them, trust them,
keep them true.*
