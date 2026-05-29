<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-x402-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/x402</h1>

<p align="center">
  <strong>HTTP-native micropayments for agents. Solana and the major EVM chains.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/x402"><img src="https://img.shields.io/npm/v/@dexterai/x402.svg" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E=18-brightgreen.svg" alt="Node"></a>
  <a href="https://dexter.cash/sdk"><img src="https://img.shields.io/badge/Live_Demo-dexter.cash%2Fsdk-blueviolet" alt="Live Demo"></a>
</p>

<p align="center">
  <a href="https://dexter.cash/sdk"><strong>Try it with real payments →</strong></a>
</p>

---

## What is x402?

x402 is HTTP's missing payment protocol. A server returns `402 Payment Required` with a `PAYMENT-REQUIRED` header describing what it wants paid; the client signs a payment, retries with `PAYMENT-SIGNATURE`, and gets the resource.

The audience this is built for in 2026 is **agents**: Claude, ChatGPT, Cursor, and the rest, making paid HTTP calls on behalf of humans. This SDK is the buyer side and the seller side, with USDC on Solana and the major EVM chains, behind a single API.

You call `payAndFetch()` on the client. You add `x402Middleware()` on the server. Payments happen.

Built against the official x402 v1 and v2 specs. Adds the multi-chain buyer and seller surface, the React hook, a discriminated `PayResult` type, and batch-settlement channels for high-frequency calls.

---

## Quick start

```bash
npm install @dexterai/x402
```

### Pay for a resource (Node.js, any chain)

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
  // Endpoint didn't demand payment; response came through unchanged.
  const data = await result.response.json();
} else {
  console.error(result.reason, result.detail);
}
```

`payAndFetch` is version-agnostic (handles x402 v1 and v2 transparently) and returns a discriminated `PayResult`. The `ok: true` branch is further split by `paid: true | false`, so a free 200 response is distinguishable from an actually-paid one. No throws for expected failures.

### Pay for a resource (Browser, React)

`useX402Payment` accepts wallets from your existing providers (`@solana/wallet-adapter-react`, `wagmi`) and exposes a `fetch` that pays automatically.

```tsx
import { useX402Payment } from '@dexterai/x402/react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';

function PayButton({ url }: { url: string }) {
  const solanaWallet = useWallet();
  const evmWallet = useAccount();

  const { fetch, isLoading, balances, transactionUrl } = useX402Payment({
    wallets: { solana: solanaWallet, evm: evmWallet },
  });

  return (
    <div>
      <p>Balance: ${balances[0]?.balance.toFixed(2)}</p>
      <button onClick={() => fetch(url)} disabled={isLoading}>
        {isLoading ? 'Paying…' : 'Pay'}
      </button>
      {transactionUrl && <a href={transactionUrl}>View transaction</a>}
    </div>
  );
}
```

### Protect an endpoint (server)

```typescript
import express from 'express';
import { x402Middleware } from '@dexterai/x402/server';

const app = express();

app.get(
  '/api/protected',
  x402Middleware({
    payTo: 'YourReceivingAddress',
    amount: '0.01',                // $0.01 USDC
    network: 'eip155:8453',        // Base. Pass an array for multi-chain.
  }),
  (req, res) => res.json({ data: 'protected content' }),
);
```

The handler only runs after a successful payment. Pass `network` as an array to accept across multiple chains; the buyer picks the chain they have balance on.

### Reading the receipt

`getPaymentReceipt(response)` returns the settled-payment info attached to any paid response (whether the payment came from `payAndFetch`, the legacy `wrapFetch`, or the React hook).

```typescript
import { payAndFetch, getPaymentReceipt } from '@dexterai/x402/client';

const result = await payAndFetch(url, { method: 'GET' }, wallets, {});
if (result.ok && result.paid) {
  const receipt = getPaymentReceipt(result.response);
  console.log('tx:', receipt?.transaction, 'on', receipt?.network);
}
```

---

## Batch settlement (EVM)

Batch settlement lets a buyer pre-fund an escrow channel once, make many **discrete** paid API calls against it with cheap off-chain vouchers, and then close the channel. The seller's many charges are batched into a handful of on-chain transactions instead of one per call. It amortizes gas across high-frequency discrete purchasing.

It is **not** a streaming primitive; it batches discrete purchases. EVM only (Base, Arbitrum, Polygon). The buyer never needs a gas token: every step (deposit, voucher, claim, settle, refund) is signature-based; the Dexter facilitator submits the transactions and pays the gas.

### Buyer

```ts
import { openBatchChannel } from '@dexterai/x402/batch-settlement';

const channel = await openBatchChannel({
  wallet: evmWallet,            // any { address, signTypedData }
  network: 'eip155:8453',       // Base
  deposit: '0.30',              // USDC escrowed for this channel
});

const a = await channel.fetch('https://api.example.com/v1/data');
const b = await channel.fetch('https://api.example.com/v1/data');

console.log(channel.state); // { deposited: '0.3', spent: '0.16', remaining: '0.14' }

const { closed } = await channel.close();
```

Each `openBatchChannel` call opens a new channel: a fresh random channel-config salt is generated, so a buyer can hold several independent channels with the same seller over time. The salt is exposed as `channel.salt`; persist it if you will later need to resume that exact channel.

Resume after a process restart with the wallet, network, and the channel's salt:

```ts
import { resumeBatchChannel } from '@dexterai/x402/batch-settlement';

const channel = await resumeBatchChannel({
  wallet: evmWallet,
  network: 'eip155:8453',
  salt: savedSalt,
});
```

Channel state auto-persists (localStorage in the browser, a file under `~/.dexter-x402/channels` in Node); the resumed channel's accounting is recovered from storage, or from on-chain state if storage was lost.

#### Escape hatch: `forceWithdraw()` / `finalizeWithdraw()`

If the seller never settles, the buyer can reclaim unspent escrow directly via the channel contract's timed withdrawal:

```ts
await channel.forceWithdraw();
// after the channel's withdraw delay elapses
await channel.finalizeWithdraw();
```

Last-resort safety net; normal operation never needs it. Unlike every other batch-settlement step, the escape hatch costs the buyer gas: the wallet must expose a `sendTransaction` method.

### Seller

`createBatchSettlementSeller(config)` returns an Express request handler. Mount it directly; it accepts vouchers, persists them, and settles in the background. Dexter operates the delegate authorizer, so the seller manages no signing key.

```ts
import { createBatchSettlementSeller } from '@dexterai/x402/batch-settlement/seller';

const seller = createBatchSettlementSeller({
  payTo: '0xYourReceivingAddress',
  network: 'eip155:8453',
  price: '0.08',
});

app.use('/api/data', seller);

process.on('SIGTERM', async () => {
  await seller.stop();   // flushes a final settle so no vouchers are lost
});
```

Mounting via `x402Middleware` also works. With `scheme: 'batch-settlement'` it returns the same callable seller object, so you keep the `.stop()` / `.closeAll()` / `.closeChannel()` handle.

---

## Discovery (bazaar extension)

Shipped in 3.8.0. The bazaar extension makes any `x402Middleware`-protected route discoverable through the official x402 bazaar spec, so agents browsing a bazaar-compliant indexer find your endpoint by capability, not by URL.

The 402 response carries a spec-compliant `extensions.bazaar` block describing the route's inputs, output schema, and template path. Discovery indexers read it and surface your endpoint in agent-facing catalogs.

```typescript
import {
  x402Middleware,
  bazaarExtension,
  declareDiscoveryExtension,
} from '@dexterai/x402/server';

app.post(
  '/v1/translate',
  x402Middleware({
    payTo: '...',
    amount: '0.02',
    network: 'eip155:8453',
    extensions: [bazaarExtension()],
    declarations: {
      ...declareDiscoveryExtension({
        method: 'POST',
        bodyType: 'json',
        inputSchema: {
          properties: {
            text: { type: 'string', description: 'Source text' },
            targetLang: { type: 'string', description: 'ISO 639-1 code' },
          },
          required: ['text', 'targetLang'],
        },
        output: {
          example: { translation: 'Bonjour' },
        },
      }),
    },
  }),
  (req, res) => res.json({ translation: translate(req.body) }),
);
```

`extensions` is opt-in: middleware without an `extensions` array emits a 402 byte-identical to pre-3.8.0 behavior. `method` may be omitted from `declareDiscoveryExtension`; the extension stamps the actual request method at 402 time.

Failure isolation: if an extension throws, it's caught, logged, and skipped. The 402 still goes out, just without that key. The payment path is never affected.

---

## Sponsored Access (Instinct ad network)

This is how MCP agents (Claude, ChatGPT, Cursor) see your sponsored placements. When an agent pays for an API through Dexter's facilitator, a matched recommendation can be injected into the settlement receipt; the agent's LLM reads it and may call the suggested resource next. Both blockchain transactions become proof of the conversion.

The buyer-side helpers are wired into every MCP `fetch` tool in the Dexter ecosystem, plus the human-facing receipt UI on x402gle. If you're shipping an x402 endpoint, sponsored access is how you reach the agents already using paid APIs.

### Seller: enable recommendation injection

```typescript
import { x402Middleware } from '@dexterai/x402/server';

app.get(
  '/api/data',
  x402Middleware({
    payTo: '...',
    amount: '0.01',
    sponsoredAccess: true,         // injects _x402_sponsored into JSON responses
  }),
  (req, res) => res.json({ data: 'content' }),
);
// Response: { _x402_sponsored: [{ resourceUrl, description, sponsor }], data: 'content' }
```

For custom placement (where in the body the recommendation appears, conversion logging, etc.), pass an object instead of `true`:

```typescript
sponsoredAccess: {
  inject: (body, recs) => ({ ...body, related_tools: recs }),
  onMatch: (recs, settlement) => log(`matched ${recs.length} for tx ${settlement.transaction}`),
},
```

### Buyer: read recommendations off a paid response

```typescript
import {
  payAndFetch,
  getSponsoredRecommendations,
  fireImpressionBeacon,
} from '@dexterai/x402/client';

const result = await payAndFetch(url, { method: 'GET' }, wallets, {});
if (result.ok && result.paid) {
  const recs = getSponsoredRecommendations(result.response);
  if (recs) {
    for (const rec of recs) {
      console.log(`${rec.sponsor}: ${rec.description} (${rec.resourceUrl})`);
    }
    await fireImpressionBeacon(result.response);
  }
}
```

### React: recommendations in the hook

```tsx
import { useX402Payment } from '@dexterai/x402/react';

function PayButton() {
  const { fetch, isLoading, sponsoredRecommendations } = useX402Payment({ wallets });

  return (
    <div>
      <button onClick={() => fetch(url)} disabled={isLoading}>Pay</button>
      {sponsoredRecommendations?.map((rec, i) => (
        <a key={i} href={rec.resourceUrl}>{rec.sponsor}: {rec.description}</a>
      ))}
    </div>
  );
}
```

### Advertise

Campaign creation is x402-gated at `x402ads.io`. Your wallet is your identity. Full advertiser guide at [docs.dexter.cash/docs/sponsored-access/for-advertisers](https://docs.dexter.cash/docs/sponsored-access/for-advertisers).

---

## Auto-listing in OpenDexter

When an agent pays for your API through the Dexter facilitator, your endpoint is auto-discovered, AI-named, and quality-tested. Quality-verified endpoints surface in `x402_search` results across MCP clients (ChatGPT, Claude, Cursor). No registration step.

Browse the live catalog at [dexter.cash/opendexter](https://dexter.cash/opendexter).

---

## Supported networks

All networks supported by the [Dexter facilitator](https://x402.dexter.cash/supported). USDC on every chain.

**Mainnets:**

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

**Testnets:**

| Network | CAIP-2 |
|---------|--------|
| Solana Devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` |
| Solana Testnet | `solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z` |
| Base Sepolia | `eip155:84532` |
| SKALE Base Sepolia | `eip155:324705682` |

Multi-chain endpoints accept payments on any chain in the list. The buyer picks:

```typescript
app.get('/api/data', x402Middleware({
  payTo: {
    'solana:*': 'YourSolanaAddress...',
    'eip155:*': '0xYourEvmAddress...',
  },
  amount: '0.01',
  network: [
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    'eip155:8453',
    'eip155:137',
    'eip155:42161',
    'eip155:10',
    'eip155:43114',
    'eip155:56',
    'eip155:1187947933',
  ],
}));
```

---

## Package exports

```typescript
// Client: canonical entrypoint
import { payAndFetch, createKeypairWallet, createEvmKeypairWallet, getPaymentReceipt } from '@dexterai/x402/client';

// Client: sponsored access reader
import { getSponsoredRecommendations, fireImpressionBeacon } from '@dexterai/x402/client';

// React
import { useX402Payment } from '@dexterai/x402/react';

// Server: middleware
import { x402Middleware } from '@dexterai/x402/server';

// Server: discovery (bazaar extension)
import { bazaarExtension, declareDiscoveryExtension } from '@dexterai/x402/server';

// Server: manual control
import { createX402Server } from '@dexterai/x402/server';

// Batch settlement
import { openBatchChannel, resumeBatchChannel } from '@dexterai/x402/batch-settlement';
import { createBatchSettlementSeller } from '@dexterai/x402/batch-settlement/seller';

// Adapters (advanced)
import { createSolanaAdapter, createEvmAdapter } from '@dexterai/x402/adapters';

// Utilities
import { toAtomicUnits, fromAtomicUnits } from '@dexterai/x402/utils';
```

---

## Utilities

```typescript
import { toAtomicUnits, fromAtomicUnits } from '@dexterai/x402/utils';

toAtomicUnits(0.05, 6);          // '50000'
toAtomicUnits(1.50, 6);          // '1500000'
fromAtomicUnits('50000', 6);     // 0.05
fromAtomicUnits(1500000n, 6);    // 1.5
```

---

## Manual server (advanced)

For full control over the payment flow without `x402Middleware`:

```typescript
import { createX402Server } from '@dexterai/x402/server';

const server = createX402Server({
  payTo: 'YourAddress...',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
});

app.post('/protected', async (req, res) => {
  const paymentSig = req.headers['payment-signature'];

  if (!paymentSig) {
    const requirements = await server.buildRequirements({
      amountAtomic: '50000',  // $0.05 USDC
      resourceUrl: req.originalUrl,
    });
    res.setHeader('PAYMENT-REQUIRED', server.encodeRequirements(requirements));
    return res.status(402).json({});
  }

  const result = await server.settlePayment(paymentSig);
  if (!result.success) {
    return res.status(402).json({ error: result.errorReason });
  }

  res.json({ data: 'protected content' });
});
```

---

## Legacy capabilities

Several v1-era helpers ship with `@deprecated` markers in 3.9. They keep working. The markers exist to steer new code at the canonical paths. Each has a JSDoc pointing at its migration target.

| Symbol | Migration target |
|---|---|
| `wrapFetch` (`@dexterai/x402/client`) | `payAndFetch` (version-agnostic, discriminated return type) |
| `createX402Client` (`@dexterai/x402/client`) | `payAndFetch` |
| `x402AccessPass`, `useAccessPass` | No replacement. Per-request `x402Middleware` + `payAndFetch` covers the same usage pattern. |
| `createDynamicPricing`, `createTokenPricing`, `MODEL_PRICING` | Price requests in your handler (use your model provider's live API for LLM cases) and pass the amount to `x402Middleware`. The v1 character-based and tiktoken-based helpers were stopgaps before x402 v2 dynamic pricing landed. |
| `stripePayTo` | No replacement in the SDK. Integrate Stripe at your application layer if needed. |
| `x402BrowserSupport` | No replacement. Build a custom paywall page if you need one. |

None of these will be removed in 3.x.

---

## API reference

### `payAndFetch(url, init, wallets, opts) → Promise<PayResult>`

| Argument | Type | Description |
|---|---|---|
| `url` | `string` | Endpoint to fetch |
| `init` | `RequestInit` | Standard fetch init. Body must be a string. |
| `wallets` | `WalletSet` | `{ solana?, evm? }`. The SDK picks the chain by what the merchant accepts and what you can pay |
| `opts` | `PayAndFetchOptions` | `maxAmountAtomic`, `timeoutMs`, `solanaRpcUrl` |

`PayResult` is a discriminated union. Narrow on `ok` first, then on `paid`:

```typescript
if (result.ok && result.paid) {
  result.response;       // the merchant's response
  result.amountPaid;     // amount actually paid, in the token's smallest denomination
  result.network;        // NetworkRef { caip2, bare, family }
  result.txSignature;    // optional; tx hash where the chain reports one
} else if (result.ok && !result.paid) {
  result.response;       // the merchant didn't demand payment; pass-through
} else {
  result.reason;         // 'merchant_rejected' | 'settlement_failed' | 'timeout' | ...
  result.detail;         // verbatim merchant error for settlement_failed
}
```

### `x402Middleware(config)`

| Option | Type | Required | Description |
|---|---|---|---|
| `payTo` | `string \| { 'solana:*'?, 'eip155:*'?, [caip2]? }` | Yes | Receiver address; map for per-chain receivers |
| `amount` | `string` | Yes | USD amount, e.g., `'0.01'` |
| `network` | `string \| string[]` | No | CAIP-2 network(s). Default: Solana mainnet |
| `description` | `string` | No | Human-readable description |
| `scheme` | `'exact' \| 'batch-settlement'` | No | Use `'batch-settlement'` to mount as a batch-settlement seller |
| `extensions` | `ResourceServerExtension[]` | No | E.g., `[bazaarExtension()]` |
| `declarations` | `Record<string, unknown>` | No | Per-route extension config (see `declareDiscoveryExtension`) |
| `sponsoredAccess` | `boolean \| { inject?, onMatch? }` | No | Enable Instinct ad-network recommendation injection |
| `facilitatorUrl` | `string` | No | Override facilitator (default: `x402.dexter.cash`) |
| `verbose` | `boolean` | No | Debug logging |

### `useX402Payment({ wallets })`

Returns `{ fetch, isLoading, status, error, transactionId, transactionUrl, balances, refreshBalances, reset, sponsoredRecommendations }`. Accepts wallets directly from `@solana/wallet-adapter-react` and `wagmi`, with no manual adapter wrapping.

### `createBatchSettlementSeller(config)`

| Option | Type | Description |
|---|---|---|
| `payTo` | `string` | EVM receiver |
| `network` | `string` | CAIP-2 network |
| `price` | `string` | Per-call USD price |
| `storage` | `ChannelStorage` | Optional. Defaults to file storage under `~/.dexter-x402/channels` |

Returns an Express handler with `.stop()`, `.closeAll()`, `.closeChannel(channelId)`.

### `bazaarExtension()` / `declareDiscoveryExtension(config)`

The bazaar extension factory takes no arguments. Per-route discovery config is supplied through `declareDiscoveryExtension(config)`:

| Field | Type | Notes |
|---|---|---|
| `method` | `'GET' \| 'HEAD' \| 'DELETE' \| 'POST' \| 'PUT' \| 'PATCH'` | Optional. If omitted, the actual request method is used. |
| `queryParams` | `Record<string, ParamSpec>` | For GET/HEAD/DELETE routes |
| `bodyType` | `'json' \| 'form'` | For POST/PUT/PATCH routes |
| `body` | `Record<string, ParamSpec>` | For POST/PUT/PATCH routes |
| `inputSchema` | JSON Schema (Draft 2020-12) | Validates `info` |
| `output` | `{ example, schema? }` | Example response payload |

---

## Development

```bash
npm run build      # ESM + CJS
npm run dev        # Watch mode
npm run typecheck
npm test           # 273 vitest tests
```

---

## License

MIT. See [LICENSE](./LICENSE).

---

<p align="center">
  <a href="https://x402.dexter.cash">Dexter Facilitator</a> ·
  <a href="https://dexter.cash/opendexter">OpenDexter Catalog</a> ·
  <a href="https://dexter.cash/sdk">Live Demo</a> ·
  <a href="https://dexter.cash/onboard">Become a Seller</a>
</p>
