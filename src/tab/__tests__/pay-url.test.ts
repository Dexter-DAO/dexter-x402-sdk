// src/tab/__tests__/pay-url.test.ts
/**
 * payUrlWithTab — pay a URL through a tab with zero seller knowledge.
 * Covers: happy path, free URL, budget_exceeded (pre-chain), tab reuse,
 * post-open payment failure, onLiveSession passthrough, and no tab offered.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { payUrlWithTab } from '../pay-url';
import { openTab } from '../tab';
import type { Tab, VaultAdapter } from '../types';
import { sessionRegisterMessage } from '../messages';
import { DEXTER_VAULT_PROGRAM_ID } from '../instructions';
import { finalizedReservationReceipt } from './reservation-fixture';

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
  sessionVoucherVersion: 2,
  authorizeSession: async scope => {
    const publicKey = new Uint8Array(32).fill(1);
    return {
      publicKey,
      privateKey: new Uint8Array(64).fill(9),
      scope,
      registration: sessionRegisterMessage({
        programId: DEXTER_VAULT_PROGRAM_ID,
        vaultPda: new PublicKey(SELLER),
        sessionPubkey: publicKey,
        maxAmount: BigInt(scope.maxAmountAtomic),
        expiresAt: BigInt(scope.expiresAtUnix),
        allowedCounterparty: new PublicKey(scope.allowedCounterparty),
        nonce: 0x8000_0007,
        maxRevolvingCapacity: BigInt(scope.revolvingCapacityAtomic!),
      }),
    };
  },
  signWithSession: async (session, payload) => ({
    payload: {
      ...payload,
      sequenceNumber: (payload.sequenceNumber | 0x8000_0000) >>> 0,
    },
    sessionPublicKey: session.publicKey,
    sessionRegistration: session.registration,
    sessionSignature: new Uint8Array(64).fill(3),
  }),
  signOpenTab: async () => new Uint8Array(0),
  signCloseTab: async () => new Uint8Array(0),
  verifyFinalVoucherV2Reservation: async () => undefined,
};

const reserveFinalVoucherV2 = async (
  input: Parameters<NonNullable<import('../types').OpenTabOptions['reserveFinalVoucherV2']>>[0],
) => finalizedReservationReceipt(input);

/** Build an open V2 tab for the tab-reuse test. */
async function buildOpenTab(): Promise<Tab> {
  const tab = await openTab({
    vault: fakeAdapter,
    network: 'solana:mainnet',
    seller: SELLER,
    perUnitCap: '0.02',
    totalCap: '0.02',
    reserveFinalVoucherV2,
  });
  return tab;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('payUrlWithTab', () => {
  it('1. happy path — resolves offer, opens tab, pays with voucher header, returns tab', async () => {
    const voucherHeaders: string[] = [];

    // Scripted fetch sequence:
    //   (a) resolve probe → 402 challenge
    //   (b) payAndFetch probe → 402 challenge
    //   (c) request WITH x-tab-voucher → 200
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers ?? undefined);

        // (c) voucher-carrying paid request
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
        reserveFinalVoucherV2,
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
    expect(decoded.reservationReceipt).toMatchObject({
      contract: 'dexter-native-tab-open-receipt/v1',
      transaction: '5'.repeat(88),
      commitment: 'confirmed',
      buyerSwigAddress: SELLER,
      vaultPda: SELLER,
      seller: SELLER,
      channelId: decoded.payload.channelId,
      sessionPublicKey: decoded.sessionPublicKey,
      cumulativeAmountAtomic: decoded.payload.cumulativeAmount,
      sequenceNumber: decoded.payload.sequenceNumber,
      reservationAmountAtomic: decoded.payload.cumulativeAmount,
      currentOutstandingAfterAtomic: decoded.payload.cumulativeAmount,
    });
    expect(decoded.reservationReceipt.voucherDigest).toMatch(/^[0-9a-f]{64}$/);
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
        reserveFinalVoucherV2,
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
        reserveFinalVoucherV2,
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

    // Script for the second call (tab already seeded, no arm needed):
    //   (a) resolve probe → 402
    //   (b) payAndFetch probe → 402
    //   (c) voucher request → 200
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers ?? undefined);

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
        reserveFinalVoucherV2,
      },
    );

    expect(result.ok).toBe(true);

    // The returned tab is the SAME object as the seeded one.
    expect(tab).toBe(seededTab);
  });

  it('6. payment fails AFTER the tab opened — tab is non-null so the caller can close it', async () => {
    // Script: resolve probe → 402, payAndFetch probe → 402,
    // then the voucher request → 500.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers ?? undefined);
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
        reserveFinalVoucherV2,
      },
    );

    expect(result.ok).toBe(false);
    // The recovery contract: the opened tab IS returned so the caller can
    // close() it (settle whatever streamed, free the freeze).
    expect(tab).not.toBeNull();
    expect(tab!.counterparty).toBe(SELLER);
    expect(tab!.state.isOpen).toBe(true);
  });

  it('7. onLiveSession passes through openTab to the adapter (K-T4e replace acknowledgement)', async () => {
    // MINOR-1 regression guard: payUrlWithTab used to have NO passthrough,
    // so this call site could never acknowledge a live-session replace.
    const authorizeOpts: unknown[] = [];
    const capturingAdapter: VaultAdapter = {
      ...fakeAdapter,
      authorizeSession: async (scope, opts) => {
        authorizeOpts.push(opts);
        return fakeAdapter.authorizeSession(scope, opts);
      },
    };

    // Same script as the happy path: probe → 402, probe → 402,
    // voucher request → 200.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers ?? undefined);
        if (headers.get('X-Tab-Voucher') ?? headers.get('x-tab-voucher')) {
          return new Response('paid!', { status: 200 });
        }
        return makeChallenge402([tabAccept]);
      }),
    );

    const { result } = await payUrlWithTab(
      URL,
      { method: 'GET' },
      {
        vault: capturingAdapter,
        perUnitCap: '0.02',
        totalCap: '0.02',
        onLiveSession: 'replace',
        reserveFinalVoucherV2,
      },
    );

    expect(result.ok).toBe(true);
    expect(authorizeOpts).toEqual([{ onLiveSession: 'replace' }]);
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
        reserveFinalVoucherV2,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('no_payment_options');
    expect(tab).toBeNull();
  });
});
