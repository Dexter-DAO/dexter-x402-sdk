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
  /** Maximum retry attempts for verify/settle @default 3 */
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
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchWithRetry(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, init);
        if (!response.ok && response.status >= 500) {
          throw new HttpError(response.status, await response.text());
        }
        return response;
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

    const response = await this.fetchWithTimeout(`${this.facilitatorUrl}/supported`);
    if (!response.ok) {
      throw new Error(`Facilitator /supported returned ${response.status}`);
    }

    this.cachedSupported = (await response.json()) as SupportedResponse;
    this.cacheTime = now;
    return this.cachedSupported;
  }

  /**
   * Get the fee payer address for a specific network
   */
  async getFeePayer(network: string): Promise<string> {
    const supported = await this.getSupported();
    const kind = supported.kinds.find(
      (k) => k.x402Version === 2 && k.scheme === 'exact' && k.network === network,
    );

    if (!kind?.extra?.feePayer) {
      throw new Error(
        `Facilitator does not support network "${network}" with scheme "exact", or feePayer not provided`,
      );
    }

    return kind.extra.feePayer;
  }

  /**
   * Get extra data for a network (feePayer, decimals, EIP-712 data, etc.)
   */
  async getNetworkExtra(network: string): Promise<SupportedKind['extra']> {
    const supported = await this.getSupported();
    const kind = supported.kinds.find(
      (k) => k.x402Version === 2 && k.scheme === 'exact' && k.network === network,
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

      const response = await this.fetchWithRetry(`${this.facilitatorUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload,
          paymentRequirements: requirements,
        }),
      });

      if (!response.ok) {
        return {
          isValid: false,
          invalidReason: `facilitator_error_${response.status}`,
        };
      }

      return (await response.json()) as VerifyResponse;
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
   * Retries on 5xx and network errors with exponential backoff.
   */
  async settlePayment(
    paymentSignatureHeader: string,
    requirements: PaymentAccept,
  ): Promise<SettleResponse> {
    try {
      const paymentPayload = decodeBase64Json<PaymentSignature>(paymentSignatureHeader);

      const response = await this.fetchWithRetry(`${this.facilitatorUrl}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload,
          paymentRequirements: requirements,
        }),
      });

      if (!response.ok) {
        return {
          success: false,
          network: requirements.network,
          errorReason: `facilitator_error_${response.status}`,
        };
      }

      const result = (await response.json()) as SettleResponse;
      return { ...result, network: requirements.network };
    } catch (error) {
      const reason = error instanceof HttpError
        ? `facilitator_error_${error.status}`
        : error instanceof Error && error.name === 'AbortError'
          ? 'facilitator_timeout'
          : error instanceof Error
            ? error.message
            : 'unexpected_settle_error';

      return {
        success: false,
        network: requirements.network,
        errorReason: reason,
      };
    }
  }
}
