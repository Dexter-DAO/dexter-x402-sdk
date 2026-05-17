/**
 * Live both-sides batch-settlement smoke test — Base mainnet, real USDC.
 *
 * NOT part of `npm test` or CI. Run manually with funded wallets:
 *   BUYER_PRIVATE_KEY=0x... SELLER_ADDRESS=0x... npx tsx test/batch-settlement-seller-real.ts
 *
 * Stands up a createBatchSettlementSeller resource server on a local port,
 * drives the buyer SDK (openBatchChannel -> fetch x3) against it, then calls
 * seller.closeChannel(...) to claim+settle+refund on-chain via the live
 * facilitator. Proves a seller can collect batch-settlement payments.
 *
 * Requires:
 *  - BUYER_PRIVATE_KEY : a Base wallet holding >= 0.30 USDC
 *  - SELLER_ADDRESS    : the seller payout address (the channel receiver)
 */
import express from 'express';
import { privateKeyToAccount } from 'viem/accounts';
import { openBatchChannel } from '../src/batch-settlement/index';
import { createBatchSettlementSeller } from '../src/batch-settlement/seller/index';

const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const SELLER_ADDRESS = process.env.SELLER_ADDRESS as `0x${string}`;
const NETWORK = 'eip155:8453';
const PORT = 14075;
const ROUTE = '/smoke';

async function main() {
  if (!BUYER_PRIVATE_KEY) throw new Error('set BUYER_PRIVATE_KEY');
  if (!SELLER_ADDRESS) throw new Error('set SELLER_ADDRESS');

  // --- seller ---
  const seller = createBatchSettlementSeller({
    payTo: SELLER_ADDRESS,
    network: NETWORK,
    price: '0.08',
    route: `GET ${ROUTE}`,
    autoSettle: false, // settle explicitly below
  });
  const app = express();
  app.use(ROUTE, seller, (_req, res) => res.json({ ok: true }));
  const server = app.listen(PORT);
  console.log(`seller listening on :${PORT}`);

  try {
    // --- buyer ---
    const account = privateKeyToAccount(BUYER_PRIVATE_KEY);
    const wallet = {
      address: account.address,
      connected: true,
      signTypedData: (args: Parameters<typeof account.signTypedData>[0]) =>
        account.signTypedData(args),
    };
    const channel = await openBatchChannel({ wallet, network: NETWORK, deposit: '0.30' });
    console.log('channel opened');

    for (let i = 1; i <= 3; i++) {
      const res = await channel.fetch(`http://localhost:${PORT}${ROUTE}`);
      console.log(`request ${i}: HTTP ${res.status}`, channel.state);
      if (res.status !== 200) throw new Error(`request ${i} failed: ${res.status}`);
    }

    // --- seller settles ---
    const receipt = await seller.closeChannel(channel.channelId);
    console.log('OVERALL: PASS');
    console.log('  claim :', receipt.claimTx, '\n  settle:', receipt.settleTx, '\n  refund:', receipt.refundTx);
    console.log('  settled / refunded:', receipt.settledAmount, '/', receipt.refundedAmount);
  } finally {
    await seller.stop();
    server.close();
  }
}

main().catch((e) => {
  console.error('OVERALL: FAIL');
  console.error(e);
  process.exit(1);
});
