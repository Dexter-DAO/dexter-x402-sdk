/**
 * Helius Laserstream subscriber — one subscription per account-filter,
 * multiplexed to N listeners.
 *
 * The relay maintains a SINGLE Laserstream subscription per watched account
 * and fans events out to all currently-paying subscribers for that account.
 * Buyers connect via SSE; their channel id is registered on the fan-out
 * list when they pass the seller middleware's voucher gate; events flow
 * back through the SSE response.
 *
 * Why one subscription per account (not per buyer): Laserstream has a
 * finite subscription budget on a Helius plan, and each subscription has
 * real server-side cost. Multiplexing means the relay scales with N
 * buyers sharing M accounts, not N×M independent streams.
 *
 * Voucher cadence is enforced in the relay's HTTP path (index.ts), not
 * here — this module only owns the subscription/fan-out lifecycle.
 */

import {
  subscribe,
  CommitmentLevel,
  type LaserstreamConfig,
  type StreamHandle,
  type SubscribeUpdate,
} from 'helius-laserstream';

/** An on-chain event we want to bill for. The shape is intentionally small
 *  so it serializes cleanly into an SSE chunk. */
export interface ChainEvent {
  signature: string;
  slot: number;
  /** The account this event matched on. The relay's fan-out routes by this. */
  matchedAccount: string;
  /** Wall-clock when the relay observed the event. */
  observedAt: number;
}

export type EventListener = (event: ChainEvent) => void;

interface FilterState {
  /** Subscribe handle so we can cancel when the last listener leaves. */
  handle: Promise<StreamHandle>;
  /** Active listeners. SSE controllers register on connect, unregister on
   *  disconnect; when this map empties, the underlying subscription is
   *  cancelled. */
  listeners: Map<string, EventListener>;
}

/**
 * Multiplexed Laserstream subscription manager. Per-account-filter state
 * with shared underlying subscription.
 */
export class LaserstreamMux {
  private filters = new Map<string, FilterState>();
  private readonly config: LaserstreamConfig;

  constructor(endpoint: string, apiKey: string) {
    this.config = { endpoint, apiKey };
  }

  /**
   * Register a listener for a watched account. The first listener for a
   * given account starts the underlying Laserstream subscription; later
   * listeners share it. Returns an unsubscribe function the caller MUST
   * call when the buyer disconnects.
   */
  subscribeAccount(
    account: string,
    listenerId: string,
    listener: EventListener,
  ): () => void {
    let state = this.filters.get(account);
    if (!state) {
      state = this.startSubscription(account);
      this.filters.set(account, state);
    }
    state.listeners.set(listenerId, listener);
    return () => this.unsubscribe(account, listenerId);
  }

  private unsubscribe(account: string, listenerId: string) {
    const state = this.filters.get(account);
    if (!state) return;
    state.listeners.delete(listenerId);
    if (state.listeners.size === 0) {
      void state.handle.then((h) => {
        try { h.cancel(); } catch (err) { console.error('[mux] cancel failed:', err); }
      }).catch(() => {});
      this.filters.delete(account);
    }
  }

  private startSubscription(account: string): FilterState {
    const listeners = new Map<string, EventListener>();

    // Laserstream gRPC subscribe-request shape, matching the production
    // dexter-laser worker. We filter on transactions touching `account`
    // and ignore vote/failed txs.
    const request = {
      transactions: {
        watched: {
          accountInclude: [account],
          accountExclude: [],
          accountRequired: [],
          failed: false,
          vote: false,
        },
      },
      commitment: CommitmentLevel.CONFIRMED,
    };

    const handle = subscribe(
      this.config,
      request,
      async (update: SubscribeUpdate) => {
        // Updates may carry a tx or a ping/slot heartbeat — only fan out
        // when there's an actual transaction we can bill on.
        const tx = (update as { transaction?: { transaction?: { signature?: Uint8Array | string } } }).transaction;
        const raw = tx?.transaction;
        if (!raw) return;
        const event: ChainEvent = {
          signature: signatureToBase58(raw.signature),
          slot: Number((update as { transaction?: { slot?: number | bigint } }).transaction?.slot ?? 0),
          matchedAccount: account,
          observedAt: Date.now(),
        };
        for (const fn of listeners.values()) {
          try {
            fn(event);
          } catch (err) {
            console.error('[mux] listener failed:', err);
          }
        }
      },
      async (err: Error) => {
        console.error(`[mux] subscription error on ${account}:`, err.message);
      },
    );

    // Surface failures of the initial subscribe so we don't silently lose
    // the stream — the relay route handler treats this as a fatal for the
    // affected SSE connection on next batch attempt.
    handle.catch((err) => {
      console.error(`[mux] subscribe() failed on ${account}:`, err);
    });

    return { handle, listeners };
  }

  /** Diagnostic — count of active filters and total subscribers across them. */
  stats(): { filters: number; totalListeners: number } {
    let totalListeners = 0;
    for (const state of this.filters.values()) totalListeners += state.listeners.size;
    return { filters: this.filters.size, totalListeners };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function signatureToBase58(sig: Uint8Array | string | undefined): string {
  if (!sig) return '';
  if (typeof sig === 'string') return sig;
  // Standard base58 encoding for Solana signatures. Avoid pulling bs58
  // here — the relay already depends on it transitively, and this keeps
  // the subscriber module's import surface minimal.
  // Tiny inline base58 (Bitcoin alphabet) — handles 64-byte sigs in <1ms.
  return base58Encode(sig);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Convert via successive division.
  const input = Array.from(bytes);
  const out: number[] = [];
  let start = zeros;
  while (start < input.length) {
    let remainder = 0;
    for (let i = start; i < input.length; i++) {
      const v = (remainder << 8) + input[i]!;
      input[i] = Math.floor(v / 58);
      remainder = v % 58;
    }
    out.push(remainder);
    if (input[start] === 0) start++;
  }
  let str = '';
  for (let i = 0; i < zeros; i++) str += '1';
  for (let i = out.length - 1; i >= 0; i--) str += B58[out[i]!];
  return str;
}
