/**
 * Facilitator Client
 *
 * Communicates with the x402 facilitator for:
 * - /supported - Get supported payment schemes and fee payer addresses
 * - /verify - Verify a payment signature before processing
 * - /settle - Submit the payment for execution
 *
 * Includes retry with exponential backoff and request timeouts.
 * Works with any x402 v2 facilitator (Dexter or others).
 */

import type { PaymentAccept, PaymentSignature, VerifyResponse, SettleResponse } from '../types';
import { DEXTER_FACILITATOR_URL } from '../types';
import { decodeBase64Json } from '../utils';

/**
 * Supported payment kind from facilitator /supported endpoint
 */
export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: {
    feePayer?: string;
    decimals?: number;
    name?: string;
    version?: string;
    [key: string]: unknown;
  };
}

/**
 * Response from facilitator /supported endpoint
 */
export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions?: string[];
  signers?: Record<string, string[]>;
}

/**
 * Configuration for retry and timeout behavior
 */
export interface FacilitatorClientConfig {
  /** Request timeout in milliseconds @default 10000 */
  timeoutMs?: number;
  /** Maximum attempts for verify. Settlement is dispatched once. @default 3 */
  maxRetries?: number;
  /** Base delay between retries in milliseconds (doubles each attempt) @default 500 */
  retryBaseMs?: number;
}

// Retryable: network errors and 5xx responses
function isRetryable(error: unknown): boolean {
  if (error instanceof TypeError) return true; // fetch network errors
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status;
    return status >= 500 && status < 600;
  }
  return false;
}

class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

const MAX_SETTLEMENT_RESPONSE_BYTES = 65_536;

async function readSettlementResponse(
  response: Response,
  evidence: NonNullable<SettleResponse['facilitatorResponse']>,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    evidence.bodyComplete = true;
    return;
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        evidence.bodyComplete = true;
        return;
      }
      const remaining = MAX_SETTLEMENT_RESPONSE_BYTES - bytes;
      const captured = value.subarray(0, remaining);
      evidence.body += decoder.decode(captured, { stream: true });
      bytes += captured.byteLength;
      if (value.byteLength > remaining) {
        evidence.bodyTruncated = true;
        throw new Error('facilitator_response_too_large');
      }
    }
  } finally {
    evidence.body += decoder.decode();
    reader.releaseLock();
  }
}

function knownTransaction(body: string): string | undefined {
  try {
    const result = JSON.parse(body) as { transaction?: unknown } | null;
    return typeof result?.transaction === 'string' && result.transaction.trim().length > 0
      && result.transaction.length <= 256 ? result.transaction : undefined;
  } catch {
    return undefined;
  }
}

function hasUncertainSettlementEvidence(body: string): boolean {
  try {
    const result: unknown = JSON.parse(body);
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    const receipt = result as Record<string, unknown>;
    // An HTTP rejection cannot negate evidence of a dispatched or completed payment.
    // Even an invalid transaction value must keep the outcome uncertain; only the
    // bounded, validated value may be copied into public recovery metadata.
    if (receipt.success === true
      || (typeof receipt.transaction === 'string' && receipt.transaction.trim().length > 0)) return true;
    return [receipt.errorCode, receipt.errorReason, receipt.errorMessage, receipt.error,
      receipt.status, receipt.settlementStatus].some(value => typeof value === 'string'
        && /pending|unknown|unconfirmed|timeout|temporar|in[_ -]?flight|processing|submitted|broadcast|settling|settled|success/i.test(value));
  } catch {
    return false;
  }
}

/**
 * Client for communicating with an x402 v2 facilitator
 */
export class FacilitatorClient {
  private facilitatorUrl: string;
  private cachedSupported: SupportedResponse | null = null;
  private cacheTime: number = 0;
  private readonly CACHE_TTL_MS = 60_000;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(
    facilitatorUrl: string = DEXTER_FACILITATOR_URL,
    config?: FacilitatorClientConfig,
  ) {
    this.facilitatorUrl = facilitatorUrl.replace(/\/$/, '');
    this.timeoutMs = config?.timeoutMs ?? 10_000;
    this.maxRetries = config?.maxRetries ?? 3;
    this.retryBaseMs = config?.retryBaseMs ?? 500;
  }

  private async fetchWithTimeout(
    url: string,
    init?: RequestInit,
  ): Promise<{ response: Response; cleanup: () => void }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      // Cancel unread bodies as well as requests that have not received headers.
      controller.abort();
    };
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      // The reader owns cleanup: headers do not end the response deadline.
      return { response, cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  private async fetchWithRetry(
    url: string,
    init?: RequestInit,
  ): Promise<{ response: Response; cleanup: () => void }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const request = await this.fetchWithTimeout(url, init);
        const { response, cleanup } = request;
        if (!response.ok && response.status >= 500) {
          try {
            throw new HttpError(response.status, await response.text());
          } finally {
            cleanup();
          }
        }
        return request;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries - 1 && isRetryable(error)) {
          const delay = this.retryBaseMs * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  /**
   * Get supported payment kinds from the facilitator.
   * Results are cached for 1 minute to reduce network calls.
   */
  async getSupported(): Promise<SupportedResponse> {
    const now = Date.now();
    if (this.cachedSupported && now - this.cacheTime < this.CACHE_TTL_MS) {
      return this.cachedSupported;
    }

    const { response, cleanup } = await this.fetchWithTimeout(`${this.facilitatorUrl}/supported`);
    try {
      if (!response.ok) {
        throw new Error(`Facilitator /supported returned ${response.status}`);
      }

      this.cachedSupported = (await response.json()) as SupportedResponse;
      this.cacheTime = now;
      return this.cachedSupported;
    } finally {
      cleanup();
    }
  }

  /**
   * Get the fee payer address for a specific network
   */
  async getFeePayer(network: string): Promise<string | undefined> {
    const supported = await this.getSupported();
    // batch-settlement is intentionally excluded: it uses signature-based gas
    // sponsoring (no feePayer field on its /supported kind). Do not add it here.
    const kind = supported.kinds.find(
      (k) => k.x402Version === 2 && (k.scheme === 'exact' || k.scheme === 'exact-approval') && k.network === network,
    );

    if (!kind) {
      throw new Error(
        `Facilitator does not support network "${network}" with a recognized scheme`,
      );
    }

    return kind.extra?.feePayer;
  }

  /**
   * Get extra data for a network (feePayer, decimals, EIP-712 data,
   * receiverAuthorizer for batch-settlement, etc.)
   */
  async getNetworkExtra(network: string): Promise<SupportedKind['extra']> {
    const supported = await this.getSupported();
    const kind = supported.kinds.find(
      (k) =>
        k.x402Version === 2 &&
        (k.scheme === 'exact' ||
          k.scheme === 'exact-approval' ||
          k.scheme === 'batch-settlement') &&
        k.network === network,
    );
    return kind?.extra;
  }

  /**
   * Verify a payment with the facilitator.
   * Retries on 5xx and network errors with exponential backoff.
   */
  async verifyPayment(
    paymentSignatureHeader: string,
    requirements: PaymentAccept,
  ): Promise<VerifyResponse> {
    try {
      const paymentPayload = decodeBase64Json<PaymentSignature>(paymentSignatureHeader);

      const { response, cleanup } = await this.fetchWithRetry(`${this.facilitatorUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload,
          paymentRequirements: requirements,
        }),
      });

      try {
        if (!response.ok) {
          return {
            isValid: false,
            invalidReason: `facilitator_error_${response.status}`,
          };
        }

        return (await response.json()) as VerifyResponse;
      } finally {
        cleanup();
      }
    } catch (error) {
      const reason = error instanceof HttpError
        ? `facilitator_error_${error.status}`
        : error instanceof Error && error.name === 'AbortError'
          ? 'facilitator_timeout'
          : error instanceof Error
            ? error.message
            : 'unexpected_verify_error';

      return { isValid: false, invalidReason: reason };
    }
  }

  /**
   * Settle a payment with the facilitator.
   * Dispatches once. Ambiguous HTTP or settlement evidence leaves the outcome unknown.
   */
  async settlePayment(
    paymentSignatureHeader: string,
    requirements: PaymentAccept,
  ): Promise<SettleResponse> {
    let dispatched = false;
    let evidence: SettleResponse['facilitatorResponse'];
    const unknownOutcome = (reason: string): SettleResponse => {
      const transaction = evidence && knownTransaction(evidence.body);
      return {
        success: false,
        network: requirements.network,
        errorReason: reason,
        errorCode: 'settlement_unknown',
        ...(evidence ? { facilitatorResponse: evidence } : {}),
        ...(transaction ? { transaction } : {}),
      };
    };
    try {
      const paymentPayload = decodeBase64Json<PaymentSignature>(paymentSignatureHeader);
      const body = JSON.stringify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements: requirements,
      });
      dispatched = true;
      const { response, cleanup } = await this.fetchWithTimeout(`${this.facilitatorUrl}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        redirect: 'manual',
      });

      try {
        evidence = { status: response.status, body: '', bodyComplete: false, bodyTruncated: false };
        await readSettlementResponse(response, evidence);
        if (!response.ok) {
          if (response.status >= 500 || response.status < 400
            || response.status === 408 || response.status === 429
            || hasUncertainSettlementEvidence(evidence.body)) {
            return unknownOutcome(`facilitator_error_${response.status}`);
          }
          return {
            success: false,
            network: requirements.network,
            errorReason: `facilitator_error_${response.status}`,
            facilitatorResponse: evidence,
          };
        }

        const result = JSON.parse(evidence.body) as SettleResponse | null;
        if (!result || typeof result !== 'object' || Array.isArray(result)
          || typeof result.success !== 'boolean'
          || (result.success && (typeof result.transaction !== 'string' || !result.transaction.trim()
            || (result.network !== undefined && result.network !== requirements.network)))) {
          return unknownOutcome('invalid_facilitator_response');
        }
        return { ...result, network: requirements.network };
      } finally {
        cleanup();
      }
    } catch (error) {
      const reason = error instanceof HttpError
        ? `facilitator_error_${error.status}`
        : error instanceof Error && error.name === 'AbortError'
          ? 'facilitator_timeout'
          : error instanceof Error
            ? error.message
            : 'unexpected_settle_error';

      if (dispatched) return unknownOutcome(reason);
      return {
        success: false,
        network: requirements.network,
        errorReason: reason,
      };
    }
  }
}
