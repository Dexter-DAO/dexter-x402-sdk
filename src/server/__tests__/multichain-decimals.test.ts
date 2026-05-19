import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { x402Middleware } from '../middleware';
import { BSC_MAINNET_NETWORK, BASE_MAINNET_NETWORK, BSC_USDC, USDC_BASE } from '../../constants';

/**
 * Regression guard for the per-network 402 amount bug.
 *
 * USDC is 6 decimals on every supported chain EXCEPT BSC, where it is 18.
 * The multi-chain middleware must convert the USD price into atomic units
 * with EACH network's own decimals. A single pre-converted amount misquotes
 * BSC by 12 orders of magnitude — telling a paying agent to send 0.000000000001
 * of the intended value (or, the other direction, a trillion times too much).
 *
 * This drives a real `x402Middleware` end-to-end with the facilitator's
 * /supported endpoint mocked offline, captures the 402 JSON, and asserts the
 * `accepts` entry for `eip155:56` is quoted in 18-decimal atomic units while
 * `eip155:8453` stays at 6.
 */

// Facilitator /supported response covering BSC + Base. Both EVM, so no
// feePayer is required (only Solana networks demand one). `decimals` is
// intentionally per-network: 18 for BSC, 6 for Base — matching what the
// real facilitator advertises.
const MOCK_SUPPORTED = {
  kinds: [
    {
      x402Version: 2,
      scheme: 'exact',
      network: BSC_MAINNET_NETWORK,
      extra: { decimals: 18, name: 'USD Coin', version: '1' },
    },
    {
      x402Version: 2,
      scheme: 'exact',
      network: BASE_MAINNET_NETWORK,
      extra: { decimals: 6, name: 'USD Coin', version: '2' },
    },
  ],
};

/** Minimal Express req with no payment-signature header → forces a 402. */
function mockRequest(): Request {
  return {
    headers: {},
    protocol: 'https',
    originalUrl: '/api/protected',
    get: (name: string) => (name.toLowerCase() === 'host' ? 'example.com' : undefined),
  } as unknown as Request;
}

/** Express res double that captures status + JSON body. */
function mockResponse() {
  const captured: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, captured };
}

/** Drive a middleware through a no-payment request and return the 402 accepts. */
async function get402Accepts(amount: string) {
  const middleware = x402Middleware({
    payTo: { 'eip155:*': '0x00AC604E07eA856235C746F45362f1BFfc030Ab9' },
    amount,
    network: [BSC_MAINNET_NETWORK, BASE_MAINNET_NETWORK],
  });

  const { res, captured } = mockResponse();
  await (middleware as (req: Request, res: Response, next: () => void) => Promise<void>)(
    mockRequest(),
    res,
    () => {
      throw new Error('next() should not be called for an unpaid request');
    },
  );

  expect(captured.status).toBe(402);
  const body = captured.body as { accepts: Array<{ network: string; amount: string; extra?: { decimals?: number } }> };
  return body.accepts;
}

describe('x402Middleware — per-network 402 amount decimals', () => {
  beforeEach(() => {
    // Offline: /supported is the only network call buildRequirements makes.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => MOCK_SUPPORTED })),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('quotes $1.00 as 18-decimal atomic on BSC and 6-decimal on Base', async () => {
    const accepts = await get402Accepts('1.00');

    const bsc = accepts.find((a) => a.network === BSC_MAINNET_NETWORK)!;
    const base = accepts.find((a) => a.network === BASE_MAINNET_NETWORK)!;

    expect(bsc).toBeDefined();
    expect(base).toBeDefined();

    // 1.00 USD × 10^18 vs × 10^6
    expect(bsc.amount).toBe('1000000000000000000');
    expect(base.amount).toBe('1000000');

    // The advertised asset is BSC's 18-decimal USDC vs Base's 6-decimal USDC.
    expect(bsc.extra?.decimals).toBe(18);
    expect(base.extra?.decimals).toBe(6);
  });

  it('quotes a sub-dollar amount ($0.05) correctly per network', async () => {
    // Cents prove it is real per-network conversion, not whole-dollar luck.
    const accepts = await get402Accepts('0.05');

    const bsc = accepts.find((a) => a.network === BSC_MAINNET_NETWORK)!;
    const base = accepts.find((a) => a.network === BASE_MAINNET_NETWORK)!;

    // 0.05 USD × 10^18 vs × 10^6
    expect(bsc.amount).toBe('50000000000000000');
    expect(base.amount).toBe('50000');
  });

  it('advertises the correct per-chain USDC contract address', async () => {
    const accepts = await get402Accepts('1.00');

    const bsc = accepts.find((a) => a.network === BSC_MAINNET_NETWORK) as
      | { asset?: string }
      | undefined;
    const base = accepts.find((a) => a.network === BASE_MAINNET_NETWORK) as
      | { asset?: string }
      | undefined;

    expect(bsc?.asset).toBe(BSC_USDC);
    expect(base?.asset).toBe(USDC_BASE);
  });
});
