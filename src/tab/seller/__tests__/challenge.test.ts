import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tabChallengeMiddleware } from '../challenge';
import { v2Strategy } from '../../../payment/v2-strategy';

const SELLER = 'GmaDrppjnZBxjBVgxiZJWFY7tXJVHTYUBVoBtmofpNNw';
const CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const FEE_PAYER = '4Nd1mY5K6kBpFNDdYWvvz4gG8hpHQNYJdEPGuoNFhq9b';

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: any) => {
    const u = String(input);
    if (u.endsWith('/supported')) {
      return new Response(JSON.stringify({
        kinds: [{
          x402Version: 2,
          scheme: 'exact',
          network: CAIP2,
          extra: { feePayer: FEE_PAYER, decimals: 6 },
        }],
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as any;
});
afterEach(() => { globalThis.fetch = realFetch; });

function fakeReqRes(headers: Record<string, string> = {}) {
  const req: any = {
    headers,
    protocol: 'http',
    originalUrl: '/paid/tick',
    get: (h: string) => (h.toLowerCase() === 'host' ? '127.0.0.1:4455' : undefined),
  };
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    set(h: Record<string, string>) { Object.assign(this.headers, h); return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return { req, res };
}

const mw = () => tabChallengeMiddleware({
  sellerPubkey: SELLER,
  network: 'solana:mainnet',
  perUnit: '0.01',
  facilitatorUrl: 'http://127.0.0.1:4072',
});

/** Decode the base64-encoded PAYMENT-REQUIRED header into the requirements object */
function decodePaymentRequired(header: string): Record<string, unknown> {
  const padded = header.replace(/-/g, '+').replace(/_/g, '/');
  const normalized = padded + '='.repeat((4 - (padded.length % 4 || 4)) % 4);
  return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
}

describe('tabChallengeMiddleware', () => {
  it('answers a voucher-less request with a standard 402 tab challenge', async () => {
    const { req, res } = fakeReqRes();
    const next = vi.fn();
    await mw()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect(res.headers['PAYMENT-REQUIRED']).toBeTruthy();
    // The requirements are encoded in the header, not the body (body is {}).
    const requirements = decodePaymentRequired(res.headers['PAYMENT-REQUIRED']);
    const accepts = (requirements as any).accepts;
    expect(accepts).toHaveLength(1);
    expect(accepts[0].scheme).toBe('tab');
    expect(accepts[0].payTo).toBe(SELLER);
    // The CAIP-2 form — NOT the SDK-internal 'solana:mainnet' alias, which
    // standard buyers (toNetworkRef) silently drop.
    expect(accepts[0].network).toBe(CAIP2);
    expect(accepts[0].maxAmountRequired).toBe('10000');
  });

  it('INTEROP RECEIPT: the emitted challenge parses under the standard v2 buyer', async () => {
    const { req, res } = fakeReqRes();
    await mw()(req, res, vi.fn());
    const wire = new Response(JSON.stringify(res.body), {
      status: 402,
      headers: { 'payment-required': res.headers['PAYMENT-REQUIRED'] },
    });
    const challenge = await v2Strategy.parseChallenge(wire);
    expect(challenge).not.toBeNull();
    const tab = challenge!.options.find((o) => o.scheme === 'tab');
    expect(tab).toBeDefined();
    expect(tab!.payTo).toBe(SELLER);
    expect(tab!.network.family).toBe('svm');
  });

  it('passes voucher-carrying requests through to tabMiddleware', async () => {
    const { req, res } = fakeReqRes({ 'x-tab-voucher': 'anything' });
    const next = vi.fn();
    await mw()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0); // untouched
  });
});
