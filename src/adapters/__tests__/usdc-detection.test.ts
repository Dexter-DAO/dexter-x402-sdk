import { describe, it, expect } from 'vitest';
import { isKnownUSDC, USDC_ADDRESSES } from '../index';

describe('isKnownUSDC', () => {
  it('recognizes Solana mainnet USDC', () => {
    expect(isKnownUSDC('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
  });

  it('recognizes Solana devnet USDC', () => {
    expect(isKnownUSDC('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')).toBe(true);
  });

  it('recognizes Base mainnet USDC', () => {
    expect(isKnownUSDC('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(true);
  });

  it('recognizes all EVM USDC addresses from the registry', () => {
    for (const [chain, addr] of Object.entries(USDC_ADDRESSES)) {
      expect(isKnownUSDC(addr)).toBe(true);
    }
  });

  it('is case-insensitive for EVM addresses', () => {
    expect(isKnownUSDC('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBe(true);
    expect(isKnownUSDC('0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913')).toBe(true);
  });

  it('rejects unknown addresses', () => {
    expect(isKnownUSDC('0x0000000000000000000000000000000000000000')).toBe(false);
    expect(isKnownUSDC('SomeRandomSolanaAddress1111111111111111111')).toBe(false);
    expect(isKnownUSDC('')).toBe(false);
  });
});
