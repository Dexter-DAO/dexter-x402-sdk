/**
 * @dexterai/x402/seller: checks a store's signed quote against the store file on its own website, decides what the
 * approval screen may show, and builds and verifies the binding a passkey approval commits to.
 * Browser-safe: no Node built-ins, no client, server or tab code.
 */
export * from './types';
export { checkSellerOffer } from './check';
export { screenSeller } from './screen';
export type { ScreenInput } from './screen';
export {
  SELLER_CHECKER, buildSellerBinding, decodeSellerBinding, encodeSellerBinding, knownSellers,
} from './binding';
export { sellerBindingNonce, newSellerBindingSalt } from './nonce';
export { verifySellerEvidence, verifySellerReceipt, liveSellerStatus } from './verify';
export { sellerOfferFromPaymentRequired } from './offer';
export { addressProofMessage } from './document';
export { registrableDomainOf, displayHost } from './host';
export { jwkThumbprint } from './jwk';
export { DidDocumentUnavailable, defaultFetchDidDocument } from './fetch';
