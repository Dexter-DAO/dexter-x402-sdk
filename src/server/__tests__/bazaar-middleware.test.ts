import { describe, it, expect, vi, beforeEach } from 'vitest';
import { x402Middleware } from '../middleware';
import { bazaarExtension } from '../extensions/bazaar/index';
import { declareDiscoveryExtension } from '../extensions/bazaar/declare';

// Mock the facilitator: the middleware's 402 path resolves /supported via
// fetch. Return a minimal supported payload so the test runs offline.
const MOCK_SUPPORTED = {
  kinds: [
    {
      x402Version: 2,
      scheme: 'exact',
      network: 'eip155:8453',
      extra: { feePayer: '0xFee', decimals: 6, name: 'USD Coin', version: '2' },
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => MOCK_SUPPORTED,
    })),
  );
});

/** Minimal Express-like req/res doubles for driving the middleware. */
function makeReqRes(routePath: string, params: Record<string, string>) {
  const req = {
    method: 'GET',
    headers: {},
    path: routePath,
    route: { path: routePath },
    params,
    protocol: 'https',
    originalUrl: routePath,
    get: () => 'api.example.com',
  } as unknown as Parameters<ReturnType<typeof x402Middleware>>[0];

  let statusCode = 0;
  let body: unknown;
  const resImpl: {
    statusCode: number;
    setHeader: () => void;
    status: (c: number) => typeof resImpl;
    json: (b: unknown) => typeof resImpl;
  } = {
    statusCode: 0,
    setHeader: () => {},
    status(c: number) {
      statusCode = c;
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      body = b;
      return this;
    },
  };
  const res = resImpl as unknown as Parameters<ReturnType<typeof x402Middleware>>[1];

  return { req, res, getStatus: () => statusCode, getBody: () => body };
}

describe('x402Middleware + bazaar extension', () => {
  it('emits a 402 carrying extensions.bazaar when configured', async () => {
    const mw = x402Middleware({
      payTo: '0x402Feee072D655B85e08f1751AF9ddbCd249521f',
      network: 'eip155:8453',
      amount: '0.05',
      facilitatorUrl: 'https://facilitator.test',
      extensions: [bazaarExtension()],
      declarations: {
        ...declareDiscoveryExtension({
          method: 'GET',
          pathParamsSchema: {
            properties: { address: { type: 'string' } },
            required: ['address'],
          },
          output: { example: { address: 'X4o2', verdict: { wash_score: 0 } } },
        }),
      },
    });

    const { req, res, getStatus, getBody } = makeReqRes('/trust/wallet/:address', {
      address: 'X4o2',
    });
    await mw(req, res, () => {});

    expect(getStatus()).toBe(402);
    const body = getBody() as {
      accepts: unknown[];
      extensions?: { bazaar?: { info: { input: Record<string, unknown> }; schema: unknown; routeTemplate?: string } };
    };
    expect(body.accepts.length).toBeGreaterThan(0);
    expect(body.extensions).toBeDefined();
    expect(body.extensions!.bazaar).toBeDefined();
    expect(body.extensions!.bazaar!.info.input.method).toBe('GET');
    expect(body.extensions!.bazaar!.info.input.pathParams).toEqual({ address: 'X4o2' });
    expect(body.extensions!.bazaar!.routeTemplate).toBe('/trust/wallet/:address');
    expect(body.extensions!.bazaar!.schema).toBeDefined();
  });

  it('emits a 402 with NO extensions key when none configured (backward-compat)', async () => {
    const mw = x402Middleware({
      payTo: '0x402Feee072D655B85e08f1751AF9ddbCd249521f',
      network: 'eip155:8453',
      amount: '0.05',
      facilitatorUrl: 'https://facilitator.test',
    });

    const { req, res, getStatus, getBody } = makeReqRes('/trust/wallet/:address', {
      address: 'X4o2',
    });
    await mw(req, res, () => {});

    expect(getStatus()).toBe(402);
    expect((getBody() as Record<string, unknown>).extensions).toBeUndefined();
  });
});
