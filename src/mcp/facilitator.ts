import { createHash } from 'node:crypto';
import { VersionedTransaction } from '@solana/web3.js';
import { FacilitatorClient } from '../server/facilitator-client';
import type { PaymentAccept } from '../types';
import { encodeBase64Json } from '../utils';
import type { McpPaymentPayload, McpPaymentProcessor } from './types';
import { canonicalJson, isObject, isMcpSettlementPending } from './wire';

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function exactPaymentIdentity(payment: McpPaymentPayload): string {
  const { network, scheme, asset } = payment.accepted;
  if (scheme !== 'exact') throw new Error('Default MCP processor supports exact payments');
  const families = ['transaction', 'authorization', 'permit2Authorization']
    .filter(key => payment.payload[key] !== undefined);
  if (families.length !== 1) throw new Error('Payment must contain exactly one supported proof family');
  if (network.startsWith('solana:') && typeof payment.payload.transaction === 'string') {
    const bytes = Buffer.from(payment.payload.transaction, 'base64');
    const transaction = VersionedTransaction.deserialize(bytes);
    // Fee-payer signature completion and extra JSON fields must not create a
    // second admission for the same signed transaction message.
    return digest({ network, message: Buffer.from(transaction.message.serialize()).toString('base64') });
  }
  if (network.startsWith('eip155:')) {
    const method = payment.accepted.extra?.assetTransferMethod ?? 'eip3009';
    if (method !== 'eip3009' && method !== 'permit2') throw new Error('Unsupported asset transfer method');
    const authorization = payment.payload.authorization;
    if (method === 'eip3009' && isObject(authorization)
      && typeof authorization.from === 'string' && /^0x[0-9a-f]{40}$/i.test(authorization.from)
      && typeof authorization.nonce === 'string' && /^0x[0-9a-f]{64}$/i.test(authorization.nonce)) {
      return digest({ network, kind: 'eip3009', asset: asset.toLowerCase(),
        from: authorization.from.toLowerCase(), nonce: authorization.nonce.toLowerCase() });
    }
    const permit = payment.payload.permit2Authorization;
    if (method === 'permit2' && isObject(permit)
      && typeof permit.from === 'string' && /^0x[0-9a-f]{40}$/i.test(permit.from)
      && typeof permit.nonce === 'string' && /^[0-9]+$/.test(permit.nonce)) {
      // Permit2's nonce space is shared across tokens for a payer.
      return digest({ network, kind: 'permit2', from: permit.from.toLowerCase(), nonce: BigInt(permit.nonce).toString() });
    }
  }
  throw new Error('Unsupported exact payment proof');
}

/**
 * Reuse the SDK facilitator client with a single request per operation.
 * Network allow-list is explicit. A negative facilitator response remains
 * uncertain because that client also maps transport errors to success:false.
 */
export function createMcpFacilitatorProcessor(options: {
  facilitatorUrl?: string;
  networks: string[];
  timeoutMs?: number;
}): McpPaymentProcessor {
  if (!options.networks.length) throw new Error('Configure at least one MCP payment network');
  const networks = new Set(options.networks);
  const facilitator = new FacilitatorClient(options.facilitatorUrl, {
    maxRetries: 1, timeoutMs: options.timeoutMs,
  });
  const supports: McpPaymentProcessor['supports'] = accept => accept.scheme === 'exact'
    && (accept.extra?.paymentFlow === undefined || accept.extra.paymentFlow === 'authorization')
    && networks.has(accept.network) && ((/^solana:/.test(accept.network)
      && (accept.extra?.assetTransferMethod === undefined || accept.extra.assetTransferMethod === 'default'))
      || (/^eip155:/.test(accept.network) && ['eip3009', 'permit2']
        .includes(String(accept.extra?.assetTransferMethod ?? 'eip3009'))));
  function validate(payment: McpPaymentPayload, requirements: Parameters<McpPaymentProcessor['verify']>[1]) {
    if (!supports(requirements) || canonicalJson(payment.accepted) !== canonicalJson(requirements)) {
      throw new Error('Unsupported or mismatched facilitator payment requirements');
    }
    exactPaymentIdentity(payment);
  }
  return {
    supports,
    identify: exactPaymentIdentity,
    async verify(payment, requirements) {
      try { validate(payment, requirements); }
      catch { return { isValid: false, invalidReason: 'unsupported_payment_proof' }; }
      return facilitator.verifyPayment(encodeBase64Json(payment), requirements as PaymentAccept);
    },
    async settle(payment, requirements) {
      validate(payment, requirements);
      const receipt = await facilitator.settlePayment(encodeBase64Json(payment), requirements as PaymentAccept);
      if (!isMcpSettlementPending(receipt) && receipt.success === true && typeof receipt.transaction === 'string' && receipt.transaction.length > 0
        && receipt.network === requirements.network) {
        return { status: 'settled', receipt: { ...receipt, success: true } };
      }
      return { status: 'unknown', reason: receipt.errorReason ?? receipt.errorCode ?? 'settlement_not_confirmed', receipt };
    },
  };
}
