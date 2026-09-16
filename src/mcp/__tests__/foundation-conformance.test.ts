import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { x402Client, x402MCPClient, type PaymentPayload } from '@x402/mcp';
import { createPaidMcpTool } from '../seller';
import { callMcpToolWithPayment, probeMcpTool } from '../client';
import { fixture, output, payment, receipt, request, requirements } from './fixtures';
import type { McpToolResult } from '../types';

describe('published Foundation MCP conformance', () => {
  it('stock @x402/mcp 2.26 client buys from our seller over MCP transport', async () => {
    const f = fixture();
    const tool = createPaidMcpTool(f.options);
    const server = new Server({ name: 'independent-seller', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'report',
      inputSchema: { type: 'object', properties: { ticker: { type: 'string' } } } }] }));
    server.setRequestHandler(CallToolRequestSchema, call => tool(call.params, f.context));
    const client = new Client({ name: 'foundation-buyer', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const paid = new x402MCPClient(client, new x402Client());
      // Payment cryptography is deliberately stubbed. This verifies the
      // published client's challenge parsing, wire proof and receipt exchange.
      paid.onPaymentRequired(({ paymentRequired }) => {
        expect(paymentRequired).toEqual(requirements);
        return { payment: payment as PaymentPayload };
      });
      const result = await paid.callTool('report', { ticker: 'ABC' });
      expect(result.content).toEqual(output.content);
      expect(result.paymentResponse).toEqual(receipt);
      expect(result.isError).not.toBe(true);
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.payments.settle).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('our buyer preserves structured content and metadata across an independent MCP seller', async () => {
    const server = new Server({ name: 'reference-wire-seller', version: '1' }, { capabilities: { tools: {} } });
    let paidCalls = 0;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'report', inputSchema: { type: 'object' } }] }));
    // Handwritten seller follows the published wire specification. It shares
    // neither challenge encoding nor seller helper code with the tested buyer.
    server.setRequestHandler(CallToolRequestSchema, async call => {
      if (!call.params._meta?.['x402/payment']) {
        return { isError: true, structuredContent: requirements,
          content: [{ type: 'text', text: JSON.stringify(requirements) }] };
      }
      expect(call.params._meta['x402/payment']).toEqual(payment);
      expect(call.params._meta.trace).toBe('trace-1');
      paidCalls++;
      return { content: output.content, structuredContent: output.structuredContent,
        _meta: { ...output._meta, 'x402/payment-response': receipt } };
    });
    const client = new Client({ name: 'dexter-buyer', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const transport = async (call: typeof request) => await client.callTool(call) as McpToolResult;
      const challenge = await probeMcpTool(transport, request);
      expect(challenge.paymentRequired).toEqual(requirements);
      const result = await callMcpToolWithPayment({ transport, request,
        paymentRequired: challenge.paymentRequired!, payment, beforeDispatch: async () => {} });
      expect(result.result?.structuredContent).toEqual(output.structuredContent);
      expect(result.result?.content).toEqual(output.content);
      expect(result.result?._meta?.custom).toEqual({ retained: true });
      expect(result.receipt).toEqual(receipt);
      expect(paidCalls).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
