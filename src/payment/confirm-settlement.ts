/**
 * Post-timeout settlement confirmation.
 *
 * When a paid call times out AFTER the payment authorization was sent, the
 * money may already be on-chain. This module asks the chain directly — via
 * the adapter's `confirmSettlement` — whether the exact payment settled, so
 * the strategy can return a confirmed `paid: true` instead of an honest-but-
 * unhelpful `payment_unconfirmed`.
 *
 * Shared by v1-strategy and v2-strategy: the confirmation logic is identical
 * across protocol versions — only the request/response framing differs.
 */
import type { SettlementProbe } from '../adapters/types';
import { createEvmAdapter, createSolanaAdapter } from '../adapters';
import type { NetworkRef } from './types';
import { errorDetail } from './errors';

/**
 * The result of attempting on-chain confirmation after a post-payment abort.
 *
 *  - `confirmed`   — the chain shows the payment settled. `txSignature` set
 *                    when the check could recover it.
 *  - `unconfirmed` — the chain shows no settlement, OR confirmation could not
 *                    be performed (no probe, no `confirmSettlement` for this
 *                    scheme, or the RPC call itself failed). `detail` explains
 *                    which. The caller maps this to `reason: 'payment_unconfirmed'`.
 */
export type ConfirmResult =
  | { confirmed: true; txSignature?: string }
  | { confirmed: false; detail: string };

const UNCONFIRMED_BASE =
  'Payment authorization was sent, but the merchant did not respond ' +
  'within the timeout. ';

const UNCONFIRMED_TAIL =
  ' Do not retry without checking — inspect the funding wallet for a ' +
  'transfer to the merchant before attempting payment again.';

/**
 * Try to confirm, on-chain, that a dispatched payment settled.
 *
 * Never throws — an RPC failure or an unconfirmable scheme resolves to
 * `{ confirmed: false }` with an explanatory `detail`.
 *
 * @param probe - The probe captured at build time, or `undefined` when the
 *   scheme has no on-chain confirmation (e.g. EVM exact-approval).
 * @param network - The network the payment was made on.
 * @param solanaRpcUrl - Optional Solana RPC override (EVM uses the adapter's
 *   default per-network RPC).
 */
export async function confirmSettlement(
  probe: SettlementProbe | undefined,
  network: NetworkRef,
  solanaRpcUrl?: string,
): Promise<ConfirmResult> {
  if (!probe) {
    return {
      confirmed: false,
      detail:
        UNCONFIRMED_BASE +
        'This payment scheme has no on-chain confirmation check, so the ' +
        'SDK cannot verify whether it settled.' +
        UNCONFIRMED_TAIL,
    };
  }

  try {
    if (probe.kind === 'solana') {
      const adapter = createSolanaAdapter();
      const rpcUrl = solanaRpcUrl ?? adapter.getDefaultRpcUrl(network.caip2);
      if (!adapter.confirmSettlement) {
        return unconfirmable();
      }
      const result = await adapter.confirmSettlement(probe, rpcUrl);
      return result.settled
        ? { confirmed: true, txSignature: result.txSignature }
        : notSettled();
    }

    // eip3009 | permit2 — EVM.
    const adapter = createEvmAdapter();
    const rpcUrl = adapter.getDefaultRpcUrl(network.caip2);
    if (!adapter.confirmSettlement) {
      return unconfirmable();
    }
    const result = await adapter.confirmSettlement(probe, rpcUrl);
    return result.settled
      ? { confirmed: true, txSignature: result.txSignature }
      : notSettled();
  } catch (err) {
    // RPC error, or an adapter that genuinely cannot tell — treat as unknown.
    return {
      confirmed: false,
      detail:
        UNCONFIRMED_BASE +
        `On-chain confirmation could not be completed (${errorDetail(err)}).` +
        UNCONFIRMED_TAIL,
    };
  }
}

function notSettled(): ConfirmResult {
  return {
    confirmed: false,
    detail:
      UNCONFIRMED_BASE +
      'On-chain confirmation found no matching settlement yet — the payment ' +
      'may still be pending, or may not have settled.' +
      UNCONFIRMED_TAIL,
  };
}

function unconfirmable(): ConfirmResult {
  return {
    confirmed: false,
    detail:
      UNCONFIRMED_BASE +
      'The chain adapter does not support on-chain confirmation.' +
      UNCONFIRMED_TAIL,
  };
}
