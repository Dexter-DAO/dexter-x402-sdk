<p align="center">
  <img src="./assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/x402</h1>

<p align="center">
  <strong>The x402 SDK that actually works.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/x402"><img src="https://img.shields.io/npm/v/@dexterai/x402.svg" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E=18-brightgreen.svg" alt="Node"></a>
  <a href="https://dexter.cash/sdk"><img src="https://img.shields.io/badge/🎮_Live_Demo-dexter.cash%2Fsdk-blueviolet" alt="Live Demo"></a>
</p>

<p align="center">
  <a href="https://dexter.cash/sdk"><strong>👉 Try it with real payments →</strong></a>
</p>

---

## ✨ Why This SDK?

- **🔗 Multi-chain** — Solana and Base, same API
- **⚡ x402 v2** — Full protocol support, verified working
- **⚛️ React Hook** — `useX402Payment` with loading states, balances, and transaction tracking
- **💰 Smart Balance Check** — Clear "insufficient funds" error *before* the wallet popup
- **👻 Phantom Compatible** — Handles Lighthouse safety assertions automatically
- **📦 Zero Config** — Wrap `fetch()`, payments just work

---

## 🎮 See It Working

**Don't take our word for it.** Make a real payment yourself:

**[→ dexter.cash/sdk](https://dexter.cash/sdk)**

The demo uses this exact SDK. Solana and Base. Real USDC. Real transactions.

---

## 🚀 Quick Start

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
  rpcUrls: {
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'https://your-solana-rpc.com',
    'eip155:8453': 'https://your-base-rpc.com',
  },
});

// That's it. 402 responses are handled automatically.
const response = await client.fetch('https://api.example.com/protected');
```

### React

```tsx
import { useX402Payment } from '@dexterai/x402/react';

function PayButton() {
  const { fetch, isLoading, balances, transactionUrl } = useX402Payment({
    wallets: { solana: solanaWallet, evm: evmWallet },
    rpcUrls: { /* your RPC endpoints */ },
  });

  return (
    <div>
      <p>Balance: ${balances[0]?.balance.toFixed(2)}</p>
      <button onClick={() => fetch(url)} disabled={isLoading}>
        {isLoading ? 'Paying...' : 'Pay'}
      </button>
      {transactionUrl && <a href={transactionUrl}>View Transaction ↗</a>}
    </div>
  );
}
```

---

## 🌐 Supported Networks

| Network | Identifier | Status |
|---------|------------|--------|
| Solana Mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | ✅ Verified |
| Base Mainnet | `eip155:8453` | ✅ Verified |

All networks use USDC.

---

## 📦 Package Exports

```typescript
// Client - browser & Node.js
import { createX402Client } from '@dexterai/x402/client';

// React hook
import { useX402Payment } from '@dexterai/x402/react';

// Server helpers (see note below)
import { createX402Server } from '@dexterai/x402/server';

// Chain adapters (advanced)
import { createSolanaAdapter, createEvmAdapter } from '@dexterai/x402/adapters';

// Utilities
import { toAtomicUnits, fromAtomicUnits } from '@dexterai/x402/utils';
```

---

## 🛠️ Utilities

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

## 🖥️ Server SDK

```typescript
import { createX402Server } from '@dexterai/x402/server';

const server = createX402Server({
  payTo: 'YourAddress...',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  facilitatorUrl: 'https://x402.dexter.cash',
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

> ⚠️ **Note:** The server SDK has not been battle-tested in production yet. The client SDK and React hook have been verified with real payments at [dexter.cash/sdk](https://dexter.cash/sdk).

---

## 💸 Dynamic Pricing

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

## 📋 API Reference

### `createX402Client(options)`

| Option | Type | Description |
|--------|------|-------------|
| `wallet` | `SolanaWallet` | Single Solana wallet (legacy) |
| `wallets` | `{ solana?, evm? }` | Multi-chain wallets |
| `preferredNetwork` | `string` | Prefer this network when multiple options available |
| `rpcUrls` | `Record<string, string>` | RPC endpoints per network (CAIP-2 format) |
| `maxAmountAtomic` | `string` | Maximum payment cap |
| `verbose` | `boolean` | Enable debug logging |

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

## 🔧 Development

```bash
npm run build      # Build ESM + CJS
npm run dev        # Watch mode
npm run typecheck  # TypeScript
npm test           # Run tests
```

---

## 📄 License

MIT — see [LICENSE](./LICENSE)

---

<p align="center">
  <a href="https://x402.dexter.cash">Dexter Facilitator</a> · 
  <a href="https://dexter.cash/sdk">Live Demo</a> · 
  <a href="https://dexter.cash/onboard">Become a Seller</a>
</p>
