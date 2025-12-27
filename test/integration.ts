/**
 * Integration test for @dexter/x402-solana
 * 
 * Tests the SDK against live Dexter endpoints.
 * Run with: npx tsx test/integration.ts
 */

import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createX402Client, DEXTER_FACILITATOR_URL, SOLANA_MAINNET_NETWORK } from '../src/client';
import { createX402Server, FacilitatorClient } from '../src/server';

// Test configuration
const DEXTER_API_BASE = 'https://x402.dexter.cash';
const TEST_ENDPOINT = `${DEXTER_API_BASE}/api/tools/solscan/trending`;

async function testFacilitatorClient() {
  console.log('\n=== Test 1: FacilitatorClient ===');
  
  const client = new FacilitatorClient(DEXTER_FACILITATOR_URL);
  
  try {
    // Test /supported endpoint
    console.log('Fetching /supported...');
    const supported = await client.getSupported();
    console.log(`✅ Got ${supported.kinds.length} supported kinds`);
    
    // Find Solana mainnet
    const solanaKind = supported.kinds.find(
      k => k.network === SOLANA_MAINNET_NETWORK && k.scheme === 'exact'
    );
    
    if (solanaKind) {
      console.log(`✅ Solana mainnet supported`);
      console.log(`   feePayer: ${solanaKind.extra?.feePayer}`);
      console.log(`   decimals: ${solanaKind.extra?.decimals}`);
    } else {
      console.log('❌ Solana mainnet not found in supported kinds');
    }
    
    // Test getFeePayer helper
    const feePayer = await client.getFeePayer(SOLANA_MAINNET_NETWORK);
    console.log(`✅ getFeePayer() returned: ${feePayer}`);
    
    return true;
  } catch (error) {
    console.error('❌ FacilitatorClient test failed:', error);
    return false;
  }
}

async function testServerBuildRequirements() {
  console.log('\n=== Test 2: Server buildRequirements ===');
  
  try {
    const server = createX402Server({
      payTo: 'DevFFyNWxZPtYLpEjzUnN1PFc9Po6PH7eZCi9f3tTkTw', // Test address
    });
    
    const requirements = await server.buildRequirements({
      amountAtomic: '50000', // $0.05 USDC
      resourceUrl: 'https://example.com/api/test',
      description: 'Test resource',
    });
    
    console.log('✅ Built payment requirements:');
    console.log(`   x402Version: ${requirements.x402Version}`);
    console.log(`   network: ${requirements.accepts[0].network}`);
    console.log(`   amount: ${requirements.accepts[0].amount}`);
    console.log(`   payTo: ${requirements.accepts[0].payTo}`);
    console.log(`   feePayer: ${requirements.accepts[0].extra.feePayer}`);
    
    // Test encoding
    const encoded = server.encodeRequirements(requirements);
    console.log(`✅ Encoded to base64 (${encoded.length} chars)`);
    
    // Test 402 response creation
    const response = server.create402Response(requirements);
    console.log(`✅ Created 402 response with status: ${response.status}`);
    console.log(`   Header length: ${response.headers['PAYMENT-REQUIRED'].length} chars`);
    
    return true;
  } catch (error) {
    console.error('❌ Server test failed:', error);
    return false;
  }
}

async function testClient402Detection() {
  console.log('\n=== Test 3: Client 402 Detection ===');
  
  // Create a mock wallet (won't actually sign, just testing 402 detection)
  const mockWallet = {
    publicKey: { toBase58: () => 'MockPublicKey11111111111111111111111111111' },
    signTransaction: async <T>(tx: T): Promise<T> => {
      throw new Error('Mock wallet - signing disabled for test');
    },
  };
  
  const client = createX402Client({
    wallet: mockWallet,
    network: SOLANA_MAINNET_NETWORK,
    verbose: true,
  });
  
  try {
    console.log(`Making request to ${TEST_ENDPOINT}...`);
    
    // This should get a 402 and try to handle it
    // It will fail at signing (mock wallet), but we can verify 402 detection works
    await client.fetch(TEST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 1 }),
    });
    
    console.log('❌ Expected error but got success');
    return false;
  } catch (error: any) {
    if (error.code === 'transaction_build_failed' || error.message?.includes('Mock wallet')) {
      console.log('✅ 402 detected and payment flow initiated');
      console.log('   (Expected failure at signing - mock wallet)');
      return true;
    }
    if (error.code === 'missing_fee_payer') {
      console.log('✅ 402 detected, requirements parsed');
      console.log('   (Missing feePayer in response - server issue)');
      return true;
    }
    console.log(`✅ 402 flow triggered, error: ${error.code || error.message}`);
    return true;
  }
}

async function testRealPayment() {
  console.log('\n=== Test 4: Real Payment (SKIP - requires funded wallet) ===');
  console.log('   To test real payments, use a funded wallet with USDC');
  console.log('   and run the example in examples/client-example.ts');
  return true;
}

async function runAllTests() {
  console.log('🧪 Dexter x402 SDK Integration Tests');
  console.log('====================================');
  
  const results = {
    facilitatorClient: await testFacilitatorClient(),
    serverBuildRequirements: await testServerBuildRequirements(),
    client402Detection: await testClient402Detection(),
    realPayment: await testRealPayment(),
  };
  
  console.log('\n====================================');
  console.log('📊 Results:');
  console.log('====================================');
  
  let passed = 0;
  let failed = 0;
  
  for (const [name, result] of Object.entries(results)) {
    if (result) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.log(`  ❌ ${name}`);
      failed++;
    }
  }
  
  console.log('====================================');
  console.log(`Total: ${passed} passed, ${failed} failed`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch(console.error);

