// src/payment/__tests__/v1-strategy.test.ts
import { describe, it, expect } from 'vitest';
import { v1Strategy } from '../v1-strategy';
import { makeV1Response, makeV2Response, makeEmptyResponse } from './fixtures';

describe('v1Strategy.parseChallenge', () => {
  it('parses a v1 body challenge', async () => {
    const c = await v1Strategy.parseChallenge(makeV1Response());
    expect(c).not.toBeNull();
    expect(c!.x402Version).toBe(1);
    expect(c!.options[0].amount).toBe('10000'); // from maxAmountRequired
    expect(c!.options[0].network.bare).toBe('base');
    expect(c!.options[0].network.caip2).toBe('eip155:8453');
  });

  it('returns null for a v2 response — handled by v2Strategy', async () => {
    // A v2 response has a PAYMENT-REQUIRED header; v1 should decline it
    // so the dispatcher picks v2 first regardless of body contents.
    const c = await v1Strategy.parseChallenge(makeV2Response());
    expect(c).toBeNull();
  });

  it('returns null for a 402 with no usable challenge', async () => {
    const c = await v1Strategy.parseChallenge(makeEmptyResponse());
    expect(c).toBeNull();
  });

  it('exposes version 1', () => {
    expect(v1Strategy.version).toBe(1);
  });
});
