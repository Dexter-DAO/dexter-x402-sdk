// src/tab/__tests__/settle-fee.test.ts
/**
 * Facilitator fee fields on `Tab.close()`:
 *
 *  1. A fee-aware facilitator's `/tab/settle` response carries
 *     `grossAmount` / `feeAmount` / `netAmount` (atomic strings), and
 *     `close()` must surface them verbatim on `TabCloseResult`.
 *
 *  2. An OLD facilitator omits them — `close()` must leave all three
 *     `undefined` (no crash, no defaulting from `transferAmount`).
 *
 *  3. The existing postSettle error paths (non-2xx, non-JSON, missing
 *     settleTx) must remain byte-identical.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TabImpl } from '../tab';
import type { Tab, VaultAdapter } from '../types';

// Any valid base58 pubkeys — never hit on chain in these tests.
const SELLER_PUBKEY = 'DhP2eR7XGwsCFUxiYxkLBpzkmuyU1Cn9CGUVNkpBu1g7';
const VAULT_PUBKEY = '7S3P4HxJpyyigGzodYwHtCxZyUQe9JiBMHyRWXArAaKv';

const FACILITATOR_URL = 'https://facilitator.test';

function makeFakeAdapter(): VaultAdapter {
  return {
    network: 'solana:mainnet',
    swigAddress: VAULT_PUBKEY,
    vaultPda: VAULT_PUBKEY,
    sessionVoucherVersion: 1,
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
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Build a /tab/settle fetch mock. The local V1 handle below represents an
 * already-issued historical tab; v6 public open/recovery does not arm V1.
 */
function makeRoutingFetch(settleResponse: () => Response) {
  return vi.fn(async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ) => settleResponse());
}

/** Build an already-issued V1 tab and sign one voucher for close coverage. */
async function makeTabWithVoucher(mockFetch: ReturnType<typeof vi.fn>): Promise<Tab> {
  vi.stubGlobal('fetch', mockFetch);
  const vault = makeFakeAdapter();
  const expiresAtUnix = Math.floor(Date.now() / 1000) + 3600;
  const channelIdHex = '11'.repeat(32);
  const session = await vault.authorizeSession({
    channelId: channelIdHex,
    maxAmountAtomic: '5000000',
    revolvingCapacityAtomic: '5000000',
    expiresAtUnix,
    allowedCounterparty: SELLER_PUBKEY,
  });
  const tab = new TabImpl({
    vault,
    network: 'solana:mainnet',
    seller: SELLER_PUBKEY,
    counterparty: SELLER_PUBKEY,
    session,
    channelIdHex,
    channelIdBytes: Uint8Array.from(Buffer.from(channelIdHex, 'hex')),
    perUnitCapAtomic: 10000n,
    totalCapAtomic: 5000000n,
    expiresAtUnix,
    facilitatorUrl: FACILITATOR_URL,
  });
  await tab.signNextVoucher('10000');
  return tab;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Tab.close() — facilitator fee fields', () => {
  it('surfaces grossAmount/feeAmount/netAmount from a fee-aware facilitator', async () => {
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse({
        settleTx: 'sig',
        cumulativeAmount: '10000',
        transferAmount: '9900',
        grossAmount: '10000',
        feeAmount: '100',
        netAmount: '9900',
      }),
    );

    const tab = await makeTabWithVoucher(mockFetch);
    const result = await tab.close();

    expect(result.settleTx).toBe('sig');
    expect(result.grossAmount).toBe('10000');
    expect(result.feeAmount).toBe('100');
    expect(result.netAmount).toBe('9900');

    // Sanity: the settle call went to the facilitator's /tab/settle.
    const settleCalls = mockFetch.mock.calls.filter(([url]) =>
      String(url).endsWith('/tab/settle'),
    );
    expect(settleCalls).toHaveLength(1);
    expect(String(settleCalls[0]![0])).toBe(`${FACILITATOR_URL}/tab/settle`);
    expect(JSON.parse(String(settleCalls[0]![1]?.body))).toMatchObject({
      attemptedAmount: '10000',
      cumulativeAmount: '10000',
    });
  });

  it('leaves the fee fields undefined when an old facilitator omits them', async () => {
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse({
        settleTx: 'sig',
        cumulativeAmount: '10000',
        transferAmount: '10000',
      }),
    );

    const tab = await makeTabWithVoucher(mockFetch);
    const result = await tab.close();

    expect(result.settleTx).toBe('sig');
    expect(result.grossAmount).toBeUndefined();
    expect(result.feeAmount).toBeUndefined();
    expect(result.netAmount).toBeUndefined();
  });

  it('settles the full cumulative span of a grandfathered multi-voucher V1 tab', async () => {
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse({
        settleTx: 'sig',
        cumulativeAmount: '8000',
        transferAmount: '8000',
      }),
    );
    vi.stubGlobal('fetch', mockFetch);
    const vault = makeFakeAdapter();
    const expiresAtUnix = Math.floor(Date.now() / 1000) + 3600;
    const channelIdHex = '22'.repeat(32);
    const session = await vault.authorizeSession({
      channelId: channelIdHex,
      maxAmountAtomic: '5000000',
      revolvingCapacityAtomic: '5000000',
      expiresAtUnix,
      allowedCounterparty: SELLER_PUBKEY,
    });
    const tab = new TabImpl({
      vault,
      network: 'solana:mainnet',
      seller: SELLER_PUBKEY,
      counterparty: SELLER_PUBKEY,
      session,
      channelIdHex,
      channelIdBytes: Uint8Array.from(Buffer.from(channelIdHex, 'hex')),
      perUnitCapAtomic: 10000n,
      totalCapAtomic: 5000000n,
      expiresAtUnix,
      facilitatorUrl: FACILITATOR_URL,
    });
    await tab.signNextVoucher('3000');
    await tab.signNextVoucher('5000');
    await tab.close();

    const settleCall = mockFetch.mock.calls.find(([url]) =>
      String(url).endsWith('/tab/settle'),
    );
    expect(JSON.parse(String(settleCall?.[1]?.body))).toMatchObject({
      attemptedAmount: '8000',
      cumulativeAmount: '8000',
    });
  });

  it('ignores non-string fee field values rather than coercing them', async () => {
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse({
        settleTx: 'sig',
        cumulativeAmount: '10000',
        transferAmount: '9900',
        grossAmount: 10000,
        feeAmount: null,
        netAmount: { atomic: '9900' },
      }),
    );

    const tab = await makeTabWithVoucher(mockFetch);
    const result = await tab.close();

    expect(result.settleTx).toBe('sig');
    expect(result.grossAmount).toBeUndefined();
    expect(result.feeAmount).toBeUndefined();
    expect(result.netAmount).toBeUndefined();
  });
});

describe('Tab.close() — postSettle error paths stay byte-identical', () => {
  it('throws "tab settle <status>: <body>" on non-2xx', async () => {
    const mockFetch = makeRoutingFetch(
      () => new Response('settle exploded', { status: 502 }),
    );

    const tab = await makeTabWithVoucher(mockFetch);
    await expect(tab.close()).rejects.toThrow('tab settle 502: settle exploded');
  });

  it('throws on a non-JSON 2xx body', async () => {
    const mockFetch = makeRoutingFetch(
      () => new Response('<html>oops</html>', { status: 200 }),
    );

    const tab = await makeTabWithVoucher(mockFetch);
    await expect(tab.close()).rejects.toThrow(
      'tab settle returned non-JSON: <html>oops</html>',
    );
  });

  it('throws when the response JSON has no settleTx', async () => {
    const mockFetch = makeRoutingFetch(
      () => jsonResponse({ cumulativeAmount: '10000' }),
    );

    const tab = await makeTabWithVoucher(mockFetch);
    await expect(tab.close()).rejects.toThrow('tab settle returned no settleTx:');
  });
});
