<p align="center">
  <img src="https://dexter.cash/assets/logos/dexter-wordmark.svg" alt="Dexter wordmark" width="360">
</p>

<p align="center">
  <a href="https://nodejs.org/en/download"><img src="https://img.shields.io/badge/node-%3E=20-green.svg" alt="Node >= 20"></a>
  <a href="https://www.npmjs.com/package/@dexter/x402-solana"><img src="https://img.shields.io/badge/npm-%40dexter%2Fx402--solana-red.svg" alt="npm @dexter/x402-solana"></a>
  <a href="https://x402.dexter.cash"><img src="https://img.shields.io/badge/facilitator-x402.dexter.cash-orange.svg" alt="x402 Facilitator"></a>
</p>

<p align="center">
  <a href="https://github.com/BranchManager69/dexter-api">Dexter API</a>
  · <a href="https://github.com/BranchManager69/dexter-fe">Dexter FE</a>
  · <a href="https://github.com/BranchManager69/dexter-mcp">Dexter MCP</a>
  · <strong>Dexter x402 SDK</strong>
  · <a href="https://github.com/BranchManager69/dexter-ops">Dexter Ops</a>
</p>

Official SDK for integrating with Dexter's x402 v2 Solana payment protocol. Provides client-side auto-402 handling and server-side helpers for generating payment requirements and verifying settlements through the Dexter facilitator.

---

## Highlights

- **Zero-config client** – wrap your `fetch` calls; the SDK auto-handles 402 responses, signs transactions via wallet adapter, and retries with payment proof.
- **Server helpers** – generate correct `PAYMENT-REQUIRED` headers and verify/settle payments through the Dexter facilitator in one line.
- **v2 header-based flow** – uses `PAYMENT-REQUIRED` and `PAYMENT-SIGNATURE` headers (not legacy `X-PAYMENT`).
- **Solana-native** – builds proper `TransferChecked` transactions with ComputeBudget instructions that comply with Dexter's sponsored-fee policy.
- **Dual ESM/CJS** – ships both module formats with full TypeScript definitions.

---

## Quick Start

### Install

```bash
npm install @dexter/x402-solana @solana/web3.js @solana/spl-token
```

### Client (Browser/Node)

```typescript
import { createX402Client } from '@dexter/x402-solana/client';

const client = createX402Client({
  wallet,  // wallet adapter with signTransaction
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  verbose: true,
});

// Auto-handles 402s, signs payment, retries
const res = await client.fetch('https://api.dexter.cash/api/shield/create', {
  method: 'POST',
  body: JSON.stringify(payload),
});
```

### Server (Express/Next.js)

```typescript
import { createX402Server } from '@dexter/x402-solana/server';

const server = createX402Server({
  facilitatorUrl: 'https://x402.dexter.cash',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  payTo: 'YourWalletAddress...',
  asset: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
});

// Generate 402 response
const requirements = server.buildRequirements({
  amountAtomic: '50000',  // 0.05 USDC
  resourceUrl: '/api/protected',
});

res.setHeader('PAYMENT-REQUIRED', btoa(JSON.stringify(requirements)));
res.status(402).json({ error: 'Payment required' });
```

---

## API Surface

### Client

| Method | Description |
|--------|-------------|
| `createX402Client(config)` | Returns a client with a wrapped `fetch` that auto-handles 402 flows |

**Config options:**
- `wallet` – Solana wallet adapter with `publicKey` and `signTransaction`
- `network` – CAIP-2 network ID (e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`)
- `rpcUrl` – optional custom RPC endpoint
- `maxAmountAtomic` – optional payment cap in atomic units
- `fetch` – optional custom fetch implementation
- `verbose` – optional logging flag

### Server

| Method | Description |
|--------|-------------|
| `createX402Server(config)` | Returns helpers for building requirements and verifying payments |
| `.buildRequirements(params)` | Generates a valid `PaymentRequired` payload |

**Coming soon:**
- `.send402Response()` – helper to set headers and respond
- `.verifyPayment()` – validate payment signature via facilitator
- `.settlePayment()` – confirm settlement via facilitator

---

## Dexter Stack

| Repo | Role |
|------|------|
| [`dexter-api`](https://github.com/BranchManager69/dexter-api) | Issues realtime tokens, proxies MCP, x402 billing |
| [`dexter-fe`](https://github.com/BranchManager69/dexter-fe) | Next.js frontend for voice/chat surfaces |
| [`dexter-mcp`](https://github.com/BranchManager69/dexter-mcp) | Hosted MCP transport powering tool access |
| [`dexter-ops`](https://github.com/BranchManager69/dexter-ops) | Shared operations scripts, PM2 config, nginx templates |

---

## Development

```bash
npm run build    # Build ESM + CJS to dist/
npm run dev      # Watch mode
npm run lint     # ESLint
npm test         # Run tests (TODO)
```

---

## Resources

- [x402 v2 Migration Guide](https://docs.cdp.coinbase.com/x402/migration-guide)
- [Seller Onboarding](https://dexter.cash/onboard)
- [Facilitator Metrics](https://dexter.cash/facilitator)

---

## License

Private – internal Dexter SDK infrastructure.
