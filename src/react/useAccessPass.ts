/**
 * React Hook for x402 Access Pass
 *
 * Dedicated hook for managing the access pass lifecycle:
 * tier discovery, pass purchase, token caching, and auto-fetch with pass.
 *
 * @example
 * ```tsx
 * import { useAccessPass } from '@dexterai/x402/react';
 *
 * function DataDashboard() {
 *   const {
 *     tiers,
 *     pass,
 *     isPassValid,
 *     purchasePass,
 *     isPurchasing,
 *     fetch: apFetch,
 *   } = useAccessPass({
 *     wallets: { solana: solanaWallet },
 *     resourceUrl: 'https://api.example.com',
 *   });
 *
 *   return (
 *     <div>
 *       {!isPassValid && tiers && (
 *         <div>
 *           {tiers.map(t => (
 *             <button key={t.id} onClick={() => purchasePass(t.id)}>
 *               {t.label} — ${t.price}
 *             </button>
 *           ))}
 *         </div>
 *       )}
 *       {isPassValid && <p>Pass active! Expires: {pass?.expiresAt}</p>}
 *       <button onClick={() => apFetch('/api/data').then(r => r.json()).then(console.log)}>
 *         Fetch Data
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createX402Client } from '../client/x402-client';
import type { WalletSet } from '../adapters/types';
import type { AccessPassTier, AccessPassInfo } from '../types';
import { isSolanaWallet, isEvmWallet, createSolanaAdapter, createEvmAdapter } from '../adapters';

// ============================================================================
// Types
// ============================================================================

export interface UseAccessPassConfig {
  /** Wallets for each chain type */
  wallets?: WalletSet;
  /** Legacy: Single Solana wallet */
  wallet?: unknown;
  /** Preferred network */
  preferredNetwork?: string;
  /** Custom RPC URLs by network */
  rpcUrls?: Record<string, string>;
  /** The base URL of the x402 resource */
  resourceUrl: string;
  /** Auto-fetch tier info on mount @default true */
  autoConnect?: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
}

export interface UseAccessPassReturn {
  /** Available tiers from the server (null until fetched) */
  tiers: AccessPassTier[] | null;
  /** Custom rate per hour (if server supports custom durations) */
  customRatePerHour: string | null;
  /** Whether tier info is being loaded */
  isLoadingTiers: boolean;

  /** Current active pass (null if no valid pass) */
  pass: {
    jwt: string;
    tier: string;
    expiresAt: string;
    remainingSeconds: number;
  } | null;
  /** Whether the current pass is valid and not expired */
  isPassValid: boolean;

  /** Fetch tier info from the server */
  fetchTiers: () => Promise<void>;
  /** Purchase a pass for a specific tier or custom duration */
  purchasePass: (tier?: string, durationSeconds?: number) => Promise<void>;
  /** Whether a pass purchase is in progress */
  isPurchasing: boolean;
  /** Error from the last purchase attempt */
  purchaseError: Error | null;

  /** Fetch with automatic pass inclusion */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useAccessPass(config: UseAccessPassConfig): UseAccessPassReturn {
  const {
    wallets: walletSet,
    wallet: legacyWallet,
    preferredNetwork,
    rpcUrls = {},
    resourceUrl,
    autoConnect = true,
    verbose = false,
  } = config;

  // Persistence key for sessionStorage (scoped to resource URL)
  const storageKey = `x402-access-pass:${resourceUrl}`;

  // Restore pass from sessionStorage on mount
  function loadPersistedPass(): { jwt: string; tier: string; expiresAt: string } | null {
    if (typeof sessionStorage === 'undefined') return null;
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (!stored) return null;
      const parsed = JSON.parse(stored) as { jwt: string; tier: string; expiresAt: string };
      // Check expiration
      if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
        sessionStorage.removeItem(storageKey);
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function persistPass(jwt: string, tier: string, expiresAt: string): void {
    if (typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ jwt, tier, expiresAt }));
    } catch {}
  }

  // State — initialized from sessionStorage if available
  const persisted = loadPersistedPass();
  const [tiers, setTiers] = useState<AccessPassTier[] | null>(null);
  const [customRatePerHour, setCustomRatePerHour] = useState<string | null>(null);
  const [isLoadingTiers, setIsLoadingTiers] = useState(false);
  const [passJwt, setPassJwt] = useState<string | null>(persisted?.jwt || null);
  const [passInfo, setPassInfo] = useState<{ tier: string; expiresAt: string } | null>(
    persisted ? { tier: persisted.tier, expiresAt: persisted.expiresAt } : null,
  );
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [purchaseError, setPurchaseError] = useState<Error | null>(null);

  // Ref to always have the latest JWT available in callbacks (avoids stale closures)
  const passJwtRef = useRef<string | null>(passJwt);
  useEffect(() => { passJwtRef.current = passJwt; }, [passJwt]);

  const log = useCallback((...args: unknown[]) => {
    if (verbose) console.log('[useAccessPass]', ...args);
  }, [verbose]);

  // Build wallet set
  const wallets: WalletSet = useMemo(() => {
    const w: WalletSet = { ...walletSet };
    if (legacyWallet && !w.solana && isSolanaWallet(legacyWallet)) {
      w.solana = legacyWallet;
    }
    if (legacyWallet && !w.evm && isEvmWallet(legacyWallet)) {
      w.evm = legacyWallet;
    }
    return w;
  }, [walletSet, legacyWallet]);

  // Create x402 client with access pass support
  const client = useMemo(() => createX402Client({
    adapters: [createSolanaAdapter({ verbose, rpcUrls }), createEvmAdapter({ verbose, rpcUrls })],
    wallets,
    preferredNetwork,
    rpcUrls,
    verbose,
    accessPass: { enabled: true, autoRenew: true },
  }), [wallets, preferredNetwork, rpcUrls, verbose]);

  // Tick counter — increments every second to drive countdown
  const [tick, setTick] = useState(0);

  // Compute pass validity (recomputes every tick)
  const pass = useMemo(() => {
    void tick; // Ensure tick is a dependency
    if (!passJwt || !passInfo) return null;
    const expiresAtMs = new Date(passInfo.expiresAt).getTime();
    const remaining = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
    if (remaining <= 0) return null;
    return { jwt: passJwt, tier: passInfo.tier, expiresAt: passInfo.expiresAt, remainingSeconds: remaining };
  }, [passJwt, passInfo, tick]);

  const isPassValid = pass !== null && pass.remainingSeconds > 0;

  // Tick every second when pass is active
  useEffect(() => {
    if (!passJwt || !passInfo) return;
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isPassValid]);

  // Fetch tier info from server
  const fetchTiers = useCallback(async () => {
    setIsLoadingTiers(true);
    try {
      const res = await fetch(resourceUrl);
      if (res.status === 402) {
        const tiersHeader = res.headers.get('X-ACCESS-PASS-TIERS');
        if (tiersHeader) {
          const info: AccessPassInfo = JSON.parse(atob(tiersHeader));
          setTiers(info.tiers || null);
          setCustomRatePerHour(info.ratePerHour || null);
          log('Tier info loaded:', info);
        }
      }
    } catch (e) {
      log('Failed to fetch tiers:', e);
    } finally {
      setIsLoadingTiers(false);
    }
  }, [resourceUrl, log]);

  // Auto-fetch tiers on mount
  useEffect(() => {
    if (autoConnect) fetchTiers();
  }, [autoConnect, fetchTiers]);

  // Purchase a pass
  const purchasePass = useCallback(async (tier?: string, durationSeconds?: number) => {
    setIsPurchasing(true);
    setPurchaseError(null);

    try {
      let url = resourceUrl;
      if (tier) url += (url.includes('?') ? '&' : '?') + `tier=${tier}`;
      else if (durationSeconds) url += (url.includes('?') ? '&' : '?') + `duration=${durationSeconds}`;

      const res = await client.fetch(url, { method: 'POST' });

      // Check for ACCESS-PASS header
      const jwt = res.headers.get('ACCESS-PASS');
      log('ACCESS-PASS header:', jwt ? 'found' : 'NOT FOUND');
      if (jwt) {
        setPassJwt(jwt);

        // Decode pass info from response body or JWT payload
        let passTier = tier || 'unknown';
        let passExpiresAt = '';

        try {
          const body = await res.json() as { accessPass?: { tier?: string; expiresAt?: string } };
          passTier = body.accessPass?.tier || passTier;
          passExpiresAt = body.accessPass?.expiresAt || '';
        } catch {
          // Body already consumed or not JSON — decode from JWT
        }

        // If no expiresAt from body, decode from JWT payload
        if (!passExpiresAt) {
          try {
            const parts = jwt.split('.');
            if (parts.length === 3) {
              const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
              passTier = payload.tier || passTier;
              passExpiresAt = new Date(payload.exp * 1000).toISOString();
            }
          } catch {}
        }

        setPassInfo({ tier: passTier, expiresAt: passExpiresAt });
        persistPass(jwt, passTier, passExpiresAt);
        log('Pass purchased and persisted:', passTier, passExpiresAt);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setPurchaseError(error);
      throw error;
    } finally {
      setIsPurchasing(false);
    }
  }, [resourceUrl, client, log]);

  // Fetch with pass — uses ref to always have the latest JWT
  const fetchWithPass = useCallback(async (path: string, init?: RequestInit): Promise<Response> => {
    const url = !path || path === ''
      ? resourceUrl
      : path.startsWith('http')
        ? path
        : `${resourceUrl.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
    const currentJwt = passJwtRef.current;

    if (currentJwt) {
      // Check if JWT is still valid (not expired)
      try {
        const parts = currentJwt.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (payload.exp && payload.exp > Date.now() / 1000) {
            return fetch(url, {
              ...init,
              headers: {
                ...(init?.headers || {}),
                'Authorization': `Bearer ${currentJwt}`,
              },
            });
          }
        }
      } catch {}
      // JWT expired or invalid — clear it
      setPassJwt(null);
      setPassInfo(null);
      try { sessionStorage.removeItem(storageKey); } catch {}
    }

    // No valid pass — use the x402 client (will auto-purchase if configured)
    return client.fetch(url, init);
  }, [resourceUrl, client, storageKey]);

  return {
    tiers,
    customRatePerHour,
    isLoadingTiers,
    pass,
    isPassValid,
    fetchTiers,
    purchasePass,
    isPurchasing,
    purchaseError,
    fetch: fetchWithPass,
  };
}
