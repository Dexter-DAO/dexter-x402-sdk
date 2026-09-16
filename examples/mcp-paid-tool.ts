import {
  createMcpFacilitatorProcessor, createPaidMcpTool,
  type McpPaymentStore,
} from '@dexterai/x402/mcp';

interface CustomerContext { accountId?: string }

/** Supply the application's existing durable store and report execution. */
export function createReportTool(dependencies: {
  sellerAddress: string;
  store: McpPaymentStore;
  requireAccount(context: CustomerContext): Promise<string>;
  buildReport(arguments_: Record<string, unknown>, paymentId: string): Promise<{
    summary: string;
    sources: string[];
  }>;
}) {
  return createPaidMcpTool<CustomerContext>({
    name: 'report',
    serviceScope: 'reports.example/customer-reports',
    requirements: {
      x402Version: 2,
      resource: { url: 'mcp://reports.example/tools/report', mimeType: 'application/json' },
      accepts: [{
        scheme: 'exact', network: 'eip155:8453', amount: '10000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: dependencies.sellerAddress, maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2' },
      }],
    },
    payments: createMcpFacilitatorProcessor({ networks: ['eip155:8453'] }),
    store: dependencies.store,
    authorize: (_request, context) => dependencies.requireAccount(context),
    execute: async (request, { paymentId }) => {
      const report = await dependencies.buildReport(request.arguments ?? {}, paymentId);
      return { content: [{ type: 'text', text: report.summary }], structuredContent: report };
    },
  });
}
