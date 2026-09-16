import { vi } from 'vitest';
import type {
  McpPaymentPayload, McpPaymentProcessor, McpPaymentRecord, McpPaymentRequired,
  McpPaymentStore, McpToolCall, McpToolResult, PaidMcpToolOptions,
} from '../types';
import { createMcpFacilitatorProcessor } from '../facilitator';

export const requirements: McpPaymentRequired = {
  x402Version: 2,
  resource: { url: 'mcp://example.test/tools/report', description: 'Read a report', mimeType: 'application/json' },
  accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000',
    asset: '0x1111111111111111111111111111111111111111',
    payTo: '0x2222222222222222222222222222222222222222', maxTimeoutSeconds: 60,
    extra: { name: 'USD Coin', version: '2' } }],
};
export const payment: McpPaymentPayload = {
  x402Version: 2, resource: requirements.resource, accepted: requirements.accepts[0],
  payload: { signature: `0x${'11'.repeat(65)}`, authorization: {
    from: '0x3333333333333333333333333333333333333333', to: requirements.accepts[0].payTo,
    value: '10000', validAfter: '0', validBefore: '9999999999', nonce: `0x${'ab'.repeat(32)}`,
  } },
};
export const request: McpToolCall = { name: 'report', arguments: { ticker: 'ABC' }, _meta: { trace: 'trace-1' } };
export const paidRequest: McpToolCall = { ...request, _meta: { ...request._meta, 'x402/payment': payment } };
export const receipt = { success: true as const, transaction: `0x${'77'.repeat(32)}`,
  network: 'eip155:8453', payer: '0x3333333333333333333333333333333333333333' };
export const output: McpToolResult = {
  content: [ { type: 'text', text: 'Report ready' },
    { type: 'resource_link', uri: 'https://example.test/private/report', name: 'report.json', mimeType: 'application/json' } ],
  structuredContent: { findings: [{ source: 'https://example.test/source', value: 42 }] },
  _meta: { trace: 'provider-trace', custom: { retained: true } },
  resultType: 'complete', customExtension: 'retained',
};

/** Test fixture only. Deliberately absent from the public SDK exports. */
export class TestStore implements McpPaymentStore {
  records = new Map<string, McpPaymentRecord>();
  async get(id: string) { return structuredClone(this.records.get(id)); }
  async claim(record: McpPaymentRecord) {
    const existing = this.records.get(record.paymentId);
    if (existing) return { claimed: false as const, record: structuredClone(existing) };
    this.records.set(record.paymentId, structuredClone(record));
    return { claimed: true as const };
  }
  async compareAndSwap(id: string, revision: number, next: McpPaymentRecord) {
    if (this.records.get(id)?.revision !== revision) return false;
    this.records.set(id, structuredClone(next));
    return true;
  }
}

export function fixture() {
  const store = new TestStore();
  const processor = createMcpFacilitatorProcessor({ networks: ['eip155:8453'] });
  const payments: McpPaymentProcessor = {
    supports: processor.supports, identify: processor.identify,
    verify: vi.fn(async () => ({ isValid: true, payer: receipt.payer })),
    settle: vi.fn(async () => ({ status: 'settled' as const, receipt })),
  };
  const execute = vi.fn(async () => structuredClone(output));
  const authorize = vi.fn(async (_request: McpToolCall, context: { account: string }) => context.account);
  const options: PaidMcpToolOptions<{ account: string }> = {
    name: 'report', serviceScope: 'example.test/reports', requirements, payments, store, execute, authorize,
  };
  return { store, payments, execute, authorize, options, context: { account: 'buyer-1' } };
}
