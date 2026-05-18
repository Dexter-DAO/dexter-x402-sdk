# x402 v1 SVM (Solana) `exact` Scheme — Client-Side Signing Research

**Date:** 2026-05-18
**Goal:** Ground the implementation of v1 SVM `exact` client-side signing in `@dexterai/x402`'s `src/payment/v1-strategy.ts` (currently skips SVM with comment "SVM v1 signing is not implemented in this SDK").
**Source of truth:** upstream `x402@1.1.0` at `/home/branchmanager/websites/dexter-api/node_modules/x402/dist/cjs/`. Code, not docs.

---

## 1. Summary — what v1 SVM `exact` signing produces

For Solana, v1 `exact` is **NOT a message/authorization blob like EVM's EIP-3009**. The client builds a **full, real Solana v0 transaction** containing exactly three instructions (set-compute-unit-limit, set-compute-unit-price, SPL `TransferChecked`), **partially signs it** with its keypair (signing only the token-transfer authority slot), and ships the **base64-encoded wire transaction** to the merchant. The merchant's facilitator is the **fee payer**: it adds its own signature, completes the transaction, simulates, then submits it to the chain. So the client output is a partially-signed transaction blob, and the facilitator co-signs + broadcasts.

**Critical implication for our SDK:** building this transaction **requires live RPC access**. The upstream client makes **three RPC calls** during `createPaymentHeader` — `fetchMint`, `estimateComputeUnitLimit` (a `simulateTransaction`), and `getLatestBlockhash`. This is a real change to our v1 strategy's API surface: v1 EVM signing is pure/offline, v1 SVM signing is not. **Flagged loudly in §4.**

The good news (§6): our **existing v2 Solana adapter (`src/adapters/solana.ts`) already does essentially this exact thing** with `@solana/web3.js` 1.x. v1 and v2 SVM payloads are structurally near-identical — the transaction construction is reusable almost verbatim; only the surrounding payload envelope differs.

---

## 2. The `X-PAYMENT` payload shape

The decoded (pre-base64) JSON object is the standard v1 `PaymentPayload`. From the zod schema (`schemes/index.js:1129-1138`):

```js
var ExactSvmPayloadSchema = import_zod3.z.object({
  transaction: import_zod3.z.string().regex(Base64EncodedRegex)
});
var PaymentPayloadSchema = import_zod3.z.object({
  x402Version: z.number(),
  scheme:      z.enum(schemes),     // "exact"
  network:     NetworkSchema,        // bare name, e.g. "solana" or "solana-devnet"
  payload:     z.union([ExactEvmPayloadSchema, ExactSvmPayloadSchema])
});
```

So for SVM the `payload` is a single-field object `{ transaction: "<base64>" }`. There is **no `signature` field, no `authorization` object** — unlike EVM. Concrete example of the full decoded object:

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "solana",
  "payload": {
    "transaction": "AQAAAAAAAAAAAAAA...<base64 of the full v0 wire transaction>...=="
  }
}
```

This whole object is `JSON.stringify`'d then base64-encoded into the `X-PAYMENT` header. The encoder (`encodePayment`, `schemes/index.js:1399-1402`) for SVM is trivial — it does NOT stringify bigints (EVM does); it just passes `payload` straight through:

```js
if (SupportedSVMNetworks.includes(payment.network)) {
  safe = { ...payment, payload: payment.payload };
  return safeBase64Encode(JSON.stringify(safe));
}
```

Builder (`createAndSignPayment`, `schemes/index.js:2024-2042`):

```js
async function createAndSignPayment(client, x402Version, paymentRequirements, config2) {
  const transactionMessage = await createTransferTransactionMessage(client, paymentRequirements, config2);
  const signedTransaction = await partiallySignTransactionMessageWithSigners(transactionMessage);
  const base64EncodedWireTransaction = getBase64EncodedWireTransaction(signedTransaction);
  return {
    scheme:  paymentRequirements.scheme,
    network: paymentRequirements.network,
    x402Version,
    payload: { transaction: base64EncodedWireTransaction }
  };
}
```

---

## 3. The transaction — instructions, signers, blockhash

`createTransferTransactionMessage` (`schemes/index.js:2050-2076`) and `createTransferInstructions` (`:2078-2109`):

```js
async function createTransferTransactionMessage(client, paymentRequirements, config2) {
  const rpc = getRpcClient(paymentRequirements.network, config2?.svmConfig?.rpcUrl);
  const transferInstructions = await createTransferInstructions(client, paymentRequirements, config2);
  const feePayer = paymentRequirements.extra?.feePayer;          // <-- facilitator pubkey, from `extra`
  const txToSimulate = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageComputeUnitPrice(1, tx),         // 1 microlamport priority fee
    (tx) => setTransactionMessageFeePayer(feePayer, tx),          // fee payer = facilitator
    (tx) => appendTransactionMessageInstructions(transferInstructions, tx)
  );
  const estimateComputeUnitLimit = estimateComputeUnitLimitFactory({ rpc });
  const estimatedUnits = await estimateComputeUnitLimit(txToSimulate);          // RPC: simulate
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();     // RPC: blockhash
  const tx = pipe(
    txToSimulate,
    (tx) => prependTransactionMessageInstruction(
      getSetComputeUnitLimitInstruction({ units: estimatedUnits }), tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx)
  );
  return tx;
}
```

```js
async function createTransferInstructions(client, paymentRequirements, config2) {
  const { asset, maxAmountRequired: amount, payTo } = paymentRequirements;
  const rpc = getRpcClient(paymentRequirements.network, config2?.svmConfig?.rpcUrl);
  const tokenMint = await fetchMint(rpc, asset);                  // RPC: read mint account
  const tokenProgramAddress = tokenMint.programAddress;           // TOKEN_PROGRAM or TOKEN_2022
  // ... throws if not a known token program ...
  const [sourceATA]      = await findAssociatedTokenPda({ mint: asset, owner: client.address, tokenProgram });
  const [destinationATA] = await findAssociatedTokenPda({ mint: asset, owner: payTo,          tokenProgram });
  const transferIx = getTransferCheckedInstruction({
    source: sourceATA, mint: asset, destination: destinationATA,
    authority: client,                                            // the client keypair signer
    amount: BigInt(amount),
    decimals: tokenMint.data.decimals                             // decimals from the mint, NOT from `extra`
  }, { programAddress: tokenProgramAddress });
  return [transferIx];
}
```

**Final transaction = exactly 3 instructions, in this order** (the facilitator's `verifyTransactionInstructions` at `:1775` *enforces* `instructions.length === 3`):

| # | Instruction | Program | Notes |
|---|---|---|---|
| 0 | `SetComputeUnitLimit` | ComputeBudget | units = estimate from simulation |
| 1 | `SetComputeUnitPrice` | ComputeBudget | 1 microlamport (facilitator caps at 5,000,000) |
| 2 | `TransferChecked` | SPL Token or Token-2022 | source ATA → dest ATA, `amount` = `maxAmountRequired`, `decimals` from mint |

**Signers / co-signing:**
- **Fee payer = the facilitator** (`extra.feePayer` from the `accepts[]` requirement). The client does NOT pay fees.
- The client is the `authority` on the `TransferChecked` instruction → the client signs only that authority slot.
- `partiallySignTransactionMessageWithSigners` signs with whatever signers it has (just the client keypair). The fee-payer signature slot is left empty.
- Facilitator-side `settle` (`schemes/index.js:1876`) calls `signTransactionWithSigner(signer, decodedTransaction)` to add the fee-payer signature, then `assertTransactionFullySigned`, then sends. So **the client deliberately produces a partially-signed transaction; the facilitator completes it.**
- Facilitator `verifyTransactionInstructions` (`:1779-1786`) explicitly **rejects** the transaction if the fee payer appears in any instruction's account list or is the transfer authority — i.e. the facilitator must be *only* the gas sponsor, never a participant in the token movement.

**Blockhash:** a real recent blockhash from `getLatestBlockhash()` — a **mandatory RPC call**. It is NOT in `extra`. The transaction lifetime is blockhash-based (~60–90s validity); the facilitator simulates with `replaceRecentBlockhash: false`, so the client's blockhash must be fresh when the merchant settles.

**"Exact amount to exact payTo" enforcement:** the facilitator's `verifyTransferCheckedInstruction` (`:1810-1842`) independently re-derives `payToATA` from `(asset, payTo)`, requires the instruction's `destination === payToATA`, requires `instruction.data.amount === BigInt(maxAmountRequired)` exactly (mismatch → `invalid_exact_svm_payload_transaction_amount_mismatch`), and confirms via `fetchEncodedAccounts` that both source and destination ATAs exist on-chain.

---

## 4. Inputs & dependencies — the RPC/blockhash question (READ THIS)

**Inputs taken from the `accepts[]` requirement entry:**
- `asset` — the USDC mint address.
- `payTo` — recipient owner address (NOT the ATA; the ATA is derived).
- `maxAmountRequired` — atomic amount string → `BigInt`.
- `scheme` (`"exact"`), `network` (`"solana"` / `"solana-devnet"`).
- `extra.feePayer` — **required**. The facilitator's pubkey, used as the transaction fee payer. If absent, the upstream code passes `undefined` to `setTransactionMessageFeePayer` and the build fails. Our v2 adapter already throws an explicit `"Missing feePayer in payment requirements"` — keep that.

**Inputs derived / fetched at runtime — NOT from the requirement:**
- **Token decimals** — fetched from the mint account on-chain (`fetchMint`). Upstream does NOT trust `extra.decimals`. (Our v2 adapter logs a warning on mismatch but uses the on-chain value — keep that.)
- **Token program** — read from the mint account owner (SPL vs Token-2022).
- **Source & destination ATAs** — derived (`findAssociatedTokenPda`), not provided.
- **Compute unit limit** — from a `simulateTransaction` estimate.
- **Recent blockhash** — from `getLatestBlockhash`.

### >>> RPC IS REQUIRED — this changes the SDK API surface <<<

v1 **EVM** signing in our SDK is pure and offline (sign an EIP-712 typed-data struct, no network). v1 **SVM** signing is **not offline**. Upstream `createPaymentHeader` for SVM makes **three RPC round-trips**:

1. `fetchMint(rpc, asset)` — read the mint account (decimals + token program).
2. `estimateComputeUnitLimitFactory({ rpc })(...)` — a `simulateTransaction` call.
3. `rpc.getLatestBlockhash()` — recent blockhash for the transaction lifetime.

Upstream gets its RPC endpoint from `getRpcClient(network, config?.svmConfig?.rpcUrl)`, defaulting to the **public** `https://api.mainnet-beta.solana.com` / `https://api.devnet.solana.com` (`schemes/index.js:995-1006`) if no override is supplied.

**Implications for our `v1-strategy.ts`:**
- `pay()` / the v1 strategy must accept a Solana RPC URL (or a `Connection`) for the SVM path. Reuse the same `rpcUrl` plumbing the v2 Solana adapter already has (`buildTransaction(accept, wallet, rpcUrl?)`).
- Defaulting to the public RPC works but is rate-limited and slow; the SDK should let callers pass their own (Helius, etc.).
- The v1 strategy can no longer treat "build payment header" as a synchronous pure function for all networks. It is already `async`; just make sure the SVM branch is allowed to do I/O and can surface RPC errors.
- **Blockhash staleness risk:** the gap between the client building the tx and the merchant settling must stay inside the blockhash validity window. Build the payment header as late as possible (right before the retry request), exactly as the strategy already does for EVM.

`x402Version` is `1` for v1 (`createPaymentHeader(signer, 1, requirement)` in dexter-api).

---

## 5. Settlement side (confirmation our output is shaped right)

`settle` (`schemes/index.js:1856-1903`): the facilitator (1) `verify`s — decodes the tx, runs `transactionIntrospection` (3-instruction check, compute-budget checks, transfer-checked checks, ATA existence), signs+simulates with `sigVerify:true` and `replaceRecentBlockhash:false`; (2) `signTransactionWithSigner` adds the fee-payer signature; (3) `assertTransactionFullySigned`; (4) `sendAndConfirmSignedTransaction` → `rpc.sendTransaction(..., { skipPreflight:true })` then waits for confirmation via WebSocket subscriptions. It returns `{ success, transaction: <signature>, payer, network }`.

So our client-side job is precisely: produce a base64 v0 wire transaction, fee payer = `extra.feePayer`, 3 instructions in the mandated order, partially signed by the client (transfer authority). If we match that, the facilitator completes and broadcasts it. No co-signing or extra round-trip from the client.

---

## 6. Associated Token Accounts (ATAs)

- The client-side builder **derives** both ATAs (`findAssociatedTokenPda` for `(asset, client.address)` and `(asset, payTo)`).
- It **assumes both ATAs already exist** — the upstream client does **NOT** add a `createAssociatedTokenAccountIdempotent` instruction (that would make 4 instructions and the facilitator's `instructions.length === 3` check would reject it).
- The facilitator independently verifies both ATAs exist (`fetchEncodedAccounts`); missing → `invalid_exact_svm_payload_transaction_sender_ata_not_found` / `..._receiver_ata_not_found`.
- Our v2 adapter already mirrors this: it derives both ATAs and explicitly checks each with `getAccountInfo`, throwing a friendly error if the source (buyer's USDC account) or destination (seller's USDC account) is missing. **Keep that behavior** — fail fast with a clear message rather than emitting a transaction the facilitator will reject.

---

## 7. Solana library & reusability of our v2 adapter

**Upstream uses `@solana/kit` 5.x** (the new functional Solana SDK), plus `@solana-program/token`, `@solana-program/token-2022`, `@solana-program/compute-budget`. Our SDK does **not** depend on `@solana/kit` and should **not** add it — our SDK uses `@solana/web3.js` 1.x + `@solana/spl-token`.

**This is fine.** The kit-vs-web3.js difference is purely the construction API; the *wire transaction bytes* are identical. A v0 `VersionedTransaction` built with `@solana/web3.js` and partially signed serializes to exactly the bytes the facilitator's `getTransactionDecoder()` expects.

**Our v2 Solana adapter (`src/adapters/solana.ts`, `buildTransaction`) is ~95% reusable for v1.** It already:
- builds a v0 `VersionedTransaction` with fee payer = `extra.feePayer`;
- emits `SetComputeUnitLimit` + `SetComputeUnitPrice` + `createTransferCheckedInstruction` (3 instructions, correct order);
- detects SPL vs Token-2022 from mint owner;
- fetches the mint for decimals;
- derives source/destination ATAs and verifies both exist;
- fetches a recent blockhash;
- partially signs via `wallet.signTransaction(transaction)` (the fee-payer slot stays empty);
- returns `Buffer.from(signedTx.serialize()).toString('base64')`.

That `serialized` base64 string **is** exactly the `payload.transaction` value v1 needs.

**What differs between v1 and v2 — only the envelope and field source:**

| Aspect | v2 (our adapter today) | v1 (what to add) |
|---|---|---|
| Amount field | `accept.amount` (falls back to `maxAmountRequired`) | `maxAmountRequired` |
| Payload envelope | v2 `@x402/core` payload shape | `{ x402Version:1, scheme, network, payload:{ transaction } }` |
| Header encoding | v2 path | `JSON.stringify` → base64 → `X-PAYMENT` |
| Compute unit limit | hard-coded `12_000` | upstream estimates via simulation; **12_000 hard-coded is acceptable** — facilitator only checks instruction[0] is a ComputeBudget set-limit + caps the *price*, not the limit value. Simpler to keep the constant; flag as a minor deviation. |
| Network names | v2 CAIP-ish | v1 bare: `"solana"`, `"solana-devnet"` |

**Recommended implementation path:** in `v1-strategy.ts`, for an SVM `accepts[]` entry, call `createSolanaAdapter().buildTransaction(accept, wallet, rpcUrl)` (the v2 adapter, reused as-is — it is v1/v2-agnostic since it already falls back to `maxAmountRequired`), take its `.serialized`, and wrap it as `{ x402Version: 1, scheme: 'exact', network: accept.network, payload: { transaction: serialized } }`, then `JSON.stringify` + base64 into `X-PAYMENT`. Remove the SVM skip at `v1-strategy.ts:196-197`. This adds essentially no new transaction-building code — it is a thin envelope around an adapter we already ship and test.

---

## 8. Open questions / risks for the implementer

1. **RPC dependency (biggest).** v1 SVM signing needs an RPC endpoint. Decide how the v1 strategy receives it — most likely reuse the existing `rpcUrl` config the v2 Solana path already threads through `buildTransaction`. The public default RPC works but is slow/rate-limited; expose an override. This is a genuine API-surface change vs v1 EVM (which is offline).
2. **Blockhash staleness.** Build the SVM payment header as late as possible (immediately before the retry request). If the merchant is slow to settle, the blockhash can expire (`settle_exact_svm_block_height_exceeded`). v1 EVM has no analogous time pressure.
3. **Compute unit limit constant vs estimate.** Upstream simulates to size the limit; our v2 adapter hard-codes `12_000`. The facilitator does not validate the limit *value* (only that instruction[0] is a ComputeBudget set-limit, and caps the *price* at 5,000,000 microlamports). `12_000` is enough for one `TransferChecked` on an existing ATA. Keep the constant; document the deviation. Revisit only if a facilitator starts simulating and 12_000 proves too low.
4. **`extra.feePayer` must be present.** v1 SVM is unsignable without it. Throw a clear error if a v1 SVM `accepts[]` entry omits `extra.feePayer` (do not silently fall through).
5. **Token-2022 transfer fees.** If a mint is Token-2022 with a transfer-fee extension, `TransferChecked` with `amount = maxAmountRequired` may deliver *less* than required after the fee, and the facilitator's strict `amount` equality check is on the instruction amount (not net received) — so this likely still passes verify, but could surprise. USDC is plain SPL Token, so not a concern for the common case; note it for exotic assets.
6. **Wallet signer shape.** Our v2 adapter expects a `SolanaWallet` with `signTransaction`. The v1 strategy's keypair wallets (`wallets.solana`) must satisfy that interface (or be adapted). Confirm `createSolanaKeypairWallet` (or equivalent) yields a `signTransaction`-capable object before wiring it in.
7. **Partial-sign semantics.** With `@solana/web3.js`, calling `signTransaction` on a `VersionedTransaction` where the fee payer is a different key produces a transaction with the client's signature filled and the fee-payer slot null — i.e. a valid partial signature. Verify `signedTx.serialize()` does not throw on a partially-signed v0 tx (web3.js 1.x allows serializing partially-signed transactions; the v2 adapter already relies on this, so it is proven).

---

## Appendix — key file references (upstream `x402@1.1.0`)

All paths under `/home/branchmanager/websites/dexter-api/node_modules/x402/dist/cjs/`:

- `schemes/index.js:1129-1138` — `ExactSvmPayloadSchema` / `PaymentPayloadSchema`.
- `schemes/index.js:1399-1402` — `encodePayment` SVM branch.
- `schemes/index.js:2014-2042` — `createPaymentHeader2` / `createAndSignPayment` (SVM client entry).
- `schemes/index.js:2050-2076` — `createTransferTransactionMessage` (the 3-instruction build, RPC calls).
- `schemes/index.js:2078-2109` — `createTransferInstructions` (mint fetch, ATA derivation, `TransferChecked`).
- `schemes/index.js:1775-1853` — facilitator `verifyTransactionInstructions` / `verifyTransferCheckedInstruction` (the rules the client must satisfy).
- `schemes/index.js:1856-1903` — facilitator `settle` (co-sign + broadcast).
- `schemes/index.js:995-1031` — `getRpcClient` / default public RPC endpoints.
- `types/index.js:292-301` — `createSignerFromBase58` (kit `createKeyPairSignerFromBytes`).

Our SDK: `src/adapters/solana.ts:162-302` — `buildTransaction` (the reusable v2 builder). `src/payment/v1-strategy.ts:196-197` — the SVM skip to remove.
