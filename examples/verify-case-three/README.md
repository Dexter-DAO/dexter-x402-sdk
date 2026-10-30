# Verify case three

Rerun the seller and payment checks from the case-three record download, public HTTPS files and a Solana mainnet RPC. Node 24 or newer is required.

```sh
cd examples/verify-case-three
npm ci --ignore-scripts
node verify.mjs /path/to/record.json
node verify.mjs /path/to/record.json --rpc https://your-public-solana-rpc.example
```

The default RPC is `https://api.mainnet-beta.solana.com`. Public providers may limit transaction-history requests. Choose a provider that retains the approval, reservation, lock, settlement and refusal transactions. The script accepts the page's `dexter-mandate-case-record/v1` download and a direct `dexter-mandate-case/v1` case-three record.

The example pins `@dexterai/vault` 0.44.3, `@dexterai/x402` 6.1.0 and `@solana/web3.js` 1.98.4 from npm. It reads the record's retained bytes directly. Binding bytes, store-file bytes and salt use base64url; hashes and the approval ceremony nonce use lowercase hex.

Each line contains `PASS` or `FAIL` and its evidence. Checks cover the passkey approval and permission terms, seller binding and commitment, saved store file, decoded Wayback snapshot, both purchases and signed receipts, V1 through V5, first contact and screenshot, the copycat session's complete transaction history, both redirects, and errors 6013 and 6009. Each refusal must include the program's verbatim AnchorError line, which is reread from the node and printed.

Exit status is zero only when every historical check passes. The separate `LIVE store_file` line reports `still_listed`, `changed`, `removed` or `unreadable` and does not affect exit status. A missing snapshot, screenshot, refusal or purchase fails verification.

The vault SDK checks transaction signatures, instruction bindings and token-account deltas. The seller SDK checks signatures, signed URL and payment terms, address proofs, commitment and screen decisions. Solana RPC metadata supplies transaction outcomes, logs, balances, slots and block times. The script verifies those fields against the retained record; the node reports them.

## Save the store file

```sh
node archive.mjs https://dexter.cash/.well-known/did.json
```

The helper requests a Wayback save, reads its timestamped `id_` snapshot, and prints the timestamp, snapshot URL and SHA-256 hashes of the source and archived bytes. Node fetch decodes HTTP content encoding before hashing, as `curl --compressed` does. A save failure or byte mismatch exits with status 1. Run this after the store file is serving and immediately after the approval.

```sh
npm test
```

Tests use generated signing keys, saved documents, local HTTP fixtures and captured public case-two transactions. The case-two fixture exercises the shared approval and payment checks; case-three rehearsal evidence is checked separately. They check signature and commitment mutations, every copycat result, swapped files, missing documents, complete history pagination, a successful history entry, an existing copycat account, screenshot hashes, exact refusal logs and compressed archive bytes.
