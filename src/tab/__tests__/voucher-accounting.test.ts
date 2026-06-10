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
import { describe, it, expect, vi } from 'vitest';
import { openTab } from '../tab';
import type { Tab, VaultAdapter, SignedVoucher, VoucherPayload } from '../types';

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

describe('Tab.signNextVoucher — commit only after signing', () => {
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
