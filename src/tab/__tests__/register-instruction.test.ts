/**
 * register_session_key construction — invokes the REAL @dexterai/vault
 * builder through the adapter's arg-construction path.
 *
 * Why this exists: vault 0.4.2 added two required accounts (swig +
 * vault_usdc_ata) to register_session_key and the adapter call site wasn't
 * updated — 282 tests stayed green because nothing invoked the real
 * builder, and openTab would have crashed at runtime. These tests pin the
 * builder's account list so the NEXT vault account-list bump fails loudly
 * here (and in the DTS build) instead of on mainnet.
 */

import { describe, test, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

import { buildAdapterRegisterInstruction } from '../adapters/solana/index';
import {
  deriveSwigWalletAddress,
  DEXTER_VAULT_PROGRAM_ID,
  INSTRUCTIONS_SYSVAR_ID,
} from '../instructions';
import { USDC_MINT } from '../../constants';

// Fixtures. The swig is the live-chain demo's buyer Swig STATE account
// (examples/live-chain/README.md) — a real Swig-program-owned account, so
// the wallet-PDA + ATA derivation below mirrors production exactly.
const SWIG = new PublicKey('E6iBgjoqBo1V53KUxGnWA6gSq6Ywc6Xui9fZMwLAYCdH');
const VAULT_PDA = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const COUNTERPARTY = new PublicKey('Ed25519SigVerify111111111111111111111111111');

const buildIx = () =>
  buildAdapterRegisterInstruction({
    vaultPda: VAULT_PDA,
    swigAddress: SWIG,
    sessionPubkey: new Uint8Array(32).fill(0xaa),
    maxAmount: 1_000_000n,
    maxRevolvingCapacity: 2_000_000n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    allowedCounterparty: COUNTERPARTY,
    nonce: 42,
    clientDataJSON: new Uint8Array([1, 2, 3]),
    authenticatorData: new Uint8Array(37).fill(0xbb),
  });

describe('buildAdapterRegisterInstruction (real vault builder)', () => {
  test('builds against the vault program with the 0.4.2 5-account list', () => {
    const ix = buildIx();
    expect(ix.programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    // CANARY: if the vault program's register_session_key account list
    // changes again, this count (and the order checks below) must be
    // revisited along with the adapter's arg construction.
    expect(ix.keys).toHaveLength(5);
  });

  test('account order matches the on-chain Anchor struct', () => {
    const ix = buildIx();
    const swigWallet = deriveSwigWalletAddress(SWIG);
    const expectedAta = getAssociatedTokenAddressSync(
      new PublicKey(USDC_MINT),
      swigWallet,
      true,
    );

    // [0] vault (writable)
    expect(ix.keys[0].pubkey.equals(VAULT_PDA)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    // [1] vault_usdc_ata — swig WALLET's USDC ATA (overcommit gate read)
    expect(ix.keys[1].pubkey.equals(expectedAta)).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    // [2] swig — the STATE account, passed through verbatim
    expect(ix.keys[2].pubkey.equals(SWIG)).toBe(true);
    // [3] swig_wallet_address — derived by the builder from the state account
    expect(ix.keys[3].pubkey.equals(swigWallet)).toBe(true);
    // [4] instructions sysvar
    expect(ix.keys[4].pubkey.equals(INSTRUCTIONS_SYSVAR_ID)).toBe(true);
  });

  test('ATA owner is the derived wallet PDA, not the swig state account', () => {
    // The classic mixup: deriving the ATA off the state account would
    // build fine but fail on chain. Pin that they differ.
    const wrongAta = getAssociatedTokenAddressSync(
      new PublicKey(USDC_MINT),
      SWIG,
      true,
    );
    const ix = buildIx();
    expect(ix.keys[1].pubkey.equals(wrongAta)).toBe(false);
  });
});
