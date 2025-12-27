/**
 * Real Payment Test - Base
 *
 * Tests the full x402 flow with actual USDC payment on Base mainnet.
 */

import { ethers } from 'ethers';
import { createX402Client, BASE_MAINNET } from '../src/client';

// Test wallet (from test-wallet-base.json)
const TEST_WALLET = {
  address: '0xA6D5F4E5ECbE00E0A0Ee6bAAA2137d703C98F0EE',
  privateKey: 'REDACTED_BASE_KEY',
};

const RPC_URL = 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function getUsdcBalance(address: string): Promise<number> {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const usdc = new ethers.Contract(
    USDC_ADDRESS,
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );
  const balance = await usdc.balanceOf(address);
  return Number(ethers.formatUnits(balance, 6));
}

async function main() {
  console.log('💰 Real Payment Test - Base');
  console.log('===========================\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(TEST_WALLET.privateKey, provider);

  console.log(`Wallet: ${signer.address}`);

  // Check balances
  const ethBalance = await provider.getBalance(signer.address);
  console.log(`ETH Balance: ${ethers.formatEther(ethBalance)} ETH`);

  const usdcBefore = await getUsdcBalance(signer.address);
  console.log(`USDC Balance: $${usdcBefore.toFixed(4)}`);

  if (usdcBefore < 0.05) {
    console.error('❌ Insufficient USDC balance (need $0.05)');
    process.exit(1);
  }

  // Create EVM wallet adapter for the SDK
  const evmWallet = {
    address: signer.address,
    chainId: 8453, // Base mainnet

    // EIP-712 typed data signing
    signTypedData: async (params: {
      domain: Record<string, unknown>;
      types: Record<string, unknown[]>;
      primaryType: string;
      message: Record<string, unknown>;
    }) => {
      // ethers v6 uses signTypedData directly
      const signature = await signer.signTypedData(
        params.domain as ethers.TypedDataDomain,
        { [params.primaryType]: params.types[params.primaryType] } as Record<string, ethers.TypedDataField[]>,
        params.message
      );
      return signature;
    },
  };

  // Create client with EVM wallet
  const client = createX402Client({
    wallets: { evm: evmWallet },
    preferredNetwork: BASE_MAINNET,
    rpcUrls: { [BASE_MAINNET]: RPC_URL },
    verbose: true,
  });

  console.log('\n📡 Making paid API request to Dexter (Base)...\n');

  try {
    const response = await client.fetch('https://x402.dexter.cash/api/tools/solscan/trending', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 3 }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.log('Response body:', text);
      throw new Error(`Request failed: ${response.status} - ${text.slice(0, 500)}`);
    }

    const data = await response.json();
    console.log('\n✅ Payment successful!');
    console.log('Response preview:', JSON.stringify(data, null, 2).slice(0, 500));

    // Check new balance
    await new Promise(r => setTimeout(r, 3000)); // Wait for confirmation
    const usdcAfter = await getUsdcBalance(signer.address);

    console.log(`\n💸 Spent: $${(usdcBefore - usdcAfter).toFixed(4)} USDC`);
    console.log(`   Balance: $${usdcBefore.toFixed(4)} → $${usdcAfter.toFixed(4)}`);

  } catch (error: any) {
    console.error('\n❌ Payment failed:', error.message);
    if (error.code) console.error('Code:', error.code);
    if (error.details) console.error('Details:', error.details);
    process.exit(1);
  }
}

main();

