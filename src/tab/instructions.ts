/**
 * @dexterai/x402/tab instruction builders — moved to @dexterai/vault.
 *
 * The discriminator bytes, account layouts, and precompile encoder are the
 * on-chain protocol contract. Owned by @dexterai/vault to keep them in
 * lockstep with the Rust handlers; re-exported here so existing consumers
 * of `@dexterai/x402/tab` continue to resolve unchanged.
 */

export {
  buildRegisterSessionKeyInstruction,
  buildRevokeSessionKeyInstruction,
  type BuildRegisterSessionKeyArgs,
  type BuildRevokeSessionKeyArgs,
} from '@dexterai/vault/instructions';

export {
  buildSecp256r1VerifyInstruction,
} from '@dexterai/vault/precompile';

export {
  DEXTER_VAULT_PROGRAM_ID,
  SECP256R1_PROGRAM_ID,
  INSTRUCTIONS_SYSVAR_ID,
} from '@dexterai/vault/constants';
