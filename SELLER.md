# Accept agent payments as a seller — Dexter Tabs

> **For the integrator (human or agent):** this is the complete, self-contained
> path to get paid by AI agents on your API. Read it top to bottom and you can
> wire it in. Front door is **`@dexterai/x402`**; you do not need `@dexterai/vault`
> (that's the engine, not the front door). USDC on Solana.

## What you get

An agent opens a **tab** against its owner's wallet — a capped spending line your
server meters per request. You get paid for what you serve; the buyer cannot pull
their funds out from under charges you've already accrued. One on-chain settle at
the end pays you for everything spent. No per-request signature, no gas on your side.

**The guarantee, stated precisely:** as the agent spends, accrued charges crystallize
on-chain into a *reservation* against the buyer's wallet — sized to exactly what's
been accrued, not the whole wallet. The buyer can still move the rest of their
balance, but cannot withdraw out from under your reservation. Settlement pays you the
reserved amount. (This is the **lock** model, the default since 2026-06. It replaced a
whole-wallet freeze.)

**Honest status:** the program is **pre-audit** (funding in flight). Say so in your own
diligence. The withdrawal-gate guarantee is exercised on Solana mainnet with a
committed receipt; credit/factoring are separate products built on the same substrate,
not required for seller integration.

## Install

```bash
npm install @dexterai/x402
```

## The minimal seller (recommended default)

`tabOrExactMiddleware` advertises a tab AND a one-shot price in a single `402`
challenge, so tab-paying agents and one-shot callers both work at the same price.

```ts
import { tabOrExactMiddleware, requireTab, openSse } from '@dexterai/x402/tab/seller';
import type { X402Request } from '@dexterai/x402/server';

app.get('/paid/answer',
  tabOrExactMiddleware({
    connection,                       // your Solana Connection (any RPC)
    sellerPubkey: YOUR_USDC_ADDRESS,  // where you receive USDC (base58)
    network: 'solana:mainnet',
    perUnit: '0.01',                  // USD per unit
  }),
  async (req, res) => {
    // One-shot caller paid exact — serve and return.
    if ((req as X402Request).x402) { res.json({ data: '…', paidVia: 'exact' }); return; }

    // Tab caller — meter the work. charge() demands a fresh voucher before each
    // unit and throws if the tab's cap is exceeded; send() pushes the chunk.
    const tab = requireTab(req);
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(1);
    meter.send(JSON.stringify({ data: '…' }));
    await meter.end();                // ALWAYS await — flushes the final delivered amount
  },
);
```

That's the whole integration. `await meter.end()` is required (it persists the final
delivered total). A tab-only endpoint instead composes `tabChallengeMiddleware` (answers
voucher-less requests with the discovery challenge) before `tabMiddleware` (verifies the
per-charge vouchers) — both from `@dexterai/x402/tab/seller`.

## How you know you got paid

The buyer's agent settles on tab close: one on-chain transaction pays your
`sellerPubkey` for everything metered. You hold no key and sign nothing — Dexter's
facilitator drives settlement. Your `charge()` calls are the meter; the reservation
is what makes the settle collectible.

## One caveat that matters at scale

The default per-channel ledger enforces "one live stream per tab" correctly **within a
single server process**. If you run **multiple instances behind a load balancer**, back
the ledger with an atomic lease (Redis `SET NX PX`, or Postgres advisory lock /
`INSERT ON CONFLICT`), or route a given tab's requests to a consistent instance —
otherwise concurrent same-tab streams across instances can over-deliver. Single-process
sellers need nothing extra.

## Networks

USDC on Solana (`solana:mainnet`). The on-chain program enforcing the cap and the
reservation is `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc` — verifiable on Solscan.

## More

- Full package reference (buyer side, one-shot, batch, discovery): the
  [`@dexterai/x402` README](https://www.npmjs.com/package/@dexterai/x402).
- Live demo with real payments: https://dexter.cash/sdk
- Questions / diligence: branch@dexter.cash
