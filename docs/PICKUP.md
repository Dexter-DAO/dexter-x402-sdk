# Pickup — SDK 3.9 cycle (complete) + open follow-ups

**For:** a fresh Claude (or human) picking up after a context reset.
**Updated:** 2026-05-21 (post-publish).

---

## TL;DR — the 3.9 cycle is DONE and PUBLISHED

`@dexterai/x402@3.9.0` is live on npm. The SDK work is finished. What
remains is consumer-side and facilitator-side, none of it in this repo.
Do NOT re-do the 3.9 PRs — they all shipped.

---

## Read these files first

1. **[FOLLOWUPS.md](./FOLLOWUPS.md)** — the live list of open issues (F1–F6). This is the actionable doc now. Read it before doing anything.
2. **[PLAN.md](./PLAN.md)** — the 3.9 cycle (done) + a NON-committed sketch of the post-3.9 removal cycle.
3. **[DESIGN-timeout-double-charge.md](./DESIGN-timeout-double-charge.md)** — design for the timeout double-charge fix (shipped as PRs 5/6).
4. **[AUDIT-2026-05-20.md](./AUDIT-2026-05-20.md)** — original SDK audit. Its `§0`/`§0a`/`§0b` errata explain earlier wrong calls; `§0b` matters if you ever touch model-registry / stripe-payto / token-pricing (they have internal SDK consumers).

---

## State at this pickup point

- **SDK version:** **3.9.0 — published on npm.**
- **`main` HEAD:** `04816c7` (or later — check `git log -1`).
- **Working tree:** clean. Nothing in flight.
- **Tests:** 278 passing.

---

## The 3.9 cycle — all shipped

| PR | Title | Commit |
|---|---|---|
| 1 | `@deprecated` markers on 9 v1-era files | `1722506` |
| 2 | Reorganize `client/index.ts`, promote `payAndFetch` | `d332b0e` |
| 3 | Fix `PayResult` phantom-network bug | `8d72512` |
| 4 | README full rewrite | `24b928d` |
| 5 | Timeout fix — two-phase timeout, `payment_unconfirmed` | `200be1d` |
| 6 | Timeout fix — on-chain settlement confirmation | `26658f8` |
| ~~7~~ | dep cleanup — **dropped** (audit's premise was wrong; see FOLLOWUPS F3) | — |
| 8 | Publish 3.9.0 | `b50349e` + tag `v3.9.0` |

The money-loss double-charge bug (`payAndFetch` reporting `timeout` on a
payment that settled) is fixed and published. Both v1 and v2 strategies.

---

## What actually remains — all in FOLLOWUPS.md

Nothing left to do *in this SDK repo* for 3.9. The open items:

- **F6** — batch-settlement `close()`/settle path returns a `CloseReceipt`
  with `undefined` tx hashes. The deposit + paid-call path is PROVEN
  working (the earlier deposit failure was a stale facilitator process —
  fixed by rebuild+restart). The settle/close failure is new, undiagnosed,
  lives in `dexter-facilitator` + upstream `@x402/evm`. Own session.
- **F4** — dexter-api verifier: a `U+0000` byte breaks a Postgres write.
  Verifier-owner's bug, not the SDK's.
- **F1** — EVM pre-payment balance check not bounded by the pre-payment
  timeout. Low severity, unscheduled.
- **F3** — `dexter-facilitator` SDK pin is stale text (`^1.7.2`). Already
  bumped to `^3.9.0` this session. **Do NOT drop the dependency** — three
  `scripts/` files import it. (FOLLOWUPS may still say "open"; the bump is
  done — only the cosmetic note remains.)
- **F2** — dexter-api verifier `PayResult` adaptation: **DONE** (the
  dexter-api agent shipped `ce9267e`).
- **PR 9 consumer fixes** — `opendexter-ide` x402-mcp-tools `fetch` tool
  needs `payment_unconfirmed` handling (it currently renders it as a
  generic "Payment failed", which invites a double-charging retry, and
  reads `payResult.response` unconditionally — crashes on the new
  `paid:true, response:undefined` shape). This is now unblocked (3.9 is
  published). Owned by the OpenDexter side. `dexter-mcp` is NOT a consumer
  — it uses `wrapFetch`, never sees `PayResult`.

---

## The post-3.9 removal cycle — a SKETCH, not committed

PLAN.md has a "post-3.9 sketch" section (PRs `R1`–`R5`) for removing the
`@deprecated` v1-era helpers. **It is a thinking-aid, not a roadmap.**
Whether removals land as 3.10, 4.0, or something else gets decided after
3.9 has been out with real consumers. If you see "4.0" anywhere, it is a
placeholder name, not a decided release.

---

## Hard rules — still apply if the removal cycle is taken up

1. **No commit message disparages an old feature.** Frame forward.
2. **`@deprecated` in 3.9 (done), removals in a later major.** No mixing.
3. **No removal until the dexter-lab agent-template references are
   updated** — it emits `createDynamicPricing` / `x402AccessPass` /
   `x402BrowserSupport` / `createTokenPricing` / `MODEL_PRICING` in
   generated code. Full list in PLAN §D6.
4. **`model-registry.ts` / `stripe-payto.ts` have internal SDK consumers**
   — not deletable standalone. See AUDIT §0b.
5. **Test suite stays green at every step.** 278 passing now.
6. **If a finding turns out wrong: fix it in AUDIT + PLAN first, then the
   code.** The audit was wrong twice (sponsored-access, model-registry)
   and once about the dexter-facilitator dep — verify before acting.

---

*The 3.9 SDK cycle is complete. This file's job now is to stop a fresh
agent from re-doing finished work and to point at FOLLOWUPS.md for what's
actually left.*
