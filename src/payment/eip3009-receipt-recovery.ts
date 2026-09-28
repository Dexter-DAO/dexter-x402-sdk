import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import type { SettlementProbe } from '../adapters/types';
import { EVM_RPC_URLS, USDC_ADDRESSES } from '../constants';
import { decodePaymentReceiptHeader, type PaymentReceipt } from '../client/x402-client';
import type { PaymentAccept } from '../types';

const hashPattern = /^0x[0-9a-f]{64}$/i;
const addressPattern = /^0x[0-9a-f]{40}$/i;
const quantityPattern = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const topic = (text: string) => `0x${bytesToHex(keccak_256(new TextEncoder().encode(text)))}`;
const authorizationUsed = topic('AuthorizationUsed(address,bytes32)');
const transfer = topic('Transfer(address,address,uint256)');
const addressTopic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
const same = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const quantity = (value: unknown): value is string => typeof value === 'string' && quantityPattern.test(value);

// Both headers must agree. Contradictory or malformed merchant evidence cannot
// be overridden by this compatibility path, including an explicit pending state.
function candidate(response: Response, network: string, from: string, amount: string): string | undefined {
  let transaction: string | undefined;
  for (const name of ['PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE']) {
    const raw = response.headers.get(name);
    if (raw === null) continue;
    const value = decodePaymentReceiptHeader(raw);
    if (!value || typeof value.transaction !== 'string' || !hashPattern.test(value.transaction)) return;
    if (value.success !== undefined && value.success !== true) return;
    if (value.network !== undefined && value.network !== network) return;
    if (value.settlementStatus !== undefined && value.settlementStatus !== 'settled') return;
    if ([value.errorReason, value.errorCode, value.errorMessage].some(v => v !== undefined && v !== '')) return;
    if (value.payer !== undefined && !same(value.payer, from)) return;
    if ([value.amountAtomic, value.attemptedAmountAtomic].some(v => v !== undefined && v !== amount)) return;
    if (value.assetDecimals !== undefined && value.assetDecimals !== 6) return;
    if (value.success === true && value.network === network) return; // Normal strict receipt path owns this case.
    if (transaction && !same(value.transaction, transaction)) return;
    transaction = value.transaction;
  }
  return transaction;
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('RPC response unavailable');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('RPC confirmation aborted');
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1_048_576) throw new Error('RPC response too large');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}

/**
 * Confirm an incomplete receipt against this attempt's signed EIP-3009 payment.
 * RPC failure leaves the receipt unconfirmed. Never reads the merchant body,
 * signs, sends another merchant request, or infers payment from nonce consumption.
 */
export async function recoverIncompleteEip3009Receipt(
  response: Response,
  receipt: PaymentReceipt,
  probe: SettlementProbe | undefined,
  accept: PaymentAccept,
): Promise<void> {
  if (receipt.settlementStatus !== 'unconfirmed' || probe?.kind !== 'eip3009'
    || accept.scheme !== 'exact' || (accept.extra?.assetTransferMethod !== undefined && accept.extra.assetTransferMethod !== 'eip3009')) return;
  const network = `eip155:${probe.chainId}`;
  const registeredAsset = USDC_ADDRESSES[network];
  const rpcUrl = EVM_RPC_URLS[network];
  const amount = accept.amount ?? accept.maxAmountRequired;
  if (!rpcUrl || !registeredAsset || accept.network !== network || !same(probe.asset, registeredAsset)
    || !same(accept.asset, probe.asset) || !addressPattern.test(probe.from)
    || !probe.to || !addressPattern.test(probe.to) || !same(accept.payTo, probe.to)
    || !amount || !/^[0-9]+$/.test(amount) || amount !== probe.amount || !hashPattern.test(probe.nonce)) return;
  const txHash = candidate(response, network, probe.from, amount);
  if (!txHash) return;

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(new Error('RPC confirmation timed out')); }, 5000);
  });
  let nextId = 0;
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const id = ++nextId;
    const work = async () => {
      const res = await fetch(rpcUrl, { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      const envelope = await boundedJson(res, controller.signal);
      if (!object(envelope) || envelope.jsonrpc !== '2.0' || envelope.id !== id || envelope.error) throw new Error('Invalid RPC response');
      return envelope.result;
    };
    return Promise.race([work(), deadline]);
  };

  try {
    const [chainId, mined, transaction] = await Promise.all([
      rpc('eth_chainId', []), rpc('eth_getTransactionReceipt', [txHash]), rpc('eth_getTransactionByHash', [txHash]),
    ]);
    if (!quantity(chainId) || BigInt(chainId) !== BigInt(probe.chainId) || !object(mined) || !object(transaction)
      || mined.status !== '0x1' || !same(mined.transactionHash, txHash) || !same(transaction.hash, txHash)
      || typeof mined.blockHash !== 'string' || !hashPattern.test(mined.blockHash)
      || !same(transaction.blockHash, mined.blockHash) || !quantity(mined.blockNumber)
      || transaction.blockNumber !== mined.blockNumber || !quantity(mined.transactionIndex)
      || transaction.transactionIndex !== mined.transactionIndex
      || (transaction.chainId !== undefined && (!quantity(transaction.chainId) || BigInt(transaction.chainId) !== BigInt(probe.chainId)))) return;
    const transactionIndex = Number(BigInt(mined.transactionIndex));
    if (!Number.isSafeInteger(transactionIndex)) return;
    const block = await rpc('eth_getBlockByNumber', [mined.blockNumber, false]);
    if (!object(block) || !same(block.hash, mined.blockHash) || block.number !== mined.blockNumber
      || !Array.isArray(block.transactions) || !same(block.transactions[transactionIndex], txHash)
      || !Array.isArray(mined.logs)) return;

    let used = false;
    let transferred = false;
    for (const log of mined.logs) {
      if (!object(log) || (log.removed !== undefined && log.removed !== false) || !same(log.blockHash, mined.blockHash)
        || log.blockNumber !== mined.blockNumber || !same(log.transactionHash, txHash)
        || log.transactionIndex !== mined.transactionIndex || !Array.isArray(log.topics)) return;
      if (!same(log.address, probe.asset)) continue;
      if (same(log.topics[0], authorizationUsed) && log.topics.length === 3
        && same(log.topics[1], addressTopic(probe.from)) && same(log.topics[2], probe.nonce)
        && log.data === '0x') used = true;
      if (same(log.topics[0], transfer) && same(log.topics[1], addressTopic(probe.from))) {
        if (transferred || log.topics.length !== 3 || !same(log.topics[2], addressTopic(probe.to))
          || typeof log.data !== 'string' || !hashPattern.test(log.data) || BigInt(log.data) !== BigInt(amount)) return;
        transferred = true;
      }
    }
    if (!used || !transferred) return;
    receipt.settlementStatus = 'settled';
    receipt.amountAtomic = amount;
    receipt.chainConfirmation = {
      source: 'eip3009_transaction', finality: 'included', network,
      blockHash: mined.blockHash, blockNumber: mined.blockNumber, authorizationNonce: probe.nonce,
    };
  } catch {
    // Retain the merchant response, tx candidate, and unconfirmed state.
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
