# Pickup — SDK cleanup

**For:** a fresh Claude (or human) picking up the SDK cleanup work after a context reset.
**Updated:** 2026-05-21

---

## Read these files first

1. **[AUDIT-2026-05-20.md](./AUDIT-2026-05-20.md)** — what's in the SDK, what's good, what's wrong, what's actually load-bearing.
2. **[PLAN.md](./PLAN.md)** — the committed 3.9 scope and a sketch of what comes after.
3. **[DESIGN-timeout-double-charge.md](./DESIGN-timeout-double-charge.md)** — the design for PRs 5/6/7 (the money-loss bug fix). Read before touching `payment/`.
4. **[FOLLOWUPS.md](./FOLLOWUPS.md)** — issues found mid-work and deliberately deferred. Check it before declaring anything "done" — there may be a known gap.

The audit's `§0`, `§0a`, and `§0b` errata blocks explain what earlier drafts got wrong and why — read them so you don't repeat the same mistakes. **`§0b` is the most important if you're about to touch model-registry, stripe-payto, or token-pricing**: those files looked deletable on a surface read but turned out to have internal SDK consumers. PR sequencing was rewritten as a result.

---

## Scope reminder

**Committed:** the 3.9 cycle (9 PRs — grew from 6 when the timeout double-charge fix was added 2026-05-21). PRs 1-4 have shipped.
**Sketch (NOT committed):** the post-3.9 removal cycle. We'll decide whether removals land as 3.10, 4.0, or something else *after* 3.9 ships and we see how the deprecation warnings behave with real consumers. Don't treat the "post-3.9 sketch" section of PLAN.md as a roadmap — it's a thinking-aid.

If a fresh agent reads this and gets excited about "4.0 cleanup," slow down — that's a placeholder name, not a decided release.

---

## State at this pickup point

- **SDK version:** 3.8.1 (latest on npm; 3.9 not yet published).
- **Last commit on `main`:** `26658f8 feat(payment): confirm settlement on-chain …` (PR 6 of the 3.9 cycle).
- **Nothing in flight.** No uncommitted code changes. No PRs out.
- **Test suite is green** at 278 passing.

---

## What "we're doing" in one paragraph

The SDK is a modern, well-engineered core (`payment/`, `batch-settlement/`, the 3.8 bazaar extension) wrapped around a January-era stopgap layer that's no longer load-bearing but still exported. The 3.9 cycle adds `@deprecated` markers on the stopgaps, fixes the `PayResult` phantom-network bug, reorganizes `client/index.ts` to promote `payAndFetch`, rewrites the README, and — added 2026-05-21 after a bake-off audit — fixes a money-loss bug where `payAndFetch` reports `timeout` on payments that settled on-chain (causing a silent double-charge on retry). Whether the post-3.9 deletions land as 3.10 or 4.0 gets decided after 3.9 ships.

---

## 3.9 progress

| PR | Title | Status |
|---|---|---|
| 1 | `@deprecated` markers on 9 files | ✅ `1722506` |
| 2 | Reorganize `client/index.ts` | ✅ `d332b0e` |
| 3 | Fix `PayResult` phantom network | ✅ `8d72512` |
| 4 | README rewrite | ✅ `24b928d` |
| 5 | Timeout — stop the lie (two-phase timeout, `payment_unconfirmed`) | ✅ `200be1d` |
| 6 | Timeout — chain confirmation | ✅ `26658f8` |
| 7 | Consumer dep cleanup (dexter-facilitator drop, dexter-mcp bump) | next |
| 8 | Tag and publish 3.9.0 | pending |
| 9 | `payment_unconfirmed` consumer fixes — opendexter-ide + dexter-api (MUST be after PR 8) | pending |

---

## Next action: PR 7 — consumer dep cleanup

Two `package.json` edits, in two other repos, each its own commit:

- **`dexter-facilitator/package.json`** — drop the `@dexterai/x402` dependency entirely. It is pinned (`^1.7.2`) but not imported anywhere in source. Verify with a grep before removing.
- **`dexter-mcp/package.json`** — bump the `@dexterai/x402` pin from `^2.0.0` to `^3.8.x`. dexter-mcp DOES use it at runtime (`await import('@dexterai/x402/client')` for `wrapFetch` + sponsored-access helpers), but the `^2.0.0` pin could resolve to a wildly old major.

Neither is a blocker for anything; both are hygiene. Build + test each repo after.

### Then PR 8 — publish 3.9.0

Final CHANGELOG pass, `npm version minor` → 3.9.0, `npm publish`, tag.

### Then PR 9 — consumer fixes (only AFTER PR 8 publishes)

**Why after publish:** the consumers pin `@dexterai/x402@^3.7.x`. `payment_unconfirmed` and the `response: undefined` shape only exist in 3.9. A consumer fix written before 3.9 is on npm cannot typecheck. Each PR 9 fix bumps its consumer's SDK pin to `^3.9.0` in the same commit.

Two consumers (verified by cross-monorepo grep — `dexter-mcp` is NOT one, it uses `wrapFetch` which never exposes `PayResult`):
- **`opendexter-ide`** `packages/x402-mcp-tools/src/tools/fetch.ts` — `payment_unconfirmed` currently renders as generic "Payment failed" (invites a double-charging retry); `payResult.response` read unconditionally (crashes on `paid: true, response: undefined`).
- **`dexter-api`** `src/tasks/verifier/payment.ts` — `r.response.status` at the 405-retry check, and all post-result reads, crash on `undefined` response.

Full detail in PLAN.md PR 9 and DESIGN-timeout-double-charge.md.

---

## Hard rules — do not break

1. **No PR ships until the plan and audit have been read.** They're not long.
2. **No commit message disparages an old feature.** Frame forward: "consolidate around the canonical path," "promote `payAndFetch` as recommended." Never "remove dead code" or "X was never used."
3. **`@deprecated` in 3.9, removals in a later major.** No mixing.
4. **No removal until the dexter-lab agent-template references are updated.** Multiple emission sites in dexter-lab reference `createDynamicPricing` / `x402AccessPass` / `x402BrowserSupport` / `createTokenPricing` / `MODEL_PRICING` in generated code or agent prompts. Full list in PLAN §D6.
5. **Every PR is independently revertable.** Stopping after any PR leaves the SDK in a sane state.
6. **Test suite stays green at every step.** 273 passing (rises as PRs add coverage).
7. **Public communication scope = CHANGELOG and README.** No blog post, no GitHub issue, no Twitter. Internal hygiene.

---

## Things that look like loose ends but aren't

- **Two version pins to bump** (`dexter-mcp` from `^2.0.0` to `^3.8.x`, `dexter-facilitator` to drop the dep entirely). That's PR 8, separate repos, separate commits. Not a blocker for the timeout-fix PRs.
- **`sponsored-access` looking suspiciously like deprecated code** — it's not. 4 real production consumers (opendexter-ide MCP `fetch` tool, dexter-mcp x402-client + open-mcp-server, x402gle InstinctReceipt). All use `await import('@dexterai/x402/client')` — a static grep misses them. See AUDIT `§0`.
- **`model-registry.ts` looking like obviously dead code** — `token-pricing.ts:30` imports `MODEL_PRICING_MAP` and re-exports it as `MODEL_PRICING`, which dexter-lab's agent imports. See AUDIT `§0b`. Already `@deprecated` in PR 1; deletion is a later-major thing, not 3.9.
- **`stripe-payto` looking deletable without touching middleware** — `middleware.ts:34` imports `getStripeProviderNetwork` from it. Already `@deprecated` in PR 1 (no runtime change); a future removal takes middleware's Stripe codepath with it. PLAN.md covers this.
- **The "post-3.9 sketch" section of PLAN.md** — it has PR numbers and version targets (4.0, 5.0). Those are placeholders. Branch and I agreed in 2026-05-21 chat that the actual shape of the removal cycle gets decided *after* 3.9 ships. Don't treat the sketch as committed work.

---

## If a finding turns out to be wrong

The audit was wrong about sponsored-access on first pass. It was wrong about model-registry on second pass. Both got corrected after a recount. If you find another wrong claim while executing the plan: **fix it in AUDIT-2026-05-20.md and PLAN.md first, then in the PR.** The docs are the source of truth; the code follows.

---

*This file is for your benefit. Branch already knows what we're doing. You're catching up.*
