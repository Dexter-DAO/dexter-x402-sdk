/**
 * Sponsored Access (Ads for Agents) — Client Helpers
 *
 * Extract sponsored recommendations from x402 payment receipts and
 * fire impression beacons to confirm delivery to the ad network.
 *
 * Recommendations are injected by the facilitator after settlement
 * via the `extensions["sponsored-access"]` field. Publishers who enable
 * `sponsoredAccess: true` in their middleware also inject them into
 * the JSON response body as `_x402_sponsored`.
 *
 * @example
 * ```typescript
 * import { wrapFetch, getSponsoredRecommendations, fireImpressionBeacon } from '@dexterai/x402/client';
 *
 * const x402Fetch = wrapFetch(fetch, { walletPrivateKey: key });
 * const response = await x402Fetch('https://api.example.com/data');
 *
 * const recs = getSponsoredRecommendations(response);
 * if (recs) {
 *   console.log('Sponsored:', recs.map(r => `${r.sponsor}: ${r.description}`));
 *   await fireImpressionBeacon(response); // Confirm delivery to ad network
 * }
 * ```
 */

import type {
  SponsoredRecommendation,
  SponsoredAccessSettlementInfo,
} from '@dexterai/x402-ads-types';
import { getPaymentReceipt } from './x402-client';

export type { SponsoredRecommendation, SponsoredAccessSettlementInfo };

/**
 * Extract the full sponsored-access extension data from a payment receipt.
 * Returns undefined if no sponsored-access extension is present.
 */
export function getSponsoredAccessInfo(response: Response): SponsoredAccessSettlementInfo | undefined {
  const receipt = getPaymentReceipt(response);
  if (!receipt?.extensions?.['sponsored-access']) return undefined;
  return receipt.extensions['sponsored-access'] as SponsoredAccessSettlementInfo;
}

/**
 * Extract sponsored recommendations from an x402 payment response.
 * Returns the recommendations array, or undefined if none present.
 *
 * @example
 * ```typescript
 * const recs = getSponsoredRecommendations(response);
 * if (recs) {
 *   for (const rec of recs) {
 *     console.log(`${rec.sponsor}: ${rec.description} — ${rec.resourceUrl}`);
 *   }
 * }
 * ```
 */
export function getSponsoredRecommendations(response: Response): SponsoredRecommendation[] | undefined {
  const info = getSponsoredAccessInfo(response);
  if (!info?.recommendations?.length) return undefined;
  return info.recommendations;
}

/**
 * Fire the impression beacon to confirm recommendation delivery to the ad network.
 * This is a fire-and-forget GET request — failures are silently ignored.
 *
 * Call this after you've read the recommendations to help the ad network
 * track delivery rates and verify impressions.
 *
 * @returns true if the beacon was fired (regardless of response), false if no beacon URL
 *
 * @example
 * ```typescript
 * const recs = getSponsoredRecommendations(response);
 * if (recs) {
 *   // Process recommendations...
 *   await fireImpressionBeacon(response);
 * }
 * ```
 */
export async function fireImpressionBeacon(response: Response): Promise<boolean> {
  const info = getSponsoredAccessInfo(response);
  const beaconUrl = info?.tracking?.impressionBeacon;
  if (!beaconUrl) return false;

  try {
    await fetch(beaconUrl, { method: 'GET' });
  } catch {
    // Fire-and-forget — don't block the caller
  }
  return true;
}
