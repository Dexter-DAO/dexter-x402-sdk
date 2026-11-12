import { describe, it, expect, vi } from 'vitest';
import {
  NanoAdapter,
  NANO_MAINNET,
  NANO_ASSET,
  isNanoWallet,
  isValidNanoAddress,
  nanoAddressToPublicKey,
  publicKeyToNanoAddress,
  rawToXno,
  xnoToRaw,
  type NanoWallet,
} from '../nano';
import { createDefaultAdapters } from '..';
import type { SettlementProbe } from '../types';
import type { PaymentAccept } from '../../types';

// Genesis account and its public key — a published, well-known pair.
const GENESIS = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const GENESIS_KEY = 'E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA';
// All-zero public key ("burn" account).
const BURN = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp';

const PAYER = BURN;
const MERCHANT = GENESIS;
const RPC = 'https://nano-node.test/rpc';
const BLOCK_HASH = 'A'.repeat(64);
const ONE_MILLI_XNO = '1000000000000000000000000000'; // 0.001 XNO in raw

function createAccept(overrides: Partial<PaymentAccept> = {}): PaymentAccept {
  return {
    scheme: 'exact',
    network: NANO_MAINNET,
    amount: ONE_MILLI_XNO,
    asset: NANO_ASSET,
    payTo: MERCHANT,
    maxTimeoutSeconds: 60,
    extra: { decimals: 30 },
    ...overrides,
  } as PaymentAccept;
}

function createWallet(hash = BLOCK_HASH): NanoWallet & { send: ReturnType<typeof vi.fn> } {
  return { address: PAYER, send: vi.fn(async () => hash) };
}

function probe(overrides: Partial<Extract<SettlementProbe, { kind: 'nano' }>> = {}): SettlementProbe {
  return { kind: 'nano', blockHash: BLOCK_HASH, payTo: MERCHANT, amount: ONE_MILLI_XNO, ...overrides };
}

function blockInfo(overrides: Record<string, unknown> = {}, contents: Record<string, unknown> = {}) {
  return {
    block_account: PAYER,
    amount: ONE_MILLI_XNO,
    balance: '0',
    height: '2',
    confirmed: 'true',
    subtype: 'send',
    contents: {
      type: 'state',
      account: PAYER,
      link_as_account: MERCHANT,
      ...contents,
    },
    ...overrides,
  };
}

function rpcReturning(body: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status }));
}

describe('Nano address validation', () => {
  it('accepts checksummed nano_ and xrb_ addresses', () => {
    expect(isValidNanoAddress(GENESIS)).toBe(true);
    expect(isValidNanoAddress(GENESIS.replace('nano_', 'xrb_'))).toBe(true);
    expect(isValidNanoAddress(BURN)).toBe(true);
  });

  it('round-trips a public key', () => {
    const key = nanoAddressToPublicKey(GENESIS);
    expect(key && Buffer.from(key).toString('hex').toUpperCase()).toBe(GENESIS_KEY);
    expect(publicKeyToNanoAddress(Buffer.from(GENESIS_KEY, 'hex'))).toBe(GENESIS);
  });

  it('rejects a bad checksum, bad alphabet, bad length and bad prefix', () => {
    const lastChar = GENESIS.at(-1) === '3' ? '4' : '3';
    expect(isValidNanoAddress(GENESIS.slice(0, -1) + lastChar)).toBe(false);
    // Flip one key character; the checksum no longer matches.
    expect(isValidNanoAddress(GENESIS.slice(0, 10) + 'z' + GENESIS.slice(11))).toBe(false);
    expect(isValidNanoAddress(GENESIS.replace('t6k', 't0k'))).toBe(false); // '0' is not in the alphabet
    expect(isValidNanoAddress(GENESIS.slice(0, -1))).toBe(false);
    expect(isValidNanoAddress(GENESIS.replace('nano_', 'ban_'))).toBe(false);
    expect(isValidNanoAddress('')).toBe(false);
  });
});

describe('Nano amount conversion', () => {
  it('converts XNO to raw with bigint precision (1 XNO = 10^30 raw)', () => {
    expect(xnoToRaw('1')).toBe(10n ** 30n);
    expect(xnoToRaw('0.001')).toBe(BigInt(ONE_MILLI_XNO));
    expect(xnoToRaw('0.000000000000000000000000000001')).toBe(1n);
    expect(xnoToRaw('133248.297')).toBe(133248297n * 10n ** 27n);
  });

  it('converts raw to XNO without float rounding', () => {
    expect(rawToXno(10n ** 30n)).toBe('1');
    expect(rawToXno(BigInt(ONE_MILLI_XNO))).toBe('0.001');
    expect(rawToXno(1n)).toBe('0.000000000000000000000000000001');
    expect(rawToXno(0n)).toBe('0');
  });

  it('rejects malformed amounts', () => {
    expect(() => xnoToRaw('1e-3')).toThrow(/Invalid XNO amount/);
    expect(() => xnoToRaw('-1')).toThrow(/Invalid XNO amount/);
    expect(() => xnoToRaw('0.0000000000000000000000000000001')).toThrow(/Invalid XNO amount/);
  });
});

describe('NanoAdapter', () => {
  it('is opt-in: not part of the default adapters', () => {
    expect(createDefaultAdapters().some(a => a.canHandle(NANO_MAINNET))).toBe(false);
  });

  it('handles nano:mainnet only', () => {
    const adapter = new NanoAdapter();
    expect(adapter.canHandle(NANO_MAINNET)).toBe(true);
    expect(adapter.canHandle('eip155:8453')).toBe(false);
    expect(adapter.family).toBe('nano');
  });

  it('recognises a wallet by address and send()', () => {
    expect(isNanoWallet(createWallet())).toBe(true);
    expect(isNanoWallet({ address: 'nano_bad', send: async () => BLOCK_HASH })).toBe(false);
    expect(isNanoWallet({ address: PAYER })).toBe(false);
  });

  describe('buildTransaction', () => {
    it('sends the exact raw amount to payTo and returns the block hash', async () => {
      const wallet = createWallet('ab'.repeat(32));
      const signed = await new NanoAdapter().buildTransaction(createAccept(), wallet);

      expect(wallet.send).toHaveBeenCalledWith({ to: MERCHANT, amountRaw: BigInt(ONE_MILLI_XNO) });
      expect(JSON.parse(signed.serialized)).toEqual({ blockHash: 'AB'.repeat(32), account: PAYER });
      expect(signed.signature).toBe('AB'.repeat(32));
      expect(signed.settlementProbe).toEqual({
        kind: 'nano', blockHash: 'AB'.repeat(32), payTo: MERCHANT, amount: ONE_MILLI_XNO,
      });
    });

    it('refuses invalid requirements before the wallet sends', async () => {
      const adapter = new NanoAdapter();
      const wallet = createWallet();
      await expect(adapter.buildTransaction(createAccept({ payTo: GENESIS.slice(0, -1) + 'x' }), wallet))
        .rejects.toThrow(/Invalid Nano payTo/);
      await expect(adapter.buildTransaction(createAccept({ asset: 'USDC' }), wallet))
        .rejects.toThrow(/Unsupported Nano asset/);
      await expect(adapter.buildTransaction(createAccept({ amount: '0' }), wallet))
        .rejects.toThrow(/greater than zero/);
      await expect(adapter.buildTransaction(createAccept({ amount: '0.5' }), wallet))
        .rejects.toThrow(/Invalid raw amount/);
      await expect(adapter.buildTransaction(createAccept({ scheme: 'tab' }), wallet))
        .rejects.toThrow(/Unsupported payment scheme/);
      expect(wallet.send).not.toHaveBeenCalled();
    });

    it('rejects a wallet that returns something other than a block hash', async () => {
      await expect(new NanoAdapter().buildTransaction(createAccept(), createWallet('not-a-hash')))
        .rejects.toThrow(/invalid block hash/);
    });
  });

  describe('getBalance', () => {
    it('reads account_balance from the configured node', async () => {
      const fetch = rpcReturning({ balance: (2n * 10n ** 30n).toString(), receivable: '0' });
      const adapter = new NanoAdapter({ fetch, rpcUrls: { [NANO_MAINNET]: RPC } });
      expect(await adapter.getBalance(createAccept(), createWallet())).toBe(2);
      expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ action: 'account_balance', account: PAYER });
    });

    it('throws when no node is configured', async () => {
      await expect(new NanoAdapter().getBalance(createAccept(), createWallet()))
        .rejects.toThrow(/No Nano RPC URL configured/);
    });
  });

  describe('confirmSettlement', () => {
    it('is settled for a confirmed send of the required amount to payTo, in one block_info call', async () => {
      const fetch = rpcReturning(blockInfo());
      const result = await new NanoAdapter({ fetch }).confirmSettlement(probe(), RPC);
      expect(result).toEqual({ settled: true, txSignature: BLOCK_HASH });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe(RPC);
      expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({
        action: 'block_info', json_block: 'true', hash: BLOCK_HASH,
      });
    });

    it('accepts an overpayment and an xrb_ destination for the same account', async () => {
      const fetch = rpcReturning(blockInfo(
        { amount: (BigInt(ONE_MILLI_XNO) + 1n).toString() },
        { link_as_account: MERCHANT.replace('nano_', 'xrb_') },
      ));
      expect(await new NanoAdapter({ fetch }).confirmSettlement(probe(), RPC)).toMatchObject({ settled: true });
    });

    it('is not settled when underpaid', async () => {
      const fetch = rpcReturning(blockInfo({ amount: (BigInt(ONE_MILLI_XNO) - 1n).toString() }));
      expect(await new NanoAdapter({ fetch }).confirmSettlement(probe(), RPC)).toEqual({ settled: false });
    });

    it('is not settled when sent to a different account', async () => {
      const fetch = rpcReturning(blockInfo({}, { link_as_account: BURN }));
      expect(await new NanoAdapter({ fetch }).confirmSettlement(probe(), RPC)).toEqual({ settled: false });
    });

    it('is not settled for a receive block', async () => {
      const fetch = rpcReturning(blockInfo({ subtype: 'receive' }));
      expect(await new NanoAdapter({ fetch }).confirmSettlement(probe(), RPC)).toEqual({ settled: false });
    });

    it('throws (unknown) for a matching send that is not yet confirmed', async () => {
      const fetch = rpcReturning(blockInfo({ confirmed: 'false' }));
      await expect(new NanoAdapter({ fetch }).confirmSettlement(probe(), RPC)).rejects.toThrow(/not yet confirmed/);
    });

    it('throws on an RPC error', async () => {
      const fetch = rpcReturning({ error: 'Block not found' });
      await expect(new NanoAdapter({ fetch }).confirmSettlement(probe(), RPC)).rejects.toThrow(/RPC error.*Block not found/);
    });

    it('throws on an HTTP failure', async () => {
      const fetch = rpcReturning({}, 503);
      await expect(new NanoAdapter({ fetch }).confirmSettlement(probe(), RPC)).rejects.toThrow(/RPC request failed: 503/);
    });

    it('refuses a probe of another chain', async () => {
      const fetch = rpcReturning(blockInfo());
      const evmProbe: SettlementProbe = { kind: 'permit2', from: '0x1', nonce: '1', chainId: 8453 };
      await expect(new NanoAdapter({ fetch }).confirmSettlement(evmProbe, RPC)).rejects.toThrow(/cannot handle probe kind "permit2"/);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
