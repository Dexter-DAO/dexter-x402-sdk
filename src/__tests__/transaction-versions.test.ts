import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';
import fixtures from './fixtures/mainnet-transaction-versions.json';

describe('mainnet transaction version decoder', () => {
  it.each(fixtures.cases)('decodes captured $version wire bytes', fixture => {
    const transaction = VersionedTransaction.deserialize(Buffer.from(fixture.wireBase64, 'base64'));
    expect(transaction.version).toBe(fixture.version);
    expect(bs58.encode(transaction.signatures[0])).toBe(fixture.signature);
    if (transaction.message.version === 1) {
      expect(transaction.message.transactionConfig.priorityFee).toBe(13);
    } else {
      expect(Buffer.from(transaction.serialize()).toString('base64')).toBe(fixture.wireBase64);
    }
  });

  it('decodes mixed legacy, v0 and v1 RPC history with the wallet-activity pattern', async () => {
    const fetchRpc = vi.fn(async (_url: unknown, init: { body?: unknown } | undefined): Promise<Response> => {
      const requests = JSON.parse(String(init?.body)) as Array<{ id: string; params: unknown[] }>;
      return new Response(JSON.stringify(requests.map(request => {
        expect(request.params[1]).toEqual({
          encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1,
        });
        return { jsonrpc: '2.0', id: request.id,
          result: fixtures.cases.find(fixture => fixture.signature === request.params[0])!.parsed };
      })));
    });
    const connection = new Connection('https://rpc.invalid', { fetch: fetchRpc });
    const transactions = await connection.getParsedTransactions(
      fixtures.cases.map(fixture => fixture.signature),
      { commitment: 'finalized', maxSupportedTransactionVersion: 1 },
    );
    expect(transactions.map(transaction => transaction?.version)).toEqual(['legacy', 0, 1]);
    expect(transactions[2]?.transaction.message.accountKeys[0].pubkey).toBeInstanceOf(PublicKey);
    expect(transactions[2]?.transaction.message.transactionConfig?.priorityFee).toBe(13);
  });
});
