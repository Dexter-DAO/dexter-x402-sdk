/**
 * x402 v2 Spec Compliance Test
 *
 * Validates the SDK middleware against the x402 v2 protocol specification.
 * Tests BEFORE and AFTER fixes — all tests should FAIL before fixes and PASS after.
 *
 * Covers:
 *   A. 402 response includes `amount` field (not just `maxAmountRequired`)
 *   B. 200 response includes `PAYMENT-RESPONSE` header after settlement
 *   C. Facilitator requests include top-level `x402Version: 2`
 *   D. `PAYMENT-RESPONSE` header contains correct base64-encoded settlement data
 *
 * Run: npx tsx test/v2-spec-compliance.ts
 */

import express from 'express';
import http from 'http';
import { createX402Server } from '../src/server/x402-server';
import { x402Middleware } from '../src/server/middleware';
import { encodeBase64Json } from '../src/utils';

// ============================================================================
// Mock facilitator — captures requests and returns canned responses
// ============================================================================

interface CapturedRequest {
  path: string;
  body: Record<string, unknown>;
}

const capturedRequests: CapturedRequest[] = [];

function createMockFacilitator(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());

    // /supported — returns Solana mainnet with feePayer
    app.get('/supported', (_req, res) => {
      res.json({
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
            extra: {
              feePayer: 'MockFeePayerAddress1111111111111111111111111',
              decimals: 6,
            },
          },
        ],
      });
    });

    // /verify — always returns valid
    app.post('/verify', (req, res) => {
      capturedRequests.push({ path: '/verify', body: req.body });
      res.json({
        isValid: true,
        payer: 'MockPayerAddress1111111111111111111111111111',
      });
    });

    // /settle — always returns success with a mock tx signature
    app.post('/settle', (req, res) => {
      capturedRequests.push({ path: '/settle', body: req.body });
      res.json({
        success: true,
        transaction: '5xMockTransactionSignature1111111111111111111111111111111111111111111111111111111111111111',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        payer: 'MockPayerAddress1111111111111111111111111111',
      });
    });

    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

// ============================================================================
// Test seller server using SDK middleware
// ============================================================================

function createTestSeller(facilitatorPort: number): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());

    app.post(
      '/api/paid-resource',
      x402Middleware({
        payTo: 'SellerWalletAddress1111111111111111111111111111',
        amount: '0.01',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        facilitatorUrl: `http://127.0.0.1:${facilitatorPort}`,
        description: 'Test paid resource',
      }),
      (_req, res) => {
        res.json({ ok: true, data: 'premium content' });
      }
    );

    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

// ============================================================================
// Test runner
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

async function runTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  x402 v2 Spec Compliance Tests');
  console.log('═══════════════════════════════════════════════════════════\n');

  const results: TestResult[] = [];

  // Start mock facilitator
  const facilitator = await createMockFacilitator();
  console.log(`  Mock facilitator running on port ${facilitator.port}`);

  // Start test seller
  const seller = await createTestSeller(facilitator.port);
  console.log(`  Test seller running on port ${seller.port}\n`);

  const sellerBase = `http://127.0.0.1:${seller.port}`;

  // ──────────────────────────────────────────────────────────────────────
  // TEST A: 402 response includes `amount` field
  // ──────────────────────────────────────────────────────────────────────
  try {
    console.log('  [A] 402 response: `amount` field in accepts array');

    const res = await fetch(`${sellerBase}/api/paid-resource`, { method: 'POST' });

    if (res.status !== 402) {
      throw new Error(`Expected 402, got ${res.status}`);
    }

    const body = await res.json() as { accepts?: Array<{ amount?: string; maxAmountRequired?: string }> };
    const accept = body.accepts?.[0];

    if (!accept) {
      throw new Error('No accepts array in 402 body');
    }

    const hasAmount = typeof accept.amount === 'string' && accept.amount.length > 0;
    const hasMaxAmount = typeof accept.maxAmountRequired === 'string' && accept.maxAmountRequired.length > 0;

    if (!hasMaxAmount) {
      throw new Error('Missing maxAmountRequired (existing field)');
    }

    if (!hasAmount) {
      throw new Error(`Missing 'amount' field — only has maxAmountRequired: "${accept.maxAmountRequired}"`);
    }

    if (accept.amount !== accept.maxAmountRequired) {
      throw new Error(`amount (${accept.amount}) !== maxAmountRequired (${accept.maxAmountRequired})`);
    }

    results.push({ name: 'A: amount field in 402 accepts', passed: true, detail: `amount="${accept.amount}"` });
    console.log(`      PASS — amount="${accept.amount}", maxAmountRequired="${accept.maxAmountRequired}"\n`);
  } catch (e: any) {
    results.push({ name: 'A: amount field in 402 accepts', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  // Also check the PAYMENT-REQUIRED header
  try {
    console.log('  [A2] 402 response: `amount` field in PAYMENT-REQUIRED header');

    const res = await fetch(`${sellerBase}/api/paid-resource`, { method: 'POST' });
    const header = res.headers.get('PAYMENT-REQUIRED');

    if (!header) {
      throw new Error('No PAYMENT-REQUIRED header');
    }

    const decoded = JSON.parse(atob(header)) as {
      accepts?: Array<{ amount?: string; maxAmountRequired?: string }>;
    };
    const accept = decoded.accepts?.[0];

    if (!accept) {
      throw new Error('No accepts in decoded header');
    }

    const hasAmount = typeof accept.amount === 'string' && accept.amount.length > 0;

    if (!hasAmount) {
      throw new Error(`PAYMENT-REQUIRED header accepts missing 'amount' — only has maxAmountRequired: "${accept.maxAmountRequired}"`);
    }

    results.push({ name: 'A2: amount in PAYMENT-REQUIRED header', passed: true, detail: `amount="${accept.amount}"` });
    console.log(`      PASS — amount="${accept.amount}" in PAYMENT-REQUIRED header\n`);
  } catch (e: any) {
    results.push({ name: 'A2: amount in PAYMENT-REQUIRED header', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // TEST B: 200 response includes PAYMENT-RESPONSE header
  // ──────────────────────────────────────────────────────────────────────
  try {
    console.log('  [B] 200 response: PAYMENT-RESPONSE header after settlement');

    // Build a fake payment signature that the mock facilitator will accept
    const fakePaymentSig = encodeBase64Json({
      x402Version: 2,
      resource: { url: `${sellerBase}/api/paid-resource` },
      accepted: {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        maxAmountRequired: '10000',
        asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        payTo: 'SellerWalletAddress1111111111111111111111111111',
        maxTimeoutSeconds: 60,
        extra: { feePayer: 'MockFeePayerAddress1111111111111111111111111', decimals: 6 },
      },
      payload: { transaction: 'AAAA' },
    });

    const res = await fetch(`${sellerBase}/api/paid-resource`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': fakePaymentSig,
      },
    });

    if (res.status !== 200) {
      const text = await res.text();
      throw new Error(`Expected 200, got ${res.status}: ${text}`);
    }

    const paymentResponse = res.headers.get('PAYMENT-RESPONSE');

    if (!paymentResponse) {
      throw new Error('No PAYMENT-RESPONSE header on 200 response');
    }

    // Decode and validate structure
    let decoded: Record<string, unknown>;
    try {
      decoded = JSON.parse(atob(paymentResponse));
    } catch {
      throw new Error(`PAYMENT-RESPONSE header is not valid base64 JSON: "${paymentResponse.slice(0, 50)}..."`);
    }

    if (!decoded.success) {
      throw new Error(`PAYMENT-RESPONSE.success is not true: ${JSON.stringify(decoded)}`);
    }
    if (!decoded.transaction || typeof decoded.transaction !== 'string') {
      throw new Error(`PAYMENT-RESPONSE.transaction missing or not string: ${JSON.stringify(decoded)}`);
    }
    if (!decoded.network || typeof decoded.network !== 'string') {
      throw new Error(`PAYMENT-RESPONSE.network missing or not string: ${JSON.stringify(decoded)}`);
    }

    results.push({
      name: 'B: PAYMENT-RESPONSE header on 200',
      passed: true,
      detail: `tx="${(decoded.transaction as string).slice(0, 20)}..." network="${decoded.network}"`,
    });
    console.log(`      PASS — transaction="${(decoded.transaction as string).slice(0, 20)}...", network="${decoded.network}"\n`);
  } catch (e: any) {
    results.push({ name: 'B: PAYMENT-RESPONSE header on 200', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // TEST C: Facilitator requests include x402Version at top level
  // ──────────────────────────────────────────────────────────────────────
  try {
    console.log('  [C] Facilitator /verify request: top-level x402Version');

    const verifyReq = capturedRequests.find((r) => r.path === '/verify');
    if (!verifyReq) {
      throw new Error('No /verify request was captured (settlement may have failed)');
    }

    if (verifyReq.body.x402Version !== 2) {
      throw new Error(
        `Top-level x402Version missing or wrong. Body keys: [${Object.keys(verifyReq.body).join(', ')}], ` +
        `x402Version: ${JSON.stringify(verifyReq.body.x402Version)}`
      );
    }

    results.push({ name: 'C: x402Version in /verify body', passed: true, detail: `x402Version=${verifyReq.body.x402Version}` });
    console.log(`      PASS — x402Version=${verifyReq.body.x402Version}\n`);
  } catch (e: any) {
    results.push({ name: 'C: x402Version in /verify body', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  try {
    console.log('  [C2] Facilitator /settle request: top-level x402Version');

    const settleReq = capturedRequests.find((r) => r.path === '/settle');
    if (!settleReq) {
      throw new Error('No /settle request was captured');
    }

    if (settleReq.body.x402Version !== 2) {
      throw new Error(
        `Top-level x402Version missing or wrong. Body keys: [${Object.keys(settleReq.body).join(', ')}], ` +
        `x402Version: ${JSON.stringify(settleReq.body.x402Version)}`
      );
    }

    results.push({ name: 'C2: x402Version in /settle body', passed: true, detail: `x402Version=${settleReq.body.x402Version}` });
    console.log(`      PASS — x402Version=${settleReq.body.x402Version}\n`);
  } catch (e: any) {
    results.push({ name: 'C2: x402Version in /settle body', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // TEST D: Response body still works (non-regression)
  // ──────────────────────────────────────────────────────────────────────
  try {
    console.log('  [D] Response body: route handler content still delivered');

    const fakePaymentSig = encodeBase64Json({
      x402Version: 2,
      resource: { url: `${sellerBase}/api/paid-resource` },
      accepted: {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        maxAmountRequired: '10000',
        asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        payTo: 'SellerWalletAddress1111111111111111111111111111',
        maxTimeoutSeconds: 60,
        extra: { feePayer: 'MockFeePayerAddress1111111111111111111111111', decimals: 6 },
      },
      payload: { transaction: 'AAAA' },
    });

    const res = await fetch(`${sellerBase}/api/paid-resource`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': fakePaymentSig,
      },
    });

    const body = await res.json() as { ok?: boolean; data?: string };

    if (!body.ok || body.data !== 'premium content') {
      throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
    }

    results.push({ name: 'D: Response body intact', passed: true, detail: 'ok=true, data="premium content"' });
    console.log(`      PASS — body is correct\n`);
  } catch (e: any) {
    results.push({ name: 'D: Response body intact', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════\n');

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  for (const r of results) {
    const icon = r.passed ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${r.name}`);
    console.log(`         ${r.detail}`);
  }

  console.log(`\n  Total: ${passed} passed, ${failed} failed out of ${results.length}\n`);

  // Cleanup
  seller.server.close();
  facilitator.server.close();

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});
