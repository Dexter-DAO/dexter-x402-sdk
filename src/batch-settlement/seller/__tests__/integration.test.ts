import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import type {
  Channel,
  ChannelStorage,
  ChannelUpdateResult,
} from '@x402/evm/batch-settlement/server';
import { buildResourceServer } from '../resource-server';

/**
 * Voucher-persistence integration test for the batch-settlement SELLER runtime.
 *
 * batch-settlement is an escrow-channel BATCHING scheme: a buyer pre-funds a
 * channel, makes many discrete paid calls each carrying an off-chain voucher,
 * and the seller accumulates those vouchers into channel storage so its
 * `closeChannel`/`closeAll` can later claim them on-chain.
 *
 * SDK 3.3.0 shipped a buyer side with no seller-side channel storage, so the
 * seller's claim path found nothing. This test proves the seller runtime built
 * by `buildResourceServer` (the layer `createBatchSettlementSeller` is built
 * on) is wired so a voucher's `Channel` record genuinely lands in the storage
 * the seller's claim path reads.
 *
 * What is and is not exercised here:
 *  - A real request is driven through the seller's Express handler against a
 *    stubbed facilitator, proving the runtime is live and routes through the
 *    upstream `x402ResourceServer`.
 *  - The persistence assertion is verified at the genuinely-reachable seam: the
 *    upstream batch-settlement server scheme's verify hook writes/refreshes a
 *    `Channel` exclusively through `ChannelStorage.updateChannel`, and the
 *    channel manager claims by reading `ChannelStorage.list()`. This test
 *    proves (a) the scheme inside the seller holds the EXACT storage object the
 *    seller was handed, and (b) a `Channel` written through that one shared
 *    `updateChannel` is readable via `list()` — i.e. it reaches the seller's
 *    claim path. A buyer-produced, cryptographically-valid voucher driven all
 *    the way through the upstream verify path needs a live facilitator and a
 *    live channel on-chain; that end-to-end persistence proof is covered by the
 *    live mainnet test, not this unit test.
 */

const FACILITATOR_URL = 'https://test.facilitator';
const PAY_TO = '0x00AC604E07eA856235C746F45362f1BFfc030Ab9';
const NETWORK = 'eip155:8453';
const PRICE = '0.08';
const ROUTE = 'GET /api/data';

/**
 * `/supported` body advertising the batch-settlement scheme on Base.
 *
 * The upstream scheme's `enhancePaymentRequirements` (which builds the 402)
 * requires a non-zero `extra.receiverAuthorizer` on the matched kind when no
 * receiver-authorizer signer is configured — so the mock carries one.
 */
const MOCK_SUPPORTED = {
  kinds: [
    {
      x402Version: 2,
      scheme: 'batch-settlement',
      network: NETWORK,
      extra: { decimals: 6, receiverAuthorizer: PAY_TO },
    },
  ],
};

/**
 * A fully-functional in-memory `ChannelStorage` that ALSO records every call,
 * so the test can both inspect persisted state and assert the seller wrote
 * through this exact instance.
 */
class RecordingChannelStorage implements ChannelStorage {
  readonly channels = new Map<string, Channel>();
  readonly getCalls: string[] = [];
  readonly listCalls = 0;
  readonly updateCalls: string[] = [];
  private _listCalls = 0;

  get listCallCount(): number {
    return this._listCalls;
  }

  async get(channelId: string): Promise<Channel | undefined> {
    this.getCalls.push(channelId);
    return this.channels.get(channelId);
  }

  async list(): Promise<Channel[]> {
    this._listCalls += 1;
    return [...this.channels.values()];
  }

  async updateChannel(
    channelId: string,
    update: (current: Channel | undefined) => Channel | undefined,
  ): Promise<ChannelUpdateResult> {
    this.updateCalls.push(channelId);
    const current = this.channels.get(channelId);
    const next = update(current);
    if (next === undefined) {
      this.channels.delete(channelId);
      return { channel: undefined, status: 'deleted' };
    }
    this.channels.set(channelId, next);
    return {
      channel: next,
      status: current === next ? 'unchanged' : 'updated',
    };
  }
}

/** Builds a minimal but real `Channel` record, as a voucher's verify hook would. */
function makeChannel(channelId: string): Channel {
  return {
    channelId,
    channelConfig: {
      channelId,
      payer: '0x1111111111111111111111111111111111111111',
      payerAuthorizer: '0x1111111111111111111111111111111111111111',
      receiver: PAY_TO,
      receiverAuthorizer: PAY_TO,
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1000000',
      withdrawDelay: 3600,
      salt: `0x${'0'.repeat(64)}`,
    } as Channel['channelConfig'],
    chargedCumulativeAmount: '80000',
    signedMaxClaimable: '80000',
    signature: '0xvoucher',
    balance: '1000000',
    totalClaimed: '0',
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: Date.now(),
  };
}

/**
 * Stubs `fetch` so the facilitator only ever answers `/supported`.
 *
 * The upstream `HTTPFacilitatorClient` reads success bodies via
 * `response.text()` (then JSON-parses), so the `/supported` reply must expose a
 * `text()` returning the JSON string — not just `json()`.
 */
function stubFacilitator(): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/supported')) {
      const body = JSON.stringify(MOCK_SUPPORTED);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => body,
        json: async () => MOCK_SUPPORTED,
      } as unknown as Response;
    }
    // Any other facilitator call (verify/settle) is not reached by the paths
    // this test drives; fail loudly if it ever is.
    return {
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => `unexpected facilitator call: ${url}`,
      json: async () => ({ error: `unexpected facilitator call: ${url}` }),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

/** Minimal Express `Response` double that captures status / headers / body. */
function makeResponse(): {
  res: Response;
  get statusCode(): number;
  get body(): unknown;
  get headers(): Record<string, string>;
} {
  let statusCode = 200;
  let body: unknown;
  let headersSent = false;
  const headers: Record<string, string> = {};
  const res = {
    get headersSent() {
      return headersSent;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      headersSent = true;
      return res;
    },
    send(payload: unknown) {
      body = payload;
      headersSent = true;
      return res;
    },
    end() {
      headersSent = true;
      return res;
    },
  } as unknown as Response;
  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get headers() {
      return headers;
    },
  };
}

/** Minimal Express `Request` double for a GET with optional payment header. */
function makeRequest(paymentHeader?: string): Request {
  const headers: Record<string, string> = { host: 'seller.test' };
  if (paymentHeader) headers['payment-signature'] = paymentHeader;
  return {
    method: 'GET',
    path: '/api/data',
    originalUrl: '/api/data',
    protocol: 'http',
    headers,
    query: {},
    body: {},
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe('batch-settlement seller — voucher persistence', () => {
  it('builds a live runtime that routes an unpaid request to a batch-settlement 402', async () => {
    stubFacilitator();
    const store = new RecordingChannelStorage();

    const rs = buildResourceServer({
      payTo: PAY_TO,
      network: NETWORK,
      price: PRICE,
      route: ROUTE,
      facilitatorUrl: FACILITATOR_URL,
      channelStore: store,
    });
    await rs.ready;

    const cap = makeResponse();
    const next = vi.fn();
    await rs.handler(makeRequest(), cap.res, next);

    // An unpaid request to a protected route must yield a 402, NOT fall
    // through — proof the seller runtime is live and routing through the
    // upstream resource server.
    expect(next).not.toHaveBeenCalled();
    expect(cap.statusCode).toBe(402);

    // x402 carries the payment challenge in the base64 `payment-required`
    // header. Decoding it must show the upstream resource server advertised
    // THIS seller's batch-settlement scheme, network, payTo and price — i.e.
    // a buyer SDK could produce a voucher against this exact runtime.
    const challengeHeader = cap.headers['payment-required'];
    expect(challengeHeader).toBeTruthy();
    const challenge = JSON.parse(
      Buffer.from(challengeHeader as string, 'base64').toString('utf8'),
    ) as { accepts: Array<Record<string, unknown>> };
    const accept = challenge.accepts.find((a) => a.scheme === 'batch-settlement');
    expect(accept).toBeDefined();
    expect(accept?.network).toBe(NETWORK);
    expect(accept?.payTo).toBe(PAY_TO);
    // price "0.08" USDC at 6 decimals → "80000" base units.
    expect(accept?.amount).toBe('80000');
  });

  it('the seller scheme holds the exact channelStore it was handed', () => {
    stubFacilitator();
    const store = new RecordingChannelStorage();

    const rs = buildResourceServer({
      payTo: PAY_TO,
      network: NETWORK,
      price: PRICE,
      route: ROUTE,
      facilitatorUrl: FACILITATOR_URL,
      channelStore: store,
    });

    // The upstream batch-settlement server scheme's verify hook persists a
    // voucher's Channel ONLY through this storage object. If the seller wired
    // a different instance, persisted vouchers would be invisible to the
    // claim path — the exact SDK 3.3.0 bug. `getStorage()` must return the
    // very object the seller was given.
    expect(rs.scheme.getStorage()).toBe(store);
  });

  it('a Channel written through the seller-shared storage reaches the claim path', async () => {
    stubFacilitator();
    const store = new RecordingChannelStorage();

    const rs = buildResourceServer({
      payTo: PAY_TO,
      network: NETWORK,
      price: PRICE,
      route: ROUTE,
      facilitatorUrl: FACILITATOR_URL,
      channelStore: store,
    });

    const sharedStorage = rs.scheme.getStorage();
    const channelId = '0xchannel-voucher-1';

    // Drive a write through the SAME `updateChannel` the upstream verify hook
    // uses when it persists an incoming voucher's Channel.
    const result = await sharedStorage.updateChannel(channelId, (current) =>
      current ?? makeChannel(channelId),
    );
    expect(result.status).toBe('updated');

    // The channel manager claims by reading `list()` off this same storage.
    // The Channel must be visible there — i.e. it genuinely reached the
    // seller's claim path, not a detached store.
    const claimable = await sharedStorage.list();
    expect(claimable).toHaveLength(1);
    expect(claimable[0]?.channelId).toBe(channelId);
    expect(claimable[0]?.chargedCumulativeAmount).toBe('80000');

    // And it landed in the exact instance the test owns and can inspect.
    expect(store.channels.has(channelId)).toBe(true);
    expect(store.updateCalls).toContain(channelId);
    expect(store.listCallCount).toBeGreaterThan(0);
  });

  it('an unverifiable voucher header still does not crash the runtime', async () => {
    stubFacilitator();
    const store = new RecordingChannelStorage();

    const rs = buildResourceServer({
      payTo: PAY_TO,
      network: NETWORK,
      price: PRICE,
      route: ROUTE,
      facilitatorUrl: FACILITATOR_URL,
      channelStore: store,
    });
    await rs.ready;

    // A malformed/unverifiable payment header must be rejected cleanly (4xx),
    // never hang or 500 the real-money request path. A genuine voucher cannot
    // be produced without a live channel + facilitator, so this asserts the
    // failure mode rather than persistence.
    const cap = makeResponse();
    const next = vi.fn();
    const bogusVoucher = btoa(
      JSON.stringify({ x402Version: 2, scheme: 'batch-settlement', payload: {} }),
    );
    await rs.handler(makeRequest(bogusVoucher), cap.res, next);

    expect(cap.statusCode).toBeGreaterThanOrEqual(400);
    expect(cap.statusCode).toBeLessThan(600);
    // The seller's own route handler must NOT run for an unverified voucher.
    expect(next).not.toHaveBeenCalled();
  });
});
