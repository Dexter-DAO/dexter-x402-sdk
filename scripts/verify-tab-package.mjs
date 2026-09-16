#!/usr/bin/env node
// Run from an installed consumer directory, or pass that directory explicitly:
// node /path/to/sdk/scripts/verify-tab-package.mjs /path/to/consumer
// Uses package exports in fresh ESM/CJS processes. No RPC, HTTP, or signing
// with user credentials: all keys and chain responses are local fixtures.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

async function qualify(mode) {
  const { default: assert } = await import('node:assert/strict');
  const { createRequire } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const require = createRequire(join(process.cwd(), 'package.json'));
  const load = mode === 'esm'
    ? (specifier) => import(specifier)
    : async (specifier) => require(specifier);
  // Resolve dependencies as the installed x402 package does, including
  // layouts where transitive dependencies are not hoisted to the consumer.
  const dependencyRequire = createRequire(require.resolve('@dexterai/x402/tab'));
  const { Keypair, PublicKey, TransactionInstruction, TransactionMessage } =
    dependencyRequire('@solana/web3.js');
  const nacl = dependencyRequire('tweetnacl');
  const tabApi = await load('@dexterai/x402/tab');
  const sellerApi = await load('@dexterai/x402/tab/seller');
  const adapterApi = await load('@dexterai/x402/tab/adapters/solana');
  const { deriveSessionPda } = dependencyRequire('@dexterai/vault/session');
  const { deriveSwigVaultBindingPda } = dependencyRequire('@dexterai/vault/credit');
  const { buildSettleVoucherInstruction } = dependencyRequire('@dexterai/vault/instructions');

  function versionFor(specifier, name) {
    let directory = dirname(dependencyRequire.resolve(specifier));
    while (directory !== dirname(directory)) {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        if (manifest.name === name) return manifest.version;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      directory = dirname(directory);
    }
    throw new Error(`cannot locate manifest for ${name}`);
  }

  for (const name of [
    'signContextBoundFinalVoucherV2', 'sessionVoucherV2Nonce',
    'finalVoucherV2Sequence', 'finalVoucherV2ReservationIdentity',
    'finalVoucherV2ReservationMemo', 'tabFromGrant',
  ]) {
    assert.equal(typeof tabApi[name], 'function', `${mode}: missing V2 export ${name}`);
  }

  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error('unexpected HTTP request during offline package qualification');
  };
  const vault = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey;
  const seller = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
  const swig = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
  const session = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4));
  const programId = tabApi.DEXTER_VAULT_PROGRAM_ID;
  const nonce = tabApi.sessionVoucherV2Nonce(42n);
  assert.equal(nonce, 0x8000_002a, 'preserve the issuer authorization context');
  const [sessionPda, sessionBump] = deriveSessionPda(vault, seller, programId);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const params = {
    counterparty: seller.toBase58(),
    sessionPubkey: new PublicKey(session.publicKey).toBase58(),
    maxAmountAtomic: '1000000',
    expiresAtUnix: expiresAt,
    nonce,
    maxRevolvingCapacityAtomic: '500000',
  };
  const registration = tabApi.sessionRegisterMessage({
    programId,
    vaultPda: vault,
    sessionPubkey: session.publicKey,
    maxAmount: 1000000n,
    expiresAt: BigInt(expiresAt),
    allowedCounterparty: seller,
    nonce,
    maxRevolvingCapacity: 500000n,
  });
  assert.equal(registration.length, 188);
  const parsed = sellerApi.parseRegistration(registration);
  assert.equal(parsed.nonce, nonce);
  assert.equal(parsed.vaultPda.toBase58(), vault.toBase58());
  const signingInput = {
    programId: programId.toBase58(),
    vaultPda: vault.toBase58(),
    sessionPda: sessionPda.toBase58(),
    seller: seller.toBase58(),
    sessionNonce: nonce,
    channelId: 'ab'.repeat(32),
    cumulativeAmountAtomic: '125',
    sequenceOrdinal: 1,
    sessionPrivateKey: session.secretKey,
    sessionPublicKey: session.publicKey,
    sessionRegistration: registration,
  };
  const signed = tabApi.signContextBoundFinalVoucherV2(signingInput);
  assert.equal(signed.sequenceNumber, 0x8000_0001);
  const voucher = {
    payload: {
      channelId: signed.channelId,
      cumulativeAmount: signed.cumulativeAmount,
      sequenceNumber: signed.sequenceNumber,
    },
    sessionPublicKey: Buffer.from(signed.sessionPublicKey, 'hex'),
    sessionSignature: Buffer.from(signed.sessionSignature, 'hex'),
    sessionRegistration: Buffer.from(signed.sessionRegistration, 'hex'),
  };
  sellerApi.verifyVoucherSignature(voucher, Buffer.from(signed.channelId, 'hex'));
  assert.throws(() => sellerApi.verifyVoucherSignature({
    ...voucher,
    payload: { ...voucher.payload, cumulativeAmount: '126' },
  }, Buffer.from(signed.channelId, 'hex')));
  const otherVault = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey;
  assert.throws(() => tabApi.signContextBoundFinalVoucherV2({
    ...signingInput,
    vaultPda: otherVault.toBase58(),
    sessionPda: deriveSessionPda(otherVault, seller, programId)[0].toBase58(),
  }), /registration_identity_mismatch/);
  assert.throws(() => tabApi.signVoucher({
    publicKey: session.publicKey,
    privateKey: session.secretKey,
    registration,
    scope: {
      channelId: signed.channelId,
      maxAmountAtomic: params.maxAmountAtomic,
      expiresAtUnix: expiresAt,
      allowedCounterparty: params.counterparty,
    },
  }, voucher.payload, Buffer.from(signed.channelId, 'hex')), /durable reservation/);

  // Actual SessionAccount byte layout, matching the current issuer. This is
  // deliberately separate from the package's encoder/decoder implementation.
  const account = Buffer.alloc(162);
  Buffer.from([74, 34, 65, 133, 96, 163, 80, 69]).copy(account, 0);
  account.writeUInt8(1, 8);
  account.writeUInt8(sessionBump, 9);
  vault.toBuffer().copy(account, 10);
  Buffer.from(session.publicKey).copy(account, 42);
  account.writeBigUInt64LE(1000000n, 74);
  account.writeBigInt64LE(BigInt(expiresAt), 82);
  seller.toBuffer().copy(account, 90);
  account.writeUInt32LE(nonce, 122);
  account.writeBigUInt64LE(500000n, 142);
  let accountReads = 0;
  const connection = {
    getAccountInfo: async (address) => {
      accountReads += 1;
      assert.equal(address.toBase58(), sessionPda.toBase58());
      return { data: account, owner: programId, executable: false, lamports: 1, rentEpoch: 0 };
    },
  };
  const options = {
    sessionSecretKey: session.secretKey,
    params,
    vaultPda: vault,
    swigAddress: swig.toBase58(),
    connection,
    perUnitCapAtomic: '5000',
  };
  await assert.rejects(tabApi.tabFromGrant({
    ...options, params: { ...params, nonce: 42 },
  }), /native_tab_v1_migration_required/);
  await assert.rejects(tabApi.tabFromGrant(options), /native_tab_v2_reservation_fence_required/);
  assert.equal(accountReads, 0, 'migration/provider checks must precede RPC');

  const reservationInputs = [];
  let confirmedReceipt;
  const tab = await tabApi.tabFromGrant({
    ...options,
    reserveFinalVoucherV2: async (input) => {
      reservationInputs.push(input);
      if (confirmedReceipt) return confirmedReceipt;
      // Model an uncertain provider outcome. A grant alone must never bypass
      // this callback or release its bearer voucher after this refusal.
      throw new Error('qualification_reservation_unconfirmed');
    },
  });
  assert.equal(accountReads, 1);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(tab.signNextVoucher('125'), /qualification_reservation_unconfirmed/);
    assert.equal(tab.state.spent, '0');
  }
  assert.equal(reservationInputs.length, 2);
  assert.equal(reservationInputs[0].idempotencyKey, reservationInputs[1].idempotencyKey);
  assert.deepEqual(reservationInputs[0].voucher, reservationInputs[1].voucher);
  assert.equal(reservationInputs[0].sessionNonce, nonce);
  assert.equal(reservationInputs[0].reservationAmountAtomic, '125');
  assert.equal(reservationInputs[0].previousCumulativeAtomic, '0');
  assert.match(tabApi.finalVoucherV2ReservationMemo(reservationInputs[0]),
    /^dexter-native-tab-v2-reservation\/v1:[0-9a-f]{64}$/);

  const input = reservationInputs[0];
  const authority = Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey;
  const [bindingPda, bindingBump] = deriveSwigVaultBindingPda(swig, programId);
  const binding = Buffer.alloc(74);
  Buffer.from([56, 67, 4, 209, 238, 143, 0, 129]).copy(binding, 0);
  binding.writeUInt8(bindingBump, 9);
  swig.toBuffer().copy(binding, 10);
  vault.toBuffer().copy(binding, 42);
  const vaultAccount = Buffer.alloc(181);
  Buffer.from([211, 8, 232, 43, 2, 152, 117, 119]).copy(vaultAccount, 0);
  vaultAccount.writeUInt8(7, 8);
  vaultAccount.writeUInt8(255, 9);
  Buffer.alloc(33, 7).copy(vaultAccount, 10);
  swig.toBuffer().copy(vaultAccount, 43);
  vaultAccount.writeUInt32LE(1, 79);
  authority.toBuffer().copy(vaultAccount, 116);
  vaultAccount.writeUInt8(1, 148);
  account.writeBigUInt64LE(125n, 134);
  const signature = '5'.repeat(88);
  const message = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58(),
    instructions: [
      buildSettleVoucherInstruction({
        vaultPda: vault, dexterAuthority: authority, allowedCounterparty: seller,
        swigAddress: swig, vaultUsdcAta: null, siblingSessionPdas: [],
        amount: 125n, increment: true, programId,
      }),
      new TransactionInstruction({
        programId: adapterApi.SOLANA_FINAL_VOUCHER_V2_MEMO_PROGRAM_ID,
        keys: [{ pubkey: authority, isSigner: true, isWritable: false }],
        data: Buffer.from(tabApi.finalVoucherV2ReservationMemo(input), 'utf8'),
      }),
    ],
  }).compileToV0Message();
  confirmedReceipt = {
    contract: 'dexter-native-tab-open-receipt/v1',
    operationId: 'a'.repeat(64), callerOperationId: input.idempotencyKey,
    network: input.network, transaction: signature, commitment: 'confirmed',
    confirmationSlot: 100, postStateSlot: 101,
    buyerSwigAddress: input.buyerSwigAddress, vaultPda: input.vaultPda,
    sessionPda: input.sessionPda, seller: input.seller, channelId: input.channelId,
    sessionPublicKey: Buffer.from(input.voucher.sessionPublicKey).toString('hex'),
    voucherDigest: input.voucherDigest, cumulativeAmountAtomic: '125',
    sequenceNumber: input.voucher.payload.sequenceNumber,
    providerReceiptId: 'qualification:1', reservationAmountAtomic: '125',
    pendingVoucherCountBefore: 0, pendingVoucherCountAfter: 1,
    currentOutstandingBeforeAtomic: '0', currentOutstandingAfterAtomic: '125',
  };
  Object.assign(connection, {
    getSignatureStatuses: async () => ({
      value: [{ err: null, confirmationStatus: 'confirmed', slot: 100, confirmations: 1 }],
    }),
    getTransaction: async () => ({
      slot: 100, blockTime: null, version: 0,
      meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
      transaction: { signatures: [signature], message },
    }),
    getMultipleAccountsInfoAndContext: async (addresses, options) => {
      assert.deepEqual(addresses.map((address) => address.toBase58()),
        [bindingPda, vault, sessionPda].map((address) => address.toBase58()));
      assert.deepEqual(options, { commitment: 'confirmed', minContextSlot: 100 });
      return {
        context: { slot: 101 },
        value: [binding, vaultAccount, account].map((data) => ({
          data, owner: programId, executable: false, lamports: 1, rentEpoch: 0,
        })),
      };
    },
  });
  for (const version of [1, 2, 3, 4]) {
    binding.writeUInt8(version, 8);
    await assert.doesNotReject(
      adapterApi.verifySolanaFinalVoucherV2Reservation(connection, input, confirmedReceipt),
      `known binding version ${version} must pass reservation verification`,
    );
  }
  for (const version of [0, 5, 255]) {
    binding.writeUInt8(version, 8);
    await assert.rejects(
      adapterApi.verifySolanaFinalVoucherV2Reservation(connection, input, confirmedReceipt),
      { code: 'binding_version' },
    );
  }
  binding.writeUInt8(4, 8);
  const released = await tab.signNextVoucher('125');
  assert.deepEqual(released.payload, input.voucher.payload);
  assert.equal(tab.state.spent, '0.000125');
  sellerApi.verifyVoucherSignature(released, Buffer.from(input.channelId, 'hex'));
  assert.equal(networkCalls, 0);
  session.secretKey.fill(0);
  console.log(JSON.stringify({
    mode,
    x402: versionFor('@dexterai/x402/tab', '@dexterai/x402'),
    vault: versionFor('@dexterai/vault/session', '@dexterai/vault'),
    checks: [
      'public exports', 'issuer V2 nonce', 'seller signature verification',
      'altered amount rejection', 'altered context rejection', 'legacy signer rejection',
      'V1 buyer migration refusal', 'reservation provider required before RPC',
      'grant construction', 'unconfirmed reservation blocks voucher release',
      'same-voucher retry', 'binding versions 1/2/3/4', 'unknown binding rejection',
      'confirmed reservation fixture releases exact voucher',
    ],
    networkCalls,
    scope: 'offline artifact compatibility; no paid delivery or settlement proof',
  }));
}

const consumerDirectory = resolve(process.argv[2] ?? process.cwd());
for (const mode of ['esm', 'cjs']) {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `try { await (${qualify.toString()})(${JSON.stringify(mode)}); }
     catch (error) {
       console.error(JSON.stringify({ mode: ${JSON.stringify(mode)}, ok: false,
         name: error.name, error: error.message, code: error.code }));
       process.exitCode = 1;
     }`,
  ], { cwd: consumerDirectory, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
