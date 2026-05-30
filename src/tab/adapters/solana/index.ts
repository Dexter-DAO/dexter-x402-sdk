/**
 * Solana VaultAdapter — production implementation against the deployed
 * dexter-vault v2 program on Solana mainnet.
 *
 * Two passkey signing paths are supported via the `passkeySigner` field:
 *   - CLI/Node: a noble-curves P-256 signer wrapping a local keypair
 *     (`./passkey-noble.ts`).
 *   - Browser: a WebAuthn-backed signer (lands in Phase 5 / React work).
 *
 * The adapter's job is to (a) take the buyer's session scope, (b) get a
 * passkey signature endorsing it, (c) submit the on-chain
 * register_session_key tx so the seller can verify the endorsement, (d)
 * expose voucher signing for the session, and (e) tear the session down
 * at close.
 *
 * The adapter does NOT touch pending_voucher_count. That counter belongs
 * to the facilitator's dexter_authority and is moved via settle_voucher
 * during seller settlement. The SDK's `Tab.close()` will hand a cumulative
 * voucher to the facilitator in Phase 3; Phase 2 stops at the session
 * register/revoke layer.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  type Signer,
  type ConfirmOptions,
} from '@solana/web3.js';

import type {
  VaultAdapter,
  SessionScope,
  SessionKey,
  VoucherPayload,
  SignedVoucher,
  TabNetworkId,
  AtomicAmount,
} from '../../types';

import {
  buildRegisterSessionKeyInstruction,
  buildRevokeSessionKeyInstruction,
  buildSecp256r1VerifyInstruction,
  DEXTER_VAULT_PROGRAM_ID,
} from '../../instructions';

import {
  sessionRegisterMessage,
  sessionRevokeMessage,
} from '../../messages';

import {
  generateSessionKeypair,
  makeSessionKey,
  signVoucher,
  parseAtomic,
  deriveChannelId,
} from '../../sessions';

import type { P256Keypair, SignedPasskeyPayload } from './passkey-noble';
import { signOperationWithPasskey } from './passkey-noble';

// ── Passkey signer abstraction ─────────────────────────────────────────
//
// We don't bake "noble keypair" into VaultAdapter; instead we accept a
// signer interface. That lets the browser path drop in a WebAuthn-backed
// implementation later without changing the adapter or any caller.

export interface PasskeySigner {
  /** 33-byte SEC1 compressed P-256 public key. The vault stores this on
   *  init; the on-chain verifier compares against it on every passkey-
   *  signed instruction. */
  publicKey: Uint8Array;
  /** Sign an arbitrary operation-message bundle in the WebAuthn shape the
   *  on-chain verifier expects. The CLI path uses noble-curves; the
   *  browser path will use navigator.credentials.get(). */
  signOperation(operationMessage: Uint8Array): Promise<SignedPasskeyPayload>;
}

/** Build a PasskeySigner from a locally-held P-256 keypair (CLI path). */
export function passkeySignerFromP256Keypair(kp: P256Keypair): PasskeySigner {
  return {
    publicKey: kp.publicKey,
    signOperation: async (msg) => signOperationWithPasskey(kp, msg),
  };
}

// ── Adapter options ────────────────────────────────────────────────────

export interface CreateSolanaVaultAdapterOptions {
  /** RPC the adapter uses to submit txs. The buyer can pass their own
   *  connection (browser wallet RPC, Helius URL, etc.) — the adapter has
   *  no opinion. */
  connection: Connection;
  /** The buyer's Swig wallet (holds USDC). */
  swigAddress: string | PublicKey;
  /** The buyer's vault PDA (gate account). */
  vaultPda: string | PublicKey;
  /** The passkey signing path. */
  passkeySigner: PasskeySigner;
  /** Lamport-fee payer. In Phase 2 this is the buyer; later phases may
   *  route through a facilitator co-signer. Required because the buyer's
   *  vault account is not a signer for register/revoke (the passkey
   *  signature in the precompile sibling is the authorization). */
  feePayer: Signer;
  /** Confirmation options for sendAndConfirm. Defaults to 'confirmed' to
   *  match production code (FE/API). For test suites, override to
   *  'finalized' — see reference_anchor_test_commitment in repo memory. */
  confirmOptions?: ConfirmOptions;
}

// ── Adapter implementation ─────────────────────────────────────────────

class SolanaVaultAdapter implements VaultAdapter {
  readonly network: TabNetworkId = 'solana:mainnet';
  readonly swigAddress: string;
  readonly vaultPda: string;

  private readonly connection: Connection;
  private readonly vaultPdaKey: PublicKey;
  private readonly passkey: PasskeySigner;
  private readonly feePayer: Signer;
  private readonly confirmOptions: ConfirmOptions;

  constructor(opts: CreateSolanaVaultAdapterOptions) {
    this.connection = opts.connection;
    this.swigAddress = typeof opts.swigAddress === 'string'
      ? opts.swigAddress
      : opts.swigAddress.toBase58();
    this.vaultPdaKey = typeof opts.vaultPda === 'string'
      ? new PublicKey(opts.vaultPda)
      : opts.vaultPda;
    this.vaultPda = this.vaultPdaKey.toBase58();
    this.passkey = opts.passkeySigner;
    this.feePayer = opts.feePayer;
    this.confirmOptions = opts.confirmOptions ?? { commitment: 'confirmed' };
  }

  /**
   * Authorize a session key on chain. ONE passkey ceremony; submits the
   * register_session_key tx; returns a SessionKey the caller passes to
   * `signWithSession` for every voucher.
   */
  async authorizeSession(scope: SessionScope): Promise<SessionKey> {
    const counterparty = new PublicKey(scope.allowedCounterparty);

    // 1. Generate the in-memory session keypair (ed25519). The PUBLIC key
    //    is what the passkey endorses; the private key never leaves this
    //    process.
    const kp = generateSessionKeypair();

    // 2. Build the canonical 180-byte registration message. The on-chain
    //    program reconstructs this byte-for-byte from its args and
    //    cross-checks against what the precompile verified.
    //    The nonce is an implementation detail of the registration
    //    ceremony, not part of the user-facing scope.
    const nonce = deriveNonce();
    const message = sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: this.vaultPdaKey,
      sessionPubkey: kp.publicKey,
      maxAmount: parseAtomic(scope.maxAmountAtomic),
      expiresAt: BigInt(scope.expiresAtUnix),
      allowedCounterparty: counterparty,
      nonce,
    });

    // 3. Have the passkey sign it. This is the only passkey prompt for
    //    the entire tab lifecycle.
    const signed = await this.passkey.signOperation(message);

    // 4. Build the two-instruction tx: precompile verifier + the vault
    //    instruction. The precompile MUST come first; the vault handler
    //    reads it from the instructions sysvar.
    const precompileIx = buildSecp256r1VerifyInstruction(
      this.passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );
    const registerIx = buildRegisterSessionKeyInstruction({
      vaultPda: this.vaultPdaKey,
      sessionPubkey: kp.publicKey,
      maxAmount: parseAtomic(scope.maxAmountAtomic),
      expiresAt: BigInt(scope.expiresAtUnix),
      allowedCounterparty: counterparty,
      nonce,
      clientDataJSON: signed.clientDataJSON,
      authenticatorData: signed.authenticatorData,
    });

    const tx = new Transaction().add(precompileIx, registerIx);
    tx.feePayer = this.feePayer.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash(
      this.confirmOptions.commitment,
    );
    tx.recentBlockhash = blockhash;
    tx.sign(this.feePayer);

    const sig = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: this.confirmOptions.preflightCommitment ?? this.confirmOptions.commitment,
    });
    await this.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight: (await this.connection.getLatestBlockhash(this.confirmOptions.commitment)).lastValidBlockHeight },
      this.confirmOptions.commitment,
    );

    // 4b. Wait until the active_session is visible at finalized commitment.
    // Production sellers (and our own seller middleware) read at finalized
    // to avoid the read-replica race. Absorbing the wait here means the
    // buyer never hands a tab handle to upstream code until the seller can
    // reliably verify the registration.
    await this.waitForActiveSessionFinalized(kp.publicKey);

    // 5. Bind the keypair to the scope + the registration bytes that
    //    authorized it. Note: the seller's middleware will verify the
    //    registration against an on-chain read of active_session, so
    //    `registration` is the canonical message (not the signature
    //    bundle).
    return makeSessionKey(kp, scope, message);
  }

  /**
   * Sign a voucher with the in-memory session key. Cheap, no I/O, no
   * prompt. Throws if the cumulative amount exceeds the session cap or
   * the session expiry has passed.
   */
  async signWithSession(
    session: SessionKey,
    payload: VoucherPayload,
  ): Promise<SignedVoucher> {
    // The channelId in the payload is a string for portability across
    // JSON boundaries; we re-derive its 32-byte form from the buyer's
    // vault, seller URL, and a nonce here. For now we re-hash the
    // string id — Phase 3 will tighten the contract to require the
    // raw 32 bytes flow through unchanged.
    const channelIdBytes = await hashChannelId(payload.channelId);
    return signVoucher(session, payload, channelIdBytes);
  }

  /**
   * Open-tab on-chain signature. Phase 2 returns the canonical
   * registration message — i.e., the same bytes the seller verifies
   * the passkey signed. The facilitator (Phase 3) will call
   * settle_voucher(increment) separately; this method exists to
   * satisfy the VaultAdapter shape and to give the seller something
   * to bind against if they want to open without a facilitator yet.
   */
  async signOpenTab(session: SessionKey, _channelId: string): Promise<Uint8Array> {
    // The registration bytes ARE the open-tab proof. Anyone with these
    // bytes + a chain read of the vault's active_session can convince
    // themselves the buyer authorized this session.
    return session.registration;
  }

  /**
   * Close-tab on-chain signature. Returns the canonical 128-byte
   * revocation message + submits the revoke_session_key tx on chain.
   *
   * In Phase 3, the facilitator will additionally call
   * settle_voucher(decrement) with the final cumulative voucher
   * presented by the seller, in the same transaction or a follow-up.
   * The buyer's side ends here.
   */
  async signCloseTab(
    session: SessionKey,
    _channelId: string,
    _cumulativeAmount: AtomicAmount,
  ): Promise<Uint8Array> {
    // 1. Build the 128-byte revocation message. The on-chain handler
    //    rejects this if session_pubkey doesn't match active_session.
    const message = sessionRevokeMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: this.vaultPdaKey,
      sessionPubkey: session.publicKey,
    });

    // 2. Passkey-sign the revocation. ONE more prompt at tab close.
    const signed = await this.passkey.signOperation(message);

    // 3. Submit the two-instruction tx.
    const precompileIx = buildSecp256r1VerifyInstruction(
      this.passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );
    const revokeIx = buildRevokeSessionKeyInstruction({
      vaultPda: this.vaultPdaKey,
      clientDataJSON: signed.clientDataJSON,
      authenticatorData: signed.authenticatorData,
    });

    const tx = new Transaction().add(precompileIx, revokeIx);
    tx.feePayer = this.feePayer.publicKey;
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(
      this.confirmOptions.commitment,
    );
    tx.recentBlockhash = blockhash;
    tx.sign(this.feePayer);

    const sig = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: this.confirmOptions.preflightCommitment ?? this.confirmOptions.commitment,
    });
    await this.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      this.confirmOptions.commitment,
    );

    return message;
  }

  /**
   * Block until the vault's active_session_pubkey, read at finalized,
   * matches `expectedSessionPubkey`. Bounds the read-replica race so the
   * seller's verifier (which reads finalized) can always see what the
   * buyer just registered.
   */
  private async waitForActiveSessionFinalized(
    expectedSessionPubkey: Uint8Array,
    timeoutMs = 20_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const acct = await this.connection.getAccountInfo(this.vaultPdaKey, 'finalized');
      if (acct) {
        const data = acct.data;
        const pendingTag = data[83];
        const pendingSize = pendingTag === 1 ? 48 : 0;
        const identityStart = 84 + pendingSize;
        const dexterAuthStart = identityStart + 32;
        const activeSessionTagOffset = dexterAuthStart + 32;
        if (data[activeSessionTagOffset] === 1) {
          const sessionPkStart = activeSessionTagOffset + 1;
          const onChainPk = data.slice(sessionPkStart, sessionPkStart + 32);
          if (bytesEqual(onChainPk, expectedSessionPubkey)) return;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `register_session_key did not become finalized-visible within ${timeoutMs}ms`,
    );
  }
}

/** Factory entry point. */
export function createSolanaVaultAdapter(
  opts: CreateSolanaVaultAdapterOptions,
): VaultAdapter {
  return new SolanaVaultAdapter(opts);
}

// ── Helpers ────────────────────────────────────────────────────────────

function deriveNonce(): number {
  // Process-local monotonic-ish nonce. The on-chain program doesn't
  // enforce monotonicity (non-monotonic nonce is a caller footgun, per
  // the Rust comment on RegisterSessionKeyArgs.nonce). We just want
  // uniqueness within a session.
  // NOTE: avoids Date.now() to stay safe under deterministic-resume
  // harnesses; uses Math.random instead.
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

async function hashChannelId(channelId: string): Promise<Uint8Array> {
  // If the channelId is already a 64-char hex string, use it directly.
  if (/^[0-9a-f]{64}$/i.test(channelId)) {
    return hexToBytes(channelId);
  }
  // Otherwise hash it deterministically. Phase 3 will tighten this.
  const { sha256 } = await import('@noble/hashes/sha256');
  return sha256(new TextEncoder().encode(channelId));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

// Re-export the channel id derivation helper for callers that want to
// pre-compute it and pass it as a hex string.
export { deriveChannelId };
