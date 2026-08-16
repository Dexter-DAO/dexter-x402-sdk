// src/tab/__tests__/voucher-accounting.test.ts
/**
 * Voucher counter accounting on the Tab runtime:
 *
 *  1. `signNextVoucher` must commit `sequenceNumber` / `cumulativeAtomic`
 *     only AFTER `vault.signWithSession` resolves — a signing rejection
 *     must not leave a phantom increment that the next voucher silently
 *     absorbs.
 *
 *  2. `rollbackVoucher` (internal, not on the public Tab interface) must
 *     revert the counters and restore the previous `lastSignedVoucher`
 *     IFF the voucher being rolled back is exactly the most recent one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { openTab } from '../tab';
import type { Tab, VaultAdapter, SignedVoucher, VoucherPayload } from '../types';
import { sessionRegisterMessage } from '@dexterai/vault/messages';
import { DEXTER_VAULT_PROGRAM_ID } from '../instructions';

// Any valid base58 pubkeys — never hit on chain in these tests.
const SELLER_PUBKEY = 'DhP2eR7XGwsCFUxiYxkLBpzkmuyU1Cn9CGUVNkpBu1g7';
const VAULT_PUBKEY = '7S3P4HxJpyyigGzodYwHtCxZyUQe9JiBMHyRWXArAaKv';

/** Internal surface the tests reach past the public Tab interface for. */
type TabInternalsView = Tab & {
  rollbackVoucher(v: SignedVoucher): boolean;
  lastSignedVoucher: SignedVoucher | null;
};

function fakeSign(payload: VoucherPayload): SignedVoucher {
  return {
    payload,
    sessionPublicKey: new Uint8Array(32).fill(1),
    sessionRegistration: new Uint8Array(180).fill(2),
    sessionSignature: new Uint8Array(64).fill(3),
  };
}

function makeFakeAdapter(
  signWithSession?: VaultAdapter['signWithSession'],
): VaultAdapter {
  return {
    network: 'solana:mainnet',
    swigAddress: VAULT_PUBKEY,
    vaultPda: VAULT_PUBKEY,
    authorizeSession: async scope => ({
      publicKey: new Uint8Array(32).fill(1),
      privateKey: new Uint8Array(64).fill(9),
      scope,
      registration: new Uint8Array(180).fill(2),
    }),
    signWithSession:
      signWithSession ?? (async (_session, payload) => fakeSign(payload)),
    signOpenTab: async () => new Uint8Array(0),
    signCloseTab: async () => new Uint8Array(0),
  };
}

async function makeTab(adapter: VaultAdapter): Promise<TabInternalsView> {
  const tab = await openTab({
    vault: adapter,
    network: 'solana:mainnet',
    seller: SELLER_PUBKEY,
    perUnitCap: '0.005', // 5000 atomic
    totalCap: '5',
  });
  return tab as TabInternalsView;
}

function makeFakeV2Adapter() {
  const sessionPublicKey = new Uint8Array(32).fill(7);
  const authorizeSession = vi.fn(async (scope: Parameters<VaultAdapter['authorizeSession']>[0]) => {
    const registration = sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: new PublicKey(VAULT_PUBKEY),
      sessionPubkey: sessionPublicKey,
      maxAmount: BigInt(scope.maxAmountAtomic),
      expiresAt: BigInt(scope.expiresAtUnix),
      allowedCounterparty: new PublicKey(scope.allowedCounterparty),
      nonce: 0x8000_0007,
      maxRevolvingCapacity: BigInt(scope.revolvingCapacityAtomic!),
    });
    return {
      publicKey: sessionPublicKey,
      privateKey: new Uint8Array(64).fill(9),
      scope,
      registration,
    };
  });
  const adapter: VaultAdapter = {
    network: 'solana:mainnet',
    sessionVoucherVersion: 2,
    swigAddress: VAULT_PUBKEY,
    vaultPda: VAULT_PUBKEY,
    authorizeSession,
    signWithSession: async (session, payload) => ({
      payload: {
        ...payload,
        sequenceNumber: (payload.sequenceNumber | 0x8000_0000) >>> 0,
      },
      sessionPublicKey: session.publicKey,
      sessionRegistration: session.registration,
      sessionSignature: new Uint8Array(64).fill(3),
    }),
    signOpenTab: async () => new Uint8Array(0),
    signCloseTab: async () => new Uint8Array(0),
  };
  return { adapter, authorizeSession };
}

// armTabOpen is called by openTab after authorizeSession. Stub fetch to return
// a successful /tab/open arm response so tests that don't care about fetch
// (no settle, no external calls) still run cleanly.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ success: true, armed: true, signature: 'stub' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ));
});
afterEach(() => vi.unstubAllGlobals());

describe('Tab.signNextVoucher — commit only after signing', () => {
  it('requires the V2 reservation fence before creating an on-chain session', async () => {
    const { adapter, authorizeSession } = makeFakeV2Adapter();
    await expect(makeTab(adapter)).rejects.toThrow(
      /native_tab_v2_reservation_fence_required/,
    );
    expect(authorizeSession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('releases a V2 FINAL voucher only after the exact reservation callback', async () => {
    const { adapter } = makeFakeV2Adapter();
    const reserveFinalVoucherV2 = vi.fn(async () => ({ armed: true as const }));
    const tab = await openTab({
      vault: adapter,
      network: 'solana:mainnet',
      seller: SELLER_PUBKEY,
      perUnitCap: '0.005',
      totalCap: '5',
      reserveFinalVoucherV2,
    }) as TabInternalsView;
    expect(fetch).not.toHaveBeenCalled();

    const voucher = await tab.signNextVoucher('5000');
    expect(voucher.payload.sequenceNumber).toBe(0x8000_0001);
    expect(reserveFinalVoucherV2).toHaveBeenCalledWith(expect.objectContaining({
      buyerSwigAddress: VAULT_PUBKEY,
      vaultPda: VAULT_PUBKEY,
      seller: SELLER_PUBKEY,
      sessionNonce: 0x8000_0007,
      reservationAmountAtomic: '5000',
      previousCumulativeAtomic: '0',
      voucher,
    }));
    expect(tab.rollbackVoucher(voucher)).toBe(false);
  });

  it('rejects a V2 adapter registration that substitutes the buyer vault identity', async () => {
    const { adapter } = makeFakeV2Adapter();
    adapter.authorizeSession = async scope => {
      const sessionPublicKey = new Uint8Array(32).fill(7);
      return {
        publicKey: sessionPublicKey,
        privateKey: new Uint8Array(64).fill(9),
        scope,
        registration: sessionRegisterMessage({
          programId: DEXTER_VAULT_PROGRAM_ID,
          vaultPda: new PublicKey(SELLER_PUBKEY),
          sessionPubkey: sessionPublicKey,
          maxAmount: BigInt(scope.maxAmountAtomic),
          expiresAt: BigInt(scope.expiresAtUnix),
          allowedCounterparty: new PublicKey(scope.allowedCounterparty),
          nonce: 0x8000_0007,
          maxRevolvingCapacity: BigInt(scope.revolvingCapacityAtomic!),
        }),
      };
    };

    await expect(openTab({
      vault: adapter,
      network: 'solana:mainnet',
      seller: SELLER_PUBKEY,
      perUnitCap: '0.005',
      totalCap: '5',
      reserveFinalVoucherV2: async () => ({ armed: true }),
    })).rejects.toThrow('native_tab_v2_registration_identity_mismatch');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves the counter unchanged when signWithSession rejects, and the next attempt reproduces the same voucher', async () => {
    const sign = vi
      .fn<VaultAdapter['signWithSession']>()
      .mockRejectedValueOnce(new Error('signer offline'))
      .mockImplementation(async (_session, payload) => fakeSign(payload));
    const tab = await makeTab(makeFakeAdapter(sign));

    await expect(tab.signNextVoucher('5000')).rejects.toThrow('signer offline');

    // No phantom increment: counters untouched, no voucher recorded.
    expect(tab.state.spent).toBe('0');
    expect(tab.lastSignedVoucher).toBeNull();

    // The retry produces EXACTLY what the failed attempt would have —
    // sequence 1, cumulative 5000 — not 2/10000 with a phantom fold-in.
    const signed = await tab.signNextVoucher('5000');
    expect(signed.payload.sequenceNumber).toBe(1);
    expect(signed.payload.cumulativeAmount).toBe('5000');
    expect(tab.state.spent).toBe('0.005');
  });

  it('still enforces scope caps BEFORE signing (no signer call on cap_exceeded)', async () => {
    const sign = vi
      .fn<VaultAdapter['signWithSession']>()
      .mockImplementation(async (_session, payload) => fakeSign(payload));
    const tab = await makeTab(makeFakeAdapter(sign));

    // perUnitCap is 5000 atomic — 6000 must throw without touching the signer.
    await expect(tab.signNextVoucher('6000')).rejects.toThrow('perUnitCap');
    expect(sign).not.toHaveBeenCalled();
    expect(tab.state.spent).toBe('0');
  });
});

describe('Tab.rollbackVoucher — internal honest-refusal rollback', () => {
  it('reverts counters and restores the previous lastSignedVoucher', async () => {
    const tab = await makeTab(makeFakeAdapter());

    const first = await tab.signNextVoucher('5000'); // seq 1, cum 5000
    const second = await tab.signNextVoucher('5000'); // seq 2, cum 10000

    expect(tab.rollbackVoucher(second)).toBe(true);

    expect(tab.lastSignedVoucher).toBe(first);
    expect(tab.state.spent).toBe('0.005');

    // The reissued voucher reuses the rolled-back sequence/cumulative.
    const reissued = await tab.signNextVoucher('5000');
    expect(reissued.payload.sequenceNumber).toBe(second.payload.sequenceNumber);
    expect(reissued.payload.cumulativeAmount).toBe(second.payload.cumulativeAmount);
  });

  it('rolls a first-and-only voucher back to the pristine state', async () => {
    const tab = await makeTab(makeFakeAdapter());

    const first = await tab.signNextVoucher('5000');
    expect(tab.rollbackVoucher(first)).toBe(true);

    expect(tab.lastSignedVoucher).toBeNull();
    expect(tab.state.spent).toBe('0');
  });

  it('refuses to roll back anything but the exact most recent voucher', async () => {
    const tab = await makeTab(makeFakeAdapter());

    const first = await tab.signNextVoucher('5000');
    const second = await tab.signNextVoucher('5000');
    const third = await tab.signNextVoucher('5000');

    // Stale voucher: not the most recent — no-op.
    expect(tab.rollbackVoucher(first)).toBe(false);
    expect(tab.rollbackVoucher(second)).toBe(false);
    expect(tab.lastSignedVoucher).toBe(third);
    expect(tab.state.spent).toBe('0.015');

    // Only one level of history: a second consecutive rollback past it refuses
    // (second is seq 2 — its pre-state is unknown once history is consumed).
    expect(tab.rollbackVoucher(third)).toBe(true);
    expect(tab.rollbackVoucher(second)).toBe(false);
    expect(tab.lastSignedVoucher).toBe(second);
    expect(tab.state.spent).toBe('0.01');
  });
});
