/**
 * @dexterai/x402 Server
 *
 * Server-side helpers for accepting x402 payments.
 * Works with any x402 v2 facilitator.
 *
 * @example
 * ```typescript
 * import { createX402Server } from '@dexterai/x402/server';
 *
 * // Create server for Solana payments
 * const solanaServer = createX402Server({
 *   payTo: 'YourSolanaAddress...',
 *   network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
 * });
 *
 * // Create server for Base payments
 * const baseServer = createX402Server({
 *   payTo: '0xYourEvmAddress...',
 *   network: 'eip155:8453',
 *   asset: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
 * });
 *
 * // In your Express handler:
 * app.post('/protected', async (req, res) => {
 *   const paymentSig = req.headers['payment-signature'];
 *
 *   if (!paymentSig) {
 *     const requirements = await solanaServer.buildRequirements({
 *       amountAtomic: '50000',
 *       resourceUrl: req.originalUrl,
 *     });
 *     res.setHeader('PAYMENT-REQUIRED', solanaServer.encodeRequirements(requirements));
 *     return res.status(402).json({});
 *   }
 *
 *   const result = await solanaServer.settlePayment(paymentSig);
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

// Re-export types for convenience
export type { VerifyResponse, SettleResponse, PaymentRequired, PaymentAccept } from '../types';
export { DEXTER_FACILITATOR_URL, SOLANA_MAINNET_NETWORK, BASE_MAINNET_NETWORK, USDC_MINT, USDC_BASE } from '../types';
