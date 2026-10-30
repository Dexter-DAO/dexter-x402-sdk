/**
 * @dexterai/x402/seller: checks a store's signed quote against the store file on its own website, decides what the
 * approval screen may show, and builds and verifies the binding a passkey approval commits to.
 * Browser-safe: no Node built-ins, no client, server or tab code.
 */
export * from './types';
export * from './jcs';
export * from './ed25519';
export * from './jwk';
export * from './jws';
export * from './host';
export * from './fetch';
export * from './document';
export * from './offer';
export * from './nonce';
export { checkSellerOffer } from './check';
export { screenSeller } from './screen';
export type { ScreenInput } from './screen';
export {
  SELLER_CHECKER, buildSellerBinding, decodeSellerBinding, encodeSellerBinding, knownSellers, sellerBindingSha256,
} from './binding';
export { verifySellerEvidence, verifySellerReceipt, liveSellerStatus } from './verify';
export type { SellerEvidenceInput } from './verify';
