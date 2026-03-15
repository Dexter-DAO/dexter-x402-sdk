import { describe, it, expect } from 'vitest';
import { getSponsoredRecommendations, getSponsoredAccessInfo, fireImpressionBeacon } from '../sponsored-access';

describe('Sponsored Access Client Helpers', () => {
  it('returns undefined when response has no receipt', () => {
    const response = new Response('{}', { status: 200 });
    expect(getSponsoredRecommendations(response)).toBeUndefined();
    expect(getSponsoredAccessInfo(response)).toBeUndefined();
  });

  it('returns undefined for a response that never went through x402', () => {
    const response = new Response('{"data": "free content"}', { status: 200 });
    expect(getSponsoredRecommendations(response)).toBeUndefined();
  });

  it('fireImpressionBeacon returns false when no beacon URL', async () => {
    const response = new Response('{}', { status: 200 });
    const result = await fireImpressionBeacon(response);
    expect(result).toBe(false);
  });
});
