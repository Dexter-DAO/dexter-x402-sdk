# Pickup — SDK cleanup

**For:** a fresh Claude (or human) picking up the SDK cleanup work after a context reset.
**Updated:** 2026-05-21

---

## Read these two files first

1. **[AUDIT-2026-05-20.md](./AUDIT-2026-05-20.md)** — what's in the SDK, what's good, what's wrong, what's actually load-bearing.
2. **[PLAN.md](./PLAN.md)** — the committed 3.9 scope and a sketch of what comes after.

The audit's `§0`, `§0a`, and `§0b` errata blocks explain what earlier drafts got wrong and why — read them so you don't repeat the same mistakes. **`§0b` is the most important if you're about to touch model-registry, stripe-payto, or token-pricing**: those files looked deletable on a surface read but turned out to have internal SDK consumers. PR sequencing was rewritten as a result.

---

## Scope reminder

**Committed:** the 3.9 cycle (6 PRs). PR 1 has shipped.
**Sketch (NOT committed):** the post-3.9 removal cycle. We'll decide whether removals land as 3.10, 4.0, or something else *after* 3.9 ships and we see how the deprecation warnings behave with real consumers. Don't treat the "post-3.9 sketch" section of PLAN.md as a roadmap — it's a thinking-aid.

If a fresh agent reads this and gets excited about "4.0 cleanup," slow down — that's a placeholder name, not a decided release.

---

## State at this pickup point

- **SDK version:** 3.8.1 (latest on npm).
- **Last commit on `main`:** `1722506 chore: mark v1-era helpers @deprecated ahead of 4.0 + 5.0` (PR 1 of the 3.9 cycle).
- **Nothing in flight.** No uncommitted code changes. No PRs out.
- **Test suite is green** at 272 passing.

---

## What "we're doing" in one paragraph

The SDK is a modern, well-engineered core (`payment/`, `batch-settlement/`, the 3.8 bazaar extension) wrapped around a January-era stopgap layer that's no longer load-bearing but still exported, still on the homepage, and confusing every new adopter. The 3.9 cycle adds `@deprecated` markers on the stopgaps, fixes one real bug (`PayResult` lies about network when no payment was required), reorganizes `client/index.ts` so `payAndFetch` is promoted as the canonical 2026+ entrypoint, and rewrites the README to match. Whether the actual deletions land as 3.10 or 4.0 gets decided after 3.9 ships.

---

## 3.9 progress

| PR | Title | Status |
|---|---|---|
| 1 | `@deprecated` markers on 9 files | ✅ shipped `1722506` |
| 2 | Reorganize `client/index.ts` recommendation hierarchy | next |
| 3 | Fix `PayResult` lying about network when no payment required | pending |
| 4 | README rewrite — promote `payAndFetch` + bazaar + sponsored-access | pending |
| 5 | Consumer dep cleanup (dexter-facilitator drop, dexter-mcp bump) | pending |
| 6 | Tag and publish 3.9.0 | pending |

---

## Next action: PR 2 — `client/index.ts` reorganization

Reorganize `src/client/index.ts` exports into commented sections matching PLAN.md §D4:

```typescript
// ── Canonical client (2026+) ──
export { payAndFetch, detectStrategy, ... } from '../payment';

// ── Wallet helpers ──
export { createKeypairWallet, createEvmKeypairWallet, ... } from './keypair-wallet';

// ── Sponsored Access (Instinct ad network buyer hooks) ──
export { getSponsoredRecommendations, getSponsoredAccessInfo, fireImpressionBeacon } from './sponsored-access';

// ── Agent budget controls ──
export { createBudgetAccount } from './budget-account';

// ── @deprecated — predate payAndFetch; will be removed in a future major ──
export { createX402Client, wrapFetch, getPaymentReceipt } from './x402-client';
```

`getPaymentReceipt` is NOT deprecated — it stays in the deprecated section's export line because that's where the source file is, but the JSDoc on it should stay clean.

**Steps:**

1. Read the current `src/client/index.ts` to see what's there.
2. Read `src/payment/index.ts` (or wherever `payAndFetch` lives) to confirm the export names.
3. Reorganize. No symbol additions/removals — only reordering + comment headers.
4. Typecheck + tests (expect 272 passing).
5. Commit: `docs(client): group exports by role; promote payAndFetch as canonical 2026+ entry`
6. Push.

---

## Hard rules — do not break

1. **No PR ships until the plan and audit have been read.** They're not long.
2. **No commit message disparages an old feature.** Frame forward: "consolidate around the canonical path," "promote `payAndFetch` as recommended." Never "remove dead code" or "X was never used."
3. **`@deprecated` in 3.9, removals in a later major.** No mixing.
4. **No removal until the dexter-lab agent-template references are updated.** Multiple emission sites in dexter-lab reference `createDynamicPricing` / `x402AccessPass` / `x402BrowserSupport` / `createTokenPricing` / `MODEL_PRICING` in generated code or agent prompts. Full list in PLAN §D6.
5. **Every PR is independently revertable.** Stopping after any PR leaves the SDK in a sane state.
6. **Test suite stays green at every step.** 272 passing.
7. **Public communication scope = CHANGELOG and README.** No blog post, no GitHub issue, no Twitter. Internal hygiene.

---

## Things that look like loose ends but aren't

- **Two version pins to bump** (`dexter-mcp` from `^2.0.0` to `^3.8.x`, `dexter-facilitator` to drop the dep entirely). That's PR 5, separate repos, separate commits. Not a blocker for PR 2.
- **`sponsored-access` looking suspiciously like deprecated code** — it's not. 4 real production consumers (opendexter-ide MCP `fetch` tool, dexter-mcp x402-client + open-mcp-server, x402gle InstinctReceipt). All use `await import('@dexterai/x402/client')` — a static grep misses them. See AUDIT `§0`.
- **`model-registry.ts` looking like obviously dead code** — `token-pricing.ts:30` imports `MODEL_PRICING_MAP` and re-exports it as `MODEL_PRICING`, which dexter-lab's agent imports. See AUDIT `§0b`. Already `@deprecated` in PR 1; deletion is a later-major thing, not 3.9.
- **`stripe-payto` looking deletable without touching middleware** — `middleware.ts:34` imports `getStripeProviderNetwork` from it. Already `@deprecated` in PR 1 (no runtime change); a future removal takes middleware's Stripe codepath with it. PLAN.md covers this.
- **The "post-3.9 sketch" section of PLAN.md** — it has PR numbers and version targets (4.0, 5.0). Those are placeholders. Branch and I agreed in 2026-05-21 chat that the actual shape of the removal cycle gets decided *after* 3.9 ships. Don't treat the sketch as committed work.

---

## If a finding turns out to be wrong

The audit was wrong about sponsored-access on first pass. It was wrong about model-registry on second pass. Both got corrected after a recount. If you find another wrong claim while executing the plan: **fix it in AUDIT-2026-05-20.md and PLAN.md first, then in the PR.** The docs are the source of truth; the code follows.

---

*This file is for your benefit. Branch already knows what we're doing. You're catching up.*
