/** Handle for a running auto-settlement loop. */
export interface AutoLoopHandle {
  /** Halts the loop and runs one final claimAndSettle flush. */
  stop(): Promise<void>;
}

/**
 * Starts a background auto-settlement loop. On each interval it runs one
 * claimAndSettle pass. A pass that throws is caught and logged — the loop
 * keeps running. stop() clears the timer and runs a final flush so no channel
 * is left stranded at shutdown.
 *
 * Note: the upstream BatchSettlementChannelManager has its own start() with
 * separate claim/settle/refund intervals; this loop wraps a single
 * claimAndSettle pass on one interval, which is sufficient here (claim and
 * settle happen together; refunds ride the same call's claimAndSettle path).
 */
export function startAutoLoop(args: {
  /** Runs one claim+settle pass. */
  claimAndSettle: () => Promise<void>;
  /** Milliseconds between passes. */
  claimIntervalMs: number;
  /** Optional logger for pass failures. */
  onError?: (err: unknown) => void;
}): AutoLoopHandle {
  let stopped = false;

  const runPass = async (): Promise<void> => {
    try {
      await args.claimAndSettle();
    } catch (err) {
      args.onError?.(err);
    }
  };

  const timer = setInterval(() => {
    if (!stopped) void runPass();
  }, args.claimIntervalMs);
  // Do not keep the process alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    async stop() {
      // Idempotent: a second (or later) call is a no-op so the timer is
      // cleared once and the final flush runs exactly once.
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // Final flush — settle anything accumulated since the last tick.
      await runPass();
    },
  };
}
