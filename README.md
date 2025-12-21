# @dexter/x402-solana

Dexter's x402 v2 SDK for Solana payments. Make and accept machine-to-machine payments with one line of code.

## What is x402?

x402 is a protocol for HTTP-native payments. When a server responds with `402 Payment Required`, the client automatically pays and retries. No checkout flows, no API keys, no accounts.

Dexter runs a public x402 v2 facilitator at `https://x402.dexter.cash`.

## Installation

```bash
npm install @dexter/x402-solana
```

## Quick Start (Client)

Make paid API requests with automatic 402 handling:

```ts
import { createX402Client } from '@dexter/x402-solana/client';

const client = createX402Client({
  wallet, // any @solana/wallet-adapter compatible wallet
});

// This automatically handles 402 responses:
// 1. Server returns 402 with PAYMENT-REQUIRED header
// 2. SDK builds + signs a USDC transfer
// 3. SDK retries with PAYMENT-SIGNATURE header
// 4. You get the response
const response = await client.fetch('https://api.dexter.cash/api/shield/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'Hello world' }),
});
```

### Client Options

```ts
createX402Client({
  wallet,                    // Required: wallet with signTransaction
  network: 'solana:5eykt...', // Optional: CAIP-2 network (defaults to mainnet)
  rpcUrl: 'https://...',     // Optional: custom RPC
  maxAmountAtomic: '100000', // Optional: cap payments (in atomic units)
  fetch: customFetch,        // Optional: custom fetch for proxies
  verbose: true,             // Optional: debug logging
});
```

## Quick Start (Server)

Accept x402 payments in your Express/Node server:

```ts
import { createX402Server } from '@dexter/x402-solana/server';

const x402 = createX402Server({
  payTo: 'YourSolanaWalletAddress',
});

app.post('/api/premium', async (req, res) => {
  // Check for payment
  const paymentHeader = req.headers['payment-signature'];
  
  if (!paymentHeader) {
    // No payment — return 402
    const requirements = x402.buildRequirements({
      amountAtomic: '50000', // 0.05 USDC
      resourceUrl: 'https://yourapi.com/api/premium',
      description: 'Premium API access',
    });
    
    res.status(402)
      .set('PAYMENT-REQUIRED', x402.encodeRequirements(requirements))
      .json({});
    return;
  }

  // Verify + settle payment
  const settled = await x402.settlePayment(paymentHeader);
  if (!settled.success) {
    return res.status(402).json({ error: 'Payment failed' });
  }

  // Payment confirmed — serve the response
  res.json({ data: 'premium content' });
});
```

### Server Options

```ts
createX402Server({
  payTo: 'YourWallet',                      // Required: where USDC lands
  facilitatorUrl: 'https://x402.dexter.cash', // Optional: facilitator URL
  network: 'solana:5eykt...',               // Optional: CAIP-2 network
  asset: { mint: 'EPjFW...', decimals: 6 }, // Optional: defaults to USDC
  defaultTimeoutSeconds: 60,                // Optional: payment timeout
});
```

## Protocol Details

### Headers

| Header | Direction | Purpose |
|--------|-----------|---------|
| `PAYMENT-REQUIRED` | Server → Client | Base64-encoded payment requirements |
| `PAYMENT-SIGNATURE` | Client → Server | Base64-encoded signed transaction |
| `PAYMENT-RESPONSE` | Server → Client | Settlement confirmation |

### PaymentRequired Structure

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/endpoint",
    "description": "API access",
    "mimeType": "application/json"
  },
  "accepts": [{
    "scheme": "exact",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "amount": "50000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "payTo": "SellerWalletAddress",
    "maxTimeoutSeconds": 60,
    "extra": {
      "feePayer": "FacilitatorAddress",
      "decimals": 6
    }
  }]
}
```

## Links

- [Dexter Facilitator](https://dexter.cash/facilitator)
- [Seller Onboarding](https://dexter.cash/onboard)
- [x402 v2 Migration Guide](https://docs.cdp.coinbase.com/x402/migration-guide)

## License

MIT

