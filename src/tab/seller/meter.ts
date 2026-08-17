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
 *     await meter.end();
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
 * Concurrency note: tabMiddleware holds one renewable fenced lease per channel,
 * so a second same-channel stream is rejected before it can share a stale
 * delivered baseline. Production multi-instance sellers must select the
 * corresponding safety mode and a cross-process adapter such as Redis.
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

  // Cumulative write-ahead delivery reservations DURING this request.
  let chargedAtomic = 0n;
  let ended = false;
  let pendingCharges = 0;
  let chargeTail: Promise<void> = Promise.resolve();

  // Delivery truth is write-ahead, not terminal best-effort. Every successful
  // charge durably advances the fenced ledger BEFORE the caller may send its
  // chunk. A hard crash can therefore conservatively account a chunk that was
  // not sent; it can never send service that disappears from restart state.
  // Close only marks the local meter terminal; there is nothing left to flush.
  res.prependListener('close', () => {
    if (ended) return;
    ended = true;
  });

  function charge(units = 1): Promise<void> {
    if (ended) return Promise.reject(new Error('meter ended'));
    if (perUnitAtomic === null) {
      return Promise.reject(new Error('charge() needs options.perUnit'));
    }
    if (!Number.isSafeInteger(units) || units <= 0) {
      return Promise.reject(new Error('charge() units must be a positive safe integer'));
    }
    const inc = perUnitAtomic * BigInt(units);
    pendingCharges += 1;
    const run = chargeTail.then(async () => {
      // Re-check inside the serialized section: another queued charge may have
      // consumed the remaining signed budget while this call was waiting.
      if (ended) throw new Error('meter ended');
      const next = chargedAtomic + inc;
      if (next > budgetAtomic) {
        ended = true; // terminate: no further send()/charge() past the cap
        throw new ScopeViolationError(
          'cumulative_exceeds_cap',
          `chunk would push delivered to ${atomicToHuman((deliveredBaselineAtomic + next).toString())} ` +
          `beyond signed cumulative ${atomicToHuman(signedAtomic.toString())} ` +
          `(per-request budget ${atomicToHuman(budgetAtomic.toString())})`,
        );
      }
      try {
        await tab.recordDelivered(inc.toString());
        chargedAtomic = next;
      } catch (error) {
        // Store/lease ambiguity fails closed before caller-controlled send().
        // If the write committed but its acknowledgement was lost, conservative
        // over-accounting is safer than re-delivering the same signed budget.
        ended = true;
        throw error;
      }
    });
    chargeTail = run.catch(() => undefined);
    return run.finally(() => {
      pendingCharges -= 1;
    });
  }

  function send(chunk: string | Uint8Array): void {
    if (ended) throw new Error('meter ended');
    if (pendingCharges > 0) {
      throw new Error('charge still pending; await meter.charge() before send()');
    }
    const data = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    // Escape backslashes BEFORE newlines so the client's unescape is a true
    // inverse. The old newline-only escape corrupted payloads that already
    // contained literal `\n` sequences (e.g. JSON.stringify output): the
    // client turned the JSON's own escapes into real newlines, breaking parse.
    const escaped = data.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
    res.write(`data: ${escaped}\n\n`);
  }

  async function end(): Promise<void> {
    if (ended) return;
    ended = true;
    res.write(`event: end\ndata: {"chargedAtomic":"${chargedAtomic}"}\n\n`);
    res.end();
  }

  return { charge, send, end };
}
