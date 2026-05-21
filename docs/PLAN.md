# `@dexterai/x402` SDK Cleanup Plan

**Status:** DRAFT — for internal planning only. Not for external/public framing.
**Companion document:** [AUDIT-2026-05-20.md](./AUDIT-2026-05-20.md) — read first.
**Updated:** 2026-05-21 (committed scope narrowed to 3.9 only; post-3.9 work kept as a sketch, not a commitment).
**Previously:** 2026-05-21 (PR sequencing rewritten after internal-consumer recount), 2026-05-20 (rebaselined from 3.8 → 3.9 because the team shipped 3.8.0 + 3.8.1).

**Current published version:** 3.8.1
**Committed scope:** 3.9.0 — see "3.9 cycle" below. Six PRs, one shipped (`@deprecated` markers).
**Post-3.9 sketch (NOT a commitment):** the deletions could land as 3.10 (keep deprecated stuff callable, just hidden from docs), 4.0 (clean break), or something else. Decided after 3.9 ships and we see how the deprecation warnings land with real consumers. The "post-3.9 sketch" PR list below is preserved as a thinking-aid, not a roadmap.

---

## Decision tree

The audit identified a clear shape:

- **Zero** files to delete outright in 3.9. (Original plan said "delete `model-registry.ts`" — see AUDIT §0b. The file has 1 internal consumer (`token-pricing.ts` re-exports `MODEL_PRICING_MAP` as `MODEL_PRICING`) and the resulting `MODEL_PRICING` has 2 real external consumers in dexter-lab. Deletion moves to 4.0 alongside token-pricing removal.)
- **Several** files to deprecate now and remove in 4.0 (the older feature-demos: Access Pass, Dynamic Pricing, Browser Support, token-pricing, model-registry, Stripe, useAccessPass).
- **Two** primitives to keep and **promote** (`sponsored-access`, `payAndFetch`).
- **One** primitive to **rebuild** (`createBudgetAccount` → Budget Account 2.0).
- **One** README rewrite to reorder the section hierarchy.

This plan locks each of those into a specific PR with explicit scope so nothing in flight overlaps anything else, and so we don't get halfway through and discover an unresolved question.

---

## Hard rules

1. **No PR ships until this plan is approved.** Plan first, then PRs.
2. **No commit message disparages an old feature.** Frame everything forward: "consolidate around the canonical path," "promote `payAndFetch` as the recommended client," "rebuild Budget Account for production use." Never "remove dead code" or "X was never used."
3. **`@deprecated` markers go in 3.9. Removals go in 4.0.** No mixing. Same cadence the team used for `X402ErrorCode.no_solana_accept` and `KeypairWallet.keypair` in 3.2.0.
4. **No 4.0 removal happens before its dexter-lab agent-template references are updated.** The agent currently emits `createDynamicPricing` / `x402AccessPass` / `x402BrowserSupport` in generated code (`dexter-lab/app/lib/.server/agent/dexter-agent.ts`). Removing the SDK export without updating that template means the agent advises broken code.
5. **Public communication scope = the CHANGELOG and the README.** No blog post, no GitHub issue, no Twitter. This is internal hygiene.
6. **Every PR is independently revertable.** No PR depends on a later PR. If we stop after PR 3, the SDK is still in a sane state.
7. **Test suite stays green at every step.** 35/35 batch-settlement tests + the broader suite. No "we'll fix the tests in the next PR."

---

## Locked decisions

These are the ones I want you to confirm before we start. Each has a clear yes/no.

### D1. Version cadence

**Decision:** Ship `@deprecated` markers + README rewrite as **3.9.0**. Hold removals for **4.0.0**, ship ~1 month later.

(The initial plan said 3.8.0 — but the team shipped 3.8.0 + 3.8.1 as the bazaar discovery extension release while the audit was running. The next minor after that is 3.9.)

**Alternative considered:** ship everything in 4.0 with no 3.9 intermediate. Rejected because it gives no migration window to any consumer and breaks the team's own 3.2.0 deprecation pattern.

### D2. Keep / cut list

| Symbol / file | 3.9 action | 4.0 action | 5.0 action |
|---|---|---|---|
| `src/server/model-registry.ts` (789L) | `@deprecated` (was "DELETE in 3.9" — corrected after internal-consumer recount; `token-pricing.ts` imports `MODEL_PRICING_MAP` and that flows through to dexter-lab) | DELETE alongside token-pricing | — |
| `src/server/access-pass.ts` | `@deprecated` | DELETE | — |
| `src/react/useAccessPass.ts` | `@deprecated` | DELETE | — |
| `src/server/dynamic-pricing.ts` | `@deprecated` | DELETE | — |
| `src/server/browser-support.ts` | `@deprecated` | DELETE | — |
| `src/server/stripe-payto.ts` | `@deprecated` | DELETE (incl. `middleware.ts`'s Stripe codepath — `getStripeProviderNetwork` import + the runtime check at lines 357-360 + the JSDoc at 49-58) | — |
| `src/server/token-pricing.ts` (+ `MODEL_PRICING`) | `@deprecated` | DELETE | — |
| `test/model-eval/{run,types}.ts` | (no change — not shipped) | DELETE alongside model-registry, or migrate to a self-contained pricing fixture | — |
| `src/client/budget-account.ts` | **Keep** — flag in JSDoc as "v1, rebuild planned for 4.0" | **REBUILD** (Budget Account 2.0, see D5) | — |
| `src/client/sponsored-access.ts` | **Keep + promote** | Keep | — |
| `src/client/wrap-fetch.ts` (`wrapFetch`) | `@deprecated` — `payAndFetch` is canonical | Keep with deprecation | DELETE |
| `src/client/x402-client.ts` (`createX402Client`) | `@deprecated` — `payAndFetch` is canonical | Keep with deprecation | DELETE |
| `src/payment/*` (`payAndFetch` and friends) | Keep — this is the new baseline | Keep | Keep |
| `src/batch-settlement/**` | Keep | Keep | Keep |
| `src/server/extensions/**` (bazaar) | Keep — shipped in 3.8.0 | Keep | Keep |

### D3. README rewrite scope (3.9)

- **Promote in Quick Start:** `payAndFetch` as the canonical client recipe.
- **Promote in Why-This-SDK headline:** batch-settlement, sponsored-access (the MCP-tool reality), the new bazaar discovery extension (3.8.0), and `payAndFetch`.
- **Demote to "Legacy capabilities" appendix:** Access Pass, Dynamic Pricing, Token Pricing, `stripePayTo`. All four are v1-era hypotheses that x402 v2 + the bazaar extension supersede; mention they exist so consumers using them aren't blindsided by the deprecation warning, but don't sell them.
- **Strengthen, don't cut:** Sponsored Access — concrete example showing the MCP `fetch` tool extracting and rendering recommendations.
- **Delete entirely:** all README mentions of `MODEL_REGISTRY` and `model-registry` (no migration path, no JSDoc deprecation; the file is gone in 3.9).
- **No static counts.** Strip "5,000+ paid APIs," any "N protocols supported," any other number that goes stale. Replace with qualitative phrasing ("tens of thousands of paid APIs," "every major EVM chain plus Solana"). Static counts go stale in weeks; the README rewrote in May 2026 already had a count 10× out of date.
- **Keep, no change:** Quick Start install line, supported networks table, batch-settlement section (already excellent).

### D4. `client/index.ts` recommendation hierarchy (3.9)

Reorganize into commented sections:

```typescript
// ── Canonical client (2026+) ──
export { payAndFetch, detectStrategy, ... } from '../payment';
export type { PayResult, PayAndFetchOptions, ... } from '../payment';

// ── Wallet helpers ──
export { createKeypairWallet, createEvmKeypairWallet, ... } from './keypair-wallet';

// ── Sponsored Access (Instinct ad network buyer hooks) ──
export { getSponsoredRecommendations, getSponsoredAccessInfo, fireImpressionBeacon } from './sponsored-access';

// ── Agent budget controls ──
export { createBudgetAccount } from './budget-account';  // v1, rebuild planned for 4.0

// ── @deprecated — predate payAndFetch; will be removed in 5.0 ──
export { createX402Client, wrapFetch, getPaymentReceipt } from './x402-client';
```

`createX402Client` and `wrapFetch` get `@deprecated` JSDoc in 3.9 pointing consumers at `payAndFetch`. They keep working through 4.x. They are removed in 5.0. `getPaymentReceipt` stays (still useful, no replacement needed).

### D5. Budget Account 2.0 scope

Lock the surface now so we know what 4.0 looks like:

```typescript
import { createBudgetAccount } from '@dexterai/x402/client';

const agent = createBudgetAccount({
  walletPrivateKey: ...,

  // Multiple named budgets (envelopes)
  budgets: {
    research: { total: '50.00', perRequest: '1.00' },
    tools:    { total: '20.00', perHour: '5.00' },
  },

  // Pluggable storage (mirror batch-settlement's ChannelStorage shape)
  storage: createRedisBudgetStorage({ url: process.env.REDIS_URL }),
  // default: in-memory (current behavior)

  // Per-domain caps, not just allowlist
  domains: {
    'api.openai.com':       { cap: '5.00' },
    'data.example.com':     { allow: true },         // no cap
    '*.scrapingbee.com':    { cap: '10.00' },
  },

  // Observability
  onSpend:           (record) => { ... },
  onLimitApproached: (envelope, pct) => { ... },  // e.g. at 80%
  onBlocked:         (intent, reason) => { ... },

  // Optional approval flow (soft caps)
  approve: async (intent) => {
    // intent: { url, amount, envelope, accumulated, limit }
    // return false to block this specific request
    return true;
  },
});

// Use it
await agent.fetch(url, { envelope: 'research' });

// Inspect
agent.envelope('research').spent;     // '$2.34'
agent.envelope('research').remaining; // '$47.66'
agent.envelope('research').ledger;    // PaymentRecord[]
```

**Out of scope for 4.0 (defer to 4.1+):**
- Multi-user budget sharing (workspace-level envelopes)
- Budget refresh schedules (monthly resets etc.)
- UI for human approval

### D6. dexter-lab agent-template update

The dexter-lab agent emits SDK references into generated user code. Full list of touchpoints, from the post-internal-recount grep (AUDIT §0b):

| File | Emits | Removed in 4.0? |
|---|---|---|
| `dexter-lab/app/lib/.server/agent/dexter-agent.ts:163-170` | `createDynamicPricing`, `x402AccessPass`, `MODEL_PRICING` (in agent prompt text) | yes — all three |
| `dexter-lab/app/lib/.server/agent/mcp-tools.ts:275` | `createX402Server, createDynamicPricing` (import literal in generated code) | yes — `createDynamicPricing` |
| `dexter-lab/app/lib/.server/agent/mcp-tools.ts:290-295` | `createTokenPricing, MODEL_PRICING` import + `MODEL_PRICING['gpt-4o'].input/output` access | yes — both |
| `dexter-lab/app/utils/templates/agent.ts:16` | `createX402Server, createTokenPricing` | yes — `createTokenPricing` |
| `dexter-lab/app/utils/templates/ai-resource.ts:12` | `createX402Server, createTokenPricing` | yes — `createTokenPricing` |
| `dexter-lab/x402-ai-assistant/index.ts:2` | `createX402Server, createTokenPricing, createDynamicPricing` | yes — both |
| `dexter-lab/app/lib/.server/deployment/deployment-service.ts:538-551` | `x402BrowserSupport` import injection into generated code | yes — `x402BrowserSupport` |

**Action:** before 4.0 ships, update **every one** of these references so the agent stops emitting the soon-removed symbols. This is a separate PR in the dexter-lab repo, not the SDK repo, but **gates the SDK's 4.0 release**.

(Original plan listed only `createDynamicPricing` / `x402AccessPass` / `x402BrowserSupport`. The recount added `createTokenPricing` and `MODEL_PRICING` — the dexter-lab agent template uses the token-pricing pathway extensively, not just the dynamic-pricing one.)

### D7. Consumer pin updates

`dexter-mcp` currently pins `@dexterai/x402: ^2.0.0`. It IS used at runtime via dynamic import. **Bump to `^3.7.x` as part of PR 5** so the dynamic-import resolves to a current SDK, not a wildly stale one.

`dexter-facilitator` pins `^1.7.2`, doesn't import the SDK at all. **Drop the dependency as part of PR 5.**

---

## PR plan

Each PR is independently revertable. Each PR is small. Each PR can ship on its own without depending on a later PR.

### PR 1 — `@deprecated` markers (3.9)

(Original plan had this as PR 2 — the standalone "delete `model-registry.ts`" PR ahead of it was retired after the AUDIT §0b internal-consumer recount. PR 1 is now the deprecation pass.)

- Add `@deprecated` JSDoc — **gone in 4.0**:
  - `src/server/access-pass.ts` exports
  - `src/server/dynamic-pricing.ts` exports
  - `src/server/browser-support.ts` exports
  - `src/server/stripe-payto.ts` exports
  - `src/server/token-pricing.ts` exports (incl. `MODEL_PRICING`)
  - `src/server/model-registry.ts` exports (entire file — even though it has no direct external consumers, its `MODEL_PRICING_MAP` is the underlying data for `MODEL_PRICING`; both ride the same removal cycle)
  - `src/react/useAccessPass.ts`
- Add `@deprecated` JSDoc — **gone in 5.0** (longer migration window because they have 7+3 real consumers):
  - `src/client/wrap-fetch.ts` (`wrapFetch`, `WrapFetchOptions`)
  - `src/client/x402-client.ts` (`createX402Client`, `X402ClientConfig`, `X402Client`)
- Each `@deprecated` JSDoc points at the replacement (`payAndFetch` for the client APIs; "use x402 v2 dynamic pricing" for the v1 LLM pricers; "no replacement — feature retired" for `stripePayTo`, Access Pass, browser-support, model-registry).
- No runtime behavior changes.
- CHANGELOG entry under "Deprecated" with two subsections (4.0 removal target vs 5.0 removal target).
- Commit message: `chore: mark v1-era helpers @deprecated ahead of 4.0 + 5.0`

**Acceptance:** typecheck green, tests green. Consumers using the deprecated APIs see editor warnings but their code still runs.

### PR 2 — `client/index.ts` hierarchy (3.9)

- Reorganize `client/index.ts` exports into the commented sections in D4.
- No symbol additions/removals — only reordering + comments.
- Commit message: `docs(client): group exports by role; promote payAndFetch as canonical 2026+ entry`

**Acceptance:** all existing imports still resolve, typecheck green, tests green.

### PR 3 — `dispatcher.ts` PayResult fix (3.9)

- Add `paid: true | false` discriminator to `PayResult` (or make `network` optional on the no-payment branch).
- Fix the placeholder at `dispatcher.ts:104-112` so it returns truthful data.
- Update v2-strategy and v1-strategy to match.
- Update tests.
- CHANGELOG entry under "Fixed."
- Commit message: `fix(payment): PayResult no longer reports fake network for unpaid responses`

**Acceptance:** consumers reading `result.network` on a non-paid response now get either `null` or a `paid: false` branch — never a phantom Base default.

### PR 4 — README rewrite (3.9)

- Reorder sections per D3.
- Promote `payAndFetch` to Quick Start.
- **Add a "Discovery extensions" section** that documents the 3.8.0 bazaar extension (`bazaarExtension`, `declareDiscoveryExtension`, the `extensions` + `declarations` middleware config). New feature, shipped, not yet in README. Show the canonical recipe and link to the upstream bazaar spec.
- Strengthen Sponsored Access section with the MCP-tool reality.
- Demote Access Pass, Dynamic Pricing to "Legacy capabilities" appendix.
- Update CHANGELOG with "Documentation" note pointing readers at the new layout.
- Commit message: `docs(readme): restructure to lead with payAndFetch + batch-settlement + bazaar + sponsored-access`

**Acceptance:** a new adopter reading the README top-down meets the canonical 2026+ paths (including the new bazaar discovery extension) in the first 200 lines.

### PR 5 — Timeout double-charge: stop the lie (3.9)

Inserted 2026-05-21 after a bake-off audit found `payAndFetch` reports `reason: 'timeout'` on payments that settled on-chain, against a merchant slower than the 15s deadline — causing a silent double-charge on retry. Full design: [DESIGN-timeout-double-charge.md](./DESIGN-timeout-double-charge.md). Report: `FINDINGS-pay-timeout-double-charge-2026-05-21.md`.

- Split the `v2-strategy.ts` / `v1-strategy.ts` timeout into two phases: a short pre-payment deadline (`timeoutMs`, default 15000) and a long post-payment deadline (new `responseTimeoutMs`, default 120000).
- Track `paymentDispatched` — set true the moment the `PAYMENT-SIGNATURE` request is sent.
- Add `'payment_unconfirmed'` to the `PayResult` `ok: false` reason union.
- A post-payment abort returns `payment_unconfirmed` (not `timeout`). No chain calls yet — PR 6 adds those.
- Commit message: `fix(payment): two-phase timeout; post-payment abort no longer reports 'timeout'`

**Acceptance:** a merchant slower than 15s no longer yields `reason: 'timeout'`; it yields `payment_unconfirmed`, whose `detail` does not read as "failed." Pre-payment timeouts still return `timeout`. Typecheck + tests green.

### PR 6 — Timeout double-charge: chain confirmation (3.9)

- Add the optional `ChainAdapter.confirmSettlement` method + `SettlementProbe` type.
- EVM EIP-3009: confirm via `USDC.authorizationState(from, nonce)`. EVM Permit2: `nonceBitmap`. EVM exact-approval: no probe — falls back to `payment_unconfirmed`.
- Solana: confirm via windowed `getSignaturesForAddress(destinationAta)`, matched on amount/asset, bounded by blockhash validity.
- On a post-payment abort, run `confirmSettlement`: settled → `{ ok: true, paid: true, response: undefined, txSignature }`; not settled → `payment_unconfirmed`.
- Commit message: `feat(payment): confirm settlement on-chain after a post-payment timeout`

**Acceptance:** the m01 reproduction (EVM EIP-3009 on Base, >15s research endpoint) returns `paid: true` on the first call — no retry, no double-charge. Typecheck + tests green with branch coverage.

### PR 7 — Timeout double-charge: x402-mcp-tools consumer fix (dexter-mcp, not SDK)

- The `x402_fetch` handler stops rendering `Payment failed: ${reason}` for `payment_unconfirmed`; renders "payment likely settled, no data received, do not retry, check wallet."
- Handles the `{ ok: true, paid: true, response: undefined }` shape — a paid result with no body is not an error.
- Separate PR in the `dexter-mcp` repo. Should land close to PR 5.

### PR 8 — Consumer dep cleanup (separate repos, not SDK)

- `dexter-facilitator/package.json`: drop `@dexterai/x402` dependency entirely (not imported in source).
- `dexter-mcp/package.json`: bump pin from `^2.0.0` to `^3.8.x` (current published).
- Each in its own commit/PR in its own repo.

**Acceptance:** both repos build, tests green, runtime behavior unchanged.

### PR 9 — Tag and publish 3.9.0

- Final CHANGELOG pass.
- `npm version minor` → 3.9.0.
- `npm publish`.
- Tag the commit.

**Acceptance:** `npm install @dexterai/x402@3.9.0` works; consumers updating from 3.8.x see no breakage but get the deprecation warnings + the timeout fix.

---

## Post-3.9 sketch (NOT committed)

What follows is a sketch of what the removal cycle *could* look like. It's a thinking-aid for the team, not a commitment. We'll decide the actual shape after 3.9 ships — could be 3.10 (deprecated symbols stay callable but disappear from the README), could be 4.0 (clean break), could be something else.

The version numbers below (4.0, 5.0) are placeholders from when this was framed as a committed roadmap; read them as "first removal release" and "second removal release."

*(PR numbers in this section use an `R` prefix — `R1`, `R2`, … — so they never collide with the committed 3.9 PR numbers above.)*

### PR R1 — Update dexter-lab agent template

- In `dexter-lab` (not the SDK repo): rewrite every emission site listed in D6 (table above) so generated code and agent prompts stop referencing the soon-removed symbols. Recommend canonical 2026+ paths instead (`payAndFetch`, batch-settlement, sponsored-access, x402 v2 dynamic pricing).
- This PR **gates** PR R2 — must ship and be deployed first.

### PR R2 — Actual removals (first removal release)

- Delete:
  - `src/server/access-pass.ts`
  - `src/server/dynamic-pricing.ts`
  - `src/server/browser-support.ts`
  - `src/server/stripe-payto.ts` + middleware's Stripe codepath (`middleware.ts:34` import, `middleware.ts:49-58` JSDoc, `middleware.ts:357-360` runtime check). All three go together — `getStripeProviderNetwork` is dead with `stripePayTo` gone.
  - `src/server/token-pricing.ts`
  - `src/server/model-registry.ts` (only safe to delete here because `token-pricing.ts` is going at the same time)
  - `src/react/useAccessPass.ts`
  - `test/model-eval/{run,types}.ts` — internal harness, lost its data source when model-registry left. Either delete or rewrite against a self-contained fixture; the rewrite should NOT block 4.0.
- Remove their exports from `src/server/index.ts` and `src/react/index.ts`.
- Remove their README sections entirely (already moved to legacy appendix in PR 4; now delete the appendix).
- CHANGELOG entry under "Removed" with one bullet per file, citing the deprecation in 3.9.
- Commit message: `refactor!: remove v1-era helpers deprecated in 3.9 (access-pass, dynamic-pricing, browser-support, stripe-payto, token-pricing, model-registry, useAccessPass)`

`wrapFetch` and `createX402Client` STAY in the first removal release — their deprecation window runs longer; removal lands in the second removal release (see PR R5 below).

**Acceptance:** typecheck green, tests green. Consumers who ignored the 3.9 deprecation warnings for the first-removal-target items now get hard build errors with a CHANGELOG pointing them at the migration. `wrapFetch` / `createX402Client` consumers still build clean but keep seeing the deprecation warning.

### PR R3 — Budget Account 2.0 (first removal release)

- Rewrite `src/client/budget-account.ts` per D5: envelopes, pluggable storage, observability hooks, approval flow, per-domain caps.
- New `BudgetStorage` interface in `src/client/budget-storage.ts` mirroring `ChannelStorage`'s shape.
- Tests covering each new capability.
- README section updated with the new surface.
- Commit message: `feat(client): Budget Account 2.0 — persistent, observable, envelopes, approval flow`

**Acceptance:** skillsmith-cli (the existing consumer) can adopt the new API with a deprecated alias path supported in the first-removal-release's patch line; new consumers get the full surface.

### PR R4 — Write MIGRATION.md + tag and publish the first removal release

- Write `MIGRATION.md` at the repo root: one section per removed symbol, mapping it to its replacement. ~1 page total.
- Final CHANGELOG with prominent "Breaking" section listing every removal and the Budget Account API change.
- Link MIGRATION.md from the README and CHANGELOG.
- `npm version major` → 4.0.0.
- `npm publish`.

### PR R5 — Remove `wrapFetch` + `createX402Client` (second removal release, ~6 months later)

- Delete `src/client/wrap-fetch.ts` and `src/client/x402-client.ts` (`createX402Client`, `X402Client`, `X402ClientConfig`, `PaymentReceipt` types — keep `getPaymentReceipt` if it has a home elsewhere, otherwise migrate to a small `src/client/receipt.ts`).
- Remove exports from `src/client/index.ts`.
- Update MIGRATION.md with the 5.0 section pointing at `payAndFetch`.
- CHANGELOG entry under "Removed" citing the 3.9 deprecation.
- Commit message: `refactor!: remove createX402Client + wrapFetch deprecated in 3.9 (use payAndFetch)`

**Acceptance:** consumers still on `wrapFetch` / `createX402Client` now get hard build errors. The 6-month window between 3.9 deprecation and 5.0 removal was enough for any active consumer to migrate.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| A consumer we missed depends on a deprecated export | Medium — the umbrella sweep was thorough but didn't audit external consumers | The 1-month gap between 3.9 (`@deprecated`) and 4.0 (remove) is the window. If anyone complains, we extend. |
| The dexter-lab agent template update slips and 4.0 ships with broken advice | High if not actively tracked | PR 8 is explicitly listed as gating PR 9. If PR 8 isn't done, PR 9 doesn't ship. |
| External observers notice the deprecation activity and read into it | Low — internal SDK cleanup is normal SemVer hygiene | Commit messages frame everything as "consolidate around canonical path," never "this was wrong." |
| We commit half the cleanup and then get pulled away | High — happens to every cleanup project | Every PR ships independently; stopping after any PR leaves the SDK in a sane state. |
| Budget Account 2.0 takes longer than expected | Medium — it's a real feature, not a cleanup | Can ship 4.0 without Budget Account 2.0 if needed. The 3.9 JSDoc note "v1, rebuild planned" gives us a graceful holding pattern. |

---

## Decisions made (2026-05-20)

The original "open questions" section is preserved here as decisions, with reasoning, so future readers see how we got here:

1. **`createX402Client` and `wrapFetch` — `@deprecated` in 3.9, removed in 5.0.** Reasoning: `payAndFetch` is the only version-agnostic client. The others are v2-centric bridge code with the wrong shape (no discriminated-union return, no clean merchant-vs-settlement-failure split). Longer migration window than the 4.0 batch because they have 7 + 3 real consumers; 5.0 (~6 months later) gives them runway.

2. **`stripePayTo` — `@deprecated` in 3.9, removed in 4.0.** Reasoning: read the source. It's a Stripe `PaymentIntent` machine-payments provider for `x402Middleware`. Only consumers are the `/stripe` marketing page on dexter-fe. The audience for x402 in 2026 is "agents paying with USDC," not "merchants who want Stripe with crypto sprinkles."

3. **`token-pricing.ts` — `@deprecated` in 3.9, removed in 4.0.** Reasoning: it's the tiktoken LLM-token pricer, same January-era v1 stopgap as Access Pass and Dynamic Pricing. x402 v2 dynamic pricing supersedes it. Removing it also resolves the `ModelPricing` name collision automatically.

4. **No static counts in the README.** The "5,000+ paid APIs" number was 10× out of date (current ~50,000). Static counts go stale faster than the README gets rewritten. Replace with qualitative phrasing ("tens of thousands of paid APIs").

5. **`MIGRATION.md` — yes.** ~1 page, written at the very end of the 4.0 cycle (PR 11), one section per removed symbol mapping to its replacement.

---

## Definition of done

**3.9 ships when:**

- [x] PR 1 merged: `@deprecated` markers — first-removal-target (Access Pass / Dynamic Pricing / Browser Support / Stripe / Token Pricing / model-registry / useAccessPass) AND second-removal-target (`wrapFetch` / `createX402Client`)
- [x] PR 2 merged: `client/index.ts` reorganized
- [x] PR 3 merged: `PayResult` no longer lies about network
- [x] PR 4 merged: README rewrite
- [ ] PR 5 merged: timeout double-charge — stop the lie (two-phase timeout, `payment_unconfirmed`)
- [ ] PR 6 merged: timeout double-charge — chain confirmation
- [ ] PR 7 merged: timeout double-charge — `x402-mcp-tools` consumer fix (dexter-mcp)
- [ ] PR 8 merged: facilitator/mcp dep cleanup (separate repos)
- [ ] CHANGELOG entry for 3.9.0 written
- [ ] Tests green
- [ ] Published to npm (PR 9)
- [ ] One umbrella repo (dexter-fe or dexter-api) bumps to 3.9.0 and rebuilds clean

**The post-3.9 removal cycle ships when (NOT committed — see "Post-3.9 sketch"):**

- [ ] Sketch PR R1 merged: dexter-lab agent template updated and deployed (all D6 emission sites, including the `MODEL_PRICING` and `createTokenPricing` ones the original plan missed)
- [ ] Sketch PR R2 merged: deprecated files deleted (access-pass, dynamic-pricing, browser-support, stripe-payto + middleware Stripe codepath, token-pricing, model-registry, useAccessPass)
- [ ] Sketch PR R3 merged: Budget Account 2.0
- [ ] Sketch PR R4 merged: MIGRATION.md + first-removal-release tag and publish
- [ ] CHANGELOG entry with prominent "Breaking" section
- [ ] Tests green
- [ ] Published to npm
- [ ] One umbrella repo upgrades and rebuilds clean

**The second removal release ships when (target: ~6 months later):**

- [ ] Sketch PR R5 merged: `wrapFetch` + `createX402Client` removed
- [ ] MIGRATION.md updated with the 5.0 section
- [ ] CHANGELOG entry for 5.0.0 with "Breaking" section citing the 3.9 deprecation
- [ ] Tests green
- [ ] Published to npm

---

*This plan exists so the cleanup is decided once, executed mechanically, and never requires re-litigating. If a finding here turns out to be wrong (the way sponsored-access did in the audit), correct it here first, then in the PR.*
