# @dexterai/x402 — Reference

The full API surface. For what the SDK *is* and why, start with the [README](./README.md).

- [Package exports](#package-exports)
- [Tabs (buyer)](#tabs-buyer)
- [Sellers](#sellers)
- [One-shot payments](#one-shot-payments)
- [Server middleware](#server-middleware)
- [Batch settlement (EVM)](#batch-settlement-evm)
- [Discovery & sponsored access](#discovery--sponsored-access)
- [Migration](#migration)
- [Development](#development)

---

## Package exports

```typescript
// Tabs (Solana): buyer
import { payUrlWithTab, resolveTabTerms, resolveTabOffer } from '@dexterai/x402/tab';
import { createSolanaVaultAdapter, passkeySignerFromP256Keypair } from '@dexterai/x402/tab/adapters/solana';

// Tabs (Solana): seller
import { tabChallengeMiddleware, tabMiddleware, tabOrExactMiddleware, requireTab, openSse } from '@dexterai/x402/tab/seller';

// One-shot client
import { payAndFetch, createKeypairWallet, createEvmKeypairWallet, getPaymentReceipt } from '@dexterai/x402/client';

// React
import { useX402Payment } from '@dexterai/x402/react';

// Server middleware + discovery
import { x402Middleware, bazaarExtension, declareDiscoveryExtension, createX402Server } from '@dexterai/x402/server';

// Batch settlement
import { openBatchChannel, resumeBatchChannel } from '@dexterai/x402/batch-settlement';
import { createBatchSettlementSeller } from '@dexterai/x402/batch-settlement/seller';

// Adapters (advanced) + utilities
import { createSolanaAdapter, createEvmAdapter } from '@dexterai/x402/adapters';
import { toAtomicUnits, fromAtomicUnits } from '@dexterai/x402/utils';
```

> `@dexterai/vault` is an exact **peer dependency** at `0.43.2`: install it alongside the matching v6 x402 package so the adapter, revocation wire, and your app use one tested Vault contract.

---

## Tabs (buyer)

### `payUrlWithTab(url, init, opts) → Promise<{ result, tab }>`

Opens (or reuses) a lock-protected tab to the seller discovered from the URL's `402` challenge, and pays. `opts`: `{ vault, perUnitCap, totalCap, tabs, reserveFinalVoucherV2 }`. Reuse one `tabs` map across calls to keep a single open tab per seller; `tab.close()` settles everything spent in one transaction. V2 requires `reserveFinalVoucherV2`; see [FINAL V2 reservation provider](#final-v2-reservation-provider).

```ts
import { payUrlWithTab, type ReserveFinalVoucherV2 } from '@dexterai/x402/tab';

const reserveFinalVoucherV2: ReserveFinalVoucherV2 = async (input) => {
  const response = await fetch('/api/native-tab/reserve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`reservation failed: ${response.status}`);
  return response.json();
};
const tabs = new Map();
const { result, tab } = await payUrlWithTab(
  'https://api.example.com/paid/infer',
  { method: 'GET' },
  {
    vault,
    perUnitCap: '0.01',
    totalCap: '1.00',
    tabs,
    reserveFinalVoucherV2,
  },
);
await tab?.close();
```

### `resolveTabTerms(url) → Promise<TabResolution>`

Reads a URL's tab terms without paying. Returns `{ kind: 'terms', terms: { counterparty, perRequest, network, settlement } }`, or a non-terms kind when the URL offers no tab.

```ts
import { resolveTabTerms } from '@dexterai/x402/tab';

const resolved = await resolveTabTerms('https://api.example.com/paid/tick');
if (resolved.kind === 'terms') {
  console.log(resolved.terms.counterparty, resolved.terms.perRequest.human);
  // settlement: { custody: 'non-custodial', protection: 'lock', settleOn: 'close' }
}
```

### `createSolanaVaultAdapter(options)`

Builds the `vault` adapter the buyer calls drive through.

| Option | Type | Description |
|---|---|---|
| `connection` | `Connection` | Your Solana `Connection` (any RPC) |
| `swigAddress` | `string` | The vault's Swig state account, from enrollment |
| `vaultPda` | `string` | The vault's gate PDA, from enrollment |
| `passkeySigner` | `PasskeySignerWithPublicKey` | A `signOperation(operationMessage)` signer (see below) |
| `feePayer` | `Signer` | Lamport fee payer |

The `passkeySigner` uses Vault 0.43.2's canonical shape: `{ credentialId, publicKey, signOperation(operationMessage) }`. The adapter passes the raw operation bytes. The signer obtains the canonical V7 200-byte challenge binding the fixed program, exact vault, current monotonic authorization nonce, operation hash, and fresh ceremony entropy; the adapter owns only the precompile assembly. Do not substitute a bare `sha256(operationMessage)` challenge for V7 operations.

- **Browser:** vault's `DexterApiBrowserPasskeySigner` — drops in with no shim.
- **CLI / server agent:** `passkeySignerFromP256Keypair(kp, { resolveAuthorizationContext })` from `@dexterai/x402/tab/adapters/solana`, wrapping a locally-held P-256 keypair. The resolver must read the current `PasskeyAuthorization` state immediately before a revoke ceremony; the helper never guesses that nonce.

```ts
import { fetchPasskeyAuthorizationState } from '@dexterai/vault';
import { DEXTER_VAULT_PROGRAM_ID } from '@dexterai/vault/constants';
import { passkeySignerFromP256Keypair } from '@dexterai/x402/tab/adapters/solana';
import { PublicKey } from '@solana/web3.js';

const passkeySigner = passkeySignerFromP256Keypair(kp, {
  resolveAuthorizationContext: async () => {
    const authorization = await fetchPasskeyAuthorizationState(
      connection,
      new PublicKey(vaultPda),
    );
    if (!authorization) throw new Error('passkey authorization unavailable');
    return {
      programId: DEXTER_VAULT_PROGRAM_ID,
      vault: authorization.vault,
      nonce: authorization.nonce,
    };
  },
});
```

### FINAL V2 reservation provider

Before a FINAL V2 voucher is returned to merchant-facing code, the buyer must reserve its exact increment through `reserveFinalVoucherV2`. This is a money-side effect and normally belongs in the buyer's authenticated backend, not browser JavaScript. The callback must be idempotent for the same input, use `input.idempotencyKey` as its stable caller-operation identity, and return the complete `FinalVoucherV2ReservationReceipt` only after the exact transaction reaches at least Solana confirmed commitment. Provider receipt and lifecycle IDs remain provider-owned; they are not aliases for the SDK idempotency key. The transaction must contain exactly the canonical `settle_voucher(increment=true)` instruction followed by an SPL Memo v2 instruction whose sole account is the Dexter authority signer and whose UTF-8 data is `finalVoucherV2ReservationMemo(input)`. The Solana adapter independently requires signature status and transaction visibility at least confirmed, verifies both instructions, then reads coherent Vault/SessionAccount post-state at confirmed with `minContextSlot` set only from the independently fetched transaction slot. Processed-only evidence, `{ armed: true }`, a broadcast-only response, a provider-only voucher assertion, or a receipt that does not match the voucher is rejected. A finalized transaction is accepted as stronger evidence if already observed, but this interactive path never polls or waits for finalization.

```ts
const { result, tab } = await payUrlWithTab(url, init, {
  vault,
  perUnitCap: '0.01',
  totalCap: '1.00',
  reserveFinalVoucherV2: async (input) => {
    const response = await fetch('https://your-backend.example/native-tab/reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`reservation failed: ${response.status}`);
    return response.json();
  },
});
```

The Vault instruction proves the exact session and amount. The immediately following authority-signed Memo carries `dexter-native-tab-v2-reservation/v1:<sha256>` and binds that reservation to the complete FINAL voucher and pre-reservation frontier. Provider receipt, lifecycle, and retry identifiers are deliberately outside that shared economic digest and remain separately validated receipt metadata. The provider receipt is durable lifecycle evidence, but it is not the sole voucher binding and cannot replace either transaction instruction.

---

## Sellers

`tabOrExactMiddleware` is the recommended default: one middleware that advertises a tab and a one-shot price in a single 402 challenge, so agents pay by tab and one-shot callers pay exact, at the same price.

```ts
import { tabOrExactMiddleware, requireTab, openSse } from '@dexterai/x402/tab/seller';
import type { X402Request } from '@dexterai/x402/server';

app.get('/paid/tick',
  tabOrExactMiddleware({ connection, sellerPubkey, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', perUnit: '0.01' }),
  async (req, res) => {
    if ((req as X402Request).x402) { res.json({ data: '...', paidVia: 'exact' }); return; } // exact rail
    const tab = requireTab(req);                                                            // tab rail
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(1);                  // demand a fresh voucher; throws if the cap is exceeded
    meter.send(JSON.stringify({ data: '...' }));
    await meter.end();                      // ALWAYS await — persists the final delivered amount
  });
```

For a tab-only endpoint, compose the two middlewares directly: `tabChallengeMiddleware` (answers voucher-less requests with the standard x402 challenge, so any agent can discover you) before `tabMiddleware` (verifies the per-charge vouchers). Both are exported from `@dexterai/x402/tab/seller`.

For Native Tab V2, the buyer carries the complete reservation receipt inside the same `X-Tab-Voucher` envelope. Seller middleware treats it only as an untrusted transaction locator: before your handler can deliver, it independently requires the exact reservation signature and transaction at least confirmed, recomputes the Memo for the presented voucher, verifies the Dexter authority signature, and reads the binding, Vault, and exact SessionAccount together at confirmed with `minContextSlot` equal to the independently fetched transaction slot. That coherent read must prove the active registration, V2 wire, exact frontier, and `currentOutstanding` equal to the voucher's uncovered increment. A cached registration, equal amount, provider assertion, processed-only transaction, or missing proof is not delivery authorization. Finalized evidence is accepted when already present; delivery does not wait for it.

How the protection works: as the agent spends, accrued charges crystallize on-chain into a reservation against the buyer's wallet — sized to exactly what's accrued, not the whole wallet — so the buyer can't withdraw out from under your charges. One on-chain settle at close pays your `sellerPubkey` for everything metered; you hold no key and sign nothing.

---

## One-shot payments

When a charge is a single discrete purchase rather than metered consumption, pay it one-shot. x402 is HTTP's payment protocol: a server returns `402 Payment Required` describing what it wants paid, the client signs and retries, and the resource comes back. USDC on Solana and the major EVM chains, behind one API.

```typescript
import { payAndFetch, createKeypairWallet, createEvmKeypairWallet } from '@dexterai/x402/client';

const solana = await createKeypairWallet(process.env.SOLANA_PRIVATE_KEY);
const evm = await createEvmKeypairWallet(process.env.EVM_PRIVATE_KEY);  // requires: npm install viem

const result = await payAndFetch(
  'https://api.example.com/protected',
  { method: 'GET' },
  { solana, evm },
  {},
);

if (result.ok && result.paid) {
  const data = await result.response.json();
  console.log(`Paid ${result.amountPaid} on ${result.network.bare}, tx ${result.txSignature}`);
} else if (result.ok && !result.paid) {
  const data = await result.response.json(); // endpoint didn't demand payment; passed through
} else {
  console.error(result.reason, result.detail);
}
```

`payAndFetch` handles x402 v1 and v2 transparently and returns a discriminated `PayResult`: `ok` splits into `paid: true | false`, so a free 200 is distinguishable from a paid one, and expected failures don't throw.

### `payAndFetch(url, init, wallets, opts) → Promise<PayResult>`

| Argument | Type | Description |
|---|---|---|
| `url` | `string` | Endpoint to fetch |
| `init` | `RequestInit` | Standard fetch init. Body must be a string. |
| `wallets` | `WalletSet` | `{ solana?, evm? }`. The SDK picks the chain by what the merchant accepts and what you can pay |
| `opts` | `PayAndFetchOptions` | `maxAmountAtomic`, `timeoutMs`, `solanaRpcUrl` |

`PayResult` is a discriminated union. Narrow on `ok`, then on `paid`:

```typescript
if (result.ok && result.paid) {
  result.response; result.amountPaid; result.network; result.txSignature;
} else if (result.ok && !result.paid) {
  result.response;       // merchant didn't demand payment; pass-through
} else {
  result.reason;         // 'merchant_rejected' | 'settlement_failed' | 'timeout' | ...
  result.detail;
}
```

In React, `useX402Payment` takes wallets from `@solana/wallet-adapter-react` or `wagmi` and returns a `fetch` that pays automatically. Read a settled receipt off any paid response with `getPaymentReceipt(response)`.

---

## Server middleware

Protect an endpoint with `x402Middleware`; the handler runs only after payment settles.

```typescript
import { x402Middleware } from '@dexterai/x402/server';

app.get('/api/protected',
  x402Middleware({ payTo: 'YourReceivingAddress', amount: '0.01', network: 'eip155:8453' }),
  (req, res) => res.json({ data: 'protected content' }),
);
```

### `x402Middleware(config)`

| Option | Type | Required | Description |
|---|---|---|---|
| `payTo` | `string \| { 'solana:*'?, 'eip155:*'?, [caip2]? }` | Yes | Receiver address; map for per-chain receivers |
| `amount` | `string` | Yes | USD amount, e.g., `'0.01'` |
| `network` | `string \| string[]` | No | CAIP-2 network(s). Default: Solana mainnet |
| `scheme` | `'exact' \| 'batch-settlement'` | No | `'batch-settlement'` mounts as a batch-settlement seller |
| `extensions` | `ResourceServerExtension[]` | No | E.g., `[bazaarExtension()]` |
| `sponsoredAccess` | `boolean \| { inject?, onMatch? }` | No | Instinct ad-network recommendation injection |
| `facilitatorUrl` | `string` | No | Override facilitator (default: `x402.dexter.cash`) |

Multi-chain endpoints accept any chain the buyer can pay; pass `network` as an array with a `payTo` map for per-chain receivers. Testnets supported: Solana Devnet/Testnet, Base Sepolia, SKALE Base Sepolia.

---

## Batch settlement (EVM)

Prepay an escrow once, make many discrete paid calls against it with off-chain vouchers, and settle in a handful of transactions to amortize gas. EVM only.

```ts
import { openBatchChannel } from '@dexterai/x402/batch-settlement';

const escrow = await openBatchChannel({ wallet: evmWallet, network: 'eip155:8453', deposit: '0.30' });
await escrow.fetch('https://api.example.com/v1/data');
console.log(escrow.state); // { deposited: '0.3', spent: '0.16', remaining: '0.14' }
await escrow.close();
```

State auto-persists and resumes with `resumeBatchChannel({ wallet, network, salt })`. If the seller never settles, reclaim unspent escrow with `forceWithdraw()` then `finalizeWithdraw()`. The seller mounts `createBatchSettlementSeller(config)` as an Express handler; Dexter operates the authorizer, so the seller manages no signing key. The returned handler exposes `.stop()`, `.closeAll()`, `.closeChannel(id)`.

---

## Discovery & sponsored access

`bazaarExtension()` plus `declareDiscoveryExtension(config)` attach a spec-compliant `extensions.bazaar` block to a route's 402; extensions are opt-in and failure-isolated, so the payment path is never affected.

`sponsoredAccess` injects `_x402_sponsored` into responses; read it with `getSponsoredRecommendations(response)`. When an agent pays through Dexter's facilitator, a matched recommendation can ride along in the receipt and the agent's model may act on it. Campaign creation is x402-gated at `x402ads.io`.

Endpoints paid through the facilitator are auto-discovered, named, and quality-tested, then surfaced in `x402_search` across MCP clients — no registration step.

---

## Migration

### Migrating to 6.0.0

1. Install the current tested pair: `npm install @dexterai/x402 @dexterai/vault`.
2. Add `sessionVoucherVersion` to every custom `VaultAdapter`. Buyer-side V1 open and reconstruction are not supported in v6 and throw `HistoricalV1MigrationRequiredError`; settle or revoke a historical V1 session through the deployment that originally opened it, then create a context-bound V2 session. Seller-side verification remains available only for already-issued V1 vouchers.
3. For V2, implement `verifyFinalVoucherV2Reservation` and replace boolean reservation callbacks with the complete versioned receipt.
4. Treat `Tab.voucherVersion` as required. Missing or invalid runtime values fail closed.
5. Node P-256 signers must resolve the current authorization state for revoke; unknown operations no longer silently use the legacy hash.
6. Serialize access to a Tab at the application boundary as well. The runtime now rejects concurrent sign/close calls rather than allowing duplicate sequence issuance.

`5.4.2` may be used only with its historical, compatible Vault range. Do not pair it with Vault `0.43.x`; its close wire predates exact-state V3 revocation.

### Migrating to 5.0.0 (breaking)

Two changes, both about packaging and the passkey signer — the payment path itself is unchanged.

1. **`@dexterai/vault` became a peer dependency** in v5, rather than a bundled dependency. Current v6 consumers must use the exact tested `0.43.2` pair described above.
2. **The passkey signer contract is `signOperation(operationMessage)`**, replacing the old `sign(challenge)`. The adapter hands the signer the RAW operation message. A V7 signer must resolve the authoritative vault authorization nonce and build the canonical 200-byte challenge; bare `sha256(op)` is legacy-only and fails closed on V7. If you wrote a custom signer against `sign(challenge)`, pass the raw operation into Dexter's canonical challenge policy instead of accepting a caller-supplied challenge. Vault's browser signer and this package's `passkeySignerFromP256Keypair` node/agent signer already conform for the supported session operations.

To pin the old surface, stay on `@dexterai/x402@^4`.

### Removed in v4.0.0

The v1-era helpers were removed in `4.0.0`. The payment engine is unchanged — the canonical entrypoints have done their jobs since 3.x:

| Removed | Use instead |
| --- | --- |
| `createX402Client(...).fetch(url)` | `payAndFetch(url, init, wallets)` (client) |
| `wrapFetch(fetch, opts)` | `payAndFetch` (client) — or pass your `WalletSet` directly |
| `x402AccessPass`, `x402BrowserSupport` | `x402Middleware` (server) |
| `createDynamicPricing`, `formatPricing` | compute the price per request in your handler, pass it to `x402Middleware` |
| `createTokenPricing`, `countTokens`, `MODEL_REGISTRY` + model getters | gone — these wrapped a hardcoded Jan-2026 OpenAI snapshot that goes stale; price requests with your model provider's live API and pass the amount to `x402Middleware` |
| `stripePayTo` | a `PayToProvider` map on `x402Middleware` |
| `useAccessPass` (react) | `useX402Payment` (react) |

`payAndFetch` speaks both x402 v1 and v2 and returns a discriminated `PayResult`, so it covers everything the old clients did. **EVM one-shot pay-per-call is unchanged** — `payAndFetch` is the EVM path until Tabs reaches EVM.

---

## Development

```bash
npm run build      # ESM + CJS
npm run dev        # Watch mode
npm run typecheck
npm test           # vitest
```

MIT. See [LICENSE](./LICENSE).
