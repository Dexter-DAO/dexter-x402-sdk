/**
 * Real Payment Test - AI Chat with Dynamic Pricing
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

async function main() {
  console.log('🤖 Real Payment Test - AI Chat Dynamic Pricing');
  console.log('==============================================\n');

  const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);

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

  console.log(`USDC Balance: $${balanceBefore.toFixed(4)}\n`);

  const wallet = {
    publicKey: keypair.publicKey,
    signTransaction: async <T extends { sign: (signers: Keypair[]) => void }>(tx: T): Promise<T> => {
      (tx as any).sign([keypair]);
      return tx;
    },
  };

  const client = createX402Client({
    wallet,
    preferredNetwork: SOLANA_MAINNET,
    rpcUrls: { [SOLANA_MAINNET]: RPC_URL },
    verbose: true,
  });

  const prompt = 'What is x402 in one sentence?';
  console.log(`📝 Prompt: "${prompt}"`);
  console.log(`   Length: ${prompt.length} chars\n`);

  try {
    const response = await client.fetch('https://api.dexter.cash/api/tools/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        prompt,
        model: 'gpt-4o-mini',  // Token-based pricing
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Request failed: ${response.status} - ${text}`);
    }

    const data = await response.json();
    console.log('\n✅ AI Response received!');
    console.log('─'.repeat(40));
    console.log(data.response);
    console.log('─'.repeat(40));
    // Payment details from API response (authoritative - no balance diff needed)
    console.log('\n💰 Payment Confirmed:');
    console.log(`   Charged: $${data.billing?.chargeUsd} USDC`);
    console.log(`   Atomic:  ${data.billing?.amountAtomic} units`);
    console.log(`   TX:      ${data.billing?.txHash}`);
    console.log(`   Verify:  https://solscan.io/tx/${data.billing?.txHash}`);

  } catch (error: any) {
    console.error('\n❌ Failed:', error.message);
    process.exit(1);
  }
}

main();
