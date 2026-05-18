/**
 * The x402 version seam. The single entrypoint for paying x402
 * endpoints — handles v1 and v2 transparently.
 */
export { payAndFetch, detectStrategy } from './dispatcher';
export { toNetworkRef } from './network-map';
export { toSiwxSigner } from './siwx-signer';
export type {
  PaymentStrategy,
  PaymentChallenge,
  ChallengeOption,
  PayResult,
  PayAndFetchOptions,
  NetworkRef,
} from './types';
