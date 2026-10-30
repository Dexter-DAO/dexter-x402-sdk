# Claude buys four books under one weekly approval

Claude creates its own Ed25519 key. Branch approves that public key to spend
at Dexter Bookstore once: $5 total, $1.50 at a time, expiring seven days after
the request. Claude then signs four separate $1 book payments. The facilitator
reserves and settles them; the purchase path uses the SDK and Claude's key.

The new shelf has its own endpoint,
`https://api.dexter.cash/api/x402/demo-books/shelf-two`, and its own seller
wallet:

```text
6Aa6C1dfvG9BDaqBukPPxJJXpKFjtidhydkHmmVLBX2b
```

That address is a constant in the API, so the seller is the same in every
deployment. The original $20 shelf and its seller keep their existing
permission and purchase history.

## Prepare after the live run is authorized

Use Node 22 or newer and the reviewed SDK checkout. Keep the agent's private
folder outside the repository. Before requesting approval, send an unpaid GET
to the new endpoint and confirm HTTP 402, scheme `tab`, Solana mainnet, canonical
USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`), the new seller, and
`amount` of `1000000`. Confirm the wallet has at least $5 USDC.

```bash
export PATH=/home/branchmanager/.nvm/versions/node/v24.22.1/bin:$PATH
cd /path/to/dexter-x402-sdk
npm ci
npm run build
mkdir -m 700 /private/path/claude-case-two
node scripts/case-two-self-held.mjs request \
  --key /private/path/claude-case-two/agent.json \
  --grant /private/path/claude-case-two/grant.json \
  --merchant '6Aa6C1dfvG9BDaqBukPPxJJXpKFjtidhydkHmmVLBX2b' \
  --cap 5 --revolving 1.50 --max-single 1.50
```

Branch opens the printed `https://dexter.cash/tabs/new?req=...` link. Check that
the screen names the seller **Dexter Bookstore**, shows $5 total, $1.50 at a time,
and seven days. Approve once with Face ID. Read back the on-chain session before
buying: Claude's public key, the new seller, cap `5000000`, revolving capacity
`1500000`, spent `0`, outstanding `0`. Record `expiresAt`; the late refusal is
scheduled for ten minutes after it.

If consent reports an error, inspect the chain before asking Branch to retry.
A registered session can survive a lost HTTP reply.

## Four editions, four orders

Buy The Wealth of Nations, Meditations by Marcus Aurelius, The Art of War, and
The Prince. Each digital edition costs exactly $1 and returns its title,
edition, Project Gutenberg text link and order receipt. Fetch the shelf's
`/catalog` first and use its current product IDs and catalog version in the
order bodies. Create a new `orderId` for every purchase, including an intentional
second purchase of the same title. Keep the full body and reason in the receipt.

Each order body follows this shape. Replace the UUID for every new order and
select the matching product and edition pair from the table:

```json
{
  "catalogVersion": "dexter-bookstore-shelf-two/v1",
  "orderId": "2bc78f09-789c-4de8-9a9a-8e3d25de72e3",
  "productId": "book:wealth-of-nations",
  "editionId": "gutenberg:3300",
  "quantity": 1,
  "asset": "USDC",
  "totalAmountAtomic": "1000000",
  "fulfillment": "digital"
}
```

| Title | productId | editionId |
| --- | --- | --- |
| The Wealth of Nations | `book:wealth-of-nations` | `gutenberg:3300` |
| Meditations | `book:meditations` | `gutenberg:2680` |
| The Art of War | `book:art-of-war` | `gutenberg:132` |
| The Prince | `book:the-prince` | `gutenberg:1232` |

Run once per order with a new body file and a new receipt path. Wait for
settlement before starting the next order:

```bash
node scripts/case-two-self-held.mjs buy --live \
  --grant /private/path/claude-case-two/grant.json \
  --vault '<APPROVED_VAULT_ADDRESS>' \
  --rpc '<WRITE_CAPABLE_SOLANA_RPC>' \
  --facilitator https://x402.dexter.cash \
  --endpoint https://api.dexter.cash/api/x402/demo-books/shelf-two \
  --body /private/path/claude-case-two/wealth-of-nations-order.json \
  --reason 'Read the division of labour argument for the agent economy research.' \
  --receipt /private/path/claude-case-two/purchase-1.json \
  --token-env-file /home/branchmanager/websites/dexter-api/.env
```

After each purchase require HTTP 200, stage `settled`, spent increasing by
`1000000`, and outstanding `0`. After four, spent must be `4000000`.

The CLI settles a purchase only after the shelf answers HTTP 200. Any other
answer, or a lost one, stops the CLI with the answer saved, the payment
reserved but unsettled, and the purchase still pending. Never pay again for
that order. Resend first, settle second. Resend the exact saved request once:

```bash
node scripts/case-two-self-held.mjs resend --live \
  --receipt /private/path/claude-case-two/purchase-1.json
```

Resend posts the saved order body with the same `X-Tab-Voucher`. It signs,
reserves and settles nothing. A shelf that recorded the order answers HTTP 200
with the stored receipt. A shelf that never took the payment can still take
the unsettled reservation and answers HTTP 200 with the edition. The answer is
saved beside the purchase receipt as `.resend.json`. A second resend of the
same receipt is refused. Then settle with `resume`, whatever resend answered:

```bash
node scripts/case-two-self-held.mjs resume --live \
  --grant /private/path/claude-case-two/grant.json \
  --receipt /private/path/claude-case-two/purchase-1.json \
  --rpc '<WRITE_CAPABLE_SOLANA_RPC>' \
  --token-env-file /home/branchmanager/websites/dexter-api/.env
```

Resume settles the signed payment and clears the pending purchase; it never
sends the order again. If resend did not return HTTP 200, report that receipt
before another purchase. Settling before resend makes the resend useless: the
shelf's Tab rail refuses a reservation that is already settled.

The key must be an owned regular file with mode 600. One process owns a grant.
Each voucher and reservation is saved before transmission; an unfinished
purchase blocks further signing. After a crash, `resume` recovers that exact
attempt. If it stopped before delivery, resume retries the saved reservation
identity and sends the order once, settling only after HTTP 200; any other
answer stops it again for `resend`, then `resume`. If it stopped during
delivery, the outcome is unknown: run `resend` once, then `resume`. Inspect the
PID in a leftover `.lock` and verify that process is gone before removing that
exact lock. Keep every receipt.

## Two authority-signed refusals

With spent `4000000` and outstanding `0`, try to reserve $1.50 against the $1
remaining cap. The authority file below holds Dexter's existing Vault
authority; the script verifies its public key against the vault before signing.
The authority also pays the fee.

```bash
node scripts/case-two-refusal.mjs --live --send \
  --rpc '<WRITE_CAPABLE_SOLANA_RPC>' \
  --vault '<APPROVED_VAULT_ADDRESS>' \
  --seller '6Aa6C1dfvG9BDaqBukPPxJJXpKFjtidhydkHmmVLBX2b' \
  --agent-key /private/path/claude-case-two/agent.json \
  --authority-key /home/branchmanager/.config/solana/dexter-vault/api-session-master.json \
  --amount 1500000 --kind over-limit \
  --receipt /private/path/claude-case-two/over-limit.json
```

The signed transaction is simulated first. It is sent only when instruction 1
returns 6013 `RevolvingCapacityExceeded`; the landed transaction must fail with
the same code and leave protected state unchanged. A successful simulation or
a different error sends nothing. Each rerun requires a new receipt path.

Keep this wallet idle through the late refusal. Another Tab approval or payment
after expiry can sweep the expired permission and remove the evidence. Wait
until ten minutes after `expiresAt`, check the actual chain clock, and confirm
the same permission still exists. Then try the $1 that fits the remaining cap:

```bash
node scripts/case-two-refusal.mjs --live --send \
  --rpc '<WRITE_CAPABLE_SOLANA_RPC>' \
  --vault '<APPROVED_VAULT_ADDRESS>' \
  --seller '6Aa6C1dfvG9BDaqBukPPxJJXpKFjtidhydkHmmVLBX2b' \
  --agent-key /private/path/claude-case-two/agent.json \
  --authority-key /home/branchmanager/.config/solana/dexter-vault/api-session-master.json \
  --amount 1000000 --kind expired \
  --receipt /private/path/claude-case-two/expired.json
```

Require simulation and landed instruction 1 error 6009 `SessionExpiryInPast`,
with protected state unchanged. Both refusals contain Claude's voucher signature
check followed by an authority-signed `settle_voucher` reservation. The program
enforces the approved cap and expiry even when Dexter's own authority signs.
Check the program executable hash before the run; these scripts expect the
reviewed mainnet program's error codes.

## Operational limits

The seven-day grant ends at its approved expiry. A new week requires a new
approval. The program permits one outstanding reservation, bounded by its $1.50
revolving capacity and remaining lifetime cap. The client also refuses quotes
above $1.50.

`/tab/open` requires `DEXTER_INTERNAL_TOKEN`. The CLI reads only that value from
the existing env file and sends it to the facilitator. Use the facilitator URL
shown above exactly. Keep receipts private until Dexter reviews and scrubs
local paths, signed transport bytes and personal material for publication.

The build job authorizes clone rehearsals and PRs. Mainnet funding, consent,
transactions and deployment belong to the separately authorized live run.
Clone setup and its software-passkey limitation are in `CASE-TWO-CLONE.md`.
