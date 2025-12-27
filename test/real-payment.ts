/**
 * REAL Payment Test for @dexter/x402-solana
 * 
 * This test ACTUALLY pays for an API call and verifies the entire flow:
 * 1. Make request → get 402
 * 2. Parse PAYMENT-REQUIRED
 * 3. Build transaction
 * 4. Sign transaction  
 * 5. Retry with PAYMENT-SIGNATURE
 * 6. Get real response
 * 
 * Run with: npx tsx test/real-payment.ts
 */

import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import { createX402Client, SOLANA_MAINNET_NETWORK } from '../src/client';

// Configuration
const DEXTER_API = 'https://x402.dexter.cash';
const RPC_URL = 'https://api.mainnet-beta.solana.com';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// Test wallet - CONNECTOR_REWARD_PRIVATE_KEY from dexter-api .env
const TEST_PRIVATE_KEY = '3aPixPmY4mQYjJR7XfvgGBq4eUU7mmhEibQKL2mQq46Zy3jPEPWkJ7PCgzTgn9ku5NNtzHwJvPToRsYFyWQ198HW';

async function checkBalance(keypair: Keypair): Promise<{ sol: number; usdc: number }> {
  const connection = new Connection(RPC_URL, 'confirmed');
  
  const solBalance = await connection.getBalance(keypair.publicKey);
  
  const usdcAta = await getAssociatedTokenAddress(USDC_MINT, keypair.publicKey);
  let usdcBalance = 0;
  try {
    const account = await getAccount(connection, usdcAta);
    usdcBalance = Number(account.amount) / 1_000_000; // 6 decimals
  } catch {
    // No USDC account
  }
  
  return {
    sol: solBalance / 1_000_000_000,
    usdc: usdcBalance,
  };
}

async function runRealPaymentTest() {
  console.log('🔥 REAL Payment Test');
  console.log('====================\n');
  
  // Load wallet
  const keypair = Keypair.fromSecretKey(bs58.decode(TEST_PRIVATE_KEY));
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  
  // Check balance
  const balanceBefore = await checkBalance(keypair);
  console.log(`Balance: ${balanceBefore.sol.toFixed(4)} SOL, ${balanceBefore.usdc.toFixed(4)} USDC\n`);
  
  if (balanceBefore.usdc < 0.05) {
    console.error('❌ Insufficient USDC balance (need at least $0.05)');
    process.exit(1);
  }
  
  // Create SDK client with REAL wallet
  const wallet = {
    publicKey: { toBase58: () => keypair.publicKey.toBase58() },
    signTransaction: async <T extends { sign: (signers: Keypair[]) => void }>(tx: T): Promise<T> => {
      // For VersionedTransaction, we need to use the sign method
      (tx as any).sign([keypair]);
      return tx;
    },
  };
  
  const client = createX402Client({
    wallet,
    network: SOLANA_MAINNET_NETWORK,
    rpcUrl: RPC_URL,
    verbose: true,
  });
  
  // Make a REAL paid request
  const endpoint = `${DEXTER_API}/api/tools/solscan/trending`;
  console.log(`\n📡 Calling: ${endpoint}`);
  console.log('   This will cost $0.05 USDC\n');
  
  try {
    const response = await client.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 3 }),
    });
    
    console.log(`\n✅ Response status: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log('\n📊 Response data:');
      console.log(JSON.stringify(data, null, 2).slice(0, 500) + '...');
      
      // Check balance after
      const balanceAfter = await checkBalance(keypair);
      const spent = balanceBefore.usdc - balanceAfter.usdc;
      console.log(`\n💰 Spent: $${spent.toFixed(4)} USDC`);
      console.log(`   Balance after: ${balanceAfter.usdc.toFixed(4)} USDC`);
      
      console.log('\n✅ REAL PAYMENT TEST PASSED');
    } else {
      const errorText = await response.text();
      console.error(`❌ Request failed: ${response.status}`);
      console.error(errorText);
      process.exit(1);
    }
  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.code) console.error('   Code:', error.code);
    if (error.details) console.error('   Details:', error.details);
    process.exit(1);
  }
}

runRealPaymentTest().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

