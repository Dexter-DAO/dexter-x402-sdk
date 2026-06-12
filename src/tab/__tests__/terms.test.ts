import { describe, it, expect, vi } from 'vitest';
import { resolveTabTerms, type TabTerms } from '../terms';

const CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SELLER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function challenge402(accepts: unknown[]): Response {
  const payload = { x402Version: 2, resource: { url: 'https://s.example/tick' }, accepts, error: 'Payment required' };
  const header = Buffer.from(JSON.stringify(payload)).toString('base64');
  return new Response(JSON.stringify({}), { status: 402, headers: { 'PAYMENT-REQUIRED': header } });
}

const TAB_ACCEPT = {
  scheme: 'tab', network: CAIP2, amount: '10000', maxAmountRequired: '10000',
  asset: USDC, payTo: SELLER, maxTimeoutSeconds: 60,
  extra: { feePayer: SELLER, decimals: 6 },
};

describe('resolveTabTerms', () => {
  it('maps an offer to typed tab terms', async () => {
    const fetchImpl = vi.fn(async () => challenge402([TAB_ACCEPT]));
    const result = await resolveTabTerms('https://s.example/tick', {}, { fetchImpl });
    expect(result.kind).toBe('terms');
    if (result.kind !== 'terms') throw new Error('unreachable');
    const t: TabTerms = result.terms;
    expect(t.counterparty).toBe(SELLER);
    expect(t.perRequest.atomic).toBe('10000');
    expect(t.perRequest.human).toBe('0.01');
    expect(t.asset).toBe(USDC);
    expect(t.network.caip2).toBe(CAIP2);
    expect(t.scheme).toBe('tab');
    expect(t.settlement).toEqual({ custody: 'non-custodial', protection: 'freeze', settleOn: 'close' });
    expect(t.credit).toBeNull();
  });

  it('caches by URL: second call does not re-probe and returns the same terms', async () => {
    const fetchImpl = vi.fn(async () => challenge402([TAB_ACCEPT]));
    const cache = new Map<string, TabTerms>();
    const first = await resolveTabTerms('https://s.example/tick', {}, { fetchImpl, cache });
    const second = await resolveTabTerms('https://s.example/tick', {}, { fetchImpl, cache });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    if (first.kind !== 'terms' || second.kind !== 'terms') throw new Error('unreachable');
    expect(second.terms).toBe(first.terms);
  });

  it('passes through no_tab without caching', async () => {
    const fetchImpl = vi.fn(async () => challenge402([{ ...TAB_ACCEPT, scheme: 'exact' }]));
    const cache = new Map<string, TabTerms>();
    const result = await resolveTabTerms('https://s.example/tick', {}, { fetchImpl, cache });
    expect(result.kind).toBe('no_tab');
    if (result.kind !== 'no_tab') throw new Error('unreachable');
    expect(result.schemesOffered).toEqual(['exact']);
    expect(cache.size).toBe(0);
  });

  it('passes through free (caller owns the live response body)', async () => {
    const fetchImpl = vi.fn(async () => new Response('hi', { status: 200 }));
    const result = await resolveTabTerms('https://s.example/tick', {}, { fetchImpl });
    expect(result.kind).toBe('free');
    if (result.kind !== 'free') throw new Error('unreachable');
    expect(await result.response.text()).toBe('hi');
  });

  it('passes through probe errors', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const result = await resolveTabTerms('https://s.example/tick', {}, { fetchImpl });
    expect(result.kind).toBe('error');
  });
});
