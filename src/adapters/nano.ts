/**
 * Nano Chain Adapter
 *
 * Implements the ChainAdapter interface for the Nano (XNO) network.
 *
 * Nano has no facilitator and no fee payer: a payment is a single send block
 * the buyer's own wallet publishes. The SDK therefore never holds a key — the
 * caller injects a {@link NanoWallet} whose `send` publishes the block and
 * returns its hash. The PAYMENT-SIGNATURE payload carries that hash, and
 * anyone (merchant, buyer, auditor) can check it against the ledger with one
 * `block_info` RPC call — see {@link NanoAdapter.confirmSettlement}.
 *
 * Opt-in: this adapter is not part of `createDefaultAdapters()`.
 *
 * @example
 * ```typescript
 * import { createX402Client } from '@dexterai/x402/client';
 * import { createSolanaAdapter, createEvmAdapter, createNanoAdapter, NANO_MAINNET } from '@dexterai/x402/adapters';
 *
 * const client = createX402Client({
 *   adapters: [
 *     createSolanaAdapter(),
 *     createEvmAdapter(),
 *     createNanoAdapter({ rpcUrls: { [NANO_MAINNET]: 'https://your-nano-node.example/rpc' } }),
 *   ],
 *   wallets: { nano: myNanoWallet },
 * });
 * ```
 */

import { blake2b } from '@noble/hashes/blake2b';
import { exactPaymentCapabilityError } from '../payment/exact-capability';
import type {
  ChainAdapter,
  AdapterConfig,
  SignedTransaction,
  SettlementProbe,
  SettlementConfirmation,
} from './types';
import type { PaymentAccept } from '../types';

/** CAIP-2-style network identifier for Nano mainnet. */
export const NANO_MAINNET = 'nano:mainnet';

/** Asset identifier for the native XNO token in a payment requirement. */
export const NANO_ASSET = 'XNO';

/** XNO has 30 decimals: 1 XNO = 10^30 raw. */
export const NANO_DECIMALS = 30;

const RAW_PER_XNO = 10n ** BigInt(NANO_DECIMALS);

/** Nano's base32 alphabet (no 0, 2, l, v). */
const NANO_ALPHABET = '13456789abcdefghijkmnopqrstuwxyz';

const ADDRESS_PATTERN = /^(nano|xrb)_([13][13456789abcdefghijkmnopqrstuwxyz]{51})([13456789abcdefghijkmnopqrstuwxyz]{8})$/;
const BLOCK_HASH_PATTERN = /^[0-9A-Fa-f]{64}$/;

/**
 * Nano wallet interface.
 *
 * The SDK never sees a seed or private key. `send` must publish a state send
 * block moving exactly `amountRaw` to `to`, and resolve with its block hash
 * (64 hex chars) once the block has been accepted by the node it was
 * published to.
 */
export interface NanoWallet {
  /** The paying account (`nano_...`). */
  address: string;
  /** Publish a send block and return its hash. */
  send(params: { to: string; amountRaw: bigint }): Promise<string>;
  /** Optional spendable balance in raw; when absent the adapter asks the RPC. */
  getBalanceRaw?(): Promise<bigint>;
}

/**
 * Nano adapter configuration.
 *
 * There is deliberately no built-in default node: pass the node you trust
 * via `rpcUrls[NANO_MAINNET]` (or the client's `rpcUrls`).
 */
export interface NanoAdapterConfig extends AdapterConfig {
  /** Custom fetch used for node RPC calls (defaults to the global fetch). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Check if an object is a valid Nano wallet
 */
export function isNanoWallet(wallet: unknown): wallet is NanoWallet {
  if (!wallet || typeof wallet !== 'object') return false;
  const w = wallet as Record<string, unknown>;
  return (
    typeof w.address === 'string' &&
    isValidNanoAddress(w.address) &&
    typeof w.send === 'function'
  );
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function base32ToBigInt(chars: string): bigint {
  let value = 0n;
  for (const ch of chars) value = (value << 5n) | BigInt(NANO_ALPHABET.indexOf(ch));
  return value;
}

function bigIntToBase32(value: bigint, length: number): string {
  let out = '';
  for (let i = length - 1; i >= 0; i--) {
    out += NANO_ALPHABET[Number((value >> BigInt(5 * i)) & 31n)];
  }
  return out;
}

/** The 5-byte address checksum: blake2b-40 of the public key, byte-reversed. */
function addressChecksum(publicKey: Uint8Array): bigint {
  return bytesToBigInt(blake2b(publicKey, { dkLen: 5 }).reverse());
}

/**
 * Decode a `nano_`/`xrb_` address to its 32-byte public key, or `null` if the
 * address is malformed or its checksum does not match.
 */
export function nanoAddressToPublicKey(address: string): Uint8Array | null {
  const match = ADDRESS_PATTERN.exec(address);
  if (!match) return null;
  // 52 chars = 260 bits: 4 zero padding bits, then the 256-bit key.
  const keyValue = base32ToBigInt(match[2]);
  if (keyValue >> 256n !== 0n) return null;
  const publicKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    publicKey[i] = Number((keyValue >> BigInt(8 * (31 - i))) & 0xffn);
  }
  if (addressChecksum(publicKey) !== base32ToBigInt(match[3])) return null;
  return publicKey;
}

/** Encode a 32-byte public key as a `nano_` address. */
export function publicKeyToNanoAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('Nano public key must be 32 bytes');
  return `nano_${bigIntToBase32(bytesToBigInt(publicKey), 52)}${bigIntToBase32(addressChecksum(publicKey), 8)}`;
}

/** True for a well-formed `nano_`/`xrb_` address with a valid checksum. */
export function isValidNanoAddress(address: string): boolean {
  return nanoAddressToPublicKey(address) !== null;
}

/** Two addresses name the same account (prefix-insensitive). */
function sameNanoAccount(a: string, b: string): boolean {
  const ka = nanoAddressToPublicKey(a);
  const kb = nanoAddressToPublicKey(b);
  if (!ka || !kb) return false;
  return ka.every((byte, i) => byte === kb[i]);
}

/**
 * Convert a decimal XNO amount (e.g. `'0.001'`) to raw.
 * Throws on anything that is not a plain non-negative decimal with at most
 * 30 fractional digits — no floats, no rounding.
 */
export function xnoToRaw(xno: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,30}))?$/.exec(xno);
  if (!match) throw new Error(`Invalid XNO amount: ${xno}`);
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(NANO_DECIMALS, '0'));
  return whole * RAW_PER_XNO + fraction;
}

/** Convert raw to a decimal XNO string without trailing zeros. */
export function rawToXno(raw: bigint): string {
  if (raw < 0n) throw new Error('Raw amount must be non-negative');
  const whole = raw / RAW_PER_XNO;
  const fraction = (raw % RAW_PER_XNO).toString().padStart(NANO_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function parseRaw(value: string | undefined, field: string): bigint {
  if (!value || !/^\d+$/.test(value)) throw new Error(`Invalid raw ${field}: ${String(value)}`);
  return BigInt(value);
}

/**
 * Nano Chain Adapter
 */
export class NanoAdapter implements ChainAdapter {
  readonly name = 'Nano';
  readonly family = 'nano' as const;
  readonly networks = [NANO_MAINNET];

  private config: NanoAdapterConfig;
  private log: (...args: unknown[]) => void;

  constructor(config: NanoAdapterConfig = {}) {
    this.config = config;
    this.log = config.verbose
      ? console.log.bind(console, '[x402:nano]')
      : () => {};
  }

  canHandle(network: string): boolean {
    return this.networks.includes(network);
  }

  /**
   * The configured node for `network`, or `''` when none is configured.
   * Calls that need the node throw on an empty URL.
   */
  getDefaultRpcUrl(network: string): string {
    return this.config.rpcUrls?.[network] ?? '';
  }

  getAddress(wallet: unknown): string | null {
    if (!isNanoWallet(wallet)) return null;
    return wallet.address;
  }

  isConnected(wallet: unknown): boolean {
    return isNanoWallet(wallet);
  }

  async getBalance(
    accept: PaymentAccept,
    wallet: unknown,
    rpcUrl?: string
  ): Promise<number> {
    if (!isNanoWallet(wallet)) {
      return 0;
    }
    let raw: bigint;
    if (wallet.getBalanceRaw) {
      raw = await wallet.getBalanceRaw();
    } else {
      const result = await this.rpc(rpcUrl || this.getDefaultRpcUrl(accept.network), {
        action: 'account_balance',
        account: wallet.address,
      });
      raw = parseRaw(result.balance as string | undefined, 'balance');
    }
    return Number(rawToXno(raw));
  }

  async buildTransaction(
    accept: PaymentAccept,
    wallet: unknown,
    _rpcUrl?: string
  ): Promise<SignedTransaction> {
    const unsupported = exactPaymentCapabilityError(accept, 'nano');
    if (unsupported) throw new Error(unsupported);
    if (!isNanoWallet(wallet)) {
      throw new Error('Invalid Nano wallet');
    }
    if (!this.canHandle(accept.network)) {
      throw new Error(`Unsupported Nano network: ${accept.network}`);
    }
    if (accept.asset !== NANO_ASSET) {
      throw new Error(`Unsupported Nano asset: ${accept.asset}`);
    }
    if (!isValidNanoAddress(accept.payTo)) {
      throw new Error(`Invalid Nano payTo address: ${accept.payTo}`);
    }
    const amount = accept.amount ?? accept.maxAmountRequired;
    const amountRaw = parseRaw(amount, 'amount');
    if (amountRaw === 0n) {
      throw new Error('Nano payment amount must be greater than zero');
    }

    this.log('Sending:', { from: wallet.address, to: accept.payTo, amountRaw: amountRaw.toString() });

    const blockHash = await wallet.send({ to: accept.payTo, amountRaw });
    if (typeof blockHash !== 'string' || !BLOCK_HASH_PATTERN.test(blockHash)) {
      throw new Error(`Nano wallet returned an invalid block hash: ${String(blockHash)}`);
    }
    const hash = blockHash.toUpperCase();

    return {
      serialized: JSON.stringify({ blockHash: hash, account: wallet.address }),
      signature: hash,
      settlementProbe: {
        kind: 'nano',
        blockHash: hash,
        payTo: accept.payTo,
        amount: amountRaw.toString(),
      },
    };
  }

  /**
   * Confirm a Nano payment with a single `block_info` call.
   *
   * Settled means: the block is a confirmed state send block whose
   * destination (`link_as_account`) is the probe's `payTo` and whose amount
   * is at least the required raw amount. A block that exists but is the
   * wrong kind, goes elsewhere, or moves too little is a definitive
   * `{ settled: false }`. An RPC error (including an unknown block) or a
   * matching block that is not yet confirmed throws — the outcome is unknown.
   */
  async confirmSettlement(
    probe: SettlementProbe,
    rpcUrl: string,
  ): Promise<SettlementConfirmation> {
    if (probe.kind !== 'nano') {
      throw new Error(
        `NanoAdapter.confirmSettlement cannot handle probe kind "${probe.kind}"`,
      );
    }

    const info = await this.rpc(rpcUrl, {
      action: 'block_info',
      json_block: 'true',
      hash: probe.blockHash,
    });
    const contents = (info.contents ?? {}) as Record<string, unknown>;

    if (contents.type !== 'state' || info.subtype !== 'send') {
      return { settled: false };
    }
    if (typeof contents.link_as_account !== 'string'
      || !sameNanoAccount(contents.link_as_account, probe.payTo)) {
      return { settled: false };
    }
    if (parseRaw(info.amount as string | undefined, 'amount') < BigInt(probe.amount)) {
      return { settled: false };
    }
    if (info.confirmed !== 'true' && info.confirmed !== true) {
      throw new Error(`Nano block ${probe.blockHash} is not yet confirmed`);
    }
    return { settled: true, txSignature: probe.blockHash };
  }

  /** One node RPC call. Throws on HTTP or RPC error. */
  private async rpc(rpcUrl: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!rpcUrl) {
      throw new Error(`No Nano RPC URL configured for ${NANO_MAINNET}`);
    }
    const doFetch = this.config.fetch ?? globalThis.fetch;
    const response = await doFetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`RPC request failed: ${response.status}`);
    }
    const result = (await response.json()) as Record<string, unknown> | null;
    if (!result || typeof result !== 'object') {
      throw new Error('RPC returned an empty result');
    }
    if (result.error) {
      throw new Error(`RPC error: ${JSON.stringify(result.error)}`);
    }
    return result;
  }
}

/**
 * Create a Nano adapter instance
 */
export function createNanoAdapter(config?: NanoAdapterConfig): NanoAdapter {
  return new NanoAdapter(config);
}
