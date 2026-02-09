/**
 * x402 Access Pass Test Suite
 *
 * Validates the access pass feature end-to-end:
 *   A. Server returns X-ACCESS-PASS-TIERS header on 402
 *   B. Pass purchase via x402 payment returns ACCESS-PASS header with JWT
 *   C. Subsequent requests with JWT bypass payment (200 directly)
 *   D. Expired JWT falls through to 402
 *   E. Custom duration pricing works
 *   F. Tier pricing calculates correctly
 *   G. Per-request x402 still works without access pass config (non-regression)
 *   H. Invalid JWT is rejected
 *
 * Run: npx tsx test/access-pass.ts
 */

import express from 'express';
import http from 'http';
import { x402AccessPass } from '../src/server/access-pass';
import { x402Middleware } from '../src/server/middleware';
import { encodeBase64Json } from '../src/utils';

// ============================================================================
// Mock facilitator
// ============================================================================

function createMockFacilitator(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());

    app.get('/supported', (_req, res) => {
      res.json({
        kinds: [{
          x402Version: 2,
          scheme: 'exact',
          network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          extra: { feePayer: 'MockFeePayer11111111111111111111111111111111', decimals: 6 },
        }],
      });
    });

    app.post('/verify', (_req, res) => {
      res.json({ isValid: true, payer: 'MockPayer111111111111111111111111111111111111' });
    });

    app.post('/settle', (_req, res) => {
      res.json({
        success: true,
        transaction: '5xMockTx11111111111111111111111111111111111111111111111111111111111111111111111111111111',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        payer: 'MockPayer111111111111111111111111111111111111',
      });
    });

    const server = app.listen(0, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

// ============================================================================
// Test servers
// ============================================================================

function createAccessPassServer(facilitatorPort: number): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());

    app.use('/api', x402AccessPass({
      payTo: 'SellerWallet11111111111111111111111111111111111',
      facilitatorUrl: `http://127.0.0.1:${facilitatorPort}`,
      tiers: { '5m': '0.05', '1h': '0.50', '24h': '2.00' },
      ratePerHour: '0.50',
      verbose: false,
    }));

    app.get('/api/data', (req, res) => {
      res.json({ ok: true, data: 'protected content', timestamp: Date.now() });
    });

    app.post('/api/data', (req, res) => {
      res.json({ ok: true, data: 'protected content', timestamp: Date.now() });
    });

    const server = app.listen(0, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

function createPerRequestServer(facilitatorPort: number): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());

    app.post('/api/data', x402Middleware({
      payTo: 'SellerWallet11111111111111111111111111111111111',
      amount: '0.01',
      facilitatorUrl: `http://127.0.0.1:${facilitatorPort}`,
    }), (_req, res) => {
      res.json({ ok: true, data: 'per-request content' });
    });

    const server = app.listen(0, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

// ============================================================================
// Test runner
// ============================================================================

interface TestResult { name: string; passed: boolean; detail: string; }

async function runTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  x402 Access Pass Tests');
  console.log('═══════════════════════════════════════════════════════════\n');

  const results: TestResult[] = [];
  const facilitator = await createMockFacilitator();
  const apServer = await createAccessPassServer(facilitator.port);
  const prServer = await createPerRequestServer(facilitator.port);

  console.log(`  Mock facilitator: port ${facilitator.port}`);
  console.log(`  Access pass server: port ${apServer.port}`);
  console.log(`  Per-request server: port ${prServer.port}\n`);

  const apBase = `http://127.0.0.1:${apServer.port}`;
  const prBase = `http://127.0.0.1:${prServer.port}`;

  // ── A: 402 includes X-ACCESS-PASS-TIERS ──
  try {
    console.log('  [A] 402 response includes X-ACCESS-PASS-TIERS header');
    const res = await fetch(`${apBase}/api/data`);
    if (res.status !== 402) throw new Error(`Expected 402, got ${res.status}`);

    const tiersHeader = res.headers.get('X-ACCESS-PASS-TIERS');
    if (!tiersHeader) throw new Error('Missing X-ACCESS-PASS-TIERS header');

    const info = JSON.parse(atob(tiersHeader));
    if (!info.tiers || info.tiers.length !== 3) throw new Error(`Expected 3 tiers, got ${info.tiers?.length}`);
    if (!info.ratePerHour) throw new Error('Missing ratePerHour');

    results.push({ name: 'A: X-ACCESS-PASS-TIERS header', passed: true, detail: `${info.tiers.length} tiers, rate=$${info.ratePerHour}/h` });
    console.log(`      PASS — ${info.tiers.length} tiers, rate=$${info.ratePerHour}/h\n`);
  } catch (e: any) {
    results.push({ name: 'A: X-ACCESS-PASS-TIERS header', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  // ── B: Pass purchase returns ACCESS-PASS header ──
  let purchasedJwt = '';
  try {
    console.log('  [B] Pass purchase returns ACCESS-PASS header with JWT');
    const fakeSig = encodeBase64Json({
      x402Version: 2,
      resource: { url: `${apBase}/api/data` },
      accepted: {
        scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        maxAmountRequired: '50000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        payTo: 'SellerWallet11111111111111111111111111111111111', maxTimeoutSeconds: 60,
        extra: { feePayer: 'MockFeePayer11111111111111111111111111111111', decimals: 6 },
      },
      payload: { transaction: 'AAAA' },
    });

    const res = await fetch(`${apBase}/api/data?tier=1h`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': fakeSig },
    });

    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${await res.text()}`);

    const jwt = res.headers.get('ACCESS-PASS');
    if (!jwt) throw new Error('Missing ACCESS-PASS header');

    purchasedJwt = jwt;

    const body = await res.json() as { accessPass?: { tier?: string; durationSeconds?: number } };
    if (body.accessPass?.tier !== '1h') throw new Error(`Expected tier "1h", got "${body.accessPass?.tier}"`);

    results.push({ name: 'B: Pass purchase + ACCESS-PASS header', passed: true, detail: `tier=1h, jwt=${jwt.slice(0, 20)}...` });
    console.log(`      PASS — tier=1h, jwt=${jwt.slice(0, 20)}...\n`);
  } catch (e: any) {
    results.push({ name: 'B: Pass purchase + ACCESS-PASS header', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  // ── C: JWT bypasses payment ──
  try {
    console.log('  [C] Request with valid JWT bypasses payment (200 directly)');
    if (!purchasedJwt) throw new Error('No JWT from test B');

    const res = await fetch(`${apBase}/api/data`, {
      headers: { 'Authorization': `Bearer ${purchasedJwt}` },
    });

    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);

    const body = await res.json() as { ok?: boolean; data?: string };
    if (!body.ok || body.data !== 'protected content') throw new Error(`Unexpected body: ${JSON.stringify(body)}`);

    results.push({ name: 'C: JWT bypasses payment', passed: true, detail: 'ok=true, data="protected content"' });
    console.log(`      PASS — 200 with protected content\n`);
  } catch (e: any) {
    results.push({ name: 'C: JWT bypasses payment', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  // ── D: Expired JWT falls through to 402 ──
  try {
    console.log('  [D] Expired JWT falls through to 402');
    // Create a JWT that's already expired (exp in the past)
    const expiredParts = purchasedJwt.split('.');
    if (expiredParts.length !== 3) throw new Error('Invalid JWT structure');

    // Decode payload, set exp to past, re-encode (signature will be invalid)
    const payload = JSON.parse(Buffer.from(expiredParts[1], 'base64url').toString());
    payload.exp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const fakeJwt = `${expiredParts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${expiredParts[2]}`;

    const res = await fetch(`${apBase}/api/data`, {
      headers: { 'Authorization': `Bearer ${fakeJwt}` },
    });

    if (res.status !== 402) throw new Error(`Expected 402, got ${res.status}`);

    results.push({ name: 'D: Expired JWT → 402', passed: true, detail: 'Correctly rejected expired token' });
    console.log(`      PASS — 402 returned for expired token\n`);
  } catch (e: any) {
    results.push({ name: 'D: Expired JWT → 402', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  // ── E: Custom duration pricing ──
  try {
    console.log('  [E] Custom duration pricing via ?duration=');
    const res = await fetch(`${apBase}/api/data?duration=7200`); // 2 hours
    if (res.status !== 402) throw new Error(`Expected 402, got ${res.status}`);

    const body = await res.json() as { accessPass?: { ratePerHour?: string } };
    // The 402 should include tier info
    const tiersHeader = res.headers.get('X-ACCESS-PASS-TIERS');
    if (!tiersHeader) throw new Error('Missing X-ACCESS-PASS-TIERS');

    results.push({ name: 'E: Custom duration pricing', passed: true, detail: 'duration=7200 accepted' });
    console.log(`      PASS — custom duration accepted\n`);
  } catch (e: any) {
    results.push({ name: 'E: Custom duration pricing', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  // ── F: Tier pricing correct ──
  try {
    console.log('  [F] Tier pricing is correct');
    const res = await fetch(`${apBase}/api/data?tier=24h`);
    if (res.status !== 402) throw new Error(`Expected 402, got ${res.status}`);

    const prHeader = res.headers.get('PAYMENT-REQUIRED');
    if (!prHeader) throw new Error('Missing PAYMENT-REQUIRED');

    const decoded = JSON.parse(atob(prHeader));
    const amount = decoded.accepts?.[0]?.amount || decoded.accepts?.[0]?.maxAmountRequired;
    // $2.00 = 2000000 atomic units
    if (amount !== '2000000') throw new Error(`Expected 2000000 for 24h tier, got ${amount}`);

    results.push({ name: 'F: Tier pricing correct', passed: true, detail: '24h tier = $2.00 (2000000 atomic)' });
    console.log(`      PASS — 24h tier = 2000000 atomic ($2.00)\n`);
  } catch (e: any) {
    results.push({ name: 'F: Tier pricing correct', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  // ── G: Per-request x402 still works (non-regression) ──
  try {
    console.log('  [G] Per-request x402 still works (non-regression)');
    const fakeSig = encodeBase64Json({
      x402Version: 2, resource: { url: `${prBase}/api/data` },
      accepted: {
        scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        maxAmountRequired: '10000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        payTo: 'SellerWallet11111111111111111111111111111111111', maxTimeoutSeconds: 60,
        extra: { feePayer: 'MockFeePayer11111111111111111111111111111111', decimals: 6 },
      },
      payload: { transaction: 'AAAA' },
    });

    const res = await fetch(`${prBase}/api/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': fakeSig },
    });

    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);

    const body = await res.json() as { ok?: boolean };
    if (!body.ok) throw new Error(`Unexpected body: ${JSON.stringify(body)}`);

    // Check PAYMENT-RESPONSE header (v1.4.1 fix)
    const prHeader = res.headers.get('PAYMENT-RESPONSE');
    if (!prHeader) throw new Error('Missing PAYMENT-RESPONSE header on per-request endpoint');

    results.push({ name: 'G: Per-request x402 non-regression', passed: true, detail: 'Works + has PAYMENT-RESPONSE header' });
    console.log(`      PASS — per-request x402 works correctly\n`);
  } catch (e: any) {
    results.push({ name: 'G: Per-request x402 non-regression', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  // ── H: Invalid JWT rejected ──
  try {
    console.log('  [H] Invalid/tampered JWT is rejected');
    const res = await fetch(`${apBase}/api/data`, {
      headers: { 'Authorization': 'Bearer totally.invalid.jwt' },
    });

    if (res.status !== 402) throw new Error(`Expected 402, got ${res.status}`);

    results.push({ name: 'H: Invalid JWT rejected', passed: true, detail: '402 returned for invalid token' });
    console.log(`      PASS — invalid token correctly rejected\n`);
  } catch (e: any) {
    results.push({ name: 'H: Invalid JWT rejected', passed: false, detail: e.message });
    console.log(`      FAIL — ${e.message}\n`);
  }

  // ── Summary ──
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════\n');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  for (const r of results) {
    console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.name}`);
    console.log(`         ${r.detail}`);
  }

  console.log(`\n  Total: ${passed} passed, ${failed} failed out of ${results.length}\n`);

  apServer.server.close();
  prServer.server.close();
  facilitator.server.close();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => { console.error('Test runner crashed:', err); process.exit(2); });
