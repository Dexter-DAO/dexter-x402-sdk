import { createHash } from 'node:crypto';

import type {
  FinalVoucherV2ReservationInput,
  FinalVoucherV2ReservationReceipt,
  ReserveFinalVoucherV2,
} from '@dexterai/x402/tab';

const DEFAULT_FACILITATOR_URL = 'https://x402.dexter.cash';
const HEX_32 = /^[0-9a-f]{64}$/;

type JsonRecord = Record<string, unknown>;

interface TabOpenResponse {
  receipt?: FinalVoucherV2ReservationReceipt;
  error?: string;
  retry_after_ms?: number;
  lifecycle?: JsonRecord;
  release?: JsonRecord;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical_non_finite_number');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  throw new Error('canonical_value_unsupported');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(canonicalValue(value)));
}

function successorCallerOperationId(input: {
  rootOperationId: string;
  generation: number;
  predecessorLifecycleOperationId: string;
}): string {
  return `native-tab-open:${sha256([
    'dexter-native-tab-open-generation/v1',
    input.rootOperationId,
    String(input.generation),
    input.predecessorLifecycleOperationId,
  ].join('\0'))}`;
}

function retryDelay(payload: TabOpenResponse): number {
  return Number.isSafeInteger(payload.retry_after_ms) && payload.retry_after_ms! > 0
    ? Math.min(payload.retry_after_ms!, 5_000)
    : 1_000;
}

function buildSuccessorRequest(input: {
  rootOperationId: string;
  commonRequest: JsonRecord;
  currentRequest: JsonRecord;
  voucherDigest: string;
  payload: TabOpenResponse;
}): JsonRecord {
  const release = input.payload.release;
  const lifecycleOperationId = input.payload.lifecycle?.operationId;
  const predecessorCallerOperationId = input.currentRequest.operation_id;
  const currentGeneration = input.currentRequest.generation ?? 1;
  if (
    !release
    || release.contract !== 'dexter-native-tab-open-release/v1'
    || release.rootOperationId !== input.rootOperationId
    || release.predecessorCallerOperationId !== predecessorCallerOperationId
    || release.predecessorLifecycleOperationId !== lifecycleOperationId
    || release.voucherDigest !== input.voucherDigest
    || release.state !== 'expired_unlanded'
    || release.reservationDisposition !== 'released'
    || typeof lifecycleOperationId !== 'string'
    || !HEX_32.test(lifecycleOperationId)
    || typeof predecessorCallerOperationId !== 'string'
    || !Number.isSafeInteger(release.generation)
    || release.generation !== currentGeneration
  ) {
    throw new Error('native tab reservation returned an invalid release certificate');
  }
  const generation = Number(release.generation) + 1;
  if (generation < 2 || generation > 0x7fff_ffff) {
    throw new Error('native tab reservation successor generation is invalid');
  }
  return {
    ...input.commonRequest,
    operation_id: successorCallerOperationId({
      rootOperationId: input.rootOperationId,
      generation,
      predecessorLifecycleOperationId: lifecycleOperationId,
    }),
    root_operation_id: input.rootOperationId,
    generation,
    predecessor_caller_operation_id: predecessorCallerOperationId,
    predecessor_lifecycle_operation_id: lifecycleOperationId,
    predecessor_release: release,
    predecessor_release_digest: canonicalHash(release),
  };
}

/**
 * Reference CLI transport for Dexter's managed FINAL-V2 reservation endpoint.
 * Production browser apps should proxy this money-side effect through their
 * authenticated backend instead of calling the facilitator directly.
 */
export function createManagedReservationProvider(
  facilitatorUrl = process.env.FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL,
): ReserveFinalVoucherV2 {
  const baseUrl = facilitatorUrl.replace(/\/$/, '');
  const internalToken = process.env.TAB_OPEN_INTERNAL_TOKEN?.trim();
  if (!internalToken) {
    throw new Error(
      'TAB_OPEN_INTERNAL_TOKEN is required for this server-only managed reservation example',
    );
  }

  return async (input: FinalVoucherV2ReservationInput) => {
    const commonRequest: JsonRecord = {
      buyer_swig_address: input.buyerSwigAddress,
      vault_pda: input.vaultPda,
      seller: input.seller,
      channel_id: input.channelId,
      session_public_key: hex(input.voucher.sessionPublicKey),
      session_signature: hex(input.voucher.sessionSignature),
      session_registration: hex(input.voucher.sessionRegistration),
      voucher_digest: input.voucherDigest,
      cumulative_amount_atomic: input.voucher.payload.cumulativeAmount,
      sequence_number: input.voucher.payload.sequenceNumber,
      provider_receipt_id: `sdk-example:${input.voucherDigest}`,
      reservation_amount_atomic: input.reservationAmountAtomic,
      network: input.network,
      mode: 'lock',
    };
    const rootOperationId = input.idempotencyKey;
    let request: JsonRecord = {
      ...commonRequest,
      operation_id: rootOperationId,
    };
    let endpoint = `${baseUrl}/tab/open`;
    const deadline = Date.now() + 90_000;

    for (;;) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': internalToken,
        },
        body: JSON.stringify(request),
      });
      const payload = await response.json() as TabOpenResponse;
      if (response.ok && payload.receipt) return payload.receipt;
      if (
        (response.status === 202 || response.status === 503)
        && Date.now() < deadline
      ) {
        await delay(retryDelay(payload));
        continue;
      }
      if (
        response.status === 409
        && payload.error === 'tab_open_expired_unlanded'
        && Date.now() < deadline
      ) {
        request = buildSuccessorRequest({
          rootOperationId,
          commonRequest,
          currentRequest: request,
          voucherDigest: input.voucherDigest,
          payload,
        });
        endpoint = `${baseUrl}/tab/open/successor`;
        continue;
      }
      throw new Error(
        `native tab reservation failed: ${response.status} ${payload.error ?? 'unknown_error'}`,
      );
    }
  };
}
