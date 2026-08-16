// src/tab/__tests__/covered-frontier.test.ts
/**
 * Buyer covered-settle tolerance in `Tab.close()` (C-2 §4).
 *
 * Once seller-side crystallization re-arms, a buyer's final settle can land
 * fully covered by locks. That is a NORMAL outcome — the buyer's `close()`
 * must NOT throw before the revoke; it must proceed to wipe the session.
 *
 * `postSettle` tolerates exactly two shapes as success-no-op (`settleTx: ''`):
 *
 *   1. HTTP 200 `{ settled: false, reason: 'covered_by_frontier', ... }`
 *      (new facilitator, camelCase fields).
 *   2. HTTP 409 `non_monotonic_cumulative` whose SNAKE_CASE body proves the
 *      settle was covered by locks: `attempted_cumulative > on_chain_spent`
 *      AND `attempted_cumulative <= frontier` (old-facilitator deploy skew).
 *
 * Everything else keeps today's throw-before-revoke semantics:
 *   - a 409 with `attempted_cumulative <= on_chain_spent` is genuinely stale;
 *   - a 409 over the frontier is genuinely uncovered;
 *   - a malformed 409 (missing/garbled fields) is not provably covered;
 *   - 5xx / non-JSON / network errors leave the session alive to retry.
 *
 * "Revoke reached" is asserted via the `signCloseTab` spy: close() calls it
 * ONLY after postSettle returns without throwing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TabImpl } from '../tab';
import type { Tab, VaultAdapter } from '../types';

// Any valid base58 pubkeys — never hit on chain in these tests.
const SELLER_PUBKEY = 'DhP2eR7XGwsCFUxiYxkLBpzkmuyU1Cn9CGUVNkpBu1g7';
const VAULT_PUBKEY = '7S3P4HxJpyyigGzodYwHtCxZyUQe9JiBMHyRWXArAaKv';

const FACILITATOR_URL = 'https://facilitator.test';

/** Fake adapter whose `signCloseTab` is a spy so tests can assert the revoke
 *  step ran (or did NOT run, when postSettle throws before reaching it). */
function makeAdapterWithRevokeSpy(): { adapter: VaultAdapter; signCloseTab: ReturnType<typeof vi.fn> } {
  const signCloseTab = vi.fn(async () => new Uint8Array(0));
  const adapter: VaultAdapter = {
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
    signCloseTab,
  };
  return { adapter, signCloseTab };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * URL-routing fetch mock for /tab/settle. The local V1 handle below represents
 * an already-issued historical tab; v6 public open/recovery does not arm V1.
 */
function makeRoutingFetch(settleResponse: () => Response) {
  return vi.fn(async (_input: string | URL | Request) => settleResponse());
}

/** Open a tab (revoke-mode, the openTab default) and sign one voucher so
 *  close() has a final voucher to POST. Returns the tab + the revoke spy. */
async function makeTabWithVoucher(
  mockFetch: ReturnType<typeof vi.fn>,
): Promise<{ tab: Tab; signCloseTab: ReturnType<typeof vi.fn> }> {
  const { adapter, signCloseTab } = makeAdapterWithRevokeSpy();
  vi.stubGlobal('fetch', mockFetch);
  const expiresAtUnix = Math.floor(Date.now() / 1000) + 3600;
  const channelIdHex = '11'.repeat(32);
  const session = await adapter.authorizeSession({
    channelId: channelIdHex,
    maxAmountAtomic: '5000000',
    revolvingCapacityAtomic: '5000000',
    expiresAtUnix,
    allowedCounterparty: SELLER_PUBKEY,
  });
  const tab = new TabImpl({
    vault: adapter,
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
  await tab.signNextVoucher('10000'); // cumulative → 10000
  return { tab, signCloseTab };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Tab.close() — covered-by-frontier tolerance (new-facilitator 200)', () => {
  it('treats a 200 covered_by_frontier no-op as success and proceeds to revoke', async () => {
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse({
        settled: false,
        reason: 'covered_by_frontier',
        settleTx: '',
        onChainSpent: '8000',
        crystallizedCumulative: '10000',
        frontier: '10000',
        attemptedCumulative: '10000',
      }),
    );

    const { tab, signCloseTab } = await makeTabWithVoucher(mockFetch);
    const result = await tab.close();

    // No throw; settle is the legitimate empty tx.
    expect(result.settleTx).toBe('');
    // Revoke reached — the whole point: the session must be wiped.
    expect(signCloseTab).toHaveBeenCalledTimes(1);
    expect(result.sessionRevoked).toBe(true);
    // The settle round-trip did hit /tab/settle once.
    const settleCalls = mockFetch.mock.calls.filter(([url]) =>
      String(url).endsWith('/tab/settle'),
    );
    expect(settleCalls).toHaveLength(1);
    // No fee fields fabricated on a no-op.
    expect(result.grossAmount).toBeUndefined();
    expect(result.feeAmount).toBeUndefined();
    expect(result.netAmount).toBeUndefined();
  });

  it('tolerates a minimal 200 body whose camelCase amounts prove coverage (marker + inequality only)', async () => {
    // attemptedCumulative(10000) > onChainSpent(8000) AND <= frontier(10000):
    // provably covered even without the optional settled/crystallizedCumulative
    // extras — the tolerance depends on the marker + the re-derived inequality,
    // nothing else.
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse({
        reason: 'covered_by_frontier',
        onChainSpent: '8000',
        frontier: '10000',
        attemptedCumulative: '10000',
      }),
    );

    const { tab, signCloseTab } = await makeTabWithVoucher(mockFetch);
    const result = await tab.close();

    expect(result.settleTx).toBe('');
    expect(signCloseTab).toHaveBeenCalledTimes(1);
    expect(result.sessionRevoked).toBe(true);
  });

  it('a 200 marker whose body shows attemptedCumulative <= onChainSpent throws and never revokes', async () => {
    // The marker CLAIMS covered, but the body's own amounts say stale replay
    // (attempted == onChainSpent). The marker alone is never sufficient — a
    // false no-op would revoke the session and strand the seller's tail.
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse({
        settled: false,
        reason: 'covered_by_frontier',
        settleTx: '',
        onChainSpent: '10000',
        crystallizedCumulative: '10000',
        frontier: '10000',
        attemptedCumulative: '10000', // == onChainSpent → NOT a covered span
      }),
    );

    const { tab, signCloseTab } = await makeTabWithVoucher(mockFetch);
    await expect(tab.close()).rejects.toThrow('tab settle returned no settleTx:');
    expect(signCloseTab).not.toHaveBeenCalled();
  });

  it('a 200 marker with a missing frontier field throws and never revokes (fail closed)', async () => {
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse({
        settled: false,
        reason: 'covered_by_frontier',
        settleTx: '',
        onChainSpent: '8000',
        attemptedCumulative: '10000', // no `frontier` — cannot prove coverage
      }),
    );

    const { tab, signCloseTab } = await makeTabWithVoucher(mockFetch);
    await expect(tab.close()).rejects.toThrow('tab settle returned no settleTx:');
    expect(signCloseTab).not.toHaveBeenCalled();
  });
});

describe('Tab.close() — deploy-skew tolerance (old-facilitator 409)', () => {
  it('tolerates a 409 non_monotonic_cumulative that the snake_case body proves covered', async () => {
    // attempted(10000) > on_chain_spent(8000) AND attempted(10000) <= frontier(10000)
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse(
        {
          error: 'non_monotonic_cumulative',
          on_chain_spent: '8000',
          crystallized_cumulative: '10000',
          frontier: '10000',
          attempted_cumulative: '10000',
        },
        409,
      ),
    );

    const { tab, signCloseTab } = await makeTabWithVoucher(mockFetch);
    const result = await tab.close();

    expect(result.settleTx).toBe('');
    expect(signCloseTab).toHaveBeenCalledTimes(1);
    expect(result.sessionRevoked).toBe(true);
  });

  it('accepts the reason under the `reason` key too (not only `error`)', async () => {
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse(
        {
          reason: 'non_monotonic_cumulative',
          on_chain_spent: '8000',
          frontier: '10000',
          attempted_cumulative: '10000',
        },
        409,
      ),
    );

    const { tab, signCloseTab } = await makeTabWithVoucher(mockFetch);
    const result = await tab.close();

    expect(result.settleTx).toBe('');
    expect(signCloseTab).toHaveBeenCalledTimes(1);
  });
});

describe('Tab.close() — genuine failures keep throwing BEFORE revoke', () => {
  it('a stale 409 (attempted <= on_chain_spent) throws and never revokes', async () => {
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse(
        {
          error: 'non_monotonic_cumulative',
          on_chain_spent: '10000',
          crystallized_cumulative: '0',
          frontier: '10000',
          attempted_cumulative: '10000', // == on_chain_spent → stale replay
        },
        409,
      ),
    );

    const { tab, signCloseTab } = await makeTabWithVoucher(mockFetch);
    await expect(tab.close()).rejects.toThrow('tab settle 409:');
    expect(signCloseTab).not.toHaveBeenCalled();
  });

  it('a 409 over the frontier (attempted > frontier, uncovered) throws and never revokes', async () => {
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse(
        {
          error: 'non_monotonic_cumulative',
          on_chain_spent: '8000',
          frontier: '9000',
          attempted_cumulative: '10000', // > frontier → NOT covered by locks
        },
        409,
      ),
    );

    const { tab, signCloseTab } = await makeTabWithVoucher(mockFetch);
    await expect(tab.close()).rejects.toThrow('tab settle 409:');
    expect(signCloseTab).not.toHaveBeenCalled();
  });

  it('a facilitator 500 throws before revoke (session stays alive to retry)', async () => {
    const mockFetch = makeRoutingFetch(
      () => new Response('settle exploded', { status: 500 }),
    );

    const { tab, signCloseTab } = await makeTabWithVoucher(mockFetch);
    await expect(tab.close()).rejects.toThrow('tab settle 500: settle exploded');
    expect(signCloseTab).not.toHaveBeenCalled();
  });

  it('a network error throws before revoke', async () => {
    const mockFetch = makeRoutingFetch(() => {
      throw new Error('connect ECONNREFUSED');
    });

    const { tab, signCloseTab } = await makeTabWithVoucher(mockFetch);
    await expect(tab.close()).rejects.toThrow('ECONNREFUSED');
    expect(signCloseTab).not.toHaveBeenCalled();
  });

  it('a malformed 409 (missing frontier field) is NOT tolerated → throws', async () => {
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse(
        {
          error: 'non_monotonic_cumulative',
          on_chain_spent: '8000',
          attempted_cumulative: '10000', // no `frontier` — cannot prove coverage
        },
        409,
      ),
    );

    const { tab, signCloseTab } = await makeTabWithVoucher(mockFetch);
    await expect(tab.close()).rejects.toThrow('tab settle 409:');
    expect(signCloseTab).not.toHaveBeenCalled();
  });

  it('a 409 with a non-numeric frontier is NOT tolerated → throws (BigInt-strict parse)', async () => {
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse(
        {
          error: 'non_monotonic_cumulative',
          on_chain_spent: '8000',
          frontier: '10000.5', // decimal — not an atomic-unit integer string
          attempted_cumulative: '10000',
        },
        409,
      ),
    );

    const { tab, signCloseTab } = await makeTabWithVoucher(mockFetch);
    await expect(tab.close()).rejects.toThrow('tab settle 409:');
    expect(signCloseTab).not.toHaveBeenCalled();
  });

  it('a 409 whose body is literal JSON null throws cleanly (no TypeError escape), never revokes', async () => {
    // JSON.parse('null') SUCCEEDS — the parsed body is null, not an object.
    // The tolerance check must return false (fail closed), not blow up on
    // property access and leak a TypeError instead of the settle error.
    const mockFetch = makeRoutingFetch(() =>
      jsonResponse(null, 409),
    );

    const { tab, signCloseTab } = await makeTabWithVoucher(mockFetch);
    await expect(tab.close()).rejects.toThrow('tab settle 409:');
    expect(signCloseTab).not.toHaveBeenCalled();
  });
});
