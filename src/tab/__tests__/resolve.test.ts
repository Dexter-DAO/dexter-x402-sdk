import { describe, it, expect } from 'vitest';
import { resolveTabOffer } from '../resolve';

const SELLER = 'GmaDrppjnZBxjBVgxiZJWFY7tXJVHTYUBVoBtmofpNNw'; // any valid base58 pubkey
const CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function encode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function challenge402(accepts: unknown[], resourceUrl = 'http://s/paid'): Response {
  return new Response(JSON.stringify({ error: 'Payment required', accepts }), {
    status: 402,
    headers: {
      'payment-required': encode({ accepts, resource: { url: resourceUrl } }),
    },
  });
}

const tabAccept = {
  scheme: 'tab',
  network: CAIP2,
  maxAmountRequired: '10000',
  asset: USDC,
  payTo: SELLER,
  maxTimeoutSeconds: 60,
  extra: { voucherHeader: 'x-tab-voucher' },
};

const fetchReturning = (res: Response) => (async () => res) as unknown as typeof fetch;

describe('resolveTabOffer', () => {
  it('extracts the tab offer from a standard v2 402 challenge', async () => {
    const out = await resolveTabOffer('http://s/paid', {}, fetchReturning(challenge402([tabAccept])));
    expect(out.kind).toBe('offer');
    if (out.kind !== 'offer') return;
    expect(out.offer.payTo).toBe(SELLER);
    expect(out.offer.amountAtomic).toBe('10000');
    expect(out.offer.networkCaip2).toBe(CAIP2);
    expect(out.offer.resourceUrl).toBe('http://s/paid');
  });

  it('returns free for a 200 response', async () => {
    const out = await resolveTabOffer('http://s/free', {}, fetchReturning(new Response('ok', { status: 200 })));
    expect(out.kind).toBe('free');
  });

  it('returns no_tab when only other schemes are offered', async () => {
    const out = await resolveTabOffer('http://s/paid', {}, fetchReturning(
      challenge402([{ ...tabAccept, scheme: 'exact' }]),
    ));
    expect(out.kind).toBe('no_tab');
    if (out.kind !== 'no_tab') return;
    expect(out.schemesOffered).toEqual(['exact']);
  });

  it('errors on a 402 without a PAYMENT-REQUIRED header', async () => {
    const out = await resolveTabOffer('http://s/paid', {}, fetchReturning(
      new Response(JSON.stringify({ error: 'invalid_voucher' }), { status: 402 }),
    ));
    expect(out.kind).toBe('error');
  });

  it('errors when the tab payTo is not a valid pubkey', async () => {
    const out = await resolveTabOffer('http://s/paid', {}, fetchReturning(
      challenge402([{ ...tabAccept, payTo: 'not-a-pubkey' }]),
    ));
    expect(out.kind).toBe('error');
  });

  it('errors on non-402 failure statuses', async () => {
    const out = await resolveTabOffer('http://s/paid', {}, fetchReturning(new Response('boom', { status: 500 })));
    expect(out.kind).toBe('error');
  });
});
