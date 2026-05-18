// src/payment/__tests__/v2-strategy.test.ts
import { describe, it, expect } from 'vitest';
import { v2Strategy } from '../v2-strategy';
import { makeV2Response, makeV1Response } from './fixtures';

describe('v2Strategy.parseChallenge', () => {
  it('parses a v2 PAYMENT-REQUIRED header challenge', async () => {
    const c = await v2Strategy.parseChallenge(makeV2Response());
    expect(c).not.toBeNull();
    expect(c!.x402Version).toBe(2);
    expect(c!.options).toHaveLength(1);
    expect(c!.options[0].amount).toBe('2000');
    expect(c!.options[0].network.caip2).toBe('eip155:8453');
    expect(c!.options[0].network.bare).toBe('base');
  });

  it('returns null for a v1 (body-only) response — not its version', async () => {
    const c = await v2Strategy.parseChallenge(makeV1Response());
    expect(c).toBeNull();
  });

  it('exposes version 2', () => {
    expect(v2Strategy.version).toBe(2);
  });
});
