/**
 * EVM Chain Adapter
 *
 * Implements the ChainAdapter interface for EVM networks (Base, Ethereum, Arbitrum, etc.)
 * Uses EIP-712 typed data signing for x402 v2 payments.
 */

import type { ChainAdapter, AdapterConfig, SignedTransaction } from './types';
import type { PaymentAccept } from '../types';

/**
 * Approval strategy from the facilitator's /supported endpoint.
 * Controls how much to approve on chains that use the exact-approval scheme.
 */
interface ApprovalStrategy {
  mode: 'buffered' | 'exact';
  defaultMultiple?: number;
  maxCapUsd?: number;
  exactAboveUsd?: number;
}

/**
 * CAIP-2 network identifiers for EVM chains.
 * Mirrors dexter-facilitator/src/config/chains.ts — update both when adding chains.
 */
export const BASE_MAINNET = 'eip155:8453';
export const BASE_SEPOLIA = 'eip155:84532';
export const ARBITRUM_ONE = 'eip155:42161';
export const POLYGON = 'eip155:137';
export const OPTIMISM = 'eip155:10';
export const AVALANCHE = 'eip155:43114';
export const BSC_MAINNET = 'eip155:56';
export const SKALE_BASE = 'eip155:1187947933';
export const SKALE_BASE_SEPOLIA = 'eip155:324705682';

/** @deprecated Not supported by the Dexter facilitator. Use BASE_MAINNET for EVM payments. */
export const ETHEREUM_MAINNET = 'eip155:1';

/**
 * BSC stablecoin addresses (18 decimals — unlike 6 on every other chain)
 */
export const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955';
export const BSC_USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

/**
 * Chain IDs by CAIP-2 network
 */
const CHAIN_IDS: Record<string, number> = {
  [BSC_MAINNET]: 56,
  [BASE_MAINNET]: 8453,
  [BASE_SEPOLIA]: 84532,
  [ARBITRUM_ONE]: 42161,
  [POLYGON]: 137,
  [OPTIMISM]: 10,
  [AVALANCHE]: 43114,
  [SKALE_BASE]: 1187947933,
  [SKALE_BASE_SEPOLIA]: 324705682,
  [ETHEREUM_MAINNET]: 1,
};

/**
 * Default RPC URLs.
 * Base mainnet uses Dexter's RPC proxy for reliability and zero-config setup.
 * Source of truth: dexter-facilitator/src/config/chains.ts
 */
const DEFAULT_RPC_URLS: Record<string, string> = {
  [BSC_MAINNET]: 'https://bsc-dataseed1.binance.org',
  [BASE_MAINNET]: 'https://api.dexter.cash/api/base/rpc',
  [BASE_SEPOLIA]: 'https://sepolia.base.org',
  [ARBITRUM_ONE]: 'https://arb1.arbitrum.io/rpc',
  [POLYGON]: 'https://polygon-rpc.com',
  [OPTIMISM]: 'https://mainnet.optimism.io',
  [AVALANCHE]: 'https://api.avax.network/ext/bc/C/rpc',
  [SKALE_BASE]: 'https://skale-base.skalenodes.com/v1/base',
  [SKALE_BASE_SEPOLIA]: 'https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha',
  [ETHEREUM_MAINNET]: 'https://eth.llamarpc.com',
};

/**
 * USDC contract addresses by chain.
 * Source of truth: dexter-facilitator/src/config/chains.ts
 */
export const USDC_ADDRESSES: Record<string, string> = {
  [BSC_MAINNET]: BSC_USDC,
  [BASE_MAINNET]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  [BASE_SEPOLIA]: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  [ARBITRUM_ONE]: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  [POLYGON]: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  [OPTIMISM]: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  [AVALANCHE]: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  [SKALE_BASE]: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
  [SKALE_BASE_SEPOLIA]: '0x2e08028E3C4c2356572E096d8EF835cD5C6030bD',
  [ETHEREUM_MAINNET]: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
};

/**
 * Known BSC stablecoin addresses (for isKnownStablecoin checks).
 * Both use 18 decimals on BSC, unlike the 6 decimals on all other chains.
 */
export const BSC_STABLECOIN_ADDRESSES: Record<string, { symbol: string; decimals: number }> = {
  [BSC_USDT]: { symbol: 'USDT', decimals: 18 },
  [BSC_USDC]: { symbol: 'USDC', decimals: 18 },
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
  readonly networks = [BSC_MAINNET, BASE_MAINNET, BASE_SEPOLIA, ETHEREUM_MAINNET, ARBITRUM_ONE];

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
    if (network === 'bsc') return true;
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
    if (network === 'bsc') return DEFAULT_RPC_URLS[BSC_MAINNET];
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
    if (network === 'bsc') return 56;
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

      if (!response.ok) {
        throw new Error(`RPC request failed: ${response.status}`);
      }

      const result = (await response.json()) as { error?: unknown; result?: string };
      if (result.error) {
        throw new Error(`RPC error: ${JSON.stringify(result.error)}`);
      }
      if (!result.result || result.result === '0x') {
        return 0;
      }

      const balance = BigInt(result.result);
      const decimals = accept.extra?.decimals ?? 6;
      return Number(balance) / Math.pow(10, decimals);
    } catch (err) {
      // Re-throw RPC/network errors so caller can distinguish from zero balance
      throw err;
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
    rpcUrl?: string
  ): Promise<SignedTransaction> {
    if (!isEvmWallet(wallet)) {
      throw new Error('Invalid EVM wallet');
    }
    if (!wallet.address) {
      throw new Error('Wallet not connected');
    }

    // Route to approval-based flow for BSC and other chains without EIP-3009
    if (accept.scheme === 'exact-approval') {
      return this.buildApprovalTransaction(accept, wallet, rpcUrl);
    }

    const { payTo, asset, extra } = accept;
    // amount is the v2 spec field, maxAmountRequired is v1 fallback
    const amount = accept.amount ?? accept.maxAmountRequired;
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

    // Generate a cryptographically secure random nonce (32 bytes hex)
    const nonceBytes = new Uint8Array(32);
    (globalThis.crypto ?? (await import('crypto')).webcrypto).getRandomValues(nonceBytes);
    const nonce = ('0x' + [...nonceBytes].map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;

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

  // ===========================================================================
  // exact-approval: BSC and other chains without EIP-3009
  // ===========================================================================

  /**
   * Build a payment transaction for chains that use the approval-based scheme.
   * The facilitator's /supported response provides the EIP-712 domain and types
   * in accept.extra, so the client doesn't hardcode any contract addresses.
   */
  private async buildApprovalTransaction(
    accept: PaymentAccept,
    wallet: EvmWallet,
    rpcUrl?: string,
  ): Promise<SignedTransaction> {
    const { payTo, asset, extra } = accept;
    const amount = accept.amount ?? accept.maxAmountRequired;
    if (!amount) {
      throw new Error('Missing amount in payment requirements');
    }

    const facilitatorContract = extra?.facilitatorContract as string | undefined;
    if (!facilitatorContract) {
      throw new Error(
        'exact-approval scheme requires extra.facilitatorContract from the facilitator. ' +
        'The /supported endpoint should provide this.'
      );
    }

    if (!wallet.signTypedData) {
      throw new Error('Wallet does not support signTypedData (EIP-712)');
    }

    this.log('Building approval-based transaction:', {
      from: wallet.address,
      to: payTo,
      amount,
      asset,
      network: accept.network,
      facilitatorContract,
    });

    const url = rpcUrl || this.getDefaultRpcUrl(accept.network);

    // 1. Check current allowance
    const fee = (extra?.fee as string) ?? '0';
    const totalNeeded = BigInt(amount) + BigInt(fee);
    const currentAllowance = await this.readAllowance(url, asset, wallet.address, facilitatorContract);

    // 2. Approve if needed
    if (currentAllowance < totalNeeded) {
      if (!wallet.sendTransaction) {
        throw new Error(
          'BSC payments require a wallet that supports sendTransaction for the one-time token approval. ' +
          'Use createEvmKeypairWallet() or a browser wallet with transaction support.'
        );
      }

      const approvalAmount = this.calculateApprovalAmount(amount, fee, extra?.approvalStrategy as ApprovalStrategy | undefined);
      this.log(`Approving ${approvalAmount} for ${facilitatorContract} (current allowance: ${currentAllowance})`);

      const approveTxHash = await wallet.sendTransaction({
        to: asset,
        data: this.encodeApprove(facilitatorContract, approvalAmount),
        value: 0n,
      });

      this.log(`Approval tx sent: ${approveTxHash}`);

      // Wait for the approval to confirm
      await this.waitForReceipt(url, approveTxHash);
      this.log('Approval confirmed');
    } else {
      this.log('Sufficient allowance, skipping approval');
    }

    // 3. Generate random nonce (128-bit, matching facilitator contract)
    const nonceBytes = new Uint8Array(16);
    (globalThis.crypto ?? (await import('crypto')).webcrypto).getRandomValues(nonceBytes);
    const nonce = [...nonceBytes].reduce((acc, b) => acc * 256n + BigInt(b), 0n).toString();

    // 4. Generate random paymentId (32 bytes)
    const paymentIdBytes = new Uint8Array(32);
    (globalThis.crypto ?? (await import('crypto')).webcrypto).getRandomValues(paymentIdBytes);
    const paymentId = ('0x' + [...paymentIdBytes].map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;

    // 5. Build deadline
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + (accept.maxTimeoutSeconds || 300);

    // 6. Build EIP-712 domain and message from facilitator-provided data
    const eip712Domain = extra?.eip712Domain as Record<string, unknown> | undefined;
    const domain = eip712Domain
      ? {
          name: eip712Domain.name as string,
          version: eip712Domain.version as string,
          chainId: BigInt(eip712Domain.chainId as number),
          verifyingContract: eip712Domain.verifyingContract as string,
        }
      : {
          name: 'DexterBSCFacilitator',
          version: '1',
          chainId: BigInt(this.getChainId(accept.network)),
          verifyingContract: facilitatorContract,
        };

    const types = (extra?.eip712Types as Record<string, unknown[]>) ?? {
      Payment: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'fee', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'paymentId', type: 'bytes32' },
      ],
    };

    const message = {
      from: wallet.address,
      to: payTo,
      token: asset,
      amount: BigInt(amount),
      fee: BigInt(fee),
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
      paymentId,
    };

    // 7. Sign
    const signature = await wallet.signTypedData({
      domain: domain as Record<string, unknown>,
      types: types as Record<string, unknown[]>,
      primaryType: 'Payment',
      message: message as Record<string, unknown>,
    });

    this.log('EIP-712 Payment signature obtained');

    // 8. Build payload — string values for JSON transport, same as facilitator expects
    const payload = {
      from: wallet.address,
      to: payTo,
      token: asset,
      amount,
      fee,
      nonce,
      deadline,
      paymentId,
      signature,
    };

    return {
      serialized: JSON.stringify(payload),
      signature,
    };
  }

  /**
   * Read ERC-20 allowance via raw eth_call (no viem dependency needed).
   */
  private async readAllowance(
    rpcUrl: string,
    token: string,
    owner: string,
    spender: string,
  ): Promise<bigint> {
    // allowance(address,address) selector: 0xdd62ed3e
    const selector = '0xdd62ed3e';
    const paddedOwner = owner.slice(2).toLowerCase().padStart(64, '0');
    const paddedSpender = spender.slice(2).toLowerCase().padStart(64, '0');
    const data = selector + paddedOwner + paddedSpender;

    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: token, data }, 'latest'],
        }),
      });
      const result = (await response.json()) as { result?: string; error?: unknown };
      if (result.error || !result.result || result.result === '0x') return 0n;
      return BigInt(result.result);
    } catch {
      return 0n;
    }
  }

  /**
   * Encode ERC-20 approve(address,uint256) calldata.
   */
  private encodeApprove(spender: string, amount: bigint): string {
    // approve(address,uint256) selector: 0x095ea7b3
    const selector = '0x095ea7b3';
    const paddedSpender = spender.slice(2).toLowerCase().padStart(64, '0');
    const paddedAmount = amount.toString(16).padStart(64, '0');
    return selector + paddedSpender + paddedAmount;
  }

  /**
   * Wait for a transaction receipt by polling eth_getTransactionReceipt.
   */
  private async waitForReceipt(rpcUrl: string, txHash: string, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getTransactionReceipt',
            params: [txHash],
          }),
        });
        const result = (await response.json()) as { result?: { status: string } | null };
        if (result.result) {
          if (result.result.status === '0x0') {
            throw new Error(`Approval transaction reverted: ${txHash}`);
          }
          return; // Success
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('reverted')) throw err;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`Approval transaction receipt timeout after ${timeoutMs}ms: ${txHash}`);
  }

  /**
   * Calculate how much to approve based on the facilitator's approval strategy.
   * Buffered approvals reduce the number of on-chain approval txs for micropayments.
   */
  private calculateApprovalAmount(
    paymentAmount: string,
    fee: string,
    strategy?: ApprovalStrategy,
  ): bigint {
    const total = BigInt(paymentAmount) + BigInt(fee);

    if (!strategy || strategy.mode === 'exact') {
      return total;
    }

    // Buffered mode: approve multiple * total, capped
    const multiple = BigInt(strategy.defaultMultiple ?? 10);
    const buffered = total * multiple;

    // Cap at maxCapUsd (converted to atomic units using the same decimals as the payment)
    // The strategy values are in USD, amounts are in atomic units.
    // For BSC (18 decimals): $5 = 5 * 10^18 = 5000000000000000000
    // For other chains (6 decimals): $5 = 5 * 10^6 = 5000000
    // We infer decimals from the payment amount magnitude.
    if (strategy.maxCapUsd) {
      const decimals = this.inferDecimals(paymentAmount);
      const maxCap = BigInt(Math.floor(strategy.maxCapUsd * Math.pow(10, decimals)));
      if (buffered > maxCap) return maxCap;
    }

    // If payment exceeds exactAboveUsd threshold, use exact amount
    if (strategy.exactAboveUsd) {
      const decimals = this.inferDecimals(paymentAmount);
      const threshold = BigInt(Math.floor(strategy.exactAboveUsd * Math.pow(10, decimals)));
      if (BigInt(paymentAmount) > threshold) return total;
    }

    return buffered;
  }

  /**
   * Infer token decimals from payment amount magnitude.
   * BSC stablecoins use 18 decimals, all others use 6.
   * A $1 payment is 1000000 (6 dec) or 1000000000000000000 (18 dec).
   * If the amount has > 12 digits, it's almost certainly 18 decimals.
   */
  private inferDecimals(amount: string): number {
    return amount.length > 12 ? 18 : 6;
  }
}

/**
 * Create an EVM adapter instance
 */
export function createEvmAdapter(config?: AdapterConfig): EvmAdapter {
  return new EvmAdapter(config);
}

