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

/**
 * Classify a FAILED paid-retry response.
 *
 * When a payment is submitted and the merchant still returns non-2xx, the
 * cause splits two ways and the caller must not conflate them:
 *
 *  - `merchant_rejected` — the merchant rejected the payment itself (bad or
 *    declined payload, failed verification). Look at our payment.
 *  - `settlement_failed` — the merchant ACCEPTED the payload but their own
 *    settlement step failed (their facilitator errored). Not our payload —
 *    a merchant-side defect; routing to a different provider is the move.
 *
 * The merchant's verbatim error text is always carried in `detail` — never
 * discarded — so an agent (or a human) sees whose fault it is at a glance,
 * instead of a bare "HTTP 402".
 *
 * Reads the response via .clone() so the caller's body is left intact.
 */
export async function classifyPaidFailure(
  res: Response,
): Promise<{ reason: 'merchant_rejected' | 'settlement_failed'; detail: string }> {
  let bodyText = '';
  try {
    bodyText = (await res.clone().text()).slice(0, 600);
  } catch {
    /* unreadable body — fall through with empty bodyText */
  }

  // A settlement failure is the merchant's facilitator erroring AFTER
  // accepting the payment. It shows up as a settle/settlement-flavoured
  // error string in the body (e.g. strale.io: "Payment settlement failed").
  const lower = bodyText.toLowerCase();
  const isSettlement =
    lower.includes('settle') || // "settlement failed", "failed to settle"
    lower.includes('facilitator'); // some merchants name their facilitator

  // Pull a human message out of the body — a JSON {error}/{detail}/{message}
  // field if present, else the raw text, else the bare status.
  let detail = bodyText;
  try {
    const j = JSON.parse(bodyText) as Record<string, unknown>;
    const parts = [j.error, j.detail, j.message]
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (parts.length > 0) detail = parts.join(' — ');
  } catch {
    /* non-JSON body — keep the raw text */
  }
  if (!detail) detail = `HTTP ${res.status}`;

  return {
    reason: isSettlement ? 'settlement_failed' : 'merchant_rejected',
    detail: `merchant HTTP ${res.status}: ${detail}`,
  };
}
