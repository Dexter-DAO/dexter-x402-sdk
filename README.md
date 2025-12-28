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

**Phantom wallet support on Solana mainnet.** The Dexter facilitator is the only x402 facilitator that handles Phantom's Lighthouse safety assertions. Other facilitators fail silently or reject Phantom transactions on mainnet. This SDK uses the Dexter facilitator by default.

**Multi-chain.** Solana and Base with the same API. Add wallets for both chains and the SDK picks the right one based on what the server accepts.

**Built-in RPC.** Uses Dexter's RPC proxy by default—no need to configure Helius, QuickNode, or other providers. Just pass your wallet and go.

**Pre-flight balance check.** Shows "Insufficient USDC balance" *before* the wallet popup, not after a failed transaction.

**React hook included.** `useX402Payment` with loading states, balances, and transaction tracking.

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

```tsx
import { useX402Payment } from '@dexterai/x402/react';

function PayButton() {
  const { fetch, isLoading, balances, transactionUrl } = useX402Payment({
    wallets: { solana: solanaWallet, evm: evmWallet },
  });

  return (
    <div>
      <p>Balance: ${balances[0]?.balance.toFixed(2)}</p>
      <button onClick={() => fetch(url)} disabled={isLoading}>
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

> **Note:** The server SDK has not been battle-tested in production yet. The client SDK and React hook have been verified with real payments at [dexter.cash/sdk](https://dexter.cash/sdk).

---

## Dynamic Pricing

For LLM/AI endpoints where cost scales with input size:

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
