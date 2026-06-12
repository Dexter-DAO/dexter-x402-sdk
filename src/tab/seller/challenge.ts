/**
 * The discovery half of a tab seller: answer voucher-LESS requests with a
 * standard x402 v2 402 challenge advertising scheme 'tab', so a stranger's
 * agent can resolve the counterparty off the wire. Compose BEFORE
 * tabMiddleware:
 *
 *   app.get('/paid/x',
 *     tabChallengeMiddleware({ sellerPubkey, network, perUnit, facilitatorUrl }),
 *     tabMiddleware({ ... }),
 *     handler);
 *
 * Requests carrying x-tab-voucher fall through to tabMiddleware untouched.
 * The challenge emits the CAIP-2 network form (x402 v2) — the SDK-internal
 * 'solana:mainnet' alias is NOT standard and buyers drop it.
 */
import type { RequestHandler } from 'express';
import { PublicKey } from '@solana/web3.js';

import { createX402Server, type X402Server } from '../../server/x402-server';
import { SOLANA_MAINNET_NETWORK } from '../../constants';
import { TAB_VOUCHER_HEADER } from './middleware';
import { humanToAtomic } from '../tab';
import type { HumanAmount, TabNetworkId } from '../types';

export interface TabChallengeConfig {
  /** Seller pubkey — advertised as the tab counterparty (payTo). */
  sellerPubkey: string | PublicKey;
  /** Tab network id ('solana:mainnet'); mapped to CAIP-2 on the wire. */
  network: TabNetworkId;
  /** Per-request price in human units; advertised as maxAmountRequired. */
  perUnit: HumanAmount;
  /** Facilitator base URL (the challenge embeds its feePayer extra). */
  facilitatorUrl?: string;
  description?: string;
}

const NETWORK_TO_CAIP2: Partial<Record<TabNetworkId, string>> = {
  'solana:mainnet': SOLANA_MAINNET_NETWORK,
};

export function tabChallengeMiddleware(config: TabChallengeConfig): RequestHandler {
  const caip2 = NETWORK_TO_CAIP2[config.network];
  if (!caip2) {
    throw new Error(`tabChallengeMiddleware: unsupported network "${config.network}"`);
  }
  const payTo =
    typeof config.sellerPubkey === 'string'
      ? config.sellerPubkey
      : config.sellerPubkey.toBase58();
  new PublicKey(payTo); // validate at construction, not per request

  // CHALLENGE-ONLY server: only buildRequirements/create402Response are
  // wired. verify/settle are NOT served through this instance — voucher
  // verification belongs to tabMiddleware, settlement to the facilitator's
  // /tab/settle. (Its requirements cache is keyed by payTo, which is
  // constant here; reusing this instance for verify/settle would read
  // whichever resourceUrl was challenged last.)
  const server: X402Server = createX402Server({
    payTo,
    network: caip2,
    scheme: 'tab',
    facilitatorUrl: config.facilitatorUrl,
  });
  const amountAtomic = humanToAtomic(config.perUnit);

  return async (req, res, next) => {
    if (req.headers[TAB_VOUCHER_HEADER]) return next();
    try {
      const resourceUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const requirements = await server.buildRequirements({
        amountAtomic,
        resourceUrl,
        description: config.description,
      });
      const r = server.create402Response(requirements);
      res.set(r.headers).status(r.status).json(r.body);
    } catch (err) {
      // Almost always "facilitator unreachable" (the challenge embeds its
      // feePayer extra, fetched once per process). That is a TRANSIENT
      // seller-side condition — answer 503 + Retry-After so a discovering
      // agent retries, instead of a 500 that reads as a hard failure.
      const detail = (err as { message?: string })?.message ?? String(err);
      res
        .status(503)
        .set({ 'Retry-After': '5' })
        .json({ error: 'challenge_unavailable', detail });
    }
  };
}
