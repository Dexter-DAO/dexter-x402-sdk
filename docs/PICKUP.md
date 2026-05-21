# Pickup — SDK cleanup

**For:** a fresh Claude (or human) picking up the SDK cleanup work after a context reset.
**Updated:** 2026-05-21

---

## Read these files first

1. **[AUDIT-2026-05-20.md](./AUDIT-2026-05-20.md)** — what's in the SDK, what's good, what's wrong, what's actually load-bearing.
2. **[PLAN.md](./PLAN.md)** — the committed 3.9 scope and a sketch of what comes after.
3. **[DESIGN-timeout-double-charge.md](./DESIGN-timeout-double-charge.md)** — the design for PRs 5/6/7 (the money-loss bug fix). Read before touching `payment/`.

The audit's `§0`, `§0a`, and `§0b` errata blocks explain what earlier drafts got wrong and why — read them so you don't repeat the same mistakes. **`§0b` is the most important if you're about to touch model-registry, stripe-payto, or token-pricing**: those files looked deletable on a surface read but turned out to have internal SDK consumers. PR sequencing was rewritten as a result.

---

## Scope reminder

**Committed:** the 3.9 cycle (9 PRs — grew from 6 when the timeout double-charge fix was added 2026-05-21). PRs 1-4 have shipped.
**Sketch (NOT committed):** the post-3.9 removal cycle. We'll decide whether removals land as 3.10, 4.0, or something else *after* 3.9 ships and we see how the deprecation warnings behave with real consumers. Don't treat the "post-3.9 sketch" section of PLAN.md as a roadmap — it's a thinking-aid.

If a fresh agent reads this and gets excited about "4.0 cleanup," slow down — that's a placeholder name, not a decided release.

---

## State at this pickup point

- **SDK version:** 3.8.1 (latest on npm).
- **Last commit on `main`:** `24b928d docs(readme): restructure …` (PR 4 of the 3.9 cycle).
- **Nothing in flight.** No uncommitted code changes. No PRs out.
- **Test suite is green** at 273 passing (PR 3 added one regression test).

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
| 5 | Timeout double-charge — stop the lie (two-phase timeout, `payment_unconfirmed`) | next |
| 6 | Timeout double-charge — chain confirmation | pending |
| 7 | Timeout double-charge — `x402-mcp-tools` consumer fix (dexter-mcp repo) | pending |
| 8 | Consumer dep cleanup (dexter-facilitator drop, dexter-mcp bump) | pending |
| 9 | Tag and publish 3.9.0 | pending |

---

## Next action: PR 5 — timeout double-charge, stop the lie

**Read [DESIGN-timeout-double-charge.md](./DESIGN-timeout-double-charge.md) first.** It carries the full design with locked decisions. The bug report is `FINDINGS-pay-timeout-double-charge-2026-05-21.md` at the repo root.

The bug: `payAndFetch` arms one 15s timeout over the whole `client.fetch()` call, which both settles the on-chain payment AND waits for the merchant. A merchant slower than 15s gets the payment settled, then the abort fires and `payAndFetch` returns `{ ok: false, reason: 'timeout' }` — a lie. `x402-mcp-tools` renders "Payment failed," the agent retries, pays again. Proven on Base mainnet.

PR 5 is the smaller half of the fix (PR 6 adds chain confirmation):

- Split the `v2-strategy.ts` / `v1-strategy.ts` timeout into two phases: short pre-payment deadline (`timeoutMs`, 15000), long post-payment deadline (new `responseTimeoutMs`, 120000).
- Track `paymentDispatched` — true the moment the `PAYMENT-SIGNATURE` request is sent.
- Add `'payment_unconfirmed'` to the `PayResult` `ok: false` reason union.
- Post-payment abort → `payment_unconfirmed` (not `timeout`). No chain calls yet.
- Commit: `fix(payment): two-phase timeout; post-payment abort no longer reports 'timeout'`

The build-time call flagged in the design: `v2-strategy.ts` currently delegates to `createX402Client`, which hides the probe/pay seam. Either thread a "payment dispatched" signal through `createX402Client`, or have the strategy drive probe + pay itself. Decide at implementation time; flag it in the PR.

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
