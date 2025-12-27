/**
 * Real Payment Test - Solana
 *
 * Tests the full x402 flow with actual USDC payment on Solana mainnet.
 * Uses the CONNECTOR_REWARD wallet for testing.
 */

import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import { createX402Client, SOLANA_MAINNET, USDC_MINT } from '../src/client';

// Test wallet (CONNECTOR_REWARD from dexter-api)
const PRIVATE_KEY = 'REDACTED_SOLANA_KEY';
const RPC_URL = 'https://api.mainnet-beta.solana.com';

async function main() {
  console.log('💰 Real Payment Test - Solana');
  console.log('==============================\n');

  // Setup wallet
  const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);

  // Check balance
  const connection = new Connection(RPC_URL, 'confirmed');
  const usdcMint = new PublicKey(USDC_MINT);
  const ata = await getAssociatedTokenAddress(usdcMint, keypair.publicKey);

  let balanceBefore = 0;
  try {
    const account = await getAccount(connection, ata);
    balanceBefore = Number(account.amount) / 1_000_000;
  } catch {
    console.error('❌ No USDC account found');
    process.exit(1);
  }

  console.log(`USDC Balance: $${balanceBefore.toFixed(4)}`);

  if (balanceBefore < 0.05) {
    console.error('❌ Insufficient balance (need $0.05)');
    process.exit(1);
  }

  // Create wallet adapter
  const wallet = {
    publicKey: keypair.publicKey,
    signTransaction: async <T extends { sign: (signers: Keypair[]) => void }>(tx: T): Promise<T> => {
      (tx as any).sign([keypair]);
      return tx;
    },
  };

  // Create client
  const client = createX402Client({
    wallet,
    preferredNetwork: SOLANA_MAINNET,
    rpcUrls: { [SOLANA_MAINNET]: RPC_URL },
    verbose: true,
  });

  console.log('\n📡 Making paid API request to Dexter...\n');

  try {
    const response = await client.fetch('https://x402.dexter.cash/api/tools/solscan/trending', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 3 }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Request failed: ${response.status} - ${text}`);
    }

    const data = await response.json();
    console.log('\n✅ Payment successful!');
    console.log('Response preview:', JSON.stringify(data, null, 2).slice(0, 500));

    // Check new balance
    await new Promise(r => setTimeout(r, 2000)); // Wait for confirmation
    const accountAfter = await getAccount(connection, ata);
    const balanceAfter = Number(accountAfter.amount) / 1_000_000;

    console.log(`\n💸 Spent: $${(balanceBefore - balanceAfter).toFixed(4)} USDC`);
    console.log(`   Balance: $${balanceBefore.toFixed(4)} → $${balanceAfter.toFixed(4)}`);

  } catch (error: any) {
    console.error('\n❌ Payment failed:', error.message);
    if (error.details) console.error('Details:', error.details);
    process.exit(1);
  }
}

main();

