// src/tab/__tests__/pay-url.test.ts
/**
 * payUrlWithTab — pay a URL through a tab with zero seller knowledge.
 * Five tests: happy path, free URL, budget_exceeded (pre-chain), tab reuse,
 * and no tab offered.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { payUrlWithTab } from '../pay-url';
import { openTab } from '../tab';
import type { Tab, VaultAdapter } from '../types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SELLER = 'GmaDrppjnZBxjBVgxiZJWFY7tXJVHTYUBVoBtmofpNNw';
const CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const URL = 'http://s/paid';

/** Extract a URL string from the heterogeneous fetch `input` argument. */
function inputToUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  // Both URL (.href) and Request (.url) expose their string representation here.
  const asAny = input as unknown as Record<string, unknown>;
  if (typeof asAny['href'] === 'string') return asAny['href'] as string;
  if (typeof asAny['url'] === 'string') return asAny['url'] as string;
  return String(input);
}

/** Encode a v2 payment-required header (resolve.test.ts idiom). */
function encode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

/** Build a 402 Response with a tab accept entry. */
function makeChallenge402(
  accepts: unknown[],
  resourceUrl = URL,
): Response {
  return new Response(JSON.stringify({ error: 'Payment required', accepts }), {
    status: 402,
    headers: {
      'payment-required': encode({ accepts, resource: { url: resourceUrl } }),
    },
  });
}

/** Standard tab accept (maxAmountRequired as string, used by resolveTabOffer). */
const tabAccept = {
  scheme: 'tab',
  network: CAIP2,
  maxAmountRequired: '10000',   // = $0.01 USDC (6 decimals)
  asset: USDC,
  payTo: SELLER,
  maxTimeoutSeconds: 60,
};

/** A minimal fake VaultAdapter (same pattern as tab-negotiation.test.ts). */
const fakeAdapter: VaultAdapter = {
  network: 'solana:mainnet',
  swigAddress: SELLER,
  vaultPda: SELLER,
  authorizeSession: async scope => ({
    publicKey: new Uint8Array(32).fill(1),
    privateKey: new Uint8Array(64).fill(9),
    scope,
    registration: new Uint8Array(180).fill(2),
  }),
  signWithSession: async (_session, payload) => ({
    payload,
    sessionPublicKey: new Uint8Array(32).fill(1),
    sessionRegistration: new Uint8Array(180).fill(2),
    sessionSignature: new Uint8Array(64).fill(3),
  }),
  signOpenTab: async () => new Uint8Array(0),
  signCloseTab: async () => new Uint8Array(0),
};

/** Build an open tab for tab-reuse test (requires a stubbed fetch for /tab/open). */
async function buildOpenTab(): Promise<Tab> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({ success: true, armed: true, signature: 'x' }),
        { status: 200 },
      ),
    ),
  );
  const tab = await openTab({
    vault: fakeAdapter,
    network: 'solana:mainnet',
    seller: SELLER,
    perUnitCap: '0.02',
    totalCap: '0.02',
  });
  vi.unstubAllGlobals();
  return tab;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('payUrlWithTab', () => {
  it('1. happy path — resolves offer, opens tab, pays with voucher header, returns tab', async () => {
    const tabOpenCalls: string[] = [];
    const voucherHeaders: string[] = [];

    // Scripted fetch sequence:
    //   (a) resolve probe → 402 challenge
    //   (b) POST /tab/open → armed
    //   (c) payAndFetch probe → 402 challenge
    //   (d) request WITH x-tab-voucher → 200
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = inputToUrl(input);
        const headers = new Headers(init?.headers ?? undefined);

        // (b) arm call
        if (url.includes('/tab/open')) {
          tabOpenCalls.push(url);
          return new Response(
            JSON.stringify({ success: true, armed: true, signature: 'x' }),
            { status: 200 },
          );
        }

        // (d) voucher-carrying paid request
        const voucher = headers.get('X-Tab-Voucher') ?? headers.get('x-tab-voucher');
        if (voucher) {
          voucherHeaders.push(voucher);
          return new Response('paid!', { status: 200 });
        }

        // (a)/(c) probe → 402
        return makeChallenge402([tabAccept]);
      }),
    );

    const { result, tab } = await payUrlWithTab(
      URL,
      { method: 'GET' },
      {
        vault: fakeAdapter,
        perUnitCap: '0.02',
        totalCap: '0.02',
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.paid).toBe(true);

    expect(tab).not.toBeNull();
    expect(tab!.counterparty).toBe(SELLER);

    // A voucher-carrying request was made.
    expect(voucherHeaders).toHaveLength(1);
    // The voucher decodes correctly.
    const decoded = JSON.parse(
      Buffer.from(voucherHeaders[0], 'base64').toString('utf8'),
    );
    expect(decoded.payload).toBeDefined();
    expect(decoded.sessionPublicKey).toBeDefined();
  });

  it('2. free URL — 200 with no payment challenge returns paid:false, tab null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('hello!', { status: 200 })),
    );

    const { result, tab } = await payUrlWithTab(
      URL,
      { method: 'GET' },
      {
        vault: fakeAdapter,
        perUnitCap: '0.02',
        totalCap: '0.02',
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.paid).toBe(false);
    expect(tab).toBeNull();

    // Response body is readable.
    if (result.paid === false) {
      expect(await result.response.text()).toBe('hello!');
    }
  });

  it('3. quote above perUnitCap refused BEFORE any chain action — no /tab/open fetch', async () => {
    // Challenge quotes 30000 atomic ($0.03); perUnitCap is $0.02 (20000 atomic)
    const bigAccept = { ...tabAccept, maxAmountRequired: '30000' };

    const fetchMock = vi.fn(async () => makeChallenge402([bigAccept]));
    vi.stubGlobal('fetch', fetchMock);

    const { result, tab } = await payUrlWithTab(
      URL,
      { method: 'GET' },
      {
        vault: fakeAdapter,
        perUnitCap: '0.02',   // 20000 atomic
        totalCap: '0.02',
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('budget_exceeded');
    expect(tab).toBeNull();

    // CRITICAL: no /tab/open call was made.
    const callUrls = (fetchMock.mock.calls as unknown as Array<[string | URL | Request, ...unknown[]]>)
      .map(([input]) => inputToUrl(input));
    expect(callUrls.some(u => u.includes('/tab/open'))).toBe(false);
    // Only the one resolve probe was sent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('4. tab reuse — existing open tab is reused; no /tab/open POST for second call', async () => {
    // Seed: build a real open tab.
    const seededTab = await buildOpenTab();
    const tabs = new Map<string, Tab>();
    tabs.set(SELLER, seededTab);

    const tabOpenCalls: string[] = [];

    // Script for the second call (tab already seeded, no arm needed):
    //   (a) resolve probe → 402
    //   (b) payAndFetch probe → 402
    //   (c) voucher request → 200
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = inputToUrl(input);
        const headers = new Headers(init?.headers ?? undefined);

        if (url.includes('/tab/open')) {
          tabOpenCalls.push(url);
          return new Response(
            JSON.stringify({ success: true, armed: true, signature: 'x' }),
            { status: 200 },
          );
        }

        const voucher = headers.get('X-Tab-Voucher') ?? headers.get('x-tab-voucher');
        if (voucher) {
          return new Response('paid!', { status: 200 });
        }

        return makeChallenge402([tabAccept]);
      }),
    );

    const { result, tab } = await payUrlWithTab(
      URL,
      { method: 'GET' },
      {
        vault: fakeAdapter,
        perUnitCap: '0.02',
        totalCap: '0.02',
        tabs,
      },
    );

    expect(result.ok).toBe(true);

    // No /tab/open was called during the second payUrlWithTab call.
    expect(tabOpenCalls).toHaveLength(0);

    // The returned tab is the SAME object as the seeded one.
    expect(tab).toBe(seededTab);
  });

  it('6. payment fails AFTER the tab opened — tab is non-null so the caller can close it', async () => {
    // Script: (a) resolve probe → 402, (b) /tab/open → armed,
    //         (c) payAndFetch probe → 402, (d) voucher request → 500.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = inputToUrl(input);
        const headers = new Headers(init?.headers ?? undefined);
        if (url.includes('/tab/open')) {
          return new Response(
            JSON.stringify({ success: true, armed: true, signature: 'x' }),
            { status: 200 },
          );
        }
        const voucher = headers.get('X-Tab-Voucher') ?? headers.get('x-tab-voucher');
        if (voucher) {
          return new Response('seller exploded', { status: 500 });
        }
        return makeChallenge402([tabAccept]);
      }),
    );

    const { result, tab } = await payUrlWithTab(
      URL,
      { method: 'GET' },
      {
        vault: fakeAdapter,
        perUnitCap: '0.02',
        totalCap: '0.02',
      },
    );

    expect(result.ok).toBe(false);
    // The recovery contract: the opened tab IS returned so the caller can
    // close() it (settle whatever streamed, free the freeze).
    expect(tab).not.toBeNull();
    expect(tab!.counterparty).toBe(SELLER);
    expect(tab!.state.isOpen).toBe(true);
  });

  it('5. no tab offered — only exact scheme → reason no_payment_options, tab null', async () => {
    const exactAccept = {
      scheme: 'exact',
      network: CAIP2,
      maxAmountRequired: '10000',
      asset: USDC,
      payTo: SELLER,
      maxTimeoutSeconds: 60,
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeChallenge402([exactAccept])),
    );

    const { result, tab } = await payUrlWithTab(
      URL,
      { method: 'GET' },
      {
        vault: fakeAdapter,
        perUnitCap: '0.02',
        totalCap: '0.02',
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('no_payment_options');
    expect(tab).toBeNull();
  });
});
