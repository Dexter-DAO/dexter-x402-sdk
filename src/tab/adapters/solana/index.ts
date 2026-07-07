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

import type {
  VaultAdapter,
  SessionScope,
  SessionKey,
  VoucherPayload,
  SignedVoucher,
  TabNetworkId,
  AtomicAmount,
  AuthorizeSessionOptions,
} from '../../types';
import { LiveSessionExistsError } from '../../types';

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

// V6 session-discovery helpers (sibling PDAs for the overcommit gate) + the
// K-T4e atomic revoke-then-register primitive. Owned by @dexterai/vault to
// stay in lockstep with the on-chain register handler.
import {
  fetchVaultSessionAccounts,
  fetchSessionAccount,
  isSessionLive,
  sessionPdasOf,
  waitForSession,
  resolveVaultUsdcAta,
  composeRevokeThenRegister,
} from '@dexterai/vault/session';
import type { SessionAccountState } from '@dexterai/vault/types';

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import { createSelfPayingComposeSend } from './composeSend';
import type { TransactionInstruction } from '@solana/web3.js';

// ── Passkey signer abstraction (unified with @dexterai/vault) ───────────
//
// The adapter consumes vault 0.19's canonical signer shape: a 33-byte SEC1
// publicKey + signOperation(operationMessage). Both paths conform — node via
// passkeySignerFromP256Keypair, browser via vault's
// DexterApiBrowserPasskeySigner — with NO bridge shim, sharing ONE vault
// (vault is a peerDependency, never bundled). The SIGNER owns the hashing
// locus (challenge = sha256(op), internal); the adapter hands it the RAW
// operation message and only owns the precompile assembly
// (precompileMessage = authenticatorData ‖ sha256(clientDataJSON)).

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
  /** Testing/production seams (default: the real chain readers + the
   *  self-paying v0+ALT compose transport). Same seam idiom as
   *  @dexterai/vault's session helpers. */
  seams?: SolanaAdapterSeams;
}

/** Injectable chain-reader/transport seams for the Solana adapter. */
export interface SolanaAdapterSeams {
  fetchSession?: typeof fetchSessionAccount;
  fetchSessions?: typeof fetchVaultSessionAccounts;
  resolveUsdcAta?: typeof resolveVaultUsdcAta;
  waitForSession?: typeof waitForSession;
  /** Atomic-compose transport override: receives the FULL composed
   *  instruction list ([secp(revoke), revoke, secp(register), register]),
   *  must send + confirm ATOMICALLY in one transaction. Production default:
   *  `createSelfPayingComposeSend` (v0+ALT — the compose does NOT fit a
   *  legacy transaction, K-T4a). */
  composeSend?: (instructions: TransactionInstruction[]) => Promise<string>;
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
  /** The vault swig-wallet's USDC ATA, or `null` for a credit-only vault whose
   *  ATA does not exist on-chain (own-USDC counted as 0). Resolve it through
   *  `@dexterai/vault`'s `resolveVaultUsdcAta` — the SINGLE source of truth for
   *  the derive-and-probe decision. The adapter no longer derives it locally. */
  vaultUsdcAta: PublicKey | null;
}

export function buildAdapterRegisterInstruction(p: AdapterRegisterIxParams) {
  return buildRegisterSessionKeyInstruction({
    vaultPda: p.vaultPda,
    sessionPubkey: p.sessionPubkey,
    maxAmount: p.maxAmount,
    maxRevolvingCapacity: p.maxRevolvingCapacity,
    expiresAt: p.expiresAt,
    allowedCounterparty: p.allowedCounterparty,
    nonce: p.nonce,
    swigAddress: p.swigAddress,
    vaultUsdcAta: p.vaultUsdcAta,
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
  private readonly seams: SolanaAdapterSeams;

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
    this.seams = opts.seams ?? {};
  }

  /**
   * Authorize a session key on chain. ONE passkey ceremony on the fresh
   * path (register only); TWO when atomically replacing a live session
   * (revoke ceremony + register ceremony). Returns a SessionKey the caller
   * passes to `signWithSession` for every voucher.
   *
   * K-T4e — the live-target fork. The session PDA is keyed by
   * (vault, counterparty): re-authorizing against a seller you already hold
   * a LIVE session with resolves to the SAME PDA, and the program's
   * SessionAlreadyActive guard rejects a bare register over it (the
   * pre-guard program silently overwrote it — stranding the old session's
   * unsettled tail). So the adapter reads the PDA FIRST:
   *
   *  - NOT live (absent / cleared / expired) → the bare legacy register,
   *    exactly the pre-K-T4e bytes (937 B — legacy-size safe, K-T4a);
   *  - LIVE + default policy → LiveSessionExistsError (stranding guard;
   *    thrown BEFORE any passkey ceremony is burned);
   *  - LIVE + onLiveSession:'replace' → ONE atomic transaction
   *    [secp(revoke), revoke, secp(register), register] composed via
   *    @dexterai/vault's composeRevokeThenRegister and sent v0+ALT (the
   *    compose overflows a legacy tx even at zero siblings — K-T4a).
   */
  async authorizeSession(scope: SessionScope, opts?: AuthorizeSessionOptions): Promise<SessionKey> {
    const counterparty = new PublicKey(scope.allowedCounterparty);

    // Revolving capacity defaults to the session's total cap when the caller
    // didn't specify one (revolving cap == total cap). The program requires > 0.
    const maxRevolvingCapacity = parseAtomic(
      scope.revolvingCapacityAtomic ?? scope.maxAmountAtomic,
    );

    // 0. K-T4e: read the target session PDA BEFORE anything else. Liveness =
    //    version != 0 AND unexpired (the program's own semantics — expired or
    //    revoke-cleared targets register fresh with no guard conflict).
    const fetchSession = this.seams.fetchSession ?? fetchSessionAccount;
    const existing = await fetchSession(this.connection, this.vaultPdaKey, counterparty);
    const live = existing !== null && isSessionLive(existing);

    if (live && (opts?.onLiveSession ?? 'error') !== 'replace') {
      // STRANDING GUARD: replacing a live session voids any voucher its key
      // signed beyond the on-chain frontier — and the chain cannot see those
      // vouchers. Refuse loudly (with the evidence) unless the caller
      // explicitly acknowledged the replace. Thrown before any passkey
      // ceremony so nothing is burned.
      const spent = existing.session.spent;
      const crystallized = existing.session.crystallizedCumulative;
      throw new LiveSessionExistsError({
        allowedCounterparty: scope.allowedCounterparty,
        sessionPubkeyHex: bytesToHex(existing.session.sessionPubkey),
        expiresAtUnix: existing.session.expiresAt,
        spentAtomic: spent.toString(),
        crystallizedCumulativeAtomic: crystallized.toString(),
        currentOutstandingAtomic: existing.session.currentOutstanding.toString(),
        frontierAtomic: (spent > crystallized ? spent : crystallized).toString(),
      });
    }

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

    // 3. Have the passkey sign it. The signer hashes internally
    //    (challenge = sha256(operationMessage)); the adapter owns only the
    //    precompile assembly.
    const registerCeremony = await this.passkey.signOperation(message);

    if (live) {
      await this.sendAtomicReplace(existing, scope, counterparty, kp.publicKey, nonce, maxRevolvingCapacity, registerCeremony);
    } else {
      await this.sendBareRegister(scope, counterparty, kp.publicKey, nonce, maxRevolvingCapacity, registerCeremony);
    }

    // 4b. Wait until the V6 SessionAccount PDA ([b"session", vault, counterparty])
    // is visible with this session pubkey. V6 stores each session in its own PDA
    // (not inline in the vault), so we wait on the PDA — content-aware confirm so
    // the seller's verifier (and any reader) can reliably see the registration.
    // Content-aware matters double for a replace: existence + version!=0 are
    // BLIND to it (the old registration satisfied both).
    const waitImpl = this.seams.waitForSession ?? waitForSession;
    await waitImpl(this.connection, this.vaultPdaKey, counterparty, {
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
   * The NOT-live path: the bare [secp256r1, register_session_key] legacy
   * transaction — byte-identical to the pre-K-T4e adapter (937 B, fits
   * legacy comfortably; K-T4a proved only the revoke-composed tx overflows).
   */
  private async sendBareRegister(
    scope: SessionScope,
    counterparty: PublicKey,
    sessionPubkey: Uint8Array,
    nonce: number,
    maxRevolvingCapacity: bigint,
    ceremony: { signature: Uint8Array; clientDataJSON: Uint8Array; authenticatorData: Uint8Array },
  ): Promise<void> {
    const { signature, clientDataJSON, authenticatorData } = ceremony;
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
    const fetchSessions = this.seams.fetchSessions ?? fetchVaultSessionAccounts;
    const siblingSessionPdas = sessionPdasOf(
      await fetchSessions(this.connection, this.vaultPdaKey),
    );
    // Resolve the vault's USDC ATA through the SINGLE shared helper: returns the
    // ATA when it exists (funded vault), or null for a credit-only vault whose
    // ATA was never created (own-USDC counts as 0 on-chain). One source of truth
    // for the derive-and-probe decision — the adapter never derives it itself.
    const resolveAta = this.seams.resolveUsdcAta ?? resolveVaultUsdcAta;
    const vaultUsdcAta = await resolveAta(
      this.connection,
      new PublicKey(this.swigAddress),
    );
    const registerIx = buildAdapterRegisterInstruction({
      vaultPda: this.vaultPdaKey,
      swigAddress: new PublicKey(this.swigAddress),
      sessionPubkey,
      maxAmount: parseAtomic(scope.maxAmountAtomic),
      maxRevolvingCapacity,
      expiresAt: BigInt(scope.expiresAtUnix),
      allowedCounterparty: counterparty,
      nonce,
      clientDataJSON,
      authenticatorData,
      payer: this.feePayer.publicKey,
      siblingSessionPdas,
      vaultUsdcAta,
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
  }

  /**
   * The LIVE path: ONE atomic transaction
   * [secp(revoke), revoke_session_key, secp(register), register_session_key]
   * via @dexterai/vault's composeRevokeThenRegister — the buyer is never
   * left sessionless mid-flow, and `live_session_count` is conserved across
   * the pair. Costs a SECOND passkey ceremony (the revoke, bound to the
   * CURRENT live session pubkey — compose re-validates the binding and
   * throws RevokeCeremonyMismatchError if the session rotated since our
   * read, rather than burning the tx on-chain).
   *
   * Transport: v0 + ephemeral ALT (createSelfPayingComposeSend) — the
   * compose measures 1347 B legacy at ZERO siblings, past the 1232 B wire
   * cap (K-T4a). The adapter's feePayer both pays and owns the ALT: the
   * loop's self-paying path and a sponsored path differ only in WHOSE
   * Signer was handed to the adapter.
   */
  private async sendAtomicReplace(
    existing: SessionAccountState,
    scope: SessionScope,
    counterparty: PublicKey,
    sessionPubkey: Uint8Array,
    nonce: number,
    maxRevolvingCapacity: bigint,
    registerCeremony: { signature: Uint8Array; clientDataJSON: Uint8Array; authenticatorData: Uint8Array },
  ): Promise<void> {
    // The revoke ceremony binds to the LIVE session pubkey (the handler
    // rebuilds this message from the PDA's current session_pubkey — a
    // rotated-away pubkey can only revert on-chain, and compose fails fast
    // on the mismatch before submitting).
    const revokeMessage = sessionRevokeMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: this.vaultPdaKey,
      sessionPubkey: existing.session.sessionPubkey,
    });
    const revokeCeremony = await this.passkey.signOperation(revokeMessage);

    const resolveAta = this.seams.resolveUsdcAta ?? resolveVaultUsdcAta;
    const vaultUsdcAta = await resolveAta(this.connection, new PublicKey(this.swigAddress));

    // Transport: injected seam for tests; production = the self-paying
    // v0+ALT sender (ephemeral ALT, deactivated after — fire-and-forget).
    const transport = this.seams.composeSend
      ? { send: this.seams.composeSend, deactivateAlt: async () => {} }
      : createSelfPayingComposeSend(this.connection, this.feePayer, {
          commitment: this.confirmOptions.commitment,
        });

    try {
      await composeRevokeThenRegister({
        connection: this.connection,
        vaultPda: this.vaultPdaKey,
        allowedCounterparty: counterparty,
        registerArgs: {
          sessionPubkey,
          maxAmount: parseAtomic(scope.maxAmountAtomic),
          maxRevolvingCapacity,
          expiresAt: BigInt(scope.expiresAtUnix),
          nonce,
          swigAddress: new PublicKey(this.swigAddress),
          vaultUsdcAta,
          payer: this.feePayer.publicKey,
        },
        registerCeremony: {
          clientDataJSON: registerCeremony.clientDataJSON,
          authenticatorData: registerCeremony.authenticatorData,
          signature: registerCeremony.signature,
        },
        revokeCeremony: {
          clientDataJSON: revokeCeremony.clientDataJSON,
          authenticatorData: revokeCeremony.authenticatorData,
          signature: revokeCeremony.signature,
        },
        credentialPublicKey: this.passkey.publicKey,
        send: transport.send,
        fetchSession: this.seams.fetchSession,
        fetchSessions: this.seams.fetchSessions,
      });
    } finally {
      // Cleanup never gates (or fails) the money op.
      void transport.deactivateAlt();
    }
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

    // 2. Passkey-sign the revocation. ONE more prompt at tab close. The
    //    signer hashes the message internally (challenge = sha256(message)).
    const { signature, clientDataJSON, authenticatorData } = await this.passkey.signOperation(message);
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

// K-T4e surface: the self-paying v0+ALT compose transport (for callers that
// drive composeRevokeThenRegister themselves) + the stranding-guard error.
export {
  createSelfPayingComposeSend,
  collectAltAddresses,
  compileComposeV0,
  TX_SIZE_LIMIT_BYTES,
  type SelfPayingComposeSend,
  type SelfPayingComposeSendOptions,
} from './composeSend';
export { LiveSessionExistsError, type LiveSessionDetails, type AuthorizeSessionOptions } from '../../types';
