# `live-chain` — paid live Solana stream

> Pay-per-event Solana streaming from a vault you alone control. An **unruggable channel** built on `@dexterai/x402/tab`.

## What this is

A working demo of **pay-per-event metered access to live Solana on-chain data**. The buyer opens a Tab against the relay, picks a wallet (or program) to watch, and gets a live stream of Solana transactions. The vault balance ticks down per voucher batch as events flow. When the buyer closes the tab, settlement lands on mainnet.

The buyer never gives up custody. The seller never holds escrow. The facilitator never holds the float. Funds stay in the buyer's vault, signed for by the buyer's passkey, the entire time. The channel is **unruggable.**

## What's inside

```
live-chain/
├── relay/         The seller-side service. Helius Laserstream subscription
│                  multiplexed to N paying buyer connections via SSE, with the
│                  Tab seller middleware metering per-event accrual.
├── demo-app/      The buyer-side UI. Pick a wallet to watch, see live tx
│                  flash, see USDC tick down per event batch, close tab,
│                  see the settlement Solscan link.
└── README.md      This file.
```

## Why this demo matters

Pay-per-call is already a thing in RPC pricing — every provider sells credit packs (Helius, QuickNode, Alchemy). The current model is: sign up → put in a credit card → buy 100M credits → key gets metered down → top up via Stripe when low.

The friction is **the signup, the credit card, the manual top-up, and the static rate limits.** What x402 + the Dexter vault change:

> Agent shows up with a vault → makes a streaming RPC call → events get settled per-batch → no account, no top-up, no key rotation.

This is a legitimate product gap for streaming infra incumbents, not a vanity demo. Three reasons it lands:

1. **Agent traffic story.** "Solana for agents" is on-thesis for Helius. A streaming endpoint that an agent can hit without going through a human-onboarding flow matches the narrative.
2. **Long-tail customers.** Agents that want 5,000 events and then disappear. Those customers can't justify a $50/mo plan. Without x402 they're lost revenue; with it they're captured per event.
3. **Premium-endpoint upsell.** Laserstream/Sender/Geyser are exactly the kind of streaming, per-millisecond-cost products where channel-pattern billing actually shines. "Pay per Laserstream second" is more compelling than "pay per call" — and only this architecture can do it without a settlement-per-millisecond gas nightmare.

## Architecture

```
┌──────────────────┐                  ┌─────────────────────────┐
│   buyer (CLI     │                  │   relay (Node + SSE)    │
│   or browser)    │   X-Tab-Voucher  │                         │
│                  │ ───────────────▶ │   tabMiddleware()       │
│ openTab({       })│                  │   ↓                     │
│   vault,         │ ◀─── event chunk │   subscribe to Laser-   │
│   seller,        │     (text/event- │   stream once, fan out  │
│   perUnitCap,    │      stream)     │   to all paying buyers  │
│   totalCap,      │                  │                         │
│ })               │ ────close tab──▶ │   on close: settle      │
└──────────────────┘                  └──────────┬──────────────┘
        │                                        │
        │                                        ▼
        │                              ┌─────────────────────┐
        │ ◀──── settlement tx sig ──── │  facilitator        │
        │                              │  x402.dexter.cash   │
        ▼                              └─────────────────────┘
   vault PDA on Solana
   (pending_voucher_count
    ticks up on open,
    down on close)
```

### Voucher cadence

Per-event accrual at Laserstream burst rates (hundreds of tx/sec on busy wallets) is a signature storm. The relay batches:

- **N=10 events per voucher** (default), OR
- **M=500ms wall clock since last voucher**, whichever comes first.

Tunable per-tab via the `openTab` options. The Tab SDK's `perUnitCap` controls the dollar per-batch.

## Running the demo

### One-time setup

```sh
# From repo root
npm install

# .env file in live-chain/relay/ — see relay/README.md for the full list
cd examples/live-chain/relay
cp .env.example .env
# Fill in HELIUS_API_KEY, SOLANA_RPC_URL, SELLER_PRIVATE_KEY
```

### Run

```sh
# In one terminal — the relay
cd examples/live-chain/relay
npm run dev

# In another terminal — the buyer demo
cd examples/live-chain/demo-app
npm run dev
```

Open `http://localhost:3000`. Pick a wallet (a few defaults are pre-populated). Watch the tx feed. Watch USDC tick down. Close the tab. See the Solscan link.

## Proof run — what landed on mainnet 2026-06-02

Run against a freshly-enrolled scripted vault, watching the USDC mint for traffic:

- **1069 Solana transactions** streamed through the metered SSE pipe in ~25 seconds
- **5 rounds** of voucher-bounded budgets ($0.01 each, 100 events per round)
- **Auto-loop** worked — the buyer kept buying new rounds as each $0.01 budget exhausted
- **Vault stayed liquid** — funds never left the buyer's vault PDA during the run
- **Settled $0.05** off-chain (vouchers signed and accepted by the seller middleware)

Mainnet artifacts from the proof run:
- Buyer vault PDA: `4mt4KsJykyc7JRa1hYsuqJvcabfNtBJ6R3p4vCMs3GP2`
- Buyer swig: `E6iBgjoqBo1V53KUxGnWA6gSq6Ywc6Xui9fZMwLAYCdH`
- Funding tx (`$1` USDC into swig): `TJhVmDx3gksGqrxZTY9iNuvv2U6veQJTNtzBapyq3QMkLZRoJk8bBAqds4Pkwc7q1pEjiSjJb9UNA13EM67YrUr`

## Settled on chain (live since 2026-06-03, `@dexterai/x402@3.10.0`)

`tab.close()` POSTs the buyer's final session-signed voucher to the facilitator's `POST /tab/settle` endpoint, which submits a 5-instruction tx that moves USDC from the buyer's swig wallet PDA's ATA to the seller's ATA — atomically with `vault.active_session.spent` advancing and `pending_voucher_count` decrementing. After the settle lands, the SDK revokes the session key.

The settle is gated entirely on the session key's Ed25519 signature over the canonical 44-byte voucher message (verified by the Solana Ed25519 sigverify precompile as a sibling of the new `vault.settle_tab_voucher` instruction). The facilitator's master keypair signs `settle_tab_voucher` as `dexter_authority` for the `pending_voucher_count` decrement but is NEVER in the spend path — the unruggable-channel property is structurally enforced on chain.

Mainnet proof run, fresh role-3 vault:
- Settle tx: [`4VLDNUDtY8Q3ucwFyuCEz7BsBFqYzUo2ANQv4KU2TDnrUEcn9tS7KmyqHGkZjM6AqEf9uZuS1W5CTQ1RKL47QU89`](https://solscan.io/tx/4VLDNUDtY8Q3ucwFyuCEz7BsBFqYzUo2ANQv4KU2TDnrUEcn9tS7KmyqHGkZjM6AqEf9uZuS1W5CTQ1RKL47QU89)
- Buyer vault PDA: `F8mxdRs1r2t52tJkawmi6v3Uo5TP11Pr2r2qL24XvKcY`
- Buyer swig: `B4uzAVY4eqLdFGtcuYxyEo8kqnjD16VnpedJv5vRZgSz`
- Seller ATA delta: `100000` → `101000` atomic (= $0.001 USDC moved, exact match for the test voucher's cumulative amount)

Older Swigs created before the role-3 marker was added to `dexter-api/src/vault/swigBundle.ts` cannot Tab-settle on chain and need to re-enroll.

## What's NOT in the demo (yet)

- **Multi-program filters.** Demo only supports per-wallet for now. Per-program / per-token filters are a follow-up — the relay subscribes to Laserstream once and routes; adding filter types is a routing-layer change, not an architecture change.
- **Browser passkey signing.** Demo uses a scripted vault (P-256 software keypair) for dev iteration. Browser/iPhone passkey path lands when we wire WebAuthn into the demo-app (Phase 5 of the Tab SDK).
- **Multi-buyer fan-out at scale.** The relay multiplexes from one Laserstream subscription, but only basic per-connection backpressure is in place. Production hardening (rate caps per buyer, slow-consumer disconnect) is a follow-up.
- **Public deploy.** Demo runs locally for now. Public demo domain TBD.

## License

MIT, same as the rest of `@dexterai/x402`.
