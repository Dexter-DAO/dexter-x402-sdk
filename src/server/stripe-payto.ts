/**
 * Stripe Machine Payments — PayTo Provider
 *
 * Generates per-request Stripe deposit addresses via PaymentIntents.
 * Payments land in your Stripe Dashboard with full reporting, taxes, and refunds.
 *
 * Requires `stripe` npm package as a peer dependency.
 *
 * @example
 * ```typescript
 * import { x402Middleware, stripePayTo } from '@dexterai/x402/server';
 *
 * app.use('/api/data', x402Middleware({
 *   amount: '0.01',
 *   payTo: stripePayTo(process.env.STRIPE_SECRET_KEY),
 * }));
 * ```
 *
 * @see https://docs.stripe.com/payments/machine
 */

import type { PayToContext, PayToProvider } from '../types';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for the Stripe PayTo provider.
 */
export interface StripePayToConfig {
  /** Stripe secret key (sk_test_... or sk_live_...) */
  secretKey: string;

  /**
   * Stripe API version to use.
   * @default '2026-01-28.clover'
   */
  apiVersion?: string;

  /**
   * Target network for deposit addresses.
   * - 'base' → Base mainnet (eip155:8453)
   * - 'base-sepolia' → Base Sepolia testnet (eip155:84532)
   * @default 'base'
   */
  network?: 'base' | 'base-sepolia';
}

// Map our network names to Stripe deposit_addresses keys
const STRIPE_NETWORK_KEYS: Record<string, string> = {
  'base': 'base',
  'base-sepolia': 'base_sepolia',
};

// Map our network names to CAIP-2 identifiers
const CAIP2_NETWORKS: Record<string, string> = {
  'base': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
};

// USDC has 6 decimals
const USDC_DECIMALS = 6;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a Stripe-backed PayTo provider for x402 machine payments.
 *
 * On each new request, creates a Stripe PaymentIntent with a crypto deposit address.
 * When the agent sends USDC to that address, Stripe auto-captures the payment.
 * Payments appear in your Stripe Dashboard like any other transaction.
 *
 * @param secretKeyOrConfig - Stripe secret key string, or full config object
 * @returns A PayToProvider function with auto-configuration defaults
 *
 * @example Minimal usage
 * ```typescript
 * const provider = stripePayTo('sk_test_...');
 * ```
 *
 * @example With config
 * ```typescript
 * const provider = stripePayTo({
 *   secretKey: 'sk_test_...',
 *   network: 'base-sepolia',  // testnet
 * });
 * ```
 */
export function stripePayTo(
  secretKeyOrConfig: string | StripePayToConfig,
): PayToProvider {
  const config: StripePayToConfig =
    typeof secretKeyOrConfig === 'string'
      ? { secretKey: secretKeyOrConfig }
      : secretKeyOrConfig;

  const networkName = config.network ?? 'base';
  const stripeNetworkKey = STRIPE_NETWORK_KEYS[networkName] ?? 'base';
  const caip2Network = CAIP2_NETWORKS[networkName] ?? 'eip155:8453';
  const apiVersion = config.apiVersion ?? '2026-01-28.clover';

  // Lazy-loaded Stripe client (avoids import errors when stripe isn't installed)
  let stripeClient: any = null;

  async function getStripe(): Promise<any> {
    if (stripeClient) return stripeClient;

    try {
      // Dynamic import so stripe is not required at bundle time
      const { default: Stripe } = await import('stripe');
      stripeClient = new Stripe(config.secretKey, {
        apiVersion: apiVersion as any,
        appInfo: {
          name: '@dexterai/x402',
          url: 'https://dexter.cash/sdk',
        },
      });
      return stripeClient;
    } catch {
      throw new Error(
        'The "stripe" package is required for stripePayTo(). ' +
        'Install it with: npm install stripe',
      );
    }
  }

  // The provider function
  const provider: PayToProvider = async (context: PayToContext): Promise<string> => {
    // ---------------------------------------------------------------
    // Retry path: extract the deposit address from the payment header
    // ---------------------------------------------------------------
    if (context.paymentHeader) {
      try {
        const decoded = JSON.parse(
          Buffer.from(context.paymentHeader, 'base64').toString(),
        );
        // EVM: address is in payload.authorization.to
        const toAddress = decoded.payload?.authorization?.to;
        if (toAddress && typeof toAddress === 'string') {
          return toAddress;
        }
        // Fallback: check accepted.payTo
        const acceptedPayTo = decoded.accepted?.payTo;
        if (acceptedPayTo && typeof acceptedPayTo === 'string') {
          return acceptedPayTo;
        }
      } catch {
        // Fall through to error
      }
      throw new Error(
        'Could not extract deposit address from payment header. ' +
        'Ensure the client is sending a valid x402 PAYMENT-SIGNATURE.',
      );
    }

    // ---------------------------------------------------------------
    // Initial path: create a Stripe PaymentIntent for a deposit address
    // ---------------------------------------------------------------
    const stripe = await getStripe();

    // Convert atomic USDC to Stripe cents
    // 10000 atomic USDC (6 decimals) = 0.01 USDC = $0.01 = 1 cent
    const amountAtomic = context.amountAtomic ? parseInt(context.amountAtomic, 10) : 10000;
    const amountInCents = Math.max(1, Math.round(amountAtomic / Math.pow(10, USDC_DECIMALS - 2)));

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'usd',
      payment_method_types: ['crypto'],
      payment_method_data: {
        type: 'crypto',
      },
      payment_method_options: {
        crypto: {
          mode: 'custom',
        },
      },
      confirm: true,
    });

    // Extract the deposit address from the PaymentIntent's next_action
    const nextAction = paymentIntent.next_action as any;
    if (!nextAction?.crypto_collect_deposit_details) {
      throw new Error(
        'Stripe PaymentIntent did not return crypto deposit details. ' +
        'Ensure your Stripe account has crypto payins enabled: ' +
        'https://support.stripe.com/questions/get-started-with-pay-with-crypto',
      );
    }

    const depositDetails = nextAction.crypto_collect_deposit_details;
    const payToAddress: string | undefined =
      depositDetails.deposit_addresses?.[stripeNetworkKey]?.address;

    if (!payToAddress) {
      throw new Error(
        `No deposit address found for network "${stripeNetworkKey}". ` +
        `Available networks: ${Object.keys(depositDetails.deposit_addresses || {}).join(', ')}`,
      );
    }

    return payToAddress;
  };

  // Attach auto-configuration defaults so the middleware can set
  // network and facilitator automatically when Stripe is used
  provider._x402Defaults = {
    network: caip2Network,
    facilitatorUrl: 'https://x402.dexter.cash',
  };

  return provider;
}
