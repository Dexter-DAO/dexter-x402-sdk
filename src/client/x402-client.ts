/**
 * x402 v2 Client
 *
 * Chain-agnostic client for x402 v2 payments.
 * Automatically detects 402 responses, finds a matching payment option,
 * builds the transaction with the appropriate chain adapter, and retries.
 *
 * @example
 * ```typescript
 * import { createX402Client } from '@dexterai/x402/client';
 * import { createSolanaAdapter, createEvmAdapter } from '@dexterai/x402/adapters';
 *
 * const client = createX402Client({
 *   adapters: [createSolanaAdapter(), createEvmAdapter()],
 *   wallets: {
 *     solana: solanaWallet,
 *     evm: evmWallet,
 *   },
 * });
 *
 * const response = await client.fetch(url);
 * ```
 */

import type { ChainAdapter, WalletSet } from '../adapters/types';
import type {
  PaymentRequired,
  PaymentAccept,
  AccessPassInfo,
  AccessPassClientConfig,
} from '../types';
import { X402Error } from '../types';
import { createSolanaAdapter, createEvmAdapter, isSolanaWallet, isEvmWallet } from '../adapters';

/**
 * Client configuration
 */
export interface X402ClientConfig {
  /**
   * Chain adapters to use for building transactions.
   * If not provided, uses Solana and EVM adapters by default.
   */
  adapters?: ChainAdapter[];

  /**
   * Wallets for each chain type.
   * Can also pass a single wallet for backwards compatibility.
   */
  wallets?: WalletSet;

  /**
   * Legacy: Single wallet (Solana).
   * Use `wallets` for multi-chain support.
   */
  wallet?: unknown;

  /**
   * Preferred network to use when multiple options are available.
   * CAIP-2 format (e.g., 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'eip155:8453')
   */
  preferredNetwork?: string;

  /**
   * Custom RPC URLs by network
   */
  rpcUrls?: Record<string, string>;

  /**
   * Maximum payment amount allowed (in atomic units).
   * Rejects payments exceeding this amount.
   */
  maxAmountAtomic?: string;

  /**
   * Custom fetch implementation
   */
  fetch?: typeof globalThis.fetch;

  /**
   * Enable verbose logging
   */
  verbose?: boolean;

  /**
   * Access pass configuration.
   * When present, the client will prefer purchasing time-limited access passes
   * over per-request payments. One payment grants unlimited requests for a duration.
   */
  accessPass?: AccessPassClientConfig;
}

/**
 * x402 Client interface
 */
export interface X402Client {
  /**
   * Fetch with automatic x402 payment handling.
   * If the server returns 402, handles payment automatically and retries.
   */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/**
 * Result of finding a payment option
 */
interface MatchedPayment {
  accept: PaymentAccept;
  adapter: ChainAdapter;
  wallet: unknown;
}

/**
 * Create an x402 v2 client
 */
export function createX402Client(config: X402ClientConfig): X402Client {
  const {
    adapters = [createSolanaAdapter({ verbose: config.verbose }), createEvmAdapter({ verbose: config.verbose })],
    wallets: walletSet,
    wallet: legacyWallet,
    preferredNetwork,
    rpcUrls = {},
    maxAmountAtomic,
    fetch: customFetch = globalThis.fetch,
    verbose = false,
    accessPass: accessPassConfig,
  } = config;

  const log = verbose
    ? console.log.bind(console, '[x402]')
    : () => {};

  // ── Access pass cache (host → { jwt, expiresAt }) ──
  const passCache = new Map<string, { jwt: string; expiresAt: number }>();

  function getCachedPass(url: string): string | null {
    try {
      const host = new URL(url).host;
      const cached = passCache.get(host);
      if (cached && cached.expiresAt > Date.now() / 1000 + 10) { // 10s buffer
        return cached.jwt;
      }
      if (cached) {
        passCache.delete(host); // Expired
      }
    } catch {}
    return null;
  }

  function cachePass(url: string, jwt: string): void {
    try {
      const host = new URL(url).host;
      // Decode expiration from JWT (middle part is base64url-encoded JSON)
      const parts = jwt.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (payload.exp) {
          passCache.set(host, { jwt, expiresAt: payload.exp });
          log('Access pass cached for', host, '| expires:', new Date(payload.exp * 1000).toISOString());
        }
      }
    } catch {
      log('Failed to cache access pass');
    }
  }

  // Build wallet set from legacy format if needed
  const wallets: WalletSet = walletSet || {};
  if (legacyWallet && !wallets.solana && isSolanaWallet(legacyWallet)) {
    wallets.solana = legacyWallet;
  }
  if (legacyWallet && !wallets.evm && isEvmWallet(legacyWallet)) {
    wallets.evm = legacyWallet;
  }

  /**
   * Find a payment option we can handle
   * Prioritizes:
   * 1. Preferred network (if specified)
   * 2. Networks where we have a connected wallet
   * 3. First available option
   */
  function findPaymentOption(accepts: PaymentAccept[]): MatchedPayment | null {
    // Filter to options we can handle
    const candidates: MatchedPayment[] = [];

    for (const accept of accepts) {
      const adapter = adapters.find(a => a.canHandle(accept.network));
      if (!adapter) continue;

      // Find the right wallet for this adapter
      let wallet: unknown;
      if (adapter.name === 'Solana') {
        wallet = wallets.solana;
      } else if (adapter.name === 'EVM') {
        wallet = wallets.evm;
      }

      if (wallet && adapter.isConnected(wallet)) {
        candidates.push({ accept, adapter, wallet });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    // Prefer the specified network
    if (preferredNetwork) {
      const preferred = candidates.find(c => c.accept.network === preferredNetwork);
      if (preferred) return preferred;
    }

    // Return first available
    return candidates[0];
  }

  /**
   * Get RPC URL for a network
   */
  function getRpcUrl(network: string, adapter: ChainAdapter): string {
    return rpcUrls[network] || adapter.getDefaultRpcUrl(network);
  }

  /**
   * Purchase an access pass via x402 payment, cache the JWT, retry with it
   */
  async function purchaseAccessPass(
    input: string | URL | Request,
    init: RequestInit | undefined,
    originalResponse: Response,
    passInfo: AccessPassInfo,
    url: string,
  ): Promise<Response | null> {
    // Determine which tier/duration to request
    let tierQuery = '';

    if (accessPassConfig?.preferTier && passInfo.tiers) {
      const match = passInfo.tiers.find(t => t.id === accessPassConfig.preferTier);
      if (match) {
        // Check max spend
        if (accessPassConfig.maxSpend && parseFloat(match.price) > parseFloat(accessPassConfig.maxSpend)) {
          throw new X402Error('access_pass_exceeds_max_spend',
            `Access pass tier "${match.id}" costs $${match.price}, exceeds max spend $${accessPassConfig.maxSpend}`);
        }
        tierQuery = `tier=${match.id}`;
      }
    } else if (accessPassConfig?.preferDuration && passInfo.ratePerHour) {
      tierQuery = `duration=${accessPassConfig.preferDuration}`;
    } else if (passInfo.tiers && passInfo.tiers.length > 0) {
      // Pick cheapest tier
      const cheapest = passInfo.tiers[0];
      if (accessPassConfig?.maxSpend && parseFloat(cheapest.price) > parseFloat(accessPassConfig.maxSpend)) {
        throw new X402Error('access_pass_exceeds_max_spend',
          `Cheapest access pass costs $${cheapest.price}, exceeds max spend $${accessPassConfig?.maxSpend}`);
      }
      tierQuery = `tier=${cheapest.id}`;
    }

    // The pass purchase goes through normal x402 payment flow on the same URL
    // We add the tier query param so the server knows which tier we want
    const passUrl = tierQuery
      ? (url.includes('?') ? `${url}&${tierQuery}` : `${url}?${tierQuery}`)
      : url;

    log('Purchasing access pass:', tierQuery || 'default tier');

    // We need to do the full x402 payment flow for the pass purchase
    // The 402 response we already have contains the PAYMENT-REQUIRED header
    // So we can proceed directly to building the payment from it
    const paymentRequiredHeader = originalResponse.headers.get('PAYMENT-REQUIRED');
    if (!paymentRequiredHeader) return null;

    let requirements: PaymentRequired;
    try {
      requirements = JSON.parse(atob(paymentRequiredHeader));
    } catch {
      return null;
    }

    const match = findPaymentOption(requirements.accepts);
    if (!match) return null;

    const { accept, adapter, wallet } = match;

    // Validate fee payer (Solana)
    if (adapter.name === 'Solana' && !accept.extra?.feePayer) return null;

    const USDC_MINTS = [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    ];
    const decimals = accept.extra?.decimals ?? (USDC_MINTS.includes(accept.asset) ? 6 : undefined);
    if (typeof decimals !== 'number') return null;

    const paymentAmount = accept.amount || accept.maxAmountRequired;
    if (!paymentAmount) return null;

    // Check balance
    const rpcUrl = getRpcUrl(accept.network, adapter);
    const balance = await adapter.getBalance(accept, wallet, rpcUrl);
    const requiredAmount = Number(paymentAmount) / Math.pow(10, decimals);
    if (balance < requiredAmount) {
      throw new X402Error('insufficient_balance',
        `Insufficient balance for access pass. Have $${balance.toFixed(4)}, need $${requiredAmount.toFixed(4)}`);
    }

    // Build and sign transaction
    const signedTx = await adapter.buildTransaction(accept, wallet, rpcUrl);

    // Build PAYMENT-SIGNATURE
    let payload: Record<string, unknown>;
    if (adapter.name === 'EVM') {
      payload = JSON.parse(signedTx.serialized);
    } else {
      payload = { transaction: signedTx.serialized };
    }

    const originalUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let resolvedResource: unknown = requirements.resource;
    if (typeof requirements.resource === 'string') {
      try { resolvedResource = new URL(requirements.resource, originalUrl).toString(); } catch {}
    } else if (requirements.resource && typeof requirements.resource === 'object' && 'url' in requirements.resource) {
      const rObj = requirements.resource as { url: string; [key: string]: unknown };
      try { resolvedResource = { ...rObj, url: new URL(rObj.url, originalUrl).toString() }; } catch {}
    }

    const paymentSignature = {
      x402Version: accept.x402Version ?? 2,
      resource: resolvedResource,
      accepted: accept,
      payload,
    };

    const paymentSignatureHeader = btoa(JSON.stringify(paymentSignature));

    // Make payment request to purchase the pass (must be POST)
    const passResponse = await customFetch(passUrl, {
      ...init,
      method: 'POST',
      headers: {
        ...(init?.headers || {}),
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': paymentSignatureHeader,
      },
    });

    if (!passResponse.ok) {
      log('Pass purchase failed:', passResponse.status);
      return null; // Fall back to per-request payment
    }

    // Extract and cache the JWT from ACCESS-PASS header
    const accessPassJwt = passResponse.headers.get('ACCESS-PASS');
    if (accessPassJwt) {
      cachePass(url, accessPassJwt);
      log('Access pass purchased and cached');
    }

    // Return the pass purchase response directly.
    // The JWT is in the ACCESS-PASS header for the caller (hook) to read.
    // The client's internal cache has the JWT for all future requests.
    return passResponse;
  }

  /**
   * Main fetch function with x402 payment handling + access pass support
   */
  async function x402Fetch(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    log('Making request:', url);

    // ── Access pass: try cached pass first ──
    if (accessPassConfig) {
      const cachedJwt = getCachedPass(url);
      if (cachedJwt) {
        log('Using cached access pass');
        const passResponse = await customFetch(input, {
          ...init,
          headers: {
            ...(init?.headers || {}),
            'Authorization': `Bearer ${cachedJwt}`,
          },
        });
        // If the pass worked (not 401/402), return the response
        if (passResponse.status !== 401 && passResponse.status !== 402) {
          return passResponse;
        }
        // Pass rejected (expired/invalid) — clear cache and fall through to payment
        log('Cached pass rejected (status', passResponse.status, '), purchasing new pass');
        try { passCache.delete(new URL(url).host); } catch {}
      }
    }

    // Make initial request (without pass)
    const response = await customFetch(input, init);

    // If not 402, return as-is
    if (response.status !== 402) {
      return response;
    }

    log('Received 402 Payment Required');

    // ── Access pass: check if server offers passes and we want one ──
    const passTiersHeader = response.headers.get('X-ACCESS-PASS-TIERS');
    if (accessPassConfig && passTiersHeader) {
      log('Server offers access passes, purchasing...');
      try {
        const passInfo: AccessPassInfo = JSON.parse(atob(passTiersHeader));
        const passResponse = await purchaseAccessPass(input, init, response, passInfo, url);
        if (passResponse) return passResponse;
      } catch (e) {
        log('Access pass purchase failed, falling back to per-request payment:', e);
      }
    }

    // Parse PAYMENT-REQUIRED header
    const paymentRequiredHeader = response.headers.get('PAYMENT-REQUIRED');
    if (!paymentRequiredHeader) {
      throw new X402Error(
        'missing_payment_required_header',
        'Server returned 402 but no PAYMENT-REQUIRED header'
      );
    }

    let requirements: PaymentRequired;
    try {
      const decoded = atob(paymentRequiredHeader);
      requirements = JSON.parse(decoded);
    } catch {
      throw new X402Error(
        'invalid_payment_required',
        'Failed to decode PAYMENT-REQUIRED header'
      );
    }

    log('Payment requirements:', requirements);

    // Capture X-Quote-Hash if present (for dynamic pricing validation)
    const quoteHash = response.headers.get('X-Quote-Hash');
    if (quoteHash) {
      log('Quote hash received:', quoteHash);
    }

    // Find a payment option we can use
    const match = findPaymentOption(requirements.accepts);
    if (!match) {
      const availableNetworks = requirements.accepts.map(a => a.network).join(', ');
      throw new X402Error(
        'no_matching_payment_option',
        `No connected wallet for any available network: ${availableNetworks}`
      );
    }

    const { accept, adapter, wallet } = match;
    log(`Using ${adapter.name} for ${accept.network}`);

    // Validate fee payer (Solana only - EVM users pay their own gas)
    if (adapter.name === 'Solana' && !accept.extra?.feePayer) {
      throw new X402Error(
        'missing_fee_payer',
        'Solana payment option missing feePayer in extra'
      );
    }

    // Get decimals: from extra, or default to 6 for USDC
    const USDC_MINTS = [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Solana mainnet
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Solana devnet
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base mainnet
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base sepolia
    ];
    const decimals = accept.extra?.decimals ?? (USDC_MINTS.includes(accept.asset) ? 6 : undefined);
    if (typeof decimals !== 'number') {
      throw new X402Error(
        'missing_decimals',
        'Payment option missing decimals - provide in extra or use a known stablecoin'
      );
    }

    // Get amount (x402 spec uses maxAmountRequired, we also support amount)
    const paymentAmount = accept.amount || accept.maxAmountRequired;
    if (!paymentAmount) {
      throw new X402Error('missing_amount', 'Payment option missing amount');
    }

    // Check amount limit
    if (maxAmountAtomic && BigInt(paymentAmount) > BigInt(maxAmountAtomic)) {
      throw new X402Error(
        'amount_exceeds_max',
        `Payment amount ${paymentAmount} exceeds maximum ${maxAmountAtomic}`
      );
    }

    // Check balance before signing
    const rpcUrl = getRpcUrl(accept.network, adapter);
    log('Checking balance...');
    const balance = await adapter.getBalance(accept, wallet, rpcUrl);
    const requiredAmount = Number(paymentAmount) / Math.pow(10, decimals);
    
    if (balance < requiredAmount) {
      const network = adapter.name === 'EVM' ? 'Base' : 'Solana';
      throw new X402Error(
        'insufficient_balance',
        `Insufficient USDC balance on ${network}. Have $${balance.toFixed(4)}, need $${requiredAmount.toFixed(4)}`
      );
    }
    log(`Balance OK: $${balance.toFixed(4)} >= $${requiredAmount.toFixed(4)}`);

    // Build and sign transaction
    log('Building transaction...');
    const signedTx = await adapter.buildTransaction(accept, wallet, rpcUrl);
    log('Transaction signed');

    // Build PAYMENT-SIGNATURE payload
    // Solana uses payload.transaction (base64 serialized tx)
    // EVM uses payload directly (authorization + signature object)
    let payload: Record<string, unknown>;
    if (adapter.name === 'EVM') {
      // EVM: payload is the authorization + signature object
      payload = JSON.parse(signedTx.serialized);
    } else {
      // Solana: payload.transaction is the base64 tx
      payload = { transaction: signedTx.serialized };
    }

    // Resolve relative resource URLs to absolute URLs
    // Sellers may return path-only resources like "/api/foo" in their 402 response.
    // We resolve against the original request URL so events have full URLs for discovery.
    const originalUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    
    // requirements.resource can be a string (legacy) or ResourceInfo object (v2)
    // Preserve the original format, just resolve any relative URLs
    let resolvedResource: unknown = requirements.resource;
    if (typeof requirements.resource === 'string') {
      // Legacy string format
      try {
        const resolvedUrl = new URL(requirements.resource, originalUrl).toString();
        if (resolvedUrl !== requirements.resource) {
          log('Resolved relative resource URL:', requirements.resource, '→', resolvedUrl);
        }
        resolvedResource = resolvedUrl;
      } catch {
        resolvedResource = requirements.resource;
      }
    } else if (requirements.resource && typeof requirements.resource === 'object' && 'url' in requirements.resource) {
      // ResourceInfo object - resolve the url field
      const resourceObj = requirements.resource as { url: string; [key: string]: unknown };
      try {
        const resolvedUrl = new URL(resourceObj.url, originalUrl).toString();
        if (resolvedUrl !== resourceObj.url) {
          log('Resolved relative resource URL:', resourceObj.url, '→', resolvedUrl);
          resolvedResource = { ...resourceObj, url: resolvedUrl };
        }
      } catch {
        // Keep original if URL resolution fails
      }
    }

    const paymentSignature = {
      x402Version: accept.x402Version ?? 2,  // Echo version from 402 response, default to 2
      resource: resolvedResource,
      accepted: accept,
      payload,
    };

    const paymentSignatureHeader = btoa(JSON.stringify(paymentSignature));

    // Retry request with payment
    log('Retrying request with payment...');
    const retryResponse = await customFetch(input, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        'PAYMENT-SIGNATURE': paymentSignatureHeader,
        // Forward quote hash for dynamic pricing validation
        ...(quoteHash ? { 'X-Quote-Hash': quoteHash } : {}),
      },
    });

    log('Retry response status:', retryResponse.status);

    if (retryResponse.status === 402) {
      // Try to get rejection reason from body
      let reason = 'unknown';
      try {
        const body = (await retryResponse.clone().json()) as Record<string, unknown>;
        reason = String(body.error || body.message || JSON.stringify(body));
        log('Rejection reason:', reason);
      } catch {
        // Ignore
      }
      throw new X402Error(
        'payment_rejected',
        `Payment was rejected by the server: ${reason}`
      );
    }

    return retryResponse;
  }

  return {
    fetch: x402Fetch,
  };
}

// Re-export types for convenience
export type { ChainAdapter, WalletSet } from '../adapters/types';
export { X402Error } from '../types';
