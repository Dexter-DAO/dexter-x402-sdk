import { describe, it, expect } from 'vitest';
import { computeFinalizableAt, WithdrawNotReadyError } from '../withdraw';

describe('computeFinalizableAt', () => {
  it('adds withdrawDelay to initiatedAt', () => {
    // initiatedAt = 1_700_000_000s, withdrawDelay = 900s
    expect(computeFinalizableAt(1_700_000_000, 900)).toBe(1_700_000_900);
  });

  it('returns 0 when no withdrawal is pending (initiatedAt 0)', () => {
    expect(computeFinalizableAt(0, 900)).toBe(0);
  });
});

describe('WithdrawNotReadyError', () => {
  it('is an Error with the correct name', () => {
    const e = new WithdrawNotReadyError('not yet');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('WithdrawNotReadyError');
  });
});
