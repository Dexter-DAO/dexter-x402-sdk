/**
 * Shared error-detail extraction for the payment seam.
 *
 * Some thrown errors — notably `@solana/spl-token`'s
 * `TokenOwnerOffCurveError` — are real `Error` instances but carry an
 * EMPTY `message`. A typed failure whose `detail` is `""` is useless for
 * debugging, so the seam falls back to the error's class `name` (and, if
 * even that is absent, to `String(err)`). Every `catch` in the seam that
 * maps a throw into a `{ ok: false, detail }` result uses this.
 */

/** Best-effort human-readable detail for a caught throw. Never empty. */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    if (err.message && err.message.length > 0) return err.message;
    if (err.name && err.name.length > 0) return err.name;
  }
  const s = String(err);
  return s.length > 0 ? s : 'unknown error';
}
