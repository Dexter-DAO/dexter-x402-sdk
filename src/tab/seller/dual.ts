/**
 * Dual-rail tab seller: ONE middleware advertising BOTH payment rails in a
 * single standard x402 v2 402 challenge —
 *
 *   scheme 'tab'   — agents open a freeze-protected tab and stream vouchers
 *   scheme 'exact' — one-shot buyers (and catalog verifiers, which cannot
 *                    open tabs) pay per request
 *
 * Compose as the ONLY payment middleware on the route:
 *
 *   app.get('/paid/x', tabOrExactMiddleware({ ... }), handler);
 *
 * In the handler: `(req as X402Request).x402` set -> the request was paid
 * via exact (respond normally); otherwise `requireTab(req)` -> tab rail
 * (charge via openSse meter).
 *
 * SECURITY: the exact rail passes requirements EXPLICITLY to verify/settle
 * (built from OUR configured amount). X402Server's no-requirements fallback
 * rebuilds them from the BUYER'S header amount on cache miss — an
 * underpayment hole this middleware must never take (pinned in dual.test.ts).
 */
import type { RequestHandler } from 'express';
import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';

import { createX402Server, type X402Server } from '../../server/x402-server';
import type { X402Request } from '../../server/middleware';
import { SOLANA_MAINNET_NETWORK } from '../../constants';
import { encodeBase64Json } from '../../utils';
import { tabMiddleware, TAB_VOUCHER_HEADER } from './middleware';
import { humanToAtomic } from '../tab';
import type { HumanAmount, TabNetworkId } from '../types';

export interface TabOrExactConfig {
  /** For tab voucher verification (V6 session PDA reads). */
  connection: Connection;
  /** Seller pubkey — payTo on BOTH rails. */
  sellerPubkey: string | PublicKey;
  network: TabNetworkId;
  /** Price per request, human units — identical on both rails. */
  perUnit: HumanAmount;
  facilitatorUrl?: string;
  description?: string;
}

const NETWORK_TO_CAIP2: Partial<Record<TabNetworkId, string>> = {
  'solana:mainnet': SOLANA_MAINNET_NETWORK,
};

export function tabOrExactMiddleware(config: TabOrExactConfig): RequestHandler {
  const caip2 = NETWORK_TO_CAIP2[config.network];
  if (!caip2) {
    throw new Error(`tabOrExactMiddleware: unsupported network "${config.network}"`);
  }
  const payTo =
    typeof config.sellerPubkey === 'string'
      ? config.sellerPubkey
      : config.sellerPubkey.toBase58();
  new PublicKey(payTo); // validate at construction, not per request

  // Challenge-only on the tab side (verify belongs to tabMiddleware,
  // settlement to the facilitator); the exact server ALSO verifies/settles —
  // always with explicit requirements (see file header).
  const tabServer: X402Server = createX402Server({
    payTo,
    network: caip2,
    scheme: 'tab',
    facilitatorUrl: config.facilitatorUrl,
  });
  const exactServer: X402Server = createX402Server({
    payTo,
    network: caip2,
    scheme: 'exact',
    facilitatorUrl: config.facilitatorUrl,
  });
  const amountAtomic = humanToAtomic(config.perUnit);

  const tabRail = tabMiddleware({
    connection: config.connection,
    sellerPubkey: payTo,
    network: config.network,
    perUnit: config.perUnit,
    settle: 'on-close',
    facilitatorUrl: config.facilitatorUrl,
  });

  return async (req, res, next) => {
    // Rail 1: tab voucher -> the proven tab middleware owns it end-to-end.
    if (req.headers[TAB_VOUCHER_HEADER]) return tabRail(req, res, next);

    const resourceUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    // Rail 2: exact payment -> verify + settle inline, explicit requirements.
    const paymentSignature = req.headers['payment-signature'] as string | undefined;
    if (paymentSignature) {
      try {
        const accept = await exactServer.getPaymentAccept({
          amountAtomic,
          resourceUrl,
          description: config.description,
        });
        const verify = await exactServer.verifyPayment(paymentSignature, accept);
        if (!verify.isValid) {
          res.status(402).json({
            error: 'Payment verification failed',
            reason: verify.invalidReason,
          });
          return;
        }
        const settle = await exactServer.settlePayment(paymentSignature, accept);
        if (!settle.success) {
          res.status(402).json({
            error: 'Payment settlement failed',
            reason: settle.errorReason,
          });
          return;
        }
        (req as X402Request).x402 = {
          transaction: settle.transaction!,
          payer: verify.payer ?? '',
          network: settle.network || caip2,
        };
        res.setHeader('PAYMENT-RESPONSE', encodeBase64Json({
          success: true,
          transaction: settle.transaction!,
          network: settle.network || caip2,
          payer: verify.payer ?? '',
        }));
        return next();
      } catch {
        res.status(500).json({ error: 'Payment processing error' });
        return;
      }
    }

    // Rail 0: no payment at all -> ONE merged challenge, tab listed FIRST.
    // The body carries `accepts` too (unlike tabChallengeMiddleware's `{}`):
    // catalog ingestion reads bodies, not just headers.
    try {
      const opts = { amountAtomic, resourceUrl, description: config.description };
      const [tabReqs, exactReqs] = await Promise.all([
        tabServer.buildRequirements(opts),
        exactServer.buildRequirements(opts),
      ]);
      const merged = { ...tabReqs, accepts: [...tabReqs.accepts, ...exactReqs.accepts] };
      res
        .set({ 'PAYMENT-REQUIRED': tabServer.encodeRequirements(merged) })
        .status(402)
        .json({ error: 'Payment required', accepts: merged.accepts, resource: merged.resource });
    } catch (err) {
      // Transient (facilitator unreachable while building the challenge):
      // 503 + Retry-After, same contract as tabChallengeMiddleware.
      const detail = (err as { message?: string })?.message ?? String(err);
      res
        .status(503)
        .set({ 'Retry-After': '5' })
        .json({ error: 'challenge_unavailable', detail });
    }
  };
}
