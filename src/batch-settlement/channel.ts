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
import type { ChannelConfig } from '@x402/evm';
import type { EvmWallet } from '../adapters/evm';
import { getDefaultChannelStore } from './store';
import {
  UnsupportedNetworkError,
  type ChannelStore,
  type ChannelState,
  type BatchSettlementChannel,
  type CloseResult,
  type OpenBatchChannelOptions,
  type ResumeBatchChannelOptions,
} from './types';
import {
  forceWithdraw as runForceWithdraw,
  finalizeWithdraw as runFinalizeWithdraw,
  type ForceWithdrawResult,
  type FinalizeWithdrawResult,
  type WithdrawWalletClient,
} from './withdraw';

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
  /**
   * The buyer's viem wallet client (extended with public actions). Used by the
   * escape-hatch (`forceWithdraw` / `finalizeWithdraw`) to submit on-chain
   * withdrawal transactions and read channel state. The buyer pays gas.
   */
  withdrawClient: WithdrawWalletClient;
  /**
   * True when the consumer's wallet exposes `sendTransaction`. The escape hatch
   * submits real on-chain transactions and `sendTransaction` is the only
   * reliable bridge (the wallet owns gas/nonce). A `signTransaction`-only or
   * signature-only wallet cannot use it. `forceWithdraw` / `finalizeWithdraw`
   * check this BEFORE any `writeContract` call so an incapable wallet gets a
   * clear error instead of a cryptic keyless-RPC failure.
   */
  canSubmitTransactions: boolean;
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

  // The escape hatch needs the client to actually submit transactions. The
  // viem account above is `json-rpc` (an address, no key): viem's
  // `writeContract` would dispatch `eth_sendTransaction` to the keyless public
  // RPC and fail. So — alongside `signTypedData` — bridge the consumer wallet's
  // transaction capability. `writeContract` on a wallet client encodes the call
  // then calls the client's `sendTransaction`; overriding `sendTransaction` to
  // delegate to the consumer wallet makes `writeContract` route through it.
  // Only `sendTransaction` is a reliable bridge for the escape hatch: the
  // wallet owns gas estimation and nonce selection. A `signTransaction`-only
  // wallet would have to be handed a fully-formed tx (nonce + gas) — which
  // this SDK does not do — so a raw signature from it is not broadcastable.
  // Therefore `signTransaction` alone does NOT make the wallet escape-hatch
  // capable.
  const walletSendTransaction = input.wallet.sendTransaction;
  const canSubmitTransactions = typeof walletSendTransaction === 'function';

  /**
   * Drop-in `sendTransaction` for the escape-hatch client. Accepts viem's
   * transaction-request shape (`writeContract` builds `{ to, data, value, ... }`)
   * and routes the submission through the consumer wallet's `sendTransaction`,
   * which broadcasts and returns the tx hash (the wallet owns gas/nonce).
   * Throws a clear error if the wallet has no `sendTransaction` (should be
   * unreachable — `forceWithdraw` / `finalizeWithdraw` gate on
   * `canSubmitTransactions` first).
   */
  const bridgedSendTransaction = async (txArgs: {
    to?: `0x${string}` | null;
    data?: `0x${string}`;
    value?: bigint;
  }): Promise<`0x${string}`> => {
    const to = txArgs.to ?? undefined;
    if (!to) {
      throw new Error(
        'batch-settlement escape hatch: transaction is missing a `to` address',
      );
    }
    const data = txArgs.data ?? '0x';
    if (typeof walletSendTransaction === 'function') {
      const hash = await walletSendTransaction.call(input.wallet, {
        to,
        data,
        value: txArgs.value,
      });
      return hash as `0x${string}`;
    }
    throw new Error(
      'batch-settlement: wallet has no sendTransaction',
    );
  };

  const signerClient = Object.assign(walletClient, {
    address: input.wallet.address as `0x${string}`,
    signTypedData: (args: {
      domain: Record<string, unknown>;
      types: Record<string, unknown[]>;
      primaryType: string;
      message: Record<string, unknown>;
    }) => walletSignTypedData.call(input.wallet, args),
    // Override `sendTransaction` so `writeContract` (escape hatch) submits via
    // the consumer wallet instead of the keyless RPC. Only the escape hatch
    // calls `writeContract`; the batch-settlement scheme uses `signTypedData`.
    sendTransaction: bridgedSendTransaction,
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

  // The escape hatch submits real transactions; `signerClient` is a viem wallet
  // client extended with public actions, so it carries writeContract /
  // readContract / waitForTransactionReceipt. Cast to the structural subset the
  // escape hatch needs.
  const withdrawClient = signerClient as unknown as WithdrawWalletClient;

  return { scheme, x402Cli, httpClient, rpcUrl, withdrawClient, canSubmitTransactions };
}

/** Test-only export — do not use outside tests. */
export const __test_buildClientStack = buildClientStack;

/** USDC has 6 decimals on every batch-settlement-supported chain. */
const USDC_DECIMALS = 6;

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

/**
 * Pulls the `channelConfig` tuple out of a batch-settlement payment payload.
 * Both deposit and voucher payloads carry `channelConfig` alongside
 * `voucher.channelId` — verified against `@x402/evm` 2.12
 * `BatchSettlementDepositPayload` / `BatchSettlementVoucherPayload`. The
 * escape hatch (`forceWithdraw` / `finalizeWithdraw`) needs the full config to
 * call the contract. Returns `undefined` for an unrecognised payload shape.
 */
function channelConfigFromPayload(paymentPayload: unknown): ChannelConfig | undefined {
  const payload = (paymentPayload as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const config = (payload as { channelConfig?: unknown }).channelConfig;
  if (!config || typeof config !== 'object') return undefined;
  return config as ChannelConfig;
}

/** Inputs needed to construct a {@link BatchSettlementChannel} handle. */
interface ChannelHandleInput {
  stack: ClientStack;
  store: ChannelStore;
  network: string;
  /** Known deposit (atomic units). 0n on resume until the first fetch recovers it. */
  depositedAtomic: bigint;
}

/**
 * Builds the live channel handle. The handle is created BEFORE any network
 * call: `channelId` is empty and accounting reflects the known deposit. The
 * first successful `fetch` triggers the upstream deposit signature, resolves
 * the real `channelId`, and refreshes accounting.
 */
function makeChannelHandle(input: ChannelHandleInput): BatchSettlementChannel {
  const { stack, store, network } = input;
  // Mutable channel state — all populated/refreshed by the first successful fetch.
  let channelId = '';
  // The channel's on-chain config tuple — captured from the first paid payload.
  // Required by the escape hatch; the deposit/voucher payload carries it.
  let channelConfig: ChannelConfig | undefined;
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
        // The payload also carries the channel config tuple — capture it so the
        // escape hatch can call the contract without an extra round trip.
        const resolvedConfig = channelConfigFromPayload(paymentPayload);
        if (resolvedConfig) channelConfig = resolvedConfig;

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
    async close(): Promise<CloseResult> {
      // Buyer close() is an intent signal — the buyer cannot claim. If this
      // channel has a local record, mark it done so a later openBatchChannel
      // does not auto-resume it. The seller's runtime performs the actual
      // claim/settle/refund; the buyer's unspent escrow returns via the
      // seller's refundWithSignature.
      if (channelId) {
        await store.delete(channelId.toLowerCase());
      }
      return { closed: true };
    },
    async forceWithdraw(): Promise<ForceWithdrawResult> {
      // The escape hatch submits a real on-chain transaction and the buyer pays
      // gas — a signature-only wallet (only signTypedData) cannot use it.
      // Checked FIRST so such a wallet is told plainly, regardless of channel
      // state, instead of hitting a cryptic keyless-RPC failure later.
      if (!stack.canSubmitTransactions) {
        throw new Error(
          'batch-settlement forceWithdraw requires a wallet with a ' +
            'sendTransaction method (the withdrawal escape hatch submits an ' +
            'on-chain transaction and the buyer pays gas; a signature-only ' +
            'wallet cannot use it).',
        );
      }
      if (!channelConfig) {
        throw new Error(
          'forceWithdraw is unavailable until the channel has resolved on-chain — ' +
            'make at least one fetch() against the channel first',
        );
      }
      return runForceWithdraw({
        config: channelConfig,
        network,
        client: stack.withdrawClient,
        withdrawDelaySecs: channelConfig.withdrawDelay,
      });
    },
    async finalizeWithdraw(): Promise<FinalizeWithdrawResult> {
      // Same gate as forceWithdraw: finalizeWithdraw also submits a real
      // on-chain transaction. Check the wallet's capability FIRST.
      if (!stack.canSubmitTransactions) {
        throw new Error(
          'batch-settlement finalizeWithdraw requires a wallet with a ' +
            'sendTransaction method (the withdrawal escape hatch submits an ' +
            'on-chain transaction and the buyer pays gas; a signature-only ' +
            'wallet cannot use it).',
        );
      }
      if (!channelConfig) {
        throw new Error(
          'finalizeWithdraw is unavailable until the channel has resolved on-chain — ' +
            'make at least one fetch() against the channel first',
        );
      }
      return runFinalizeWithdraw({
        config: channelConfig,
        network,
        client: stack.withdrawClient,
        withdrawDelaySecs: channelConfig.withdrawDelay,
      });
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
    network: options.network,
    depositedAtomic: 0n,
  });
}
