# Pickup — SDK cleanup / 4.0 cycle

**For:** a fresh Claude (or human) picking up the SDK cleanup work after a context reset.
**Updated:** 2026-05-20

---

## Read these two files first

1. **[AUDIT-2026-05-20.md](./AUDIT-2026-05-20.md)** — what's in the SDK, what's good, what's wrong, what's dead.
2. **[PLAN-4.0.md](./PLAN-4.0.md)** — the locked decisions and the PR-by-PR plan.

The audit's `§0` and `§0a` errata blocks explain what the initial draft got wrong and why — read them so you don't repeat the same mistakes. The plan's "Decisions made" section captures why every call was made.

---

## State at this pickup point

- **SDK version:** 3.8.1 (latest on npm).
- **Last commit on `main`:** `9660c3a docs(plan): lock 3.9/4.0/5.0 decisions from Q1-Q5 review`.
- **All open questions resolved.** Nothing is blocking PR 1.
- **Nothing in flight.** No uncommitted code changes. No PRs out.
- **Test suite is green** at 272 passing.

---

## What "we're doing" in one paragraph

The SDK is a modern, well-engineered core (`payment/`, `batch-settlement/`, the 3.8 bazaar extension) wrapped around a January-era stopgap layer that's no longer load-bearing but still exported, still on the homepage, and confusing every new adopter. The plan is to ship **3.9.0** with `@deprecated` markers on the stopgaps + a README rewrite that promotes the canonical paths; then ship **4.0.0** ~1 month later with the actual removals + Budget Account 2.0; then ship **5.0.0** ~6 months after that with `wrapFetch` and `createX402Client` removed (longer cycle because they have real consumers).

---

## Next action: PR 1

**Delete `src/server/model-registry.ts`** (789L, hardcoded January 2026 OpenAI catalog, zero consumers in the entire monorepo umbrella).

Steps:

1. Delete `src/server/model-registry.ts`.
2. Remove its exports from `src/server/index.ts` (lines 100-123 in the version at audit time).
3. Re-run typecheck — should be clean.
4. Re-run tests — should still be 272 passing.
5. CHANGELOG entry under "Removed."
6. Commit message: `refactor(server): remove unused model-registry; token-pricing is the canonical pricing helper`
7. Push.

That's it. No migration cycle needed because there are no consumers to migrate.

---

## Then PR 2 — the big one

**Add `@deprecated` JSDoc markers** to 8 files. Two target horizons:

**Gone in 4.0** (deprecated now, removed in ~1 month):
- `src/server/access-pass.ts` exports
- `src/server/dynamic-pricing.ts` exports
- `src/server/browser-support.ts` exports
- `src/server/stripe-payto.ts` exports
- `src/server/token-pricing.ts` exports (incl. `MODEL_PRICING`)
- `src/react/useAccessPass.ts`

**Gone in 5.0** (deprecated now, removed in ~6 months; longer because they have 7+3 real consumers):
- `src/client/wrap-fetch.ts` — `wrapFetch`, `WrapFetchOptions`
- `src/client/x402-client.ts` — `createX402Client`, `X402ClientConfig`, `X402Client`

Each `@deprecated` JSDoc points at the replacement (`payAndFetch` for the client APIs; "use x402 v2 dynamic pricing" for the v1 LLM pricers; "no replacement — feature retired" for Stripe/AccessPass/browser-support).

No runtime changes. Just JSDoc.

Then PR 3 (reorganize `client/index.ts`), PR 4 (fix `PayResult` lying about network), PR 5 (README rewrite), PR 6 (consumer dep cleanup in dexter-facilitator + dexter-mcp), PR 7 (publish 3.9.0). PRs 8-11 are the 4.0 cycle. PR 12 is the 5.0 cycle. All detailed in PLAN-4.0.md.

---

## Hard rules — do not break

These are restated from the plan because they're load-bearing:

1. **No PR ships until the plan and audit have been read.** They're not long. Read them.
2. **No commit message disparages an old feature.** Frame everything forward: "consolidate around the canonical path," "promote `payAndFetch` as recommended," "rebuild Budget Account for production use." Never "remove dead code" or "X was never used."
3. **`@deprecated` in 3.9, removals in 4.0/5.0.** No mixing. Same cadence the team used for `X402ErrorCode.no_solana_accept` and `KeypairWallet.keypair` in 3.2.0.
4. **No 4.0 removal until the dexter-lab agent-template references are updated.** `dexter-lab/app/lib/.server/agent/dexter-agent.ts:163-170` currently emits `createDynamicPricing` / `x402AccessPass` / `x402BrowserSupport` in generated code. PR 8 in the plan exists for this. Don't skip it.
5. **Every PR is independently revertable.** Stopping after any PR leaves the SDK in a sane state.
6. **Test suite stays green at every step.** 272 passing.
7. **Public communication scope = the CHANGELOG and the README.** No blog post, no GitHub issue, no Twitter. This is internal hygiene.

---

## Things that look like loose ends but aren't

- **Two version pins to bump** (`dexter-mcp` from `^2.0.0` to `^3.8.x`, `dexter-facilitator` to drop the dep entirely). That's PR 6, separate repos, separate commits. Not a blocker for PR 1.
- **The audit's "Branch said 5 things, three needed legwork I haven't done yet"** — no, those got done. Q1-Q5 decisions are locked in the plan's "Decisions made" section with reasoning. Don't re-litigate.
- **`sponsored-access` looking suspiciously like the kind of "dead" code we're deprecating** — it's not. 4 real production consumers (opendexter-ide MCP `fetch` tool, dexter-mcp x402-client + open-mcp-server, x402gle InstinctReceipt). All use `await import('@dexterai/x402/client')` — a static grep misses them. See the audit's `§0` errata.

---

## If a finding turns out to be wrong

The audit was wrong about sponsored-access on first pass. It got corrected after Branch challenged it. If you find another wrong claim while executing the plan: **fix it in AUDIT-2026-05-20.md and PLAN-4.0.md first, then in the PR.** The docs are the source of truth; the code follows.

---

*This file is for your benefit. Branch already knows what we're doing. You're catching up.*
