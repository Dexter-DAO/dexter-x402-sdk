import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createX402Server } from '../x402-server';

/**
 * scheme: 'tab' — the seller's half of One-Tap-Sessions (Option A).
 *
 * The accepts entry advertises wire scheme 'tab' with payTo as the seller
 * settlement address (the on-chain counterparty binding that seeds the
 * per-counterparty session PDA), and the SDK itself surfaces the voucher
 * transport (voucherHeader / registrationEncoding) in the accepts extra.
 *
 * NOTE: as in batch-settlement-scheme.test.ts, X402ServerConfig has no
 * injectable facilitator — the seam is the global `fetch` that
 * FacilitatorClient.getNetworkExtra hits via `/supported`. getNetworkExtra
 * sources feePayer from the network's 'exact' kind; the tab transport fields
 * are added by the SDK, not fetched.
 */

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SELLER = 'X4o2D8op42a2jcNJJVZcDq3eYivh1oR9XiezPWCXosZ';
const FEE_PAYER = 'FeePayer1111111111111111111111111111111111';

describe("scheme: 'tab' accepts entry", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.restoreAllMocks());

  it('rejects tab on an EVM network at construction', () => {
    expect(() =>
      createX402Server({
        payTo: '0x' + '1'.repeat(40),
        network: 'eip155:8453',
        scheme: 'tab',
      }),
    ).toThrow(/SVM-only/);
  });

  it('advertises scheme tab with payTo = the seller and the voucher transport extra', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: SOLANA,
            extra: { feePayer: FEE_PAYER, decimals: 6 },
          },
        ],
      }),
    });

    const server = createX402Server({
      payTo: SELLER,
      network: SOLANA,
      scheme: 'tab',
      facilitatorUrl: 'https://test.facilitator',
    });

    const accept = await server.getPaymentAccept({
      amountAtomic: '50000',
      resourceUrl: '/api/protected',
    });

    expect(accept.scheme).toBe('tab');
    expect(accept.payTo).toBe(SELLER);
    expect(accept.extra?.voucherHeader).toBe('x-tab-voucher');
    expect(accept.extra?.registrationEncoding).toBe(
      'base64(188-byte sessionRegisterMessage)',
    );
    // SVM invariant still holds for tab: feePayer flows through from the facilitator.
    expect(accept.extra?.feePayer).toBe(FEE_PAYER);
  });
});
