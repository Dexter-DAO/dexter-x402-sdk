/**
 * Live both-sides batch-settlement smoke test — Base mainnet, real USDC.
 *
 * NOT part of `npm test` or CI. Run manually with a funded wallet:
 *   BUYER_PRIVATE_KEY=0x... [SELLER_ADDRESS=0x...] npx tsx test/batch-settlement-seller-real.ts
 *
 * Stands up a createBatchSettlementSeller resource server on a local port,
 * drives the buyer SDK (openBatchChannel -> fetch xN) against it, then calls
 * seller.closeChannel(...) to claim+settle+refund on-chain via the live
 * facilitator. Proves a seller can collect batch-settlement payments.
 *
 * Each run opens a NEW channel: openBatchChannel generates a fresh random
 * channel-config salt by default, so the deterministic channelId differs
 * every run and runs never collide on an already-drained channel.
 *
 * Requires:
 *  - BUYER_PRIVATE_KEY : a Base wallet holding >= 0.30 USDC (+ no native gas
 *                        needed — the facilitator pays deposit/settle gas)
 *  - SELLER_ADDRESS    : optional seller payout address / channel receiver.
 *                        Defaults to the buyer address so settled funds and
 *                        refund both return to the one test wallet.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { privateKeyToAccount } from 'viem/accounts';
import { FileChannelStorage } from '@x402/evm/batch-settlement/server';
import { openBatchChannel, createFileChannelStore } from '../src/batch-settlement/index';
import { createBatchSettlementSeller } from '../src/batch-settlement/seller/index';

const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const NETWORK = 'eip155:8453';
const PORT = 14075;
const ROUTE = '/smoke';
const PRICE = '0.08';
const REQUESTS = 3;

async function main() {
  if (!BUYER_PRIVATE_KEY) throw new Error('set BUYER_PRIVATE_KEY');

  const account = privateKeyToAccount(BUYER_PRIVATE_KEY);
  const sellerAddress =
    (process.env.SELLER_ADDRESS as `0x${string}` | undefined) ?? account.address;

  // Dedicated, freshly-created channel stores for this run. The buyer's
  // default store at ~/.dexter-x402/channels persists across runs; a throwaway
  // temp dir keeps the smoke test self-contained. (The fresh per-run salt
  // already prevents on-chain channelId reuse — this just isolates local
  // bookkeeping too.)
  const storeRoot = mkdtempSync(join(tmpdir(), 'bss-smoke-'));
  const buyerStore = createFileChannelStore(join(storeRoot, 'buyer'));
  const sellerStore = new FileChannelStorage({ directory: join(storeRoot, 'seller') });
  console.log(`fresh channel stores at ${storeRoot}`);

  // --- seller ---
  const seller = createBatchSettlementSeller({
    payTo: sellerAddress,
    network: NETWORK,
    price: PRICE,
    route: `GET ${ROUTE}`,
    autoSettle: false, // settle explicitly below
    channelStore: sellerStore,
  });
  const app = express();
  app.use(ROUTE, seller, (_req, res) => res.json({ ok: true }));
  const server = app.listen(PORT);
  console.log(`seller listening on :${PORT}`);

  try {
    // --- buyer ---
    const wallet = {
      address: account.address,
      connected: true,
      signTypedData: (args: Parameters<typeof account.signTypedData>[0]) =>
        account.signTypedData(args),
    };
    const channel = await openBatchChannel({
      wallet,
      network: NETWORK,
      deposit: '0.30',
      store: buyerStore,
    });
    // A fresh random salt => a brand-new channel for this run.
    console.log(`channel opened (salt ${channel.salt})`);

    for (let i = 1; i <= REQUESTS; i++) {
      const res = await channel.fetch(`http://localhost:${PORT}${ROUTE}`);
      console.log(`request ${i}: HTTP ${res.status}`, channel.state);
      if (res.status !== 200) throw new Error(`request ${i} failed: ${res.status}`);
    }

    // The channel is brand new, so its cumulative spend IS this run's spend:
    // exactly REQUESTS * PRICE. Assert it rather than just trusting HTTP 200.
    const expectedSpent = (REQUESTS * Number(PRICE)).toFixed(2);
    if (Number(channel.state.spent).toFixed(2) !== expectedSpent) {
      throw new Error(
        `channel spend mismatch: expected ${expectedSpent}, got ${channel.state.spent}`,
      );
    }

    // --- seller settles ---
    const receipt = await seller.closeChannel(channel.channelId);
    if (!receipt.claimTx || !receipt.settleTx || !receipt.refundTx) {
      throw new Error(
        `incomplete settlement: claim=${receipt.claimTx} settle=${receipt.settleTx} refund=${receipt.refundTx}`,
      );
    }
    if (Number(receipt.settledAmount).toFixed(2) !== expectedSpent) {
      throw new Error(
        `settled amount mismatch: expected ${expectedSpent}, got ${receipt.settledAmount}`,
      );
    }

    console.log('OVERALL: PASS');
    console.log('  claim :', receipt.claimTx, '\n  settle:', receipt.settleTx, '\n  refund:', receipt.refundTx);
    console.log('  settled / refunded:', receipt.settledAmount, '/', receipt.refundedAmount);
  } finally {
    await seller.stop();
    server.close();
    rmSync(storeRoot, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('OVERALL: FAIL');
  console.error(e);
  process.exit(1);
});
