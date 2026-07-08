/**
 * Mechanical repro + regression check for the 5.3.1 SSE-meter newline hazard.
 *
 *   npx tsx frame-roundtrip-check.ts   (or: npm run check:frames)
 *
 * Server side is REAL: openSse() from @dexterai/x402/tab/seller writes frames
 * into a mock Express response, so the actual meter.send() transform runs.
 * Buyer side reproduces, verbatim from dist/tab/index.js, the SSE unwrap +
 * unescape that tab.stream() applies in 5.3.1 (the generator is not exported):
 * frames split on "\n\n", `data:` lines sliced + trimStart'd and joined with
 * "\n", stop at `event: end`, then data.replace(/\\n/g, '\n').
 *
 * Proves two things:
 *   1. THE BUG — a raw-JSON frame whose text contains "\n" arrives corrupted:
 *      the client unescape turns the JSON's literal backslash-n into a raw
 *      newline inside a string literal, JSON.parse throws, and a parse-guarded
 *      buyer silently drops the chunk.
 *   2. THE FIX — the same payload through encodeFrame()/decodeFrame() (the
 *      exact functions server.ts and buyer-snippet.ts use) round-trips
 *      deep-equal.
 */

import assert from 'node:assert/strict';
import { openSse } from '@dexterai/x402/tab/seller';
import type { Response } from 'express';
import { encodeFrame, decodeFrame } from './sse-frame.js';

// ── Mocks: enough Express response + SellerTab for openSse to run ───────────

function mockRes(sink: string[]): Response {
  return {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    on() {},
    write(chunk: string) {
      sink.push(chunk);
      return true;
    },
    end() {},
  } as unknown as Response;
}

function mockTab() {
  return {
    channelId: 'repro-channel',
    network: 'solana:mainnet' as const,
    sessionPublicKey: null,
    cumulative: () => '1.000000', // plenty of signed budget for the repro
    charge: async () => {},
    deliveredCumulative: () => '0.000000',
    recordDelivered: async () => {},
  };
}

/** Drive the REAL 5.3.1 meter: send one payload, return the wire text. */
async function throughRealMeter(payload: string): Promise<string> {
  const sink: string[] = [];
  const meter = openSse(mockRes(sink), { tab: mockTab(), perUnit: '0.000010' });
  await meter.charge(7);
  meter.send(payload);
  await meter.end();
  return sink.join('');
}

/**
 * The buyer-side SSE unwrap, verbatim 5.3.1 behavior (dist/tab/index.js):
 * split frames on "\n\n"; per frame, `event:`->name, `data:` lines
 * slice(5).trimStart() joined with "\n"; stop at `event: end`; then the
 * asymmetric unescape data.replace(/\\n/g, "\n").
 */
function clientUnwrap(wire: string): string[] {
  const out: string[] = [];
  let buf = wire;
  let at: number;
  while ((at = buf.indexOf('\n\n')) !== -1) {
    const frame = buf.slice(0, at);
    buf = buf.slice(at + 2);
    let eventName: string | null = null;
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (eventName === 'end') return out;
    if (dataLines.length) out.push(dataLines.join('\n').replace(/\\n/g, '\n'));
  }
  return out;
}

// ── The multi-line completion chunk every LLM emits constantly ──────────────

const multiLinePayload = {
  text: 'First line.\nSecond line.\n\n\tindented code\nlast line, trailing newline:\n',
  tokensCharged: 7,
  usdcAccrued: '0.000070',
};

// 1. THE BUG: raw JSON through the real meter arrives as invalid JSON.
{
  const wire = await throughRealMeter(JSON.stringify(multiLinePayload));
  const frames = clientUnwrap(wire);
  assert.equal(frames.length, 1, 'expected exactly one data frame');
  assert.notEqual(frames[0], JSON.stringify(multiLinePayload), 'frame should arrive MUTATED');
  assert.throws(
    () => JSON.parse(frames[0]),
    SyntaxError,
    'corrupted frame should fail JSON.parse (the silently-dropped-chunk bug)',
  );
  console.log('repro   raw JSON.stringify frame with "\\n" in text -> corrupted in flight, JSON.parse throws (chunk would be dropped)');
}

// 2. THE FIX: encodeFrame/decodeFrame round-trips the same payload intact.
{
  const wire = await throughRealMeter(encodeFrame(multiLinePayload));
  const frames = clientUnwrap(wire);
  assert.equal(frames.length, 1, 'expected exactly one data frame');
  const decoded = decodeFrame<typeof multiLinePayload>(frames[0]);
  assert.deepEqual(decoded, multiLinePayload, 'b64 frame must round-trip deep-equal');
  console.log('fix     b64 frame of the same payload -> round-trips byte-identical, decode deep-equals the original');
}

// 3. Belt-and-braces: backslash-heavy text (Windows paths, regex) also intact.
{
  const nasty = { text: 'C:\\notes\\new\\file\n\\n literal backslash-n too', done: false };
  const wire = await throughRealMeter(encodeFrame(nasty));
  const decoded = decodeFrame<typeof nasty>(clientUnwrap(wire)[0]);
  assert.deepEqual(decoded, nasty, 'backslash-heavy payload must round-trip');
  console.log('fix     backslash-heavy payload (C:\\..., literal \\n) -> round-trips intact');
}

console.log('frame-roundtrip-check: ALL GREEN');
