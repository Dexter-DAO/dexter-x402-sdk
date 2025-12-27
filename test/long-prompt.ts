import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createX402Client, SOLANA_MAINNET } from '../src/client';

const PRIVATE_KEY = process.env.SOLANA_TEST_PRIVATE_KEY!;
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

const client = createX402Client({
  wallet: { 
    publicKey: keypair.publicKey, 
    signTransaction: async (tx: any) => { tx.sign([keypair]); return tx; } 
  },
  preferredNetwork: SOLANA_MAINNET,
  rpcUrls: { [SOLANA_MAINNET]: 'https://api.mainnet-beta.solana.com' },
});

// 6500+ character prompt to exceed minimum pricing ($0.01/1000 chars * 6.5k = $0.065)
const longPrompt = 'Write a comprehensive technical deep-dive on the x402 protocol covering HTTP 402, payment headers, wallet signing, facilitator settlement, and the differences between v1 and v2. '.repeat(40);

console.log('🔬 Dynamic Pricing Test - Long Prompt');
console.log('=====================================');
console.log('Prompt length:', longPrompt.length, 'chars');
console.log('Model: gpt-4o (rate: $0.01/1000 chars)');
console.log('Expected cost: $' + Math.max(0.01, (longPrompt.length / 1000) * 0.01).toFixed(2));
console.log('');

const res = await client.fetch('https://api.dexter.cash/api/tools/ai/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: longPrompt, model: 'gpt-4o', maxTokens: 100 }),
});

const data = await res.json();
console.log('✅ Actual cost:', data.billing?.chargeUsd);
console.log('✅ TX:', data.billing?.txHash);
console.log('✅ Response:', data.response?.slice(0, 80) + '...');

