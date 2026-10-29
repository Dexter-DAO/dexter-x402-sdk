# Local clone proof

The clone uses the deployed Vault ELF, read from mainnet without sending a
transaction. Every owner, agent, merchant and operator key used for the run is
new and local. Its USDC is minted on the local validator.

The harness changes four fixtures so a disposable owner can use the deployed
programs:

- GraphConfig's admin becomes the local fee payer.
- USDC's mint authority becomes a local key.
- One Swig CPI allowlist entry becomes the local payer. The rest of that ELF
  stays unchanged.
- Vault ProgramData keeps the mainnet ELF and public upgrade authority, with
  deployment slot 1. This makes deployment an ancestor of the local bank.

The facilitator keeps its production capability checks. A clone-specific
reviewed release pin describes the clone's actual ProgramData metadata and
hash. Reusing the production pin fails against ordinary validator genesis
metadata. Copying the mainnet deployment slot into a local fork also failed to
load the program because that slot was absent from its ancestry.

## Start the validator and owner

Run from the SDK repository with Node 22 or newer. Choose an unused output
directory and RPC port. The fixture directory is the existing mainnet dump in
`eng-loop-clone`; the mainnet RPC file is read only for cloning and verification.
The harness never loads production private keys.

```bash
node scripts/case-two-clone.mjs boot \
  --out /private/path/case-two-clone \
  --port 27899 \
  --fixtures /home/branchmanager/worktrees/eng-loop-clone/fixtures \
  --validator /home/branchmanager/worktrees/eng-loop-clone/agave/solana-release/bin/solana-test-validator \
  --mainnet-rpc-file /home/branchmanager/worktrees/eng-loop-clone/.mainnet-read-rpc
node scripts/case-two-clone.mjs birth --out /private/path/case-two-clone
```

Birth prints the disposable vault and seller addresses. The wallet receives
10 fake USDC and enough local SOL for the Swig rent check. The owner is a
software passkey for this clone. Use the printed seller address in the ordinary
request command:

```bash
node scripts/case-two-self-held.mjs request \
  --key /private/path/case-two-clone/claude-agent.json \
  --grant /private/path/case-two-clone/grant.json \
  --merchant '<CLONE_SELLER_FROM_BIRTH>' \
  --cap 5 --revolving 1.50 --max-single 1.50
```

Approve through the actual hosted consent routes in a separate API worktree.
That checkout needs installed dependencies and must have no `.env`. Docker must
have the `postgres:17` image available locally. The helper creates a temporary
PostgreSQL container, inserts one disposable hosted principal, runs passkey
challenge and signature verification, registers the grant on this clone, and
checks both replay refusals. It stops its HTTP server and destroys the temporary
database after saving the proof.

```bash
cd /path/to/dexter-api
npm ci
# Fill the Node binary directory and both worktree paths.
env -i PATH='<NODE_22_OR_NEWER_BIN>:/usr/local/bin:/usr/bin:/bin' HOME="$HOME" \
  node --import tsx scripts/case-two-hosted-consent.ts \
  --state /private/path/case-two-clone/state.json \
  --grant /private/path/case-two-clone/grant.json \
  --sdk /path/to/dexter-x402-sdk
cd /path/to/dexter-x402-sdk
```

The software passkey approves the public key from the same request. The helper
uses the production routes, signature verification and SQL claim logic; it
never generates a replacement agent key. API-specific setup is documented in
that repository's `scripts/CASE-TWO-HOSTED-CONSENT.md`.

Start the facilitator's clone service and merchant harness using its
`case-two-clone` scripts and a clone-specific reviewed pin. Run four `buy`
commands as shown in `CASE-TWO.md`, using the loopback RPC, facilitator and
merchant URLs. Omit `--live`; use new body, reason and receipt files for each
purchase. Wait for each settlement before the next request. The service log
and CLI receipts retain reservation, signed voucher, delivery and settlement
evidence.

## Refusals and the seven-day window

Use `case-two-refusal.mjs` with `--send`, the clone RPC, the approved vault and
seller, and the clone authority and payer key paths from `state.json`. Its agent
key is `claude-agent.json`. The $1.50 over-limit attempt uses
`--amount 1500000 --kind over-limit`; the expiry attempt uses
`--amount 1000000 --kind expired`. Each needs a fresh `--receipt` path.

A slot warp alone does not advance `Clock.unix_timestamp` by seven days. The
expiry test advances only the validator process's realtime clock through the
included C shim. Monotonic timers, the host clock and other services keep their
ordinary clocks. No session expiry field or RPC response is rewritten.

Compile the shim with the system C compiler:

```bash
cc -shared -fPIC -O2 scripts/case-two-clone-clock.c \
  -o /private/path/case-two-clone/clone-clock.so
```

After the four purchases and over-limit refusal, snapshot the affected accounts
and restart only the owned validator in a new ledger with an eight-day offset:

```bash
node scripts/case-two-clone.mjs advance-time \
  --out /private/path/case-two-clone \
  --seconds 691200 \
  --clock-library /private/path/case-two-clone/clone-clock.so
```

The helper preserves the original ledger and writes `time-advance-proof.json`.
It compares every restored account's data hash, including the approved session,
and requires the validator Clock to cross the approved expiry. The new ledger
has its own transaction history; purchase and over-limit receipts remain in the
original ledger.

Read the validator's Clock sysvar and require its Unix timestamp to exceed the
approved expiry before submitting the late refusal. Its signature precompile
and reservation must simulate and land as instruction 1, error 6009
`SessionExpiryInPast`. The $1 attempt fits the remaining $1, isolating expiry.

Stop the exact owned process after collecting the proof:

```bash
node scripts/case-two-clone.mjs stop --out /private/path/case-two-clone
```

The key files and ledger stay private for review. The output folder includes the
fixture changes, program hash and deployment slot in `state.json`. Copy only
reviewed public proof into a PR or the case page.

## Observed local proof

The Oct 29 run used published `@dexterai/x402` 6.0.6 and `@dexterai/vault`
0.44.0. Hosted consent registered the self-held public key through the production
routes using an isolated PostgreSQL principal. Replaying passkey verification
returned 400; replaying grant registration returned 409.

Four $1 purchases delivered HTTP 200 and settled. The buyer's fake USDC balance
fell from $10 to $6; the merchant received $3.96 and the treasury $0.04. The
session retained its $5 cap, recorded $4 spent and had zero outstanding amount.
Purchase durations were 1,944, 1,550, 1,541 and 1,546 milliseconds.

The $1.50 attempt with $1 left simulated and landed as instruction 1, error 6013
`RevolvingCapacityExceeded`. After the validator Clock crossed the same approved
seven-day expiry, the $1 attempt simulated and landed as instruction 1, error
6009 `SessionExpiryInPast`. Each failed transaction charged 15,000 local lamports
and changed none of the protected vault, session or buyer/seller token data.

Before purchases, successful simulations for the premature capacity and expiry
tests stopped without sending. Wrong agent and operator keys also stopped.
These four negative checks left the payer balance unchanged.

The expiry restart preserved every captured account's data hash and both
ledgers. The merchant and validator were stopped after evidence collection.
Synthetic image delivery and a software authenticator were used. The run does
not establish XONA integration, browser consent, a biometric prompt or mainnet
execution.

`CASE-TWO-PROOF.log` contains the scrubbed transaction signatures, decoded
errors, balances and hosted-route measurements. The first hosted rehearsal
returned HTTP 500 without creating a session; its fingerprinted exception did
not retain the underlying cause. A later run passed through the unchanged
production routes. No production repair is claimed for that earlier failure.
