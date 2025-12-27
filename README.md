<p align="center">
  <img src="./assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

# @dexterai/x402

<p align="center">
  <a href="https://nodejs.org/en/download"><img src="https://img.shields.io/badge/node-%3E=18-green.svg" alt="Node >= 18"></a>
  <a href="https://www.npmjs.com/package/@dexterai/x402"><img src="https://img.shields.io/npm/v/@dexterai/x402.svg" alt="npm version"></a>
  <a href="https://x402.dexter.cash"><img src="https://img.shields.io/badge/facilitator-x402.dexter.cash-orange.svg" alt="x402 Facilitator"></a>
</p>

Chain-agnostic SDK for x402 v2 payments. Works with **Solana**, **Base**, and any x402-compatible network.

---

## Highlights

- **Chain-agnostic** – pay on Solana, Base, or any supported chain
- **Zero-config client** – wrap `fetch`, auto-handles 402 responses
- **Server helpers** – generate requirements, verify & settle payments
- **React hook** – multi-wallet support with balance tracking
- **Dual ESM/CJS** – full TypeScript definitions

---

## Quick Start

### Install

```bash
npm install @dexterai/x402 @solana/web3.js @solana/spl-token
```

### Client (Browser/Node)

```typescript
import { createX402Client } from '@dexterai/x402/client';

// Single wallet (Solana)
const client = createX402Client({
  wallet: solanaWallet,
});

// Multi-chain: provide wallets for each chain
const client = createX402Client({
  wallets: {
    solana: solanaWallet,
    evm: evmWallet,  // from wagmi, viem, etc.
  },
  preferredNetwork: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
});

// Automatically handles 402 responses
const response = await client.fetch('https://api.example.com/protected');
```

### Server (Express/Next.js)

```typescript
import { createX402Server } from '@dexterai/x402/server';

// Create server for Solana payments
const server = createX402Server({
  payTo: 'YourSolanaAddress...',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
});

// Or for Base payments
const baseServer = createX402Server({
  payTo: '0xYourEvmAddress...',
  network: 'eip155:8453',
  asset: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
});

// In your route handler
app.post('/protected', async (req, res) => {
  const paymentSig = req.headers['payment-signature'];

  if (!paymentSig) {
    const requirements = await server.buildRequirements({
      amountAtomic: '50000',  // 0.05 USDC
      resourceUrl: req.originalUrl,
    });
    res.setHeader('PAYMENT-REQUIRED', server.encodeRequirements(requirements));
    return res.status(402).json({});
  }

  const result = await server.settlePayment(paymentSig);
  if (!result.success) {
    return res.status(402).json({ error: result.errorReason });
  }

  res.json({ data: 'protected content', transaction: result.transaction });
});
```

### React

```tsx
import { useX402Payment } from '@dexterai/x402/react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';

function PayButton() {
  const solanaWallet = useWallet();
  const evmWallet = useAccount();

  const {
    fetch,
    isLoading,
    balances,
    connectedChains,
    transactionUrl,
  } = useX402Payment({
    wallets: {
      solana: solanaWallet,
      evm: evmWallet,
    },
  });

  return (
    <div>
      {balances.map(b => (
        <p key={b.network}>{b.chainName}: ${b.balance.toFixed(2)}</p>
      ))}
      <button onClick={() => fetch(url)} disabled={isLoading}>
        {isLoading ? 'Paying...' : 'Pay $0.05'}
      </button>
      {transactionUrl && <a href={transactionUrl}>View Transaction</a>}
    </div>
  );
}
```

---

## Supported Networks

| Network | CAIP-2 ID | Asset |
|---------|-----------|-------|
| Solana Mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | USDC |
| Base Mainnet | `eip155:8453` | USDC |
| Arbitrum One | `eip155:42161` | USDC |
| Ethereum | `eip155:1` | USDC |

---

## API

### Client

```typescript
import { createX402Client } from '@dexterai/x402/client';

const client = createX402Client({
  wallets: { solana, evm },     // Multi-chain wallets
  wallet: solanaWallet,          // Legacy: single wallet
  preferredNetwork: '...',       // Prefer this network
  rpcUrls: { 'eip155:8453': 'https://...' },  // Custom RPCs
  maxAmountAtomic: '100000',     // Payment cap
  verbose: true,                 // Debug logging
});

const response = await client.fetch(url, init);
```

### Server

```typescript
import { createX402Server } from '@dexterai/x402/server';

const server = createX402Server({
  payTo: 'address',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  asset: { address: 'mint', decimals: 6 },
  facilitatorUrl: 'https://x402.dexter.cash',
  defaultTimeoutSeconds: 60,
});

await server.buildRequirements({ amountAtomic, resourceUrl });
server.encodeRequirements(requirements);
await server.verifyPayment(header);
await server.settlePayment(header);
```

### React Hook

```typescript
import { useX402Payment } from '@dexterai/x402/react';

const {
  fetch,              // Payment-aware fetch
  isLoading,          // Payment in progress
  status,             // 'idle' | 'pending' | 'success' | 'error'
  error,              // Error if failed
  transactionId,      // Tx signature on success
  transactionUrl,     // Explorer link
  balances,           // Token balances per chain
  connectedChains,    // { solana: bool, evm: bool }
  reset,              // Clear state
  refreshBalances,    // Manual balance refresh
} = useX402Payment({ wallets, preferredNetwork, verbose });
```

### Adapters (Advanced)

```typescript
import {
  createSolanaAdapter,
  createEvmAdapter,
  SOLANA_MAINNET,
  BASE_MAINNET,
} from '@dexterai/x402/adapters';

const adapters = [
  createSolanaAdapter({ verbose: true }),
  createEvmAdapter({ rpcUrls: { 'eip155:8453': '...' } }),
];

// Find adapter for a network
const adapter = adapters.find(a => a.canHandle('eip155:8453'));

// Build transaction manually
const signedTx = await adapter.buildTransaction(accept, wallet);

// Check balance
const balance = await adapter.getBalance(accept, wallet);
```

---

## Development

```bash
npm run build      # Build ESM + CJS
npm run dev        # Watch mode
npm run typecheck  # TypeScript checks
npm test           # Run tests
```

---

## Resources

- [Dexter Facilitator](https://x402.dexter.cash)
- [x402 Protocol Spec](https://docs.cdp.coinbase.com/x402)
- [Seller Onboarding](https://dexter.cash/onboard)

---

## License

MIT – see [LICENSE](./LICENSE)
