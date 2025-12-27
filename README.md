<p align="center">
  <img src="./assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

# @dexterai/x402-solana

<p align="center">
  <a href="https://nodejs.org/en/download"><img src="https://img.shields.io/badge/node-%3E=18-green.svg" alt="Node >= 18"></a>
  <a href="https://www.npmjs.com/package/@dexterai/x402-solana"><img src="https://img.shields.io/npm/v/@dexterai/x402-solana.svg" alt="npm version"></a>
  <a href="https://x402.dexter.cash"><img src="https://img.shields.io/badge/facilitator-x402.dexter.cash-orange.svg" alt="x402 Facilitator"></a>
</p>

Official SDK for integrating with Dexter's x402 v2 Solana payment protocol. Provides client-side auto-402 handling and server-side helpers for generating payment requirements and verifying settlements through the Dexter facilitator.

---

## Highlights

- **Zero-config client** – wrap your `fetch` calls; the SDK auto-handles 402 responses, signs transactions via wallet adapter, and retries with payment proof.
- **React hook** – `useX402Payment` with balance tracking, wallet status, and transaction URLs.
- **Server helpers** – generate correct `PAYMENT-REQUIRED` headers and verify/settle payments through the Dexter facilitator in one line.
- **v2-native** – uses `PAYMENT-REQUIRED` and `PAYMENT-SIGNATURE` headers. If you want v1, use a different SDK.
- **Solana-native** – builds proper `TransferChecked` transactions with ComputeBudget instructions that comply with Dexter's sponsored-fee policy.
- **Dual ESM/CJS** – ships both module formats with full TypeScript definitions.

---

## Quick Start

### Install

```bash
npm install @dexterai/x402-solana @solana/web3.js @solana/spl-token
```

### Client (Browser/Node)

```typescript
import { createX402Client } from '@dexterai/x402-solana/client';

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
import { createX402Server } from '@dexterai/x402-solana/server';

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

### React

```tsx
import { useX402Payment } from '@dexterai/x402-solana/react';
import { useWallet } from '@solana/wallet-adapter-react';

function PayButton() {
  const wallet = useWallet();
  const {
    fetch,
    isLoading,
    balance,
    transactionUrl,
    isWalletConnected,
  } = useX402Payment({ wallet });

  const handlePay = async () => {
    const response = await fetch('https://api.example.com/paid-endpoint');
    const data = await response.json();
    console.log('Paid!', data);
  };

  if (!isWalletConnected) return <p>Connect wallet first</p>;

  return (
    <div>
      <p>Balance: ${balance?.toFixed(2) ?? '...'} USDC</p>
      <button onClick={handlePay} disabled={isLoading}>
        {isLoading ? 'Paying...' : 'Pay'}
      </button>
      {transactionUrl && <a href={transactionUrl}>View Transaction</a>}
    </div>
  );
}
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
| `.buildRequirements(opts)` | Generates a valid `PaymentRequired` payload |
| `.encodeRequirements(req)` | Base64-encodes for the `PAYMENT-REQUIRED` header |
| `.verifyPayment(header)` | Validates payment signature via facilitator |
| `.settlePayment(header)` | Confirms settlement via facilitator, returns tx signature |

### React

| Export | Description |
|--------|-------------|
| `useX402Payment(config)` | React hook with payment state management |

**Hook returns:**
- `fetch` – wrapped fetch that handles x402 v2 payments
- `isLoading` – payment in progress
- `status` – `'idle'` | `'pending'` | `'success'` | `'error'`
- `error` – last error
- `transactionId` – tx signature after success
- `transactionUrl` – Orb Markets link to view tx
- `balance` – USDC balance in human units (e.g., `12.50`)
- `isWalletConnected` – wallet ready
- `refreshBalance()` – manually refresh balance
- `reset()` – reset state to idle

---

## Development

```bash
npm run build      # Build ESM + CJS to dist/
npm run dev        # Watch mode
npm run typecheck  # TypeScript type checking
npm test           # Run tests
```

---

## Resources

- [x402 v2 Migration Guide](https://docs.cdp.coinbase.com/x402/migration-guide)
- [Seller Onboarding](https://dexter.cash/onboard)
- [Facilitator Metrics](https://dexter.cash/facilitator)

---

## License

MIT – see [LICENSE](./LICENSE) for details.
