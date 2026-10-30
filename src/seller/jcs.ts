/** RFC 8785 restricted to printable ASCII strings and safe integer numbers. */
export function canonicalBytes(value: unknown): Uint8Array {
  const active = new Set<object>();
  function encode(input: unknown): string {
    if (input === null) return 'null';
    if (typeof input === 'boolean') return String(input);
    if (typeof input === 'string') {
      if (/[^\x20-\x7e]/.test(input)) throw new Error('canonical_non_ascii');
      return JSON.stringify(input);
    }
    if (typeof input === 'number') {
      if (!Number.isSafeInteger(input)) throw new Error('canonical_non_integer');
      return JSON.stringify(input);
    }
    if (typeof input !== 'object' || active.has(input)) throw new Error('canonical_unsupported');
    active.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length || Object.getOwnPropertySymbols(input).length) {
          throw new Error('canonical_unsupported');
        }
        return '[' + Array.from(input, encode).join(',') + ']';
      }
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
        throw new Error('canonical_unsupported');
      }
      if (Object.getOwnPropertySymbols(input).length) throw new Error('canonical_unsupported');
      return '{' + Object.keys(input).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!('value' in descriptor)) throw new Error('canonical_unsupported');
        return encode(key) + ':' + encode(descriptor.value);
      }).join(',') + '}';
    } finally { active.delete(input); }
  }
  return new TextEncoder().encode(encode(value));
}

export function parseCanonical(bytes: Uint8Array): unknown {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('canonical_mismatch'); }
  const encoded = canonicalBytes(value);
  if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) {
    throw new Error('canonical_mismatch');
  }
  return value;
}
