/**
 * SSE escape round-trip (found live 2026-07-18): JSON frames containing their
 * own `\n` escape sequences (e.g. thinking text ".\n\n" stringified) were
 * corrupted by the newline-only escape — the client unescape turned the JSON's
 * literal backslash-n into real newlines, breaking JSON.parse.
 */
import { describe, it, expect } from 'vitest';

// Mirror the exact transforms in meter.send / decodeSseChunks.
const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
const unescape = (s: string) => s.replace(/\\(\\|n)/g, (_, c: string) => (c === 'n' ? '\n' : '\\'));

describe('SSE escape round-trip', () => {
  const cases = [
    JSON.stringify({ type: 'thinking', text: '.\n\n' }),
    JSON.stringify({ type: 'token', text: 'line1\nline2\\already-escaped\\n' }),
    JSON.stringify({ text: 'windows\\path\\n\\\\double' }),
    'plain text with\nreal newline',
    'backslash-n literal: \\n and real:\n',
  ];
  for (const original of cases) {
    it(`round-trips ${JSON.stringify(original.slice(0, 40))}`, () => {
      const wire = escape(original);
      expect(wire).not.toContain('\n'); // SSE-safe: no raw newlines on the wire
      expect(unescape(wire)).toBe(original);
    });
  }
  it('JSON frames parse after round-trip', () => {
    const frame = { v: 1, type: 'thinking', text: 'a\nb\\c', meter: { seq: 7 } };
    const original = JSON.stringify(frame);
    expect(JSON.parse(unescape(escape(original)))).toEqual(frame);
  });
});
