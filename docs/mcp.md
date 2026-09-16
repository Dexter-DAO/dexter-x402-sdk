# Paid MCP tools

`@dexterai/x402/mcp` implements the published [x402 v2 MCP exchange](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md). A seller returns payment requirements as a tool error, the buyer sends an object under `params._meta["x402/payment"]`, and the seller returns the receipt under `result._meta["x402/payment-response"]`.

The adapters accept ordinary `tools/call` parameters and return complete tool results. Connect them to your MCP server or client through the transport you already use. Structured content, resources and unrelated metadata are retained.

## Supported combinations

| Component | Supported behavior |
| --- | --- |
| Wire helpers and buyer dispatch | x402 v2 object metadata binding; caller supplies an approved, signed payment |
| Default facilitator processor | `exact` on explicitly configured EVM or Solana networks |
| EVM proof forms | EIP-3009, or Permit2 with `extra.assetTransferMethod: "permit2"`; mixed forms are rejected |
| Solana proof | Signed transaction with omitted `assetTransferMethod` or `"default"`, using the SPL transfer implementation |
| Payment flow | Authorization followed by completed tool execution and settlement; omit `paymentFlow` or set it to `"authorization"` |
| MCP lifecycle | Ordinary completed tool results, including July's `resultType: "complete"` when supplied by your transport |

Other payment schemes need an explicit `McpPaymentProcessor` with a stable authorization identity and tested settlement behavior. Tabs, channel payments, upfront payments and escrow require their own lifecycle integration. The wrapper rejects task handles as completed delivery. MCP Tasks support belongs in the application that runs and stores the work.

The maintained conformance tests exercise the published `@x402/mcp` 2.26.0 client over an MCP SDK in-memory transport. A second independently written peer tests complete result preservation. Those tests stub payment verification and settlement; deployment still needs a funded test for each advertised network and scheme.

## Seller

```ts
import { createPaidMcpTool, createMcpFacilitatorProcessor } from '@dexterai/x402/mcp';

const paidReport = createPaidMcpTool({
  name: 'report',
  serviceScope: 'reports.example/customer-reports',
  requirements: {
    x402Version: 2,
    resource: { url: 'mcp://reports.example/tools/report' },
    accepts: [{
      scheme: 'exact', network: 'eip155:8453', amount: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: sellerAddress, maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2' },
    }],
  },
  payments: createMcpFacilitatorProcessor({ networks: ['eip155:8453'] }),
  store: durablePaymentStore,
  authorize: async (_request, context) => requireCustomerAccount(context),
  execute: async (request, { paymentId }) => {
    const report = await buildReport(request.arguments, paymentId);
    return { content: [{ type: 'text', text: report.summary }], structuredContent: report };
  },
});

// In your server's tools/call handler, pass the complete params and auth context.
return paidReport(call.params, authenticatedContext);
```

`durablePaymentStore`, authentication and `buildReport` are application dependencies. [The typed example](../examples/mcp-paid-tool.ts) makes those dependencies explicit. Your service owns its hosting, delivery and customer accounts.

`authorize` runs before both execution and cached retrieval. Return a stable customer identity, and reject revoked access there. A deliberately public service can return a fixed access scope; this makes possession of the original payment proof sufficient to retrieve its cached result. Keep private services tied to authenticated accounts.

All charge-affecting inputs belong in the tool arguments and advertised requirements. The first verified admission binds the payment to the service, arguments and caller. The x402 signature itself does not automatically sign arbitrary tool arguments.

## Durable storage and recovery

Implement `McpPaymentStore` against your database:

- `claim` inserts the payment ID once atomically across every worker and paid tool sharing these payments. Use a uniqueness constraint; duplicate callers receive the existing record.
- `compareAndSwap` updates only the expected revision and acknowledges success after durable commit. Persist output before settlement and the receipt before returning completion.
- Protect records as private data. They contain payment proofs and outputs. Retain them for the payment's validity and your promised result-access period. Keep unresolved records until reconciliation completes.

The package intentionally requires this store; it supplies no default memory store. Database outages stop new work before execution. An interrupted execution remains admitted. A settlement timeout, pending transaction or uncertain database acknowledgement requires reconciliation of that same operation. The wrapper avoids repeating execution or settlement automatically.

After admission, errors return a recovery state under `dexter/payment-state`. They do not issue a fresh payment challenge, which could prompt another authorization. Pending receipts retain their transaction and extensions. A definite settlement failure also withholds the service output. Application recovery can inspect the saved result and original proof, reconcile the chain or provider, then commit the recovered result using the store's revision check.

Successful duplicate requests return the saved result. The adapter rechecks authorization and binding, so another caller or changed arguments cannot retrieve it. Current price changes do not invalidate a completed purchase. The application can expose authenticated result retrieval using the same stored record without demanding another payment.

Tool errors are saved without settlement. If the handler throws after making an external change, the operation remains unresolved for application recovery. Use the supplied payment ID to connect those external effects to the admitted work.

## Buyer

```ts
import { probeMcpTool, callMcpToolWithPayment } from '@dexterai/x402/mcp';

const request = { name: 'report', arguments: { ticker: 'ABC' } };
const transport = params => connectedMcpClient.callTool(params);
const probe = await probeMcpTool(transport, request);
if (!probe.paymentRequired) return probe.result;

const payment = await approveAndSign(probe.paymentRequired, request);
const outcome = await callMcpToolWithPayment({
  transport, request, paymentRequired: probe.paymentRequired, payment,
  beforeDispatch: exactPaidRequest => journal.recordDispatch({
    serverIdentity, exactPaidRequest, requirements: probe.paymentRequired,
  }),
});
```

The transport must remain connected to the selected server. The caller owns authorization, spend limits, signing, connection security and recording the server identity. An unpaid probe can execute a free tool; check the tool's semantics before probing.

`callMcpToolWithPayment` waits for the durable hook and then makes one paid call. It reports payment and delivery separately. `seller_reported_settled` records the seller's receipt; independent chain verification remains the caller's responsibility. Missing receipts, malformed responses and `settlement_pending` remain unknown. Preserve the original operation for recovery rather than creating another authorization.

Lower-level integrations can use `getMcpPaymentRequired`, `attachMcpPayment` and `getMcpPaymentReceipt` while retaining their own dispatch and recovery code. Resource information in a v2 proof is optional; when present, it must match the approved resource. The server always stores its authoritative resource and request binding.
