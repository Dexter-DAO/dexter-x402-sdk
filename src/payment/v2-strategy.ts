/**
 * x402 v2 strategy. v2 carries the challenge in a base64-encoded
 * PAYMENT-REQUIRED header. parseChallenge returns null when the
 * response has no such header (i.e. it is a v1 response) so the
 * dispatcher can fall through to the v1 strategy.
 *
 * MUST NOT import v1-strategy.
 */
import type {
  PaymentStrategy,
  PaymentChallenge,
  ChallengeOption,
  PayResult,
  PayAndFetchOptions,
} from './types';
import type { WalletSet } from '../adapters/types';
import { toNetworkRef } from './network-map';

function decodeHeader(raw: string): unknown {
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
  const normalized = padded + '='.repeat((4 - (padded.length % 4 || 4)) % 4);
  return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
}

function toOptions(accepts: unknown[]): ChallengeOption[] {
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

export const v2Strategy: PaymentStrategy = {
  version: 2,

  async parseChallenge(res: Response): Promise<PaymentChallenge | null> {
    const header = res.headers.get('payment-required');
    if (!header) return null;
    let decoded: Record<string, unknown>;
    try {
      decoded = decodeHeader(header) as Record<string, unknown>;
    } catch {
      return null;
    }
    const accepts = Array.isArray(decoded.accepts) ? decoded.accepts : [];
    if (accepts.length === 0) return null;
    return {
      x402Version: 2,
      options: toOptions(accepts),
      resourceUrl:
        decoded.resource && typeof decoded.resource === 'object'
          ? String((decoded.resource as Record<string, unknown>).url ?? '')
          : undefined,
    };
  },

  async pay(
    _url: string,
    _requestInit: RequestInit,
    _challenge: PaymentChallenge,
    _wallets: WalletSet,
    _opts: PayAndFetchOptions,
  ): Promise<PayResult> {
    // Implemented in Task 5.
    return { ok: false, reason: 'error', detail: 'pay not yet implemented' };
  },
};
