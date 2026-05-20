# `@dexterai/x402` 3.9 + 4.0 Plan

**Status:** DRAFT — for internal planning only. Not for external/public framing.
**Companion document:** [AUDIT-2026-05-20.md](./AUDIT-2026-05-20.md) — read first.
**Updated:** 2026-05-20 (rebaselined from 3.8 → 3.9 because the team shipped 3.8.0 + 3.8.1 — the bazaar discovery extension — between the audit and this plan).

**Current published version:** 3.8.1
**Target deprecation release:** 3.9.0
**Target removal release:** 4.0.0

---

## Decision tree

The audit identified a clear shape:

- **One** file to delete outright (`model-registry.ts`, 789L, 0 consumers).
- **Several** files to deprecate now and remove in 4.0 (the older feature-demos: Access Pass, Dynamic Pricing, Browser Support).
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

| Symbol / file | 3.9 action | 4.0 action |
|---|---|---|
| `src/server/model-registry.ts` (789L) | **DELETE in 3.9** (no `@deprecated` cycle needed — 0 consumers, no migration to give) | already gone |
| `src/server/access-pass.ts` | `@deprecated` | DELETE |
| `src/react/useAccessPass.ts` | `@deprecated` | DELETE |
| `src/server/dynamic-pricing.ts` | `@deprecated` | DELETE |
| `src/server/browser-support.ts` | `@deprecated` | DELETE |
| `src/client/budget-account.ts` | **Keep** — flag in JSDoc as "v1, rebuild planned for 4.0" | **REBUILD** (Budget Account 2.0, see D5) |
| `src/client/sponsored-access.ts` | **Keep + promote** | Keep |
| `src/server/token-pricing.ts` | Keep (3 consumers + likely default after Dynamic Pricing is gone) | Keep |
| `src/payment/*` | Keep — this is the new baseline | Keep |
| `src/batch-settlement/**` | Keep | Keep |

### D3. README rewrite scope (3.9)

- **Promote in Quick Start:** `payAndFetch` as the canonical client recipe.
- **Promote in Why-This-SDK headline:** batch-settlement, sponsored-access (the MCP-tool reality), and `payAndFetch`.
- **Demote to "Legacy capabilities" appendix:** Access Pass, Dynamic Pricing.
- **Strengthen, don't cut:** Sponsored Access — concrete example showing the MCP `fetch` tool extracting and rendering recommendations.
- **Delete entirely:** all README mentions of `MODEL_REGISTRY` and `model-registry` (no migration path, no JSDoc deprecation; the file is gone in 3.9).
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

// ── Legacy client APIs (predate payAndFetch — kept for migration) ──
export { createX402Client, wrapFetch, getPaymentReceipt } from './x402-client';
```

No `@deprecated` on `createX402Client` / `wrapFetch` — they have real consumers and a working role as the lower-level API.

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

The agent at `dexter-lab/app/lib/.server/agent/dexter-agent.ts:163-170` emits this advice into generated user code:

> 2. **Dynamic Pricing** (`createDynamicPricing`) - Scales with input
> 4. **Access Pass** (`x402AccessPass`) - Pay once, unlimited requests

Plus references in `app/lib/.server/agent/mcp-tools.ts` and `app/utils/templates/index.ts`.

**Action:** before 4.0 ships, update the dexter-lab agent template to recommend the new canonical paths instead. This is a separate PR in the dexter-lab repo, not the SDK repo, but **gates the SDK's 4.0 release**.

### D7. Consumer pin updates

`dexter-mcp` currently pins `@dexterai/x402: ^2.0.0`. It IS used at runtime via dynamic import. **Bump to `^3.7.x` as part of PR 5** so the dynamic-import resolves to a current SDK, not a wildly stale one.

`dexter-facilitator` pins `^1.7.2`, doesn't import the SDK at all. **Drop the dependency as part of PR 5.**

---

## PR plan

Each PR is independently revertable. Each PR is small. Each PR can ship on its own without depending on a later PR.

### PR 1 — Delete `model-registry.ts` (3.9)

- Delete `src/server/model-registry.ts` (789L).
- Remove its exports from `src/server/index.ts`.
- CHANGELOG entry under "Removed."
- Commit message: `refactor(server): remove unused model-registry; token-pricing is the canonical pricing helper`

**Acceptance:** typecheck green, tests green, no consumer in the umbrella imports anything from `model-registry`.

### PR 2 — `@deprecated` markers (3.9)

- Add `@deprecated` JSDoc to:
  - `src/server/access-pass.ts` exports
  - `src/server/dynamic-pricing.ts` exports
  - `src/server/browser-support.ts` exports
  - `src/react/useAccessPass.ts`
- No runtime behavior changes.
- CHANGELOG entry under "Deprecated."
- Commit message: `chore(server,react): mark v1-era helpers @deprecated ahead of 4.0`

**Acceptance:** typecheck green, tests green. Consumers using the deprecated APIs see editor warnings but their code still runs.

### PR 3 — `client/index.ts` hierarchy (3.9)

- Reorganize `client/index.ts` exports into the commented sections in D4.
- No symbol additions/removals — only reordering + comments.
- Commit message: `docs(client): group exports by role; promote payAndFetch as canonical 2026+ entry`

**Acceptance:** all existing imports still resolve, typecheck green, tests green.

### PR 4 — `dispatcher.ts` PayResult fix (3.9)

- Add `paid: true | false` discriminator to `PayResult` (or make `network` optional on the no-payment branch).
- Fix the placeholder at `dispatcher.ts:104-112` so it returns truthful data.
- Update v2-strategy and v1-strategy to match.
- Update tests.
- CHANGELOG entry under "Fixed."
- Commit message: `fix(payment): PayResult no longer reports fake network for unpaid responses`

**Acceptance:** consumers reading `result.network` on a non-paid response now get either `null` or a `paid: false` branch — never a phantom Base default.

### PR 5 — README rewrite (3.9)

- Reorder sections per D3.
- Promote `payAndFetch` to Quick Start.
- **Add a "Discovery extensions" section** that documents the 3.8.0 bazaar extension (`bazaarExtension`, `declareDiscoveryExtension`, the `extensions` + `declarations` middleware config). New feature, shipped, not yet in README. Show the canonical recipe and link to the upstream bazaar spec.
- Strengthen Sponsored Access section with the MCP-tool reality.
- Demote Access Pass, Dynamic Pricing to "Legacy capabilities" appendix.
- Update CHANGELOG with "Documentation" note pointing readers at the new layout.
- Commit message: `docs(readme): restructure to lead with payAndFetch + batch-settlement + bazaar + sponsored-access`

**Acceptance:** a new adopter reading the README top-down meets the canonical 2026+ paths (including the new bazaar discovery extension) in the first 200 lines.

### PR 6 — Consumer dep cleanup (separate repos, not SDK)

- `dexter-facilitator/package.json`: drop `@dexterai/x402` dependency entirely (not imported in source).
- `dexter-mcp/package.json`: bump pin from `^2.0.0` to `^3.8.x` (current published).
- Each in its own commit/PR in its own repo.

**Acceptance:** both repos build, tests green, runtime behavior unchanged.

### PR 7 — Tag and publish 3.9.0

- Final CHANGELOG pass.
- `npm version minor` → 3.9.0.
- `npm publish`.
- Tag the commit.

**Acceptance:** `npm install @dexterai/x402@3.9.0` works; consumers updating from 3.8.x see no breakage but get the deprecation warnings.

---

## 4.0 PR plan (deferred ~1 month)

### PR 8 — Update dexter-lab agent template

- In `dexter-lab` (not the SDK repo): rewrite `app/lib/.server/agent/dexter-agent.ts:163-170` and the other template references so generated code recommends the canonical 2026+ paths (`payAndFetch`, batch-settlement, sponsored-access).
- This PR **gates** PR 9 — must ship and be deployed first.

### PR 9 — Actual removals (4.0)

- Delete `src/server/access-pass.ts`, `src/server/dynamic-pricing.ts`, `src/server/browser-support.ts`, `src/react/useAccessPass.ts`.
- Remove their exports from `src/server/index.ts` and `src/react/index.ts`.
- Remove their README sections entirely (already moved to legacy appendix in PR 5; now delete the appendix).
- CHANGELOG entry under "Removed" with one bullet per file, citing the deprecation in 3.9.
- Commit message: `refactor!: remove v1-era helpers deprecated in 3.9 (access-pass, dynamic-pricing, browser-support, useAccessPass)`

**Acceptance:** typecheck green, tests green. Consumers who ignored the 3.9 deprecation warnings now get hard build errors with a CHANGELOG pointing them at the migration.

### PR 10 — Budget Account 2.0 (4.0)

- Rewrite `src/client/budget-account.ts` per D5: envelopes, pluggable storage, observability hooks, approval flow, per-domain caps.
- New `BudgetStorage` interface in `src/client/budget-storage.ts` mirroring `ChannelStorage`'s shape.
- Tests covering each new capability.
- README section updated with the new surface.
- Commit message: `feat(client): Budget Account 2.0 — persistent, observable, envelopes, approval flow`

**Acceptance:** skillsmith-cli (the existing consumer) can adopt the new API with a deprecated alias path supported in 4.0.x; new consumers get the full surface.

### PR 11 — Tag and publish 4.0.0

- Final CHANGELOG with prominent "Breaking" section listing every removal and the Budget Account API change.
- Migration guide section in the README.
- `npm version major` → 4.0.0.
- `npm publish`.

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

## Open questions (resolve before PR 1)

1. **`createX402Client` and `wrapFetch` — keep both forever, or eventually consolidate into `payAndFetch`?**
   - Current plan: keep both, no `@deprecated`. They have real consumers and a lower-level role.
   - Alternative: `@deprecated` them in 4.x with a 5.0 removal target.
   - **Need your call.**

2. **`stripePayTo` — what is this actually for?**
   - 2 consumers, both dexter-fe. Not clear if it's a marketing demo or a real feature.
   - Need to read it before deciding.

3. **`token-pricing.ts` — keep or also deprecate?**
   - 3 consumers (1 dexter-api, 2 dexter-fe).
   - Currently planned: keep. If the dexter-api use is a real prod path, keep; if it's another demo, deprecate alongside the others.

4. **README "Marketplace Discovery" section (currently §3) — accurate?**
   - Sells "5,000+ paid APIs" auto-discovery. Is that still the marketplace state, or also a January-era number?
   - Need to verify before the README rewrite.

5. **Do we want a `MIGRATION.md` for 4.0?**
   - Convention says yes for any 4.0.
   - Scope = 1 page mapping each removed symbol to its replacement. Mostly auto-generatable from the deprecation list.

---

## Definition of done

**3.9 ships when:**

- [ ] PR 1 merged: `model-registry.ts` removed
- [ ] PR 2 merged: `@deprecated` markers on Access Pass / Dynamic Pricing / Browser Support / useAccessPass
- [ ] PR 3 merged: `client/index.ts` reorganized
- [ ] PR 4 merged: `PayResult` no longer lies about network
- [ ] PR 5 merged: README rewrite
- [ ] PR 6 merged: facilitator/mcp dep cleanup (separate repos)
- [ ] CHANGELOG entry for 3.9.0 written
- [ ] Tests green
- [ ] Published to npm
- [ ] One umbrella repo (dexter-fe or dexter-api) bumps to 3.9.0 and rebuilds clean

**4.0 ships when:**

- [ ] PR 8 merged: dexter-lab agent template updated and deployed
- [ ] PR 9 merged: deprecated files deleted
- [ ] PR 10 merged: Budget Account 2.0
- [ ] MIGRATION.md written (if D5 yes)
- [ ] CHANGELOG entry for 4.0.0 with "Breaking" section
- [ ] Tests green
- [ ] Published to npm
- [ ] One umbrella repo upgrades to 4.0 and rebuilds clean

---

*This plan exists so the cleanup is decided once, executed mechanically, and never requires re-litigating. If a finding here turns out to be wrong (the way sponsored-access did in the audit), correct it here first, then in the PR.*
