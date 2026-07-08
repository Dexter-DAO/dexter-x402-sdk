# push-per-send

Your agent can page you. A penny a send, hard-capped.

One Express server with one paid route:

```
POST /send  { "channel": "telegram" | "email", "to": "...", "message": "..." }
```

Every send costs $0.01 USDC on Solana, collected by a single x402 payment
middleware from `@dexterai/x402`. The same 402 challenge offers two ways to pay:

| Rail    | Who it fits                | How it works                                                                 |
| ------- | -------------------------- | ---------------------------------------------------------------------------- |
| `tab`   | agents that page you a lot | open a non-custodial spend tab once, page N times, settle once on close      |
| `exact` | one-off callers            | pay $0.01 up front, per request                                               |

The hard cap is the tab's `totalCap`: the vault owner authorizes a ceiling when
the session opens, it is enforced on-chain, and the agent cannot page past it.
The server holds no keys: `SELLER_PAYTO` is a receive-only pubkey.

## Run it in one minute (no secrets)

```bash
npm install
cp .env.example .env        # defaults are ready for a mock run
npm start                   # DELIVERY_MODE=mock in .env.example
```

Ask for a send without paying and you get the paywall:

```bash
curl -si -X POST localhost:4880/send \
  -H 'content-type: application/json' \
  -d '{"channel":"telegram","to":"123456","message":"hi"}'
```

```
HTTP/1.1 402 Payment Required
{ "x402Version": 2, "accepts": [ { "scheme": "tab", ... }, { "scheme": "exact", ... } ], ... }
```

Both entries quote `10000` atomic ($0.01, USDC has 6 decimals) payable to
`SELLER_PAYTO` on `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (CAIP-2 mainnet).

## Pay for a send

`buyer-snippet.ts` walks all three stages; each one runs standalone:

```bash
npm run buyer discover      # free: resolve the tab offer + settlement terms
npm run buyer oneshot       # payAndFetch pays $0.01 on the exact rail
npm run buyer tab           # open a tab, page 3x, close -> one settle tx
npm run buyer               # all of the above, skipping stages without creds
```

- `discover` needs nothing.
- `oneshot` needs `BUYER_SOLANA_SECRET_KEY` (a keypair with a little USDC +
  SOL). Without it the snippet uses an unfunded throwaway key so you can watch
  `payAndFetch` return its failure shape instead of paying.
- `tab` needs a Dexter Vault (`VAULT_*` and `FEE_PAYER_SECRET_KEY` in `.env`).
  This is the rail agents actually use: `payUrlWithTab` opens the session on
  the first call, reuses it for the rest, and `tab.close()` settles everything
  in one transaction. The snippet always closes in a `finally`: vouchers are
  bearer claims, so settle even after a failed page.

Set `PAGE_CHANNEL` / `PAGE_TO` to a real destination before paying: a Telegram
chat id, or an email address.

## How delivery works (and how to swap it)

The paid handler does not talk to Telegram or SMTP itself. It POSTs to
dexter-api's internal notify relay:

```
POST {DEXTER_API_BASE}/api/internal/notify/push
X-Internal-Auth: {DEXTER_INTERNAL_TOKEN}
{ "title", "message", "channels": ["telegram"], "telegramChatId" | "emailTo", ... }
```

That relay fans out through the same production notifier that pages Dexter's
own operators, so this example ships zero sender code and zero bot/SMTP
secrets. Running Dexter's infra? Set `DEXTER_INTERNAL_TOKEN` and
`DELIVERY_MODE=live`. Anyone else has two options:

1. `DELIVERY_MODE=mock`: full payment flow, pages logged to stdout.
2. Replace the one `deliver()` function in `server.ts` with your own sender.
   Everything about the paywall stays identical.

## Pricing

The price is decided per request, in integer USDC microunits, inside
`priceMicroFor()` in `server.ts` ($0.01 = `10_000n`; integers only near money).
Two prices exist on the tab rail:

- the middleware's `perUnit` is the **sticker**: what the 402 advertises, and
  what `exact` buyers settle before your handler runs;
- the meter's `perUnit` (`openSse`) is the **bill**: what `charge()` actually
  draws on the tab.

This example keeps them equal. If you vary the bill per request, keep the
sticker honest for one-shot buyers.

## Failure honesty

- A malformed body with payment attached gets `400` **before** any charge.
- A malformed body with no payment gets the standard `402` (so catalog crawlers and
  `resolveTabOffer` always see the challenge).
- Tab rail delivers first and charges after: a failed page costs the buyer
  nothing; the seller's exposure is one un-charged send.
- Exact rail settles up front, so a delivery fault answers `502` with the
  payment transaction included for reconciliation.

## Production notes

- **Do not set `lockCadence`.** It is omitted here on purpose: the facilitator
  owns crystallization cadence server-side as of 5.3.1. It is a risk dial, not
  a performance dial. Ship without it.
- `tabOrExactMiddleware` keeps per-channel accounting in process memory. A
  restart mid-tab is safe for funds (vouchers are verified on-chain
  state + signatures) but forgets accrual counters; for durable, multi-instance
  setups see `ChannelLedger` in the seller docs
  (https://docs.dexter.cash/docs/get-paid/sell-with-tabs).
- Knowing you were paid: `tab.cumulative()` / receipts are **accrual**
  counters, not settlement confirmations. Settlement happens at tab close (the
  buyer receives the settle tx). To observe money, watch `SELLER_PAYTO`'s USDC
  token account on chain.
- The default facilitator is `https://x402.dexter.cash` (omitted config).
  The RPC connection is used once per tab session for a registration read,
  never on the 402 path and never per send.
