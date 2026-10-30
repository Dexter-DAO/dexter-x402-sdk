import { afterEach, describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, MessageV0, type VersionedTransactionResponse } from '@solana/web3.js';
import { SolanaAdapter } from '../solana';
import { mainnetTransactionRpc, mainnetV1 } from '../../__tests__/mainnet-transactions';

afterEach(() => vi.restoreAllMocks());

describe('Solana settlement history transaction versions', () => {
  it('resolves a v0 lookup-table destination while checking token balance changes', async () => {
    const payer = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey;
    const asset = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const signature = mainnetV1.signature;
    const message = new MessageV0({
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      staticAccountKeys: [payer],
      recentBlockhash: payer.toBase58(),
      compiledInstructions: [],
      addressTableLookups: [{ accountKey: Keypair.generate().publicKey, writableIndexes: [0], readonlyIndexes: [] }],
    });
    const balance = (amount: string) => ({
      accountIndex: 1, mint: asset,
      uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6 },
    });
    vi.spyOn(Connection.prototype, 'getSignaturesForAddress').mockResolvedValue([{
      signature, slot: 1, err: null, memo: null, blockTime: null,
    }]);
    vi.spyOn(Connection.prototype, 'getTransaction').mockResolvedValue({
      slot: 1, transaction: { message, signatures: [signature] }, version: 0,
      meta: { err: null, fee: 5000, preBalances: [], postBalances: [],
        loadedAddresses: { writable: [destination], readonly: [] },
        preTokenBalances: [balance('1')], postTokenBalances: [balance('1000001')] },
    } satisfies VersionedTransactionResponse);

    await expect(new SolanaAdapter().confirmSettlement({
      kind: 'solana', sourceAta: payer.toBase58(), destinationAta: destination.toBase58(),
      asset, amount: '1000000', blockhash: payer.toBase58(),
    }, 'https://rpc.invalid')).resolves.toEqual({ settled: true, txSignature: signature });
  });

  it('decodes a real finalized mainnet v1 candidate and returns an unsettled result for a non-payment', async () => {
    const rpc = mainnetTransactionRpc();
    const read = rpc.connection.getTransaction.bind(rpc.connection);
    vi.spyOn(Connection.prototype, 'getTransaction').mockImplementation(read);
    vi.spyOn(Connection.prototype, 'getSignaturesForAddress').mockResolvedValue([{
      signature: mainnetV1.signature,
      slot: mainnetV1.parsed.slot,
      err: null,
      memo: null,
      blockTime: mainnetV1.parsed.blockTime,
    }]);
    const result = await new SolanaAdapter().confirmSettlement({
      kind: 'solana',
      sourceAta: mainnetV1.parsed.transaction.message.accountKeys[0].pubkey,
      destinationAta: mainnetV1.parsed.transaction.message.accountKeys[1].pubkey,
      asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '1',
      blockhash: mainnetV1.parsed.transaction.message.recentBlockhash,
    }, 'https://rpc.invalid');
    expect(result).toEqual({ settled: false });
    expect(rpc.fetchRpc).toHaveBeenCalledOnce();
  });
});
