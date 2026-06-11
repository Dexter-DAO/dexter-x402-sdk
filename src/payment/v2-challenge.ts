/**
 * Pure x402 v2 challenge parsing — extracted from v2-strategy so modules
 * that only need to READ a challenge (tab URL resolution) can import the
 * parser without pulling in the payment path, which imports the tab
 * runtime (a file-level cycle otherwise).
 */
import type { PaymentChallenge, ChallengeOption } from './types';
import { toNetworkRef } from './network-map';

/** Decode a base64(url)-encoded JSON header value (PAYMENT-REQUIRED /
 *  PAYMENT-RESPONSE share the encoding). */
export function decodePaymentRequiredHeader(raw: string): unknown {
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
  const normalized = padded + '='.repeat((4 - (padded.length % 4 || 4)) % 4);
  return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
}

export function toChallengeOptions(accepts: unknown[]): ChallengeOption[] {
  const out: ChallengeOption[] = [];
  for (const a of accepts) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const net = toNetworkRef(String(o.network ?? ''));
    if (!net) continue;
    out.push({
      scheme: String(o.scheme ?? 'exact'),
      network: net,
      amount: String(o.amount ?? o.maxAmountRequired ?? '0'),
      asset: String(o.asset ?? ''),
      payTo: String(o.payTo ?? ''),
      maxTimeoutSeconds:
        typeof o.maxTimeoutSeconds === 'number' ? o.maxTimeoutSeconds : undefined,
      extra:
        o.extra && typeof o.extra === 'object'
          ? (o.extra as Record<string, unknown>)
          : undefined,
    });
  }
  return out;
}

/** Parse a 402 Response's PAYMENT-REQUIRED header into a normalized
 *  challenge, or null when the response carries none (v1 / not x402). */
export async function parseV2Challenge(res: Response): Promise<PaymentChallenge | null> {
  const header = res.headers.get('payment-required');
  if (!header) return null;
  let decoded: Record<string, unknown>;
  try {
    decoded = decodePaymentRequiredHeader(header) as Record<string, unknown>;
  } catch {
    return null;
  }
  const accepts = Array.isArray(decoded.accepts) ? decoded.accepts : [];
  if (accepts.length === 0) return null;
  return {
    x402Version: 2,
    options: toChallengeOptions(accepts),
    resourceUrl:
      decoded.resource && typeof decoded.resource === 'object'
        ? String((decoded.resource as Record<string, unknown>).url ?? '')
        : undefined,
  };
}
