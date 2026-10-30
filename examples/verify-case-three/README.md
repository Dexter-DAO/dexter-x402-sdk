# Verify case three

Rerun the seller and payment checks from the case-three record download, public HTTPS files and a Solana mainnet RPC. Node 24 or newer is required.

```sh
cd examples/verify-case-three
npm ci --ignore-scripts
node verify.mjs /path/to/record.json
node verify.mjs /path/to/record.json --rpc https://your-public-solana-rpc.example
```

The default RPC is `https://api.mainnet-beta.solana.com`. Public providers may limit transaction-history requests. Choose a provider that retains the approval, reservation, lock, settlement and refusal transactions. The script accepts the page's `dexter-mandate-case-record/v1` download and a direct `dexter-mandate-case/v1` case-three record.

The example pins `@dexterai/vault` 0.44.3, `@dexterai/x402` 6.1.0, `@solana/web3.js` 1.98.4 and `@solana/spl-token` 0.4.15 from npm. It reads the record's retained bytes directly. Binding bytes, store-file bytes, salt and the new redirect voucher's raw channel and signature bytes use base64url. Hashes and the approval ceremony nonce use lowercase hex. Existing versioned payment and refusal proofs retain their protocol strings in their established encodings.

Each line contains `PASS` or `FAIL` and its evidence. Checks cover the passkey approval and permission terms, seller binding and commitment, saved store file, decoded Wayback snapshot, both purchases and signed receipts, V1 through V5, first contact and screenshot, the copycat session's transaction history, both redirects, and errors 6013 and 6009. The Wayback snapshot must be captured from 24 hours before through 30 minutes after the approval. The copycat history is checked through the record's snapshot slot, which must be at or after the 3012 no-permission refusal. Each refusal must include the program's verbatim AnchorError line, which is reread from the node and printed.

Exit status is zero only when every historical check passes. The separate `LIVE store_file` line reports `still_listed`, `changed`, `removed` or `unreadable` and does not affect exit status. A missing snapshot, screenshot, refusal or purchase fails verification.

The vault SDK checks transaction signatures, instruction bindings and token-account deltas. Its public compound-instruction decoder exposes the signed Swig payout, whose transfer bytes and accounts are compared with pure SPL `TransferChecked` instructions for the canonical source, USDC mint, approved destinations and exact amounts. This check reads the historical transaction without fetching current claim or Swig state. The seller SDK checks signatures, signed URL and payment terms, address proofs, commitment and screen decisions. Solana RPC metadata supplies transaction outcomes, logs, balances, slots and block times. The script verifies those fields against the retained record; the node reports them.

## Save the store file

```sh
node archive.mjs https://dexter.cash/.well-known/did.json
```

The helper requests a Wayback save, reads its timestamped `id_` snapshot, and prints the timestamp, snapshot URL and SHA-256 hashes of the source and archived bytes. Node fetch decodes HTTP content encoding before hashing, as `curl --compressed` does. A save failure or byte mismatch exits with status 1. Run this after the store file is serving, no more than 24 hours before the approval or within 30 minutes after it.

```sh
npm test
```

Tests use generated signing keys, saved documents, local HTTP fixtures, captured public case-two transactions and archived signed case-three clone transactions. They check signature and commitment mutations, every copycat result, swapped files, missing documents, complete history pagination, a successful history entry, an existing copycat account, the snapshot slot against the no-permission refusal, the archive capture window, screenshot hashes, exact refusal logs and compressed archive bytes.

The clone tests verify its software-passkey approval, both purchases and signed receipts, redirects 3012 and 6070, and the 6013 refusal. Its 6009 transaction proves the program refusal and agent signature, but fails the historical ordering check because the clone restarted its ledger before advancing time. Its approval has no seller commitment or rendered-screen evidence. The clone archive omits CPI `innerInstructions`. These selected standalone checks establish the signed payout instructions and node-reported balances; the full browser and API payment verifier requires those CPI records, so its clone acceptance remains unverified. The complete mainnet dress-rehearsal record remains a separate verification step.

An archive save on October 29, 2026 at 10:55:33 PM ET returned [this snapshot](https://web.archive.org/web/20261030025533id_/https://dexter.cash/.well-known/did.json). Its 910 decoded bytes and the source bytes both hashed to `eaa77c5e24fb7356749890577a60887cd5464c2b8d2f0750e592cea3c4e83c03`.
