/**
 * @dexterai/x402/tab message encoders — moved to @dexterai/vault/messages.
 *
 * The current byte layouts (188-byte V2 session registration, 252-byte
 * revocation, and versioned voucher preimages) are the on-chain protocol
 * contract. Keeping them in the
 * vault package ensures they cannot drift from the instruction builders
 * that consume them.
 *
 * This file is a thin re-export shim so existing consumers of
 * `@dexterai/x402/tab` (and internal imports of `./messages`) continue to
 * resolve to the same byte-identical functions.
 */

export {
  sessionRegisterMessage,
  sessionReplaceV1Message,
  sessionRevokeMessage,
  sessionVoucherV2Nonce,
  sessionVoucherV2AuthorizationNonce,
  finalVoucherV2Sequence,
  voucherV2SequenceOrdinal,
  voucherPayloadMessage,
  buildVoucherMessage,
  type SessionRegisterMessageArgs,
  type SessionReplaceV1MessageArgs,
  type SessionRevokeMessageArgs,
  type VoucherPayloadBytes,
} from '@dexterai/vault/messages';
