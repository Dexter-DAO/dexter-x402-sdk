import { describe, it, expect } from 'vitest';
import { applyExtensions } from '../extensions/registry';
import type { ResourceServerExtension, PaymentRequiredContext } from '../extensions/types';
import type { PaymentRequired } from '../../types';

const ctx: PaymentRequiredContext = {
  response: { x402Version: 2, accepts: [] } as unknown as PaymentRequired,
  request: { method: 'GET', path: '/x' },
};

describe('applyExtensions', () => {
  it('returns undefined when there are no extensions', async () => {
    expect(await applyExtensions([], {}, ctx)).toBeUndefined();
  });

  it('returns undefined when no extension produces output', async () => {
    const ext: ResourceServerExtension = { key: 'noop' };
    expect(await applyExtensions([ext], { noop: {} }, ctx)).toBeUndefined();
  });

  it('collects one extension output under its key', async () => {
    const ext: ResourceServerExtension = {
      key: 'demo',
      enrichPaymentRequiredResponse: () => ({ hello: 'world' }),
    };
    expect(await applyExtensions([ext], { demo: {} }, ctx)).toEqual({
      demo: { hello: 'world' },
    });
  });

  it('collects multiple extensions, each under its own key', async () => {
    const a: ResourceServerExtension = {
      key: 'a',
      enrichPaymentRequiredResponse: () => ({ v: 1 }),
    };
    const b: ResourceServerExtension = {
      key: 'b',
      enrichPaymentRequiredResponse: async () => ({ v: 2 }),
    };
    expect(await applyExtensions([a, b], { a: {}, b: {} }, ctx)).toEqual({
      a: { v: 1 },
      b: { v: 2 },
    });
  });

  it('skips an extension with no matching declaration', async () => {
    const ext: ResourceServerExtension = {
      key: 'demo',
      enrichPaymentRequiredResponse: () => ({ hello: 'world' }),
    };
    expect(await applyExtensions([ext], {}, ctx)).toBeUndefined();
  });

  it('omits an extension whose hook returns undefined', async () => {
    const a: ResourceServerExtension = {
      key: 'a',
      enrichPaymentRequiredResponse: () => undefined,
    };
    const b: ResourceServerExtension = {
      key: 'b',
      enrichPaymentRequiredResponse: () => ({ v: 2 }),
    };
    expect(await applyExtensions([a, b], { a: {}, b: {} }, ctx)).toEqual({
      b: { v: 2 },
    });
  });

  it('isolates a throwing extension — others still produce, no throw', async () => {
    const bad: ResourceServerExtension = {
      key: 'bad',
      enrichPaymentRequiredResponse: () => {
        throw new Error('boom');
      },
    };
    const good: ResourceServerExtension = {
      key: 'good',
      enrichPaymentRequiredResponse: () => ({ ok: true }),
    };
    const out = await applyExtensions([bad, good], { bad: {}, good: {} }, ctx);
    expect(out).toEqual({ good: { ok: true } });
  });
});
