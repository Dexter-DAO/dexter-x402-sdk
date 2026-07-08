/**
 * Newline-proof SSE frame codec, shared by server.ts (encode) and
 * buyer-snippet.ts (decode). One module so the two sides can never drift.
 *
 * WHY THIS EXISTS: the @dexterai/x402 5.3.1 SSE meter transforms payloads
 * asymmetrically across the wire.
 *
 *   server  meter.send()   escapes only RAW newlines
 *                          (payload.replace(/\n/g, '\\n') — a no-op for
 *                          JSON.stringify output, which never emits raw
 *                          newlines)
 *   buyer   tab.stream()   rewrites EVERY literal backslash-n back into a
 *                          raw newline (data.replace(/\\n/g, '\n'))
 *
 * So a raw-JSON frame whose string values contain "\n" — any multi-line
 * model output — arrives with raw control characters inside a JSON string.
 * That is invalid JSON: JSON.parse throws, and a parse-guarded buyer
 * silently drops the chunk.
 *
 * Base64 sidesteps both transforms: its alphabet ([A-Za-z0-9+/=]) contains
 * neither a raw newline nor a backslash, so the frame crosses the meter
 * byte-identical no matter what the payload contains. `npm run check:frames`
 * proves both the corruption and the fix mechanically.
 */

/** JSON payload -> `b64:<base64(JSON)>` — safe through the 5.3.1 SSE meter. */
export function encodeFrame(payload: unknown): string {
  return `b64:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

/**
 * Inverse of `encodeFrame`. Returns the parsed payload, or null when the
 * frame is not one of ours (stay defensive: anything unprefixed or
 * unparseable is skipped, never thrown on).
 */
export function decodeFrame<T>(frame: string): T | null {
  if (!frame.startsWith('b64:')) return null;
  try {
    return JSON.parse(Buffer.from(frame.slice(4), 'base64').toString('utf8')) as T;
  } catch {
    return null;
  }
}
