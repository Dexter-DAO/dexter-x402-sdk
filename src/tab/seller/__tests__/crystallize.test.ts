import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { maybeCrystallize, crystallizeNow } from '../crystallize';
import type { ChannelLedgerEntry } from '../channel-ledger';
import type { SignedVoucher, TabNetworkId } from '../../types';

const CHANNEL_ID = 'a'.repeat(64);
const FACILITATOR = 'https://facilitator.example.com';
const NETWORK: TabNetworkId = 'solana:mainnet';

function fakeVoucher(channelId: string, cumulativeAmount: string, seq = 1): SignedVoucher {
  return {
    payload: { channelId, cumulativeAmount, sequenceNumber: seq },
    sessionPublicKey: new Uint8Array(32).fill(0xaa),
    sessionRegistration: new Uint8Array(188).fill(0xbb),
    sessionSignature: new Uint8Array(64).fill(0xcc),
  };
}

function entryFor(deliveredAtomic: string, crystallizedAtomic = '0', cumulative = deliveredAtomic): ChannelLedgerEntry {
  return {
    lastVoucher: fakeVoucher(CHANNEL_ID, cumulative),
    deliveredCumulativeAtomic: deliveredAtomic,
    lastCrystallizedCumulativeAtomic: crystallizedAtomic,
  };
}

/** A fetch impl that records calls and returns a 200 with a claimPda body. */
function okFetch() {
  const calls: Array<{ url: string; init: any; body: any }> = [];
  const fetchImpl = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ claimPda: 'ClaimPda1111' }), { status: 200 });
  });
  return { fetchImpl, calls };
}

const HEX_RE = /^[0-9a-f]+$/i;

describe('crystallizeNow', () => {
  it('POSTs the stored voucher to /tab/lock with the postSettle wire shape', async () => {
    const { fetchImpl, calls } = okFetch();
    const entry = entryFor('100000');

    const result = await crystallizeNow(entry, CHANNEL_ID, FACILITATOR, NETWORK, fetchImpl as any);

    expect(result.crystallized).toBe(true);
    expect(result.claimPda).toBe('ClaimPda1111');
    expect(calls).toHaveLength(1);

    expect(calls[0].url).toBe(`${FACILITATOR}/tab/lock`);
    expect(calls[0].init.method).toBe('POST');

    const body = calls[0].body;
    // Same field set + encodings as postSettle().
    expect(body.channelId).toBe(CHANNEL_ID);
    expect(body.cumulativeAmount).toBe('100000');
    expect(typeof body.cumulativeAmount).toBe('string');
    expect(body.sequenceNumber).toBe(1);
    expect(body.network).toBe(NETWORK);
    // Hex-encoded byte fields.
    expect(body.sessionPublicKey).toMatch(HEX_RE);
    expect(body.sessionSignature).toMatch(HEX_RE);
    expect(body.sessionRegistration).toMatch(HEX_RE);
    // 32-byte pubkey → 64 hex chars; 64-byte sig → 128.
    expect(body.sessionPublicKey).toHaveLength(64);
    expect(body.sessionSignature).toHaveLength(128);
  });

  it('is a no-op when lastVoucher is null', async () => {
    const { fetchImpl, calls } = okFetch();
    const entry: ChannelLedgerEntry = {
      lastVoucher: null,
      deliveredCumulativeAtomic: '100000',
      lastCrystallizedCumulativeAtomic: '0',
    };

    const result = await crystallizeNow(entry, CHANNEL_ID, FACILITATOR, NETWORK, fetchImpl as any);

    expect(result.crystallized).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('resolves (does not throw) when fetch rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const entry = entryFor('100000');

    const result = await crystallizeNow(entry, CHANNEL_ID, FACILITATOR, NETWORK, fetchImpl as any);
    expect(result.crystallized).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('resolves (does not throw) on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const entry = entryFor('100000');

    const result = await crystallizeNow(entry, CHANNEL_ID, FACILITATOR, NETWORK, fetchImpl as any);
    expect(result.crystallized).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // FIX B — bounded fetch: the POST must carry an AbortSignal so a hung
  // facilitator can't leak the connection forever.
  it('passes an AbortSignal on the fetch init (bounded POST)', async () => {
    const { fetchImpl, calls } = okFetch();
    const entry = entryFor('100000');

    await crystallizeNow(entry, CHANNEL_ID, FACILITATOR, NETWORK, fetchImpl as any);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('an aborted fetch still resolves on the best-effort path (no throw)', async () => {
    // Simulate the abort the timeout would produce.
    const fetchImpl = vi.fn(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    const entry = entryFor('100000');

    const result = await crystallizeNow(entry, CHANNEL_ID, FACILITATOR, NETWORK, fetchImpl as any);
    expect(result.crystallized).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // FIX D — _channelId is now a cheap correctness guard, not a dead param.
  it('returns channel_id_mismatch (does not POST) when the voucher channelId disagrees', async () => {
    const { fetchImpl, calls } = okFetch();
    const entry = entryFor('100000'); // voucher.payload.channelId === CHANNEL_ID

    const result = await crystallizeNow(entry, 'b'.repeat(64), FACILITATOR, NETWORK, fetchImpl as any);
    expect(result.crystallized).toBe(false);
    expect(result.error).toBe('channel_id_mismatch');
    expect(calls).toHaveLength(0); // never POSTed a mismatched voucher
  });
});

describe('maybeCrystallize', () => {
  const cadence = { thresholdAtomic: '100000', onClose: true };

  it('does NOT fire below threshold (delta < threshold)', async () => {
    const { fetchImpl, calls } = okFetch();
    const entry = entryFor('50000', '0');

    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any });

    expect(calls).toHaveLength(0);
    expect(entry.lastCrystallizedCumulativeAtomic).toBe('0');
  });

  it('fires exactly when the un-crystallized delta crosses the threshold', async () => {
    const { fetchImpl, calls } = okFetch();
    const entry = entryFor('100000', '0');

    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any });

    expect(calls).toHaveLength(1);
    // Advances so a re-fire below the next threshold does not happen.
    expect(entry.lastCrystallizedCumulativeAtomic).toBe('100000');
  });

  it('advances lastCrystallized so a second call below the next threshold does NOT re-fire', async () => {
    const { fetchImpl, calls } = okFetch();
    const entry = entryFor('100000', '0');

    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any });
    expect(calls).toHaveLength(1);
    expect(entry.lastCrystallizedCumulativeAtomic).toBe('100000');

    // Deliver a bit more, but not a full threshold past the last crystallize.
    // The buyer's voucher advances in lock-step (the meter caps delivery at the
    // signed voucher, so a higher delivered implies a higher signed voucher).
    entry.deliveredCumulativeAtomic = '150000';
    entry.lastVoucher = fakeVoucher(CHANNEL_ID, '150000');
    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any });
    expect(calls).toHaveLength(1); // no second fire
    expect(entry.lastCrystallizedCumulativeAtomic).toBe('100000');

    // Now cross the next threshold.
    entry.deliveredCumulativeAtomic = '200000';
    entry.lastVoucher = fakeVoucher(CHANNEL_ID, '200000');
    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any });
    expect(calls).toHaveLength(2);
    // Watermark advances to the POSTed voucher cumulative (FIX C1).
    expect(entry.lastCrystallizedCumulativeAtomic).toBe('200000');
  });

  it('does NOT advance lastCrystallized when the POST fails (so it retries next time)', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const entry = entryFor('100000', '0');

    const result = await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, {
      fetchImpl: fetchImpl as any,
    });

    expect(result.crystallized).toBe(false);
    // Best-effort: no advance on failure → next call retries.
    expect(entry.lastCrystallizedCumulativeAtomic).toBe('0');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A retry at/over the same threshold fires again.
    const { fetchImpl: okImpl, calls } = okFetch();
    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: okImpl as any });
    expect(calls).toHaveLength(1);
    expect(entry.lastCrystallizedCumulativeAtomic).toBe('100000');
  });

  // FIX C1 — the watermark tracks the CRYSTALLIZED VOUCHER cumulative, not a
  // delivered snapshot. When the signed voucher's cumulative exceeds delivered
  // (it always >= delivered, since the meter caps delivery at signed), the
  // watermark must advance to the voucher cumulative that was actually POSTed.
  it('advances lastCrystallized to the POSTed voucher cumulative, not the delivered snapshot', async () => {
    const { fetchImpl, calls } = okFetch();
    // delivered = 100000 (crosses threshold), but the signed voucher cumulative
    // is HIGHER at 130000 — that 130000 is what gets crystallized on-chain.
    const entry = entryFor('100000', '0', '130000');

    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.cumulativeAmount).toBe('130000'); // POSTed the voucher cumulative
    // Watermark advances to the POSTED voucher cumulative, NOT delivered (100000).
    expect(entry.lastCrystallizedCumulativeAtomic).toBe('130000');
  });

  it('does not reject even if fetch throws (best-effort contract)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    const entry = entryFor('100000', '0');

    await expect(
      maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any }),
    ).resolves.toBeDefined();
    expect(entry.lastCrystallizedCumulativeAtomic).toBe('0');
  });
});

// ── Loud logging (no-silent-fallbacks) ─────────────────────────────────
//
// The best-effort contract is unchanged (never throws, never blocks), but a
// crystallize failure must NEVER be invisible: it is the seller-protection
// path — silence here is how a dead /tab/lock went unnoticed in production.
describe('crystallize loud logging', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  const allCalls = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

  it('console.errors when the POST returns a non-2xx (real failure)', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"tab_lock_failed"}', { status: 500 }));
    const entry = entryFor('100000');

    await crystallizeNow(entry, CHANNEL_ID, FACILITATOR, NETWORK, fetchImpl as any);

    expect(errSpy).toHaveBeenCalled();
    const logged = allCalls(errSpy);
    expect(logged).toContain('crystallize');
    expect(logged).toContain('500');
    expect(logged).toContain(CHANNEL_ID.slice(0, 16)); // channel identifiable
  });

  it('console.errors when fetch rejects (facilitator unreachable)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED facilitator down');
    });
    const entry = entryFor('100000');

    await crystallizeNow(entry, CHANNEL_ID, FACILITATOR, NETWORK, fetchImpl as any);

    expect(errSpy).toHaveBeenCalled();
    expect(allCalls(errSpy)).toContain('ECONNREFUSED');
  });

  it('console.errors on channel_id_mismatch (never silently drops a mis-keyed voucher)', async () => {
    const { fetchImpl } = okFetch();
    const entry = entryFor('100000');

    await crystallizeNow(entry, 'b'.repeat(64), FACILITATOR, NETWORK, fetchImpl as any);

    expect(errSpy).toHaveBeenCalled();
    expect(allCalls(errSpy)).toContain('channel_id_mismatch');
  });

  it('console.warns (not errors) on a 409 duplicate — the voucher is already secured on-chain', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"claim_already_exists","claimPda":"X"}', { status: 409 }),
    );
    const entry = entryFor('100000');

    await crystallizeNow(entry, CHANNEL_ID, FACILITATOR, NETWORK, fetchImpl as any);

    expect(warnSpy).toHaveBeenCalled();
    expect(allCalls(warnSpy)).toContain('claim_already_exists');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('console.infos a success line carrying the claimPda (lock landed must be visible too)', async () => {
    const { fetchImpl } = okFetch();
    const entry = entryFor('100000');

    const result = await crystallizeNow(entry, CHANNEL_ID, FACILITATOR, NETWORK, fetchImpl as any);

    expect(result.crystallized).toBe(true);
    expect(infoSpy).toHaveBeenCalled();
    expect(allCalls(infoSpy)).toContain('ClaimPda1111');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('stays silent on the normal no-op (lastVoucher null)', async () => {
    const { fetchImpl } = okFetch();
    const entry: ChannelLedgerEntry = {
      lastVoucher: null,
      deliveredCumulativeAtomic: '0',
      lastCrystallizedCumulativeAtomic: '0',
    };

    await crystallizeNow(entry, CHANNEL_ID, FACILITATOR, NETWORK, fetchImpl as any);

    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('below-threshold maybeCrystallize stays silent (hot path must not spam)', async () => {
    const { fetchImpl } = okFetch();
    const entry = entryFor('50000', '0');

    await maybeCrystallize(
      entry, CHANNEL_ID, FACILITATOR, NETWORK,
      { thresholdAtomic: '100000', onClose: true },
      { fetchImpl: fetchImpl as any },
    );

    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('console.warns (not errors) on a below_lock_cadence gate refusal — benign, engine-protected', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"below_lock_cadence","threshold_atomic":"10000"}', { status: 409 }),
    );
    const entry = entryFor('100000');

    await crystallizeNow(entry, CHANNEL_ID, FACILITATOR, NETWORK, fetchImpl as any);

    expect(warnSpy).toHaveBeenCalled();
    expect(allCalls(warnSpy)).toContain('below_lock_cadence');
    expect(errSpy).not.toHaveBeenCalled();
  });
});

// ── K-T3 / cadence spec §5 [A12] — the gate-refused watermark ───────────
//
// The facilitator's router gate rejects seller-initiated /tab/lock with
// `below_lock_cadence` when the un-hardened tail is under the server-side
// threshold (the facilitator's ENGINE already guarantees the protection
// cadence — the seller loses nothing). The SDK must NOT re-attempt the SAME
// refused span on every subsequent delivery — that's a retry storm against
// the gate. A NEW signed voucher (higher cumulative) always re-attempts.
describe('maybeCrystallize — gate-refused watermark (below_lock_cadence)', () => {
  const cadence = { thresholdAtomic: '100000', onClose: true };

  function refusingFetch() {
    const calls: Array<{ body: any }> = [];
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      calls.push({ body: JSON.parse(init.body) });
      return new Response('{"error":"below_lock_cadence","threshold_atomic":"250000"}', { status: 409 });
    });
    return { fetchImpl, calls };
  }

  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('a refusal advances the gate-refused watermark to the POSTed voucher cumulative (no lastCrystallized advance)', async () => {
    const { fetchImpl } = refusingFetch();
    const entry = entryFor('100000', '0', '130000');

    const result = await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, {
      fetchImpl: fetchImpl as any,
    });

    expect(result.crystallized).toBe(false);
    expect(entry.gateRefusedCumulativeAtomic).toBe('130000'); // the POSTed voucher
    expect(entry.lastCrystallizedCumulativeAtomic).toBe('0'); // nothing locked
  });

  it('does NOT re-attempt the same refused span on subsequent deliveries (storm guard)', async () => {
    const { fetchImpl } = refusingFetch();
    const entry = entryFor('100000', '0');

    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // More deliveries arrive but the SIGNED voucher hasn't advanced — the
    // refused span is unchanged. Every re-check must be a silent no-op.
    entry.deliveredCumulativeAtomic = '100000';
    warnSpy.mockClear();
    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any });
    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any });

    expect(fetchImpl).toHaveBeenCalledTimes(1); // no re-fire
    expect(warnSpy).not.toHaveBeenCalled(); // suppression is quiet (hot path)
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('re-attempts once a HIGHER voucher cumulative arrives (the span grew)', async () => {
    const { fetchImpl, calls } = refusingFetch();
    const entry = entryFor('100000', '0');

    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    entry.deliveredCumulativeAtomic = '200000';
    entry.lastVoucher = fakeVoucher(CHANNEL_ID, '200000', 2);
    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls[1].body.cumulativeAmount).toBe('200000');
    expect(entry.gateRefusedCumulativeAtomic).toBe('200000'); // watermark tracks the latest refusal
  });

  it('a success clears the gate-refused watermark and advances lastCrystallized', async () => {
    const refusing = refusingFetch();
    const entry = entryFor('100000', '0');
    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, {
      fetchImpl: refusing.fetchImpl as any,
    });
    expect(entry.gateRefusedCumulativeAtomic).toBe('100000');

    entry.deliveredCumulativeAtomic = '300000';
    entry.lastVoucher = fakeVoucher(CHANNEL_ID, '300000', 3);
    const { fetchImpl: okImpl } = okFetch();
    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: okImpl as any });

    expect(entry.lastCrystallizedCumulativeAtomic).toBe('300000');
    expect(entry.gateRefusedCumulativeAtomic).toBeUndefined();
  });

  it('a real (non-gate) failure does NOT advance the gate-refused watermark — it retries', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"tab_lock_failed"}', { status: 500 }));
    const entry = entryFor('100000', '0');

    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any });
    expect(entry.gateRefusedCumulativeAtomic).toBeUndefined();

    // Same span retries on the next check (best-effort contract unchanged).
    await maybeCrystallize(entry, CHANNEL_ID, FACILITATOR, NETWORK, cadence, { fetchImpl: fetchImpl as any });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
