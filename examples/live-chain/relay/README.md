# `live-chain` relay

Seller-side service for the [`live-chain`](../README.md) demo. Multiplexes a single Helius Laserstream subscription per watched account to N paying buyer connections via SSE, with the `@dexterai/x402/tab/seller` middleware enforcing voucher-gated access.

## Files

- `src/subscriber.ts` — `LaserstreamMux`: one Laserstream subscription per account, fanned out to per-buyer listeners with auto-teardown when the last listener leaves.
- `src/index.ts` — Express server. `GET /healthz` for ops, `GET /stream/:account` SSE endpoint behind the Tab middleware.

## Voucher cadence

The relay batches events into voucher windows. A window emits when either:

- **`VOUCHER_BATCH_EVENTS`** events have accumulated (default 10), OR
- **`VOUCHER_BATCH_MS`** ms have elapsed since the last emission (default 500ms).

Per batch the buyer is expected to submit a fresh voucher whose cumulative amount has advanced by `events_in_batch × EVENT_PRICE_USDC`. If they don't, the next batch isn't gated through and the connection is closed.

The cadence is configurable per deployment but not per-tab in this version. Tuning per-tab on `openTab` options is a follow-up.

## Run

```sh
cp .env.example .env
# fill in HELIUS_API_KEY, SOLANA_RPC_URL, SELLER_PRIVATE_KEY
npm install
npm run dev
```

Then ping it:

```sh
curl http://localhost:4400/healthz
```

## Notes

- The `SELLER_PRIVATE_KEY` is just an identity (the public key ends up as `allowed_counterparty` in the buyer's session scope). It doesn't pay gas or hold funds — the facilitator pays settlement gas, vouchers settle from the buyer's vault. Generate a fresh Ed25519 keypair for the demo.
- The relay subscribes to `mainnet.helius-rpc.com` (NOT the legacy `rpc.helius.xyz` which returns 429 on websockets).
- The seller middleware does ONE on-chain RPC per session at first-voucher time (verifying the registration matches the vault's on-chain passkey). All subsequent vouchers verify in-memory. The amortized cost per voucher is dominated by ed25519 signature verification, which is cheap.
