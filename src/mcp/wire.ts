import type { SettleResponse } from '../types';
import type { McpPaymentAccept, McpPaymentPayload, McpPaymentRequired, McpToolCall, McpToolResult } from './types';

export const MCP_PAYMENT_META = 'x402/payment';
export const MCP_PAYMENT_RESPONSE_META = 'x402/payment-response';
export const MCP_PAYMENT_STATE_META = 'dexter/payment-state';

/** Attach an object-valued payment while retaining other request metadata. */
export function attachMcpPayment(request: McpToolCall, payment: McpPaymentPayload): McpToolCall {
  if (!isMcpPaymentPayload(payment)) throw new Error('Invalid x402 v2 MCP payment payload');
  if (request._meta?.[MCP_PAYMENT_META] !== undefined) throw new Error('Request already contains payment');
  return snapshot({ ...request, _meta: { ...request._meta, [MCP_PAYMENT_META]: payment } });
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Compare JSON semantics while ignoring object key order. */
export function canonicalJson(value: unknown): string {
  const normalized = snapshot(value);
  function sort(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sort);
    if (!isObject(input)) return input;
    return Object.fromEntries(Object.keys(input).sort().map(key => [key, sort(input[key])]));
  }
  return JSON.stringify(sort(normalized));
}

export function isMcpPaymentAccept(value: unknown): value is McpPaymentAccept {
  return isObject(value)
    && ['scheme', 'network', 'asset', 'payTo'].every(key => typeof value[key] === 'string' && value[key].length > 0)
    && typeof value.amount === 'string' && /^(0|[1-9][0-9]*)$/.test(value.amount)
    && typeof value.maxTimeoutSeconds === 'number'
    && Number.isSafeInteger(value.maxTimeoutSeconds) && value.maxTimeoutSeconds > 0
    && (value.extra === undefined || isObject(value.extra));
}

export function isMcpPaymentRequired(value: unknown): value is McpPaymentRequired {
  return isObject(value) && value.x402Version === 2
    && isObject(value.resource) && typeof value.resource.url === 'string' && value.resource.url.length > 0
    && Array.isArray(value.accepts) && value.accepts.length > 0 && value.accepts.every(isMcpPaymentAccept)
    && (value.extensions === undefined || isObject(value.extensions));
}

export function isMcpPaymentPayload(value: unknown): value is McpPaymentPayload {
  return isObject(value) && value.x402Version === 2
    && (value.resource === undefined || (isObject(value.resource) && typeof value.resource.url === 'string'))
    && isMcpPaymentAccept(value.accepted) && isObject(value.payload)
    && (value.extensions === undefined || isObject(value.extensions));
}

/** Published x402 MCP challenge: structured data and identical JSON text. */
export function createMcpPaymentRequiredResult(required: McpPaymentRequired, error?: string): McpToolResult {
  if (!isMcpPaymentRequired(required)) throw new Error('Invalid x402 v2 MCP payment requirements');
  const body = snapshot({ ...required, ...(error === undefined ? {} : { error }) });
  return {
    isError: true,
    structuredContent: body as unknown as Record<string, unknown>,
    content: [{ type: 'text', text: JSON.stringify(body) }],
  };
}

/** Prefer structuredContent; support the specification's first-text fallback. */
export function getMcpPaymentRequired(result: McpToolResult): McpPaymentRequired | undefined {
  if (result.isError !== true) return undefined;
  if (isMcpPaymentRequired(result.structuredContent)) return snapshot(result.structuredContent);
  const first = result.content?.[0];
  if (first?.type !== 'text' || typeof first.text !== 'string') return undefined;
  try {
    const value: unknown = JSON.parse(first.text);
    return isMcpPaymentRequired(value) ? value : undefined;
  } catch { return undefined; }
}

export function getMcpPaymentReceipt(result: McpToolResult): SettleResponse | undefined {
  const value = result._meta?.[MCP_PAYMENT_RESPONSE_META];
  if (!isObject(value) || typeof value.success !== 'boolean' || typeof value.network !== 'string') return undefined;
  if (value.success && (typeof value.transaction !== 'string' || value.transaction.length === 0)) return undefined;
  return snapshot(value) as unknown as SettleResponse;
}

export function matchesMcpPayment(required: McpPaymentRequired, payment: McpPaymentPayload): boolean {
  return (payment.resource === undefined || payment.resource.url === required.resource.url)
    && required.accepts.some(accept => canonicalJson(accept) === canonicalJson(payment.accepted));
}

export function isMcpSettlementPending(receipt: SettleResponse): boolean {
  return receipt.errorReason === 'settlement_pending' || receipt.errorCode === 'settlement_pending';
}
