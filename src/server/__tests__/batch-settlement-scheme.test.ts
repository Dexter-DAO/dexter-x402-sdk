import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createX402Server } from '../x402-server';

/**
 * The server is a thin pass-through: when configured with
 * scheme: 'batch-settlement', the PaymentAccept it builds must carry that
 * scheme (not the hardcoded 'exact').
 *
 * NOTE: the real X402ServerConfig has no injectable `facilitator` field —
 * createX402Server builds a FacilitatorClient internally from `facilitatorUrl`.
 * The available seam to run without a network is the global `fetch`, which
 * FacilitatorClient.getNetworkExtra hits via `/supported`. We stub it here,
 * exactly as facilitator-client.test.ts does. The facilitator advertises
 * `receiverAuthorizer` in its batch-settlement kind's extra.
 */
describe('createX402Server — batch-settlement scheme', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.restoreAllMocks());

  it("builds a PaymentAccept with scheme 'batch-settlement' when configured", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        kinds: [
          {
            x402Version: 2,
            scheme: 'batch-settlement',
            network: 'eip155:8453',
            extra: {
              decimals: 6,
              name: 'USD Coin',
              version: '2',
              receiverAuthorizer: '0x88559c293Aa9A27707e66CE69F0b40eb8E9aecfB',
            },
          },
        ],
      }),
    });

    const server = createX402Server({
      payTo: '0x00AC604E07eA856235C746F45362f1BFfc030Ab9',
      network: 'eip155:8453',
      asset: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      scheme: 'batch-settlement',
      facilitatorUrl: 'https://test.facilitator',
    });

    const accept = await server.getPaymentAccept({
      amountAtomic: '80000',
      resourceUrl: '/api/protected',
    });
    expect(accept.scheme).toBe('batch-settlement');
    expect(accept.extra?.receiverAuthorizer).toBe(
      '0x88559c293Aa9A27707e66CE69F0b40eb8E9aecfB',
    );
  });

  it("defaults to scheme 'exact' when scheme is not configured", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: 'eip155:8453',
            extra: { decimals: 6, name: 'USD Coin', version: '2' },
          },
        ],
      }),
    });

    const server = createX402Server({
      payTo: '0x00AC604E07eA856235C746F45362f1BFfc030Ab9',
      network: 'eip155:8453',
      asset: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      facilitatorUrl: 'https://test.facilitator',
    });
    const accept = await server.getPaymentAccept({
      amountAtomic: '80000',
      resourceUrl: '/api/protected',
    });
    expect(accept.scheme).toBe('exact');
  });
});
