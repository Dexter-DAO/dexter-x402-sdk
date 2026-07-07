/**
 * authorizeSession vs a LIVE target session — the K-T4e contract.
 *
 * THE HAZARD (registration-surface spec, 2026-07-06): the session PDA is
 * keyed by (vault, counterparty), so re-opening a tab against a seller you
 * already hold a live session with resolves to the SAME PDA. Pre-K-T1 the
 * program silently overwrites it (stranding the seller's un-crystallized
 * tail); post-K-T1 the bare register REVERTS SessionAlreadyActive. The
 * adapter must therefore:
 *
 *   1. read the target PDA before registering;
 *   2. NOT live (absent / cleared / expired)  → the bare legacy register,
 *      byte-identical to the pre-K-T4e path (937 B — legacy-safe, K-T4a);
 *   3. LIVE + no acknowledgement             → throw LiveSessionExistsError
 *      carrying the on-chain evidence (never silently strand the tail);
 *   4. LIVE + onLiveSession:'replace'        → compose the ATOMIC same-tx
 *      [secp(revoke), revoke, secp(register), register] via the vault
 *      0.34 composeRevokeThenRegister primitive (v0+ALT transport).
 *
 * Verification oracles are REAL: fake Connection serves real-layout
 * SessionAccount bytes (from-grant.test.ts pattern), the REAL vault
 * compose/builders produce the expected instructions, and ceremonies are
 * re-derived with the same deterministic P-256 signer for byte-compare.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, PublicKey, Transaction, type Connection, type TransactionInstruction } from '@solana/web3.js';
import {
  deriveSessionPda,
  fetchSessionAccount,
  fetchVaultSessionAccounts,
} from '@dexterai/vault/session';
import { sessionRevokeMessage, sessionRegisterMessage } from '@dexterai/vault/messages';

import { createSolanaVaultAdapter } from '../adapters/solana/index';
import {
  generateP256Keypair,
  signChallenge,
  passkeySignerFromP256Keypair,
} from '../adapters/solana/passkey-noble';
import {
  buildRegisterSessionKeyInstruction,
  buildRevokeSessionKeyInstruction,
  buildSecp256r1VerifyInstruction,
  DEXTER_VAULT_PROGRAM_ID,
  SECP256R1_PROGRAM_ID,
} from '../instructions';
import { LiveSessionExistsError, type SessionScope } from '../types';
import { sha256 } from '@noble/hashes/sha256';

// ── Fixtures ───────────────────────────────────────────────────────────

const VAULT = Keypair.generate().publicKey;
const SWIG = Keypair.generate().publicKey;
const SELLER = Keypair.generate().publicKey;
const FEE_PAYER = Keypair.generate();
const NOW = Math.floor(Date.now() / 1000);

const P256 = generateP256Keypair();
const PASSKEY = passkeySignerFromP256Keypair(P256);

/** Real-layout 162-byte SessionAccount (vault session/decode.ts contract). */
function sessionAccountData(args: {
  sessionPubkey?: Uint8Array;
  version?: number;
  expiresAt?: number;
  spent?: bigint;
  currentOutstanding?: bigint;
  crystallized?: bigint;
}): Buffer {
  const buf = Buffer.alloc(162);
  Buffer.from([74, 34, 65, 133, 96, 163, 80, 69]).copy(buf, 0); // discriminator
  buf.writeUInt8(args.version ?? 1, 8);
  buf.writeUInt8(255, 9); // bump
  VAULT.toBuffer().copy(buf, 10);
  Buffer.from(args.sessionPubkey ?? new Uint8Array(32).fill(0xd1)).copy(buf, 42);
  buf.writeBigUInt64LE(2_000_000n, 74); // max_amount
  buf.writeBigInt64LE(BigInt(args.expiresAt ?? NOW + 3600), 82);
  SELLER.toBuffer().copy(buf, 90);
  buf.writeUInt32LE(7, 122); // nonce
  buf.writeBigUInt64LE(args.spent ?? 0n, 126);
  buf.writeBigUInt64LE(args.currentOutstanding ?? 0n, 134);
  buf.writeBigUInt64LE(2_000_000n, 142); // max_revolving_capacity
  buf.writeBigUInt64LE(args.crystallized ?? 0n, 150);
  buf.writeUInt32LE(0, 158);
  return buf;
}

const SESSION_PDA = deriveSessionPda(VAULT, SELLER)[0];

/** Minimal Connection double: getAccountInfo from a map, getProgramAccounts
 *  returns every map entry that parses as a SessionAccount for VAULT, plus
 *  the legacy-send trio (getLatestBlockhash / sendRawTransaction /
 *  confirmTransaction) capturing raw legacy sends. */
function fakeConnection(accounts: Map<string, Buffer>) {
  const legacySends: Uint8Array[] = [];
  const conn = {
    legacySends,
    getAccountInfo: async (pda: PublicKey) => {
      const data = accounts.get(pda.toBase58());
      return data ? { data } : null;
    },
    getProgramAccounts: async (_programId: PublicKey, _cfg: unknown) => {
      const out: Array<{ pubkey: PublicKey; account: { data: Buffer } }> = [];
      for (const [b58, data] of accounts) {
        if (data.length === 162) out.push({ pubkey: new PublicKey(b58), account: { data } });
      }
      return out;
    },
    getLatestBlockhash: async () => ({
      blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k',
      lastValidBlockHeight: 100,
    }),
    sendRawTransaction: async (raw: Uint8Array) => {
      legacySends.push(raw);
      return 'LegacySig111';
    },
    confirmTransaction: async () => ({ value: { err: null } }),
  };
  return conn as unknown as Connection & { legacySends: Uint8Array[] };
}

function makeAdapter(
  conn: Connection,
  seams: {
    composeSend?: (ixs: TransactionInstruction[]) => Promise<string>;
    fetchSession?: typeof fetchSessionAccount;
    fetchSessions?: typeof fetchVaultSessionAccounts;
  } = {},
) {
  return createSolanaVaultAdapter({
    connection: conn,
    swigAddress: SWIG,
    vaultPda: VAULT,
    passkeySigner: PASSKEY,
    feePayer: FEE_PAYER,
    seams: {
      // Content-aware post-register wait is chain-polling; stub it fast.
      waitForSession: vi.fn(async () => ({}) as never),
      // The swig has no on-chain USDC ATA in the fake — resolve as
      // credit-only (null); the builder's optional-account sentinel covers it.
      ...seams,
    },
  });
}

function scopeFor(): SessionScope {
  return {
    channelId: 'c'.repeat(64),
    maxAmountAtomic: '1000000',
    revolvingCapacityAtomic: '1000000',
    expiresAtUnix: NOW + 1800,
    allowedCounterparty: SELLER.toBase58(),
  };
}

beforeEach(() => {
  // deriveNonce() uses Math.random — pin it so register bytes are reproducible.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const EXPECTED_NONCE = Math.floor(0.5 * 0xffffffff) >>> 0;

// ── 1. NOT live → the bare legacy register (pre-K-T4e bytes) ────────────

describe('authorizeSession — target NOT live (absent / cleared / expired)', () => {
  it.each([
    ['absent', undefined],
    ['cleared (version 0)', sessionAccountData({ version: 0, expiresAt: 0 })],
    ['expired', sessionAccountData({ expiresAt: NOW - 10 })],
  ])('%s → plain legacy register, compose transport never invoked', async (_label, data) => {
    const accounts = new Map<string, Buffer>();
    if (data) accounts.set(SESSION_PDA.toBase58(), data);
    const conn = fakeConnection(accounts);
    const composeSend = vi.fn(async () => 'ComposeSig111');
    const adapter = makeAdapter(conn, { composeSend });

    const session = await adapter.authorizeSession(scopeFor(), { onLiveSession: 'replace' });

    expect(composeSend).not.toHaveBeenCalled();
    expect(conn.legacySends).toHaveLength(1);

    // The wire bytes are a LEGACY transaction (K-T4a: register-only fits at
    // 937 B) with exactly [secp256r1, register_session_key].
    const tx = Transaction.from(conn.legacySends[0]);
    expect(conn.legacySends[0].length).toBeLessThanOrEqual(1232);
    expect(tx.instructions).toHaveLength(2);
    expect(tx.instructions[0].programId.equals(SECP256R1_PROGRAM_ID)).toBe(true);
    expect(tx.instructions[1].programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);

    // Byte-exact register leg: re-derive the ceremony with the same
    // deterministic P-256 key and build through the REAL vault builder.
    const message = sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: VAULT,
      sessionPubkey: session.publicKey,
      maxAmount: 1000000n,
      maxRevolvingCapacity: 1000000n,
      expiresAt: BigInt(NOW + 1800),
      allowedCounterparty: SELLER,
      nonce: EXPECTED_NONCE,
    });
    const ceremony = signChallenge(P256, sha256(message));
    const expected = buildRegisterSessionKeyInstruction({
      vaultPda: VAULT,
      sessionPubkey: session.publicKey,
      maxAmount: 1000000n,
      maxRevolvingCapacity: 1000000n,
      expiresAt: BigInt(NOW + 1800),
      allowedCounterparty: SELLER,
      nonce: EXPECTED_NONCE,
      swigAddress: SWIG,
      vaultUsdcAta: null, // fake chain has no ATA → credit-only sentinel
      payer: FEE_PAYER.publicKey,
      siblingSessionPdas: [],
      clientDataJSON: ceremony.clientDataJSON,
      authenticatorData: ceremony.authenticatorData,
    });
    expect(Buffer.from(tx.instructions[1].data).equals(Buffer.from(expected.data))).toBe(true);
    expect(tx.instructions[1].keys.map((k) => k.pubkey.toBase58()))
      .toEqual(expected.keys.map((k) => k.pubkey.toBase58()));
  });
});

// ── 2. LIVE + no acknowledgement → typed stranding-guard error ──────────

describe('authorizeSession — LIVE target, no acknowledgement (stranding guard)', () => {
  it('throws LiveSessionExistsError with the on-chain evidence; signs NOTHING, sends NOTHING', async () => {
    const livePubkey = new Uint8Array(32).fill(0xd1);
    const accounts = new Map([
      [SESSION_PDA.toBase58(), sessionAccountData({
        sessionPubkey: livePubkey,
        spent: 5000n,
        crystallized: 7000n,
        currentOutstanding: 950_000n,
      })],
    ]);
    const conn = fakeConnection(accounts);
    const composeSend = vi.fn(async () => 'ComposeSig111');
    const signSpy = vi.spyOn(PASSKEY, 'signOperation');
    const adapter = makeAdapter(conn, { composeSend });

    const err = await adapter.authorizeSession(scopeFor()).then(
      () => { throw new Error('resolved — expected LiveSessionExistsError'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(LiveSessionExistsError);
    const details = (err as LiveSessionExistsError).details;
    expect(details.allowedCounterparty).toBe(SELLER.toBase58());
    expect(details.sessionPubkeyHex).toBe('d1'.repeat(32));
    expect(details.spentAtomic).toBe('5000');
    expect(details.crystallizedCumulativeAtomic).toBe('7000');
    expect(details.currentOutstandingAtomic).toBe('950000');
    // frontier = max(spent, crystallized) — everything the chain terminally
    // counted; a replace strands only what's signed BEYOND it.
    expect(details.frontierAtomic).toBe('7000');

    // Guard fires BEFORE any ceremony or send — no passkey prompt burned,
    // no tx submitted, nothing composed.
    expect(signSpy).not.toHaveBeenCalled();
    expect(composeSend).not.toHaveBeenCalled();
    expect(conn.legacySends).toHaveLength(0);
  });
});

// ── 3. LIVE + acknowledged replace → the ATOMIC compose ────────────────

describe('authorizeSession — LIVE target, onLiveSession: replace (atomic)', () => {
  const livePubkey = new Uint8Array(32).fill(0xd1);

  function liveConn() {
    return fakeConnection(new Map([
      [SESSION_PDA.toBase58(), sessionAccountData({ sessionPubkey: livePubkey })],
    ]));
  }

  it('sends ONE composed tx [secp(revoke), revoke, secp(register), register] through the compose transport', async () => {
    const conn = liveConn();
    const captured: TransactionInstruction[][] = [];
    const composeSend = vi.fn(async (ixs: TransactionInstruction[]) => {
      captured.push(ixs);
      return 'ComposeSig111';
    });
    const adapter = makeAdapter(conn, { composeSend });

    const session = await adapter.authorizeSession(scopeFor(), { onLiveSession: 'replace' });

    // Atomic: exactly one transport send, NO bare legacy register.
    expect(composeSend).toHaveBeenCalledTimes(1);
    expect(conn.legacySends).toHaveLength(0);

    const ixs = captured[0];
    expect(ixs).toHaveLength(4);
    // Adjacency law (webauthn.rs: verify introspects current_index − 1):
    // each secp verify immediately precedes its vault instruction.
    expect(ixs[0].programId.equals(SECP256R1_PROGRAM_ID)).toBe(true);
    expect(ixs[1].programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(ixs[2].programId.equals(SECP256R1_PROGRAM_ID)).toBe(true);
    expect(ixs[3].programId.equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);

    // Byte-exact revoke leg: ceremony over sessionRevokeMessage of the LIVE
    // pubkey (NOT the new one), built through the REAL vault builder.
    const revokeMsg = sessionRevokeMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: VAULT,
      sessionPubkey: livePubkey,
    });
    const revokeCeremony = signChallenge(P256, sha256(revokeMsg));
    const expectedRevoke = buildRevokeSessionKeyInstruction({
      vaultPda: VAULT,
      allowedCounterparty: SELLER,
      clientDataJSON: revokeCeremony.clientDataJSON,
      authenticatorData: revokeCeremony.authenticatorData,
    });
    expect(Buffer.from(ixs[1].data).equals(Buffer.from(expectedRevoke.data))).toBe(true);
    expect(ixs[1].keys.map((k) => k.pubkey.toBase58()))
      .toEqual(expectedRevoke.keys.map((k) => k.pubkey.toBase58()));
    // ...and its secp sibling verifies exactly that ceremony.
    const expectedRevokeSecp = buildSecp256r1VerifyInstruction(
      P256.publicKey,
      revokeCeremony.signature,
      revokeCeremony.authenticatorData.length
        ? concat(revokeCeremony.authenticatorData, sha256(revokeCeremony.clientDataJSON))
        : new Uint8Array(),
    );
    expect(Buffer.from(ixs[0].data).equals(Buffer.from(expectedRevokeSecp.data))).toBe(true);

    // Byte-exact register leg (new session pubkey, pinned nonce). The live
    // target session is EXCLUDED from its own sibling set by the builder.
    const registerMsg = sessionRegisterMessage({
      programId: DEXTER_VAULT_PROGRAM_ID,
      vaultPda: VAULT,
      sessionPubkey: session.publicKey,
      maxAmount: 1000000n,
      maxRevolvingCapacity: 1000000n,
      expiresAt: BigInt(NOW + 1800),
      allowedCounterparty: SELLER,
      nonce: EXPECTED_NONCE,
    });
    const registerCeremony = signChallenge(P256, sha256(registerMsg));
    const expectedRegister = buildRegisterSessionKeyInstruction({
      vaultPda: VAULT,
      sessionPubkey: session.publicKey,
      maxAmount: 1000000n,
      maxRevolvingCapacity: 1000000n,
      expiresAt: BigInt(NOW + 1800),
      allowedCounterparty: SELLER,
      nonce: EXPECTED_NONCE,
      swigAddress: SWIG,
      vaultUsdcAta: null,
      payer: FEE_PAYER.publicKey,
      siblingSessionPdas: [SESSION_PDA], // builder excludes the target itself
      clientDataJSON: registerCeremony.clientDataJSON,
      authenticatorData: registerCeremony.authenticatorData,
    });
    expect(Buffer.from(ixs[3].data).equals(Buffer.from(expectedRegister.data))).toBe(true);
    expect(ixs[3].keys.map((k) => k.pubkey.toBase58()))
      .toEqual(expectedRegister.keys.map((k) => k.pubkey.toBase58()));
  });

  it('waits for the NEW session pubkey to be visible (content-aware, not existence)', async () => {
    const conn = liveConn();
    const waitSpy = vi.fn(async () => ({}) as never);
    const adapter = createSolanaVaultAdapter({
      connection: conn,
      swigAddress: SWIG,
      vaultPda: VAULT,
      passkeySigner: PASSKEY,
      feePayer: FEE_PAYER,
      seams: {
        waitForSession: waitSpy,
        composeSend: async () => 'ComposeSig111',
      },
    });

    const session = await adapter.authorizeSession(scopeFor(), { onLiveSession: 'replace' });

    expect(waitSpy).toHaveBeenCalledTimes(1);
    const [, , counterparty, opts] = waitSpy.mock.calls[0] as unknown as [
      Connection, PublicKey, PublicKey, { expectedSessionPubkey: Uint8Array },
    ];
    expect(counterparty.equals(SELLER)).toBe(true);
    expect(Buffer.from(opts.expectedSessionPubkey).equals(Buffer.from(session.publicKey))).toBe(true);
  });

  it('propagates the vault SDK rotation error when the live session rotates between read and compose', async () => {
    // The adapter's read sees pubkey A; the compose's own re-read sees a
    // DIFFERENT live pubkey B — the revoke ceremony no longer binds, and
    // submitting it would only burn the tx on-chain. The typed vault error
    // must surface (callers re-read + retry).
    const dataA = sessionAccountData({ sessionPubkey: livePubkey });
    const dataB = sessionAccountData({ sessionPubkey: new Uint8Array(32).fill(0xe2) });
    let reads = 0;
    const accounts = new Map([[SESSION_PDA.toBase58(), dataA]]);
    const conn = fakeConnection(accounts);
    const origGetAccountInfo = conn.getAccountInfo.bind(conn);
    (conn as { getAccountInfo: unknown }).getAccountInfo = async (pda: PublicKey) => {
      reads += 1;
      if (pda.equals(SESSION_PDA) && reads > 1) return { data: dataB };
      return origGetAccountInfo(pda);
    };
    const adapter = makeAdapter(conn, { composeSend: async () => 'ComposeSig111' });

    await expect(
      adapter.authorizeSession(scopeFor(), { onLiveSession: 'replace' }),
    ).rejects.toThrow(/rotated|RevokeCeremonyMismatch/i);
  });
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
