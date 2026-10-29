# Self-held Claude grant and program refusals

The agent creates its Ed25519 key locally. The consent URL contains its public
key. Branch approves the seller, total cap, revolving capacity and expiry with
one passkey ceremony. The payment service receives signed vouchers, never the
agent's private key.

This tooling uses the published `@dexterai/x402/tab` APIs and the canonical
`@dexterai/vault/grant` request builder. It adds no database schema or production
API changes. The self-held request goes through `/tabs/new`; it does not use
`hostedNativeTab`, so that flow's cap-equals-price rule stays unchanged.

## Live operator commands, after separate authorization

Use Node 22 or newer. These commands describe the later run. This build job
authorizes only the local clone and PRs.

Fill in the merchant's Solana USDC payout address, Tab endpoint, the approved
vault address, a write-capable Solana RPC, and the existing operator key paths.
Keep the agent directory outside the repository. Claude runs the commands
under the Unix user that owns the key.

```bash
export PATH=/home/branchmanager/.nvm/versions/node/v24.22.1/bin:$PATH
cd /path/to/dexter-x402-sdk
npm ci
npm run build
mkdir -m 700 /private/path/claude-case-two
node scripts/case-two-self-held.mjs request \
  --key /private/path/claude-case-two/agent.json \
  --grant /private/path/claude-case-two/grant.json \
  --merchant '<XONA_SOLANA_PAYOUT_ADDRESS>' \
  --cap 5 --revolving 1.50 --max-single 1.50
```

Branch opens the printed `https://dexter.cash/tabs/new?req=...` URL and approves
once with his passkey. Fill `APPROVED_VAULT_ADDRESS` below from that wallet.
The CLI reads the registered session from chain, including any cap or expiry
Branch shortened. It checks the key and scope before signing.

Claude chooses one image request from its actual task, writes that request to
a JSON file, and records its reason. Run this once per chosen purchase, using a
new receipt path each time. For the case, repeat for four independently chosen
requests at approximately $1 each, waiting for settlement before the next.

```bash
node scripts/case-two-self-held.mjs buy --live \
  --grant /private/path/claude-case-two/grant.json \
  --vault '<APPROVED_VAULT_ADDRESS>' \
  --rpc '<WRITE_CAPABLE_SOLANA_RPC>' \
  --facilitator https://x402.dexter.cash \
  --endpoint '<XONA_TAB_ENDPOINT>' \
  --body /private/path/claude-case-two/chosen-image-1.json \
  --reason '<WHY_CLAUDE_CHOSE_THIS_IMAGE>' \
  --receipt /private/path/claude-case-two/purchase-1.json \
  --token-env-file /home/branchmanager/websites/dexter-api/.env
```

`--body` selects POST with JSON. Omit it for a GET merchant. The key must be an
owned regular file with mode 600. Do not run several copies against one grant.
Each voucher and reservation request is saved before transmission. An unfinished
purchase blocks further signing. To recover its saved attempt:

```bash
node scripts/case-two-self-held.mjs resume --live \
  --grant /private/path/claude-case-two/grant.json \
  --receipt /private/path/claude-case-two/purchase-1.json \
  --rpc '<WRITE_CAPABLE_SOLANA_RPC>' \
  --token-env-file /home/branchmanager/websites/dexter-api/.env
```

Resume retries the exact reservation identity. It sends a merchant request only
when the saved stage proves delivery had not begun. An uncertain delivery is
settled without repeating the request and retains `deliveryOutcome: "unknown"`
in its receipt. A reservation settled during downtime is reconciled with
`deliveryOutcome: "not-dispatched"`, without asking for delivery after payment.
After a process crash, inspect the PID in the grant's `.lock` file and confirm
that process is gone before removing that exact lock. Never discard the receipt.
An expired, unlanded reservation requires the facilitator's successor workflow;
the tool stops with its saved response for an operator to handle.

After $4 has settled under the $5 grant, send the $1.50 refusal attempt:

```bash
node scripts/case-two-refusal.mjs --live --send \
  --rpc '<WRITE_CAPABLE_SOLANA_RPC>' \
  --vault '<APPROVED_VAULT_ADDRESS>' \
  --seller '<XONA_SOLANA_PAYOUT_ADDRESS>' \
  --agent-key /private/path/claude-case-two/agent.json \
  --authority-key '<DEXTER_AUTHORITY_KEY_FILE>' \
  --fee-payer-key '<DEXTER_FEE_PAYER_KEY_FILE>' \
  --amount 1500000 --kind over-limit \
  --receipt /private/path/claude-case-two/over-limit.json
```

The script simulates the signed transaction first. It sends the same bytes with
preflight skipped only when instruction 1 returns 6013
`RevolvingCapacityExceeded`. A successful simulation or any other error stops
without sending. The landed transaction must fail with that same code and leave
session state unchanged. Only the transaction fee is charged.

Wait until the approved on-chain `expiresAt` has passed. Then attempt a $1
payment, still within the remaining total cap, to isolate the expiry rule:

```bash
node scripts/case-two-refusal.mjs --live --send \
  --rpc '<WRITE_CAPABLE_SOLANA_RPC>' \
  --vault '<APPROVED_VAULT_ADDRESS>' \
  --seller '<XONA_SOLANA_PAYOUT_ADDRESS>' \
  --agent-key /private/path/claude-case-two/agent.json \
  --authority-key '<DEXTER_AUTHORITY_KEY_FILE>' \
  --fee-payer-key '<DEXTER_FEE_PAYER_KEY_FILE>' \
  --amount 1000000 --kind expired \
  --receipt /private/path/claude-case-two/expired.json
```

This must simulate and land as 6009 `SessionExpiryInPast`. The request cannot
produce the late refusal until the window closes.

Both refusal transactions contain an Ed25519 signature-check instruction for
Claude's voucher, followed by an authority-signed `settle_voucher` reservation.
The reservation handler enforces scope but does not itself consume the voucher
bytes; the precompile checks that signature separately in the same transaction.
Dexter's server was bypassed on purpose. The program refuses the reservation
even when Dexter's own authority signs it.

## Merchant requirements

The merchant needs a Solana USDC payout address and a reachable x402 endpoint
using `tabOrExactMiddleware` from the SDK, with Solana RPC access and
`https://x402.dexter.cash` as facilitator. Its challenge must offer the `tab`
scheme on Solana mainnet, canonical USDC, and the exact approved payout address.
The middleware must independently verify the session, voucher and confirmed
reservation before delivering the image. Use a durable merchant channel ledger
and call `recordDelivered` for the quoted amount before returning delivery.

The merchant must run settlement for any locked claims. This operator CLI also
calls the facilitator's final settlement after each purchase; it never treats
image delivery alone as payment proof. Preserve the merchant's payout transaction
and delivered image evidence for the page.

## Boundaries

The seven-day grant does not renew automatically. A new week needs a new
approval. This configuration sets the on-chain revolving capacity to $1.50.
Since the program permits only one outstanding reservation, each purchase's
reservation is bounded by $1.50 and the remaining lifetime cap. The client also
refuses merchant quotes above $1.50. The current grant format has no separate
per-purchase field; this limit uses its existing revolving-capacity rule.

`/tab/open` still needs `DEXTER_INTERNAL_TOKEN`. For this Dexter-operated case,
the CLI can read only that value from the existing server env file, without
sourcing the file or sending the secret to the merchant. Removing this internal
token dependency is a separate follow-up.

Receipts contain signed vouchers and delivery bodies. Keep them private until
Dexter reviews and scrubs them for publication. Private keys, local paths and
signed transaction transport bytes do not belong on the public case page.

The clone instructions and observed results are in `CASE-TWO-CLONE.md`.
