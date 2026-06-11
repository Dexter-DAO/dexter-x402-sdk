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
import { openTab } from '../tab';
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

/** Open a tab and sign one voucher so close() has something to settle. */
async function makeTabWithVoucher(): Promise<Tab> {
  const tab = await openTab({
    vault: makeFakeAdapter(),
    network: 'solana:mainnet',
    seller: SELLER_PUBKEY,
    perUnitCap: '0.01', // 10000 atomic
    totalCap: '5',
    facilitatorUrl: FACILITATOR_URL,
  });
  await tab.signNextVoucher('10000');
  return tab;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Tab.close() — facilitator fee fields', () => {
  it('surfaces grossAmount/feeAmount/netAmount from a fee-aware facilitator', async () => {
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        settleTx: 'sig',
        cumulativeAmount: '10000',
        transferAmount: '9900',
        grossAmount: '10000',
        feeAmount: '100',
        netAmount: '9900',
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const tab = await makeTabWithVoucher();
    const result = await tab.close();

    expect(result.settleTx).toBe('sig');
    expect(result.grossAmount).toBe('10000');
    expect(result.feeAmount).toBe('100');
    expect(result.netAmount).toBe('9900');

    // Sanity: the settle actually went to the facilitator's /tab/settle.
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(String(mockFetch.mock.calls[0]![0])).toBe(`${FACILITATOR_URL}/tab/settle`);
  });

  it('leaves the fee fields undefined when an old facilitator omits them', async () => {
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        settleTx: 'sig',
        cumulativeAmount: '10000',
        transferAmount: '10000',
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const tab = await makeTabWithVoucher();
    const result = await tab.close();

    expect(result.settleTx).toBe('sig');
    expect(result.grossAmount).toBeUndefined();
    expect(result.feeAmount).toBeUndefined();
    expect(result.netAmount).toBeUndefined();
  });

  it('ignores non-string fee field values rather than coercing them', async () => {
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        settleTx: 'sig',
        cumulativeAmount: '10000',
        transferAmount: '9900',
        grossAmount: 10000,
        feeAmount: null,
        netAmount: { atomic: '9900' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const tab = await makeTabWithVoucher();
    const result = await tab.close();

    expect(result.settleTx).toBe('sig');
    expect(result.grossAmount).toBeUndefined();
    expect(result.feeAmount).toBeUndefined();
    expect(result.netAmount).toBeUndefined();
  });
});

describe('Tab.close() — postSettle error paths stay byte-identical', () => {
  it('throws "tab settle <status>: <body>" on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('settle exploded', { status: 502 })),
    );

    const tab = await makeTabWithVoucher();
    await expect(tab.close()).rejects.toThrow('tab settle 502: settle exploded');
  });

  it('throws on a non-JSON 2xx body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>oops</html>', { status: 200 })),
    );

    const tab = await makeTabWithVoucher();
    await expect(tab.close()).rejects.toThrow(
      'tab settle returned non-JSON: <html>oops</html>',
    );
  });

  it('throws when the response JSON has no settleTx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ cumulativeAmount: '10000' })),
    );

    const tab = await makeTabWithVoucher();
    await expect(tab.close()).rejects.toThrow('tab settle returned no settleTx:');
  });
});
