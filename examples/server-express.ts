/**
 * @dexter/x402-solana - Server Example (Express)
 * 
 * Demonstrates how to protect API endpoints with x402 payments.
 * Users pay USDC on Solana to access your API.
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
import { createX402Server, SOLANA_MAINNET_NETWORK, USDC_MINT } from '../src/server';

// ============================================================================
// Configuration
// ============================================================================

const PORT = process.env.PORT || 3000;
const PAY_TO = process.env.X402_PAY_TO;

if (!PAY_TO) {
  console.error('❌ Missing X402_PAY_TO environment variable');
  console.error('   Export your Solana wallet address to receive payments:');
  console.error('   export X402_PAY_TO="YourSolanaWalletAddress"');
  process.exit(1);
}

// ============================================================================
// x402 Server Setup
// ============================================================================

const x402 = createX402Server({
  // Dexter's public facilitator (handles fee sponsorship + settlement)
  facilitatorUrl: 'https://x402.dexter.cash',
  
  // Solana mainnet
  network: SOLANA_MAINNET_NETWORK,
  
  // Your wallet to receive payments
  payTo: PAY_TO,
  
  // USDC on Solana
  asset: { 
    mint: USDC_MINT, 
    decimals: 6 
  },
});

// ============================================================================
// Express App
// ============================================================================

const app = express();
app.use(express.json());

// Middleware to handle x402 payments
async function requirePayment(
  amount: string,
  description: string
) {
  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    // Check for payment signature
    const paymentSignature = req.headers['payment-signature'] as string;
    
    if (!paymentSignature) {
      // No payment - return 402 with requirements
      const requirements = await x402.buildRequirements({
        amountAtomic: amount,
        resourceUrl: req.originalUrl,
        description,
      });
      
      res.setHeader('PAYMENT-REQUIRED', x402.encodeRequirements(requirements));
      res.status(402).json({ 
        error: 'Payment required',
        amount: `$${(parseInt(amount) / 1_000_000).toFixed(2)} USDC`,
      });
      return;
    }
    
    // Verify and settle payment
    try {
      const verifyResult = await x402.verifyPayment(paymentSignature);
      
      if (!verifyResult.isValid) {
        res.status(402).json({ 
          error: 'Invalid payment',
          reason: verifyResult.invalidReason,
        });
        return;
      }
      
      const settleResult = await x402.settlePayment(paymentSignature);
      
      if (!settleResult.success) {
        res.status(402).json({ 
          error: 'Payment failed',
          reason: settleResult.errorReason,
        });
        return;
      }
      
      // Payment successful - attach tx to request for logging
      (req as any).paymentTx = settleResult.transaction;
      next();
      
    } catch (error: any) {
      console.error('Payment error:', error.message);
      res.status(500).json({ error: 'Payment processing failed' });
    }
  };
}

// ============================================================================
// Routes
// ============================================================================

// Free endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Paid endpoint - $0.05 USDC
app.post(
  '/api/premium',
  await requirePayment('50000', 'Premium API access'),
  (req, res) => {
    res.json({
      success: true,
      message: 'Thank you for your payment!',
      paymentTx: (req as any).paymentTx,
      data: {
        // Your premium content here
        secret: 'This is premium content only paying users can see.',
        timestamp: new Date().toISOString(),
      },
    });
  }
);

// Paid endpoint - $0.10 USDC
app.post(
  '/api/super-premium',
  await requirePayment('100000', 'Super Premium API access'),
  (req, res) => {
    res.json({
      success: true,
      message: 'Thank you for your premium payment!',
      paymentTx: (req as any).paymentTx,
      data: {
        secret: 'This is SUPER premium content!',
        timestamp: new Date().toISOString(),
      },
    });
  }
);

// ============================================================================
// Start Server
// ============================================================================

app.listen(PORT, () => {
  console.log('🚀 x402 Server Example');
  console.log('======================\n');
  console.log(`Receiving payments at: ${PAY_TO}`);
  console.log(`Server running at: http://localhost:${PORT}\n`);
  console.log('Endpoints:');
  console.log('  GET  /api/health        - Free (health check)');
  console.log('  POST /api/premium       - $0.05 USDC');
  console.log('  POST /api/super-premium - $0.10 USDC');
  console.log('\nTest with:');
  console.log(`  curl -X POST http://localhost:${PORT}/api/premium`);
});

