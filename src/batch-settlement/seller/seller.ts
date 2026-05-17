import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { FileChannelStorage, type ChannelStorage } from '@x402/evm/batch-settlement/server';
import type { CloseReceipt } from '../types';
import type {
  BatchSettlementSeller,
  BatchSettlementSellerConfig,
  SellerCloseResult,
} from './types';
import { buildResourceServer } from './resource-server';
import { closeChannel, closeAll, type ChannelManagerLike } from './settlement';
import { startAutoLoop, type AutoLoopHandle } from './auto-loop';

const DEFAULT_FACILITATOR_URL = 'https://x402.dexter.cash';
const DEFAULT_ROUTE = 'GET /';
/** CAIP-2 networks where the x402BatchSettlement contract is deployed. */
const SUPPORTED_NETWORKS = new Set(['eip155:8453', 'eip155:42161', 'eip155:137']);

/** Resolves the auto-settle claim interval in ms, or null when disabled. */
function resolveClaimIntervalMs(
  autoSettle: BatchSettlementSellerConfig['autoSettle'],
): number | null {
  if (autoSettle === false) return null;
  if (autoSettle === undefined || autoSettle === true) return 300_000; // default 300s
  return (autoSettle.claimIntervalSecs ?? 300) * 1000;
}

/**
 * Creates a batch-settlement seller runtime. The returned object is callable
 * (usable directly as an Express RequestHandler) and exposes lifecycle +
 * settlement methods. The auto-settlement loop starts immediately unless
 * disabled.
 */
export function createBatchSettlementSeller(
  config: BatchSettlementSellerConfig,
): BatchSettlementSeller {
  if (!SUPPORTED_NETWORKS.has(config.network)) {
    throw new Error(
      `batch-settlement is not supported on network "${config.network}" — ` +
        `supported: ${[...SUPPORTED_NETWORKS].join(', ')}`,
    );
  }

  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR_URL;
  // The runtime store is the upstream SERVER-side `ChannelStorage` (with
  // `list` / `updateChannel`) — the type `buildResourceServer` and
  // `createChannelManager` both consume. `config.channelStore` is already
  // typed as that server-side `ChannelStorage`.
  const channelStore: ChannelStorage =
    config.channelStore ??
    new FileChannelStorage({
      directory: join(homedir(), '.dexter-x402', 'seller-channels'),
    });

  const rs = buildResourceServer({
    payTo: config.payTo,
    network: config.network,
    price: config.price,
    route: config.route ?? DEFAULT_ROUTE,
    facilitatorUrl,
    channelStore,
    verbose: config.verbose,
  });

  // The channel manager shares channelStore (via rs.scheme) with the resource
  // server, so it claims exactly the vouchers the request handler persisted.
  const manager = rs.scheme.createChannelManager(
    rs.facilitator,
    config.network as `${string}:${string}`,
  ) as unknown as ChannelManagerLike;

  const runClaimPass = async (): Promise<void> => {
    await manager.claimAndSettle();
  };

  const claimIntervalMs = resolveClaimIntervalMs(config.autoSettle);
  let loop: AutoLoopHandle | null = null;
  if (claimIntervalMs !== null) {
    loop = startAutoLoop({
      claimAndSettle: runClaimPass,
      claimIntervalMs,
      onError: (e) => console.error('[batch-settlement:seller] auto-loop claim pass failed', e),
    });
  }

  const closeStoreLike = channelStore as unknown as Parameters<typeof closeChannel>[0]['store'];

  const handler = (req: Request, res: Response, next: NextFunction): void => {
    void rs.handler(req, res, next);
  };

  // The seller object IS the request handler, with methods attached.
  const seller = handler as unknown as BatchSettlementSeller;
  seller.middleware = () => handler;
  seller.closeChannel = (channelId: string): Promise<CloseReceipt> =>
    closeChannel({ manager, store: closeStoreLike, channelId });
  seller.closeAll = (): Promise<SellerCloseResult[]> =>
    closeAll({ manager, store: closeStoreLike });
  seller.stop = async (): Promise<void> => {
    if (loop) await loop.stop();
  };

  return seller;
}
