/**
 * Multiple Payment Tests - Proving Dynamic Pricing Works
 */

import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import { createX402Client, SOLANA_MAINNET, USDC_MINT } from '../src/client';

const PRIVATE_KEY = process.env.SOLANA_TEST_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('❌ Missing SOLANA_TEST_PRIVATE_KEY');
  process.exit(1);
}

const RPC_URL = 'https://api.mainnet-beta.solana.com';

interface TestCase {
  name: string;
  prompt: string;
  model: string;
  expectedMinCost: number;
}

const tests: TestCase[] = [
  {
    name: 'Short prompt, cheap model',
    prompt: 'Hi',
    model: 'gpt-4o-mini',
    expectedMinCost: 0.01,
  },
  {
    name: 'Medium prompt, cheap model',
    prompt: 'Explain HTTP 402 Payment Required status code and how it enables internet-native payments for APIs and digital content.',
    model: 'gpt-4o-mini',
    expectedMinCost: 0.01,
  },
  {
    name: 'Long prompt, standard model',
    prompt: 'Write a detailed technical explanation of how the x402 protocol works. Include: 1) The HTTP 402 status code flow, 2) The PAYMENT-REQUIRED header structure, 3) How wallets sign transactions, 4) How facilitators verify and settle payments, 5) The difference between v1 and v2 of the protocol. Be thorough and technical.',
    model: 'gpt-4o',
    expectedMinCost: 0.01,
  },
];

async function main() {
  console.log('🧪 Multiple Payment Tests - Dynamic Pricing Proof');
  console.log('='.repeat(60) + '\n');

  const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, 'confirmed');
  const usdcMint = new PublicKey(USDC_MINT);
  const ata = await getAssociatedTokenAddress(usdcMint, keypair.publicKey);

  const accountBefore = await getAccount(connection, ata);
  const balanceBefore = Number(accountBefore.amount) / 1_000_000;
  console.log(`Starting Balance: $${balanceBefore.toFixed(4)} USDC\n`);

  const wallet = {
    publicKey: keypair.publicKey,
    signTransaction: async (tx: any) => {
      tx.sign([keypair]);
      return tx;
    },
  };

  const client = createX402Client({
    wallet,
    preferredNetwork: SOLANA_MAINNET,
    rpcUrls: { [SOLANA_MAINNET]: RPC_URL },
    verbose: false, // Less noise
  });

  const results: { name: string; cost: string; tx: string; chars: number; response: string }[] = [];

  for (const test of tests) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📝 TEST: ${test.name}`);
    console.log(`   Model: ${test.model}`);
    console.log(`   Prompt length: ${test.prompt.length} chars`);

    try {
      const response = await client.fetch('https://api.dexter.cash/api/tools/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt: test.prompt,
          model: test.model,
          maxTokens: 150 
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status}: ${text.slice(0, 200)}`);
      }

      const data = await response.json();
      
      console.log(`   ✅ Cost: ${data.billing?.chargeUsd}`);
      console.log(`   ✅ TX: ${data.billing?.txHash}`);
      console.log(`   ✅ Response: "${data.response?.slice(0, 60)}..."`);

      results.push({
        name: test.name,
        cost: data.billing?.chargeUsd || '?',
        tx: data.billing?.txHash || '?',
        chars: test.prompt.length,
        response: data.response?.slice(0, 50) || '',
      });

      // Small delay between tests
      await new Promise(r => setTimeout(r, 1000));

    } catch (error: any) {
      console.error(`   ❌ FAILED: ${error.message}`);
      results.push({
        name: test.name,
        cost: 'FAILED',
        tx: 'FAILED',
        chars: test.prompt.length,
        response: error.message,
      });
    }
  }

  // Wait for balance to update
  await new Promise(r => setTimeout(r, 3000));

  const accountAfter = await getAccount(connection, ata);
  const balanceAfter = Number(accountAfter.amount) / 1_000_000;

  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));
  
  console.log('\n| Test | Chars | Cost | TX Hash |');
  console.log('|------|-------|------|---------|');
  for (const r of results) {
    console.log(`| ${r.name.slice(0,20).padEnd(20)} | ${String(r.chars).padEnd(5)} | ${r.cost.padEnd(6)} | ${r.tx.slice(0,20)}... |`);
  }

  console.log(`\n💰 Starting Balance: $${balanceBefore.toFixed(4)}`);
  console.log(`💰 Ending Balance:   $${balanceAfter.toFixed(4)}`);
  console.log(`💸 Total Spent:      $${(balanceBefore - balanceAfter).toFixed(4)}`);

  // Output TX hashes for facilitator verification
  console.log('\n📋 TX Hashes for Facilitator Verification:');
  for (const r of results) {
    if (r.tx !== 'FAILED') {
      console.log(`   ${r.tx}`);
    }
  }
}

main().catch(console.error);

