/**
 * @dexterai/x402/tab message encoders — moved to @dexterai/vault/messages.
 *
 * The byte layouts (180-byte session registration, 128-byte revocation,
 * 44-byte voucher) are the on-chain protocol contract. Keeping them in the
 * vault package ensures they cannot drift from the instruction builders
 * that consume them.
 *
 * This file is a thin re-export shim so existing consumers of
 * `@dexterai/x402/tab` (and internal imports of `./messages`) continue to
 * resolve to the same byte-identical functions.
 */

export {
  sessionRegisterMessage,
  sessionRevokeMessage,
  voucherPayloadMessage,
  buildVoucherMessage,
  type SessionRegisterMessageArgs,
  type SessionRevokeMessageArgs,
  type VoucherPayloadBytes,
} from '@dexterai/vault/messages';
