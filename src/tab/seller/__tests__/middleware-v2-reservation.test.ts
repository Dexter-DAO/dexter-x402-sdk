import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registrationNonce: 0x8000_0007,
  verifyRegistrationOnChain: vi.fn(),
  verifyVoucherSignature: vi.fn(),
  enforceScope: vi.fn(),
  inspectSolanaFinalVoucherV2Reservation: vi.fn(),
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
    inspectSolanaFinalVoucherV2Reservation:
      mocks.inspectSolanaFinalVoucherV2Reservation,
  };
});

import { tabMiddleware } from '../middleware';
import { InMemoryChannelLedger } from '../channel-ledger';
import { SolanaFinalVoucherV2ReservationError } from '../../adapters/solana/reservation-verifier';
import { ScopeViolationError } from '../verify';

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
    commitment: 'confirmed',
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
  registrationHex = '00'.repeat(188),
): string {
  return Buffer.from(JSON.stringify({
    payload: { channelId: CHANNEL, cumulativeAmount, sequenceNumber },
    sessionPublicKey: '00'.repeat(32),
    sessionRegistration: registrationHex,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    mocks.inspectSolanaFinalVoucherV2Reservation.mockResolvedValue(chainState());
  });

  it('re-reads the authoritative SessionAccount for every V2 voucher', async () => {
    mocks.inspectSolanaFinalVoucherV2Reservation
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
    expect(mocks.verifyRegistrationOnChain).not.toHaveBeenCalled();
    expect(mocks.inspectSolanaFinalVoucherV2Reservation).toHaveBeenCalledTimes(2);
    expect(mocks.inspectSolanaFinalVoucherV2Reservation).toHaveBeenLastCalledWith(
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
    mocks.inspectSolanaFinalVoucherV2Reservation
      .mockResolvedValueOnce(chainState())
      .mockRejectedValueOnce(
        new SolanaFinalVoucherV2ReservationError('session_post_state'),
      );
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
      reason: 'reservation_proof_invalid',
    });
  });

  it('does not let a scope-rejected first request poison a legitimate channel registration', async () => {
    mocks.enforceScope.mockImplementationOnce(() => {
      throw new ScopeViolationError('wrong_counterparty');
    });
    const { handle } = middleware();

    const rejected = requestResponse(voucherHeader(
      '5000',
      0x8000_0001,
      reservationReceipt(),
      true,
      '11'.repeat(188),
    ));
    const rejectedNext = vi.fn();
    await handle(rejected.req, rejected.res, rejectedNext);

    expect(rejectedNext).not.toHaveBeenCalled();
    expect(rejected.res.statusCode).toBe(402);
    expect(rejected.res.body).toMatchObject({ reason: 'wrong_counterparty' });

    const legitimate = requestResponse(voucherHeader(
      '5000',
      0x8000_0001,
      reservationReceipt(),
      true,
      '22'.repeat(188),
    ));
    const legitimateNext = vi.fn();
    await handle(legitimate.req, legitimate.res, legitimateNext);

    expect(legitimateNext).toHaveBeenCalledOnce();
    expect(mocks.inspectSolanaFinalVoucherV2Reservation).toHaveBeenCalledTimes(2);
    // The legitimate request is checked once before and once after acquiring
    // the durable lease; the rejected request fails its first scope check.
    expect(mocks.enforceScope).toHaveBeenCalledTimes(3);
  });

  it('does not let a concurrent first-seen registration overwrite the channel winner', async () => {
    const firstProof = deferred<ReturnType<typeof chainState>>();
    const secondProof = deferred<ReturnType<typeof chainState>>();
    mocks.inspectSolanaFinalVoucherV2Reservation
      .mockImplementationOnce(() => firstProof.promise)
      .mockImplementationOnce(() => secondProof.promise);
    const { handle } = middleware();

    const first = requestResponse(voucherHeader(
      '5000',
      0x8000_0001,
      reservationReceipt(),
      true,
      '11'.repeat(188),
    ));
    const second = requestResponse(voucherHeader(
      '5000',
      0x8000_0001,
      reservationReceipt(),
      true,
      '22'.repeat(188),
    ));
    const firstNext = vi.fn();
    const secondNext = vi.fn();
    const firstPending = handle(first.req, first.res, firstNext);
    const secondPending = handle(second.req, second.res, secondNext);

    await vi.waitFor(() => {
      expect(mocks.inspectSolanaFinalVoucherV2Reservation).toHaveBeenCalledTimes(2);
    });
    firstProof.resolve(chainState());
    await firstPending;
    expect(firstNext).toHaveBeenCalledOnce();

    secondProof.resolve(chainState());
    await secondPending;
    expect(secondNext).not.toHaveBeenCalled();
    expect(second.res.statusCode).toBe(402);
    expect(second.res.body).toMatchObject({
      error: 'invalid_voucher',
      detail: expect.stringContaining('lost the channel admission race'),
    });

    await release(first.res);
    mocks.inspectSolanaFinalVoucherV2Reservation.mockResolvedValueOnce(
      chainState({
        frontierAtomic: '5000',
        spentAtomic: '5000',
        currentOutstandingAtomic: '3000',
      }),
    );
    const winnerRetry = requestResponse(voucherHeader(
      '8000',
      0x8000_0002,
      reservationReceipt({
        cumulativeAmountAtomic: '8000',
        sequenceNumber: 0x8000_0002,
        reservationAmountAtomic: '3000',
        currentOutstandingAfterAtomic: '3000',
      }),
      true,
      '11'.repeat(188),
    ));
    const winnerRetryNext = vi.fn();
    await handle(winnerRetry.req, winnerRetry.res, winnerRetryNext);

    expect(winnerRetryNext).toHaveBeenCalledOnce();
  });

  it('revalidates durable registration after lease when a different process wins during proof', async () => {
    const delayedProof = deferred<ReturnType<typeof chainState>>();
    mocks.inspectSolanaFinalVoucherV2Reservation
      .mockImplementationOnce(() => delayedProof.promise)
      .mockResolvedValueOnce(chainState());
    const ledger = new InMemoryChannelLedger();
    const delayedProcess = middleware(ledger).handle;
    const winningProcess = middleware(ledger).handle; // independent SessionCache

    const delayed = requestResponse(voucherHeader(
      '5000',
      0x8000_0001,
      reservationReceipt(),
      true,
      '11'.repeat(188),
    ));
    const delayedNext = vi.fn();
    const delayedPending = delayedProcess(delayed.req, delayed.res, delayedNext);
    await vi.waitFor(() => {
      expect(mocks.inspectSolanaFinalVoucherV2Reservation).toHaveBeenCalledTimes(1);
    });

    const winner = requestResponse(voucherHeader(
      '5000',
      0x8000_0001,
      reservationReceipt(),
      true,
      '22'.repeat(188),
    ));
    const winnerNext = vi.fn();
    await winningProcess(winner.req, winner.res, winnerNext);
    expect(winnerNext).toHaveBeenCalledOnce();
    await release(winner.res);

    delayedProof.resolve(chainState());
    await delayedPending;
    expect(delayedNext).not.toHaveBeenCalled();
    expect(delayed.res.statusCode).toBe(402);
    expect(delayed.res.body).toMatchObject({
      error: 'invalid_voucher',
      detail: expect.stringContaining('durable channel registration changed'),
    });
    expect(Array.from((await ledger.get(CHANNEL))!.lastVoucher!.sessionRegistration))
      .toEqual(Array.from(new Uint8Array(188).fill(0x22)));
  });

  it('does not acquire or renew a lease after the response closes during deferred proof', async () => {
    const delayedProof = deferred<ReturnType<typeof chainState>>();
    mocks.inspectSolanaFinalVoucherV2Reservation.mockReturnValueOnce(delayedProof.promise);
    const ledger = new InMemoryChannelLedger();
    const renew = vi.spyOn(ledger, 'renewLease');
    const { handle } = middleware(ledger);
    const response = requestResponse(voucherHeader('5000', 0x8000_0001));
    const next = vi.fn();

    const pending = handle(response.req, response.res, next);
    await vi.waitFor(() => {
      expect(mocks.inspectSolanaFinalVoucherV2Reservation).toHaveBeenCalledOnce();
    });
    response.res.emit('close');
    delayedProof.resolve(chainState());
    await pending;

    expect(next).not.toHaveBeenCalled();
    expect(response.req.tab).toBeUndefined();
    expect(renew).not.toHaveBeenCalled();
    const available = await ledger.tryAcquireLease(CHANNEL, 60_000);
    expect(available).not.toBeNull();
    await ledger.releaseLease(CHANNEL, available!);
  });

  it('does not cache a first-seen registration that loses the durable lease', async () => {
    const ledger = new InMemoryChannelLedger();
    const originalAcquire = ledger.tryAcquireLease.bind(ledger);
    vi.spyOn(ledger, 'tryAcquireLease')
      .mockResolvedValueOnce(null)
      .mockImplementation(originalAcquire);
    const { handle } = middleware(ledger);

    const leaseLoser = requestResponse(voucherHeader(
      '5000',
      0x8000_0001,
      reservationReceipt(),
      true,
      '11'.repeat(188),
    ));
    const leaseLoserNext = vi.fn();
    await handle(leaseLoser.req, leaseLoser.res, leaseLoserNext);

    expect(leaseLoserNext).not.toHaveBeenCalled();
    expect(leaseLoser.res.statusCode).toBe(402);
    expect(leaseLoser.res.body).toMatchObject({ reason: 'channel_busy' });

    const legitimate = requestResponse(voucherHeader(
      '5000',
      0x8000_0001,
      reservationReceipt(),
      true,
      '22'.repeat(188),
    ));
    const legitimateNext = vi.fn();
    await handle(legitimate.req, legitimate.res, legitimateNext);

    expect(legitimateNext).toHaveBeenCalledOnce();
    expect(mocks.inspectSolanaFinalVoucherV2Reservation).toHaveBeenCalledTimes(2);
  });

  it('rolls back the exact provisional cache entry when durable ledger I/O fails', async () => {
    const ledger = new InMemoryChannelLedger();
    const originalGet = ledger.get.bind(ledger);
    let getCalls = 0;
    vi.spyOn(ledger, 'get').mockImplementation(async (channelId) => {
      getCalls += 1;
      if (getCalls === 2) throw new Error('simulated durable read failure');
      return originalGet(channelId);
    });
    const { handle } = middleware(ledger);

    const failed = requestResponse(voucherHeader(
      '5000',
      0x8000_0001,
      reservationReceipt(),
      true,
      '11'.repeat(188),
    ));
    const failedNext = vi.fn();
    await handle(failed.req, failed.res, failedNext);

    expect(failedNext).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'simulated durable read failure' }),
    );
    await release(failed.res);

    const legitimate = requestResponse(voucherHeader(
      '5000',
      0x8000_0001,
      reservationReceipt(),
      true,
      '22'.repeat(188),
    ));
    const legitimateNext = vi.fn();
    await handle(legitimate.req, legitimate.res, legitimateNext);

    expect(legitimateNext).toHaveBeenCalledOnce();
    expect(mocks.inspectSolanaFinalVoucherV2Reservation).toHaveBeenCalledTimes(2);
  });

  it('rejects delivery when currentOutstanding does not equal the uncovered voucher delta', async () => {
    mocks.inspectSolanaFinalVoucherV2Reservation.mockResolvedValue(
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
    mocks.inspectSolanaFinalVoucherV2Reservation.mockResolvedValue(chainState({
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
    mocks.inspectSolanaFinalVoucherV2Reservation.mockResolvedValue(
      chainState({ wireVersion: 1 }),
    );
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
    expect(mocks.inspectSolanaFinalVoucherV2Reservation).not.toHaveBeenCalled();
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
      expect(mocks.inspectSolanaFinalVoucherV2Reservation).not.toHaveBeenCalled();
    },
  );

  it('maps an exact Memo/transaction proof failure to a fail-closed 402', async () => {
    mocks.inspectSolanaFinalVoucherV2Reservation.mockRejectedValueOnce(
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
    expect(mocks.inspectSolanaFinalVoucherV2Reservation).not.toHaveBeenCalled();
  });
});
