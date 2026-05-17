import type { Request, Response, NextFunction } from 'express';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import {
  x402HTTPResourceServer,
  type HTTPAdapter,
  type HTTPRequestContext,
  type HTTPTransportContext,
} from '@x402/core/http';
import {
  BatchSettlementEvmScheme as BatchSettlementServerScheme,
  type ChannelStorage,
} from '@x402/evm/batch-settlement/server';

/** Inputs for building the seller resource-server runtime. */
export interface ResourceServerInput {
  /** Seller payout address; also the channel receiver. */
  payTo: string;
  /** CAIP-2 network, e.g. "eip155:8453". */
  network: string;
  /** USDC charged per request, human units, e.g. "0.08" or "$0.08". */
  price: string;
  /** The protected route, e.g. "GET /api/data". */
  route: string;
  /** Facilitator base URL. */
  facilitatorUrl: string;
  /**
   * Persistent server-side channel storage. The upstream batch-settlement
   * server scheme writes Channel records here on verify and on settle; the
   * channel manager (Task 6) reads them back to claim. This is the upstream
   * server-side `ChannelStorage` (with `updateChannel`), not the buyer-side
   * `ClientChannelStorage`.
   */
  channelStore: ChannelStorage;
  /** Verbose logging. */
  verbose?: boolean;
}

/** The built resource-server pieces the seller object needs. */
export interface ResourceServerRuntime {
  /** The upstream server scheme — shares channelStore with the channel manager. */
  scheme: BatchSettlementServerScheme;
  /** Facilitator client — reused to build the channel manager. */
  facilitator: HTTPFacilitatorClient;
  /** The Express request handler. */
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  /** Resolves once the upstream HTTP resource server has fetched facilitator support. */
  ready: Promise<void>;
}

/**
 * Builds the seller's per-request runtime.
 *
 * The upstream batch-settlement server scheme verifies an incoming voucher and
 * PERSISTS its Channel record into `channelStore`: `processHTTPRequest` runs the
 * scheme's verify hook (which writes/refreshes the channel) and `processSettlement`
 * runs the scheme's settle hook (which records the voucher's cumulative amount).
 * There is no per-request on-chain transaction — the channel manager (Task 6)
 * later claims those persisted vouchers in a batch.
 *
 * The handler settles BEFORE running the seller's own route handler. This is
 * deliberate: the voucher MUST land in `channelStore` regardless of whether the
 * seller's handler later succeeds or throws, and settling first is the only way
 * to attach the settlement-response headers before the response is flushed. A
 * handler that serves a response but drops the voucher is the exact bug this
 * runtime exists to prevent.
 */
export function buildResourceServer(input: ResourceServerInput): ResourceServerRuntime {
  const log = input.verbose
    ? console.log.bind(console, '[batch-settlement:seller]')
    : (): void => {};

  const facilitator = new HTTPFacilitatorClient({ url: input.facilitatorUrl });
  const scheme = new BatchSettlementServerScheme(input.payTo as `0x${string}`, {
    storage: input.channelStore,
  });

  const resourceServer = new x402ResourceServer(facilitator).register(
    input.network as `${string}:${string}`,
    scheme,
  );

  // RouteConfig.accepts IS the PaymentOption itself (scheme/payTo/price/network),
  // not a nested wrapper object.
  const httpResourceServer = new x402HTTPResourceServer(resourceServer, {
    [input.route]: {
      accepts: {
        scheme: 'batch-settlement',
        payTo: input.payTo,
        price: input.price,
        network: input.network as `${string}:${string}`,
      },
      description: 'batch-settlement protected route',
      mimeType: 'application/json',
    },
  });

  // initialize() fetches facilitator support; processHTTPRequest must wait for
  // it. A single permanently-rejected promise would silently wedge EVERY
  // request, so initialization is lazy: ensureReady() caches a fulfilled init
  // promise and starts a fresh initialize() after a prior failure, letting a
  // transient startup blip self-heal.
  let readyPromise: Promise<void> | null = null;
  function ensureReady(): Promise<void> {
    if (readyPromise) return readyPromise;
    const attempt = httpResourceServer.initialize();
    attempt.catch((err) => {
      // Drop the cached promise so the next request retries from scratch.
      if (readyPromise === attempt) readyPromise = null;
      // A startup failure of the payment runtime is worth surfacing even when
      // verbose logging is off.
      if (input.verbose) {
        log('resource server initialize() failed:', err);
      } else {
        console.error('[batch-settlement:seller] resource server initialize() failed:', err);
      }
    });
    readyPromise = attempt;
    return attempt;
  }
  // Kick off the first attempt now and expose it as the `ready` field so
  // existing callers/tests that await `.ready` still work.
  const ready: Promise<void> = ensureReady();

  /**
   * Emit an upstream-built response (the 402 from `payment-error`, or the
   * failure response from a rejected settlement) onto the Express response.
   * No-op if a response was already sent.
   */
  function sendUpstreamResponse(
    res: Response,
    response: { status: number; headers: Record<string, string>; body?: unknown },
  ): void {
    if (res.headersSent) return;
    for (const [k, v] of Object.entries(response.headers)) res.setHeader(k, v);
    res.status(response.status);
    const { body } = response;
    if (body == null) {
      res.end();
    } else if (typeof body === 'string') {
      res.send(body);
    } else {
      res.json(body);
    }
  }

  const handler = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
   try {
    await ensureReady();

    // Build the framework-agnostic HTTP adapter from the Express request.
    const host = req.get('host') ?? '';
    const adapter: HTTPAdapter = {
      getHeader: (name: string) => req.headers[name.toLowerCase()] as string | undefined,
      getMethod: () => req.method,
      getPath: () => req.path,
      getUrl: () => `${req.protocol}://${host}${req.originalUrl}`,
      getAcceptHeader: () => (req.headers['accept'] as string | undefined) ?? '',
      getUserAgent: () => (req.headers['user-agent'] as string | undefined) ?? '',
      getBody: () => req.body ?? {},
      getQueryParams: () => req.query as Record<string, string | string[]>,
      getQueryParam: (k: string) => {
        const v = req.query[k];
        if (typeof v === 'string') return v;
        if (Array.isArray(v)) return v as string[];
        return undefined;
      },
    };

    // x402 v2 carries the payment in `payment-signature`; `x-payment` is the
    // v1 / fallback header name.
    const paymentHeader =
      (req.headers['payment-signature'] as string | undefined) ??
      (req.headers['x-payment'] as string | undefined);

    const ctx: HTTPRequestContext = {
      adapter,
      path: req.path,
      method: req.method,
      paymentHeader,
    };

    const result = await httpResourceServer.processHTTPRequest(ctx);
    log('processHTTPRequest ->', result.type);

    // Route is not payment-protected (or not matched) — fall through.
    if (result.type === 'no-payment-required') {
      next();
      return;
    }

    // No / invalid payment — emit the upstream-built 402. Its `accepts`
    // advertises the batch-settlement scheme, payTo and price.
    if (result.type === 'payment-error') {
      sendUpstreamResponse(res, result.response);
      return;
    }

    // result.type === 'payment-verified' — a voucher was attached and the
    // scheme's verify hook has already written/refreshed the Channel in
    // `channelStore`. Settle now so the scheme's settle hook records this
    // voucher's cumulative amount BEFORE the response is flushed; this also
    // yields the settlement-response headers to attach to the response.
    //
    // For batch-settlement, settlement records the voucher into channel
    // storage — it performs no on-chain transaction and does not consume the
    // seller's response body content (the channel manager claims later). An
    // empty Buffer therefore satisfies the optional `responseBody`.
    const transportCtx: HTTPTransportContext = {
      request: ctx,
      responseBody: Buffer.alloc(0),
    };

    const settle = await httpResourceServer.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      result.declaredExtensions,
      transportCtx,
    );
    log('processSettlement ->', settle.success ? 'success' : `failure:${settle.errorReason}`);

    if (!settle.success) {
      // The voucher was rejected at settlement — surface the upstream-built
      // failure response and do NOT run the seller's handler.
      sendUpstreamResponse(res, settle.response);
      return;
    }

    // Voucher verified AND recorded in channelStore. Attach the settlement
    // headers, then run the seller's own route handler.
    for (const [k, v] of Object.entries(settle.headers)) {
      if (!res.headersSent) res.setHeader(k, v);
    }

    next();
   } catch (error) {
    // Express 4 does not forward a rejected promise from an async handler to
    // its error pipeline, so an unguarded throw here would hang the client
    // connection until socket timeout — on the real-money request path.
    log('handler error:', error);
    // Guard against double-send: the 402 / upstream / success paths above may
    // have already flushed a response before an unexpected throw.
    if (!res.headersSent) {
      res.status(500).json({ error: 'Payment processing error' });
    }
   }
  };

  return { scheme, facilitator, handler, ready };
}
