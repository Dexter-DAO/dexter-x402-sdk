import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createX402Client, getPaymentReceipt } from '../x402-client';
import type { ChainAdapter } from '../../adapters/types';
import type { PaymentAccept } from '../../types';

const accept: PaymentAccept = {
  scheme: 'exact', network: 'eip155:8453', amount: '1', asset: 'fixture', payTo: 'fixture',
  maxTimeoutSeconds: 1, extra: { decimals: 6 },
};

describe('paid HTTP dispatch', () => {
  it.each([502, 503, 504, 307, 'reset'] as const)('keeps unpaid retries while dispatching payment once after %s', async mode => {
    let unpaidRequests = 0;
    let paidRequests = 0;
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url!);
      if (req.headers['payment-signature']) {
        paidRequests++;
        if (mode === 'reset') { req.socket.destroy(); return; }
        res.writeHead(mode, {
          ...(mode === 307 ? { Location: '/redirected-paid-request' } : {}),
          'PAYMENT-RESPONSE': btoa(JSON.stringify({ success: false, network: accept.network, errorCode: 'settlement_unknown' })),
        });
        res.end('saved uncertain response');
        return;
      }
      unpaidRequests++;
      if (unpaidRequests === 1) { res.writeHead(503); res.end('unpaid retry'); return; }
      res.writeHead(402, { 'PAYMENT-REQUIRED': btoa(JSON.stringify({ x402Version: 2, accepts: [accept] })) });
      res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const buildTransaction = vi.fn(async () => ({ serialized: JSON.stringify({ fixture: true }) }));
    const adapter: ChainAdapter = {
      name: 'EVM', networks: [accept.network], canHandle: () => true, isConnected: () => true,
      getDefaultRpcUrl: () => 'http://unused.invalid', getAddress: () => 'fixture',
      getBalance: async () => 1, buildTransaction,
    };
    try {
      const client = createX402Client({ adapters: [adapter],
        wallets: { evm: { address: '0x1111111111111111111111111111111111111111' } },
        maxRetries: 3, retryDelayMs: 1 });
      const request = client.fetch(`http://127.0.0.1:${address.port}/report`);
      if (mode === 'reset') {
        await expect(request).rejects.toThrow();
      } else {
        const response = await request;
        expect(response.status).toBe(mode);
        expect(getPaymentReceipt(response)?.settlementStatus).toBe('pending');
        expect(await response.text()).toBe('saved uncertain response');
      }
      expect(unpaidRequests).toBe(2);
      expect(paidRequests).toBe(1);
      expect(buildTransaction).toHaveBeenCalledTimes(1);
      expect(paths).toEqual(['/report', '/report', '/report']);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });
});
