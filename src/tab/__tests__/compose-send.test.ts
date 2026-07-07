/**
 * createSelfPayingComposeSend — the client-side v0+ALT transport for the
 * K-T4e atomic revoke-then-register.
 *
 * WHY v0+ALT IS MANDATORY (K-T4a size proof, dexter-vault-sdk
 * tests/session.composeTxSize.test.ts — constants REUSED here, not
 * re-derived): the composed [CB, secp(revoke), revoke, secp(register),
 * register] measures 1347 B legacy at ZERO siblings — past the 1232 B wire
 * cap; web3.js serialize() itself throws. With the per-vault statics AND
 * sibling session PDAs ALT-resident it lands at 1166–1174 B. The
 * register-only path stays legacy (937 B) and never routes here.
 *
 * The MAINNET-HARDENING mirrored from dexter-api's proven K-T4b transport
 * (src/vault/revokeRegisterCompose.ts, live-tested 2026-07-06):
 *   - priority fee (p75, floored/capped) — fee-less composes were dropped
 *     under congestion and expired unlanded;
 *   - fresh-blockhash rebroadcast on expiry-only (an expired signature is
 *     permanently dead, so rebroadcast cannot double-land);
 *   - ALT read-back poll — the confirmed create can lag a load-balanced RPC;
 *   - ALT-address collision retry with a fresh finalized slot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { deriveSessionPda } from '@dexterai/vault/session';
import { sessionRegisterMessage, sessionRevokeMessage } from '@dexterai/vault/messages';

import {
  createSelfPayingComposeSend,
  collectAltAddresses,
  TX_SIZE_LIMIT_BYTES,
} from '../adapters/solana/composeSend';
import { generateP256Keypair, signChallenge } from '../adapters/solana/passkey-noble';
import {
  buildRegisterSessionKeyInstruction,
  buildRevokeSessionKeyInstruction,
  buildSecp256r1VerifyInstruction,
  DEXTER_VAULT_PROGRAM_ID,
  SECP256R1_PROGRAM_ID,
} from '../instructions';

// ── Production-shaped composed instruction list ─────────────────────────

const VAULT = Keypair.generate().publicKey;
const SWIG = Keypair.generate().publicKey;
const SELLER = Keypair.generate().publicKey;
const FEE_PAYER = Keypair.generate();
const P256 = generateP256Keypair();
const NOW = Math.floor(Date.now() / 1000);

function composedIxs(): TransactionInstruction[] {
  const livePubkey = new Uint8Array(32).fill(0xd1);
  const newPubkey = new Uint8Array(32).fill(0xa7);
  const revokeMsg = sessionRevokeMessage({
    programId: DEXTER_VAULT_PROGRAM_ID, vaultPda: VAULT, sessionPubkey: livePubkey,
  });
  const rc = signChallenge(P256, sha256(revokeMsg));
  const registerMsg = sessionRegisterMessage({
    programId: DEXTER_VAULT_PROGRAM_ID, vaultPda: VAULT, sessionPubkey: newPubkey,
    maxAmount: 1000000n, maxRevolvingCapacity: 1000000n,
    expiresAt: BigInt(NOW + 1800), allowedCounterparty: SELLER, nonce: 42,
  });
  const gc = signChallenge(P256, sha256(registerMsg));
  const precompileMsg = (c: { authenticatorData: Uint8Array; clientDataJSON: Uint8Array }) => {
    const out = new Uint8Array(c.authenticatorData.length + 32);
    out.set(c.authenticatorData, 0);
    out.set(sha256(c.clientDataJSON), c.authenticatorData.length);
    return out;
  };
  return [
    buildSecp256r1VerifyInstruction(P256.publicKey, rc.signature, precompileMsg(rc)),
    buildRevokeSessionKeyInstruction({
      vaultPda: VAULT, allowedCounterparty: SELLER,
      clientDataJSON: rc.clientDataJSON, authenticatorData: rc.authenticatorData,
    }),
    buildSecp256r1VerifyInstruction(P256.publicKey, gc.signature, precompileMsg(gc)),
    buildRegisterSessionKeyInstruction({
      vaultPda: VAULT, sessionPubkey: newPubkey,
      maxAmount: 1000000n, maxRevolvingCapacity: 1000000n,
      expiresAt: BigInt(NOW + 1800), allowedCounterparty: SELLER, nonce: 42,
      swigAddress: SWIG, vaultUsdcAta: null, payer: FEE_PAYER.publicKey,
      siblingSessionPdas: [deriveSessionPda(VAULT, SELLER)[0]],
      clientDataJSON: gc.clientDataJSON, authenticatorData: gc.authenticatorData,
    }),
  ];
}

// ── Fake Connection ─────────────────────────────────────────────────────

const FINALIZED_SLOT = 1000;

interface FakeOpts {
  /** Per-v0-attempt behavior: 'ok' | an Error to throw. */
  v0Script?: Array<'ok' | Error>;
  /** getAddressLookupTable returns null this many times before the value. */
  altReadNulls?: number;
}

function fakeConn(opts: FakeOpts = {}) {
  const sends: Uint8Array[] = [];
  const v0Raws: Uint8Array[] = [];
  const legacyRaws: Uint8Array[] = [];
  const blockhashes: string[] = [];
  let v0Attempt = 0;
  let altReadNulls = opts.altReadNulls ?? 0;
  let altAddresses: PublicKey[] | null = null;
  let altKey: PublicKey | null = null;

  const conn = {
    sends, v0Raws, legacyRaws, blockhashes,
    getRecentPrioritizationFees: async () => [{ prioritizationFee: 50_000 }, { prioritizationFee: 0 }],
    getSlot: async () => FINALIZED_SLOT,
    getLatestBlockhash: async () => {
      const blockhash = Keypair.generate().publicKey.toBase58();
      blockhashes.push(blockhash);
      return { blockhash, lastValidBlockHeight: 100 };
    },
    sendRawTransaction: async (raw: Uint8Array) => {
      sends.push(raw);
      if (raw[0] & 0x80 || (raw.length > 1 && (raw[1 + raw[0] * 64] & 0x80))) {
        // versioned (v0) — signature-count compact-u16 then 0x80 version byte
      }
      // Distinguish legacy vs v0 by attempting legacy deserialize.
      let isLegacy = true;
      try { Transaction.from(raw); } catch { isLegacy = false; }
      if (isLegacy) {
        legacyRaws.push(raw);
        // Capture the ALT create+extend so getAddressLookupTable can serve it.
        const tx = Transaction.from(raw);
        for (const ix of tx.instructions) {
          if (ix.programId.equals(AddressLookupTableProgram.programId) && altKey === null && ix.keys.length > 0) {
            altKey = ix.keys[0].pubkey;
          }
        }
        return `LegacySig${legacyRaws.length}`;
      }
      v0Raws.push(raw);
      const step = opts.v0Script?.[v0Attempt] ?? 'ok';
      v0Attempt += 1;
      if (step !== 'ok') throw step;
      return `V0Sig${v0Attempt}`;
    },
    confirmTransaction: async () => ({ value: { err: null } }),
    getAddressLookupTable: async (key: PublicKey) => {
      if (altReadNulls > 0) { altReadNulls -= 1; return { value: null }; }
      if (altAddresses === null) {
        // Serve exactly the addresses the transport would have extended:
        // every non-signer, non-fee-payer account of the composed list.
        altAddresses = collectAltAddresses(composed, FEE_PAYER.publicKey);
      }
      return {
        value: new AddressLookupTableAccount({
          key,
          state: {
            deactivationSlot: BigInt('0xffffffffffffffff'),
            lastExtendedSlot: FINALIZED_SLOT - 1,
            lastExtendedSlotStartIndex: 0,
            authority: FEE_PAYER.publicKey,
            addresses: altAddresses,
          },
        }),
      };
    },
  };
  return conn as unknown as Connection & typeof conn;
}

let composed: TransactionInstruction[];
beforeEach(() => { composed = composedIxs(); });
afterEach(() => vi.restoreAllMocks());

// ── The K-T4a reality check the transport exists for ───────────────────

describe('K-T4a size reality (reused constants)', () => {
  it('the composed list CANNOT ride a legacy transaction (1347 B > 1232 B at zero siblings)', () => {
    const tx = new Transaction().add(...composed);
    tx.feePayer = FEE_PAYER.publicKey;
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.sign(FEE_PAYER);
    expect(() => tx.serialize()).toThrow(/too large/i);
  });
});

// ── Transport behavior ──────────────────────────────────────────────────

describe('createSelfPayingComposeSend', () => {
  it('provisions the ALT then lands a v0 compose that fits the wire cap', async () => {
    const conn = fakeConn();
    const transport = createSelfPayingComposeSend(conn, FEE_PAYER);

    const sig = await transport.send(composed);

    expect(sig).toBe('V0Sig1');
    expect(conn.legacyRaws).toHaveLength(1); // ALT create+extend
    expect(conn.v0Raws).toHaveLength(1);
    expect(transport.getAltAddress()).not.toBeNull();

    const raw = conn.v0Raws[0];
    expect(raw.length).toBeLessThanOrEqual(TX_SIZE_LIMIT_BYTES);

    const vtx = VersionedTransaction.deserialize(raw);
    expect(vtx.message.version).toBe(0);
    expect(vtx.message.addressTableLookups).toHaveLength(1);
    expect(vtx.message.addressTableLookups[0].accountKey.equals(transport.getAltAddress()!)).toBe(true);

    // Instruction order: CB unit-price FIRST (adds no accounts, so every
    // secp verify still immediately precedes its vault instruction), then
    // the composed block VERBATIM.
    const staticKeys = vtx.message.staticAccountKeys;
    const progOf = (ixIdx: number) => staticKeys[vtx.message.compiledInstructions[ixIdx].programIdIndex];
    expect(vtx.message.compiledInstructions).toHaveLength(5);
    expect(progOf(0).equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(vtx.message.compiledInstructions[0].data[0]).toBe(3); // setComputeUnitPrice
    expect(progOf(1).equals(SECP256R1_PROGRAM_ID)).toBe(true);
    expect(progOf(2).equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    expect(progOf(3).equals(SECP256R1_PROGRAM_ID)).toBe(true);
    expect(progOf(4).equals(DEXTER_VAULT_PROGRAM_ID)).toBe(true);
    // Composed ix data rides through byte-identical.
    expect(Buffer.from(vtx.message.compiledInstructions[2].data).equals(Buffer.from(composed[1].data))).toBe(true);
    expect(Buffer.from(vtx.message.compiledInstructions[4].data).equals(Buffer.from(composed[3].data))).toBe(true);

    // The fee payer stays a STATIC signer; the session PDA is ALT-resident.
    expect(staticKeys[0].equals(FEE_PAYER.publicKey)).toBe(true);
    const sessionPda = deriveSessionPda(VAULT, SELLER)[0];
    expect(staticKeys.some((k) => k.equals(sessionPda))).toBe(false);
  });

  it('tolerates a lagging ALT read-back (polls instead of failing the replace)', async () => {
    const conn = fakeConn({ altReadNulls: 2 });
    const transport = createSelfPayingComposeSend(conn, FEE_PAYER, { altReadbackPollMs: 1 });
    await expect(transport.send(composed)).resolves.toBe('V0Sig1');
  });

  it('rebroadcasts with a FRESH blockhash when the compose expires unlanded (and only then)', async () => {
    const conn = fakeConn({
      v0Script: [Object.assign(new Error('TransactionExpiredBlockheightExceededError: block height exceeded')), 'ok'],
    });
    const transport = createSelfPayingComposeSend(conn, FEE_PAYER);

    const sig = await transport.send(composed);

    expect(sig).toBe('V0Sig2');
    expect(conn.v0Raws).toHaveLength(2);
    const bh = (raw: Uint8Array) => VersionedTransaction.deserialize(raw).message.recentBlockhash;
    expect(bh(conn.v0Raws[0])).not.toBe(bh(conn.v0Raws[1]));
  });

  it('surfaces an on-chain program error IMMEDIATELY (logs intact, no retry)', async () => {
    const programErr = Object.assign(new Error('Simulation failed'), {
      logs: ['Program log: AnchorError thrown', 'Program log: Error Code: SessionAlreadyActive'],
    });
    const conn = fakeConn({ v0Script: [programErr] });
    const transport = createSelfPayingComposeSend(conn, FEE_PAYER);

    await expect(transport.send(composed)).rejects.toThrow(/SessionAlreadyActive/);
    expect(conn.v0Raws).toHaveLength(1); // deterministic failure — never rebroadcast
  });

  it('throws loudly when even the v0+ALT compose exceeds the wire cap', async () => {
    const conn = fakeConn();
    const transport = createSelfPayingComposeSend(conn, FEE_PAYER);
    // Instruction DATA is incompressible by an ALT — inflate it past the cap.
    const bloated = composed.map((ix, i) => (i === 3
      ? new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.alloc(1300, 7) })
      : ix));
    await expect(transport.send(bloated)).rejects.toThrow(/exceeds the 1232/);
  });

  it('deactivateAlt is fire-and-forget: cleans up after success, never throws on failure', async () => {
    const conn = fakeConn();
    const transport = createSelfPayingComposeSend(conn, FEE_PAYER);
    await transport.send(composed);
    await transport.deactivateAlt();
    expect(conn.legacyRaws).toHaveLength(2); // create+extend, then deactivate

    // Failure path: the deactivate send rejects → still resolves.
    const failingConn = fakeConn();
    const t2 = createSelfPayingComposeSend(failingConn, FEE_PAYER);
    await t2.send(composed);
    (failingConn as { sendRawTransaction: unknown }).sendRawTransaction = async () => {
      throw new Error('rpc down');
    };
    await expect(t2.deactivateAlt()).resolves.toBeUndefined();
  });

  it('deactivateAlt is a no-op when no ALT was ever created', async () => {
    const conn = fakeConn();
    const transport = createSelfPayingComposeSend(conn, FEE_PAYER);
    await expect(transport.deactivateAlt()).resolves.toBeUndefined();
    expect(conn.sends).toHaveLength(0);
  });
});

// ── collectAltAddresses (pure) ──────────────────────────────────────────

describe('collectAltAddresses', () => {
  it('collects every non-signer account, deduped, excluding the fee payer; program ids never enter', () => {
    const addrs = collectAltAddresses(composed, FEE_PAYER.publicKey);
    const b58 = addrs.map((k) => k.toBase58());

    expect(new Set(b58).size).toBe(b58.length); // deduped
    expect(b58).not.toContain(FEE_PAYER.publicKey.toBase58()); // fee payer static
    // Signers can never be ALT-resident (payer is the only signer meta here).
    for (const ix of composed) {
      for (const meta of ix.keys) {
        if (meta.isSigner) expect(b58).not.toContain(meta.pubkey.toBase58());
      }
    }
    // INVOKED program ids are not collected as such (they're not in ix.keys)
    // — the secp verifier proves it. The VAULT program id DOES appear here,
    // but only because vault 0.34's builder passes it as Anchor's
    // None-sentinel ACCOUNT for the null vaultUsdcAta (credit-only path);
    // web3.js keeps invoked programs static at compile time regardless, so
    // its ALT residency is a harmless unused entry.
    expect(b58).not.toContain(SECP256R1_PROGRAM_ID.toBase58());
    expect(b58).toContain(DEXTER_VAULT_PROGRAM_ID.toBase58());
    // The vault, session PDA, swig, and sysvar ARE collected.
    expect(b58).toContain(VAULT.toBase58());
    expect(b58).toContain(deriveSessionPda(VAULT, SELLER)[0].toBase58());
    expect(b58).toContain(SWIG.toBase58());
  });
});
