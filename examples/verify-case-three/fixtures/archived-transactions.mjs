import {Message, PublicKey, TransactionMessage, VersionedMessage} from '@solana/web3.js';

/** Represent the archived signed message as the two shapes returned by Solana RPC, without changing its bytes. */
export function archivedConnection(fixture) {
  const responses = new Map();
  for (const [signature, archive] of Object.entries(fixture.transactions)) {
    const message = VersionedMessage.deserialize(Buffer.from(archive.messageBase64url, 'base64url'));
    const loaded = {readonly: archive.meta.loadedAddresses.readonly.map(value => new PublicKey(value)),
      writable: archive.meta.loadedAddresses.writable.map(value => new PublicKey(value))};
    const keys = message.getAccountKeys({accountKeysFromLookups: loaded});
    const decoded = TransactionMessage.decompile(message, {accountKeysFromLookups: loaded});
    // web3's legacy representation supplies the RPC's base58 instruction-data encoding; the raw response retains the original message.
    const base58 = Message.compile({payerKey: message.staticAccountKeys[0], recentBlockhash: message.recentBlockhash,
      instructions: decoded.instructions}).instructions;
    const common = {slot: archive.slot, blockTime: archive.blockTime, meta: {...archive.meta, loadedAddresses: loaded}, version: message.version};
    responses.set(signature, {raw: {...common, transaction: {message, signatures: archive.signatures}},
      parsed: {...common, transaction: {signatures: archive.signatures, message: {
        accountKeys: Array.from({length: keys.length}, (_, index) => ({pubkey: keys.get(index),
          signer: message.isAccountSigner(index), writable: message.isAccountWritable(index)})),
        instructions: decoded.instructions.map((ix, index) => ({programId: ix.programId,
          accounts: ix.keys.map(entry => entry.pubkey), data: base58[index].data})),
        recentBlockhash: message.recentBlockhash,
      }}}});
  }
  return {getSlot: async () => Math.max(...Object.values(fixture.transactions).map(tx => tx.slot)),
    getTransaction: async signature => responses.get(signature)?.raw ?? null,
    getParsedTransaction: async signature => responses.get(signature)?.parsed ?? null};
}
