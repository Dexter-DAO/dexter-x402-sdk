import { describe, it, expect, vi } from 'vitest';
import { startAutoLoop } from '../auto-loop';

describe('startAutoLoop', () => {
  it('runs a claim pass on each interval tick', async () => {
    vi.useFakeTimers();
    let claimCalls = 0;
    const handle = startAutoLoop({
      claimAndSettle: async () => { claimCalls += 1; },
      claimIntervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(3500);
    expect(claimCalls).toBe(3);
    await handle.stop();
    vi.useRealTimers();
  });

  it('stop() halts the loop and runs a final flush', async () => {
    vi.useFakeTimers();
    let claimCalls = 0;
    let flushed = false;
    const handle = startAutoLoop({
      claimAndSettle: async () => { claimCalls += 1; flushed = true; },
      claimIntervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1500); // 1 tick
    await handle.stop();                     // flush => +1
    expect(flushed).toBe(true);
    const afterStop = claimCalls;
    await vi.advanceTimersByTimeAsync(5000); // no more ticks after stop
    expect(claimCalls).toBe(afterStop);
    vi.useRealTimers();
  });

  it('stop() is idempotent — a second call runs no extra flush', async () => {
    vi.useFakeTimers();
    let claimCalls = 0;
    const handle = startAutoLoop({
      claimAndSettle: async () => { claimCalls += 1; },
      claimIntervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1500); // 1 tick
    await handle.stop();                     // flush => total should be 2
    const afterFirstStop = claimCalls;
    await handle.stop();                     // second stop — no extra flush
    expect(claimCalls).toBe(afterFirstStop);
    vi.useRealTimers();
  });

  it('a failing claim pass does not stop the loop', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const handle = startAutoLoop({
      claimAndSettle: async () => { calls += 1; throw new Error('claim boom'); },
      claimIntervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(3500);
    expect(calls).toBe(3); // kept ticking despite each throw
    await handle.stop().catch(() => {});
    vi.useRealTimers();
  });
});
