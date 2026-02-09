/**
 * Facilitator Client
 *
 * Communicates with the x402 facilitator for:
 * - /supported - Get supported payment schemes and fee payer addresses
 * - /verify - Verify a payment signature before processing
 * - /settle - Submit the payment for execution
 *
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
}

/**
 * Client for communicating with an x402 v2 facilitator
 */
export class FacilitatorClient {
  private facilitatorUrl: string;
  private cachedSupported: SupportedResponse | null = null;
  private cacheTime: number = 0;
  private readonly CACHE_TTL_MS = 60_000; // 1 minute cache

  constructor(facilitatorUrl: string = DEXTER_FACILITATOR_URL) {
    this.facilitatorUrl = facilitatorUrl.replace(/\/$/, ''); // Remove trailing slash
  }

  /**
   * Get supported payment kinds from the facilitator
   * Results are cached for 1 minute to reduce network calls
   */
  async getSupported(): Promise<SupportedResponse> {
    const now = Date.now();
    if (this.cachedSupported && now - this.cacheTime < this.CACHE_TTL_MS) {
      return this.cachedSupported;
    }

    const response = await fetch(`${this.facilitatorUrl}/supported`);
    if (!response.ok) {
      throw new Error(`Facilitator /supported returned ${response.status}`);
    }

    this.cachedSupported = (await response.json()) as SupportedResponse;
    this.cacheTime = now;
    return this.cachedSupported;
  }

  /**
   * Get the fee payer address for a specific network
   *
   * @param network - CAIP-2 network identifier
   * @returns Fee payer address
   */
  async getFeePayer(network: string): Promise<string> {
    const supported = await this.getSupported();

    // Find matching network support (exact match or v2)
    const kind = supported.kinds.find(
      (k) =>
        k.x402Version === 2 &&
        k.scheme === 'exact' &&
        k.network === network
    );

    if (!kind?.extra?.feePayer) {
      throw new Error(
        `Facilitator does not support network "${network}" with scheme "exact", or feePayer not provided`
      );
    }

    return kind.extra.feePayer;
  }

  /**
   * Get extra data for a network (feePayer, decimals, EIP-712 data, etc.)
   *
   * @param network - CAIP-2 network identifier
   * @returns Extra data from /supported
   */
  async getNetworkExtra(network: string): Promise<SupportedKind['extra']> {
    const supported = await this.getSupported();

    const kind = supported.kinds.find(
      (k) =>
        k.x402Version === 2 &&
        k.scheme === 'exact' &&
        k.network === network
    );

    return kind?.extra;
  }

  /**
   * Verify a payment with the facilitator
   *
   * @param paymentSignatureHeader - Base64-encoded PAYMENT-SIGNATURE header value
   * @param requirements - The payment requirements that were sent to the client
   * @returns Verification response
   */
  async verifyPayment(
    paymentSignatureHeader: string,
    requirements: PaymentAccept
  ): Promise<VerifyResponse> {
    try {
      const paymentPayload = decodeBase64Json<PaymentSignature>(paymentSignatureHeader);

      const verifyPayload = {
        x402Version: 2,
        paymentPayload,
        paymentRequirements: requirements,
      };

      const response = await fetch(`${this.facilitatorUrl}/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(verifyPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Facilitator /verify returned ${response.status}:`, errorText);
        return {
          isValid: false,
          invalidReason: `facilitator_error_${response.status}`,
        };
      }

      return (await response.json()) as VerifyResponse;
    } catch (error) {
      console.error('Payment verification failed:', error);
      return {
        isValid: false,
        invalidReason: error instanceof Error ? error.message : 'unexpected_verify_error',
      };
    }
  }

  /**
   * Settle a payment with the facilitator
   *
   * @param paymentSignatureHeader - Base64-encoded PAYMENT-SIGNATURE header value
   * @param requirements - The payment requirements that were sent to the client
   * @returns Settlement response with transaction signature on success
   */
  async settlePayment(
    paymentSignatureHeader: string,
    requirements: PaymentAccept
  ): Promise<SettleResponse> {
    try {
      const paymentPayload = decodeBase64Json<PaymentSignature>(paymentSignatureHeader);

      const settlePayload = {
        x402Version: 2,
        paymentPayload,
        paymentRequirements: requirements,
      };

      const response = await fetch(`${this.facilitatorUrl}/settle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(settlePayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Facilitator /settle returned ${response.status}:`, errorText);
        return {
          success: false,
          network: requirements.network,
          errorReason: `facilitator_error_${response.status}`,
        };
      }

      const result = (await response.json()) as SettleResponse;
      return {
        ...result,
        network: requirements.network,
      };
    } catch (error) {
      console.error('Payment settlement failed:', error);
      return {
        success: false,
        network: requirements.network,
        errorReason: error instanceof Error ? error.message : 'unexpected_settle_error',
      };
    }
  }
}
