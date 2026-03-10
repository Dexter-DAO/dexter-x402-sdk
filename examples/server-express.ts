/**
 * @dexterai/x402 - Server Example (Express)
 *
 * Demonstrates how to protect API endpoints with x402 payments.
 * Users pay USDC on Solana (or Base) to access your API.
 *
 * Setup:
 *   export X402_PAY_TO="YourSolanaWalletAddress"
 *
 * Run:
 *   npx tsx examples/server-express.ts
 *
 * Test:
 *   curl http://localhost:3000/api/premium
 *   # Returns 402 with PAYMENT-REQUIRED header
 */

import express from 'express';
import { x402Middleware } from '../src/server';

// ============================================================================
// Configuration
// ============================================================================

const PORT = process.env.PORT || 3000;
const PAY_TO = process.env.X402_PAY_TO;

if (!PAY_TO) {
  console.error('Missing X402_PAY_TO environment variable');
  console.error('   Export your Solana wallet address to receive payments:');
  console.error('   export X402_PAY_TO="YourSolanaWalletAddress"');
  process.exit(1);
}

// ============================================================================
// Express App
// ============================================================================

const app = express();
app.use(express.json());

// Free endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Paid endpoint - $0.01 USDC (one-liner protection)
app.get('/api/basic',
  x402Middleware({ payTo: PAY_TO, amount: '0.01', description: 'Basic API access' }),
  (req, res) => {
    res.json({ data: 'Basic content', transaction: (req as any).x402?.transaction });
  }
);

// Paid endpoint - $0.05 USDC
app.post('/api/premium',
  x402Middleware({ payTo: PAY_TO, amount: '0.05', description: 'Premium API access' }),
  (req, res) => {
    res.json({ data: 'Premium content', transaction: (req as any).x402?.transaction });
  }
);

// Multi-chain endpoint - accept on Solana + Base + Polygon
app.get('/api/multi-chain',
  x402Middleware({
    payTo: PAY_TO,
    amount: '0.01',
    network: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'eip155:8453', 'eip155:137'],
    description: 'Multi-chain API access',
  }),
  (req, res) => {
    res.json({ data: 'Paid on any chain', network: (req as any).x402?.network });
  }
);

// ============================================================================
// Start Server
// ============================================================================

app.listen(PORT, () => {
  console.log(`@dexterai/x402 Server Example`);
  console.log(`Receiving payments at: ${PAY_TO}`);
  console.log(`Server running at: http://localhost:${PORT}\n`);
  console.log('Endpoints:');
  console.log('  GET  /api/health       - Free');
  console.log('  GET  /api/basic        - $0.01 USDC');
  console.log('  POST /api/premium      - $0.05 USDC');
  console.log('  GET  /api/multi-chain  - $0.01 USDC (Solana/Base/Polygon)');
  console.log(`\nTest: curl http://localhost:${PORT}/api/basic`);
});
