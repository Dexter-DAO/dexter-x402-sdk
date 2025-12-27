/**
 * Integration Test: Chain-Agnostic SDK
 *
 * Tests:
 * 1. Facilitator client fetches /supported correctly
 * 2. Server builds correct payment requirements
 * 3. Adapters correctly identify networks
 * 4. Client finds matching payment options
 */

import { FacilitatorClient, createX402Server } from '../src/server';
import { createSolanaAdapter, createEvmAdapter, SOLANA_MAINNET, BASE_MAINNET } from '../src/adapters';

async function runTests() {
  console.log('🧪 Chain-Agnostic SDK Integration Tests\n');
  console.log('='.repeat(50));

  let passed = 0;
  let failed = 0;

  // Test 1: Facilitator client
  try {
    console.log('\n[1] Testing FacilitatorClient.getSupported()...');
    const client = new FacilitatorClient('https://x402.dexter.cash');
    const supported = await client.getSupported();

    if (!supported.kinds || !Array.isArray(supported.kinds)) {
      throw new Error('Invalid /supported response: missing kinds array');
    }

    const solanaKind = supported.kinds.find(k => k.network === SOLANA_MAINNET);
    if (!solanaKind) {
      throw new Error('No Solana mainnet support found');
    }
    if (!solanaKind.extra?.feePayer) {
      throw new Error('No feePayer for Solana');
    }

    console.log(`   ✅ Solana feePayer: ${solanaKind.extra.feePayer}`);

    const baseKind = supported.kinds.find(k => k.network === BASE_MAINNET);
    if (baseKind) {
      console.log(`   ✅ Base support found, feePayer: ${baseKind.extra?.feePayer}`);
    } else {
      console.log('   ⚠️  Base support not found (might be expected)');
    }

    passed++;
  } catch (error) {
    console.log(`   ❌ Failed: ${error}`);
    failed++;
  }

  // Test 2: Server builds requirements
  try {
    console.log('\n[2] Testing Server.buildRequirements()...');
    const server = createX402Server({
      payTo: 'TestWalletAddress123456789012345678901234567890',
      network: SOLANA_MAINNET,
    });

    const requirements = await server.buildRequirements({
      amountAtomic: '50000',
      resourceUrl: '/test',
      description: 'Test resource',
    });

    if (requirements.x402Version !== 2) {
      throw new Error(`Wrong x402Version: ${requirements.x402Version}`);
    }
    if (!requirements.accepts || requirements.accepts.length === 0) {
      throw new Error('No accepts in requirements');
    }

    const accept = requirements.accepts[0];
    if (accept.amount !== '50000') {
      throw new Error(`Wrong amount: ${accept.amount}`);
    }
    if (!accept.extra?.feePayer) {
      throw new Error('No feePayer in extra');
    }

    console.log(`   ✅ Requirements built correctly`);
    console.log(`      Amount: ${accept.amount}, FeePayer: ${accept.extra.feePayer.slice(0, 20)}...`);
    passed++;
  } catch (error) {
    console.log(`   ❌ Failed: ${error}`);
    failed++;
  }

  // Test 3: Adapters identify networks
  try {
    console.log('\n[3] Testing Adapter.canHandle()...');
    const solanaAdapter = createSolanaAdapter();
    const evmAdapter = createEvmAdapter();

    // Solana adapter
    if (!solanaAdapter.canHandle(SOLANA_MAINNET)) {
      throw new Error('Solana adapter should handle SOLANA_MAINNET');
    }
    if (!solanaAdapter.canHandle('solana')) {
      throw new Error('Solana adapter should handle legacy "solana"');
    }
    if (solanaAdapter.canHandle(BASE_MAINNET)) {
      throw new Error('Solana adapter should NOT handle BASE_MAINNET');
    }

    console.log('   ✅ SolanaAdapter correctly identifies networks');

    // EVM adapter
    if (!evmAdapter.canHandle(BASE_MAINNET)) {
      throw new Error('EVM adapter should handle BASE_MAINNET');
    }
    if (!evmAdapter.canHandle('eip155:1')) {
      throw new Error('EVM adapter should handle Ethereum mainnet');
    }
    if (!evmAdapter.canHandle('base')) {
      throw new Error('EVM adapter should handle legacy "base"');
    }
    if (evmAdapter.canHandle(SOLANA_MAINNET)) {
      throw new Error('EVM adapter should NOT handle SOLANA_MAINNET');
    }

    console.log('   ✅ EvmAdapter correctly identifies networks');
    passed++;
  } catch (error) {
    console.log(`   ❌ Failed: ${error}`);
    failed++;
  }

  // Test 4: Encoding/decoding
  try {
    console.log('\n[4] Testing encodeRequirements()...');
    const server = createX402Server({
      payTo: 'TestWalletAddress123456789012345678901234567890',
      network: SOLANA_MAINNET,
    });

    const requirements = await server.buildRequirements({
      amountAtomic: '30000',
      resourceUrl: '/api/test',
    });

    const encoded = server.encodeRequirements(requirements);
    const decoded = JSON.parse(atob(encoded));

    if (decoded.x402Version !== 2) {
      throw new Error('Decoded x402Version wrong');
    }
    if (decoded.accepts[0].amount !== '30000') {
      throw new Error('Decoded amount wrong');
    }

    console.log('   ✅ Encoding/decoding works correctly');
    passed++;
  } catch (error) {
    console.log(`   ❌ Failed: ${error}`);
    failed++;
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(console.error);
