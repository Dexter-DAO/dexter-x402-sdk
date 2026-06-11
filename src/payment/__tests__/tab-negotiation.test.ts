// src/payment/__tests__/tab-negotiation.test.ts
/**
 * Buyer-side tab negotiation in the v2 strategy: when the caller holds an
 * open Tab for the offered counterparty, payAndFetch pays a `tab`-scheme
 * accepts entry by signing the next voucher and attaching X-Tab-Voucher
 * itself — no facilitator round-trip. Without a tab, the generic picker
 * must SKIP tab options (never submit a plain transfer against them).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { v2Strategy } from '../v2-strategy';
import { openTab } from '../../tab/tab';
import type { Tab, VaultAdapter } from '../../tab/types';
import type { SignedVoucher } from '../../tab/types';

// ── Fixtures ───────────────────────────────────────────────────────────

/** Seller pubkey the tab accepts entry pays to (base58, SVM). */
const SELLER_PUBKEY = 'DhP2eR7XGwsCFUxiYxkLBpzkmuyU1Cn9CGUVNkpBu1g7';
/** A DIFFERENT pubkey, for the counterparty-mismatch case. */
const OTHER_PUBKEY = '7S3P4HxJpyyigGzodYwHtCxZyUQe9JiBMHyRWXArAaKv';

const TAB_ACCEPT = {
  scheme: 'tab',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  amount: '5000',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: SELLER_PUBKEY,
  maxTimeoutSeconds: 60,
  extra: { transport: 'voucher-header' },
};

const EXACT_EVM_ACCEPT = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '2000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x8a598A28a435Fe44D31854251b1c88d0781ea822',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
};

/** A v2 402: empty body, base64 PAYMENT-REQUIRED header (real wire shape). */
function make402(accepts: unknown[]): Response {
  const challenge = {
    x402Version: 2,
    error: 'Payment required',
    resource: { url: 'https://example.com/api', mimeType: 'application/json' },
    accepts,
  };
  const header = Buffer.from(JSON.stringify(challenge)).toString('base64');
  return new Response('{}', {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'payment-required': header,
    },
  });
}

/** A fake open Tab whose signNextVoucher we can observe. */
function makeFakeTab(counterparty: string): Tab & {
  signNextVoucher: ReturnType<typeof vi.fn>;
} {
  const signNextVoucher = vi.fn(
    async (incrementAtomic: string): Promise<SignedVoucher> => ({
      payload: {
        channelId: 'ab'.repeat(32),
        cumulativeAmount: incrementAtomic,
        sequenceNumber: 1,
      },
      sessionPublicKey: new Uint8Array(32).fill(1),
      sessionRegistration: new Uint8Array(180).fill(2),
      sessionSignature: new Uint8Array(64).fill(3),
    }),
  );
  return {
    channelId: 'ab'.repeat(32),
    network: 'solana:mainnet',
    counterparty,
    state: { isOpen: true, spent: '0', remaining: '5', expiresInSec: 3600 },
    signNextVoucher,
    stream: vi.fn(),
    close: vi.fn(),
  } as unknown as Tab & { signNextVoucher: ReturnType<typeof vi.fn> };
}

/**
 * A REAL tab (TabImpl via openTab) over a fake VaultAdapter, for tests
 * that assert the tab's internal voucher accounting — fake-Tab mocks can't
 * observe counter rollback.
 */
async function makeRealTab(): Promise<
  Tab & {
    rollbackVoucher(v: SignedVoucher): boolean;
    lastSignedVoucher: SignedVoucher | null;
  }
> {
  const adapter: VaultAdapter = {
    network: 'solana:mainnet',
    swigAddress: OTHER_PUBKEY,
    vaultPda: OTHER_PUBKEY,
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
  // openTab now arms drain-protection via POST /tab/open (fail-closed). Stub
  // that single call so the tab can be constructed over the fake adapter; the
  // caller re-stubs fetch afterward for its own negotiation assertions.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({ success: true, armed: true, signature: 'TEST_ARM_SIG' }),
        { status: 200 },
      ),
    ),
  );
  const tab = await openTab({
    vault: adapter,
    network: 'solana:mainnet',
    seller: SELLER_PUBKEY, // matches TAB_ACCEPT.payTo
    perUnitCap: '0.005', // 5000 atomic = TAB_ACCEPT.amount
    totalCap: '5',
  });
  return tab as Tab & {
    rollbackVoucher(v: SignedVoucher): boolean;
    lastSignedVoucher: SignedVoucher | null;
  };
}

async function makeEvmWallets() {
  const { createEvmKeypairWallet } = await import('../../client/evm-wallet');
  return {
    evm: await createEvmKeypairWallet(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    ),
  } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('v2Strategy.pay — tab negotiation', () => {
  it('pays a tab-only 402 by X-Tab-Voucher header when opts.tab matches payTo', async () => {
    const tab = makeFakeTab(SELLER_PUBKEY);
    const voucherHeaders: string[] = [];

    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? undefined);
      const voucher = headers.get('X-Tab-Voucher');
      if (voucher) {
        voucherHeaders.push(voucher);
        return new Response('{"data":"paid-by-tab"}', { status: 200 });
      }
      return make402([TAB_ACCEPT]);
    });
    vi.stubGlobal('fetch', mockFetch);

    const challenge = await v2Strategy.parseChallenge(make402([TAB_ACCEPT]));
    expect(challenge).not.toBeNull();

    const result = await v2Strategy.pay(
      'https://example.com/api',
      { method: 'GET' },
      challenge!,
      {} as never,
      { tab },
    );

    // signNextVoucher driven with the OPTION's amount.
    expect(tab.signNextVoucher).toHaveBeenCalledTimes(1);
    expect(tab.signNextVoucher).toHaveBeenCalledWith('5000');

    // The re-request carried the serialized voucher.
    expect(voucherHeaders).toHaveLength(1);
    const decoded = JSON.parse(
      Buffer.from(voucherHeaders[0], 'base64').toString('utf8'),
    );
    expect(decoded.payload.cumulativeAmount).toBe('5000');
    expect(decoded.sessionPublicKey).toBe('01'.repeat(32));
    expect(decoded.sessionSignature).toBe('03'.repeat(64));

    // The file's real success shape.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paid).toBe(true);
      if (result.paid) {
        expect(result.amountPaid).toBe('5000');
        expect(result.network.family).toBe('svm');
        expect(await result.response!.text()).toBe('{"data":"paid-by-tab"}');
      }
    }
  });

  it('returns a graceful no-option result for a tab-only 402 WITHOUT opts.tab', async () => {
    const mockFetch = vi.fn(async () => make402([TAB_ACCEPT]));
    vi.stubGlobal('fetch', mockFetch);

    const challenge = await v2Strategy.parseChallenge(make402([TAB_ACCEPT]));
    const result = await v2Strategy.pay(
      'https://example.com/api',
      { method: 'GET' },
      challenge!,
      // A connected Solana wallet must NOT cause a plain transfer against
      // the tab accept — the scheme filter, not wallet absence, skips it.
      { solana: {} } as never,
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_payment_options');
    }
    // No payment request of any kind was sent.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('picks the exact option from a mixed tab+exact 402 without opts.tab', async () => {
    let sawTabVoucher = false;
    let sawPaymentSignature = false;

    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? undefined);
      if (headers.has('X-Tab-Voucher')) sawTabVoucher = true;
      if (headers.has('PAYMENT-SIGNATURE')) {
        sawPaymentSignature = true;
        return new Response('{"ok":true}', { status: 200 });
      }
      // Probe (and any RPC noise) → the mixed 402. RPC parse failures are
      // tolerated by the adapter's skip-on-RPC-failure balance check.
      return make402([TAB_ACCEPT, EXACT_EVM_ACCEPT]);
    });
    vi.stubGlobal('fetch', mockFetch);

    const challenge = await v2Strategy.parseChallenge(
      make402([TAB_ACCEPT, EXACT_EVM_ACCEPT]),
    );
    const result = await v2Strategy.pay(
      'https://example.com/api',
      { method: 'GET' },
      challenge!,
      await makeEvmWallets(),
      { maxAmountAtomic: '100000' },
    );

    // The exact path ran; the tab option was never paid as anything.
    expect(sawTabVoucher).toBe(false);
    expect(sawPaymentSignature).toBe(true);
    // Mock merchant doesn't verify signatures — assert the SHAPE only.
    expect(result).toHaveProperty('ok');
  });

  it('falls through to the generic path when the seller refuses the voucher (second 402)', async () => {
    const tab = makeFakeTab(SELLER_PUBKEY);
    const order: string[] = [];

    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? undefined);
      if (headers.has('X-Tab-Voucher')) {
        order.push('voucher');
        return make402([TAB_ACCEPT, EXACT_EVM_ACCEPT]); // seller refuses
      }
      if (headers.has('PAYMENT-SIGNATURE')) {
        order.push('exact');
        return new Response('{"ok":true}', { status: 200 });
      }
      return make402([TAB_ACCEPT, EXACT_EVM_ACCEPT]);
    });
    vi.stubGlobal('fetch', mockFetch);

    const challenge = await v2Strategy.parseChallenge(
      make402([TAB_ACCEPT, EXACT_EVM_ACCEPT]),
    );
    const result = await v2Strategy.pay(
      'https://example.com/api',
      { method: 'GET' },
      challenge!,
      await makeEvmWallets(),
      { tab, maxAmountAtomic: '100000' },
    );

    // Voucher attempted first, then the generic exact path.
    expect(order[0]).toBe('voucher');
    expect(order).toContain('exact');
    expect(tab.signNextVoucher).toHaveBeenCalledTimes(1);
    expect(result).toHaveProperty('ok');
  });

  it('rolls the tab back on seller refusal so close() will not double-settle the refused increment', async () => {
    const tab = await makeRealTab();

    // A prior PAID request on the tab: seq 1, cumulative 5000. This is the
    // voucher close() must settle — the refused increment must not survive.
    const preRefusal = await tab.signNextVoucher('5000');
    expect(preRefusal.payload.sequenceNumber).toBe(1);

    const refusedVouchers: string[] = [];
    const order: string[] = [];
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? undefined);
      const voucher = headers.get('X-Tab-Voucher');
      if (voucher) {
        order.push('voucher');
        refusedVouchers.push(voucher);
        return make402([TAB_ACCEPT, EXACT_EVM_ACCEPT]); // seller refuses
      }
      if (headers.has('PAYMENT-SIGNATURE')) {
        order.push('exact');
        return new Response('{"ok":true}', { status: 200 });
      }
      return make402([TAB_ACCEPT, EXACT_EVM_ACCEPT]);
    });
    vi.stubGlobal('fetch', mockFetch);

    const challenge = await v2Strategy.parseChallenge(
      make402([TAB_ACCEPT, EXACT_EVM_ACCEPT]),
    );
    const result = await v2Strategy.pay(
      'https://example.com/api',
      { method: 'GET' },
      challenge!,
      await makeEvmWallets(),
      { tab, maxAmountAtomic: '100000' },
    );

    // Voucher attempted, refused, then the generic exact path paid.
    expect(order[0]).toBe('voucher');
    expect(order).toContain('exact');
    expect(result).toHaveProperty('ok');

    // The refused voucher was seq 2 / cumulative 10000...
    expect(refusedVouchers).toHaveLength(1);
    const refused = JSON.parse(
      Buffer.from(refusedVouchers[0], 'base64').toString('utf8'),
    );
    expect(refused.payload.sequenceNumber).toBe(2);
    expect(refused.payload.cumulativeAmount).toBe('10000');

    // ...and the rollback reverted the tab to the PRE-refusal voucher, so a
    // close() here would settle seq 1 / 5000 — not the refused increment the
    // generic path already paid for.
    expect(tab.lastSignedVoucher).toBe(preRefusal);
    expect(tab.state.spent).toBe('0.005');

    // The next voucher REUSES the refused sequence/cumulative.
    const reissued = await tab.signNextVoucher('5000');
    expect(reissued.payload.sequenceNumber).toBe(2);
    expect(reissued.payload.cumulativeAmount).toBe('10000');
  });

  it('ignores the tab when its counterparty does not match the option payTo', async () => {
    const tab = makeFakeTab(OTHER_PUBKEY); // opened against a DIFFERENT seller
    const mockFetch = vi.fn(async () => make402([TAB_ACCEPT]));
    vi.stubGlobal('fetch', mockFetch);

    const challenge = await v2Strategy.parseChallenge(make402([TAB_ACCEPT]));
    const result = await v2Strategy.pay(
      'https://example.com/api',
      { method: 'GET' },
      challenge!,
      {} as never,
      { tab },
    );

    // The tab was never spent against the wrong seller.
    expect(tab.signNextVoucher).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_payment_options');
    }
  });
});
