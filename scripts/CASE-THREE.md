# Case three: two books under one seller-bound approval

The chosen books are The Innovator's Dilemma, then The Sovereign Individual.
Each costs $1 and is a demonstration edition: no text and no shipment.

This W9 job builds, tests on a disposable clone and simulates. Claude owns every
mainnet approval, purchase, refusal send, payout and Redis hold write. Codex must
never execute the mainnet write commands below or use Branch's wallet. Claude
also owns deployments, releases, npm publication and production SQL.

Use the retained W9 checkout and Node 24. Every command runs at reduced priority.
Validator, full test and browser runs also take the shared heavy lock.

```bash
cd /home/branchmanager/worktrees/case-three-tooling
case3_node=/home/branchmanager/.nvm/versions/node/v24.22.1/bin/node
case3_lock=/home/branchmanager/worktrees/briefs/case-three/.heavy.lock
case3_env=/home/branchmanager/.config/dexter-facilitator/facilitator.env
case3_seller=D21yDMWuiMZfkoaZj3t67S4hhfBfCgA4hNYuWA5i1esj
case3_impostor=FRLf4qg2xEHRWXv1DrujbqxqUXzxsgAs6tcPkTUZRHH2
case3_rpc='<AUTHORIZED_SOLANA_RPC>'
case3_dir=/home/branchmanager/.local/share/claude-case-three
case3_vault='<VAULT_FROM_THIS_APPROVAL>'
case3_register='<FINALIZED_REGISTRATION_SIGNATURE>'
c3() { nice -n 10 "$case3_node" scripts/case-three-self-held.mjs "$@"; }
r3() { nice -n 10 "$case3_node" scripts/case-three-refusal.mjs "$@"; }
heavy3() { flock "$case3_lock" nice -n 19 ionice -c3 "$@"; }
```

The two seller addresses above come from W4 and W8's committed public documents.
Compare them with the live quote and copycat document before the sitting. Never
load `dexter-bookstore-shelf2.json`, a Vault upgrade key, or the case-two agent key.
The CLI reads the internal token and Redis credentials in process. Never put
their values into arguments, terminal output or a report.

## Before the sitting

Claude confirms that the API, frontend, CSP, DID document, copycat site and W7's
test wallet are ready. Both SDK releases must be available: x402 6.1.0 and Vault
0.44.3. Require the clone rehearsal, test-wallet rehearsal, W10 rehearsal check,
W11 owner review and W8 first-contact capture. Archive both DID documents and
compare the archived bytes' hashes with the records. Read the live vault balance,
all sibling sessions and session count through a working RPC before approval.

Use a new private directory. Existing keys, grants and receipt paths are never
overwritten. The request prints its expiry in ET and unix seconds. A request at
10:01 AM ET using `--expiry-rule 2.5h` expires at 1:00 PM ET.

```bash
nice -n 10 mkdir -m 700 "$case3_dir"
c3 request --merchant "$case3_seller" \
  --seller-url https://books.dexter.cash/books/the-innovators-dilemma \
  --expected-host books.dexter.cash --cap 3 --revolving 1.50 --max-single 1.50 \
  --expiry-rule 2.5h --key "$case3_dir/agent.json" --grant "$case3_dir/grant.json"
```

Branch opens the consent URL. Read the seller `books.dexter.cash`, first payment
to this website, the receiving address, total $3, $1.50 at a time and expiry.
The agent is its public key, marked new; `Claude` appears only as its quoted
claim. Branch approves once. Read back the registered key, seller, caps, nonce
and expiry. A lost HTTP reply can follow a successful registration; inspect the
chain before asking for another approval.

Export the binding with W10's read-only mode, then check every row against the
finalized registration. Claude runs the export for Branch's registration; Codex
may use this SELECT only for the authorized test-wallet registration.

```bash
(
  cd /home/branchmanager/worktrees/case-three-golden
  nice -n 10 "$case3_node" --import tsx scripts/case-three-evidence-ingest.ts \
    --binding-only --register-tx "$case3_register" \
    --env /home/branchmanager/websites/dexter-api/.env --out "$case3_dir/binding-row.json"
)
c3 check-binding --row "$case3_dir/binding-row.json" \
  --register-tx "$case3_register" --rpc "$case3_rpc"
```

Stop before links or purchases if the binding check fails.
Archive the real and copycat DID files as specified in SPEC section 4 step 12.

## The mainnet sequence, run by Claude

First prove no permission exists for the copycat. This precedes generating any
copycat link. `--send` still simulates first and sends once only on the expected
3012 at instruction 1 with `AnchorError caused by account: session`.

```bash
r3 --live --send --rpc "$case3_rpc" --vault "$case3_vault" \
  --seller "$case3_impostor" --approved-seller "$case3_seller" \
  --agent-key "$case3_dir/agent.json" --amount 1000000 --kind no-permission \
  --receipt "$case3_dir/no-permission.json"
c3 impostor-links --variants V1,V2,V3,V4,V5 \
  --impostor-base https://dexter-bookstore.pages.dev --impostor "$case3_impostor" \
  --real https://books.dexter.cash/books/the-innovators-dilemma --out "$case3_dir/copycats"
c3 links-fresh --dir "$case3_dir/copycats"
```

Branch opens all five within five minutes and presses nothing. V1 and V4 flag
the name and identify his real store, books.dexter.cash. V2 refuses with R1
`kid_not_listed`; V3 refuses with R2 `payto_mismatch`. V4 also shows that no
website signed for the address. V5 shows only the address and R5
`unsigned_known_host`. If V1 lacks its notice, stop and investigate seller
history. Generate a replacement in a new directory with `--variant Vn` if an
unopened link is older than six minutes. Keep the original record.

Prepare the two order bodies from the live catalog. This records the edition IDs
and fulfillment values the store accepts, generates distinct order IDs, and
writes exclusive mode-600 files.

```bash
nice -n 10 "$case3_node" --input-type=module - "$case3_dir" <<'JS'
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const dir = process.argv[2];
const response = await fetch('https://books.dexter.cash/catalog', { redirect: 'error' });
if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
const catalog = await response.json();
for (const [index, slug] of ['the-innovators-dilemma', 'the-sovereign-individual'].entries()) {
  const item = catalog.items.find(item => item.productId === `book:${slug}`);
  if (!item || item.unitPriceAtomic !== '1000000' || item.fulfillment !== 'demonstration') throw new Error('Unexpected book edition or price');
  const order = { catalogVersion: catalog.catalogVersion, orderId: randomUUID(), productId: item.productId,
    editionId: item.editionId, quantity: 1, asset: 'USDC', totalAmountAtomic: '1000000', fulfillment: item.fulfillment };
  writeFileSync(`${dir}/order-${index + 1}.json`, JSON.stringify(order), { flag: 'wx', mode: 0o600 });
}
JS
c3 buy --live --check-seller --grant "$case3_dir/grant.json" --vault "$case3_vault" \
  --rpc "$case3_rpc" --facilitator https://x402.dexter.cash \
  --endpoint https://books.dexter.cash/books/the-innovators-dilemma \
  --seller-url https://books.dexter.cash/books/the-innovators-dilemma \
  --body "$case3_dir/order-1.json" --receipt "$case3_dir/purchase-1.json" \
  --reason "Record The Innovator's Dilemma demonstration edition. No text and no shipment." \
  --env-file "$case3_env"
c3 buy --live --check-seller --hold-settlement \
  --grant "$case3_dir/grant.json" --vault "$case3_vault" --rpc "$case3_rpc" \
  --facilitator https://x402.dexter.cash \
  --endpoint https://books.dexter.cash/books/the-sovereign-individual \
  --seller-url https://books.dexter.cash/books/the-sovereign-individual \
  --body "$case3_dir/order-2.json" --receipt "$case3_dir/purchase-2.json" \
  --reason 'Record The Sovereign Individual demonstration edition. No text and no shipment.' \
  --env-file "$case3_env"
case3_claim=$(nice -n 10 "$case3_node" -e \
  'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1])).claim.address)' \
  "$case3_dir/purchase-2.json")
r3 --live --send --rpc "$case3_rpc" --vault "$case3_vault" --seller "$case3_seller" \
  --kind payout-redirect --claim "$case3_claim" --redirect-to "$case3_impostor" \
  --env "$case3_env" --receipt "$case3_dir/payout-redirect.json"
c3 settle-held --live --claim "$case3_claim" --grant "$case3_dir/grant.json" \
  --receipt "$case3_dir/purchase-2.json" --payout "$case3_dir/payout-2.json" \
  --facilitator https://x402.dexter.cash --rpc "$case3_rpc" --env-file "$case3_env"
r3 --live --send --rpc "$case3_rpc" --vault "$case3_vault" --seller "$case3_seller" \
  --agent-key "$case3_dir/agent.json" --amount 1500000 --kind over-limit \
  --receipt "$case3_dir/over-limit.json"
```

Purchase 1 requires a checked quote, HTTP 200, verified store receipt, a locked
claim and its completed payout. Purchase 2 must record the hold read-back before
reservation and stop at `delivered` with a Pending claim. Run the 6070 attempt
within a minute of that claim becoming Pending. Require the same claim data and
protected accounts after the failed transaction. `settle-held` pays that claim
to the store while its hold remains set, waits for closure, writes the payout,
deletes the hold, and resumes the existing purchase. The over-limit attempt then
requires 6013 with $2 used and $1 left and no Pending claim.

Claude runs W10's committed ingest and `--check`, creates its PR and releases the
accepted artifact. Claude checks the v2 owner review before asking Branch for
the publication passkey. Keep the session idle from expiry until the late
refusal: another approval or reservation could sweep it.

After the actual chain clock exceeds expiry, Claude sends the $1 attempt that
otherwise fits. Require instruction 1 error 6009 in simulation and on chain.

```bash
r3 --live --send --rpc "$case3_rpc" --vault "$case3_vault" --seller "$case3_seller" \
  --agent-key "$case3_dir/agent.json" --amount 1000000 --kind expired \
  --receipt "$case3_dir/expired.json"
```

Claude re-ingests all four refusals, five copycats, first-contact evidence and
history checks, then runs W10's check and W11's independent verifier. Publication
and release remain Claude's steps. Keep every signature, simulation error,
landed error and unchanged-state check in the report.

## Test-wallet dress rehearsal

Wait for root's explicit readiness for the live API, frontend, copycat site and
W7 wallet. Use `/home/branchmanager/.local/share/dexter-case-three-test-wallet/identity.json`
through W6's `loadGuestWallet` in the CSP harness. Claude performs approval and
all money movement. Use a new test-run folder and the test vault, never the
Branch run's folder or vault.

Request cap 1.10, revolving 1.00, max single 1.00 and expiry two hours from now:

```bash
case3_expiry=$(nice -n 10 "$case3_node" -p 'Math.floor(Date.now()/1000)+7200')
c3 request --merchant "$case3_seller" \
  --seller-url https://books.dexter.cash/books/the-innovators-dilemma \
  --expected-host books.dexter.cash --cap 1.10 --revolving 1.00 --max-single 1.00 \
  --expires-at "$case3_expiry" --key "$case3_dir/agent.json" --grant "$case3_dir/grant.json"
heavy3 "$case3_node" scripts/case-three-screens.ts \
  --harness /home/branchmanager/worktrees/case-three-csp-harness \
  --grant "$case3_dir/grant.json" --out "$case3_dir/fresh-approval-screen"
```

After Claude approves, export and check the test binding, run no-permission,
generate the five links, then read and screenshot every screen within five
minutes without confirming or approving them. Use `heavy3` for the browser run.
Record the screen's seller, first payment, new agent key and quoted agent claim.
If W10's binding mode is absent, record `check-binding not run` and continue;
Claude must run it before the sitting.

The read-only screen tool loads W7's saved identity and blocks approval and
transaction submission. After no-permission and fresh link generation, capture
all five with this command. It never clicks Confirm or Approve.

```bash
heavy3 "$case3_node" scripts/case-three-screens.ts \
  --harness /home/branchmanager/worktrees/case-three-csp-harness \
  --links "$case3_dir/copycats" --out "$case3_dir/fresh-copycat-screens"
```

Run only purchase 1, using the purchase-1 command above with
`--hold-settlement`. Target its claim for 6070, then `settle-held` using
purchase-1 and payout-1 paths. The final over-limit command uses
`--amount 1000000`: $1 is used and $0.10 remains. Record the hold read-back,
all signatures, errors, state checks, screen readings and screenshot paths.
Codex may replace `--send` with `--simulate-only` and a fresh receipt path for
read-only simulations. A simulation-only receipt cannot later be reused for a
send; Claude must use a different receipt path.

## Disposable clone sequence

The complete driver holds the heavy lock until the validator, facilitator and
bookstore stop. It uses installed npm x402 6.1.0 and Vault 0.44.3 in a separate
consumer and copies the current CLI files there. It preserves transaction
messages, complete RPC execution metadata including inner instructions, token
balances and the expiry snapshot before cleanup. The new expiry ledger keeps
deployment slot 1, then advances empty banks until its finalized root exceeds the
previous bank's measured slot before any refusal. Transaction slots are never edited. The account
snapshot is a new local ledger, not an uninterrupted chain.
Choose a new run directory. Keep the completed evidence private.

```bash
heavy3 npm install --prefix /home/branchmanager/worktrees/briefs/case-three/results/W9-consumer \
  --ignore-scripts --no-package-lock --save-exact @dexterai/x402@6.1.0 @dexterai/vault@0.44.3
heavy3 "$case3_node" scripts/case-three-clone-rehearsal.mjs \
  --out '<NEW_CLONE_RUN_DIRECTORY>' \
  --consumer /home/branchmanager/worktrees/briefs/case-three/results/W9-consumer \
  --api /home/branchmanager/worktrees/case-three-store-routes \
  --facilitator-source /home/branchmanager/worktrees/case-three-clone-lock \
  --fixtures /home/branchmanager/worktrees/eng-loop-clone/fixtures \
  --validator /home/branchmanager/worktrees/eng-loop-clone/agave/solana-release/bin/solana-test-validator \
  --read-rpc-file /home/branchmanager/worktrees/eng-loop-clone/.mainnet-read-rpc \
  --pin-env /home/branchmanager/.config/dexter-facilitator/facilitator.env
```

The API checkout needs its matching dependencies, and part 0 needs its retained
dependencies. This job temporarily linked W2's absent `node_modules` to the
matching `consent-api/node_modules`; no production dependency declaration
differed. The link is removed after the rehearsal. Install matching dependencies
under the heavy lock before a later run if that link is absent.

The commands below explain the driver steps. Execute them only inside an
already locked rehearsal shell. Do not acquire the lock again from that shell.

Use `scripts/CASE-TWO-CLONE.md` for validator boot, disposable owner birth and
software-passkey consent. Use part 0's facilitator worktree and its
`scripts/CASE-TWO-CLONE.md` for the reviewed clone pin and service command. Never
load a production signing key. W2's
books routes run through the persistent wrapper below, with a throwaway quote
key and the clone's disposable receiving key. The wrapper imports W2's actual
registrar and ledger helpers, creates a disposable PostgreSQL database and
rewrites local requests to the books Host. Its output supplies the local book
endpoints and DID file. Run it in a second terminal while the heavy lock is held
by the clone rehearsal's owning process, then stop it with SIGTERM for cleanup.

```bash
nice -n 19 ionice -c3 "$case3_node" --import /home/branchmanager/worktrees/case-three-store-routes/node_modules/tsx/dist/loader.mjs scripts/case-three-clone-bookstore.ts \
  --state '<NEW_CLONE_RUN_DIRECTORY>/state.json' \
  --api /home/branchmanager/worktrees/case-three-store-routes \
  --facilitator http://127.0.0.1:27901 --port 27905
```

```bash
case3_dir='<NEW_CLONE_RUN_DIRECTORY>'
case3_rpc=http://127.0.0.1:27899
case3_vault='<CLONE_VAULT>'
case3_seller='<CLONE_BOOKS_SELLER>'
case3_impostor='<FRESH_CLONE_IMPOSTOR_ADDRESS>'
case3_env="$case3_dir/services/facilitator.env"
case3_authority='<CLONE_AUTHORITY_KEY_PATH>'
case3_payer='<CLONE_FEE_PAYER_KEY_PATH>'
c3 request --merchant "$case3_seller" \
  --endpoint '<LOCAL_BOOK_1_URL>' --seller-url https://books.dexter.cash/books/the-innovators-dilemma \
  --expected-host books.dexter.cash --did-file '<CLONE_DID_FILE>' \
  --cap 3 --revolving 1.50 --max-single 1.50 --expiry-rule 2.5h \
  --key "$case3_dir/agent.json" --grant "$case3_dir/grant.json"
```

Register that request through the clone software passkey:

```bash
nice -n 10 "$case3_node" scripts/case-three-clone-approve.mjs \
  --state "$case3_dir/state.json" --grant "$case3_dir/grant.json"
```

The clone exercises
the production unsigned registration path; it proves no browser seller binding.
Prepare two bodies from the local books catalog with distinct order IDs and
the same demonstration edition values used above. Buy book 1 with
`--pay-claim`, then buy book 2 leaving its claim Pending:

```bash
c3 buy --check-seller --pay-claim --grant "$case3_dir/grant.json" --vault "$case3_vault" \
  --rpc "$case3_rpc" --facilitator http://127.0.0.1:27901 \
  --endpoint '<LOCAL_BOOK_1_URL>' --seller-url https://books.dexter.cash/books/the-innovators-dilemma \
  --did-file '<CLONE_DID_FILE>' --body "$case3_dir/order-1.json" \
  --reason 'Record the first demonstration edition on the clone.' \
  --receipt "$case3_dir/purchase-1.json" --env-file "$case3_env"
c3 buy --check-seller --hold-settlement --no-hold \
  --grant "$case3_dir/grant.json" --vault "$case3_vault" --rpc "$case3_rpc" \
  --facilitator http://127.0.0.1:27901 --endpoint '<LOCAL_BOOK_2_URL>' \
  --seller-url https://books.dexter.cash/books/the-sovereign-individual \
  --did-file '<CLONE_DID_FILE>' --body "$case3_dir/order-2.json" \
  --reason 'Retain the second clone claim for the redirect attempt.' \
  --receipt "$case3_dir/purchase-2.json" --env-file "$case3_env"
case3_claim=$(nice -n 10 "$case3_node" -e \
  'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1])).claim.address)' \
  "$case3_dir/purchase-2.json")
r3 --send --rpc "$case3_rpc" --vault "$case3_vault" --seller "$case3_seller" \
  --authority-key "$case3_authority" --fee-payer-key "$case3_payer" \
  --kind payout-redirect --claim "$case3_claim" --redirect-to "$case3_impostor" \
  --env "$case3_env" --receipt "$case3_dir/payout-redirect.json"
c3 settle-held --no-hold --claim "$case3_claim" --grant "$case3_dir/grant.json" \
  --receipt "$case3_dir/purchase-2.json" --payout "$case3_dir/payout-2.json" \
  --facilitator http://127.0.0.1:27901 --rpc "$case3_rpc" --env-file "$case3_env"
r3 --send --rpc "$case3_rpc" --vault "$case3_vault" \
  --seller "$case3_impostor" --approved-seller "$case3_seller" \
  --authority-key "$case3_authority" --fee-payer-key "$case3_payer" \
  --agent-key "$case3_dir/agent.json" --amount 1000000 --kind no-permission \
  --receipt "$case3_dir/no-permission.json"
r3 --send --rpc "$case3_rpc" --vault "$case3_vault" --seller "$case3_seller" \
  --authority-key "$case3_authority" --fee-payer-key "$case3_payer" \
  --agent-key "$case3_dir/agent.json" --amount 1500000 --kind over-limit \
  --receipt "$case3_dir/over-limit.json"
nice -n 10 cc -shared -fPIC -O2 scripts/case-two-clone-clock.c -o "$case3_dir/clone-clock.so"
nice -n 10 "$case3_node" scripts/case-two-clone.mjs advance-time --out "$case3_dir" \
  --seconds 14400 --clock-library "$case3_dir/clone-clock.so"
r3 --send --rpc "$case3_rpc" --vault "$case3_vault" --seller "$case3_seller" \
  --authority-key "$case3_authority" --fee-payer-key "$case3_payer" \
  --agent-key "$case3_dir/agent.json" --amount 1000000 --kind expired \
  --receipt "$case3_dir/expired.json"
nice -n 10 "$case3_node" scripts/case-two-clone.mjs stop --out "$case3_dir"
```

Both purchases must lock. The first explicit payout and second held payout must
close their claims and credit the store. Require simulation and landed 6070,
3012, 6013 and 6009 with unchanged protected state. Verify the clone Clock crossed
the approved expiry after the restart. The holder comes from the clone's env
file. `--pay-claim` and `--no-hold` are loopback-only; the clone has no Redis and
does not exercise production hold behavior.

## Recovery

A different simulation error sends nothing. Every refusal needs a new receipt
path. If a target claim is already paid, stop and report; buying a third book
would change the budget proof. Any other Pending claim blocks a refusal.

After a failed or unknown delivery, preserve the original journal. Use the
existing `resend` and `resume` commands on that receipt; never sign a replacement
purchase. A failed receipt verification after HTTP 200 is recorded and reported,
with the purchase retained for recovery. It never triggers another payment.
Inspect a leftover grant lock's PID and exact process before removing that lock.
If fewer than 30 minutes remain before expiry, stop the unfinished purchase and
over-limit steps and report the incomplete proof.
