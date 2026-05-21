// src/payment/v1-header.ts
/**
 * Standalone v1 X-PAYMENT header builder.
 *
 * Extracted from v1-strategy so that external consumers that manage their
 * own fetch (e.g. a dexter-api payment route) can build a v1 header without
 * pulling in the full PaymentStrategy machinery or the upstream `x402` lib.
 *
 * MUST NOT import v2-strategy or v1-strategy (seam isolation).
 */
import type {
  PaymentChallenge,
  ChallengeOption,
  PayAndFetchOptions,
} from './types';
import type { WalletSet, SettlementProbe } from '../adapters/types';
import type { EvmWallet } from '../adapters/evm';
import type { SolanaWallet } from '../adapters/solana';
import type { PaymentAccept } from '../types';
import { createSolanaAdapter } from '../adapters';
import { CHAIN_IDS } from '../constants';
import { getAddress } from 'viem';
import { errorDetail } from './errors';

/**
 * EIP-712 type set for the v1 `exact` EVM scheme. v1 signs an EIP-3009
 * `TransferWithAuthorization` directly against the USDC contract — a
 * different (simpler) structure than the v2 Permit2 witness scheme, so
 * v1 cannot reuse the `src/adapters/evm.ts` Permit2 signing path and
 * carries its own minimal helper here.
 */
const V1_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

/** A v1 EVM `exact` payment payload, ready for base64 encoding. */
interface V1EvmPayment {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

/**
 * Random 32-byte hex nonce for EIP-3009 replay protection.
 *
 * `crypto` is only a global in browsers and Node 19+. The SDK supports Node
 * 18 (`engines: >=18`), where the WebCrypto API must be imported from
 * `node:crypto` — so resolve `globalThis.crypto` with a `webcrypto` fallback,
 * matching the pattern used elsewhere in the SDK (e.g. `src/adapters/evm.ts`).
 */
async function randomNonce(): Promise<string> {
  const webCrypto =
    globalThis.crypto ?? (await import('crypto')).webcrypto;
  const bytes = new Uint8Array(32);
  webCrypto.getRandomValues(bytes);
  return (
    '0x' +
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  );
}

/**
 * Build and sign a v1 `exact`-scheme EVM payment for one ChallengeOption.
 *
 * The `network` field written into the payload is the merchant's
 * advertised v1 bare name verbatim — see the no-rewrite comment in
 * `buildV1PaymentHeader`.
 */
async function signV1EvmPayment(
  wallet: EvmWallet,
  option: ChallengeOption,
  wireNetwork: string,
): Promise<{ payment: V1EvmPayment; settlementProbe: SettlementProbe }> {
  if (typeof wallet.signTypedData !== 'function') {
    throw new Error('EVM wallet does not support signTypedData');
  }
  const now = Math.floor(Date.now() / 1000);
  const validAfter = String(now - 600); // 10 min of clock skew tolerance
  const validBefore = String(now + (option.maxTimeoutSeconds ?? 60));
  const authorization = {
    from: wallet.address,
    to: option.payTo,
    value: option.amount,
    validAfter,
    validBefore,
    nonce: await randomNonce(),
  };
  // chainId is derived from the CAIP-2 form purely to build the EIP-712
  // domain separator — it never reaches the wire payload.
  const chainId = CHAIN_IDS[option.network.caip2];
  if (chainId === undefined) {
    throw new Error(`unknown chain id for network ${option.network.caip2}`);
  }
  // The EIP-712 domain separator is keccak256 over
  // name + version + chainId + verifyingContract. If name/version do not
  // match the deployed token contract's actual EIP-712 domain, the
  // recovered signer is wrong and the payment is rejected
  // (invalid_signature) or settlement reverts on-chain. The domain is
  // therefore NEVER guessed — `buildEvmHeader` guarantees extra.name /
  // extra.version are present non-empty strings before calling this helper
  // (see the domain check in `buildEvmHeader`). Hardcoded fallbacks
  // ('USD Coin'/'2') were removed: they are correct only for native USDC
  // and silently produce an unspendable signature for bridged USDC (USDC.e)
  // and chains like BSC / Polygon PoS where the token reports a different
  // name/version.
  const extra = option.extra as Record<string, unknown>;
  const signature = await wallet.signTypedData({
    domain: {
      name: extra.name as string,
      version: extra.version as string,
      chainId,
      verifyingContract: getAddress(option.asset),
    },
    types: V1_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });
  return {
    payment: {
      x402Version: 1,
      scheme: option.scheme,
      network: wireNetwork,
      payload: { signature, authorization },
    },
    // v1 EVM `exact` is EIP-3009 — the same scheme v2 uses by default — so a
    // post-payment timeout can confirm via the token's `authorizationState`.
    settlementProbe: {
      kind: 'eip3009',
      from: authorization.from,
      nonce: authorization.nonce,
      asset: option.asset,
      chainId,
    },
  };
}

/** Result of building a v1 X-PAYMENT header value. Never thrown. */
export type V1HeaderResult =
  | {
      ok: true;
      headerValue: string;
      option: ChallengeOption;
      /**
       * Data to confirm settlement on-chain if a post-payment timeout fires.
       * `undefined` for schemes with no on-chain confirmation check.
       */
      settlementProbe?: SettlementProbe;
    }
  | {
      ok: false;
      reason:
        | 'unsupported_network'
        | 'budget_exceeded'
        | 'merchant_rejected'
        | 'error';
      detail?: string;
    };

/**
 * Build a v1 `X-PAYMENT` header value for one of a challenge's options.
 *
 * This is the v1 payment-construction seam: it picks the first option
 * whose chain family has a usable wallet, signs the v1 `exact` payload
 * (EIP-3009 for EVM; a partially-signed Solana transaction for SVM),
 * and base64-encodes the v1 PaymentPayload. It does NOT send a request —
 * the caller owns the fetch. payAndFetch's v1 strategy uses this; so do
 * external consumers that manage their own request flow.
 *
 * Returns a typed result; never throws for an expected failure.
 *
 * NO NETWORK REWRITE: the `network` field on the wire is the merchant's
 * advertised v1 bare name verbatim (option.network.bare).
 */
export async function buildV1PaymentHeader(
  challenge: PaymentChallenge,
  wallets: WalletSet,
  opts: PayAndFetchOptions,
): Promise<V1HeaderResult> {
  try {
    for (const option of challenge.options) {
      if (option.network.family === 'evm' && wallets.evm) {
        const evmWallet = (await wallets.evm) as EvmWallet;
        return await buildEvmHeader(option, evmWallet, opts);
      }
      if (option.network.family === 'svm' && wallets.solana) {
        const solanaWallet = (await wallets.solana) as SolanaWallet;
        return await buildSvmHeader(option, solanaWallet, opts);
      }
    }
    return { ok: false, reason: 'unsupported_network' };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      detail: errorDetail(err),
    };
  }
}

async function buildEvmHeader(
  option: ChallengeOption,
  evmWallet: EvmWallet,
  opts: PayAndFetchOptions,
): Promise<V1HeaderResult> {
  if (opts.maxAmountAtomic !== undefined) {
    if (BigInt(option.amount) > BigInt(opts.maxAmountAtomic)) {
      return { ok: false, reason: 'budget_exceeded' };
    }
  }
  // The v1 challenge must carry the exact-scheme EIP-712 domain. A wrong
  // domain produces an unspendable signature, so it is never guessed.
  const extra = (option.extra ?? {}) as Record<string, unknown>;
  const domainName = extra.name;
  const domainVersion = extra.version;
  if (
    typeof domainName !== 'string' ||
    domainName.length === 0 ||
    typeof domainVersion !== 'string' ||
    domainVersion.length === 0
  ) {
    return {
      ok: false,
      reason: 'merchant_rejected',
      detail:
        'v1 challenge missing exact-scheme EIP-712 domain (extra.name / extra.version)',
    };
  }
  // NO network rewrite — wire network is the merchant's advertised bare name.
  const wireNetwork = option.network.bare;
  const { payment, settlementProbe } = await signV1EvmPayment(
    evmWallet,
    option,
    wireNetwork,
  );
  const headerValue = Buffer.from(
    JSON.stringify(payment),
    'utf8',
  ).toString('base64');
  return { ok: true, headerValue, option, settlementProbe };
}

/**
 * Build and base64-encode a v1 `exact`-scheme SVM (Solana) X-PAYMENT header.
 *
 * Unlike EVM (an offline EIP-3009 signature), v1 SVM `exact` ships a real,
 * partially-signed Solana v0 transaction (SetComputeUnitLimit +
 * SetComputeUnitPrice + TransferChecked, fee payer = `extra.feePayer`).
 * Building it requires Solana RPC (mint lookup + recent blockhash).
 *
 * The v2 Solana adapter's `buildTransaction` already produces exactly that
 * transaction — it is v1/v2-agnostic (falls back to `maxAmountRequired`).
 * This is a thin envelope around it: take the serialized wire transaction
 * and wrap it in the v1 PaymentPayload `{ transaction }` shape.
 *
 * RPC failures from `buildTransaction` are allowed to throw — the
 * `buildV1PaymentHeader` wrapper converts them to `{ ok:false, reason:'error' }`.
 */
async function buildSvmHeader(
  option: ChallengeOption,
  solanaWallet: SolanaWallet,
  opts: PayAndFetchOptions,
): Promise<V1HeaderResult> {
  // Budget check FIRST — before any RPC work (mint lookup / blockhash).
  if (opts.maxAmountAtomic !== undefined) {
    if (BigInt(option.amount) > BigInt(opts.maxAmountAtomic)) {
      return { ok: false, reason: 'budget_exceeded' };
    }
  }
  // Only the `exact` scheme is defined for v1 SVM. Reject anything else
  // up front rather than signing a transaction for a scheme we cannot
  // honour — the SVM adapter always builds an `exact` transfer.
  if (option.scheme !== 'exact') {
    return {
      ok: false,
      reason: 'merchant_rejected',
      detail: `v1 SVM supports only the 'exact' scheme, got '${option.scheme}'`,
    };
  }
  // v1 SVM exact is unsignable without the facilitator fee payer — it is
  // the transaction's fee payer. Fail clearly rather than fall through.
  const extra = (option.extra ?? {}) as Record<string, unknown>;
  if (typeof extra.feePayer !== 'string' || extra.feePayer.length === 0) {
    return {
      ok: false,
      reason: 'merchant_rejected',
      detail:
        'v1 SVM challenge missing extra.feePayer (required as the transaction fee payer)',
    };
  }
  // NO network rewrite — wire network is the merchant's advertised bare name.
  const wireNetwork = option.network.bare;
  // The v2 Solana adapter builds the exact 3-instruction partially-signed
  // transaction v1 SVM exact requires; reuse it. `scheme` is cast because
  // PaymentAccept's union is stricter than ChallengeOption's string scheme;
  // `extra` already satisfies AcceptsExtra via its index signature.
  const accept: PaymentAccept = {
    x402Version: 1,
    scheme: option.scheme as PaymentAccept['scheme'],
    network: wireNetwork,
    asset: option.asset,
    payTo: option.payTo,
    amount: option.amount,
    maxAmountRequired: option.amount,
    maxTimeoutSeconds: option.maxTimeoutSeconds ?? 60,
    extra,
  };
  const adapter = createSolanaAdapter();
  const built = await adapter.buildTransaction(
    accept,
    solanaWallet,
    opts.solanaRpcUrl,
  );
  const payment = {
    x402Version: 1,
    scheme: option.scheme,
    network: wireNetwork,
    payload: { transaction: built.serialized },
  };
  const headerValue = Buffer.from(
    JSON.stringify(payment),
    'utf8',
  ).toString('base64');
  return { ok: true, headerValue, option, settlementProbe: built.settlementProbe };
}
