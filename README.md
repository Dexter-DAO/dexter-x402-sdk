<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-x402-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/x402</h1>

<p align="center">
  <strong>Full-stack x402 SDK. Add paid API monetization to any endpoint. Solana, Base, and 4 more chains.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/x402"><img src="https://img.shields.io/npm/v/@dexterai/x402.svg" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E=18-brightgreen.svg" alt="Node"></a>
  <a href="https://dexter.cash/sdk"><img src="https://img.shields.io/badge/Live_Demo-dexter.cash%2Fsdk-blueviolet" alt="Live Demo"></a>
  <a href="https://dexter.cash/opendexter"><img src="https://img.shields.io/badge/Marketplace-5%2C000%2B_APIs-success" alt="Marketplace"></a>
</p>

<p align="center">
  <a href="https://dexter.cash/sdk"><strong>Try it with real payments →</strong></a>
</p>

---

## What is x402?

x402 is a protocol for HTTP-native micropayments. When a server returns HTTP status `402 Payment Required`, it includes payment details in a `PAYMENT-REQUIRED` header. The client signs a payment transaction and retries the request with a `PAYMENT-SIGNATURE` header. The server verifies and settles the payment, then returns the protected content.

This SDK handles the entire flow automatically—you just call `fetch()` and payments happen transparently. With **Access Pass** mode, buyers pay once and get unlimited access for a time window—no per-request signing needed.

---

## Why This SDK?

**Monetize any API in minutes.** Add payments to your server in ~10 lines. Clients pay automatically—no checkout pages, no subscriptions, no invoices. Just HTTP.

**Dynamic pricing.** Charge based on usage: characters, tokens, records, pixels, API calls—whatever makes sense. Price scales with input, not fixed rates.

**Token-accurate LLM pricing.** Built-in [tiktoken](https://github.com/openai/tiktoken) support prices AI requests by actual token count. Works with OpenAI models out of the box, or bring your own rates for Anthropic, Gemini, Mistral, or local models.

**Access Pass.** Pay once, get unlimited access for a time window. Buyers connect a wallet, make one payment, and receive a JWT token that works like an API key—no per-request signing, no private keys in code. The Stripe replacement for crypto-native APIs.

**Full-stack.** Client SDK for browsers, server SDK for backends. React hooks, Express middleware patterns, facilitator client—everything you need.

**Multi-chain.** Solana and Base (Ethereum L2) with the same API. Add wallets for both and the SDK picks the right one automatically.

**Works out of the box.** Built-in RPC proxy, pre-flight balance checks, automatic retry on 402. Uses the [Dexter facilitator](https://x402.dexter.cash) by default—Solana's most feature-rich x402 facilitator.

---

## Automatic Marketplace Discovery

When someone pays for your API through the Dexter facilitator, your endpoint is **automatically discovered and listed** in the [OpenDexter Marketplace](https://dexter.cash/opendexter) — a searchable directory of 5,000+ paid APIs used by AI agents.

No registration step needed. The flow:

1. You add `x402Middleware` to your endpoint (see Quick Start below)
2. An agent pays for your API → the facilitator processes the settlement
3. Your endpoint is auto-discovered, AI-named, and quality-verified
4. Agents find it via `x402_search` in any MCP client (ChatGPT, Claude, Cursor, etc.)

Quality-verified endpoints (score 75+) get promoted in search results. The verification bot tests your endpoint automatically — no action required on your part.

---

## Quick Start

### Install

```bash
npm install @dexterai/x402
```

### Client (Node.js) — NEW!

The simplest way to make x402 payments from scripts:

```typescript
import { wrapFetch } from '@dexterai/x402/client';

const x402Fetch = wrapFetch(fetch, {
  walletPrivateKey: process.env.SOLANA_PRIVATE_KEY,
});

// That's it. 402 responses are handled automatically.
const response = await x402Fetch('https://api.example.com/protected');
```

### Client (Browser)

```typescript
import { createX402Client } from '@dexterai/x402/client';

const client = createX402Client({
  wallets: {
    solana: solanaWallet,
    evm: evmWallet,
  },
});

// That's it. 402 responses are handled automatically.
const response = await client.fetch('https://api.example.com/protected');
```

RPC URLs are optional—the SDK uses Dexter's RPC proxy by default. Override if needed:

```typescript
const client = createX402Client({
  wallets: { solana: solanaWallet },
  rpcUrls: {
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'https://your-rpc.com',
  },
});
```

### React

Works with [`@solana/wallet-adapter-react`](https://github.com/anza-xyz/wallet-adapter) and [`wagmi`](https://wagmi.sh/) out of the box:

```tsx
import { useX402Payment } from '@dexterai/x402/react';
import { useWallet } from '@solana/wallet-adapter-react';  // Solana
import { useAccount } from 'wagmi';                        // EVM (Base)

function PayButton() {
  // Get wallets from your existing providers
  const solanaWallet = useWallet();
  const evmWallet = useAccount();

  const { fetch, isLoading, balances, transactionUrl } = useX402Payment({
    wallets: { 
      solana: solanaWallet,  // Pass directly - SDK handles the interface
      evm: evmWallet,
    },
  });

  return (
    <div>
      <p>Balance: ${balances[0]?.balance.toFixed(2)}</p>
      <button 
        onClick={() => fetch('/api/protected')} 
        disabled={isLoading || !solanaWallet.connected}
      >
        {isLoading ? 'Paying...' : 'Pay'}
      </button>
      {transactionUrl && <a href={transactionUrl}>View Transaction</a>}
    </div>
  );
}
```

---

## Supported Networks

| Network | Identifier | Client | Server |
|---------|------------|--------|--------|
| Solana Mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | ✅ Verified | ✅ Verified |
| Base Mainnet | `eip155:8453` | ✅ Verified | ✅ Verified |

All networks use USDC. Both client and server SDKs are production-tested with real payments.

---

## Package Exports

```typescript
// Client - browser
import { createX402Client } from '@dexterai/x402/client';

// Client - Node.js (private key wallet)
import { wrapFetch, createKeypairWallet } from '@dexterai/x402/client';

// React hook
import { useX402Payment } from '@dexterai/x402/react';

// Server - Express middleware
import { x402Middleware } from '@dexterai/x402/server';

// Server - Access Pass (pay once, unlimited requests)
import { x402AccessPass } from '@dexterai/x402/server';

// Server - manual control
import { createX402Server } from '@dexterai/x402/server';

// Server - dynamic pricing
import { createDynamicPricing, createTokenPricing } from '@dexterai/x402/server';

// React - Access Pass hook
import { useAccessPass } from '@dexterai/x402/react';

// Chain adapters (advanced)
import { createSolanaAdapter, createEvmAdapter } from '@dexterai/x402/adapters';

// Utilities
import { toAtomicUnits, fromAtomicUnits } from '@dexterai/x402/utils';
```

---

## Utilities

```typescript
import { toAtomicUnits, fromAtomicUnits } from '@dexterai/x402/utils';

// Convert dollars to atomic units (for API calls)
toAtomicUnits(0.05, 6);  // '50000'
toAtomicUnits(1.50, 6);  // '1500000'

// Convert atomic units back to dollars (for display)
fromAtomicUnits('50000', 6);   // 0.05
fromAtomicUnits(1500000n, 6);  // 1.5
```

---

## Server SDK

### Express Middleware — NEW!

One-liner payment protection for any Express endpoint:

```typescript
import express from 'express';
import { x402Middleware } from '@dexterai/x402/server';

const app = express();

app.get('/api/protected',
  x402Middleware({
    payTo: 'YourSolanaAddress...',
    amount: '0.01',  // $0.01 USD
  }),
  (req, res) => {
    // This only runs after successful payment
    res.json({ data: 'protected content' });
  }
);
```

Options:
- `payTo` — Address to receive payments
- `amount` — Price in USD (e.g., `'0.01'` for 1 cent)
- `network` — CAIP-2 network (default: Solana mainnet)
- `description` — Human-readable description
- `facilitatorUrl` — Override facilitator (default: x402.dexter.cash)
- `verbose` — Enable debug logging

### Access Pass — Pay Once, Unlimited Requests

Replace API keys with time-limited access passes. Buyers make one payment and get a JWT token for unlimited requests during a time window.

**Server:**

```typescript
import express from 'express';
import { x402AccessPass } from '@dexterai/x402/server';

const app = express();

// Protect all /api routes with access pass
app.use('/api', x402AccessPass({
  payTo: 'YourSolanaAddress...',
  tiers: {
    '1h':  '0.50',   // $0.50 for 1 hour
    '24h': '2.00',   // $2.00 for 24 hours
  },
  ratePerHour: '0.50',  // also accept custom durations
}));

app.get('/api/data', (req, res) => {
  // Only runs with a valid access pass
  res.json({ data: 'premium content' });
});
```

**Client (Node.js):**

```typescript
import { wrapFetch } from '@dexterai/x402/client';

const x402Fetch = wrapFetch(fetch, {
  walletPrivateKey: process.env.SOLANA_PRIVATE_KEY,
  accessPass: { preferTier: '1h', maxSpend: '1.00' },
});

// First call: auto-purchases a 1-hour pass ($0.50 USDC)
const res1 = await x402Fetch('https://api.example.com/api/data');

// All subsequent calls for the next hour: uses cached JWT, zero payment
const res2 = await x402Fetch('https://api.example.com/api/data');
const res3 = await x402Fetch('https://api.example.com/api/data');
```

**React:**

```tsx
import { useAccessPass } from '@dexterai/x402/react';

function Dashboard() {
  const { tiers, pass, isPassValid, purchasePass, fetch: apFetch } = useAccessPass({
    wallets: { solana: solanaWallet },
    resourceUrl: 'https://api.example.com',
  });

  return (
    <div>
      {!isPassValid && tiers?.map(t => (
        <button key={t.id} onClick={() => purchasePass(t.id)}>
          {t.label} — ${t.price}
        </button>
      ))}
      {isPassValid && <p>Pass active! {pass?.remainingSeconds}s remaining</p>}
      <button onClick={() => apFetch('/api/data')}>Fetch Data</button>
    </div>
  );
}
```

**How it works:**
1. Client requests a protected endpoint → Server returns `402` with `X-ACCESS-PASS-TIERS` header
2. Client selects a tier and pays via x402 → Server verifies, settles, issues a JWT
3. Server returns `200` with `ACCESS-PASS` header containing the JWT
4. Client caches the JWT and includes it as `Authorization: Bearer <token>` on all subsequent requests
5. Server validates the JWT locally (no facilitator call) → instant response

Options:
- `payTo` — Address to receive payments
- `tiers` — Named duration tiers with prices (e.g., `{ '1h': '0.50' }`)
- `ratePerHour` — Rate for custom durations (buyer sends `?duration=<seconds>`)
- `network` — CAIP-2 network (default: Solana mainnet)
- `secret` — HMAC secret for JWT signing (auto-generated if not provided)
- `facilitatorUrl` — Override facilitator (default: x402.dexter.cash)

**[Live demo →](https://dexter.cash/access-pass)**

---

### Manual Server (Advanced)

For more control over the payment flow:

```typescript
import { createX402Server } from '@dexterai/x402/server';

const server = createX402Server({
  payTo: 'YourAddress...',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
});

// In your route handler
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

  res.json({ data: 'Your protected content' });
});
```

---

## Dynamic Pricing

**Generic pricing for any use case** - charge by characters, bytes, API calls, or any unit you define. No external dependencies.

Works for:
- LLM/AI endpoints (by character count)
- Image processing (by pixel count or file size)
- Data APIs (by record count)
- Any service where cost scales with input

```typescript
import { createX402Server, createDynamicPricing } from '@dexterai/x402/server';

const server = createX402Server({ payTo: '...', network: '...' });
const pricing = createDynamicPricing({
  unitSize: 1000,      // chars per unit
  ratePerUnit: 0.01,   // $0.01 per unit
  minUsd: 0.01,        // floor
  maxUsd: 10.00,       // ceiling
});

app.post('/api/llm', async (req, res) => {
  const { prompt } = req.body;
  const paymentSig = req.headers['payment-signature'];

  if (!paymentSig) {
    const quote = pricing.calculate(prompt);
    const requirements = await server.buildRequirements({
      amountAtomic: quote.amountAtomic,
      resourceUrl: req.originalUrl,
    });
    res.setHeader('PAYMENT-REQUIRED', server.encodeRequirements(requirements));
    res.setHeader('X-Quote-Hash', quote.quoteHash);
    return res.status(402).json({ usdAmount: quote.usdAmount });
  }

  // Validate quote hasn't changed (prevents prompt manipulation)
  const quoteHash = req.headers['x-quote-hash'];
  if (!pricing.validateQuote(prompt, quoteHash)) {
    return res.status(400).json({ error: 'Prompt changed, re-quote required' });
  }

  const result = await server.settlePayment(paymentSig);
  if (!result.success) return res.status(402).json({ error: result.errorReason });

  const response = await runLLM(prompt);
  res.json(response);
});
```

The client SDK automatically forwards `X-Quote-Hash` on retry.

---

## Token Pricing (LLM-Accurate)

**Accurate token-based pricing for LLMs.** Uses tiktoken for token counting. Supports OpenAI models out of the box, plus custom rates for Anthropic, Gemini, Mistral, or any model.

```typescript
import { createX402Server, createTokenPricing, MODEL_PRICING } from '@dexterai/x402/server';

const server = createX402Server({ payTo: '...', network: '...' });
const pricing = createTokenPricing({
  model: 'gpt-4o-mini',  // Uses real OpenAI rates
  // minUsd: 0.001,      // Optional floor
  // maxUsd: 50.0,       // Optional ceiling
});

app.post('/api/chat', async (req, res) => {
  const { prompt, systemPrompt } = req.body;
  const paymentSig = req.headers['payment-signature'];

  if (!paymentSig) {
    const quote = pricing.calculate(prompt, systemPrompt);
    const requirements = await server.buildRequirements({
      amountAtomic: quote.amountAtomic,
      resourceUrl: req.originalUrl,
      description: `${quote.model}: ${quote.inputTokens.toLocaleString()} tokens`,
    });
    res.setHeader('PAYMENT-REQUIRED', server.encodeRequirements(requirements));
    res.setHeader('X-Quote-Hash', quote.quoteHash);
    return res.status(402).json({
      inputTokens: quote.inputTokens,
      usdAmount: quote.usdAmount,
      model: quote.model,
      tier: quote.tier,
    });
  }

  // Validate quote hasn't changed
  const quoteHash = req.headers['x-quote-hash'];
  if (!pricing.validateQuote(prompt, quoteHash)) {
    return res.status(400).json({ error: 'Prompt changed, re-quote required' });
  }

  const result = await server.settlePayment(paymentSig);
  if (!result.success) return res.status(402).json({ error: result.errorReason });

  const response = await openai.chat.completions.create({
    model: pricing.config.model,
    messages: [{ role: 'user', content: prompt }],
    max_completion_tokens: pricing.modelInfo.maxTokens,
  });

  res.json({ 
    response: response.choices[0].message.content,
    transaction: result.transaction,
  });
});
```

### Available Models

```typescript
import { MODEL_PRICING, getAvailableModels } from '@dexterai/x402/server';

// Get all models sorted by tier and price
const models = getAvailableModels();
// → [{ model: 'gpt-5-nano', inputRate: 0.05, tier: 'fast' }, ...]

// Check pricing for a specific model
MODEL_PRICING['gpt-4o-mini'];
// → { input: 0.15, output: 0.6, maxTokens: 4096, tier: 'fast' }
```

**Supported tiers:** `fast`, `standard`, `reasoning`, `premium`, `custom`

### Custom Models (Anthropic, Gemini, etc.)

Not using OpenAI? Pass your own rates:

```typescript
// Anthropic Claude
const pricing = createTokenPricing({
  model: 'claude-3-sonnet',
  inputRate: 3.0,    // $3.00 per 1M input tokens
  outputRate: 15.0,  // $15.00 per 1M output tokens
  maxTokens: 4096,
});

// Google Gemini
const pricing = createTokenPricing({
  model: 'gemini-1.5-pro',
  inputRate: 1.25,
  outputRate: 5.0,
});

// Custom/local model with custom tokenizer
const pricing = createTokenPricing({
  model: 'llama-3-70b',
  inputRate: 0.50,
  tokenizer: (text) => llamaTokenizer.encode(text).length,
});
```

tiktoken's default encoding works well for most transformer models. Only use a custom tokenizer if your model has significantly different tokenization.

---

## API Reference

### `createX402Client(options)`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `wallets` | `{ solana?, evm? }` | Yes | Multi-chain wallets |
| `wallet` | `SolanaWallet` | No | Single Solana wallet (legacy) |
| `preferredNetwork` | `string` | No | Prefer this network when multiple options available |
| `rpcUrls` | `Record<string, string>` | No | RPC endpoints per network (defaults to Dexter proxy) |
| `maxAmountAtomic` | `string` | No | Maximum payment cap |
| `verbose` | `boolean` | No | Enable debug logging |

### `x402AccessPass(options)`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `payTo` | `string` | Yes | Address to receive payments |
| `tiers` | `Record<string, string>` | One of `tiers` or `ratePerHour` | Named tiers (e.g., `{ '1h': '0.50' }`) |
| `ratePerHour` | `string` | One of `tiers` or `ratePerHour` | USD rate for custom durations |
| `network` | `string` | No | CAIP-2 network (default: Solana mainnet) |
| `secret` | `Buffer` | No | HMAC secret for JWT (auto-generated) |
| `facilitatorUrl` | `string` | No | Facilitator URL (default: x402.dexter.cash) |
| `verbose` | `boolean` | No | Enable debug logging |

### `useX402Payment(options)`

Returns:

| Property | Type | Description |
|----------|------|-------------|
| `fetch` | `function` | Payment-aware fetch |
| `isLoading` | `boolean` | Payment in progress |
| `status` | `string` | `'idle'` \| `'pending'` \| `'success'` \| `'error'` |
| `error` | `X402Error?` | Error details if failed |
| `transactionId` | `string?` | Transaction signature |
| `transactionUrl` | `string?` | Block explorer link |
| `balances` | `Balance[]` | Token balances per chain |
| `refreshBalances` | `function` | Manual refresh |
| `reset` | `function` | Clear state |
| `accessPass` | `object?` | Active pass state (tier, expiresAt, remainingSeconds) |

### `useAccessPass(options)`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `wallets` | `{ solana?, evm? }` | Yes | Multi-chain wallets |
| `resourceUrl` | `string` | Yes | The x402 resource base URL |
| `preferredNetwork` | `string` | No | Prefer this network |
| `autoConnect` | `boolean` | No | Auto-fetch tiers on mount (default: true) |

Returns:

| Property | Type | Description |
|----------|------|-------------|
| `tiers` | `AccessPassTier[]?` | Available tiers from server |
| `pass` | `object?` | Active pass (jwt, tier, expiresAt, remainingSeconds) |
| `isPassValid` | `boolean` | Whether pass is active and not expired |
| `purchasePass` | `function` | Buy a pass for a tier or custom duration |
| `isPurchasing` | `boolean` | Purchase in progress |
| `fetch` | `function` | Fetch with auto pass inclusion |

---

## Development

```bash
npm run build      # Build ESM + CJS
npm run dev        # Watch mode
npm run typecheck  # TypeScript checks
```

---

## License

MIT — see [LICENSE](./LICENSE)

---

<p align="center">
  <a href="https://x402.dexter.cash">Dexter Facilitator</a> · 
  <a href="https://dexter.cash/opendexter">OpenDexter Marketplace</a> · 
  <a href="https://dexter.cash/sdk">Live Demo</a> · 
  <a href="https://dexter.cash/access-pass">Access Pass Demo</a> · 
  <a href="https://dexter.cash/onboard">Become a Seller</a>
</p>
