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
import type { WalletSet } from '../adapters/types';
import type { EvmWallet } from '../adapters/evm';
import { CHAIN_IDS } from '../constants';
import { getAddress } from 'viem';

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

/** Random 32-byte hex nonce for EIP-3009 replay protection. */
function randomNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
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
): Promise<V1EvmPayment> {
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
    nonce: randomNonce(),
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
    x402Version: 1,
    scheme: option.scheme,
    network: wireNetwork,
    payload: { signature, authorization },
  };
}

/** Result of building a v1 X-PAYMENT header value. Never thrown. */
export type V1HeaderResult =
  | { ok: true; headerValue: string; option: ChallengeOption }
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
        // SVM implemented in a later task.
        return {
          ok: false,
          reason: 'error',
          detail: 'v1 SVM signing not yet implemented',
        };
      }
    }
    return { ok: false, reason: 'unsupported_network' };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      detail: err instanceof Error ? err.message : String(err),
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
  const payment = await signV1EvmPayment(evmWallet, option, wireNetwork);
  const headerValue = Buffer.from(
    JSON.stringify(payment),
    'utf8',
  ).toString('base64');
  return { ok: true, headerValue, option };
}
