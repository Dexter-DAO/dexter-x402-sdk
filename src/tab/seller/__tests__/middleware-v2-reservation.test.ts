import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registrationNonce: 0x8000_0007,
  verifyRegistrationOnChain: vi.fn(),
  verifyVoucherSignature: vi.fn(),
  enforceScope: vi.fn(),
  verifySolanaFinalVoucherV2Reservation: vi.fn(),
}));

vi.mock('../verify', async () => {
  const actual = await vi.importActual<typeof import('../verify')>('../verify');
  const { PublicKey } = await import('@solana/web3.js');
  const seller = new PublicKey(
    '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  );
  return {
    ...actual,
    parseRegistration: vi.fn(() => ({
      programId: new PublicKey(
        'Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc',
      ),
      vaultPda: seller,
      sessionPubkey: new Uint8Array(32),
      maxAmount: 1_000_000_000n,
      expiresAt: BigInt(Math.floor(Date.now() / 1_000) + 3_600),
      allowedCounterparty: seller,
      nonce: mocks.registrationNonce,
      maxRevolvingCapacity: 1_000_000n,
    })),
    verifyRegistrationOnChain: mocks.verifyRegistrationOnChain,
    verifyVoucherSignature: mocks.verifyVoucherSignature,
    enforceScope: mocks.enforceScope,
  };
});

vi.mock('../../adapters/solana/reservation-verifier', async () => {
  const actual = await vi.importActual<
    typeof import('../../adapters/solana/reservation-verifier')
  >('../../adapters/solana/reservation-verifier');
  return {
    ...actual,
    verifySolanaFinalVoucherV2Reservation:
      mocks.verifySolanaFinalVoucherV2Reservation,
  };
});

import { tabMiddleware } from '../middleware';
import { InMemoryChannelLedger } from '../channel-ledger';
import { OnChainVerificationError } from '../verify';
import { SolanaFinalVoucherV2ReservationError } from '../../adapters/solana/reservation-verifier';

const SELLER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const CHANNEL = 'b'.repeat(64);

function chainState(overrides: Record<string, unknown> = {}) {
  return {
    sessionAccountVersion: 1,
    wireVersion: 2,
    frontierAtomic: '0',
    spentAtomic: '0',
    currentOutstandingAtomic: '5000',
    crystallizedCumulativeAtomic: '0',
    ...overrides,
  };
}

function reservationReceipt(overrides: Record<string, unknown> = {}) {
  return {
    contract: 'dexter-native-tab-open-receipt/v1',
    operationId: 'a'.repeat(64),
    callerOperationId: `native-tab-v2:${'b'.repeat(64)}`,
    network: 'solana:mainnet',
    transaction: '5'.repeat(88),
    commitment: 'finalized',
    confirmationSlot: 100,
    postStateSlot: 101,
    buyerSwigAddress: SELLER,
    vaultPda: SELLER,
    sessionPda: SELLER,
    seller: SELLER,
    channelId: CHANNEL,
    sessionPublicKey: '00'.repeat(32),
    voucherDigest: 'b'.repeat(64),
    cumulativeAmountAtomic: '5000',
    sequenceNumber: 0x8000_0001,
    providerReceiptId: 'native-tab-provider:test',
    reservationAmountAtomic: '5000',
    pendingVoucherCountBefore: 0,
    pendingVoucherCountAfter: 1,
    currentOutstandingBeforeAtomic: '0',
    currentOutstandingAfterAtomic: '5000',
    ...overrides,
  };
}

function voucherHeader(
  cumulativeAmount: string,
  sequenceNumber: number,
  proof: unknown = reservationReceipt({
    cumulativeAmountAtomic: cumulativeAmount,
    sequenceNumber,
  }),
  includeProof = true,
): string {
  return Buffer.from(JSON.stringify({
    payload: { channelId: CHANNEL, cumulativeAmount, sequenceNumber },
    sessionPublicKey: '00'.repeat(32),
    sessionRegistration: '00'.repeat(188),
    sessionSignature: '00'.repeat(64),
    ...(includeProof ? { reservationReceipt: proof } : {}),
  }), 'utf8').toString('base64');
}

function requestResponse(header: string) {
  const req: any = { headers: { 'x-tab-voucher': header } };
  const res: any = new EventEmitter();
  res.statusCode = 0;
  res.body = undefined;
  res.status = function (code: number) { this.statusCode = code; return this; };
  res.json = function (body: unknown) { this.body = body; return this; };
  res.setHeader = function () { return this; };
  res.write = function () { return true; };
  res.end = function () { return this; };
  res.flushHeaders = function () {};
  res.headersSent = false;
  return { req, res };
}

function middleware(ledger = new InMemoryChannelLedger()) {
  return {
    ledger,
    handle: tabMiddleware({
      connection: {} as any,
      sellerPubkey: SELLER,
      perUnit: '0.01',
      network: 'solana:mainnet',
      settle: 'on-close',
      ledger,
      lockCadence: { thresholdAtomic: '1000000000000', onClose: false },
    }),
  };
}

const release = async (res: EventEmitter) => {
  res.emit('finish');
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('Native Tab V2 seller reservation admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registrationNonce = 0x8000_0007;
    mocks.verifyRegistrationOnChain.mockResolvedValue(chainState());
    mocks.verifySolanaFinalVoucherV2Reservation.mockResolvedValue(undefined);
  });

  it('re-reads the authoritative SessionAccount for every V2 voucher', async () => {
    mocks.verifyRegistrationOnChain
      .mockResolvedValueOnce(chainState({ currentOutstandingAtomic: '5000' }))
      .mockResolvedValueOnce(chainState({
        frontierAtomic: '5000',
        spentAtomic: '5000',
        currentOutstandingAtomic: '3000',
      }));
    const { ledger, handle } = middleware();

    const first = requestResponse(voucherHeader('5000', 0x8000_0001));
    const firstNext = vi.fn();
    await handle(first.req, first.res, firstNext);
    expect(firstNext).toHaveBeenCalledOnce();
    await release(first.res);

    const second = requestResponse(voucherHeader(
      '8000',
      0x8000_0002,
      reservationReceipt({
        cumulativeAmountAtomic: '8000',
        sequenceNumber: 0x8000_0002,
        reservationAmountAtomic: '3000',
        currentOutstandingAfterAtomic: '3000',
      }),
    ));
    const secondNext = vi.fn();
    await handle(second.req, second.res, secondNext);

    expect(secondNext).toHaveBeenCalledOnce();
    expect(mocks.verifyRegistrationOnChain).toHaveBeenCalledTimes(2);
    expect(mocks.verifySolanaFinalVoucherV2Reservation).toHaveBeenCalledTimes(2);
    expect(mocks.verifySolanaFinalVoucherV2Reservation).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelId: CHANNEL,
        reservationAmountAtomic: '3000',
        previousCumulativeAtomic: '5000',
        voucher: expect.objectContaining({
          payload: expect.objectContaining({
            cumulativeAmount: '8000',
            sequenceNumber: 0x8000_0002,
          }),
        }),
      }),
      expect.objectContaining({
        transaction: '5'.repeat(88),
        cumulativeAmountAtomic: '8000',
        reservationAmountAtomic: '3000',
      }),
    );
    expect(mocks.enforceScope).toHaveBeenLastCalledWith(
      expect.objectContaining({ previousCumulativeAtomic: '5000' }),
    );
    expect((await ledger.get(CHANNEL))?.deliveredCumulativeAtomic).toBe('5000');
  });

  it('rejects a warm-cache voucher when the active registration was replaced', async () => {
    mocks.verifyRegistrationOnChain
      .mockResolvedValueOnce(chainState())
      .mockRejectedValueOnce(new OnChainVerificationError(
        'registration_state_mismatch',
        'active registration changed',
      ));
    const { handle } = middleware();

    const first = requestResponse(voucherHeader('5000', 0x8000_0001));
    await handle(first.req, first.res, vi.fn());
    await release(first.res);

    const second = requestResponse(voucherHeader('8000', 0x8000_0002));
    const next = vi.fn();
    await handle(second.req, second.res, next);

    expect(next).not.toHaveBeenCalled();
    expect(second.res.statusCode).toBe(402);
    expect(second.res.body).toMatchObject({
      error: 'invalid_voucher',
      reason: 'registration_state_mismatch',
    });
  });

  it('rejects delivery when currentOutstanding does not equal the uncovered voucher delta', async () => {
    mocks.verifyRegistrationOnChain.mockResolvedValue(
      chainState({ currentOutstandingAtomic: '4999' }),
    );
    const { ledger, handle } = middleware();
    const response = requestResponse(voucherHeader('5000', 0x8000_0001));
    const next = vi.fn();

    await handle(response.req, response.res, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.res.statusCode).toBe(402);
    expect(response.res.body).toMatchObject({ reason: 'reservation_mismatch' });
    expect(await ledger.get(CHANNEL)).toBeNull();
  });

  it('rejects an already-covered V2 voucher before the route can deliver', async () => {
    mocks.verifyRegistrationOnChain.mockResolvedValue(chainState({
      frontierAtomic: '5000',
      spentAtomic: '5000',
      currentOutstandingAtomic: '0',
    }));
    const { handle } = middleware();
    const response = requestResponse(voucherHeader('5000', 0x8000_0001));
    const next = vi.fn();

    await handle(response.req, response.res, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.res.statusCode).toBe(402);
    expect(response.res.body).toMatchObject({ reason: 'voucher_already_covered' });
  });

  it('rejects a V2 voucher when the authoritative session reports the V1 wire', async () => {
    mocks.verifyRegistrationOnChain.mockResolvedValue(chainState({ wireVersion: 1 }));
    const { handle } = middleware();
    const response = requestResponse(voucherHeader('5000', 0x8000_0001));
    const next = vi.fn();

    await handle(response.req, response.res, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.res.statusCode).toBe(402);
    expect(response.res.body).toMatchObject({ reason: 'wire_version_mismatch' });
  });

  it('rejects a V1 voucher sequence carried by a V2 registration', async () => {
    const { handle } = middleware();
    const response = requestResponse(voucherHeader('5000', 1));
    const next = vi.fn();

    await handle(response.req, response.res, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.res.statusCode).toBe(402);
    expect(response.res.body).toMatchObject({ reason: 'wire_version_mismatch' });
  });

  it('fails closed before delivery when a V2 envelope omits its reservation proof', async () => {
    const { handle } = middleware();
    const response = requestResponse(voucherHeader(
      '5000',
      0x8000_0001,
      undefined,
      false,
    ));
    const next = vi.fn();

    await handle(response.req, response.res, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.res.body).toMatchObject({
      reason: 'reservation_proof_missing',
    });
    expect(mocks.verifySolanaFinalVoucherV2Reservation).not.toHaveBeenCalled();
  });

  it.each([null, 'not-an-object', []])(
    'fails closed when the V2 reservation proof is malformed: %j',
    async proof => {
      const { handle } = middleware();
      const response = requestResponse(voucherHeader(
        '5000',
        0x8000_0001,
        proof,
      ));
      const next = vi.fn();

      await handle(response.req, response.res, next);

      expect(next).not.toHaveBeenCalled();
      expect(response.res.body).toMatchObject({
        reason: 'reservation_proof_invalid',
      });
      expect(mocks.verifySolanaFinalVoucherV2Reservation).not.toHaveBeenCalled();
    },
  );

  it('maps an exact Memo/transaction proof failure to a fail-closed 402', async () => {
    mocks.verifySolanaFinalVoucherV2Reservation.mockRejectedValueOnce(
      new SolanaFinalVoucherV2ReservationError('reservation_memo_digest'),
    );
    const { handle } = middleware();
    const response = requestResponse(voucherHeader('5000', 0x8000_0001));
    const next = vi.fn();

    await handle(response.req, response.res, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.res.body).toMatchObject({
      reason: 'reservation_proof_invalid',
    });
  });

  it('preserves historical V1 registration caching without a per-voucher chain read', async () => {
    mocks.registrationNonce = 7;
    mocks.verifyRegistrationOnChain.mockResolvedValue(undefined);
    const { handle } = middleware();

    const first = requestResponse(voucherHeader('5000', 1));
    await handle(first.req, first.res, vi.fn());
    await release(first.res);

    const second = requestResponse(voucherHeader('8000', 2));
    const next = vi.fn();
    await handle(second.req, second.res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(mocks.verifyRegistrationOnChain).toHaveBeenCalledTimes(1);
    expect(mocks.verifySolanaFinalVoucherV2Reservation).not.toHaveBeenCalled();
  });
});
