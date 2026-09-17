import { describe, expect, it, vi } from 'vitest';
import { callMcpToolWithPayment, probeMcpTool } from '../client';
import { attachMcpPayment, getMcpPaymentRequired, getMcpPaymentReceipt } from '../wire';
import { output, payment, receipt, request, requirements } from './fixtures';
import type { McpToolCall, McpToolResult } from '../types';

describe('MCP buyer exchange', () => {
  it('refuses required payment identifiers before recording or dispatching a new payment', async () => {
    const transport = vi.fn(async () => output);
    const beforeDispatch = vi.fn(async () => {});
    await expect(callMcpToolWithPayment({ transport, request, payment, beforeDispatch,
      paymentRequired: { ...requirements, extensions: { 'payment-identifier': { info: { required: true } } } },
    })).rejects.toThrow('unsupported_required_payment_identifier');
    expect(transport).not.toHaveBeenCalled();
    expect(beforeDispatch).not.toHaveBeenCalled();
  });

  it.each([
    { 'payment-identifier': { info: { required: false } } },
    { 'other-extension': { info: { required: true } } },
  ])('preserves optional and unrelated extensions: %j', async extensions => {
    const transport = vi.fn(async () => ({ ...output, _meta: { 'x402/payment-response': receipt } }));
    expect(await callMcpToolWithPayment({ transport, request, payment, beforeDispatch: async () => {},
      paymentRequired: { ...requirements, extensions },
    })).toMatchObject({ paymentStatus: 'seller_reported_settled' });
    expect(transport).toHaveBeenCalledOnce();
  });

  // Hand-written peer fixture, deliberately independent of our seller encoder.
  const challenge: McpToolResult = { isError: true, content: [{ type: 'text', text: JSON.stringify(requirements) }] };

  it('parses independent peer text challenges, preferring valid structured content', () => {
    expect(getMcpPaymentRequired(challenge)).toEqual(requirements);
    expect(getMcpPaymentRequired({ ...challenge, structuredContent: { ...requirements, error: 'structured' } })).toMatchObject({ error: 'structured' });
    expect(getMcpPaymentRequired({ ...challenge, isError: false })).toBeUndefined();
    expect(getMcpPaymentRequired({ isError: true, content: [], _meta: { 'x402/error': requirements } })).toBeUndefined();
    expect(getMcpPaymentRequired({ isError: true, content: [{ type: 'text', text: '{broken' }] })).toBeUndefined();
  });

  it('performs one probe and preserves a complete unpaid result', async () => {
    const transport = vi.fn(async () => output);
    expect(await probeMcpTool(transport, request)).toEqual({ result: output, paymentRequired: undefined });
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(probeMcpTool(transport, attachMcpPayment(request, payment))).rejects.toThrow('already contains payment');
  });

  it('sends object proof to an independent peer and returns its full result unchanged', async () => {
    let persisted: McpToolCall | undefined;
    const response = { ...output, _meta: { ...output._meta, 'x402/payment-response': receipt } };
    const transport = vi.fn(async (call: McpToolCall) => {
      expect(call).toEqual(persisted);
      expect(call._meta?.['x402/payment']).toEqual(payment);
      expect(typeof call._meta?.['x402/payment']).toBe('object');
      expect(call._meta?.trace).toBe('trace-1');
      return response;
    });
    const result = await callMcpToolWithPayment({ transport, request, paymentRequired: requirements, payment,
      beforeDispatch: async call => { persisted = call; } });
    expect(result.result).toBe(response);
    expect(result).toMatchObject({ paymentStatus: 'seller_reported_settled', deliveryStatus: 'result_received', receipt });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(request._meta?.['x402/payment']).toBeUndefined();
  });

  it('never dispatches when durable recording fails or selected terms differ', async () => {
    const transport = vi.fn(async () => output);
    await expect(callMcpToolWithPayment({ transport, request, paymentRequired: requirements, payment,
      beforeDispatch: async () => { throw new Error('database unavailable'); } })).rejects.toThrow('database unavailable');
    await expect(callMcpToolWithPayment({ transport, request, paymentRequired: requirements,
      payment: { ...payment, accepted: { ...payment.accepted, amount: '20000' } }, beforeDispatch: async () => {} })).rejects.toThrow('does not match');
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not let persistence hook mutation change the approved dispatch', async () => {
    const transport = vi.fn(async (call: McpToolCall) => {
      expect(call.arguments).toEqual(request.arguments);
      return output;
    });
    await callMcpToolWithPayment({ transport, request, paymentRequired: requirements, payment,
      beforeDispatch: async call => { call.arguments = { ticker: 'changed' }; } });
  });

  it('returns uncertainty after timeout, without another call', async () => {
    const transport = vi.fn(async (): Promise<McpToolResult> => { throw new Error('response lost after settlement'); });
    expect(await callMcpToolWithPayment({ transport, request, paymentRequired: requirements, payment,
      beforeDispatch: async () => {} })).toMatchObject({ paymentStatus: 'unknown', deliveryStatus: 'unknown' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    { ...receipt, transaction: '' },
    { ...receipt, network: 'eip155:1' },
    btoa(JSON.stringify(receipt)),
  ])('retains the delivered result with unknown payment status for invalid receipt %j', async invalid => {
    const response = { ...output, _meta: { 'x402/payment-response': invalid } };
    const result = await callMcpToolWithPayment({ transport: async () => response, request,
      paymentRequired: requirements, payment, beforeDispatch: async () => {} });
    expect(result.paymentStatus).toBe('unknown');
    expect(result.deliveryStatus).toBe('result_received');
    expect(result.result).toBe(response);
  });

  it('distinguishes a failed tool result from a successful payment receipt', async () => {
    const response = { ...output, isError: true, _meta: { 'x402/payment-response': receipt } };
    const result = await callMcpToolWithPayment({ transport: async () => response, request,
      paymentRequired: requirements, payment, beforeDispatch: async () => {} });
    expect(result).toMatchObject({ paymentStatus: 'seller_reported_settled', deliveryStatus: 'tool_error' });
    expect(getMcpPaymentReceipt(response)).toEqual(receipt);
  });

  it('accepts a resource-less v2 proof while retaining approved resource in the dispatch context', async () => {
    const noResource = { ...payment };
    delete noResource.resource;
    const result = await callMcpToolWithPayment({ transport: async call => {
      expect(call._meta?.['x402/payment']).toEqual(noResource);
      return { ...output, _meta: { 'x402/payment-response': receipt } };
    }, request, paymentRequired: requirements, payment: noResource, beforeDispatch: async () => {} });
    expect(result.paymentStatus).toBe('seller_reported_settled');
  });

  it('preserves a pending settlement receipt as unknown, including its broadcast transaction', async () => {
    const pending = { ...receipt, success: false, errorReason: 'settlement_pending', extensions: { recover: 'same-payment' } };
    const response = { ...output, isError: true, _meta: { 'x402/payment-response': pending } };
    const result = await callMcpToolWithPayment({ transport: async () => response, request,
      paymentRequired: requirements, payment, beforeDispatch: async () => {} });
    expect(result).toMatchObject({ paymentStatus: 'unknown', deliveryStatus: 'tool_error', receipt: pending, result: response });
  });

  it('respects the seller recovery state when a facilitator failure remains ambiguous', async () => {
    const failed = { success: false, network: payment.accepted.network, errorReason: 'facilitator_timeout' };
    const response = { isError: true, content: [], _meta: {
      'x402/payment-response': failed,
      'dexter/payment-state': { phase: 'settlement_unknown', recoveryRequired: true },
    } };
    const result = await callMcpToolWithPayment({ transport: async () => response, request,
      paymentRequired: requirements, payment, beforeDispatch: async () => {} });
    expect(result).toMatchObject({ paymentStatus: 'unknown', receipt: failed });
  });

  it('does not automatically pay again when the paid response is another challenge', async () => {
    const transport = vi.fn(async () => challenge);
    const result = await callMcpToolWithPayment({ transport, request, paymentRequired: requirements, payment,
      beforeDispatch: async () => {} });
    expect(result).toMatchObject({ paymentStatus: 'unknown', deliveryStatus: 'tool_error', result: challenge });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined, 'bad response', { content: 'not-an-array' }])('retains malformed response %j after dispatch as uncertainty', async raw => {
    const transport = vi.fn(async () => raw as unknown as McpToolResult);
    const result = await callMcpToolWithPayment({ transport, request, paymentRequired: requirements, payment,
      beforeDispatch: async () => {} });
    expect(result).toMatchObject({ paymentStatus: 'unknown', deliveryStatus: 'unknown', rawResult: raw });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
