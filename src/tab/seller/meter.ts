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
  // Cumulative budget for THIS request: what the buyer authorized via the
  // voucher header. The middleware put it in tab.cumulative() already.
  const budgetAtomic = BigInt(humanToAtomic(tab.cumulative()));

  // Per-chunk unit price. Defaults are passed via tabMiddleware's perUnit;
  // openSse can override.
  const perUnitAtomic = options.perUnit
    ? BigInt(humanToAtomic(options.perUnit))
    : null;

  // Cumulative the meter has authorized so far on this request.
  let chargedAtomic = 0n;
  let ended = false;

  function charge(units = 1): Promise<void> {
    if (ended) return Promise.reject(new Error('meter ended'));
    if (perUnitAtomic === null) {
      return Promise.reject(new Error('charge() needs options.perUnit'));
    }
    const inc = perUnitAtomic * BigInt(units);
    const next = chargedAtomic + inc;
    if (next > budgetAtomic) {
      return Promise.reject(
        new ScopeViolationError(
          'cumulative_exceeds_cap',
          `chunk would push request total to ${atomicToHuman(next.toString())} ` +
          `beyond voucher-authorized budget ${atomicToHuman(budgetAtomic.toString())}`,
        ),
      );
    }
    chargedAtomic = next;
    return Promise.resolve();
  }

  function send(chunk: string | Uint8Array): void {
    if (ended) throw new Error('meter ended');
    const data = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    // SSE format: each event is a line `data: <payload>\n\n`.
    // We escape newlines inside the payload so the event boundary is clear.
    const escaped = data.replace(/\n/g, '\\n');
    res.write(`data: ${escaped}\n\n`);
  }

  function end(): void {
    if (ended) return;
    ended = true;
    // SSE close: write an empty event so EventSource sees a clean end,
    // then end the underlying response.
    res.write(`event: end\ndata: {"chargedAtomic":"${chargedAtomic}"}\n\n`);
    res.end();
  }

  return { charge, send, end };
}
