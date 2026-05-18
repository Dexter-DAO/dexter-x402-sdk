// src/payment/v1-strategy.ts
/**
 * x402 v1 strategy. v1 carries the challenge in the JSON body of the
 * 402 (an `accepts` array) with bare network names. parseChallenge
 * declines (returns null) when a PAYMENT-REQUIRED header is present —
 * that is a v2 response and the dispatcher will route it to v2Strategy.
 *
 * MUST NOT import v2-strategy.
 */
import type {
  PaymentStrategy,
  PaymentChallenge,
  ChallengeOption,
  PayResult,
  PayAndFetchOptions,
} from './types';
import type { WalletSet } from '../adapters/types';
import type { EvmWallet } from '../adapters/evm';
import { toNetworkRef } from './network-map';
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
 * advertised v1 bare name verbatim — see the no-rewrite comment in `pay`.
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
  // therefore NEVER guessed — `pay` guarantees extra.name / extra.version
  // are present non-empty strings before calling this helper (see the
  // domain check in `pay`). Hardcoded fallbacks ('USD Coin'/'2') were
  // removed: they are correct only for native USDC and silently produce
  // an unspendable signature for bridged USDC (USDC.e) and chains like
  // BSC / Polygon PoS where the token reports a different name/version.
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

function toOptions(accepts: unknown[]): ChallengeOption[] {
  const out: ChallengeOption[] = [];
  for (const a of accepts) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const net = toNetworkRef(String(o.network ?? ''));
    if (!net) continue;
    out.push({
      scheme: String(o.scheme ?? 'exact'),
      network: net,
      // v1 names the amount field `maxAmountRequired`.
      amount: String(o.maxAmountRequired ?? o.amount ?? '0'),
      asset: String(o.asset ?? ''),
      payTo: String(o.payTo ?? ''),
      maxTimeoutSeconds:
        typeof o.maxTimeoutSeconds === 'number' ? o.maxTimeoutSeconds : undefined,
      extra:
        o.extra && typeof o.extra === 'object'
          ? (o.extra as Record<string, unknown>)
          : undefined,
    });
  }
  return out;
}

export const v1Strategy: PaymentStrategy = {
  version: 1,

  async parseChallenge(res: Response): Promise<PaymentChallenge | null> {
    // A PAYMENT-REQUIRED header means v2 — decline.
    if (res.headers.get('payment-required')) return null;
    let body: Record<string, unknown>;
    try {
      body = (await res.clone().json()) as Record<string, unknown>;
    } catch {
      return null;
    }
    const accepts = Array.isArray(body.accepts) ? body.accepts : [];
    if (accepts.length === 0) return null;
    const options = toOptions(accepts);
    if (options.length === 0) return null;
    return { x402Version: 1, options };
  },

  async pay(
    url: string,
    requestInit: RequestInit,
    challenge: PaymentChallenge,
    wallets: WalletSet,
    opts: PayAndFetchOptions,
  ): Promise<PayResult> {
    // pay() MUST never throw — every path returns a typed PayResult.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 1. Pick the first option whose chain family has a usable wallet.
      //    wallets.evm / wallets.solana may be a Promise (createEvmKeypairWallet
      //    is async and callers commonly pass it un-awaited) — await before use.
      let chosen: ChallengeOption | null = null;
      let evmWallet: EvmWallet | null = null;
      for (const option of challenge.options) {
        if (option.network.family === 'evm' && wallets.evm) {
          evmWallet = (await wallets.evm) as EvmWallet;
          chosen = option;
          break;
        }
        // SVM v1 signing is not implemented in this SDK (no v1 SVM
        // exact-scheme path); such options are skipped, not chosen.
      }
      if (!chosen || !evmWallet) {
        return { ok: false, reason: 'unsupported_network' };
      }

      // 2. Budget check.
      if (opts.maxAmountAtomic !== undefined) {
        if (BigInt(chosen.amount) > BigInt(opts.maxAmountAtomic)) {
          return { ok: false, reason: 'budget_exceeded' };
        }
      }

      // 3. Verify the v1 challenge carries the exact-scheme EIP-712 domain.
      //    A wrong EIP-712 domain produces a cryptographically unspendable
      //    signature, so the domain is never guessed — if the merchant
      //    omitted extra.name / extra.version the payment cannot be signed
      //    correctly and pay fails fast rather than emit a bad payload.
      const chosenExtra = (chosen.extra ?? {}) as Record<string, unknown>;
      const domainName = chosenExtra.name;
      const domainVersion = chosenExtra.version;
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

      // 4. Build the signed v1 `exact` payment payload.
      //
      //    CRITICAL — NO NETWORK REWRITE. The `network` field on the wire
      //    MUST be the merchant's advertised v1 string verbatim. For a
      //    genuine v1 merchant the advertised form is the BARE name, which
      //    `parseChallenge` preserved as `network.bare`. The bare/CAIP-2
      //    distinction in NetworkRef exists ONLY to choose the signer
      //    family (and to derive the EIP-712 chainId) — it must NEVER be
      //    used to convert or normalise the value placed on the wire. The
      //    old verifier rewrote eip155:8453 -> base before signing, which
      //    a v2-aware merchant rejected with invalid_payload. Do not
      //    reintroduce that rewrite.
      const wireNetwork = chosen.network.bare;
      const payment = await signV1EvmPayment(evmWallet, chosen, wireNetwork);

      // 5. Base64-encode the payload into the X-PAYMENT header value.
      const paymentHeader = Buffer.from(
        JSON.stringify(payment),
        'utf8',
      ).toString('base64');

      // 6. Build a FRESH RequestInit — never reuse a consumed body.
      const headers = new Headers(requestInit.headers ?? undefined);
      headers.set('X-PAYMENT', paymentHeader);

      const controller = new AbortController();
      const timeoutMs = opts.timeoutMs ?? 15000;
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const signal =
        requestInit.signal != null
          ? AbortSignal.any([requestInit.signal, controller.signal])
          : controller.signal;

      const freshInit: RequestInit = {
        method: requestInit.method,
        headers,
        signal,
      };
      if (typeof requestInit.body === 'string') {
        freshInit.body = requestInit.body;
      }

      // 7. Send and map the outcome.
      const response = await fetch(url, freshInit);
      if (response.ok) {
        return {
          ok: true,
          response,
          amountPaid: chosen.amount,
          network: chosen.network,
          txSignature: decodeTxSignature(response),
        };
      }
      return {
        ok: false,
        reason: 'merchant_rejected',
        detail: 'HTTP ' + response.status,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { ok: false, reason: 'timeout' };
      }
      return {
        ok: false,
        reason: 'error',
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  },
};

/**
 * Extract the settled transaction hash from an X-PAYMENT-RESPONSE header,
 * if present. The header is a base64-encoded JSON settlement receipt.
 * Returns undefined when absent or unparseable — never throws.
 */
function decodeTxSignature(response: Response): string | undefined {
  const raw =
    response.headers.get('x-payment-response') ??
    response.headers.get('X-PAYMENT-RESPONSE');
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    const tx =
      decoded.transaction ?? decoded.txHash ?? decoded.transactionHash;
    return typeof tx === 'string' ? tx : undefined;
  } catch {
    return undefined;
  }
}
