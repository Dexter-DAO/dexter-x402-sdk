/**
 * @dexter/x402-solana - Client Example
 * 
 * Demonstrates how to make paid API calls using the x402 protocol.
 * The SDK automatically handles 402 responses, builds transactions,
 * signs them, and retries with payment proof.
 * 
 * Setup:
 *   export SOLANA_PRIVATE_KEY="your-base58-private-key"
 *   export SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"  # optional
 * 
 * Run:
 *   npx tsx examples/client-basic.ts
 */

import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import { createX402Client, SOLANA_MAINNET_NETWORK } from '../src/client';

// ============================================================================
// Configuration (from environment)
// ============================================================================

const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

if (!PRIVATE_KEY) {
  console.error('❌ Missing SOLANA_PRIVATE_KEY environment variable');
  console.error('   Export your base58-encoded Solana private key:');
  console.error('   export SOLANA_PRIVATE_KEY="your-private-key-here"');
  process.exit(1);
}

// ============================================================================
// Wallet Setup
// ============================================================================

const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

// Create a wallet adapter compatible with the SDK
const wallet = {
  publicKey: keypair.publicKey,
  signTransaction: async <T extends { sign: (signers: Keypair[]) => void }>(tx: T): Promise<T> => {
    (tx as any).sign([keypair]);
    return tx;
  },
};

// ============================================================================
// Helper: Check USDC Balance
// ============================================================================

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

async function getUsdcBalance(): Promise<number> {
  const connection = new Connection(RPC_URL, 'confirmed');
  const ata = await getAssociatedTokenAddress(USDC_MINT, keypair.publicKey);
  try {
    const account = await getAccount(connection, ata);
    return Number(account.amount) / 1_000_000; // USDC has 6 decimals
  } catch {
    return 0;
  }
}

// ============================================================================
// Main: Make a Paid API Call
// ============================================================================

async function main() {
  console.log('🔥 @dexter/x402-solana Client Example');
  console.log('=====================================\n');
  
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  
  const balanceBefore = await getUsdcBalance();
  console.log(`USDC Balance: $${balanceBefore.toFixed(4)}\n`);
  
  if (balanceBefore < 0.05) {
    console.error('❌ Insufficient USDC balance (need at least $0.05)');
    process.exit(1);
  }
  
  // Create the x402 client
  const client = createX402Client({
    wallet,
    network: SOLANA_MAINNET_NETWORK,
    rpcUrl: RPC_URL,
    verbose: true, // Set to false in production
  });
  
  // Make a paid request - this will:
  // 1. Get 402 Payment Required
  // 2. Parse payment requirements
  // 3. Build USDC transfer transaction
  // 4. Sign with your wallet
  // 5. Retry with PAYMENT-SIGNATURE header
  // 6. Return the final response
  
  console.log('📡 Making paid API request...\n');
  
  const response = await client.fetch('https://x402.dexter.cash/api/tools/solscan/trending', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 5 }),
  });
  
  if (response.ok) {
    const data = await response.json();
    console.log('\n✅ Success! Response:');
    console.log(JSON.stringify(data, null, 2).slice(0, 800));
    
    const balanceAfter = await getUsdcBalance();
    console.log(`\n💰 Spent: $${(balanceBefore - balanceAfter).toFixed(4)} USDC`);
  } else {
    console.error(`\n❌ Request failed: ${response.status}`);
    console.error(await response.text());
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

