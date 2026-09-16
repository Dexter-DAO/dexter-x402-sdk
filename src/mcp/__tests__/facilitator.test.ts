import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createMcpFacilitatorProcessor } from '../facilitator';
import { payment, receipt } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('MCP facilitator reuse', () => {
  it('converts proof to the existing facilitator request and never retries uncertain settlement', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ isValid: true })))
      .mockRejectedValueOnce(new TypeError('connection lost after submit'));
    vi.stubGlobal('fetch', fetch);
    const processor = createMcpFacilitatorProcessor({ networks: ['eip155:8453'], facilitatorUrl: 'https://facilitator.example' });
    expect(await processor.verify(payment, payment.accepted)).toEqual({ isValid: true });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      x402Version: 2, paymentPayload: payment, paymentRequirements: payment.accepted,
    });
    expect(await processor.settle(payment, payment.accepted)).toMatchObject({ status: 'unknown' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns uncertainty for HTTP 500 or a success response missing a transaction', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('error', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    vi.stubGlobal('fetch', fetch);
    const processor = createMcpFacilitatorProcessor({ networks: ['eip155:8453'] });
    expect((await processor.settle(payment, payment.accepted)).status).toBe('unknown');
    expect((await processor.settle(payment, payment.accepted)).status).toBe('unknown');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retains confirmed receipts and requires an explicit exact-payment network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(receipt))));
    const processor = createMcpFacilitatorProcessor({ networks: ['eip155:8453'] });
    expect(await processor.settle(payment, payment.accepted)).toEqual({ status: 'settled', receipt });
    expect(processor.supports(payment.accepted)).toBe(true);
    expect(processor.supports({ ...payment.accepted, network: 'eip155:1' })).toBe(false);
    expect(processor.supports({ ...payment.accepted, scheme: 'tab' })).toBe(false);
  });

  it('identifies EIP-3009 authorization by nonce even when metadata or signatures change', () => {
    const processor = createMcpFacilitatorProcessor({ networks: ['eip155:8453'] });
    const altered = structuredClone(payment);
    altered.resource!.url = 'mcp://another-tool';
    altered.payload.signature = 'changed';
    altered.payload.harmlessExtra = true;
    expect(processor.identify(altered)).toBe(processor.identify(payment));
    const nonce = structuredClone(payment);
    (nonce.payload.authorization as Record<string, unknown>).nonce = `0x${'00'.repeat(32)}`;
    expect(processor.identify(nonce)).not.toBe(processor.identify(payment));
  });

  it('uses Permit2 owner and nonce across different tokens', () => {
    const processor = createMcpFacilitatorProcessor({ networks: ['eip155:8453'] });
    const permit = { ...payment, accepted: { ...payment.accepted, extra: { assetTransferMethod: 'permit2' } },
      payload: { permit2Authorization: { from: receipt.payer, nonce: '00042' } } };
    expect(processor.identify(permit)).toBe(processor.identify({ ...permit,
      accepted: { ...permit.accepted, asset: 'another-token' },
      payload: { permit2Authorization: { from: receipt.payer.toUpperCase().replace('0X', '0x'), nonce: '42' } },
    }));
  });

  it('rejects mixed proof families before identity, verification or settlement', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const processor = createMcpFacilitatorProcessor({ networks: ['eip155:8453'] });
    const mixed = { ...payment, payload: { ...payment.payload,
      permit2Authorization: { from: receipt.payer, nonce: '42' } } };
    expect(() => processor.identify(mixed)).toThrow('exactly one');
    expect(await processor.verify(mixed, mixed.accepted)).toMatchObject({ isValid: false });
    await expect(processor.settle(mixed, mixed.accepted)).rejects.toThrow('exactly one');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires the advertised EVM asset transfer method to match the proof family', () => {
    const processor = createMcpFacilitatorProcessor({ networks: ['eip155:8453'] });
    const permit = { ...payment, payload: { permit2Authorization: { from: receipt.payer, nonce: '42' } } };
    expect(() => processor.identify(permit)).toThrow('Unsupported');
    expect(() => processor.identify({ ...payment,
      accepted: { ...payment.accepted, extra: { assetTransferMethod: 'permit2' } } })).toThrow('Unsupported');
    expect(processor.supports({ ...payment.accepted, extra: { assetTransferMethod: 'new-method' } })).toBe(false);
  });

  it('rejects upfront, escrow and unknown flows before facilitator calls', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const processor = createMcpFacilitatorProcessor({ networks: ['eip155:8453'] });
    for (const paymentFlow of ['upfront', 'escrow', 'future-flow']) {
      const accept = { ...payment.accepted, extra: { paymentFlow } };
      expect(processor.supports(accept)).toBe(false);
      expect(await processor.verify({ ...payment, accepted: accept }, accept)).toMatchObject({ isValid: false });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains pending settlement hash and extensions for reconciliation', async () => {
    const pending = { ...receipt, success: false, errorReason: 'settlement_pending',
      extensions: { tracking: { pendingId: 'pending-1' } } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(pending))));
    const processor = createMcpFacilitatorProcessor({ networks: ['eip155:8453'] });
    expect(await processor.settle(payment, payment.accepted)).toEqual({ status: 'unknown',
      reason: 'settlement_pending', receipt: pending });
  });

  it('identifies the same Solana transaction after fee-payer signature changes', () => {
    const payer = Keypair.generate();
    const merchant = Keypair.generate();
    const message = new TransactionMessage({ payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: merchant.publicKey, lamports: 1 })],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    const network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
    const processor = createMcpFacilitatorProcessor({ networks: [network] });
    expect(processor.supports({ ...payment.accepted, network, extra: { assetTransferMethod: 'default' } })).toBe(true);
    expect(processor.supports({ ...payment.accepted, network, extra: { assetTransferMethod: 'unknown' } })).toBe(false);
    const unsigned = { ...payment, accepted: { ...payment.accepted, network },
      payload: { transaction: Buffer.from(transaction.serialize()).toString('base64') } };
    transaction.sign([payer]);
    const signed = { ...unsigned, payload: { transaction: Buffer.from(transaction.serialize()).toString('base64') } };
    expect(processor.identify(unsigned)).toBe(processor.identify(signed));
  });
});
