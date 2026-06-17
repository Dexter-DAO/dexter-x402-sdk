<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-x402-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/x402</h1>

<p align="center">
  <strong>Give your agent a spending limit it can't exceed.</strong>
</p>

<p align="center">
  Open a tab, set a cap, and your agent pays as it works, with no signature on each charge. Your money stays in your own wallet, and the seller is still guaranteed payment. Buyer and seller SDKs, on Solana and the major EVM chains.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/x402"><img src="https://img.shields.io/npm/v/@dexterai/x402.svg" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E=18-brightgreen.svg" alt="Node"></a>
  <img src="https://img.shields.io/badge/non--custodial-passkey-brightgreen" alt="Non-custodial">
  <a href="https://dexter.cash/sdk"><img src="https://img.shields.io/badge/Try_it-real_payments-blueviolet" alt="Live Demo"></a>
</p>

<p align="center">
  <a href="https://dexter.cash/sdk"><strong>Try it with real payments →</strong></a>
</p>

---

## Why a tab

A tab gives an agent a spending limit that the Solana program enforces at consensus. You set a cap, the agent pays against it call by call with no signature on each charge, and your USDC stays in your own wallet the entire time.

The two older ways to let an agent spend each give up something a tab keeps. Prefunding an escrow moves your money to a custodian, so your balance is on the table and you have paid a stranger in advance. Handing a wallet a spending delegate keeps your custody but lets you withdraw the funds mid-charge, so the seller can be left unpaid and serious sellers decline it. A tab keeps both halves: the money never leaves your wallet, and while the tab is open the chain blocks you from pulling it out from under accrued charges. The seller gets paid when they settle, and settlement is automatic.

The closest familiar shape is an auth-and-capture card hold, with the hold enforced on-chain instead of by a processor.

---

## Install

```bash
npm install @dexterai/x402
```

One install is both sides: the buyer surface at `@dexterai/x402/tab`, the seller surface at `@dexterai/x402/tab/seller`.

## Open a tab and pay (buyer)

A buyer drives tabs through a `vault` adapter over their passkey-rooted Solana vault. Build it once from the vault's addresses, which you receive when you enroll at [dexter.cash](https://dexter.cash), plus your passkey signer:

```ts
import { createSolanaVaultAdapter } from '@dexterai/x402/tab/adapters/solana';

const vault = createSolanaVaultAdapter({
  connection,        // your Solana Connection (any RPC)
  swigAddress,       // the vault's Swig state account, from enrollment
  vaultPda,          // the vault's gate PDA, from enrollment
  passkeySigner,     // browser: WebAuthnAssertion; server agent: passkeySignerFromP256Keypair(kp)
  feePayer,          // lamport fee payer (a Signer)
});
```

Given only a URL, the buyer then reads the seller's terms from the URL's own `402` challenge, opens a freeze-protected tab, and pays. The seller's address comes off the wire, never from your code:

```ts
import { payUrlWithTab } from '@dexterai/x402/tab';

const tabs = new Map(); // one open tab per seller, reused across calls
const { result, tab } = await payUrlWithTab(
  'https://api.example.com/paid/infer',
  { method: 'GET' },
  { vault, perUnitCap: '0.01', totalCap: '1.00', tabs },
);
// ...more payUrlWithTab calls reuse the same tab via `tabs`...
await tab?.close(); // one on-chain settle for everything the agent spent
```

To decide before you pay, `resolveTabTerms(url)` reads a URL's price and settlement terms without paying, for consent screens, directories, or an agent that plans ahead:

```ts
import { resolveTabTerms } from '@dexterai/x402/tab';

const resolved = await resolveTabTerms('https://api.example.com/paid/tick');
if (resolved.kind === 'terms') {
  console.log(resolved.terms.counterparty, resolved.terms.perRequest.human);
  // settlement: { custody: 'non-custodial', protection: 'freeze', settleOn: 'close' }
}
```

## Accept tabs on your API (seller)

`tabOrExactMiddleware` is the recommended default: one middleware that advertises a tab and a one-shot price in a single 402 challenge, so agents pay by tab and one-shot callers pay exact, at the same price.

```ts
import { tabOrExactMiddleware, requireTab, openSse } from '@dexterai/x402/tab/seller';
import type { X402Request } from '@dexterai/x402/server';

app.get('/paid/tick',
  tabOrExactMiddleware({ connection, sellerPubkey, network: 'solana:mainnet', perUnit: '0.01' }),
  async (req, res) => {
    if ((req as X402Request).x402) { res.json({ data: '...', paidVia: 'exact' }); return; } // exact rail
    const tab = requireTab(req);                                                              // tab rail
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(1);
    meter.send(JSON.stringify({ data: '...' }));
    await meter.end();
  });
```

For a tab-only endpoint, compose the two middlewares directly: `tabChallengeMiddleware` (answers voucher-less requests with the standard x402 challenge, so any agent can discover you) before `tabMiddleware` (verifies the per-charge vouchers). Both are exported from `@dexterai/x402/tab/seller`.

---

## How it works

Three nouns and one actor.

- **Vault:** your money, held in your own wallet and locked by your passkey. The program never takes custody.
- **Tab:** a capped spending limit you open against your vault, for one agent and one counterparty. The agent draws against it; the vault enforces the cap.
- **Passkey:** your key. You tap it to set up the vault and to open or approve a tab. Nothing else can authorize a withdrawal.
- **Your agent:** who you open the tab for.

A tab opens with one passkey tap, the agent spends against it with no further prompts, and one on-chain settle pays the seller and closes it. Everything between open and settle is off-chain, so a charge costs no gas and no signature.

---

## Why you can trust it

The word "unruggable" has to be earned, so here is what actually backs it. The properties below are enforced by the on-chain program, not by this SDK.

- **Non-custodial.** Your USDC stays in your own wallet. The program holds no funds; it records bindings and gates a withdrawal. There is no escrow account and no custodian to fail.
- **The cap is enforced on-chain.** The limit is checked by the Solana program at consensus, not by this library and not by Dexter. You can read the program and verify the cap yourself: [`Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`](https://solscan.io/account/Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc) on Solana mainnet.
- **Only your passkey moves funds.** Withdrawals require a WebAuthn assertion verified by Solana's secp256r1 precompile. The SDK and the facilitator never hold a key that can drain your wallet.
- **The seller is protected.** While a tab is open the program blocks the buyer's withdrawal, so funds can't be pulled out from under accrued charges. If a seller ever goes silent, the buyer recovers an abandoned tab themselves after a fixed grace period; nobody's funds can be frozen indefinitely.
- **Live on Solana mainnet.** Tabs settle on mainnet today. We can demonstrate the program rejecting a forged passkey from a clone: see the [`dexter-vault`](https://github.com/Dexter-DAO/dexter-vault) program repo.
- **Pre-audit, and we say so.** Not yet externally audited; funding is in flight. The report and any findings publish in the program repo. Responsible disclosure: branch@dexter.cash.

The full threat model and trust assumptions live in the program's [`SECURITY.md`](https://github.com/Dexter-DAO/dexter-vault).

---

## Approving a tab is one hosted screen

When a partner's app opens a tab for a user, the approval runs on one Dexter-hosted consent screen, deep-linked from the partner's app. The user sees the counterparty, the cap, and the expiry, taps their passkey once, and control returns to the app. The partner builds no approval UI and never handles a passkey.

The screen is hosted by Dexter for a structural reason, not a stylistic one: the vault's passkey can only sign on Dexter's own origin, so a user cannot be phished into approving on a look-alike page. The safety is a property of where the key will sign. Flow and routing: [docs.dexter.cash/tabs](https://docs.dexter.cash). **[TODO: confirm final docs path once #5 lands.]**

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

Protect an endpoint with `x402Middleware`; the handler runs only after payment settles. In React, `useX402Payment` takes wallets from `@solana/wallet-adapter-react` or `wagmi` and returns a `fetch` that pays automatically. Read a settled receipt off any paid response with `getPaymentReceipt(response)`.

```typescript
import { x402Middleware } from '@dexterai/x402/server';

app.get('/api/protected',
  x402Middleware({ payTo: 'YourReceivingAddress', amount: '0.01', network: 'eip155:8453' }),
  (req, res) => res.json({ data: 'protected content' }),
);
```

---

## Also in this package

Four supporting surfaces, each with its own reference below.

- **Batch settlement (EVM).** Prepay an escrow once, make many discrete paid calls against it with off-chain vouchers, and settle in a handful of transactions to amortize gas. EVM only. `openBatchChannel` / `createBatchSettlementSeller`.
- **Discovery (bazaar).** Make any `x402Middleware`-protected route discoverable through the official x402 bazaar spec, so agents find it by capability. `bazaarExtension()`.
- **Sponsored access.** When an agent pays through Dexter's facilitator, a matched recommendation can ride along in the receipt; the agent's model may act on it. `sponsoredAccess: true`.
- **Auto-listing.** Endpoints paid through the facilitator are auto-discovered, named, and quality-tested, then surfaced in `x402_search` across MCP clients. No registration step.

Full examples for each are in the [reference](#reference) section.

---

## Supported networks

All networks supported by the [Dexter facilitator](https://x402.dexter.cash/supported). USDC on every chain. Tabs are Solana; one-shot and batch settlement span Solana and the EVM chains below.

| Network | CAIP-2 | Status |
|---------|--------|--------|
| Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Production |
| Base | `eip155:8453` | Production |
| Polygon | `eip155:137` | Production |
| Arbitrum | `eip155:42161` | Production |
| Optimism | `eip155:10` | Production |
| Avalanche | `eip155:43114` | Production |
| BSC | `eip155:56` | Production |
| SKALE Base | `eip155:1187947933` | Production (zero gas) |

Testnets: Solana Devnet/Testnet, Base Sepolia, SKALE Base Sepolia. Multi-chain endpoints accept any chain in the list; the buyer picks. Pass `network` as an array to `x402Middleware`, with a `payTo` map for per-chain receivers.

---

## Reference

### Package exports

```typescript
// Tabs (Solana): buyer
import { payUrlWithTab, resolveTabTerms, resolveTabOffer } from '@dexterai/x402/tab';

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

### `payUrlWithTab(url, init, opts) → Promise<{ result, tab }>`

Opens (or reuses) a freeze-protected tab to the seller discovered from the URL's `402` challenge, and pays. `opts`: `{ vault, perUnitCap, totalCap, tabs }`. Reuse one `tabs` map across calls to keep a single open tab per seller; `tab.close()` settles everything spent in one transaction.

### `resolveTabTerms(url) → Promise<TabResolution>`

Reads a URL's tab terms without paying. Returns `{ kind: 'terms', terms: { counterparty, perRequest, network, settlement } }`, or a non-terms kind when the URL offers no tab.

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

### Batch settlement

```ts
import { openBatchChannel } from '@dexterai/x402/batch-settlement';

const escrow = await openBatchChannel({ wallet: evmWallet, network: 'eip155:8453', deposit: '0.30' });
await escrow.fetch('https://api.example.com/v1/data');
console.log(escrow.state); // { deposited: '0.3', spent: '0.16', remaining: '0.14' }
await escrow.close();
```

State auto-persists and resumes with `resumeBatchChannel({ wallet, network, salt })`. If the seller never settles, reclaim unspent escrow with `forceWithdraw()` then `finalizeWithdraw()`. The seller mounts `createBatchSettlementSeller(config)` as an Express handler; Dexter operates the authorizer, so the seller manages no signing key. Returns a handler with `.stop()`, `.closeAll()`, `.closeChannel(id)`.

### Discovery, sponsored access

`bazaarExtension()` plus `declareDiscoveryExtension(config)` attach a spec-compliant `extensions.bazaar` block to a route's 402; extensions are opt-in and failure-isolated, so the payment path is never affected. `sponsoredAccess` injects `_x402_sponsored` into responses; read it with `getSponsoredRecommendations(response)`. Campaign creation is x402-gated at `x402ads.io`.

### Legacy

v1-era helpers (`wrapFetch`, `createX402Client`, `x402AccessPass`, `createDynamicPricing`, `stripePayTo`, `x402BrowserSupport`) ship `@deprecated` with JSDoc migration targets and keep working. None will be removed in 3.x. New code should use `payAndFetch` and `x402Middleware`.

---

## Development

```bash
npm run build      # ESM + CJS
npm run dev        # Watch mode
npm run typecheck
npm test           # 273 vitest tests
```

## License

MIT. See [LICENSE](./LICENSE).

---

<p align="center">
  <a href="https://x402.dexter.cash">Dexter Facilitator</a> ·
  <a href="https://dexter.cash/opendexter">OpenDexter Catalog</a> ·
  <a href="https://dexter.cash/sdk">Live Demo</a> ·
  <a href="https://dexter.cash/onboard">Become a Seller</a>
</p>
