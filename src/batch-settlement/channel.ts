import {
  createWalletClient,
  http,
  publicActions,
  parseUnits,
  formatUnits,
  type Chain,
} from 'viem';
import { base, arbitrum, polygon } from 'viem/chains';
import { toClientEvmSigner } from '@x402/evm';
import {
  BatchSettlementEvmScheme,
  getChannel,
} from '@x402/evm/batch-settlement/client';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { EvmWallet } from '../adapters/evm';
import { getDefaultChannelStore } from './store';
import { runClose, buildChannelManager } from './close';
import {
  UnsupportedNetworkError,
  type ChannelStore,
  type ChannelState,
  type BatchSettlementChannel,
  type CloseReceipt,
  type OpenBatchChannelOptions,
  type ResumeBatchChannelOptions,
} from './types';

/** CAIP-2 networks where the x402BatchSettlement contract is deployed. */
const SUPPORTED: Record<string, { chain: Chain; defaultRpc: string }> = {
  'eip155:8453': { chain: base, defaultRpc: 'https://mainnet.base.org' },
  'eip155:42161': { chain: arbitrum, defaultRpc: 'https://arb1.arbitrum.io/rpc' },
  'eip155:137': { chain: polygon, defaultRpc: 'https://polygon-rpc.com' },
};

export interface ClientStackInput {
  wallet: EvmWallet;
  network: string;
  rpcUrl?: string;
  store: ChannelStore;
  /** Atomic-units deposit amount; the deposit strategy returns this on the first request. */
  depositAtomic: string;
}

export interface ClientStack {
  scheme: BatchSettlementEvmScheme;
  x402Cli: x402Client;
  httpClient: x402HTTPClient;
  rpcUrl: string;
}

/**
 * Builds the upstream client stack (signer -> scheme -> x402Client -> x402HTTPClient)
 * for a batch-settlement-capable network. The scheme is given the provided
 * ChannelStore, so persistence and on-chain recovery are handled upstream.
 * Throws UnsupportedNetworkError if the network has no deployed contract.
 */
function buildClientStack(input: ClientStackInput): ClientStack {
  const entry = SUPPORTED[input.network];
  if (!entry) {
    throw new UnsupportedNetworkError(
      `batch-settlement is not available on network "${input.network}" — ` +
        `supported: ${Object.keys(SUPPORTED).join(', ')}`,
    );
  }
  const rpcUrl = input.rpcUrl ?? entry.defaultRpc;

  // The scheme signs EIP-712 vouchers and ERC-3009 deposit authorizations; a
  // wallet without signTypedData cannot participate in batch-settlement.
  const walletSignTypedData = input.wallet.signTypedData;
  if (typeof walletSignTypedData !== 'function') {
    throw new Error(
      'batch-settlement requires an EvmWallet that supports signTypedData (EIP-712)',
    );
  }

  // The wallet only needs signTypedData; wrap it as a viem-shaped client and
  // route signTypedData through the consumer's wallet.
  const walletClient = createWalletClient({
    account: { address: input.wallet.address as `0x${string}`, type: 'json-rpc' },
    chain: entry.chain,
    transport: http(rpcUrl),
  }).extend(publicActions);

  const signerClient = Object.assign(walletClient, {
    address: input.wallet.address as `0x${string}`,
    signTypedData: (args: {
      domain: Record<string, unknown>;
      types: Record<string, unknown[]>;
      primaryType: string;
      message: Record<string, unknown>;
    }) => walletSignTypedData.call(input.wallet, args),
  });
  const clientSigner = toClientEvmSigner(
    signerClient as Parameters<typeof toClientEvmSigner>[0],
  );

  const scheme = new BatchSettlementEvmScheme(clientSigner, {
    storage: input.store,
    depositPolicy: { depositMultiplier: 4 },
    depositStrategy: () => input.depositAtomic,
  });

  const x402Cli = new x402Client();
  x402Cli.register(input.network as `${string}:${string}`, scheme);
  const httpClient = new x402HTTPClient(x402Cli);

  return { scheme, x402Cli, httpClient, rpcUrl };
}

/** Test-only export — do not use outside tests. */
export const __test_buildClientStack = buildClientStack;

/** USDC has 6 decimals on every batch-settlement-supported chain. */
const USDC_DECIMALS = 6;

/** Default facilitator: the Dexter facilitator submits the on-chain deposit/claim/settle/refund. */
const DEFAULT_FACILITATOR_URL = 'https://x402.dexter.cash';

/**
 * Converts atomic-unit channel accounting into the public {@link ChannelState}
 * (USDC human units). `remaining` is clamped at 0 — once spend reaches the
 * deposit there is nothing left, never a negative balance.
 */
function toChannelState(
  depositedAtomic: bigint,
  spentAtomic: bigint,
): ChannelState {
  const remainingAtomic =
    spentAtomic > depositedAtomic ? 0n : depositedAtomic - spentAtomic;
  return {
    deposited: formatUnits(depositedAtomic, USDC_DECIMALS),
    spent: formatUnits(spentAtomic, USDC_DECIMALS),
    remaining: formatUnits(remainingAtomic, USDC_DECIMALS),
  };
}

/**
 * Pulls the channelId out of a payment payload built by
 * `x402HTTPClient.createPaymentPayload`. For batch-settlement the payload is a
 * deposit or voucher payload, and BOTH carry `voucher.channelId` (a bytes32
 * hex string) — verified against `@x402/evm` 2.12 `BatchSettlementVoucherFields`.
 * Returns `''` if the payload is not a recognised batch-settlement shape.
 */
function channelIdFromPayload(paymentPayload: unknown): string {
  const payload = (paymentPayload as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object') return '';
  const voucher = (payload as { voucher?: unknown }).voucher;
  if (!voucher || typeof voucher !== 'object') return '';
  const channelId = (voucher as { channelId?: unknown }).channelId;
  return typeof channelId === 'string' ? channelId : '';
}

/** Inputs needed to construct a {@link BatchSettlementChannel} handle. */
interface ChannelHandleInput {
  stack: ClientStack;
  store: ChannelStore;
  facilitatorUrl: string;
  network: string;
  /** Known deposit (atomic units). 0n on resume until the first fetch recovers it. */
  depositedAtomic: bigint;
}

/**
 * Builds the live channel handle. The handle is created BEFORE any network
 * call: `channelId` is empty and accounting reflects the known deposit. The
 * first successful `fetch` triggers the upstream deposit signature, resolves
 * the real `channelId` and the seller `receiver`, and refreshes accounting.
 */
function makeChannelHandle(input: ChannelHandleInput): BatchSettlementChannel {
  const { stack, store, facilitatorUrl, network } = input;
  // Mutable channel state — all populated/refreshed by the first successful fetch.
  let channelId = '';
  let receiver = '';
  let depositedAtomic = input.depositedAtomic;
  let spentAtomic = 0n;

  /**
   * Reads the upstream-persisted channel context out of the store and updates
   * local accounting. The upstream `onPaymentResponse` hook writes
   * `chargedCumulativeAmount` (cumulative spend) and `balance` (on-chain
   * channel balance) AFTER a paid request settles, so this must run after
   * `processPaymentResult`.
   */
  async function refreshAccounting(): Promise<void> {
    if (!channelId) return;
    const ctx = await getChannel(store, channelId);
    if (!ctx) return;
    if (ctx.chargedCumulativeAmount !== undefined) {
      spentAtomic = BigInt(ctx.chargedCumulativeAmount);
    }
    // On resume the deposit is unknown until recovery; the on-chain channel
    // balance is the escrowed total, so adopt it once it is known.
    if (depositedAtomic === 0n && ctx.balance !== undefined) {
      depositedAtomic = BigInt(ctx.balance);
    }
  }

  return {
    get channelId() {
      return channelId;
    },
    get network() {
      return network;
    },
    get state(): ChannelState {
      return toChannelState(depositedAtomic, spentAtomic);
    },
    async fetch(
      requestInput: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> {
      const { httpClient } = stack;
      const probe = await fetch(requestInput, init);
      if (probe.status !== 402) return probe;

      const paymentRequired = httpClient.getPaymentRequiredResponse(
        (name) => probe.headers.get(name),
        await probe.clone().json().catch(() => undefined),
      );
      // The 402's first accepted requirement carries the seller payout address;
      // close() needs it and it is only knowable from a live 402.
      const firstAccept = paymentRequired.accepts?.[0];
      if (firstAccept?.payTo) receiver = firstAccept.payTo;

      // One corrective retry: a stale cumulative base makes the facilitator
      // answer 402 again; the upstream onPaymentResponse hook resyncs channel
      // state and signals { recovered: true }, after which a fresh payload works.
      const maxAttempts = 2;
      let lastResponse: Response | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
        // The deposit/voucher decision is internal to the upstream scheme; the
        // payload's voucher carries the deterministic channelId either way.
        const resolvedId = channelIdFromPayload(paymentPayload);
        if (resolvedId) channelId = resolvedId;

        const paidHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
        const paid = await fetch(requestInput, {
          ...init,
          headers: { ...(init?.headers ?? {}), ...paidHeaders },
        });
        lastResponse = paid;

        // Fires the scheme's onPaymentResponse hook, which persists
        // chargedCumulativeAmount/balance to the store.
        const { recovered } = await httpClient.processPaymentResult(
          paymentPayload,
          (name) => paid.headers.get(name),
          paid.status,
        );
        await refreshAccounting();

        if (paid.status === 402 && recovered && attempt < maxAttempts) {
          continue;
        }
        return paid;
      }
      // Unreachable: the loop returns on every path; satisfies the type checker.
      return lastResponse as Response;
    },
    async close(): Promise<CloseReceipt> {
      if (!channelId) {
        throw new Error(
          'cannot close a channel that has made no requests — call fetch() at least once first',
        );
      }
      if (!receiver) {
        throw new Error(
          'cannot close: the seller payout address is unknown (no 402 was observed)',
        );
      }
      const settledAtomic = spentAtomic.toString();
      const refundedAtomic = (
        spentAtomic > depositedAtomic ? 0n : depositedAtomic - spentAtomic
      ).toString();

      const manager = buildChannelManager(facilitatorUrl, network, receiver);
      const receipt = await runClose(manager, channelId, {
        settledAtomic,
        refundedAtomic,
      });
      // The channel is settled and refunded on-chain — drop the local record.
      await store.delete(channelId.toLowerCase());
      return receipt;
    },
  };
}

/**
 * Opens a fresh batch-settlement escrow channel. No network call happens here:
 * the channel is escrowed lazily on the FIRST `fetch`, where the upstream
 * scheme signs an ERC-3009 deposit authorization (the facilitator pays the
 * deposit gas — the buyer needs no native token, only USDC).
 *
 * The returned handle exposes accounting immediately (`deposited` from the
 * `deposit` option, `spent` 0); `channelId` stays empty until the first fetch.
 *
 * @throws UnsupportedNetworkError when the network has no deployed contract.
 * @throws Error when `deposit` is not a positive amount.
 */
export async function openBatchChannel(
  options: OpenBatchChannelOptions,
): Promise<BatchSettlementChannel> {
  const store = options.store ?? getDefaultChannelStore();
  const facilitatorUrl = options.facilitatorUrl ?? DEFAULT_FACILITATOR_URL;

  let depositAtomic: bigint;
  try {
    depositAtomic = parseUnits(options.deposit, USDC_DECIMALS);
  } catch {
    throw new Error(
      `deposit must be a valid USDC amount in decimal units (e.g. "0.30"), got "${options.deposit}"`,
    );
  }
  if (depositAtomic <= 0n) {
    throw new Error(
      `deposit must be a positive amount, got "${options.deposit}"`,
    );
  }

  // buildClientStack throws UnsupportedNetworkError before any signing.
  const stack = buildClientStack({
    wallet: options.wallet,
    network: options.network,
    rpcUrl: options.rpcUrl,
    store,
    depositAtomic: depositAtomic.toString(),
  });

  return makeChannelHandle({
    stack,
    store,
    facilitatorUrl,
    network: options.network,
    depositedAtomic: depositAtomic,
  });
}

/**
 * Resumes an already-open batch-settlement channel — same buyer wallet, same
 * network, no new deposit. The upstream scheme recovers channel state from the
 * `store` (or, with an RPC, from on-chain) on the first `fetch`.
 *
 * Because no deposit is opened, the handle's accounting starts at zero and is
 * corrected from the recovered channel context (its on-chain `balance`) once
 * the first `fetch` resolves the channel; `channelId`, `fetch`, and `close`
 * are fully functional throughout.
 *
 * @throws UnsupportedNetworkError when the network has no deployed contract.
 */
export async function resumeBatchChannel(
  options: ResumeBatchChannelOptions,
): Promise<BatchSettlementChannel> {
  const store = options.store ?? getDefaultChannelStore();
  const facilitatorUrl = options.facilitatorUrl ?? DEFAULT_FACILITATOR_URL;

  // Resume never opens a fresh deposit — the deposit strategy returns 0; the
  // upstream scheme recovers the existing channel from storage / on-chain.
  const stack = buildClientStack({
    wallet: options.wallet,
    network: options.network,
    rpcUrl: options.rpcUrl,
    store,
    depositAtomic: '0',
  });

  return makeChannelHandle({
    stack,
    store,
    facilitatorUrl,
    network: options.network,
    depositedAtomic: 0n,
  });
}
