/**
 * Live batch-settlement smoke test — Base mainnet, real USDC.
 *
 * NOT part of `npm test` or CI. Run manually with a funded wallet:
 *   BUYER_PRIVATE_KEY=0x... RESOURCE_URL=... npx tsx test/batch-settlement-real.ts
 *
 * Drives the full lifecycle through the SDK's public surface:
 * openBatchChannel -> 3x channel.fetch -> channel.close.
 *
 * Requires:
 *  - BUYER_PRIVATE_KEY : a Base wallet holding >= 0.30 USDC
 *  - RESOURCE_URL      : a resource server returning a batch-settlement 402
 */
import { privateKeyToAccount } from 'viem/accounts';
import { openBatchChannel } from '../src/batch-settlement/index';

const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const RESOURCE_URL = process.env.RESOURCE_URL ?? 'http://localhost:14072/smoke';
const NETWORK = 'eip155:8453';

async function main() {
  if (!BUYER_PRIVATE_KEY) throw new Error('set BUYER_PRIVATE_KEY');

  const account = privateKeyToAccount(BUYER_PRIVATE_KEY);
  const wallet = {
    address: account.address,
    connected: true,
    signTypedData: (args: Parameters<typeof account.signTypedData>[0]) =>
      account.signTypedData(args),
  };

  console.log('opening channel...');
  const channel = await openBatchChannel({
    wallet,
    network: NETWORK,
    deposit: '0.30',
  });
  console.log('channel opened');

  for (let i = 1; i <= 3; i++) {
    const res = await channel.fetch(RESOURCE_URL);
    console.log(`request ${i}: HTTP ${res.status}`, channel.state);
    if (res.status !== 200) throw new Error(`request ${i} failed: ${res.status}`);
  }

  console.log('closing channel...');
  const receipt = await channel.close();
  console.log('OVERALL: PASS');
  console.log('  claim :', receipt.claimTx);
  console.log('  settle:', receipt.settleTx);
  console.log('  refund:', receipt.refundTx);
  console.log('  settled / refunded:', receipt.settledAmount, '/', receipt.refundedAmount);
}

main().catch((e) => {
  console.error('OVERALL: FAIL');
  console.error(e);
  process.exit(1);
});
