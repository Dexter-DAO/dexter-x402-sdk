# Plan 1 — Immediate Resume (post-compact pickup)

**Written:** 2026-05-18, at the Task 7→8 boundary.
**Read this first on resume, then continue.**

---

## One-line state

Plan 1 (x402 version seam — SDK side + paying side) is **7 of 13 tasks
done**, all committed to `main` in `~/websites/dexter-x402-sdk`. Resume
at **Task 8**.

## What this project is

Consolidating x402 v1/v2 protocol handling — currently smeared across 8
`dexter-api` files via the upstream `x402` npm library — into ONE seam
inside the `@dexterai/x402` SDK. v1 and v2 are sealed strategy modules
behind a `PaymentStrategy` interface; a dispatcher owns version
detection. Fixes the verifier's `invalid_payload` bug (v1 network
rewrite) and Request-reuse crash. Upstream `x402` library gets deleted.

- **Spec:** `docs/superpowers/specs/2026-05-18-x402-version-seam-design.md`
- **Plan 1 (this one):** `docs/superpowers/plans/2026-05-18-x402-version-seam-plan-1-paying-side.md`
- **Plan 2** (server side + dexter-mcp) — not yet written; comes after Plan 1.

## Execution settings (locked with the user — do not re-ask)

- **Commit straight to `main`** in both `dexter-x402-sdk` and `dexter-api`.
  No feature branches (user's standing rule).
- **Subagent-driven**: per task — dispatch implementer, then spec
  reviewer, then code-quality reviewer; loop fixes; mark done. Skill:
  `superpowers:subagent-driven-development`. Provide subagents the full
  task text from the plan file — never make them read the plan.
- Model selection: mechanical tasks → haiku; integration → sonnet;
  the one crypto/judgment task (was Task 7) → opus. Reviewers: spec →
  haiku/sonnet, code-quality → sonnet (opus for crypto).
- **PAUSE before Task 9** — Task 9 does `npm publish` of `@dexterai/x402`
  3.5.0. Publishing is outward-facing/irreversible — get the user's
  explicit go-ahead before running Task 9, then continue 9→13.
- No database migration anywhere in Plan 1 (checked) — so subagents run
  every task; nothing needs the user to run it personally.

## Tasks DONE (7/13) — all committed to dexter-x402-sdk main

| # | What | Commits |
|---|------|---------|
| 1 | `src/payment/types.ts` — PaymentStrategy interface + shared types | `813acf5`, `94be9fe` |
| 2 | `src/payment/network-map.ts` — lossless CAIP-2↔bare map | `b039788`, `bcd743d` |
| 3 | `src/payment/__tests__/fixtures.ts` — v1/v2/empty 402 fixtures | `771dfa1` |
| 4 | `src/payment/v2-strategy.ts` — v2 parseChallenge (pay stubbed) | `3555051` |
| 5 | v2 strategy `pay` — delegates to `createX402Client` | `e42fef6`, `cb10485` |
| 6 | `src/payment/v1-strategy.ts` — v1 parseChallenge (pay stubbed) | `160743b` |
| 7 | v1 strategy `pay` — new EIP-3009 signing, no network rewrite | `4ac980e`, `f1858c9` |

Full SDK test suite green at Task 7 close: **204/204**, `tsc --noEmit`
clean. Each task passed spec-compliance + code-quality review.

### Verified deviations from the plan (already reviewed — sound, keep)

- **Task 5:** plan said delegate v2 pay to `wrapFetch`; implementer used
  `createX402Client` instead. Verified legitimate — `wrapFetch` only
  accepts raw private keys, can't take a pre-built `WalletSet`;
  `createX402Client` natively takes `wallets: WalletSet` and is the
  layer `wrapFetch` delegates to anyway.
- **Task 7:** implementer wrote its own `signV1EvmPayment` helper
  (EIP-3009 TransferWithAuthorization, EIP-712) rather than reusing the
  v2 adapter — correct, because the v2 adapter signs the Permit2 witness
  scheme, a different structure. No upstream `x402` dependency added.
  Code-quality review caught a real crypto bug (hardcoded EIP-712
  domain `'USD Coin'/'2'` fallback → unspendable signatures on
  bridged-USDC/BSC); fixed in `f1858c9` — v1 `pay` now fails
  `merchant_rejected` if a challenge omits `extra.name`/`extra.version`
  rather than guessing the domain.

## Tasks REMAINING (6/13)

Pick up here. Full task text + code is in the Plan 1 file
(`2026-05-18-x402-version-seam-plan-1-paying-side.md`) — Tasks 8-13.

- **Task 8** — `src/payment/dispatcher.ts` + `src/payment/index.ts` +
  `dispatcher.test.ts`. Version detection + public `payAndFetch`. The
  plan has complete code for this task. Mechanical-ish → sonnet.
- **Task 9** — export the seam from `src/client/index.ts`, full test
  run, `npm run build`, `npm version minor` (3.4.0→3.5.0), `npm publish`.
  **⚠ PAUSE for user go-ahead before running this task.**
- **Task 10** — migrate `dexter-api` `src/tasks/verifier/payment.ts`
  onto `payAndFetch`; delete `makePaymentV1Style` + the upstream `x402`
  imports. → sonnet.
- **Task 11** — migrate `dexter-api`
  `src/tasks/resourceQualityVerifier.ts` off upstream `x402`. → sonnet.
- **Task 12** — migrate the 3 paying paths in `dexter-api`
  `src/routes/x402Pay.ts` off the bare `x402` library (keep the
  separate `@x402/core/http` import — out of scope). → sonnet.
- **Task 13** — verify: typecheck dexter-api, grep-confirm no upstream
  `x402` in the 3 paying files, real paid call vs a live v2 merchant
  (reloadpi) and a live v1 merchant via `skillsmith test`.

## Carry-forward findings (not blockers, for later)

- **v1 SVM unimplemented.** v1 `pay` is EVM-only; SVM-family options
  return `unsupported_network`. The catalog has **244 v1-style SVM
  resources** (~6% of ~4,490 v1 resources; v1 EVM is ~3,874). Deliberate
  scope — the `invalid_payload` bug is EVM-specific — but a real gap.
  Candidate for a Plan 2 follow-up or a separate task.
- **`@x402/core/http`** is a *different* package from the bare upstream
  `x402` lib; `x402Pay.ts` imports both. Task 12 removes only the bare
  `x402` usage; `@x402/core/http` stays (out of scope for Plan 1).
- Plan 2 (server/charging side: `dexterPaymentMiddleware.ts`,
  `registerX402.ts`, `x402Config.ts`, `routes/payments.ts`,
  `routes/tools/ai.ts`, + `dexter-mcp`'s upstream `x402` dep) is still
  to be written via the writing-plans skill, after Plan 1 finishes.

## How to resume — exact steps

1. Re-read this file + the Plan 1 file's Tasks 8-13.
2. Re-enter subagent-driven execution (the skill is
   `superpowers:subagent-driven-development`).
3. Dispatch Task 8 implementer with the full Task 8 text from the plan.
4. Spec review → code-quality review → fix loop → mark done.
5. **STOP before Task 9. Ask the user to approve the npm publish.**
6. On approval, run 9 → 13. Task 13 is the end of Plan 1.
7. After Plan 1: write Plan 2 (server side) via `superpowers:writing-plans`.

## Wider session context (in case the whole session compacted)

This Plan 1 is priority #2 ("the verifier is lying") from a 3-priority
email sent to branch@dexter.cash + nrsander@gmail.com earlier. The
other two priorities, still open:
- **#1 search ranker** — `skillsmith search` ranks badly on natural
  phrasing; OpenAI-embedding-backed; user said the OpenAI side may be
  unpaid. Diagnosis-first, not started.
- **#3 standing skills** — split into 3A (execution engine: scheduler +
  state + budget) and 3B (notif/liaison loop). Designed in
  `~/websites/x402gle/.planning/standing-skills-design.md`. Not started.

Other planning docs live in `~/websites/x402gle/.planning/`
(verifier-findings, catalog maps, demo-workflow outlines, the
INDEX file).
