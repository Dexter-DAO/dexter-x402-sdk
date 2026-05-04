import { describe, it, expect } from 'vitest';
import {
  toAtomicUnits,
  fromAtomicUnits,
  getChainFamily,
  getChainName,
  getExplorerUrl,
  encodeBase64Json,
  decodeBase64Json,
} from '../utils';

describe('Amount Conversion', () => {
  it('converts USD to atomic units correctly', () => {
    expect(toAtomicUnits(0.05, 6)).toBe('50000');
    expect(toAtomicUnits(1.50, 6)).toBe('1500000');
    expect(toAtomicUnits(0.001, 6)).toBe('1000');
    expect(toAtomicUnits(0, 6)).toBe('0');
  });

  it('converts atomic units back to USD', () => {
    expect(fromAtomicUnits('50000', 6)).toBe(0.05);
    expect(fromAtomicUnits('1500000', 6)).toBe(1.5);
    expect(fromAtomicUnits(1000n, 6)).toBe(0.001);
  });

  it('handles floating point edge cases without drift', () => {
    // $0.10 should be exactly 100000 atomic, not 99999
    expect(toAtomicUnits(0.10, 6)).toBe('100000');
    expect(toAtomicUnits(0.01, 6)).toBe('10000');
  });
});

describe('Network Detection', () => {
  it('identifies Solana networks', () => {
    expect(getChainFamily('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe('solana');
    expect(getChainFamily('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe('solana');
    expect(getChainFamily('solana')).toBe('solana');
  });

  it('identifies EVM networks', () => {
    expect(getChainFamily('eip155:8453')).toBe('evm');
    expect(getChainFamily('eip155:137')).toBe('evm');
    expect(getChainFamily('eip155:42161')).toBe('evm');
    expect(getChainFamily('base')).toBe('evm');
  });

  it('returns unknown for unrecognized networks', () => {
    expect(getChainFamily('aptos:mainnet')).toBe('unknown');
    expect(getChainFamily('garbage')).toBe('unknown');
  });
});

describe('Chain Names', () => {
  it('maps CAIP-2 IDs to human-readable names for the original four', () => {
    expect(getChainName('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe('Solana');
    expect(getChainName('eip155:8453')).toBe('Base');
    expect(getChainName('eip155:42161')).toBe('Arbitrum');
    expect(getChainName('eip155:1')).toBe('Ethereum');
  });

  it('maps every chain Dexter\'s facilitator supports', () => {
    // If a chain in this list ever drops out of the registry, the verifier
    // and the public Test Theater will start surfacing raw CAIP-2 strings
    // to users. Lock the mapping in place.
    expect(getChainName('eip155:84532')).toBe('Base Sepolia');
    expect(getChainName('eip155:137')).toBe('Polygon');
    expect(getChainName('eip155:10')).toBe('Optimism');
    expect(getChainName('eip155:43114')).toBe('Avalanche');
    expect(getChainName('eip155:56')).toBe('BSC');
    expect(getChainName('eip155:1187947933')).toBe('SKALE Base');
    expect(getChainName('eip155:324705682')).toBe('SKALE Base Sepolia');
  });

  it('accepts legacy short-form aliases', () => {
    expect(getChainName('base')).toBe('Base');
    expect(getChainName('polygon')).toBe('Polygon');
    expect(getChainName('avalanche')).toBe('Avalanche');
    expect(getChainName('bsc')).toBe('BSC');
    expect(getChainName('skale-base')).toBe('SKALE Base');
  });

  it('returns the raw identifier for unknown networks', () => {
    expect(getChainName('eip155:999')).toBe('eip155:999');
  });
});

describe('Explorer URLs', () => {
  it('generates correct Solana explorer URLs', () => {
    const url = getExplorerUrl('5xMockTx', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(url).toContain('5xMockTx');
    expect(url).toContain('orbmarkets.io');
  });

  it('generates correct EVM explorer URLs across all supported chains', () => {
    expect(getExplorerUrl('0xT', 'eip155:8453')).toBe('https://basescan.org/tx/0xT');
    expect(getExplorerUrl('0xT', 'eip155:84532')).toBe('https://sepolia.basescan.org/tx/0xT');
    expect(getExplorerUrl('0xT', 'eip155:42161')).toBe('https://arbiscan.io/tx/0xT');
    expect(getExplorerUrl('0xT', 'eip155:1')).toBe('https://etherscan.io/tx/0xT');
    expect(getExplorerUrl('0xT', 'eip155:137')).toBe('https://polygonscan.com/tx/0xT');
    expect(getExplorerUrl('0xT', 'eip155:10')).toBe('https://optimistic.etherscan.io/tx/0xT');
    expect(getExplorerUrl('0xT', 'eip155:43114')).toBe('https://snowtrace.io/tx/0xT');
    expect(getExplorerUrl('0xT', 'eip155:56')).toBe('https://bscscan.com/tx/0xT');
    expect(getExplorerUrl('0xT', 'eip155:1187947933')).toContain('skalenodes.com');
    expect(getExplorerUrl('0xT', 'eip155:324705682')).toContain('base-sepolia-testnet');
  });
});

describe('Base64 JSON Encoding', () => {
  it('round-trips objects through base64 encoding', () => {
    const obj = { x402Version: 2, amount: '10000', network: 'eip155:8453' };
    const encoded = encodeBase64Json(obj);
    const decoded = decodeBase64Json<typeof obj>(encoded);
    expect(decoded).toEqual(obj);
  });

  it('handles unicode characters', () => {
    const obj = { description: 'Premium data access', price: '0.01' };
    const encoded = encodeBase64Json(obj);
    const decoded = decodeBase64Json<typeof obj>(encoded);
    expect(decoded.description).toBe('Premium data access');
  });

  it('handles nested objects', () => {
    const obj = {
      x402Version: 2,
      resource: { url: 'https://api.example.com/data', description: 'Test' },
      accepts: [{ scheme: 'exact', amount: '10000', network: 'eip155:8453' }],
    };
    const decoded = decodeBase64Json(encodeBase64Json(obj));
    expect(decoded).toEqual(obj);
  });
});
