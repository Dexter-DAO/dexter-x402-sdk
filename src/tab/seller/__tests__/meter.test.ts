import { describe, it, expect } from 'vitest';
import { openSse } from '../meter';
import { InMemoryChannelLedger } from '../channel-ledger';
import type { SellerTab } from '../types';
import { atomicToHuman, humanToAtomic } from '../../tab';

// Minimal SSE-capable fake Express Response that records writes and supports
// the 'close' event (for the buyer-disconnect anti-grief test).
function fakeSseRes() {
  const writes: string[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  return {
    headersSent: false,
    setHeader() {},
    flushHeaders() {},
    write(s: string) { writes.push(s); return true; },
    end() {},
    on(event: string, cb: () => void) { (listeners[event] ??= []).push(cb); return this; },
    _emit(event: string) { (listeners[event] ?? []).forEach((cb) => cb()); },
    _writes: writes,
  } as any;
}

// Flush the fire-and-forget persist kicked off by the 'close' handler.
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

// A SellerTab stub backed by the ledger. Mirrors the real middleware: the
// delivered baseline is read ONCE (async) and captured synchronously; the
// stub exposes it via deliveredCumulative() and persists via recordDelivered().
async function makeStubTab(
  channelId: string,
  signedCumulativeHuman: string,
  ledger: InMemoryChannelLedger,
): Promise<SellerTab> {
  const prior = await ledger.get(channelId);
  const deliveredBaselineAtomic = prior ? prior.deliveredCumulativeAtomic : '0';
  return {
    channelId,
    network: 'solana:mainnet',
    sessionPublicKey: new Uint8Array(32),
    cumulative: () => signedCumulativeHuman,
    deliveredCumulative: () => atomicToHuman(deliveredBaselineAtomic),
    charge: async () => { throw new Error('tab.charge stub'); },
    recordDelivered: async (cumulativeAtomic: string) => {
      await ledger.set(channelId, {
        // lastVoucher is irrelevant to the budget math; reuse prior or a stub.
        lastVoucher: prior?.lastVoucher ?? ({
          payload: { channelId, cumulativeAmount: humanToAtomic(signedCumulativeHuman), sequenceNumber: 1 },
          sessionPublicKey: new Uint8Array(32),
          sessionRegistration: new Uint8Array(188),
          sessionSignature: new Uint8Array(64),
        } as any),
        deliveredCumulativeAtomic: cumulativeAtomic,
      });
    },
  };
}

describe('openSse delivered-ledger budget — no channel-reuse leak', () => {
  const channelId = 'a'.repeat(64);

  it('first request budgets against the full signed cumulative (delivered baseline 0)', async () => {
    const ledger = new InMemoryChannelLedger();
    const tab = await makeStubTab(channelId, '0.10', ledger);
    const meter = openSse(fakeSseRes(), { tab, perUnit: '0.01' });
    for (let i = 0; i < 10; i++) await meter.charge(1); // 10 * 0.01 = 0.10, exactly budget
    await expect(meter.charge(1)).rejects.toThrow(/cumulative_exceeds_cap/);
    await meter.end();
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.10'));
  });

  it('request 2 budget = signedCumulative − deliveredCumulative (the increment), NOT lifetime; under-delivered headroom carries forward', async () => {
    const ledger = new InMemoryChannelLedger();

    // Request 1: signed 0.10, UNDER-deliver only 0.05, then end.
    const tab1 = await makeStubTab(channelId, '0.10', ledger);
    const m1 = openSse(fakeSseRes(), { tab: tab1, perUnit: '0.01' });
    for (let i = 0; i < 5; i++) await m1.charge(1); // 0.05 delivered
    await m1.end();
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.05'));

    // Request 2: buyer bumps signed to 0.20. Correct budget = 0.20 − 0.05 = 0.15
    // (0.10 fresh + 0.05 carried headroom). The OLD bug would allow 0.20 here.
    const tab2 = await makeStubTab(channelId, '0.20', ledger);
    const m2 = openSse(fakeSseRes(), { tab: tab2, perUnit: '0.01' });
    for (let i = 0; i < 15; i++) await m2.charge(1); // 0.15 — full carried budget
    await expect(m2.charge(1)).rejects.toThrow(/cumulative_exceeds_cap/); // 16th (0.16) rejected
    await m2.end();

    // Lifetime delivered is capped at the signed 0.20 — no leak.
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.20'));
  });

  it('persists delivered-so-far when a chunk is rejected for exceeding the cap', async () => {
    const ledger = new InMemoryChannelLedger();
    const tab = await makeStubTab(channelId, '0.03', ledger);
    const meter = openSse(fakeSseRes(), { tab, perUnit: '0.01' });
    await meter.charge(1);
    await meter.charge(1);
    await meter.charge(1); // 0.03, exactly budget
    await expect(meter.charge(1)).rejects.toThrow(/cumulative_exceeds_cap/);
    // delivered persisted at the cap even though end() was never called.
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.03'));
  });

  it('persists delivered when the buyer disconnects mid-stream before end() (anti-grief)', async () => {
    const ledger = new InMemoryChannelLedger();
    const tab = await makeStubTab(channelId, '0.10', ledger);
    const res = fakeSseRes();
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(1);
    await meter.charge(1); // delivered 0.02 in-flight, never reached end()
    res._emit('close');     // buyer drops the connection
    await flushMicrotasks(); // let the fire-and-forget persist settle
    // Without the close-handler this would be null/0 → req2 re-grants budget
    // (the quadratic giveaway). With it, delivered is committed at 0.02.
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.02'));
  });

  it('does not double-write on a normal end() (the res.end()-triggered close is ignored)', async () => {
    const ledger = new InMemoryChannelLedger();
    const tab = await makeStubTab(channelId, '0.10', ledger);
    const res = fakeSseRes();
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(1); // 0.01
    await meter.end();     // sets ended=true, persists 0.01
    res._emit('close');    // would fire after res.end(); must be a no-op
    await flushMicrotasks();
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.01'));
  });
});
