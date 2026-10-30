import { Connection, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { expect, vi } from 'vitest';
import fixtureData from './fixtures/mainnet-transaction-versions.json';

export const mainnetV1 = fixtureData.cases.find(fixture => fixture.version === 1)!;

// The capture includes wire bytes and jsonParsed. Reconstruct json's compiled
// message directly from those exact bytes so getTransaction exercises the real
// SDK response decoder instead of returning a pre-decoded mock MessageV1.
export function mainnetRawTransaction() {
  const transaction = VersionedTransaction.deserialize(Buffer.from(mainnetV1.wireBase64, 'base64'));
  const message = transaction.message;
  if (message.version !== 1) throw new Error('fixture must be version 1');
  return {
    ...mainnetV1.parsed,
    transaction: {
      signatures: transaction.signatures.map(signature => bs58.encode(signature)),
      message: {
        header: message.header,
        accountKeys: message.staticAccountKeys.map(key => key.toBase58()),
        recentBlockhash: message.recentBlockhash,
        instructions: message.compiledInstructions.map(instruction => ({
          programIdIndex: instruction.programIdIndex,
          accounts: instruction.accountKeyIndexes,
          data: bs58.encode(instruction.data),
        })),
        transactionConfig: message.transactionConfig,
      },
    },
  };
}

export function mainnetTransactionRpc() {
  const raw = mainnetRawTransaction();
  const fetchRpc = vi.fn(async (_url: unknown, init: { body?: unknown } | undefined): Promise<Response> => {
    const request = JSON.parse(String(init?.body));
    expect(request.method).toBe('getTransaction');
    expect(request.params[1].maxSupportedTransactionVersion).toBe(1);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: raw }));
  });
  return { raw, fetchRpc, connection: new Connection('https://rpc.invalid', { fetch: fetchRpc }) };
}
