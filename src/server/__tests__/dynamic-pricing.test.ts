import { describe, it, expect } from 'vitest';
import { createDynamicPricing } from '../dynamic-pricing';

describe('Dynamic Pricing', () => {
  it('calculates correct price for character-based input', () => {
    const pricing = createDynamicPricing({
      unitSize: 100,     // 100 chars per unit
      ratePerUnit: 0.01, // $0.01 per unit
    });

    // 250 chars = 3 units (ceil), 3 × $0.01 = $0.03 = 30000 atomic
    const quote = pricing.calculate('x'.repeat(250));
    expect(quote.units).toBe(3);
    expect(quote.usdAmount).toBe(0.03);
    expect(quote.amountAtomic).toBe('30000');
  });

  it('enforces minimum price', () => {
    const pricing = createDynamicPricing({
      unitSize: 1000,
      ratePerUnit: 0.001,
      minUsd: 0.01,
    });

    // 10 chars = 1 unit, 1 × $0.001 = $0.001, but min is $0.01
    const quote = pricing.calculate('x'.repeat(10));
    expect(quote.usdAmount).toBe(0.01);
  });

  it('enforces maximum price', () => {
    const pricing = createDynamicPricing({
      unitSize: 1,
      ratePerUnit: 1.00,
      maxUsd: 5.00,
    });

    // 1000 chars = 1000 units × $1.00 = $1000, but max is $5.00
    const quote = pricing.calculate('x'.repeat(1000));
    expect(quote.usdAmount).toBe(5.00);
  });

  it('validates own quotes (HMAC integrity)', () => {
    const pricing = createDynamicPricing({
      unitSize: 100,
      ratePerUnit: 0.01,
    });

    const input = 'Hello, world! This is a test prompt.';
    const quote = pricing.calculate(input);

    // Same input, same instance → valid
    expect(pricing.validateQuote(input, quote.quoteHash)).toBe(true);
  });

  it('rejects quotes with tampered input', () => {
    const pricing = createDynamicPricing({
      unitSize: 100,
      ratePerUnit: 0.01,
    });

    const quote = pricing.calculate('expensive prompt');
    // Attacker substitutes cheaper input but reuses the quote hash
    expect(pricing.validateQuote('cheap', quote.quoteHash)).toBe(false);
  });

  it('rejects quotes from a different pricing instance', () => {
    const pricing1 = createDynamicPricing({ unitSize: 100, ratePerUnit: 0.01 });
    const pricing2 = createDynamicPricing({ unitSize: 100, ratePerUnit: 0.01 });

    const input = 'test';
    const quote = pricing1.calculate(input);

    // Different instance = different HMAC secret → invalid
    expect(pricing2.validateQuote(input, quote.quoteHash)).toBe(false);
  });

  it('rejects expired quotes', () => {
    const pricing = createDynamicPricing({
      unitSize: 100,
      ratePerUnit: 0.01,
    });

    const input = 'test';
    const quote = pricing.calculate(input);

    // Forge a quote hash with a timestamp 10 minutes ago (beyond 5-min TTL)
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
    const forgedHash = `${oldTimestamp}.${quote.quoteHash.split('.')[1]}`;
    expect(pricing.validateQuote(input, forgedHash)).toBe(false);
  });

  it('rejects malformed quote hashes', () => {
    const pricing = createDynamicPricing({ unitSize: 100, ratePerUnit: 0.01 });
    expect(pricing.validateQuote('test', '')).toBe(false);
    expect(pricing.validateQuote('test', 'no-dot-here')).toBe(false);
    expect(pricing.validateQuote('test', 'notanumber.abc')).toBe(false);
  });

  it('throws on invalid config', () => {
    expect(() => createDynamicPricing({ unitSize: 0, ratePerUnit: 0.01 })).toThrow();
    expect(() => createDynamicPricing({ unitSize: 100, ratePerUnit: -1 })).toThrow();
    expect(() => createDynamicPricing({ unitSize: 100, ratePerUnit: 0.01, maxUsd: 0.001, minUsd: 1.0 })).toThrow();
  });
});
