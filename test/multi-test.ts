/**
 * Multiple Payment Tests - Proving Dynamic Pricing Works
 * Beautiful output for screenshots
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createX402Client, SOLANA_MAINNET } from '../src/client';

// ANSI Colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Colors
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  
  // Bright
  brightCyan: '\x1b[96m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightMagenta: '\x1b[95m',
  brightWhite: '\x1b[97m',
  
  // Background
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
};

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
  rate: string;
}

const tests: TestCase[] = [
  {
    name: 'Tiny (min)',
    prompt: 'Hi',
    model: 'gpt-4o-mini',
    rate: '$0.15/1M tokens',
  },
  {
    name: 'Medium',
    prompt: 'Write a detailed technical explanation of how the x402 protocol works, covering HTTP 402 status code flow, PAYMENT-REQUIRED header structure, wallet transaction signing, facilitator verification and settlement.',
    model: 'gpt-4o-mini',
    rate: '$0.15/1M tokens',
  },
  {
    name: 'Long + Expensive',
    prompt: 'Explain the x402 protocol including HTTP 402, payment headers, wallet signing, and facilitator settlement in detail. '.repeat(50),
    model: 'gpt-4o',
    rate: '$2.50/1M tokens',
  },
  {
    name: 'Premium Model',
    prompt: 'Write about blockchain payments, HTTP 402, API monetization with detailed technical analysis.',
    model: 'o3-mini',
    rate: '$1.10/1M tokens',
  },
];

async function main() {
  console.log('');
  console.log(`${c.bgMagenta}${c.brightWhite}${c.bold}                                                              ${c.reset}`);
  console.log(`${c.bgMagenta}${c.brightWhite}${c.bold}   🧪  x402 SDK — DYNAMIC PRICING PROOF                        ${c.reset}`);
  console.log(`${c.bgMagenta}${c.brightWhite}${c.bold}   Real payments • Real AI • Real-time pricing                 ${c.reset}`);
  console.log(`${c.bgMagenta}${c.brightWhite}${c.bold}                                                              ${c.reset}`);
  console.log('');

  const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  console.log(`${c.gray}┌─────────────────────────────────────────────────────────────┐${c.reset}`);
  console.log(`${c.gray}│${c.reset} ${c.cyan}Wallet:${c.reset}    ${c.brightWhite}${keypair.publicKey.toBase58()}${c.reset} ${c.gray}│${c.reset}`);
  console.log(`${c.gray}│${c.reset} ${c.cyan}Network:${c.reset}   ${c.brightGreen}Solana Mainnet${c.reset}                                ${c.gray}│${c.reset}`);
  console.log(`${c.gray}│${c.reset} ${c.cyan}Protocol:${c.reset}  ${c.brightMagenta}x402 v2${c.reset}                                       ${c.gray}│${c.reset}`);
  console.log(`${c.gray}└─────────────────────────────────────────────────────────────┘${c.reset}`);
  console.log('');

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
    verbose: false,
  });

  const results: { name: string; cost: string; tx: string; chars: number; model: string; rate: string }[] = [];
  let testNum = 0;

  for (const test of tests) {
    testNum++;
    console.log(`${c.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    console.log(`${c.bold}${c.brightCyan}TEST ${testNum}/${tests.length}${c.reset}  ${c.brightWhite}${test.name}${c.reset}`);
    console.log(`${c.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    console.log(`  ${c.dim}Model:${c.reset}  ${c.yellow}${test.model}${c.reset}  ${c.dim}@${c.reset} ${c.brightYellow}${test.rate}${c.reset}`);
    console.log(`  ${c.dim}Input:${c.reset}  ${c.brightWhite}${test.prompt.length.toLocaleString()}${c.reset} ${c.dim}characters${c.reset}`);
    console.log('');

    try {
      const start = Date.now();
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
      const elapsed = Date.now() - start;
      
      console.log(`  ${c.brightGreen}✓${c.reset} ${c.green}Payment successful${c.reset}`);
      console.log(`  ${c.dim}├─${c.reset} ${c.cyan}Charged:${c.reset}  ${c.bold}${c.brightGreen}$${data.billing?.chargeUsd}${c.reset} ${c.dim}USDC${c.reset}`);
      console.log(`  ${c.dim}├─${c.reset} ${c.cyan}TX:${c.reset}       ${c.blue}${data.billing?.txHash?.slice(0, 44)}${c.reset}${c.dim}...${c.reset}`);
      console.log(`  ${c.dim}├─${c.reset} ${c.cyan}Time:${c.reset}     ${c.white}${elapsed}ms${c.reset}`);
      console.log(`  ${c.dim}└─${c.reset} ${c.cyan}Response:${c.reset} ${c.dim}"${data.response?.slice(0, 50)}..."${c.reset}`);

      results.push({
        name: test.name,
        cost: data.billing?.chargeUsd || '?',
        tx: data.billing?.txHash || '?',
        chars: test.prompt.length,
        model: test.model,
        rate: test.rate,
      });

      await new Promise(r => setTimeout(r, 800));

    } catch (error: any) {
      console.error(`  ${c.bold}✗${c.reset} ${c.reset}FAILED: ${error.message}${c.reset}`);
      results.push({
        name: test.name,
        cost: 'FAILED',
        tx: 'FAILED',
        chars: test.prompt.length,
        model: test.model,
        rate: test.rate,
      });
    }
    console.log('');
  }

  // Summary
  console.log(`${c.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log('');
  console.log(`${c.bgCyan}${c.bold}${c.white}                                                              ${c.reset}`);
  console.log(`${c.bgCyan}${c.bold}${c.white}   📊  RESULTS — DYNAMIC PRICING PROOF                        ${c.reset}`);
  console.log(`${c.bgCyan}${c.bold}${c.white}                                                              ${c.reset}`);
  console.log('');
  
  // Table header
  console.log(`${c.gray}┌──────────────────────┬────────────┬─────────────┬──────────┐${c.reset}`);
  console.log(`${c.gray}│${c.reset} ${c.bold}${c.brightWhite}Test${c.reset}                 ${c.gray}│${c.reset} ${c.bold}${c.brightWhite}Characters${c.reset} ${c.gray}│${c.reset} ${c.bold}${c.brightWhite}Model${c.reset}       ${c.gray}│${c.reset} ${c.bold}${c.brightGreen}Cost${c.reset}     ${c.gray}│${c.reset}`);
  console.log(`${c.gray}├──────────────────────┼────────────┼─────────────┼──────────┤${c.reset}`);
  
  for (const r of results) {
    const chars = r.chars.toLocaleString().padStart(8);
    const model = r.model.padEnd(11);
    const cost = r.cost === 'FAILED' ? `${c.reset}FAILED${c.reset}` : `${c.brightGreen}$${r.cost}${c.reset}`;
    console.log(`${c.gray}│${c.reset} ${c.white}${r.name.slice(0,20).padEnd(20)}${c.reset} ${c.gray}│${c.reset} ${c.brightCyan}${chars}${c.reset}   ${c.gray}│${c.reset} ${c.yellow}${model}${c.reset} ${c.gray}│${c.reset} ${cost.padEnd(8)} ${c.gray}│${c.reset}`);
  }
  
  console.log(`${c.gray}└──────────────────────┴────────────┴─────────────┴──────────┘${c.reset}`);

  // Calculate total
  const totalSpent = results
    .filter(r => r.cost !== 'FAILED')
    .reduce((sum, r) => sum + parseFloat(r.cost.replace('$', '')), 0);
  
  console.log('');
  console.log(`${c.gray}┌─────────────────────────────────────────────────────────────┐${c.reset}`);
  console.log(`${c.gray}│${c.reset}  ${c.bold}${c.brightGreen}💰 TOTAL CHARGED:${c.reset}  ${c.bold}${c.brightGreen}$${totalSpent.toFixed(2)} USDC${c.reset}                            ${c.gray}│${c.reset}`);
  console.log(`${c.gray}│${c.reset}  ${c.dim}Settled via x402 v2 facilitator (x402.dexter.cash)${c.reset}          ${c.gray}│${c.reset}`);
  console.log(`${c.gray}└─────────────────────────────────────────────────────────────┘${c.reset}`);

  // TX hashes
  console.log('');
  console.log(`${c.dim}Transaction Hashes (verify on Solscan):${c.reset}`);
  for (const r of results) {
    if (r.tx !== 'FAILED') {
      console.log(`  ${c.blue}${r.tx}${c.reset}`);
    }
  }
  console.log('');
}

main().catch(console.error);

