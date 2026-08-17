/**
 * createSelfPayingComposeSend — the CLIENT-SIDE v0 + Address-Lookup-Table
 * transport for the atomic revoke-then-register compose (K-T4e).
 *
 * WHY THIS EXISTS: the live replacement carries a large, fully bound operation
 * plus the V7 account set. The compatibility compose routes it through a v0
 * transaction and address lookup table instead of relying on the legacy
 * 1232-byte wire envelope. The LIVE replacement path therefore
 * assemble a v0 `VersionedTransaction` with an ephemeral address lookup
 * table holding every non-signer account of the composed instructions
 * (vault, target session PDA, vaultUsdcAta, swig, swig wallet PDA, sysvar,
 * system program, sibling session PDAs) — 1166–1174 B on-chain-proven. The
 * register-only (not-live) path stays on the adapter's legacy send while it
 * fits and reuses this transport when required sibling accounts push it past
 * the packet cap.
 *
 * SELF-PAYING vs SPONSORED: this is the buyer-side twin of dexter-api's
 * sponsor-owned K-T4b transport (dexter-api src/vault/revokeRegisterCompose.ts,
 * mainnet-hardened 2026-07-06). Here the adapter's `feePayer` — the buyer's
 * own key on the loop's self-paying path, or a sponsor key when a caller
 * routes one in — pays the fee AND owns the ephemeral ALT. Either way the
 * payer holds ZERO authority over the vault: register/revoke authorize on
 * the passkey secp siblings, and the program validates every account by
 * seeds/address constraint, so the ALT is an encoding optimization, not a
 * trust surface.
 *
 * MAINNET-HARDENING mirrored from the proven K-T4b transport (each was
 * forced by a live failure on 2026-07-06):
 *  - PRIORITY FEE (p75 of recent, floored/capped): a fee-less compose is
 *    dropped under congestion and expires unlanded — a CU limit alone buys
 *    nothing, only a price does.
 *  - FRESH-BLOCKHASH REBROADCAST on expiry-only: an expired-blockhash
 *    signature is permanently dead on Solana, so rebroadcasting under a new
 *    blockhash cannot double-land. On-chain errors (logs present) surface
 *    immediately — deterministic failures are never retried.
 *  - ALT READ-BACK POLL: the create+extend confirms, but the ALT ACCOUNT can
 *    lag a load-balanced RPC — a one-shot read spuriously fails a legitimate
 *    replace.
 *  - ALT-ADDRESS COLLISION RETRY: createLookupTable derives from
 *    [authority, recentSlot]; two concurrent composes reading the same
 *    finalized slot collide — retry with a fresh finalized slot.
 *
 * TWO PREFLIGHT-BANK RULES (K-T4a, honored verbatim):
 *  (a) the ALT-extend must be OBSERVED by the bank preflight simulates
 *      against, or the compose preflights "invalid index" — poll getSlot at
 *      the preflight commitment until it passes lastExtendedSlot;
 *  (b) the v0 blockhash must be fetched AT the preflight commitment, or the
 *      preflight bank reports "Blockhash not found".
 */

import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  type Commitment,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  type Signer,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

/** Solana's hard on-the-wire transaction cap (IPv6 MTU 1280 − 48). */
export const TX_SIZE_LIMIT_BYTES = 1232;

/** Bounded ALT-warmup poll (rule a): ~40 × 400ms = ~16s worst case. */
const ALT_WARMUP_MAX_POLLS = 40;
/** Bounded ALT read-back poll: ~20 × 400ms = ~8s worst case. */
const ALT_READBACK_MAX_POLLS = 20;
/** Collision retry: fresh-finalized-slot wait, ~20 × 500ms = ~10s worst case. */
const ALT_CREATE_MAX_ATTEMPTS = 4;
const ALT_COLLISION_MAX_POLLS = 20;

/** Priority-fee bounds (microLamports/CU) — p75-biased must-land path. */
const PRIORITY_FEE_FLOOR_MICROLAMPORTS = 10_000;
const PRIORITY_FEE_CAP_MICROLAMPORTS = 1_000_000;

/** Bounded expiry-only rebroadcast (fresh blockhash each attempt). */
const COMPOSE_SEND_MAX_ATTEMPTS = 4;

const TAG = '[tab/solana/compose]';

export interface SelfPayingComposeSendOptions {
  /** Commitment the preflight bank rules key on. Default 'confirmed' —
   *  matching the adapter's default confirm options. */
  commitment?: Commitment;
  /** Poll intervals (test seams; production defaults match K-T4b). */
  altWarmupPollMs?: number;
  altReadbackPollMs?: number;
  altCollisionPollMs?: number;
}

export interface SelfPayingComposeSend {
  /**
   * `send` transport for `composeRevokeThenRegister`: receives the FULL
   * composed instruction list, lazily provisions + warms the ephemeral ALT
   * on the first call (reused on retries), builds the v0 tx, sends with
   * preflight ON, confirms, and returns the signature. Throws with the
   * program error text + simulation logs intact (registerSessionWithRetry's
   * IncompleteSessionSet / SessionAccountsNotSorted matcher needs them).
   */
  send: (instructions: TransactionInstruction[]) => Promise<string>;
  /** The ephemeral ALT address once created, else null. */
  getAltAddress: () => PublicKey | null;
  /**
   * Fire-and-forget cleanup: deactivate the ephemeral ALT so its rent
   * becomes reclaimable by a later `close_lookup_table` (close requires the
   * ~513-slot deactivation cooldown, so it cannot run inline). No-op when no
   * ALT was created. NEVER throws — cleanup failure must not fail the
   * money op that already landed.
   */
  deactivateAlt: () => Promise<void>;
}

/**
 * The accounts the ephemeral ALT must hold: every NON-SIGNER account meta
 * referenced by the composed instructions, deduped, minus the fee payer.
 * Extracting straight from the instruction list is exact-by-construction —
 * no re-derivation of vault accounts in this module. Signers MUST stay
 * static; invoked program ids are never in `ix.keys`, so they never enter
 * the ALT (and web3.js keeps invoked programs static regardless).
 */
export function collectAltAddresses(
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  const feePayerB58 = feePayer.toBase58();
  for (const ix of instructions) {
    for (const meta of ix.keys) {
      if (meta.isSigner) continue; // signers can never be ALT-resident
      const b58 = meta.pubkey.toBase58();
      if (b58 === feePayerB58 || seen.has(b58)) continue;
      seen.add(b58);
      out.push(meta.pubkey);
    }
  }
  return out;
}

/** Compile the composed instruction list into a v0 tx backed by `alt`. */
export function compileComposeV0(
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
  recentBlockhash: string,
  alt: AddressLookupTableAccount,
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash,
    instructions,
  }).compileToV0Message([alt]);
  return new VersionedTransaction(message);
}

/** p75-biased recent priority fee (microLamports/CU), floored + capped. */
async function computeComposePriorityFee(conn: Connection): Promise<number> {
  try {
    const nonZero = (await conn.getRecentPrioritizationFees())
      .map((f) => f.prioritizationFee)
      .filter((f) => f > 0)
      .sort((a, b) => a - b);
    if (nonZero.length === 0) return PRIORITY_FEE_FLOOR_MICROLAMPORTS;
    const p75 = nonZero[Math.floor(0.75 * (nonZero.length - 1))] ?? PRIORITY_FEE_FLOOR_MICROLAMPORTS;
    return Math.max(PRIORITY_FEE_FLOOR_MICROLAMPORTS, Math.min(p75, PRIORITY_FEE_CAP_MICROLAMPORTS));
  } catch {
    return PRIORITY_FEE_FLOOR_MICROLAMPORTS;
  }
}

/** True iff `err` is the createLookupTable [authority, recentSlot] address
 *  collision. Deliberately NARROW: only this error is retried on the create
 *  path, so a real fault still fails fast. */
function isAltAddressCollision(err: unknown): boolean {
  const e = err as { message?: unknown; logs?: unknown } | null;
  const msg = String(e?.message ?? err ?? '');
  const logs = Array.isArray(e?.logs) ? (e.logs as unknown[]).join(' ') : '';
  return /already in use/i.test(msg) || /already in use/i.test(logs);
}

/** True iff the failure is an expired-unlanded blockhash (no on-chain logs)
 *  — the ONLY failure safe to rebroadcast. */
function isExpiredUnlanded(err: unknown): boolean {
  const e = err as { message?: unknown; logs?: unknown } | null;
  const logs: unknown[] = Array.isArray(e?.logs) ? (e.logs as unknown[]) : [];
  return (
    logs.length === 0 &&
    /block height exceeded|has expired|blockhash not found/i.test(String(e?.message ?? err))
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a self-paying LIVE-compose transport bound to `conn` + `feePayer`.
 * The ALT is created from the FIRST attempt's account set and reused across
 * registerSessionWithRetry retries; a sibling that appears between the
 * ALT-extend and a later attempt rides as a static key (+33 B) — still
 * within cap below a couple of unlisted siblings.
 */
export function createSelfPayingComposeSend(
  conn: Connection,
  feePayer: Signer,
  options: SelfPayingComposeSendOptions = {},
): SelfPayingComposeSend {
  const commitment: Commitment = options.commitment ?? 'confirmed';
  const warmupPollMs = options.altWarmupPollMs ?? 400;
  const readbackPollMs = options.altReadbackPollMs ?? 400;
  const collisionPollMs = options.altCollisionPollMs ?? 500;

  let alt: AddressLookupTableAccount | null = null;
  let altAddress: PublicKey | null = null;

  /** Legacy self-signed send+confirm for the small, passkey-free ALT
   *  lifecycle txs — priority-fee'd + expiry-rebroadcast like the compose
   *  (the fee-less ALT create was being congestion-dropped live). */
  async function sendLegacy(instructions: TransactionInstruction[], label: string): Promise<string> {
    const priorityFee = await computeComposePriorityFee(conn);
    const ixs = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }), ...instructions];

    let lastErr: unknown;
    for (let attempt = 0; attempt < COMPOSE_SEND_MAX_ATTEMPTS; attempt += 1) {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(commitment);
      const tx = new Transaction().add(...ixs);
      tx.feePayer = feePayer.publicKey;
      tx.recentBlockhash = blockhash;
      tx.sign(feePayer);
      try {
        const signature = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 5,
        });
        const confirmation = await conn.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          commitment,
        );
        if (confirmation.value.err) {
          throw new Error(`${label} tx failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
        }
        return signature;
      } catch (err) {
        // Collision / on-chain errors carry logs → throw the ORIGINAL err so
        // the create path's isAltAddressCollision matcher still fires.
        if (isExpiredUnlanded(err) && attempt < COMPOSE_SEND_MAX_ATTEMPTS - 1) {
          console.warn(
            `${TAG} ${label} tx expired before landing (attempt ${attempt + 1}) — ` +
              'rebroadcasting with a fresh blockhash',
          );
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error(`${label} tx did not land after rebroadcast attempts`);
  }

  /** Block until the finalized slot advances strictly past `slot` so a
   *  retried createLookupTable derives a fresh table address. Bounded. */
  async function waitForFinalizedSlotBeyond(slot: number): Promise<number> {
    for (let i = 0; i < ALT_COLLISION_MAX_POLLS; i += 1) {
      const s = await conn.getSlot('finalized');
      if (s > slot) return s;
      await sleep(collisionPollMs);
    }
    throw new Error(`ALT collision retry: finalized slot never advanced past ${slot}`);
  }

  /** Bounded poll (rule a): block until the preflight bank's slot passes the
   *  ALT's lastExtendedSlot, so the v0 compose can resolve the lookup. */
  async function waitForAltUsable(lastExtendedSlot: number): Promise<void> {
    for (let i = 0; i < ALT_WARMUP_MAX_POLLS; i += 1) {
      const slot = await conn.getSlot(commitment);
      if (slot > lastExtendedSlot) return;
      await sleep(warmupPollMs);
    }
    throw new Error(
      `ALT warmup timed out: preflight (${commitment}) slot never passed lastExtendedSlot ${lastExtendedSlot}`,
    );
  }

  async function ensureAlt(instructions: TransactionInstruction[]): Promise<AddressLookupTableAccount> {
    if (alt) return alt;

    const addresses = collectAltAddresses(instructions, feePayer.publicKey);

    // create + extend in ONE legacy tx (≪ 1232 B for ~13 addresses), with a
    // bounded retry on the concurrent-compose address collision.
    let tableAddress: PublicKey | null = null;
    let created: string | null = null;
    let collidedSlot = -1;
    for (let attempt = 0; attempt < ALT_CREATE_MAX_ATTEMPTS; attempt += 1) {
      // recentSlot from a FINALIZED read: guaranteed already produced +
      // present in the SlotHashes sysvar at execution and well inside the
      // 512-slot window. On retry, wait past the colliding slot so the
      // re-derived [authority, recentSlot] address differs.
      const recentSlot =
        collidedSlot < 0 ? await conn.getSlot('finalized') : await waitForFinalizedSlotBeyond(collidedSlot);
      const [createIx, addr] = AddressLookupTableProgram.createLookupTable({
        authority: feePayer.publicKey,
        payer: feePayer.publicKey,
        recentSlot,
      });
      const extendIx = AddressLookupTableProgram.extendLookupTable({
        payer: feePayer.publicKey,
        authority: feePayer.publicKey,
        lookupTable: addr,
        addresses,
      });
      try {
        created = await sendLegacy([createIx, extendIx], 'ALT create/extend');
        tableAddress = addr;
        break;
      } catch (err) {
        if (isAltAddressCollision(err) && attempt < ALT_CREATE_MAX_ATTEMPTS - 1) {
          collidedSlot = recentSlot;
          console.warn(
            `${TAG} ALT address collision at slot ${recentSlot} (attempt ${attempt + 1}) — ` +
              'retrying create with a fresh finalized slot',
          );
          continue;
        }
        throw err;
      }
    }
    if (!tableAddress || !created) {
      throw new Error('ALT create exhausted retries after repeated address collisions');
    }

    // Read the ALT back for its lastExtendedSlot. The create+extend
    // confirmed, but the ALT account can lag the confirm on a load-balanced
    // RPC — poll the read-back instead of trusting a single fetch.
    let fetched = await conn.getAddressLookupTable(tableAddress);
    for (let i = 0; i < ALT_READBACK_MAX_POLLS && !fetched.value; i += 1) {
      await sleep(readbackPollMs);
      fetched = await conn.getAddressLookupTable(tableAddress);
    }
    if (!fetched.value) {
      throw new Error(
        `ALT ${tableAddress.toBase58()} not visible after ${ALT_READBACK_MAX_POLLS} read polls (${created})`,
      );
    }
    await waitForAltUsable(fetched.value.state.lastExtendedSlot);

    alt = fetched.value;
    altAddress = tableAddress;
    console.info(
      `${TAG} ephemeral compose ALT ready: ${tableAddress.toBase58()} ` +
        `(${addresses.length} addresses, createTx ${created})`,
    );
    return alt;
  }

  async function send(instructions: TransactionInstruction[]): Promise<string> {
    // Prepend a priority fee so the compose competes for inclusion.
    // setComputeUnitPrice carries no accounts and sits BEFORE the
    // [secp, vault] pairs, so each secp precompile still immediately
    // precedes its vault instruction (the program's current_index − 1
    // sibling check is preserved) and the ALT address set is unchanged.
    const priorityFee = await computeComposePriorityFee(conn);
    const composeIxs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      ...instructions,
    ];
    const table = await ensureAlt(composeIxs);

    let lastErr: unknown;
    for (let attempt = 0; attempt < COMPOSE_SEND_MAX_ATTEMPTS; attempt += 1) {
      // rule (b): fetch a FRESH v0 blockhash from the preflight bank each
      // attempt. An expired signature is permanently dead, so a
      // fresh-blockhash rebroadcast cannot double-land the revoke+register.
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(commitment);
      // web3.js message/transaction serialization writes into FIXED wire-cap
      // buffers and throws an opaque "encoding overruns Uint8Array" past them
      // (vtx.sign() serializes the message to compute sign data, so the
      // overrun can fire there too) — map it, and any residual length
      // breach, to the loud size error.
      let raw: Uint8Array;
      try {
        const vtx = compileComposeV0(composeIxs, feePayer.publicKey, blockhash, table);
        vtx.sign([feePayer]);
        raw = vtx.serialize();
      } catch (err) {
        if (/overrun|too large/i.test(String((err as Error)?.message ?? err))) {
          throw new Error(
            `composed revoke-then-register v0 tx exceeds the ${TX_SIZE_LIMIT_BYTES}B ` +
              'wire cap — too many sibling PDAs outside the lookup table',
          );
        }
        throw err;
      }
      if (raw.length > TX_SIZE_LIMIT_BYTES) {
        throw new Error(
          `composed revoke-then-register v0 tx ${raw.length}B exceeds the ${TX_SIZE_LIMIT_BYTES}B ` +
            'wire cap — too many sibling PDAs outside the lookup table',
        );
      }

      try {
        // SECURITY-LOAD-BEARING: the preflight simulation runs the secp256r1
        // precompile + program passkey-binding checks — skipPreflight:true
        // would let forged ceremonies burn the payer's fees.
        const signature = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
        const confirmation = await conn.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          commitment,
        );
        if (confirmation.value.err) {
          throw new Error(`composed tx failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
        }
        return signature;
      } catch (err) {
        // ONLY an expiry (never landed, no logs) is safe to rebroadcast. An
        // on-chain program error (has logs) is deterministic — surface it
        // immediately with the logs intact, never retry.
        if (isExpiredUnlanded(err) && attempt < COMPOSE_SEND_MAX_ATTEMPTS - 1) {
          console.warn(
            `${TAG} compose tx expired before landing (attempt ${attempt + 1}, ` +
              `priorityFee ${priorityFee}) — rebroadcasting with a fresh blockhash`,
          );
          lastErr = err;
          continue;
        }
        const logs = Array.isArray((err as { logs?: unknown })?.logs)
          ? ((err as { logs: unknown[] }).logs as unknown[])
          : [];
        if (logs.length) {
          throw new Error(`${(err as Error)?.message ?? err} | ${logs.join(' | ')}`);
        }
        throw err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('compose tx did not land after rebroadcast attempts');
  }

  async function deactivateAlt(): Promise<void> {
    if (!altAddress) return;
    try {
      const ix = AddressLookupTableProgram.deactivateLookupTable({
        lookupTable: altAddress,
        authority: feePayer.publicKey,
      });
      const sig = await sendLegacy([ix], 'ALT deactivate');
      console.info(
        `${TAG} ephemeral compose ALT deactivated: ${altAddress.toBase58()} (${sig}) — ` +
          'rent reclaimable via close_lookup_table after the deactivation cooldown',
      );
    } catch (err) {
      console.warn(
        `${TAG} ALT deactivate failed for ${altAddress?.toBase58()} — rent parks until a ` +
          `later cleanup retries (the compose already landed): ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  return { send, getAltAddress: () => altAddress, deactivateAlt };
}
