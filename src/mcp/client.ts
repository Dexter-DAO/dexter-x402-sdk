import type { McpPaidCallOutcome, McpPaymentPayload, McpPaymentRequired, McpToolCall, McpToolTransport } from './types';
import { requiresPaymentIdentifier } from '../payment/exact-capability';
import {
  MCP_PAYMENT_META, MCP_PAYMENT_STATE_META, getMcpPaymentReceipt, getMcpPaymentRequired,
  attachMcpPayment, isObject, isMcpPaymentPayload, isMcpPaymentRequired, isMcpSettlementPending, matchesMcpPayment, snapshot,
} from './wire';

/** One unpaid call. A tool may execute during this call; check its semantics. */
export async function probeMcpTool(transport: McpToolTransport, request: McpToolCall) {
  if (request._meta?.[MCP_PAYMENT_META] !== undefined) throw new Error('Probe already contains payment');
  const result = await transport(snapshot(request));
  return { result, paymentRequired: getMcpPaymentRequired(result) };
}

/**
 * Send one already-authorized payment. The caller owns selection, signing,
 * budget enforcement and durable recovery. Exceptions after dispatch are
 * uncertain outcomes, and the same helper never makes another paid request.
 */
export async function callMcpToolWithPayment(options: {
  transport: McpToolTransport;
  request: McpToolCall;
  paymentRequired: McpPaymentRequired;
  payment: McpPaymentPayload;
  /** Durably record the exact server identity, request and proof before resolving. */
  beforeDispatch(request: McpToolCall): Promise<void>;
}): Promise<McpPaidCallOutcome> {
  const required = snapshot(options.paymentRequired);
  const payment = snapshot(options.payment);
  if (!isMcpPaymentRequired(required) || !isMcpPaymentPayload(payment) || !matchesMcpPayment(required, payment)) {
    throw new Error('Payment does not match the approved MCP requirements');
  }
  if (requiresPaymentIdentifier(required.extensions)) {
    throw new Error('unsupported_required_payment_identifier');
  }
  const request = attachMcpPayment(options.request, payment);
  // The persistence hook receives a separate snapshot so it cannot mutate the
  // dispatched request after the caller approved the selected terms.
  await options.beforeDispatch(snapshot(request));
  let result;
  try {
    result = await options.transport(request);
  } catch (error) {
    return { paymentStatus: 'unknown', deliveryStatus: 'unknown', error };
  }
  if (!isObject(result) || !Array.isArray(result.content)
    || result.content.some(item => !isObject(item) || typeof item.type !== 'string')
    || (result.isError !== undefined && typeof result.isError !== 'boolean')) {
    return { rawResult: result, paymentStatus: 'unknown', deliveryStatus: 'unknown',
      error: new Error('Invalid MCP result after paid dispatch') };
  }
  const deliveryStatus = result.isError === true ? 'tool_error' : 'result_received';
  let receipt;
  try { receipt = getMcpPaymentReceipt(result); }
  catch (error) { return { result, paymentStatus: 'unknown', deliveryStatus, error }; }
  if (!receipt || receipt.network !== payment.accepted.network) {
    return { result, paymentStatus: 'unknown', deliveryStatus, error: new Error('Missing or invalid payment receipt') };
  }
  const state = result._meta?.[MCP_PAYMENT_STATE_META];
  if (isMcpSettlementPending(receipt) || (isObject(state)
    && ['unknown', 'settling', 'settlement_unknown'].includes(String(state.phase)))) {
    return { result, receipt, paymentStatus: 'unknown', deliveryStatus };
  }
  return {
    result, receipt, deliveryStatus,
    paymentStatus: receipt.success ? 'seller_reported_settled' : 'seller_reported_failed',
  };
}
