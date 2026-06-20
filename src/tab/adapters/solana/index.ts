/**
 * Solana VaultAdapter — production implementation against the deployed
 * dexter-vault v2 program on Solana mainnet.
 *
 * Two passkey signing paths are supported via the `passkeySigner` field,
 * both conforming to vault's canonical `PasskeySignerWithPublicKey`:
 *   - CLI/Node: a noble-curves P-256 signer wrapping a local keypair
 *     (`passkeySignerFromP256Keypair` in `./passkey-noble.ts`).
 *   - Browser: vault's `DexterApiBrowserPasskeySigner` drops in with no shim.
 *
 * The adapter's job is to (a) take the buyer's session scope, (b) get a
 * passkey signature endorsing it, (c) submit the on-chain
 * register_session_key tx so the seller can verify the endorsement, (d)
 * expose voucher signing for the session, and (e) tear the session down
 * at close.
 *
 * The adapter does NOT touch pending_voucher_count. That counter belongs
 * to the facilitator's dexter_authority and is decremented inside the
 * facilitator's `POST /tab/settle` tx (via the new vault.settle_tab_voucher
 * instruction) atomically with the USDC transfer. The SDK's `Tab.close()`
 * POSTs the final voucher to the facilitator; this adapter only owns the
 * passkey-signed session register/revoke layer.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  type Signer,
  type ConfirmOptions,
} from '@solana/web3.js';

import { getAssociatedTokenAddressSync } from '@solana/spl-token';

import { USDC_MINT } from '../../../constants';

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
  deriveSwigWalletAddress,
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

// V6 session-discovery helpers (sibling PDAs for the overcommit gate). Owned by
// @dexterai/vault to stay in lockstep with the on-chain register handler.
import { fetchVaultSessionAccounts, sessionPdasOf, waitForSession } from '@dexterai/vault/session';

import { sha256 } from '@noble/hashes/sha256';

// ── Passkey signer abstraction (unified with @dexterai/vault) ───────────
//
// The adapter consumes vault's canonical signer shape: a 33-byte SEC1
// publicKey + sign(challenge). Both paths conform — node via
// passkeySignerFromP256Keypair, browser via vault's
// DexterApiBrowserPasskeySigner — with NO bridge shim. The adapter owns
// the x402-protocol assembly (challenge = sha256(op); precompileMessage =
// authenticatorData ‖ sha256(clientDataJSON)).

import type { PasskeySignerWithPublicKey as PasskeySigner } from '@dexterai/vault/signers';
export type { PasskeySignerWithPublicKey as PasskeySigner } from '@dexterai/vault/signers';
export { passkeySignerFromP256Keypair } from './passkey-noble';

// ── Adapter options ────────────────────────────────────────────────────

export interface CreateSolanaVaultAdapterOptions {
  /** RPC the adapter uses to submit txs. The buyer can pass their own
   *  connection (browser wallet RPC, Helius URL, etc.) — the adapter has
   *  no opinion. */
  connection: Connection;
  /** The buyer's Swig STATE account (== vault.swig_address — what the
   *  enroller / BUYER_SWIG hands out). The spending-authority wallet PDA
   *  and its USDC ATA are derived from it; do NOT pass the derived wallet
   *  address here. */
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

// ── register_session_key construction ──────────────────────────────────
//
// Extracted from authorizeSession so the EXACT instruction the adapter
// submits on chain is unit-testable without a Connection. Vault 0.4.2's
// builder takes two accounts the adapter must supply:
//   - swigAddress: the Swig STATE account (the builder derives the
//     swig_wallet_address PDA from it itself)
//   - vaultUsdcAta: the swig wallet's USDC ATA, read live on-chain for the
//     Phase 1 overcommit gate (the builder can't derive it — it doesn't
//     know the mint)

export interface AdapterRegisterIxParams {
  vaultPda: PublicKey;
  /** Swig STATE account (== vault.swig_address). */
  swigAddress: PublicKey;
  sessionPubkey: Uint8Array;
  maxAmount: bigint;
  maxRevolvingCapacity: bigint;
  expiresAt: bigint;
  allowedCounterparty: PublicKey;
  nonce: number;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  /** V6: rent payer for the init_if_needed session PDA (the buyer's fee payer). */
  payer: PublicKey;
  /** V6: existing session PDAs for this vault — the overcommit aggregate gate. */
  siblingSessionPdas: PublicKey[];
}

export function buildAdapterRegisterInstruction(p: AdapterRegisterIxParams) {
  // The USDC ATA's owner is the canonical swig WALLET address (a PDA under
  // the Swig program, derived from the state account) — NOT the state
  // account itself. allowOwnerOffCurve must be true for a PDA owner.
  const swigWalletAddress = deriveSwigWalletAddress(p.swigAddress);
  const vaultUsdcAta = getAssociatedTokenAddressSync(
    new PublicKey(USDC_MINT),
    swigWalletAddress,
    true, // allowOwnerOffCurve — swig wallet address is a PDA
  );
  return buildRegisterSessionKeyInstruction({
    vaultPda: p.vaultPda,
    sessionPubkey: p.sessionPubkey,
    maxAmount: p.maxAmount,
    maxRevolvingCapacity: p.maxRevolvingCapacity,
    expiresAt: p.expiresAt,
    allowedCounterparty: p.allowedCounterparty,
    nonce: p.nonce,
    swigAddress: p.swigAddress,
    vaultUsdcAta,
    clientDataJSON: p.clientDataJSON,
    authenticatorData: p.authenticatorData,
    payer: p.payer,
    siblingSessionPdas: p.siblingSessionPdas,
  });
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

    // Revolving capacity defaults to the session's total cap when the caller
    // didn't specify one (revolving cap == total cap). The program requires > 0.
    const maxRevolvingCapacity = parseAtomic(
      scope.revolvingCapacityAtomic ?? scope.maxAmountAtomic,
    );

    // 1. Generate the in-memory session keypair (ed25519). The PUBLIC key
    //    is what the passkey endorses; the private key never leaves this
    //    process.
    const kp = generateSessionKeypair();

    // 2. Build the canonical 188-byte registration message. The on-chain
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
      maxRevolvingCapacity,
      expiresAt: BigInt(scope.expiresAtUnix),
      allowedCounterparty: counterparty,
      nonce,
    });

    // 3. Have the passkey sign it. This is the only passkey prompt for
    //    the entire tab lifecycle. challenge = sha256(operationMessage);
    //    the adapter owns the x402-protocol assembly.
    const challenge = sha256(message);
    const { signature, clientDataJSON, authenticatorData } = await this.passkey.sign(challenge);
    const precompileMessage = concatBytes(authenticatorData, sha256(clientDataJSON));

    // 4. Build the two-instruction tx: precompile verifier + the vault
    //    instruction. The precompile MUST come first; the vault handler
    //    reads it from the instructions sysvar.
    const precompileIx = buildSecp256r1VerifyInstruction(
      this.passkey.publicKey,
      signature,
      precompileMessage,
    );
    // V6: the register ix needs the vault's existing session PDAs (the
    // overcommit aggregate gate sums their caps) + a rent payer for the
    // init_if_needed session PDA being created/replaced.
    const siblingSessionPdas = sessionPdasOf(
      await fetchVaultSessionAccounts(this.connection, this.vaultPdaKey),
    );
    const registerIx = buildAdapterRegisterInstruction({
      vaultPda: this.vaultPdaKey,
      swigAddress: new PublicKey(this.swigAddress),
      sessionPubkey: kp.publicKey,
      maxAmount: parseAtomic(scope.maxAmountAtomic),
      maxRevolvingCapacity,
      expiresAt: BigInt(scope.expiresAtUnix),
      allowedCounterparty: counterparty,
      nonce,
      clientDataJSON,
      authenticatorData,
      payer: this.feePayer.publicKey,
      siblingSessionPdas,
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

    // 4b. Wait until the V6 SessionAccount PDA ([b"session", vault, counterparty])
    // is visible with this session pubkey. V6 stores each session in its own PDA
    // (not inline in the vault), so we wait on the PDA — content-aware confirm so
    // the seller's verifier (and any reader) can reliably see the registration.
    await waitForSession(this.connection, this.vaultPdaKey, counterparty, {
      expectedSessionPubkey: kp.publicKey,
      timeoutMs: 20_000,
    });

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
   * Open-tab on-chain signature. Returns the canonical 180-byte
   * registration message — the same bytes the seller verifies the
   * passkey signed (and the same bytes the facilitator decodes to
   * recover the vault PDA in `POST /tab/settle`). The on-chain
   * `register_session_key` tx that authorizes the session has
   * already landed by the time `openTab()` returns; this method
   * exists so the seller's middleware can bind to the registration
   * without needing a chain read.
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
   * The on-chain settle that actually moves USDC (vault.settle_tab_voucher
   * + swig::SignV2 TransferChecked) is driven by the facilitator's
   * `POST /tab/settle` endpoint — `Tab.close()` POSTs the final voucher
   * there BEFORE invoking this revoke, so by the time this tx lands the
   * session's `spent` and the seller's ATA are already up to date.
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
    const challenge = sha256(message);
    const { signature, clientDataJSON, authenticatorData } = await this.passkey.sign(challenge);
    const precompileMessage = concatBytes(authenticatorData, sha256(clientDataJSON));

    // 3. Submit the two-instruction tx.
    const precompileIx = buildSecp256r1VerifyInstruction(
      this.passkey.publicKey,
      signature,
      precompileMessage,
    );
    const revokeIx = buildRevokeSessionKeyInstruction({
      vaultPda: this.vaultPdaKey,
      // V6: revoke names the per-counterparty session PDA (Borsh arg + seed).
      allowedCounterparty: new PublicKey(session.scope.allowedCounterparty),
      clientDataJSON,
      authenticatorData,
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
}

/** Factory entry point. */
export function createSolanaVaultAdapter(
  opts: CreateSolanaVaultAdapterOptions,
): VaultAdapter {
  return new SolanaVaultAdapter(opts);
}

// ── Helpers ────────────────────────────────────────────────────────────

/** x402-protocol precompile assembly: authenticatorData ‖ sha256(clientDataJSON). */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

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
