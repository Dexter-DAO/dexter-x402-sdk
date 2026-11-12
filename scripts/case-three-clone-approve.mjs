#!/usr/bin/env node
// A software passkey on a disposable loopback clone. It commits no seller binding.
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { AddressLookupTableProgram, Connection, ComputeBudgetProgram, PublicKey, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js';
import { approveSpendGrant, parseSpendGrantRequest } from '@dexterai/vault/grant';
import { fetchPasskeyAuthorizationState } from '@dexterai/vault';
import { deriveSessionPda, fetchSessionAccount, fetchVaultSessionAccounts, resolveVaultUsdcAta, sessionPdasOf } from '@dexterai/vault/session';
import { buildRegisterSessionKeyInstruction } from '@dexterai/vault/instructions';
import { readGraphConfigOnchain, readVaultFull } from '@dexterai/vault/reader';
import { ceremony, send, softwareOwner } from './case-two-clone.mjs';
import { readKey, save, withGrantLock } from './case-two-self-held.mjs';
import { assertFreshReceipt, refusalJson } from './case-two-refusal.mjs';

export function assertCloneState(state, stateFile) {
  const rpc = new URL(state.rpc);
  if (rpc.protocol !== 'http:' || rpc.username || rpc.password
    || !['127.0.0.1', 'localhost', '[::1]'].includes(rpc.hostname)) throw new Error('clone approval accepts only loopback HTTP RPC');
  const root = dirname(resolve(stateFile));
  if (resolve(state.out) !== root) throw new Error('clone state directory differs from its saved path');
  for (const [field, name] of [['feePayerKeyPath', 'feePayer.json'], ['authorityKeyPath', 'authority.json'], ['softwareOwnerPath', 'owner.json']]) {
    if (resolve(state[field]) !== join(root, name)) throw new Error('clone key paths must name the generated files beside state.json');
  }
}

export async function approveCloneGrant({ state: stateFile, grant: grantFile, out = `${grantFile}.approval.json` }) {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  // This guard runs before any private-key file is opened.
  assertCloneState(state, stateFile);
  assertFreshReceipt(out);
  if (state.registerTx) throw new Error('this clone already records a registration; inspect it before another approval');
  const ownerStat = lstatSync(state.softwareOwnerPath);
  if (!ownerStat.isFile() || (ownerStat.mode & 0o777) !== 0o600 || ownerStat.uid !== process.getuid()) throw new Error('clone software owner must be an owned regular file with mode 600');
  return withGrantLock(grantFile, async record => {
    const request = parseSpendGrantRequest(record.request);
    if (!request.sessionPubkey) throw new Error('clone grant must supply the agent public key');
    const connection = new Connection(state.rpc, 'confirmed');
    const vault = new PublicKey(state.vault), seller = new PublicKey(request.counterparty);
    if (await fetchSessionAccount(connection, vault, seller)) throw new Error('seller already has a clone session; approval would replace it');
    const full = await readVaultFull(connection, vault);
    if (!full.exists || full.swigAddress !== state.swig) throw new Error('clone vault or Swig differs from the saved state');
    const authorization = await fetchPasskeyAuthorizationState(connection, vault);
    if (!authorization) throw new Error('clone authorization guard is missing; finish clone birth first');
    const graph = await readGraphConfigOnchain(connection);
    const swigAddress = new PublicKey(full.swigAddress);
    const vaultUsdcAta = await resolveVaultUsdcAta(connection, swigAddress, new PublicKey(graph.usdcMint));
    const payer = readKey(state.feePayerKeyPath), authority = readKey(state.authorityKeyPath);
    try {
      if (full.dexterAuthority !== authority.publicKey.toBase58()) throw new Error('clone authority key does not match the cloned vault');
      const owner = softwareOwner(state.softwareOwnerPath);
      const approved = await approveSpendGrant({ request, vaultPda: vault, authorizationNonce: authorization.nonce,
        sign: message => ceremony(connection, owner, vault, message, authorization.nonce) });
      const siblings = sessionPdasOf(await fetchVaultSessionAccounts(connection, vault));
      const p = approved.params, c = approved.ceremony;
      const instruction = buildRegisterSessionKeyInstruction({ vaultPda: vault,
        sessionPubkey: new PublicKey(p.sessionPubkey).toBytes(), maxAmount: BigInt(p.maxAmountAtomic),
        expiresAt: BigInt(p.expiresAtUnix), allowedCounterparty: seller, nonce: p.nonce,
        maxRevolvingCapacity: BigInt(p.maxRevolvingCapacityAtomic), swigAddress, vaultUsdcAta,
        payer: payer.publicKey, siblingSessionPdas: siblings,
        clientDataJSON: c.clientDataJSON, authenticatorData: c.authenticatorData });
      const proof = { schema: 'case-three/clone-approval/v1', stage: 'prepared', vault: vault.toBase58(),
        seller: seller.toBase58(), params: p, authorizationNonce: authorization.nonce.toString(),
        message: Buffer.from(approved.message).toString('base64url'),
        clientDataJSON: Buffer.from(c.clientDataJSON).toString('base64url'),
        authenticatorData: Buffer.from(c.authenticatorData).toString('base64url'),
        softwarePasskey: true, sellerBindingCommitted: false, screenRendered: false,
        siblingSessionPdas: siblings.map(key => key.toBase58()) };
      save(out, proof, true);
      try {
        // The WebAuthn envelope plus registration exceeds Solana's packet limit
        // with static keys. A disposable local lookup table keeps the same instructions.
        // The reported tip can still be absent from SlotHashes on a new clone.
        // Its newest retained ancestor is a slot the ALT program can actually accept.
        const hashes = await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, 'confirmed');
        if (!hashes || hashes.data.length < 16 || hashes.data.readBigUInt64LE(0) === 0n) throw new Error('local SlotHashes is empty');
        const recentSlot = Number(hashes.data.readBigUInt64LE(8));
        const [create, address] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot });
        const extend = AddressLookupTableProgram.extendLookupTable({ authority: payer.publicKey, payer: payer.publicKey, lookupTable: address,
          addresses: instruction.keys.filter(key => !key.isSigner).map(key => key.pubkey) });
        proof.lookupTable = { address: address.toBase58(), recentSlot, transaction: await send(connection, payer, [create, extend]) };
        save(out, proof);
        let table;
        for (let n = 0; n < 60; n++) {
          table = (await connection.getAddressLookupTable(address)).value;
          if (table && await connection.getSlot('confirmed') > table.state.lastExtendedSlot) break;
          await new Promise(done => setTimeout(done, 250));
        }
        if (!table || await connection.getSlot('confirmed') <= table.state.lastExtendedSlot) throw new Error('local lookup table did not activate');
        proof.registerTx = await send(connection, payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), c.precompile, instruction], [payer, authority], [table]);
        proof.stage = 'registered';
        save(out, proof);
        const registered = await fetchSessionAccount(connection, vault, seller);
        if (!registered || registered.version !== 1 || new PublicKey(registered.session.sessionPubkey).toBase58() !== p.sessionPubkey
          || registered.session.maxAmount !== BigInt(p.maxAmountAtomic)
          || registered.session.maxRevolvingCapacity !== BigInt(p.maxRevolvingCapacityAtomic)
          || registered.session.expiresAt !== p.expiresAtUnix || registered.session.nonce !== p.nonce) throw new Error('registered session differs from the grant');
        proof.sessionVerified = true;
        Object.assign(state, { registerTx: proof.registerTx, seller: seller.toBase58(), sessionPda: deriveSessionPda(vault, seller)[0].toBase58(),
          agentKeyPath: record.keyPath, approvalProof: resolve(out) });
        save(stateFile, state);
        save(out, proof);
        return proof;
      } catch (error) { proof.error = error.message; save(out, proof); throw error; }
    } finally { payer.secretKey.fill(0); authority.secretKey.fill(0); }
  });
}

async function main() {
  const { values } = parseArgs({ options: { state: { type: 'string' }, grant: { type: 'string' }, out: { type: 'string' } } });
  if (!values.state || !values.grant) throw new Error('--state and --grant are required');
  console.log(refusalJson(await approveCloneGrant(values), 'base64url'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
