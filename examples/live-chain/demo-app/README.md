# `live-chain` demo — buyer CLI

CLI version of the buyer side. Opens a Tab against the [relay](../relay/), streams events, prints a USDC ticker, settles on Ctrl+C.

A browser/Next.js version of this is a follow-up — the CLI is the cleanest "does the pipe work" proof.

## Setup

You need a vault enrolled on mainnet. The fastest path is the scripted enroller in `dexter-facilitator`:

```sh
cd ~/websites/dexter-facilitator/scripts/ots-e2e
./run.sh enroll
```

That gives you a passkey JSON + a swig address + a vault PDA. Use those in `.env` here.

You also need that vault funded with a little USDC. The enroller writes funding instructions; for the demo, $0.50 USDC is plenty.

```sh
cp .env.example .env
# fill in BUYER_SWIG, BUYER_VAULT_PDA, PASSKEY_KEY_FILE, FEE_PAYER_KEY_FILE
# also: SELLER_PUBKEY from the relay's /healthz, WATCH_ACCOUNT (any pubkey)
npm install
npm run dev
```

## Demo flow

1. Start the relay (`cd ../relay && npm run dev`).
2. Hit `/healthz` to grab the seller pubkey, paste into `.env`.
3. Start the buyer CLI.
4. Watch events scroll. USDC ticker climbs.
5. Ctrl+C — the tab closes, settlement transaction lands on mainnet, Solscan link is printed.

## What it proves

- The seller never holds escrow; the relay just verifies vouchers and serves events.
- The vault balance ticks down only when settlement happens (on close), and stops in real time when the tab is closed.
- The same pipe scales horizontally: run two terminals against two different `WATCH_ACCOUNT`s and the relay multiplexes both buyers from one Laserstream subscription per account.
