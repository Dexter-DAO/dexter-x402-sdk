import { describe, it, expect } from 'vitest';
import { toNetworkRef } from '../network-map';

describe('toNetworkRef', () => {
  it('resolves a CAIP-2 EVM string', () => {
    const r = toNetworkRef('eip155:8453');
    expect(r).toEqual({ caip2: 'eip155:8453', bare: 'base', family: 'evm' });
  });

  it('resolves a bare EVM name', () => {
    const r = toNetworkRef('base');
    expect(r).toEqual({ caip2: 'eip155:8453', bare: 'base', family: 'evm' });
  });

  it('resolves a CAIP-2 Solana string', () => {
    const r = toNetworkRef('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(r?.bare).toBe('solana');
    expect(r?.family).toBe('svm');
  });

  it('resolves the bare solana name', () => {
    const r = toNetworkRef('solana');
    expect(r?.family).toBe('svm');
  });

  it('returns null for an unknown network', () => {
    expect(toNetworkRef('dogecoin')).toBeNull();
  });
});
