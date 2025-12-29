<p align="center">
  <img src="./assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/x402</h1>

<p align="center">
  <strong>x402 payments for Solana and Base. Works with Phantom.</strong>
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

x402 is a protocol for HTTP-native micropayments. When a server returns HTTP status `402 Payment Required`, it includes payment details in a `PAYMENT-REQUIRED` header. The client signs a payment transaction and retries the request with a `PAYMENT-SIGNATURE` header. The server verifies and settles the payment, then returns the protected content.

This SDK handles the entire flow automatically—you just call `fetch()` and payments happen transparently.

---

## Why This SDK?

**Monetize any API in minutes.** Add payments to your server in ~10 lines. Clients pay automatically—no checkout pages, no subscriptions, no invoices. Just HTTP.

**Dynamic pricing.** Charge based on usage: characters, tokens, records, pixels, API calls—whatever makes sense. Price scales with input, not fixed rates.

**Token-accurate LLM pricing.** Built-in [tiktoken](https://github.com/openai/tiktoken) support prices AI requests by actual token count. Works with OpenAI models out of the box, or bring your own rates for Anthropic, Gemini, Mistral, or local models.

**Full-stack.** Client SDK for browsers, server SDK for backends. React hooks, Express middleware patterns, facilitator client—everything you need.

**Multi-chain.** Solana and Base (Ethereum L2) with the same API. Add wallets for both and the SDK picks the right one automatically.

**Works out of the box.** Built-in RPC proxy, pre-flight balance checks, automatic retry on 402. Uses the [Dexter facilitator](https://x402.dexter.cash) by default—the only x402 facilitator with full Phantom wallet support on Solana mainnet.

---

## Quick Start

### Install

```bash
npm install @dexterai/x402
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

| Network | Identifier | Status |
|---------|------------|--------|
| Solana Mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Verified |
| Base Mainnet | `eip155:8453` | Verified |

All networks use USDC.

---

## Package Exports

```typescript
// Client - browser & Node.js
import { createX402Client } from '@dexterai/x402/client';

// React hook
import { useX402Payment } from '@dexterai/x402/react';

// Server helpers
import { createX402Server } from '@dexterai/x402/server';

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

*Client SDK, React hook, and pricing utilities are production-verified at [dexter.cash/sdk](https://dexter.cash/sdk). `createX402Server` is a convenience wrapper not yet used in production.*

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
  <a href="https://dexter.cash/sdk">Live Demo</a> · 
  <a href="https://dexter.cash/onboard">Become a Seller</a>
</p>
