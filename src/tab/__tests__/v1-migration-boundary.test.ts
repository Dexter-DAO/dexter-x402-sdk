import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

import { tabFromGrant } from '../from-grant';
import { openTab } from '../tab';
import {
  HistoricalV1MigrationRequiredError,
  type VaultAdapter,
} from '../types';

const SELLER = Keypair.generate().publicKey.toBase58();
const VAULT = Keypair.generate().publicKey.toBase58();

describe('historical V1 buyer migration boundary', () => {
  it('openTab rejects V1 before session authorization or network activity', async () => {
    const authorizeSession = vi.fn<VaultAdapter['authorizeSession']>();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = {
      network: 'solana:mainnet',
      swigAddress: VAULT,
      vaultPda: VAULT,
      sessionVoucherVersion: 1,
      authorizeSession,
      signWithSession: vi.fn(),
      signOpenTab: vi.fn(),
      signCloseTab: vi.fn(),
    } satisfies VaultAdapter;

    const result = openTab({
      vault: adapter,
      network: 'solana:mainnet',
      seller: SELLER,
      perUnitCap: '0.01',
      totalCap: '1',
    });
    await expect(result).rejects.toBeInstanceOf(
      HistoricalV1MigrationRequiredError,
    );
    await expect(result).rejects.toThrow(/native_tab_v1_migration_required/);
    expect(authorizeSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('tabFromGrant rejects a low-bit V1 grant before RPC or fetch', async () => {
    const session = nacl.sign.keyPair();
    const getAccountInfo = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = tabFromGrant({
      sessionSecretKey: session.secretKey,
      params: {
        counterparty: SELLER,
        sessionPubkey: Keypair.generate().publicKey.toBase58(),
        maxAmountAtomic: '1000000',
        expiresAtUnix: 2_000_000_000,
        nonce: 42,
        maxRevolvingCapacityAtomic: '1000000',
      },
      vaultPda: VAULT,
      connection: { getAccountInfo } as never,
      swigAddress: VAULT,
      perUnitCapAtomic: '5000',
    });
    await expect(result).rejects.toBeInstanceOf(
      HistoricalV1MigrationRequiredError,
    );
    await expect(result).rejects.toThrow(/native_tab_v1_migration_required/);
    expect(getAccountInfo).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
