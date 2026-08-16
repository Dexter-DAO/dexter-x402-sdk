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
 * The adapter does NOT mutate pending_voucher_count. That counter belongs
 * to the facilitator's dexter_authority and is decremented inside the
 * facilitator's `POST /tab/settle` tx atomically with the USDC transfer.
 * After that POST lands, the adapter reads the Vault counter and SessionAccount
 * in one RPC context and binds both into the passkey-signed V3 revocation.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  type Signer,
  type ConfirmOptions,
  type Commitment,
} from '@solana/web3.js';
import bs58 from 'bs58';

import type {
  VaultAdapter,
  SessionScope,
  SessionKey,
  VoucherPayload,
  SignedVoucher,
  TabNetworkId,
  AtomicAmount,
  AuthorizeSessionOptions,
  FinalVoucherV2ReservationInput,
  FinalVoucherV2ReservationReceipt,
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
  sessionReplaceV1Message,
  sessionRevokeMessage,
  sessionVoucherV2Nonce,
} from '../../messages';

import {
  generateSessionKeypair,
  makeSessionKey,
  signContextBoundFinalVoucherV2,
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
  decodeSessionAccount,
  deriveSessionPda,
  isSessionLive,
  sessionPdasOf,
  waitForSession,
  resolveVaultUsdcAta,
  composeRevokeThenRegister,
} from '@dexterai/vault/session';
import { decodeVaultFull } from '@dexterai/vault/reader';
import {
  fetchPasskeyAuthorizationState,
  validatePasskeyAuthorizationClientData,
} from '@dexterai/vault';
import { parseRegistration } from '../../seller/verify';

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import { createSelfPayingComposeSend } from './composeSend';
import { verifySolanaFinalVoucherV2Reservation } from './reservation-verifier';
import type { TransactionInstruction } from '@solana/web3.js';

// ── Passkey signer abstraction (unified with @dexterai/vault) ───────────
//
// The adapter consumes Vault 0.43.2's canonical signer shape: a 33-byte SEC1
// publicKey + signOperation(operationMessage). Both paths conform — node via
// passkeySignerFromP256Keypair, browser via vault's
// DexterApiBrowserPasskeySigner — with NO bridge shim, sharing ONE vault
// (vault is an exact peerDependency, never bundled). The SIGNER owns the
// canonical V7 challenge policy (program, vault, monotonic guard nonce,
// operation hash, and fresh entropy); the adapter hands it the RAW operation
// message and only owns the precompile assembly
// (precompileMessage = authenticatorData ‖ sha256(clientDataJSON)).

import type { PasskeySignerWithPublicKey as PasskeySigner } from '@dexterai/vault/signers';
export type { PasskeySignerWithPublicKey as PasskeySigner } from '@dexterai/vault/signers';
export { passkeySignerFromP256Keypair } from './passkey-noble';
export {
  createSolanaFinalVoucherV2ReservationVerifier,
  inspectSolanaFinalVoucherV2Reservation,
  verifySolanaFinalVoucherV2Reservation,
  SolanaFinalVoucherV2ReservationError,
  SOLANA_FINAL_VOUCHER_V2_MEMO_PROGRAM_ID,
  SOLANA_FINAL_VOUCHER_V2_PROGRAM_ID,
  type SolanaReservationPostStateEvidence,
  type SolanaReservationTransactionEvidence,
  type SolanaReservationVerifierSeams,
  type SolanaFinalVoucherV2ReservationVerification,
} from './reservation-verifier';

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
  /** Confirmation/preflight options for registration and replacement.
   *  Defaults to `confirmed` to match those existing paths. Session close is
   *  stricter: it always proves the exact revoke at `finalized` before the SDK
   *  reports the credential revoked or allows the key to be wiped. */
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
  fetchPasskeyAuthorization?: typeof fetchPasskeyAuthorizationState;
  readCloseRevocationSnapshot?: ReadCloseRevocationSnapshot;
  /** Full target-state reader used by close retry reconciliation. Unlike the
   *  legacy snapshot seam, this can prove that the old credential is already
   *  cleared or has been replaced without ever targeting the replacement. */
  readCloseRevocationTargetState?: ReadCloseRevocationTargetState;
  resolveUsdcAta?: typeof resolveVaultUsdcAta;
  waitForSession?: typeof waitForSession;
  /** Atomic-compose transport override: receives the FULL composed
   *  instruction list ([secp(replace), replace] for a live V7 target),
   *  must send + confirm ATOMICALLY in one transaction. Production default:
   *  `createSelfPayingComposeSend` (v0+ALT — the compose does NOT fit a
   *  legacy transaction, K-T4a). */
  composeSend?: (instructions: TransactionInstruction[]) => Promise<string>;
}

interface CloseRevocationSnapshot {
  contextSlot: number;
  programId: PublicKey;
  vaultPda: PublicKey;
  sessionPda: PublicKey;
  sessionPubkey: Uint8Array;
  maxAmount: bigint;
  expiresAt: bigint;
  allowedCounterparty: PublicKey;
  nonce: number;
  spent: bigint;
  currentOutstanding: bigint;
  maxRevolvingCapacity: bigint;
  crystallizedCumulative: bigint;
  lastLockedSequence: number;
  expectedPendingVoucherCount: number;
}

interface ReadCloseRevocationSnapshotArgs {
  connection: Connection;
  vaultPda: PublicKey;
  allowedCounterparty: PublicKey;
  programId?: PublicKey;
  commitment?: Commitment;
}

type ReadCloseRevocationSnapshot = (
  args: ReadCloseRevocationSnapshotArgs,
) => Promise<CloseRevocationSnapshot>;

type CloseRevocationTargetState =
  | { kind: 'live'; snapshot: CloseRevocationSnapshot }
  | {
      kind: 'invalidated';
      contextSlot: number;
      sessionPda: PublicKey;
      reason: 'absent' | 'cleared';
    };

type ReadCloseRevocationTargetState = (
  args: ReadCloseRevocationSnapshotArgs,
) => Promise<CloseRevocationTargetState>;

/**
 * Read the Vault's global pending-voucher counter and the named SessionAccount
 * in one RPC context. The V3 revocation ceremony must bind one state that
 * actually existed; split reads could combine values from different slots.
 */
async function readCloseRevocationTargetState({
  connection,
  vaultPda,
  allowedCounterparty,
  programId = DEXTER_VAULT_PROGRAM_ID,
  commitment = 'finalized',
}: ReadCloseRevocationSnapshotArgs): Promise<CloseRevocationTargetState> {
  const [sessionPda] = deriveSessionPda(
    vaultPda,
    allowedCounterparty,
    programId,
  );
  const response = await connection.getMultipleAccountsInfoAndContext(
    [vaultPda, sessionPda],
    { commitment },
  );
  const [vaultAccount, sessionAccount] = response.value;
  if (!vaultAccount) {
    throw new Error('close revocation: vault account not found');
  }
  if (!vaultAccount.owner.equals(programId)) {
    throw new Error('close revocation: vault has the wrong owner');
  }

  const vault = decodeVaultFull(Buffer.from(vaultAccount.data));
  if (!vault.exists || vault.version !== 7) {
    throw new Error('close revocation: Vault V7 required');
  }
  if (!sessionAccount) {
    return {
      kind: 'invalidated',
      contextSlot: response.context.slot,
      sessionPda,
      reason: 'absent',
    };
  }
  if (!sessionAccount.owner.equals(programId)) {
    throw new Error('close revocation: session has the wrong owner');
  }

  const session = decodeSessionAccount(sessionPda, sessionAccount.data);
  if (session.version === 0) {
    return {
      kind: 'invalidated',
      contextSlot: response.context.slot,
      sessionPda,
      reason: 'cleared',
    };
  }
  if (session.version !== 1) {
    throw new Error('close revocation: live SessionAccount required');
  }
  if (session.vault !== vaultPda.toBase58()) {
    throw new Error('close revocation: session belongs to a different vault');
  }
  if (session.session.allowedCounterparty !== allowedCounterparty.toBase58()) {
    throw new Error('close revocation: session counterparty mismatch');
  }

  return {
    kind: 'live',
    snapshot: {
      contextSlot: response.context.slot,
      programId: new PublicKey(programId),
      vaultPda: new PublicKey(vaultPda),
      sessionPda,
      sessionPubkey: Uint8Array.from(session.session.sessionPubkey),
      maxAmount: session.session.maxAmount,
      // Preserve the signed i64 exactly instead of round-tripping through a JS
      // number. This is the fixed SessionAccount expiry offset in Vault V7.
      expiresAt: Buffer.from(sessionAccount.data).readBigInt64LE(82),
      allowedCounterparty: new PublicKey(allowedCounterparty),
      nonce: session.session.nonce,
      spent: session.session.spent,
      currentOutstanding: session.session.currentOutstanding,
      maxRevolvingCapacity: session.session.maxRevolvingCapacity,
      crystallizedCumulative: session.session.crystallizedCumulative,
      lastLockedSequence: session.session.lastLockedSequence,
      expectedPendingVoucherCount: vault.pendingVoucherCount,
    },
  };
}

interface PendingCloseRevocation {
  key: string;
  message: Uint8Array;
  serializedTransaction: Uint8Array;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  finalizedHistoryFloorSlot: number | null;
}

type PendingCloseReconciliation = 'complete' | 'fresh_allowed' | 'unresolved';

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
  readonly sessionVoucherVersion = 2 as const;
  readonly swigAddress: string;
  readonly vaultPda: string;

  private readonly connection: Connection;
  private readonly vaultPdaKey: PublicKey;
  private readonly passkey: PasskeySigner;
  private readonly feePayer: Signer;
  private readonly confirmOptions: ConfirmOptions;
  private readonly seams: SolanaAdapterSeams;
  /** Exact close wires survive transport ambiguity for the lifetime of this
   * adapter. A retry must reconcile one of these before it may prompt/sign a
   * replacement revoke. */
  private readonly pendingCloseRevocations = new Map<string, PendingCloseRevocation>();
  private readonly completedCloseRevocations = new Map<string, Uint8Array>();

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

  private closeRevocationKey(session: SessionKey): string {
    const registration = parseRegistration(session.registration);
    const [sessionPda] = deriveSessionPda(
      this.vaultPdaKey,
      registration.allowedCounterparty,
      DEXTER_VAULT_PROGRAM_ID,
    );
    return [
      sessionPda.toBase58(),
      bytesToHex(registration.sessionPubkey),
      registration.nonce.toString(),
    ].join(':');
  }

  private async readCloseTargetState(
    allowedCounterparty: PublicKey,
  ): Promise<CloseRevocationTargetState | null> {
    const args: ReadCloseRevocationSnapshotArgs = {
      connection: this.connection,
      vaultPda: this.vaultPdaKey,
      allowedCounterparty,
      programId: DEXTER_VAULT_PROGRAM_ID,
      commitment: 'finalized',
    };
    if (this.seams.readCloseRevocationTargetState) {
      return this.seams.readCloseRevocationTargetState(args);
    }
    if (this.seams.readCloseRevocationSnapshot) {
      try {
        return {
          kind: 'live',
          snapshot: await this.seams.readCloseRevocationSnapshot(args),
        };
      } catch {
        // The older seam cannot distinguish a cleared target from an RPC or
        // decoding failure. Never manufacture invalidation proof from it.
        return null;
      }
    }
    return readCloseRevocationTargetState(args);
  }

  private targetInvalidated(
    state: CloseRevocationTargetState,
    registration: ReturnType<typeof parseRegistration>,
  ): boolean {
    if (state.kind === 'invalidated') return true;
    const snapshot = state.snapshot;
    const [expectedSessionPda] = deriveSessionPda(
      this.vaultPdaKey,
      registration.allowedCounterparty,
      DEXTER_VAULT_PROGRAM_ID,
    );
    if (
      !snapshot.programId.equals(DEXTER_VAULT_PROGRAM_ID)
      || !snapshot.vaultPda.equals(this.vaultPdaKey)
      || !snapshot.sessionPda.equals(expectedSessionPda)
      || !snapshot.allowedCounterparty.equals(registration.allowedCounterparty)
    ) {
      throw new Error('session revocation snapshot identity mismatch');
    }
    // The PDA is seller-scoped and can be reused by an atomic replacement.
    // A different key or generation means the old credential is already dead;
    // it is success for this close, never a reason to revoke the replacement.
    if (
      !Buffer.from(snapshot.sessionPubkey)
        .equals(Buffer.from(registration.sessionPubkey))
      || snapshot.nonce !== registration.nonce
    ) {
      return true;
    }
    if (
      snapshot.maxAmount !== registration.maxAmount
      || snapshot.expiresAt !== registration.expiresAt
      || snapshot.maxRevolvingCapacity !== registration.maxRevolvingCapacity
    ) {
      throw new Error('session revocation snapshot identity mismatch');
    }
    return false;
  }

  private rememberCompletedClose(
    key: string,
    message: Uint8Array,
  ): Uint8Array {
    const stable = Uint8Array.from(message);
    this.pendingCloseRevocations.delete(key);
    this.completedCloseRevocations.set(key, stable);
    return Uint8Array.from(stable);
  }

  private async reconcilePendingClose(
    pending: PendingCloseRevocation,
    registration: ReturnType<typeof parseRegistration>,
    allowExactRebroadcast: boolean,
  ): Promise<PendingCloseReconciliation> {
    let statusRead = false;
    let observedStatus: Awaited<ReturnType<Connection['getSignatureStatuses']>>['value'][number]
      = null;
    try {
      const response = await this.connection.getSignatureStatuses(
        [pending.signature],
        { searchTransactionHistory: true },
      );
      statusRead = true;
      observedStatus = response.value[0] ?? null;
      if (observedStatus?.confirmationStatus === 'finalized') {
        return observedStatus.err === null ? 'complete' : 'fresh_allowed';
      }
    } catch {
      // Finalized transaction history and target state below are independent
      // reconciliation sources; a transient status RPC cannot authorize a
      // replacement transaction.
    }

    let finalizedTransactionRead = false;
    try {
      const transaction = await this.connection.getTransaction(
        pending.signature,
        { commitment: 'finalized', maxSupportedTransactionVersion: 0 },
      );
      finalizedTransactionRead = true;
      if (transaction) {
        if (!transaction.meta || !Object.prototype.hasOwnProperty.call(transaction.meta, 'err')) {
          return 'unresolved';
        }
        return transaction.meta.err === null ? 'complete' : 'fresh_allowed';
      }
    } catch {
      // Absence is usable only when the finalized history read itself
      // succeeded and history coverage is independently proven below.
    }

    const target = await this.readCloseTargetState(
      registration.allowedCounterparty,
    ).catch(() => null);
    if (target && this.targetInvalidated(target, registration)) {
      return 'complete';
    }

    // A transport exception may have happened before the original wire
    // reached any validator. While its blockhash is still live, a caller retry
    // may rebroadcast only the byte-identical transaction and confirm that
    // same signature to finality—never sign a second revoke.
    if (allowExactRebroadcast && statusRead && observedStatus === null) {
      try {
        const validity = await this.connection.isBlockhashValid(
          pending.blockhash,
          { commitment: 'confirmed' },
        );
        if (validity.value) {
          const returnedSignature = await this.connection.sendRawTransaction(
            pending.serializedTransaction,
            {
              skipPreflight: false,
              preflightCommitment:
                this.confirmOptions.preflightCommitment
                ?? this.confirmOptions.commitment,
            },
          );
          if (returnedSignature !== pending.signature) return 'unresolved';
          const confirmation = await this.connection.confirmTransaction(
            {
              signature: pending.signature,
              blockhash: pending.blockhash,
              lastValidBlockHeight: pending.lastValidBlockHeight,
            },
            'finalized',
          );
          return confirmation.value.err === null
            ? 'complete'
            : 'fresh_allowed';
        }
      } catch {
        // Retain the exact wire. A later retry can poll/rebroadcast it, or a
        // finalized expiry proof can eventually permit a fresh ceremony.
      }
    }

    // Any non-final status is positive evidence that this exact wire landed
    // on a live fork. Blockhash expiry is only admission expiry; it does not
    // invalidate a transaction that already landed and may still finalize.
    // Therefore history/height absence may authorize a fresh revoke only
    // when the history-aware signature read itself returned exact absence.
    if (statusRead && observedStatus !== null) {
      return 'unresolved';
    }

    if (
      !statusRead
      || !finalizedTransactionRead
      || pending.finalizedHistoryFloorSlot === null
    ) {
      return 'unresolved';
    }
    try {
      const [finalizedBlockHeight, minimumLedgerSlot] = await Promise.all([
        this.connection.getBlockHeight('finalized'),
        this.connection.getMinimumLedgerSlot(),
      ]);
      if (
        finalizedBlockHeight > pending.lastValidBlockHeight
        && minimumLedgerSlot <= pending.finalizedHistoryFloorSlot
      ) {
        return 'fresh_allowed';
      }
    } catch {
      // No invented expiry/nonlanding proof.
    }
    return 'unresolved';
  }

  /**
   * Authorize a session key on chain. Exactly ONE passkey ceremony on either
   * the fresh register path or the context-bound live replacement path.
   * Returns a SessionKey the caller
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
   *    [secp(replace), replace_session_key_v1] composed via
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

    // 1. Read the permanent per-vault authorization guard before constructing
    //    any operation bytes. V7 session nonces are not random: the high bit
    //    marks context-bound V2 and the low 31 bits MUST equal this exact
    //    guard generation. Missing/malformed guard state cannot be guessed.
    const fetchAuthorization =
      this.seams.fetchPasskeyAuthorization ?? fetchPasskeyAuthorizationState;
    const authorization = await fetchAuthorization(
      this.connection,
      this.vaultPdaKey,
      DEXTER_VAULT_PROGRAM_ID,
    );
    if (
      authorization === null
      || authorization.version !== 1
      || !authorization.vault.equals(this.vaultPdaKey)
    ) {
      throw new Error('passkey_authorization_guard_unavailable');
    }

    // 2. Generate the in-memory session keypair (ed25519). The PUBLIC key
    //    is what the passkey endorses; the private key never leaves this
    //    process.
    const kp = generateSessionKeypair();

    // 3. Build the canonical V2 registration. A live replacement signs the
    //    complete current SessionAccount snapshot plus the exact guard nonce;
    //    the program preserves its accepted meters instead of clearing them.
    const nonce = sessionVoucherV2Nonce(authorization.nonce);
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
    const operationMessage = live
      ? sessionReplaceV1Message({
          programId: DEXTER_VAULT_PROGRAM_ID,
          vaultPda: this.vaultPdaKey,
          sessionPda: new PublicKey(existing.address),
          authorizationNonce: authorization.nonce,
          retired: {
            sessionPubkey: existing.session.sessionPubkey,
            maxAmount: existing.session.maxAmount,
            expiresAt: BigInt(existing.session.expiresAt),
            allowedCounterparty: new PublicKey(
              existing.session.allowedCounterparty,
            ),
            nonce: existing.session.nonce,
            spent: existing.session.spent,
            currentOutstanding: existing.session.currentOutstanding,
            maxRevolvingCapacity:
              existing.session.maxRevolvingCapacity,
            crystallizedCumulative:
              existing.session.crystallizedCumulative,
            lastLockedSequence: existing.session.lastLockedSequence,
          },
          replacement: {
            sessionPubkey: kp.publicKey,
            maxAmount: parseAtomic(scope.maxAmountAtomic),
            expiresAt: BigInt(scope.expiresAtUnix),
            allowedCounterparty: counterparty,
            nonce,
            maxRevolvingCapacity,
          },
        })
      : message;

    // 4. One passkey ceremony binds the complete operation. The browser
    //    signer obtains the canonical 200-byte challenge from Dexter policy;
    //    the compose independently re-reads and validates the live snapshot.
    const registerCeremony = await this.passkey.signOperation(operationMessage);

    if (live) {
      await this.sendAtomicReplace(
        scope,
        counterparty,
        kp.publicKey,
        nonce,
        maxRevolvingCapacity,
        registerCeremony,
      );
    } else {
      const signedAuthorization = validatePasskeyAuthorizationClientData({
        clientDataJSON: registerCeremony.clientDataJSON,
        operationMessage,
        expectedVault: this.vaultPdaKey,
        expectedProgramId: DEXTER_VAULT_PROGRAM_ID,
      });
      if (signedAuthorization.nonce !== authorization.nonce) {
        throw new Error('passkey_authorization_guard_changed');
      }
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
   * The LIVE path: ONE atomic [secp(replace), replace_session_key_v1]
   * transaction via @dexterai/vault's compatibility-named
   * composeRevokeThenRegister. The buyer is never left sessionless, accepted
   * meters survive, and a session/guard race fails before transport.
   */
  private async sendAtomicReplace(
    scope: SessionScope,
    counterparty: PublicKey,
    sessionPubkey: Uint8Array,
    nonce: number,
    maxRevolvingCapacity: bigint,
    registerCeremony: { signature: Uint8Array; clientDataJSON: Uint8Array; authenticatorData: Uint8Array },
  ): Promise<void> {
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
        credentialPublicKey: this.passkey.publicKey,
        send: transport.send,
        fetchSession: this.seams.fetchSession,
        fetchSessions: this.seams.fetchSessions,
        fetchPasskeyAuthorization: this.seams.fetchPasskeyAuthorization,
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
    const registration = parseRegistration(session.registration);
    if ((registration.nonce & 0x8000_0000) !== 0) {
      const [sessionPda] = deriveSessionPda(
        registration.vaultPda,
        registration.allowedCounterparty,
        registration.programId,
      );
      const signed = signContextBoundFinalVoucherV2({
        programId: registration.programId.toBase58(),
        vaultPda: registration.vaultPda.toBase58(),
        sessionPda: sessionPda.toBase58(),
        seller: registration.allowedCounterparty.toBase58(),
        sessionNonce: registration.nonce,
        channelId: bytesToHex(channelIdBytes),
        cumulativeAmountAtomic: payload.cumulativeAmount,
        sequenceOrdinal: payload.sequenceNumber,
        sessionPrivateKey: session.privateKey,
        sessionPublicKey: session.publicKey,
        sessionRegistration: session.registration,
      });
      return {
        payload: {
          channelId: signed.channelId,
          cumulativeAmount: signed.cumulativeAmount,
          sequenceNumber: signed.sequenceNumber,
        },
        sessionPublicKey: Uint8Array.from(
          Buffer.from(signed.sessionPublicKey, 'hex'),
        ),
        sessionSignature: Uint8Array.from(
          Buffer.from(signed.sessionSignature, 'hex'),
        ),
        sessionRegistration: Uint8Array.from(
          Buffer.from(signed.sessionRegistration, 'hex'),
        ),
      };
    }
    return signVoucher(session, payload, channelIdBytes);
  }

  /**
   * Open-tab on-chain signature. Returns the canonical 188-byte V2
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

  async verifyFinalVoucherV2Reservation(
    input: FinalVoucherV2ReservationInput,
    receipt: FinalVoucherV2ReservationReceipt,
  ): Promise<void> {
    await verifySolanaFinalVoucherV2Reservation(
      this.connection,
      input,
      receipt,
    );
  }

  /**
   * Close-tab on-chain signature. Returns the canonical versioned
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
    const registration = parseRegistration(session.registration);
    if (
      !registration.vaultPda.equals(this.vaultPdaKey)
      || !Buffer.from(registration.sessionPubkey)
        .equals(Buffer.from(session.publicKey))
    ) {
      throw new Error('session registration identity mismatch');
    }
    const key = this.closeRevocationKey(session);
    const completed = this.completedCloseRevocations.get(key);
    if (completed) return Uint8Array.from(completed);

    // Reconcile an earlier exact signed wire before any new passkey prompt.
    // A finalized success, or a finalized target read proving the old
    // credential cleared/replaced, completes this close. Only finalized
    // failure or history-covered expiry/absence permits a fresh ceremony.
    const existing = this.pendingCloseRevocations.get(key);
    if (existing) {
      const reconciliation = await this.reconcilePendingClose(
        existing,
        registration,
        true,
      );
      if (reconciliation === 'complete') {
        return this.rememberCompletedClose(key, existing.message);
      }
      if (reconciliation === 'unresolved') {
        throw new Error(
          `session revoke finality unresolved for ${existing.signature}; retry close`,
        );
      }
      this.pendingCloseRevocations.delete(key);
    }

    // 1. Read the Vault and SessionAccount together at finalized commitment
    //    AFTER Tab.close() has awaited settlement. V3 binds every live meter
    //    plus the exact global pending count; placeholders or split-slot reads
    //    would reopen a race. A cleared/replaced old credential is already the
    //    desired terminal condition and must never target the replacement.
    const target = await this.readCloseTargetState(
      registration.allowedCounterparty,
    );
    if (!target) {
      throw new Error('close revocation target state unavailable');
    }
    if (
      target.kind === 'invalidated'
      || this.targetInvalidated(target, registration)
    ) {
      return this.rememberCompletedClose(key, session.registration);
    }
    const snapshot = target.snapshot;

    // A successful/covered settle must already be visible in the same
    // SessionAccount snapshot we are about to sign. If this RPC is lagging,
    // fail before the passkey prompt; close() stays retryable.
    const expectedFinalCumulative = parseAtomic(_cumulativeAmount);
    const terminalFrontier = snapshot.spent > snapshot.crystallizedCumulative
      ? snapshot.spent
      : snapshot.crystallizedCumulative;
    if (terminalFrontier < expectedFinalCumulative) {
      throw new Error('session revocation snapshot is behind final settlement');
    }

    const message = sessionRevokeMessage(snapshot);

    // 2. Passkey-sign the exact-state revocation. ONE more prompt at tab close. The
    //    signer binds it through the canonical V7 authorization challenge.
    const { signature, clientDataJSON, authenticatorData } = await this.passkey.signOperation(message);
    const precompileMessage = concatBytes(authenticatorData, sha256(clientDataJSON));

    // 3. Build and sign the exact two-instruction tx.
    const precompileIx = buildSecp256r1VerifyInstruction(
      this.passkey.publicKey,
      signature,
      precompileMessage,
    );
    const revokeIx = buildRevokeSessionKeyInstruction({
      vaultPda: this.vaultPdaKey,
      // V7: the same exact counter is in the passkey message and instruction.
      allowedCounterparty: snapshot.allowedCounterparty,
      expectedPendingVoucherCount: snapshot.expectedPendingVoucherCount,
      clientDataJSON,
      authenticatorData,
    });

    const tx = new Transaction().add(precompileIx, revokeIx);
    tx.feePayer = this.feePayer.publicKey;
    let finalizedHistoryFloorSlot: number | null = null;
    try {
      const floor = await this.connection.getSlot('finalized');
      finalizedHistoryFloorSlot = Number.isSafeInteger(floor) && floor >= 0
        ? floor
        : null;
    } catch {
      // Broadcast is still safe. If transport becomes ambiguous, absence can
      // never authorize a new wire without this pre-broadcast history floor.
    }
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(
      this.confirmOptions.commitment,
    );
    tx.recentBlockhash = blockhash;
    tx.sign(this.feePayer);
    if (!tx.signature) throw new Error('session revoke transaction is unsigned');

    const serializedTransaction = Uint8Array.from(tx.serialize());
    const expectedSignature = bs58.encode(tx.signature);
    const pending: PendingCloseRevocation = {
      key,
      message: Uint8Array.from(message),
      serializedTransaction,
      signature: expectedSignature,
      blockhash,
      lastValidBlockHeight,
      finalizedHistoryFloorSlot,
    };
    // Persist the complete exact wire in adapter state BEFORE the first
    // transport call. A thrown send/confirm can never erase its identity.
    this.pendingCloseRevocations.set(key, pending);

    let confirmation: Awaited<ReturnType<Connection['confirmTransaction']>>;
    try {
      const returnedSignature = await this.connection.sendRawTransaction(
        serializedTransaction,
        {
          skipPreflight: false,
          preflightCommitment:
            this.confirmOptions.preflightCommitment
            ?? this.confirmOptions.commitment,
        },
      );
      if (returnedSignature !== expectedSignature) {
        throw new Error(
          `session revoke signature mismatch expected=${expectedSignature} returned=${returnedSignature}`,
        );
      }
      confirmation = await this.connection.confirmTransaction(
        { signature: expectedSignature, blockhash, lastValidBlockHeight },
        'finalized',
      );
    } catch (error) {
      const reconciliation = await this.reconcilePendingClose(
        pending,
        registration,
        false,
      );
      if (reconciliation === 'complete') {
        return this.rememberCompletedClose(key, message);
      }
      if (reconciliation === 'fresh_allowed') {
        this.pendingCloseRevocations.delete(key);
        throw new Error(
          'session revoke transaction finalized without effect; retry close',
          { cause: error },
        );
      }
      throw new Error(
        `session revoke finality unresolved for ${expectedSignature}; retry close`,
        { cause: error },
      );
    }
    if (confirmation.value.err) {
      // The finalized error proves this exact atomic transaction had no
      // effect. Retain no stale wire; a later retry will re-read the target and
      // only then may create a fresh passkey-bound revoke.
      this.pendingCloseRevocations.delete(key);
      throw new Error(
        `session revoke transaction failed: ${JSON.stringify(confirmation.value.err)}`,
      );
    }

    return this.rememberCompletedClose(key, message);
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
