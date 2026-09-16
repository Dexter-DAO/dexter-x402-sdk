import type { ResourceInfo, SettleResponse, VerifyResponse } from '../types';

/** The tools/call params object. Supply your MCP client's transport separately. */
export interface McpToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Complete MCP result, including resources, structured data and extensions. */
export interface McpToolResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpPaymentAccept {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface McpPaymentRequired {
  x402Version: 2;
  resource: ResourceInfo;
  accepts: McpPaymentAccept[];
  error?: string;
  extensions?: Record<string, unknown>;
}

export interface McpPaymentPayload {
  x402Version: 2;
  resource?: ResourceInfo;
  accepted: McpPaymentAccept;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export type McpSettlementOutcome =
  | { status: 'settled'; receipt: SettleResponse & { success: true } }
  | { status: 'failed'; receipt: SettleResponse & { success: false } }
  | { status: 'unknown'; reason: string; receipt?: SettleResponse };

/** Implement additional schemes with their own stable, semantic payment ID. */
export interface McpPaymentProcessor {
  supports(requirements: McpPaymentAccept): boolean;
  /** Same on-chain authorization must produce the same ID, regardless of metadata. */
  identify(payment: McpPaymentPayload): string;
  verify(payment: McpPaymentPayload, requirements: McpPaymentAccept): Promise<VerifyResponse>;
  /** Make one attempt. Reconcile uncertainty outside this adapter. */
  settle(payment: McpPaymentPayload, requirements: McpPaymentAccept): Promise<McpSettlementOutcome>;
}

export type McpPaymentPhase =
  | 'admitted'
  | 'executing'
  | 'executed'
  | 'settling'
  | 'complete'
  | 'execution_failed'
  | 'execution_unknown'
  | 'settlement_failed'
  | 'settlement_unknown';

/** Persist privately: this record contains payment proof and service output. */
export interface McpPaymentRecord {
  paymentId: string;
  revision: number;
  phase: McpPaymentPhase;
  binding: string;
  proofFingerprint: string;
  accessScope: string;
  serviceScope: string;
  resource: ResourceInfo;
  request: McpToolCall;
  payment: McpPaymentPayload;
  payer?: string;
  result?: McpToolResult;
  receipt?: SettleResponse;
}

/**
 * Application-owned durable storage. All tools accepting the same payments
 * must share it. claim must insert once atomically across workers; CAS must
 * durably commit before resolving. Retain records through payment validity
 * and your result-retrieval period. Never expire in-flight records on a timer.
 */
export interface McpPaymentStore {
  get(paymentId: string): Promise<McpPaymentRecord | undefined>;
  claim(record: McpPaymentRecord): Promise<
    { claimed: true } | { claimed: false; record: McpPaymentRecord }
  >;
  compareAndSwap(paymentId: string, expectedRevision: number, next: McpPaymentRecord): Promise<boolean>;
}

export interface PaidMcpToolOptions<Context> {
  name: string;
  /** Stable seller/service identity; never use a transient MCP session ID. */
  serviceScope: string;
  requirements: McpPaymentRequired | ((request: McpToolCall, context: Context) => Promise<McpPaymentRequired>);
  payments: McpPaymentProcessor;
  store: McpPaymentStore;
  /** Authenticate every request, including cached result retrieval. */
  authorize(request: McpToolCall, context: Context): Promise<string>;
  /** Synchronous completion contract. Application owns side-effect recovery. */
  execute(request: McpToolCall, context: {
    application: Context;
    paymentId: string;
    payer?: string;
    requirements: McpPaymentAccept;
  }): Promise<McpToolResult>;
}

export type McpToolTransport = (request: McpToolCall) => Promise<McpToolResult>;

export interface McpPaidCallOutcome {
  /** Retained in full, even when receipt parsing fails. */
  result?: McpToolResult;
  /** Malformed transport response retained for diagnosis after paid dispatch. */
  rawResult?: unknown;
  paymentStatus: 'seller_reported_settled' | 'seller_reported_failed' | 'unknown';
  deliveryStatus: 'result_received' | 'tool_error' | 'unknown';
  receipt?: SettleResponse;
  /** Transport exception or invalid/missing receipt. No automatic retry occurs. */
  error?: unknown;
}
