import { describe, expect, it } from 'vitest';
import { canonicalBytes, parseCanonical } from '../jcs';
const text = (value: unknown) => new TextDecoder().decode(canonicalBytes(value));
describe('restricted RFC 8785', () => {
  it('sorts recursively and preserves array order and ASCII escaping', () => {
    expect(text({ z: [3, { b: false, a: null }], a: '"\\/' })).toBe('{"a":"\\"\\\\/","z":[3,{"a":null,"b":false}]}');
  });
  it('encodes RFC 8785 Appendix B safe integer vectors and negative zero', () => {
    for (const [value, expected] of [[0, '0'], [-0, '0'], [9007199254740991, '9007199254740991'], [-9007199254740991, '-9007199254740991']] as const) {
      expect(text(value)).toBe(expected);
    }
  });
  it('sorts integer-shaped member names lexically rather than JSON object order', () => {
    expect(text({ '2': 2, '10': 10, a: 1 })).toBe('{"10":10,"2":2,"a":1}');
  });
  it('rejects non-ASCII strings and keys and unsafe numbers', () => {
    for (const value of ['\n', 'é', { 'а': 1 }]) expect(() => canonicalBytes(value)).toThrow('canonical_non_ascii');
    for (const value of [NaN, Infinity, 1.5, 9007199254740992]) expect(() => canonicalBytes(value)).toThrow('canonical_non_integer');
  });
  it('rejects unsupported objects, sparse arrays, cycles and accessors', () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    const accessor = Object.defineProperty({}, 'a', { enumerable: true, get() { throw new Error('getter ran'); } });
    for (const value of [undefined, 1n, () => 1, new Date(), [undefined], Array(1), cycle, accessor]) {
      expect(() => canonicalBytes(value)).toThrow('canonical_unsupported');
    }
  });
  it('parses canonical bytes and rejects whitespace, duplicate members, alternate escapes and invalid UTF-8', () => {
    expect(parseCanonical(canonicalBytes({ a: [1, true] }))).toEqual({ a: [1, true] });
    for (const value of [' {"a":1}', '{"a":1,"a":1}', '{"a":"\\u0061"}', '{"a":-0}', 'not json']) {
      expect(() => parseCanonical(new TextEncoder().encode(value))).toThrow('canonical_mismatch');
    }
    expect(() => parseCanonical(new Uint8Array([0xff]))).toThrow('canonical_mismatch');
  });
});
