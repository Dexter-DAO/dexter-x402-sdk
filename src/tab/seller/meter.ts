/**
 * SSE meter: turn an Express response into a Server-Sent-Events stream
 * tied to a tab. The route handler calls `charge()` before each chunk
 * (which demands a fresh voucher from the buyer) and `send()` to push
 * the chunk down the wire.
 *
 * The streaming pattern this enables:
 *
 *   app.post('/inference', tabMiddleware({...}), async (req, res) => {
 *     const tab = requireTab(req);
 *     const meter = openSse(res, { tab, perUnit: '0.00003' });
 *     for await (const token of llm(req.body.prompt)) {
 *       await meter.charge();          // demand voucher; throws if cap exceeded
 *       meter.send(token);              // emit SSE event with the token
 *     }
 *     meter.end();
 *   });
 *
 * NOTE on voucher cadence: this implementation treats EACH `charge()` as
 * "the buyer already presented a voucher covering this chunk via the
 * inbound request header" — i.e. the request's voucher header bounds the
 * cumulative the seller can deliver under. For true per-chunk voucher
 * exchange mid-stream (the buyer presenting fresh vouchers WITHIN one
 * HTTP request), the seller needs to read vouchers off the response
 * stream's reverse direction or via WebSocket. That's an advanced mode
 * left for Phase 4+; the v3 meter ships the simpler "one voucher bounds
 * the whole request" model, which is correct for any reasonable chunk
 * count under a single per-request increment.
 *
 * Concurrency note: delivered accounting is exact for requests that run
 * sequentially per channel (the normal case — an agent streams one request at
 * a time per tab). Two GENUINELY concurrent streams on the SAME channel each
 * read the same delivered baseline, so they can over-deliver in-flight up to
 * the sum of their budgets before either persists. The lifetime ledger stays
 * correct (additive under a per-channel lock), so the over-delivery is bounded
 * to the overlap and never compounds across future requests. Sellers needing
 * exact metering under parallel same-channel streams should serialize requests
 * per channel.
 */

import type { Response } from 'express';

import type { SellerTab, SseMeter, OpenSseOptions } from './types';
import { atomicToHuman, humanToAtomic } from '../tab';
import { ScopeViolationError } from './verify';

export function openSse(res: Response, options: OpenSseOptions): SseMeter {
  if (!options.tab) throw new Error('openSse requires options.tab');

  // Initialize SSE headers if not already sent.
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Flush headers so the client starts reading.
    if (typeof (res as any).flushHeaders === 'function') {
      (res as any).flushHeaders();
    }
  }

  const tab: SellerTab = options.tab;

  // Per-request budget = what the buyer authorized via THIS voucher's signed
  // cumulative, MINUS what the meter has already delivered on this channel
  // across prior requests (read from the ChannelLedger at request start).
  // This enforces lifetime `delivered ≤ signed` and carries unused budget
  // forward — closing the channel-reuse leak where budgeting against the full
  // lifetime cumulative let the seller re-deliver it every request.
  const signedAtomic = BigInt(humanToAtomic(tab.cumulative()));
  const deliveredBaselineAtomic = BigInt(humanToAtomic(tab.deliveredCumulative()));
  let budgetAtomic = signedAtomic - deliveredBaselineAtomic;
  if (budgetAtomic < 0n) budgetAtomic = 0n; // defensive; monotonicity upstream prevents this

  const perUnitAtomic = options.perUnit
    ? BigInt(humanToAtomic(options.perUnit))
    : null;

  // Cumulative delivered DURING this request (resets per request, as before).
  let chargedAtomic = 0n;
  let ended = false;

  // Persist the lifetime delivered cumulative (baseline + this request's
  // delivery) to the ledger. Called on EVERY terminal path — clean end,
  // cap-exceeded, AND client disconnect/abort — so a buyer CANNOT grief the
  // seller by consuming service then dropping the connection before end()
  // (that would otherwise leave delivered un-advanced and re-grant the budget
  // next request — a quadratic giveaway). The only unpersisted window left is a
  // hard process crash: not buyer-controllable, bounded to in-flight requests,
  // same class as the existing voucher-store crash window. Per-chunk
  // checkpointing would only SHRINK that hard-crash window (never close it —
  // you can always crash between chunk and write) at a write-per-token cost, so
  // we persist per terminal event instead.
  async function persistDelivered(): Promise<void> {
    await tab.recordDelivered(chargedAtomic.toString());
  }

  // Buyer-controlled termination: if the client drops the connection mid-stream
  // the underlying response emits 'close'; commit what we delivered. Best-effort
  // (can't await in an event handler), but the ledger write completes because on
  // a disconnect the process is still alive. Guarded by `ended` so a normal
  // end() — which also emits 'close' via res.end() — doesn't double-write.
  res.on('close', () => {
    if (ended) return;
    ended = true;
    void persistDelivered().catch((err) => {
      // Best-effort: a failed disconnect-persist must not crash the process.
      // The residual unpersisted window is the documented hard-crash case.
      console.error('[tab/seller] failed to persist delivered on disconnect:', err);
    });
  });

  async function charge(units = 1): Promise<void> {
    if (ended) throw new Error('meter ended');
    if (perUnitAtomic === null) throw new Error('charge() needs options.perUnit');
    const inc = perUnitAtomic * BigInt(units);
    const next = chargedAtomic + inc;
    if (next > budgetAtomic) {
      ended = true; // terminate: no further send()/charge() past the cap
      await persistDelivered(); // commit what we DID deliver before refusing
      throw new ScopeViolationError(
        'cumulative_exceeds_cap',
        `chunk would push delivered to ${atomicToHuman((deliveredBaselineAtomic + next).toString())} ` +
        `beyond signed cumulative ${atomicToHuman(signedAtomic.toString())} ` +
        `(per-request budget ${atomicToHuman(budgetAtomic.toString())})`,
      );
    }
    chargedAtomic = next;
  }

  function send(chunk: string | Uint8Array): void {
    if (ended) throw new Error('meter ended');
    const data = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const escaped = data.replace(/\n/g, '\\n');
    res.write(`data: ${escaped}\n\n`);
  }

  async function end(): Promise<void> {
    if (ended) return;
    ended = true;
    await persistDelivered();
    res.write(`event: end\ndata: {"chargedAtomic":"${chargedAtomic}"}\n\n`);
    res.end();
  }

  return { charge, send, end };
}
