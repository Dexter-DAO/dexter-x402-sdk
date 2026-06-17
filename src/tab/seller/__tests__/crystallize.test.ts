import { describe, it, expect, vi } from 'vitest';

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
