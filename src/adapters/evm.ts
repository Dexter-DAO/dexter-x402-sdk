/**
 * EVM Chain Adapter
 *
 * Implements the ChainAdapter interface for EVM networks (Base, Ethereum, Arbitrum, etc.)
 * Uses EIP-712 typed data signing for x402 v2 payments.
 */

import type { ChainAdapter, AdapterConfig, SignedTransaction } from './types';
import type { PaymentAccept } from '../types';

/**
 * CAIP-2 network identifiers for EVM chains
 */
export const BASE_MAINNET = 'eip155:8453';
export const BASE_SEPOLIA = 'eip155:84532';
export const ETHEREUM_MAINNET = 'eip155:1';
export const ARBITRUM_ONE = 'eip155:42161';

/**
 * Chain IDs by CAIP-2 network
 */
const CHAIN_IDS: Record<string, number> = {
  [BASE_MAINNET]: 8453,
  [BASE_SEPOLIA]: 84532,
  [ETHEREUM_MAINNET]: 1,
  [ARBITRUM_ONE]: 42161,
};

/**
 * Default RPC URLs
 */
const DEFAULT_RPC_URLS: Record<string, string> = {
  [BASE_MAINNET]: 'https://mainnet.base.org',
  [BASE_SEPOLIA]: 'https://sepolia.base.org',
  [ETHEREUM_MAINNET]: 'https://eth.llamarpc.com',
  [ARBITRUM_ONE]: 'https://arb1.arbitrum.io/rpc',
};

/**
 * USDC addresses by chain (for reference)
 */
export const USDC_ADDRESSES: Record<string, string> = {
  [BASE_MAINNET]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  [ETHEREUM_MAINNET]: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  [ARBITRUM_ONE]: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
};

/**
 * EVM wallet interface (compatible with wagmi, ethers, viem)
 */
export interface EvmWallet {
  /** Wallet address */
  address: string;
  /** Chain ID currently connected to */
  chainId?: number;
  /**
   * Sign typed data (EIP-712)
   * This is the primary signing method for x402 EVM payments
   */
  signTypedData?(params: {
    domain: Record<string, unknown>;
    types: Record<string, unknown[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<string>;
  /**
   * Alternative: Send transaction directly
   * Used if signTypedData is not available
   */
  sendTransaction?(params: {
    to: string;
    data: string;
    value?: bigint;
  }): Promise<string>;
}

/**
 * Check if an object is a valid EVM wallet
 */
export function isEvmWallet(wallet: unknown): wallet is EvmWallet {
  if (!wallet || typeof wallet !== 'object') return false;
  const w = wallet as Record<string, unknown>;
  return (
    'address' in w &&
    typeof w.address === 'string' &&
    w.address.startsWith('0x')
  );
}

// ERC20 balanceOf function selector: 0x70a08231

/**
 * EVM Chain Adapter
 */
export class EvmAdapter implements ChainAdapter {
  readonly name = 'EVM';
  readonly networks = [BASE_MAINNET, BASE_SEPOLIA, ETHEREUM_MAINNET, ARBITRUM_ONE];

  private config: AdapterConfig;
  private log: (...args: unknown[]) => void;

  constructor(config: AdapterConfig = {}) {
    this.config = config;
    this.log = config.verbose
      ? console.log.bind(console, '[x402:evm]')
      : () => {};
  }

  canHandle(network: string): boolean {
    // Handle exact CAIP-2
    if (this.networks.includes(network)) return true;
    // Legacy format
    if (network === 'base') return true;
    if (network === 'ethereum') return true;
    if (network === 'arbitrum') return true;
    // Check if it starts with 'eip155:'
    if (network.startsWith('eip155:')) return true;
    return false;
  }

  getDefaultRpcUrl(network: string): string {
    if (this.config.rpcUrls?.[network]) {
      return this.config.rpcUrls[network];
    }
    if (DEFAULT_RPC_URLS[network]) {
      return DEFAULT_RPC_URLS[network];
    }
    // Normalize legacy
    if (network === 'base') return DEFAULT_RPC_URLS[BASE_MAINNET];
    if (network === 'ethereum') return DEFAULT_RPC_URLS[ETHEREUM_MAINNET];
    if (network === 'arbitrum') return DEFAULT_RPC_URLS[ARBITRUM_ONE];
    return DEFAULT_RPC_URLS[BASE_MAINNET];
  }

  getAddress(wallet: unknown): string | null {
    if (!isEvmWallet(wallet)) return null;
    return wallet.address;
  }

  isConnected(wallet: unknown): boolean {
    if (!isEvmWallet(wallet)) return false;
    return !!wallet.address;
  }

  private getChainId(network: string): number {
    if (CHAIN_IDS[network]) return CHAIN_IDS[network];
    // Try to extract from CAIP-2
    if (network.startsWith('eip155:')) {
      const chainIdStr = network.split(':')[1];
      return parseInt(chainIdStr, 10);
    }
    // Defaults
    if (network === 'base') return 8453;
    if (network === 'ethereum') return 1;
    if (network === 'arbitrum') return 42161;
    return 8453; // Default to Base
  }

  async getBalance(
    accept: PaymentAccept,
    wallet: unknown,
    rpcUrl?: string
  ): Promise<number> {
    if (!isEvmWallet(wallet) || !wallet.address) {
      return 0;
    }

    const url = rpcUrl || this.getDefaultRpcUrl(accept.network);

    try {
      // Use eth_call to check ERC20 balance
      const data = this.encodeBalanceOf(wallet.address);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [
            {
              to: accept.asset,
              data,
            },
            'latest',
          ],
        }),
      });

      const result = (await response.json()) as { error?: unknown; result?: string };
      if (result.error || !result.result) {
        return 0;
      }

      const balance = BigInt(result.result);
      const decimals = accept.extra?.decimals ?? 6;
      return Number(balance) / Math.pow(10, decimals);
    } catch {
      return 0;
    }
  }

  private encodeBalanceOf(address: string): string {
    // Function selector for balanceOf(address)
    const selector = '0x70a08231';
    // Pad address to 32 bytes
    const paddedAddress = address.slice(2).toLowerCase().padStart(64, '0');
    return selector + paddedAddress;
  }

  async buildTransaction(
    accept: PaymentAccept,
    wallet: unknown,
    _rpcUrl?: string
  ): Promise<SignedTransaction> {
    if (!isEvmWallet(wallet)) {
      throw new Error('Invalid EVM wallet');
    }
    if (!wallet.address) {
      throw new Error('Wallet not connected');
    }

    const { payTo, asset, extra } = accept;
    const amount = accept.amount || accept.maxAmountRequired;
    if (!amount) {
      throw new Error('Missing amount in payment requirements');
    }

    this.log('Building EVM transaction:', {
      from: wallet.address,
      to: payTo,
      amount,
      asset,
      network: accept.network,
    });

    // For x402 v2 EVM payments, we use EIP-712 typed data signing
    // The facilitator will execute the transfer on behalf of the user

    const chainId = this.getChainId(accept.network);

    // Build the EIP-712 typed data
    // This matches what Dexter's facilitator expects
    const domain = {
      name: extra?.name ?? 'USD Coin',
      version: extra?.version ?? '2',
      chainId: BigInt(chainId),
      verifyingContract: asset as `0x${string}`,
    };

    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };

    // Generate a random nonce (32 bytes hex)
    const nonce = '0x' + [...Array(32)]
      .map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0'))
      .join('') as `0x${string}`;

    const now = Math.floor(Date.now() / 1000);
    
    // Authorization object - values as strings for JSON, BigInts for signing
    const authorization = {
      from: wallet.address,
      to: payTo,
      value: amount, // string
      validAfter: String(now - 600), // 10 minutes before (matching upstream)
      validBefore: String(now + (accept.maxTimeoutSeconds || 60)),
      nonce,
    };

    // Message for signing uses BigInt values
    const message = {
      from: wallet.address,
      to: payTo,
      value: BigInt(amount),
      validAfter: BigInt(now - 600),
      validBefore: BigInt(now + (accept.maxTimeoutSeconds || 60)),
      nonce,
    };

    if (!wallet.signTypedData) {
      throw new Error('Wallet does not support signTypedData (EIP-712)');
    }

    const signature = await wallet.signTypedData({
      domain: domain as Record<string, unknown>,
      types: types as Record<string, unknown[]>,
      primaryType: 'TransferWithAuthorization',
      message: message as Record<string, unknown>,
    });

    this.log('EIP-712 signature obtained');

    // Payload structure matches upstream @x402/evm exactly
    const payload = {
      authorization,
      signature,
    };

    return {
      serialized: JSON.stringify(payload),
      signature,
    };
  }
}

/**
 * Create an EVM adapter instance
 */
export function createEvmAdapter(config?: AdapterConfig): EvmAdapter {
  return new EvmAdapter(config);
}

