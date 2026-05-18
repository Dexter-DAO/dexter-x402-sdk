/**
 * Two-way map between CAIP-2 network identifiers (x402 v2) and bare
 * network names (x402 v1). The verifier's old bug was a one-way, lossy
 * rewrite to bare names. This map is lossless: a NetworkRef always
 * carries BOTH forms, so a v1 signer can use the bare name internally
 * while the wire payload keeps whatever the merchant advertised.
 */
import type { NetworkRef } from './types';

interface Entry {
  caip2: string;
  bare: string;
  family: 'evm' | 'svm';
}

// Canonical mainnet networks. Extend as the facilitator adds chains.
const ENTRIES: Entry[] = [
  { caip2: 'eip155:8453',  bare: 'base',      family: 'evm' },
  { caip2: 'eip155:1',     bare: 'ethereum',  family: 'evm' },
  { caip2: 'eip155:137',   bare: 'polygon',   family: 'evm' },
  { caip2: 'eip155:42161', bare: 'arbitrum',  family: 'evm' },
  { caip2: 'eip155:10',    bare: 'optimism',  family: 'evm' },
  { caip2: 'eip155:43114', bare: 'avalanche', family: 'evm' },
  { caip2: 'eip155:56',    bare: 'bsc',       family: 'evm' },
  {
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    bare: 'solana',
    family: 'svm',
  },
];

const byCaip2 = new Map(ENTRIES.map((e) => [e.caip2.toLowerCase(), e]));
const byBare = new Map(ENTRIES.map((e) => [e.bare.toLowerCase(), e]));

/**
 * Resolve any network string — CAIP-2 or bare — to a NetworkRef.
 * Returns null when the network is not recognised.
 */
export function toNetworkRef(network: string): NetworkRef | null {
  if (!network) return null;
  const key = network.toLowerCase();
  const entry =
    byCaip2.get(key) ||
    byBare.get(key) ||
    // CAIP-2 EVM with an unmapped chain id still resolves to evm family.
    (key.startsWith('eip155:')
      ? { caip2: network, bare: key, family: 'evm' as const }
      : key.startsWith('solana:')
        ? { caip2: network, bare: 'solana', family: 'svm' as const }
        : undefined);
  if (!entry) return null;
  return { caip2: entry.caip2, bare: entry.bare, family: entry.family };
}
