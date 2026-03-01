/**
 * @dexterai/x402 Server
 *
 * Server-side helpers for accepting x402 payments.
 * Works with any x402 v2 facilitator.
 *
 * @example Express Middleware (recommended)
 * ```typescript
 * import express from 'express';
 * import { x402Middleware } from '@dexterai/x402/server';
 *
 * const app = express();
 *
 * // One-liner payment protection
 * app.get('/api/protected',
 *   x402Middleware({
 *     payTo: 'YourSolanaAddress...',
 *     amount: '0.01',  // $0.01 USD
 *   }),
 *   (req, res) => {
 *     // This only runs after successful payment
 *     res.json({ data: 'protected content' });
 *   }
 * );
 * ```
 *
 * @example Manual Server (advanced)
 * ```typescript
 * import { createX402Server } from '@dexterai/x402/server';
 *
 * const server = createX402Server({
 *   payTo: 'YourSolanaAddress...',
 *   network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
 * });
 *
 * app.post('/protected', async (req, res) => {
 *   const paymentSig = req.headers['payment-signature'];
 *
 *   if (!paymentSig) {
 *     const requirements = await server.buildRequirements({
 *       amountAtomic: '50000',
 *       resourceUrl: req.originalUrl,
 *     });
 *     res.setHeader('PAYMENT-REQUIRED', server.encodeRequirements(requirements));
 *     return res.status(402).json({});
 *   }
 *
 *   const result = await server.settlePayment(paymentSig);
 *   if (!result.success) {
 *     return res.status(402).json({ error: result.errorReason });
 *   }
 *
 *   res.json({ data: 'protected content', transaction: result.transaction });
 * });
 * ```
 */

export { createX402Server } from './x402-server';
export type {
  X402ServerConfig,
  X402Server,
  BuildRequirementsOptions,
  AssetConfig,
} from './x402-server';

// Express middleware
export { x402Middleware } from './middleware';
export type { X402MiddlewareConfig, X402Request } from './middleware';

// Browser support -- renders HTML paywall for browser 402 responses
export { x402BrowserSupport } from './browser-support';
export type { X402BrowserSupportConfig } from './browser-support';

// Access pass middleware
export { x402AccessPass } from './access-pass';
export type { X402AccessPassConfig, X402AccessPassRequest } from './access-pass';

export { FacilitatorClient, type SupportedKind, type SupportedResponse } from './facilitator-client';

// Dynamic pricing (character-based)
export { createDynamicPricing, formatPricing } from './dynamic-pricing';
export type { DynamicPricingConfig, DynamicPricing, PriceQuote } from './dynamic-pricing';

// Token pricing (LLM-accurate with tiktoken)
export { 
  createTokenPricing, 
  countTokens, 
  getAvailableModels, 
  isValidModel, 
  formatTokenPricing,
  MODEL_PRICING,
} from './token-pricing';
export type { 
  TokenPricingConfig, 
  TokenPricing, 
  TokenPriceQuote, 
  ModelPricing,
} from './token-pricing';

// Model Registry - the single source of truth for all OpenAI models
export {
  MODEL_REGISTRY,
  MODEL_PRICING_MAP,
  getModel,
  findModel,
  isValidModelId,
  getAvailableModelIds,
  getModelsByTier,
  getModelsByFamily,
  getActiveModels,
  getTextModels,
  getCheapestModel,
  estimateCost,
  formatModelPricing,
} from './model-registry';
export type {
  ModelTier,
  ModelModality,
  ModelApiType,
  ModelPricing as RegistryModelPricing,
  ModelParameters,
  ModelDefinition,
} from './model-registry';

// Stripe machine payments
export { stripePayTo } from './stripe-payto';
export type { StripePayToConfig } from './stripe-payto';

// Re-export types for convenience
export type { VerifyResponse, SettleResponse, PaymentRequired, PaymentAccept, PayToContext, PayToProvider, PayToProviderDefaults, AccessPassTier, AccessPassInfo, AccessPassClaims, AccessPassClientConfig } from '../types';
export { DEXTER_FACILITATOR_URL, SOLANA_MAINNET_NETWORK, BASE_MAINNET_NETWORK, USDC_MINT, USDC_BASE } from '../types';
