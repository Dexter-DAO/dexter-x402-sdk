import type { McpPaymentRecord, McpPaymentRequired, McpSettlementOutcome, McpToolCall, McpToolResult, PaidMcpToolOptions } from './types';
import { digest } from './facilitator';
import {
  MCP_PAYMENT_META, MCP_PAYMENT_RESPONSE_META, MCP_PAYMENT_STATE_META,
  createMcpPaymentRequiredResult, isMcpPaymentPayload, isMcpPaymentRequired,
  getMcpPaymentRequired, matchesMcpPayment, isMcpSettlementPending, snapshot,
} from './wire';

function failure(message: string, state?: Record<string, unknown>): McpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    ...(state ? { _meta: { [MCP_PAYMENT_STATE_META]: state } } : {}),
  };
}

function pending(record: McpPaymentRecord): McpToolResult {
  const result = failure('This payment already has an admitted operation. Retrieve or reconcile that operation before paying again.', {
    paymentId: record.paymentId, phase: record.phase, recoveryRequired: true,
  });
  if (record.receipt) result._meta![MCP_PAYMENT_RESPONSE_META] = snapshot(record.receipt);
  return result;
}

/**
 * Gate a completed tool result with the published x402 MCP payment exchange.
 * Each verified payment is claimed in durable storage before execution. A
 * restart or uncertain effect requires application reconciliation; this
 * wrapper never re-executes an incomplete admitted operation automatically.
 */
export function createPaidMcpTool<Context>(options: PaidMcpToolOptions<Context>) {
  if (!options.name || !options.serviceScope) throw new Error('Paid MCP tool requires name and serviceScope');

  return async (input: McpToolCall, application: Context): Promise<McpToolResult> => {
    const request = snapshot(input);
    if (request.name !== options.name) return failure('Unknown paid tool');
    let accessScope: string;
    try {
      accessScope = await options.authorize(snapshot(request), application);
      if (!accessScope) return failure('Access denied');
    } catch { return failure('Access denied'); }

    const rawPayment = request._meta?.[MCP_PAYMENT_META];
    let required: McpPaymentRequired;
    async function requirements(): Promise<McpPaymentRequired> {
      const candidate = typeof options.requirements === 'function'
        ? await options.requirements(snapshot(request), application) : options.requirements;
      if (!isMcpPaymentRequired(candidate)) throw new Error('Invalid MCP payment requirements');
      const value = snapshot(candidate);
      if (value.accepts.some(accept => !options.payments.supports(accept)
        || (accept.extra?.paymentFlow !== undefined && accept.extra.paymentFlow !== 'authorization'))) {
        throw new Error('MCP requirements advertise a payment scheme or network unsupported by this processor');
      }
      return value;
    }
    if (rawPayment === undefined) return createMcpPaymentRequiredResult(await requirements());
    if (!isMcpPaymentPayload(rawPayment)) {
      return createMcpPaymentRequiredResult(await requirements(), 'Payment must be an x402 v2 object in params._meta["x402/payment"]');
    }
    const payment = snapshot(rawPayment);
    let paymentId: string;
    try { paymentId = options.payments.identify(payment); }
    catch { return createMcpPaymentRequiredResult(await requirements(), 'Unsupported payment proof'); }
    if (!paymentId) throw new Error('Payment processor returned an empty payment ID');

    const binding = digest({ serviceScope: options.serviceScope, name: request.name,
      arguments: request.arguments ?? {}, accepted: payment.accepted });
    const proofFingerprint = digest(payment);
    const replay = (record: McpPaymentRecord): McpToolResult => {
      if (record.accessScope !== accessScope || record.serviceScope !== options.serviceScope
        || record.binding !== binding || record.proofFingerprint !== proofFingerprint
        || (payment.resource !== undefined && payment.resource.url !== record.resource.url)) {
        return failure('Payment is already bound to another request or caller');
      }
      if ((record.phase === 'complete' || record.phase === 'execution_failed') && record.result) {
        // A nested paid tool can return its own challenge. Keep that evidence
        // privately while preventing another charge for this admitted call.
        if (record.phase === 'execution_failed' && getMcpPaymentRequired(record.result)) return pending(record);
        return snapshot(record.result);
      }
      return pending(record);
    };
    const existing = await options.store.get(paymentId);
    // Authenticate and check the original binding before allowing cached
    // retrieval. Retrieval survives later price changes and nonce consumption.
    if (existing) return replay(existing);

    required = await requirements();
    if (!matchesMcpPayment(required, payment) || !options.payments.supports(payment.accepted)) {
      return createMcpPaymentRequiredResult(required, 'Payment terms do not match this tool');
    }
    let verification;
    try { verification = await options.payments.verify(payment, payment.accepted); }
    catch { return createMcpPaymentRequiredResult(required, 'Payment verification unavailable'); }
    if (verification.isValid !== true) {
      return createMcpPaymentRequiredResult(required, 'Payment verification failed');
    }

    // Persist the proof and exact request before the tool can produce effects.
    let record: McpPaymentRecord = {
      paymentId, revision: 0, phase: 'admitted', binding, proofFingerprint, accessScope,
      serviceScope: options.serviceScope, resource: required.resource, request, payment, payer: verification.payer,
    };
    const claim = await options.store.claim(snapshot(record));
    if (!claim.claimed) return replay(claim.record);

    async function transition(patch: Partial<McpPaymentRecord>): Promise<void> {
      const next = snapshot({ ...record, ...patch, revision: record.revision + 1 });
      if (!await options.store.compareAndSwap(paymentId, record.revision, next)) {
        throw new Error('MCP payment record changed concurrently');
      }
      record = next;
    }

    try {
      await transition({ phase: 'executing' });
      let result: McpToolResult;
      try {
        result = snapshot(await options.execute(snapshot(request), {
          application, paymentId, payer: verification.payer, requirements: snapshot(payment.accepted),
        }));
        if (!Array.isArray(result.content)
          || (result.resultType !== undefined && result.resultType !== 'complete')
          || result.task !== undefined) {
          throw new Error('Paid MCP tool must return a completed tool result');
        }
        // These fields describe this wrapper's payment, never a nested tool's
        // receipt or caller-supplied recovery state. Keep unrelated metadata.
        if (result._meta) {
          delete result._meta[MCP_PAYMENT_RESPONSE_META];
          delete result._meta[MCP_PAYMENT_STATE_META];
        }
      } catch {
        await transition({ phase: 'execution_unknown' });
        return pending(record);
      }
      // A tool error does not satisfy this completed-result purchase contract.
      if (result.isError === true) {
        await transition({ phase: 'execution_failed', result });
        return replay(record);
      }
      await transition({ phase: 'executed', result });
      await transition({ phase: 'settling' });
      let settlement: McpSettlementOutcome;
      try { settlement = await options.payments.settle(payment, payment.accepted); }
      catch { settlement = { status: 'unknown' as const, reason: 'Settlement response unavailable' }; }
      if (settlement.receipt && isMcpSettlementPending(settlement.receipt)) {
        settlement = { status: 'unknown' as const, reason: 'settlement_pending', receipt: settlement.receipt };
      }
      if (settlement.status !== 'settled') {
        await transition({ phase: settlement.status === 'failed' ? 'settlement_failed' : 'settlement_unknown',
          ...(settlement.receipt ? { receipt: settlement.receipt } : {}) });
        // Another challenge could prompt a generic buyer to create a fresh
        // authorization while this admitted operation still needs recovery.
        const response = failure(settlement.status === 'failed'
          ? 'Settlement failed; reconcile the admitted operation before paying again'
          : 'Settlement outcome unknown; reconcile the admitted operation before paying again');
        response._meta = {
          [MCP_PAYMENT_STATE_META]: { paymentId, phase: record.phase, recoveryRequired: true },
          ...(settlement.receipt ? { [MCP_PAYMENT_RESPONSE_META]: settlement.receipt } : {}),
        };
        return response;
      }
      const receipt = settlement.receipt;
      if (receipt.success !== true || !receipt.transaction || receipt.network !== payment.accepted.network) {
        await transition({ phase: 'settlement_unknown' });
        return pending(record);
      }
      const response: McpToolResult = {
        ...result, _meta: { ...result._meta, [MCP_PAYMENT_RESPONSE_META]: snapshot(receipt) },
      };
      // Completion is visible only after both output and receipt are durable.
      await transition({ phase: 'complete', result: response, receipt });
      return response;
    } catch {
      // A write can time out after committing. Never roll back the admission,
      // execute again, or resubmit payment based only on this exception.
      return failure('Operation outcome requires reconciliation before another payment.', {
        paymentId, phase: 'unknown', recoveryRequired: true,
      });
    }
  };
}
