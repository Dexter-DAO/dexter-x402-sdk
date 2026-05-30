/**
 * @dexterai/x402/tab/seller — Express middleware + SSE helper for OTS tabs.
 *
 * The middleware verifies vouchers locally and injects a `SellerTab` onto
 * `req.tab` that the route handler drives. `openSse` is a convenience helper
 * that turns an Express response into an SSE meter.
 *
 * @example
 * ```ts
 * import { tabMiddleware, openSse } from '@dexterai/x402/tab/seller';
 *
 * app.post('/inference',
 *   tabMiddleware({ perUnit: '0.00003', network: 'solana:mainnet', settle: 'on-close' }),
 *   async (req, res) => {
 *     const meter = openSse(res, req.tab);
 *     for await (const token of llm(req.body.prompt)) {
 *       await meter.charge(1);
 *       meter.send(token);
 *     }
 *     meter.end();
 *   }
 * );
 * ```
 *
 * Phase 1 (this file) declares the public types and signatures. Phase 3 fills
 * the bodies — see docs/DESIGN-tab-streaming.md §6.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type {
  TabMiddlewareOptions,
  OpenSseOptions,
  SseMeter,
  SellerTab,
} from './types';

export type {
  VoucherStore,
  SellerTab,
  TabMiddlewareOptions,
  OpenSseOptions,
  SseMeter,
} from './types';

export { InvalidVoucherError } from './types';

const NOT_IMPLEMENTED_DETAIL =
  '@dexterai/x402/tab/seller is in Phase 1 (contract lock). Implementation lands in Phase 3 — see docs/DESIGN-tab-streaming.md.';

/**
 * Express middleware that gates a route on a valid OTS tab.
 *
 * Behavior at runtime (Phase 3):
 *  - Reads the buyer's session-signed voucher from the request headers
 *  - Verifies signature, registration, scope, monotonicity locally
 *  - On success, injects `SellerTab` onto `req.tab` and calls `next()`
 *  - On failure, responds 402 with details
 */
export function tabMiddleware(_options: TabMiddlewareOptions): RequestHandler {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    next(new Error(`tabMiddleware not_implemented: ${NOT_IMPLEMENTED_DETAIL}`));
  };
}

/**
 * Open a Server-Sent Events stream tied to a tab. The returned meter is what
 * the route handler drives: `charge()` accepts a voucher bump and `send()`
 * delivers the chunk, in that order.
 */
export function openSse(_res: Response, _tab?: SellerTab, _options?: OpenSseOptions): SseMeter {
  throw new Error(`openSse not_implemented: ${NOT_IMPLEMENTED_DETAIL}`);
}

// Augment Express's Request so route handlers can read `req.tab` without
// per-route casting. The augmentation is scoped to the SDK's consumers (any
// app importing from this subpath gets it).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tab?: SellerTab;
    }
  }
}
