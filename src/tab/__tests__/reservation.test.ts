import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';

import {
  assertFinalVoucherV2ReservationReceipt,
  FINAL_VOUCHER_V2_RESERVATION_MEMO_PREFIX,
  FINAL_VOUCHER_V2_SOLANA_MAINNET_CAIP2,
  finalVoucherV2Digest,
  finalVoucherV2ReservationBindingDigest,
  finalVoucherV2ReservationBindingDigestFromIdentity,
  finalVoucherV2ReservationIdentity,
  finalVoucherV2ReservationMemo,
} from '../reservation';
import type {
  FinalVoucherV2ReservationInput,
  FinalVoucherV2ReservationReceipt,
  SignedVoucher,
} from '../types';
import { finalizedReservationReceipt } from './reservation-fixture';

const key = (fill: number) =>
  Keypair.fromSeed(new Uint8Array(32).fill(fill)).publicKey.toBase58();
const BUYER_SWIG = key(1);
const VAULT = key(2);
const SESSION = key(3);
const SELLER = key(4);
const PROGRAM = key(5);

function voucher(overrides: Partial<SignedVoucher['payload']> = {}): SignedVoucher {
  return {
    payload: {
      channelId: 'ab'.repeat(32),
      cumulativeAmount: '5000',
      sequenceNumber: 0x8000_0001,
      ...overrides,
    },
    sessionPublicKey: new Uint8Array(32).fill(0x11),
    sessionSignature: new Uint8Array(64).fill(0x22),
    sessionRegistration: new Uint8Array(188).fill(0x33),
  };
}

function inputFor(signed = voucher()): FinalVoucherV2ReservationInput {
  return {
    network: 'solana:mainnet',
    programId: PROGRAM,
    buyerSwigAddress: BUYER_SWIG,
    vaultPda: VAULT,
    sessionPda: SESSION,
    seller: SELLER,
    channelId: signed.payload.channelId,
    sessionNonce: 0x8000_0007,
    reservationAmountAtomic: '5000',
    previousCumulativeAtomic: '0',
    ...finalVoucherV2ReservationIdentity(signed),
    voucher: signed,
  };
}

describe('FINAL V2 reservation identity and provider receipt', () => {
  it('matches the managed provider shared voucher-digest vector', () => {
    expect(finalVoucherV2Digest({
      payload: {
        channelId: '22'.repeat(32),
        cumulativeAmount: '125',
        sequenceNumber: 7,
      },
      sessionPublicKey: new Uint8Array(32).fill(0x33),
      sessionSignature: new Uint8Array(64).fill(0x44),
      sessionRegistration: new Uint8Array(188).fill(0x55),
    })).toBe(
      '23f9fad188b756d67627312638705c6d79eb46024b89a54baddeb53553fb2651',
    );
  });

  it('is deterministic and changes for every complete-voucher mutation', () => {
    const original = voucher();
    const originalDigest = finalVoucherV2Digest(original);
    const mutations: SignedVoucher[] = [
      voucher({ channelId: 'cd'.repeat(32) }),
      voucher({ cumulativeAmount: '5001' }),
      voucher({ sequenceNumber: 0x8000_0002 }),
      { ...original, sessionPublicKey: new Uint8Array(32).fill(0x12) },
      { ...original, sessionSignature: new Uint8Array(64).fill(0x23) },
      { ...original, sessionRegistration: new Uint8Array(188).fill(0x34) },
    ];

    expect(finalVoucherV2Digest(original)).toBe(originalDigest);
    for (const mutation of mutations) {
      expect(finalVoucherV2Digest(mutation)).not.toBe(originalDigest);
    }
  });

  it('accepts one exact complete receipt', () => {
    const input = inputFor();
    expect(() => assertFinalVoucherV2ReservationReceipt(
      input,
      finalizedReservationReceipt(input),
    )).not.toThrow();

    const concurrent = finalizedReservationReceipt(input);
    concurrent.pendingVoucherCountBefore = 3;
    concurrent.pendingVoucherCountAfter = 11;
    expect(() => assertFinalVoucherV2ReservationReceipt(
      input,
      concurrent,
    )).not.toThrow();

    const canonicalNetwork = finalizedReservationReceipt(input);
    canonicalNetwork.network = FINAL_VOUCHER_V2_SOLANA_MAINNET_CAIP2;
    expect(() => assertFinalVoucherV2ReservationReceipt(
      input,
      canonicalNetwork,
    )).not.toThrow();

    const providerOwnedIdentity = finalizedReservationReceipt(input);
    providerOwnedIdentity.providerReceiptId = 'native-tab-provider:attempt-2';
    expect(() => assertFinalVoucherV2ReservationReceipt(
      input,
      providerOwnedIdentity,
    )).not.toThrow();
  });

  it('has one golden domain-separated transaction binding', () => {
    const input = inputFor();
    const digest = finalVoucherV2ReservationBindingDigest(input);

    expect(digest).toBe(
      '733231daab9b8acadf9fc4922c4b5731b90a0c30f2ce1ee372b2b846136cf1b6',
    );
    expect(finalVoucherV2ReservationMemo(input)).toBe(
      `${FINAL_VOUCHER_V2_RESERVATION_MEMO_PREFIX}${digest}`,
    );
    expect(finalVoucherV2ReservationBindingDigest({
      ...input,
      network: FINAL_VOUCHER_V2_SOLANA_MAINNET_CAIP2 as never,
    })).toBe(digest);
  });

  it('matches the facilitator cross-repository reservation-binding vector', () => {
    expect(finalVoucherV2ReservationBindingDigestFromIdentity({
      network: FINAL_VOUCHER_V2_SOLANA_MAINNET_CAIP2,
      programId: 'BPFLoaderUpgradeab1e11111111111111111111111',
      buyerSwigAddress: '11111111111111111111111111111111',
      vaultPda: 'So11111111111111111111111111111111111111112',
      sessionPda: 'SysvarRent111111111111111111111111111111111',
      seller: 'Vote111111111111111111111111111111111111111',
      channelId: '0123456789abcdef'.repeat(4),
      sessionNonce: 2_147_483_655,
      reservationAmountAtomic: '1000000',
      previousCumulativeAtomic: '2500000',
      voucherDigest: 'ab'.repeat(32),
      cumulativeAmountAtomic: '3500000',
      sequenceNumber: 2_147_483_649,
    })).toBe(
      'a6e95b3ab368467f0fe72c1d4bfa5296bb6e49234905b84889a6b76a763cca5b',
    );
  });

  it('changes the transaction binding for every reservation or voucher mutation', () => {
    const input = inputFor();
    const original = finalVoucherV2ReservationBindingDigest(input);
    const changedVoucher = voucher({ cumulativeAmount: '5001' });
    const mutations: FinalVoucherV2ReservationInput[] = [
      { ...input, programId: key(6) },
      { ...input, buyerSwigAddress: key(7) },
      { ...input, vaultPda: key(8) },
      { ...input, sessionPda: key(9) },
      { ...input, seller: key(10) },
      { ...input, channelId: 'cd'.repeat(32) },
      { ...input, sessionNonce: input.sessionNonce + 1 },
      { ...input, reservationAmountAtomic: '4999' },
      { ...input, previousCumulativeAtomic: '1' },
      // The helper recomputes the complete voucher digest instead of trusting
      // the stale caller-supplied input.voucherDigest.
      { ...input, voucher: changedVoucher },
    ];

    for (const mutation of mutations) {
      expect(finalVoucherV2ReservationBindingDigest(mutation))
        .not.toBe(original);
    }
  });

  it('reuses the exact same binding for an exact-byte retry', () => {
    const input = inputFor();
    const retry: FinalVoucherV2ReservationInput = {
      ...input,
      voucher: {
        payload: { ...input.voucher.payload },
        sessionPublicKey: Uint8Array.from(input.voucher.sessionPublicKey),
        sessionSignature: Uint8Array.from(input.voucher.sessionSignature),
        sessionRegistration: Uint8Array.from(input.voucher.sessionRegistration),
      },
    };

    expect(finalVoucherV2ReservationBindingDigest(retry)).toBe(
      finalVoucherV2ReservationBindingDigest(input),
    );
    expect(finalVoucherV2ReservationMemo(retry)).toBe(
      finalVoucherV2ReservationMemo(input),
    );
  });

  it('rejects a boolean acknowledgement and every economic-identity mismatch', () => {
    const input = inputFor();
    expect(() => assertFinalVoucherV2ReservationReceipt(
      input,
      { armed: true } as unknown as FinalVoucherV2ReservationReceipt,
    )).toThrow(/native_tab_v2_reservation_receipt_invalid/);

    const base = finalizedReservationReceipt(input);
    const mutations: Array<Partial<FinalVoucherV2ReservationReceipt>> = [
      { contract: 'unknown' as never },
      { callerOperationId: 'other' },
      { network: 'solana:devnet' },
      { transaction: 'not-base58' },
      { commitment: 'confirmed' as never },
      { confirmationSlot: 0 },
      { postStateSlot: 99 },
      { buyerSwigAddress: SELLER },
      { vaultPda: SESSION },
      { sessionPda: VAULT },
      { seller: BUYER_SWIG },
      { channelId: 'cd'.repeat(32) },
      { sessionPublicKey: '12'.repeat(32) },
      { voucherDigest: 'ff'.repeat(32) },
      { cumulativeAmountAtomic: '5001' },
      { sequenceNumber: 0x8000_0002 },
      { providerReceiptId: 'bad receipt id!' },
      { reservationAmountAtomic: '4999' },
      { pendingVoucherCountBefore: -1 },
      { pendingVoucherCountAfter: 1.5 },
      { currentOutstandingBeforeAtomic: '1' as never },
      { currentOutstandingAfterAtomic: '4999' },
    ];
    for (const mutation of mutations) {
      expect(() => assertFinalVoucherV2ReservationReceipt(
        input,
        { ...base, ...mutation },
      )).toThrow(/native_tab_v2_reservation_receipt_invalid/);
    }
  });

  it('rejects a mismatched delta or non-FINAL voucher before inspecting receipt', () => {
    const good = inputFor();
    const badDelta = { ...good, reservationAmountAtomic: '4999' };
    expect(() => assertFinalVoucherV2ReservationReceipt(
      badDelta,
      finalizedReservationReceipt(badDelta),
    )).toThrow(/input_reservation_delta/);

    const nonFinal = inputFor(voucher({ sequenceNumber: 1 }));
    expect(() => assertFinalVoucherV2ReservationReceipt(
      nonFinal,
      finalizedReservationReceipt(nonFinal),
    )).toThrow(/input_voucher_identity/);
  });
});
