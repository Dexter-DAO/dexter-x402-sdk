import { createReadStream, type ReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createBudgetAccount, type BudgetAccountConfig } from '../budget-account';
import { createX402Client } from '../x402-client';
import { createKeypairWallet } from '../keypair-wallet';
import { createSolanaAdapter } from '../../adapters';
import type { ChainAdapter } from '../../adapters/types';

const { buildTransaction } = vi.hoisted(() => ({
  buildTransaction: vi.fn<ChainAdapter['buildTransaction']>(),
}));

// Exercise native bodies without sockets. Wallet signing and balance are fixtures.
vi.mock('../../adapters', async importOriginal => ({
  ...await importOriginal<typeof import('../../adapters')>(),
  createSolanaAdapter: (): ChainAdapter => ({
    name: 'Solana', networks: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
    canHandle: network => network.startsWith('solana:'), isConnected: () => true,
    getAddress: () => 'fixture-wallet', getDefaultRpcUrl: () => 'http://127.0.0.1',
    getBalance: async () => 100, buildTransaction,
  }),
}));

const network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const walletPrivateKey = Keypair.fromSeed(new Uint8Array(32).fill(23)).secretKey;
const url = 'http://127.0.0.1/upload';

function challenge(accessPass = false, amount = '300000') {
  return new Response(null, { status: 402, headers: {
    'PAYMENT-REQUIRED': btoa(JSON.stringify({ x402Version: 2, accepts: [{
      scheme: 'exact', network, amount, asset: 'fixture-mint',
      payTo: 'fixture-recipient', maxTimeoutSeconds: 60,
      extra: { decimals: 6, feePayer: 'fixture-fee-payer' },
    }] })),
    ...(accessPass ? { 'X-ACCESS-PASS-TIERS': btoa(JSON.stringify({ tiers: [{ id: '1h', price: String(Number(amount) / 1e6) }] })) } : {}),
  } });
}

function account(options: Partial<BudgetAccountConfig> = {}) {
  return createBudgetAccount({ walletPrivateKey, budget: { total: '1' }, ...options });
}

async function fileBodyFactory(kind: 'getter' | 'virtual-proxy' | 'data-proxy') {
  const directory = await mkdtemp(join(tmpdir(), 'x402-upload-'));
  const file = join(directory, 'body.txt');
  await writeFile(file, 'file upload');
  const streams: ReadStream[] = [];
  const makeBody = () => {
    const stream = createReadStream(file);
    streams.push(stream);
    return stream as unknown as NonNullable<RequestInit['body']>;
  };
  const options = { method: 'POST', duplex: 'half' as const, ...(kind === 'data-proxy' ? { body: '' } : {}) };
  const init = kind !== 'getter' ? new Proxy(options, {
    get(target, key, receiver) { return key === 'body' ? makeBody() : Reflect.get(target, key, receiver); },
  }) : { ...options, get body() { return makeBody(); } };
  return {
    init, streams,
    async close() {
      await Promise.all(streams.map(stream => stream.closed ? undefined : new Promise<void>(resolve => {
        stream.once('close', resolve); stream.destroy();
      })));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

beforeEach(() => {
  buildTransaction.mockReset().mockResolvedValue({ serialized: 'fixture-signature' });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('budget account body ownership', () => {
  it.each((['ownKeys', 'getOwnPropertyDescriptor'] as const).flatMap(trap => [false, true].map(accessPass => ({ trap, accessPass }))))(
    'allows unavailable prototype metadata from $trap (access pass: $accessPass)', async ({ trap, accessPass }) => {
      const prototype = new Proxy({ method: 'POST', unusedHelper() {} }, {
        [trap]() { throw new Error(`prototype ${trap} unavailable`); },
      });
      const init = Object.assign(Object.create(prototype), {
        body: 'payload', headers: { 'x-fixture': 'kept' }, transportTag: 'kept',
      });
      const jwt = `fixture.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
      const bodies: string[] = [];
      vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
        expect((options as RequestInit & { transportTag: string }).transportTag).toBe('kept');
        const request = new Request(input, options);
        expect(request.method).toBe('POST');
        expect(request.headers.get('x-fixture')).toBe('kept');
        bodies.push(await request.text());
        return request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('Authorization')
          ? new Response('paid', { headers: accessPass ? { 'ACCESS-PASS': jwt } : {} })
          : challenge(accessPass);
      });
      const onPaymentRequired = vi.fn(() => true);
      const agent = account({ onPaymentRequired, ...(accessPass ? { accessPass: { preferTier: '1h' } } : {}) });
      expect((await agent.fetch(url, init)).status).toBe(200);
      if (accessPass) expect((await agent.fetch(url, init)).status).toBe(200);
      expect(bodies).toEqual(Array(accessPass ? 3 : 2).fill('payload'));
      expect(onPaymentRequired).toHaveBeenCalledTimes(1);
      expect(buildTransaction).toHaveBeenCalledTimes(1);
      expect(agent.spentAmount).toBe(0.3);
      expect(agent.reservedAmount).toBe(0);
    },
  );

  it.each(['ownKeys', 'getOwnPropertyDescriptor'] as const)('preserves own option metadata errors from %s', async trap => {
    const error = new Error(`own ${trap} unavailable`);
    const init = new Proxy({ method: 'POST', body: 'payload' }, {
      [trap]() { throw error; },
    });
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      expect(await new Request(input, options).text()).toBe('payload');
      return challenge();
    });
    const agent = account();
    await expect(agent.fetch(url, init)).rejects.toBe(error);
    expect(buildTransaction).not.toHaveBeenCalled();
    expect(agent.payments).toBe(0);
    expect(agent.reservedAmount).toBe(0);
  });

  it('preserves standard option errors after unavailable prototype metadata', async () => {
    const error = new Error('method lookup failed');
    let methodReads = 0;
    const prototype = new Proxy({ get method() {
      if (++methodReads > 1) throw error;
      return 'POST';
    } }, { ownKeys() { throw new Error('prototype metadata unavailable'); } });
    const init = Object.assign(Object.create(prototype), { body: 'payload' });
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      expect(await new Request(input, options).text()).toBe('payload');
      return challenge();
    });
    const agent = account();
    await expect(agent.fetch(url, init)).rejects.toBe(error);
    expect(buildTransaction).not.toHaveBeenCalled();
    expect(agent.payments).toBe(0);
    expect(agent.reservedAmount).toBe(0);
  });

  it.each(['spread-getter', 'clone-helper'].flatMap(kind => [false, true].map(accessPass => ({ kind, accessPass }))))(
    'keeps inherited custom fields out of $kind transport copies (access pass: $accessPass)', async ({ kind, accessPass }) => {
      let unusedReads = 0;
      const prototype = kind === 'clone-helper' ? { helper() { return 'unused helper'; } }
        : Object.defineProperty({}, 'unusedOption', {
          enumerable: true,
          get() { unusedReads++; throw new Error('unused inherited option was read'); },
        });
      const init = Object.assign(Object.create(prototype), {
        method: 'POST', body: 'payload', transportTag: 'kept',
      });
      const jwt = `fixture.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
      const bodies: string[] = [];
      vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
        const copied = (kind === 'clone-helper' ? structuredClone(options) : { ...options }) as RequestInit & {
          transportTag?: string;
        };
        expect(copied.transportTag).toBe('kept');
        expect(Object.hasOwn(copied, 'helper')).toBe(false);
        const request = new Request(input, copied);
        bodies.push(await request.text());
        return request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('Authorization')
          ? new Response('paid', { headers: accessPass ? { 'ACCESS-PASS': jwt } : {} })
          : challenge(accessPass);
      });
      const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
      expect((await agent.fetch(url, init)).status).toBe(200);
      if (accessPass) expect((await agent.fetch(url, init)).status).toBe(200);
      expect(bodies).toEqual(Array(accessPass ? 3 : 2).fill('payload'));
      expect(unusedReads).toBe(0);
      expect(agent.spentAmount).toBe(0.3);
      expect(buildTransaction).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['inherited', 'non-enumerable'] as const)('reads a cached-pass %s headers getter once', async kind => {
    const jwt = `fixture.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
    const cachedHeaders: Headers[] = [];
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.headers.has('Authorization')) {
        cachedHeaders.push(request.headers);
        return new Response('cached');
      }
      if (request.headers.has('PAYMENT-SIGNATURE')) return new Response('paid', { headers: { 'ACCESS-PASS': jwt } });
      return challenge(true);
    });
    const agent = account({ accessPass: { preferTier: '1h' } });
    await agent.fetch(url);
    let reads = 0;
    const source = Object.defineProperty({}, 'headers', {
      enumerable: false,
      get() {
        if (++reads > 1) throw new Error('headers may be read once per request');
        return { 'x-caller': 'kept' };
      },
    });
    const init: RequestInit = kind === 'inherited' ? Object.create(source) : source;
    expect((await agent.fetch(url, init)).status).toBe(200);
    expect(reads).toBe(1);
    expect(cachedHeaders).toHaveLength(1);
    expect(cachedHeaders[0].get('Authorization')).toBe(`Bearer ${jwt}`);
    expect(cachedHeaders[0].get('x-caller')).toBe('kept');
    expect(agent.spentAmount).toBe(0.3);
    expect(buildTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('preserves earlier records after consumed-body handoff (access pass: %s)', async accessPass => {
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      await request.text();
      if (request.headers.has('PAYMENT-SIGNATURE')) return new Response('paid');
      const prepaid = new URL(request.url).pathname === '/prepaid';
      return challenge(!prepaid && accessPass, prepaid ? '300000' : '600000');
    });
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    await agent.fetch('http://127.0.0.1/prepaid');
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    await expect(agent.fetch(url, { method: 'POST', body, duplex: 'half' } as RequestInit))
      .rejects.toMatchObject(accessPass ? { code: 'amount_exceeds_max' } : { name: 'TypeError' });
    expect(agent.ledger.map(record => record.amount)).toEqual([0.3, 0.6]);
    expect(agent.spentAmount).toBeCloseTo(0.9);
    expect(agent.payments).toBe(2);
    expect(agent.reservedAmount).toBe(0);
    await expect(agent.fetch(url)).rejects.toMatchObject({ code: 'amount_exceeds_max' });
    expect(buildTransaction).toHaveBeenCalledTimes(2);
  });

  it.each(['web', 'node'].flatMap(kind => [false, true].map(accessPass => ({ kind, accessPass }))))(
    'counts handoff when native request construction rejects a consumed $kind body (access pass: $accessPass)', async ({ kind, accessPass }) => {
      const received: string[] = [];
      vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        received.push(await request.text());
        return challenge(accessPass, '600000');
      });
      const body = kind === 'node' ? Readable.from(['one shot']) as unknown as RequestInit['body']
        : new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode('one shot')); controller.close();
        } });
      const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
      await expect(agent.fetch(url, { method: 'POST', body, duplex: 'half' } as RequestInit))
        .rejects.toMatchObject(accessPass ? { code: 'amount_exceeds_max' } : { name: 'TypeError' });
      expect(received).toEqual(['one shot']);
      expect(agent.spentAmount).toBe(0.6);
      expect(agent.payments).toBe(1);
      expect(agent.reservedAmount).toBe(0);
      expect(buildTransaction).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['web', 'node'] as const)('keeps a delivered authorization after a custom retry consumes a getter %s body', async kind => {
    let signatures = 0;
    buildTransaction.mockImplementation(async () => ({ serialized: `fixture-signature-${++signatures}` }));
    const delivered: string[] = [];
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      await request.text();
      const signature = request.headers.get('PAYMENT-SIGNATURE');
      if (!signature) return challenge(false, '700000');
      delivered.push(signature);
      // The custom transport delivers, then retries the same consumed options.
      // Native Request construction throws after the first delivery.
      new Request(input, init);
      return new Response('paid');
    });
    const init = { method: 'POST', duplex: 'half' as const, get body() {
      return kind === 'node' ? Readable.from(['upload']) as unknown as RequestInit['body']
        : new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode('upload')); controller.close();
        } });
    } };
    const agent = account();
    await expect(agent.fetch(url, init)).rejects.toThrow(TypeError);
    expect(delivered).toHaveLength(1);
    expect(agent.spentAmount).toBe(0.7);
    expect(agent.payments).toBe(1);
    await expect(agent.fetch(url, init)).rejects.toMatchObject({ code: 'amount_exceeds_max' });
    expect(delivered).toHaveLength(1);
    expect(buildTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('keeps a delivered authorization after buffered replay and response reconstruction failure (access pass: %s)', async accessPass => {
    const cache = new WeakMap<ReadableStream, ArrayBuffer>();
    const delivered: string[] = [];
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('buffered upload')); controller.close();
    } });
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const originalBody = init?.body;
      if (originalBody instanceof ReadableStream && !cache.has(originalBody)) {
        cache.set(originalBody, await new Response(originalBody).arrayBuffer());
      }
      const request = new Request(input, { ...init, body: originalBody instanceof ReadableStream ? cache.get(originalBody) : originalBody });
      await request.text();
      const signature = request.headers.get('PAYMENT-SIGNATURE');
      if (!signature) return challenge(accessPass, '700000');
      delivered.push(signature);
      const consumed = new Response('merchant response');
      await consumed.text();
      new Response(consumed.body);
      return new Response('paid');
    });
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    await expect(agent.fetch(url, { method: 'POST', body })).rejects.toBeDefined();
    expect(delivered).toHaveLength(1);
    expect(agent.spentAmount).toBe(0.7);
    expect(agent.payments).toBe(1);
    await expect(agent.fetch(url, { method: 'POST', body })).rejects.toMatchObject({ code: 'amount_exceeds_max' });
    expect(delivered).toHaveLength(1);
    expect(buildTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('does not reflect descriptors of absent Proxy options (access pass: %s)', async accessPass => {
    const init = new Proxy({ method: 'POST', body: 'proxy upload', headers: { 'x-fixture': 'present' } }, {
      getOwnPropertyDescriptor(target, key) {
        if (!Object.hasOwn(target, key)) throw new Error(`Missing option has no descriptor: ${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const bodies: string[] = [];
    const jwt = `fixture.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      const request = new Request(input, options);
      bodies.push(await request.text());
      return request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('Authorization')
        ? new Response('paid', { headers: accessPass ? { 'ACCESS-PASS': jwt } : {} })
        : challenge(accessPass);
    });
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    expect((await agent.fetch(url, init)).status).toBe(200);
    if (accessPass) expect((await agent.fetch(url, init)).status).toBe(200);
    expect(bodies).toEqual(Array(accessPass ? 3 : 2).fill('proxy upload'));
    expect(agent.spentAmount).toBe(0.3);
    expect(buildTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(['absent', 'undefined', 'null', 'getter'].flatMap(kind => [false, true].map(accessPass => ({ kind, accessPass }))))(
    'preserves a transport default body with $kind options (access pass: $accessPass)', async ({ kind, accessPass }) => {
      const received: string[] = [];
      const expectedBody = kind === 'absent' ? 'transport default' : kind === 'getter' ? 'getter body' : '';
      const jwt = `fixture.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
      vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, { method: 'POST', body: 'transport default', ...init });
        const body = await request.text();
        received.push(body);
        if (request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('Authorization')) {
          return new Response(body, { status: body === expectedBody ? 200 : 400, headers: accessPass ? { 'ACCESS-PASS': jwt } : {} });
        }
        return challenge(accessPass);
      });
      const init = kind === 'absent' ? { headers: { 'x-fixture': 'default' } }
        : kind === 'undefined' ? { body: undefined }
        : kind === 'null' ? { body: null }
        : { get body() { return 'getter body'; } };
      const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
      expect((await agent.fetch(url, init)).status).toBe(200);
      if (accessPass) expect((await agent.fetch(url, init)).status).toBe(200);
      expect(received).toEqual(Array(accessPass ? 3 : 2).fill(expectedBody));
      expect(buildTransaction).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['budget', 'approval', 'signing'].flatMap(failure => (['getter', 'virtual-proxy', 'data-proxy'] as const).map(kind => ({ failure, kind }))))(
    'does not open another $kind file body after $failure rejection', async ({ failure, kind }) => {
      const fixture = await fileBodyFactory(kind);
      let paidCalls = 0;
      vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        expect(await request.text()).toBe('file upload');
        if (request.headers.has('PAYMENT-SIGNATURE')) { paidCalls++; return new Response('paid'); }
        return challenge();
      });
      if (failure === 'signing') buildTransaction.mockRejectedValue(new Error('signing failed'));
      const agent = account({
        ...(failure === 'budget' ? { budget: { total: '0.20' } } : {}),
        ...(failure === 'approval' ? { onPaymentRequired: () => false } : {}),
      });
      try {
        await expect(agent.fetch(url, fixture.init)).rejects.toBeDefined();
        expect(fixture.streams).toHaveLength(1);
        expect(paidCalls).toBe(0);
        expect(agent.spentAmount).toBe(0);
      } finally { await fixture.close(); }
    },
  );

  it.each(['budget', 'signing'].flatMap(failure => (['getter', 'virtual-proxy', 'data-proxy'] as const).map(kind => ({ failure, kind }))))(
    'does not open a fallback $kind file body after $failure rejection', async ({ failure, kind }) => {
      const fixture = await fileBodyFactory(kind);
      let paidCalls = 0;
      vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        expect(await request.text()).toBe('file upload');
        if (!request.headers.has('PAYMENT-SIGNATURE')) return challenge(true);
        paidCalls++;
        return new Response('pass failed', { status: 500 });
      });
      if (failure === 'signing') buildTransaction.mockResolvedValueOnce({ serialized: 'pass-signature' }).mockRejectedValue(new Error('fallback signing failed'));
      const agent = account({ budget: { total: failure === 'budget' ? '0.50' : '1' }, accessPass: { preferTier: '1h' } });
      try {
        await expect(agent.fetch(url, fixture.init)).rejects.toBeDefined();
        expect(fixture.streams).toHaveLength(2);
        expect(paidCalls).toBe(1);
        expect(agent.spentAmount).toBe(0.3);
        expect(agent.payments).toBe(1);
      } finally { await fixture.close(); }
    },
  );

  it('allows approval to refresh a data-property body before paid transmission', async () => {
    const makeBody = () => new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('refreshed upload')); controller.close();
    } });
    const init = { method: 'POST', body: makeBody(), duplex: 'half' as const };
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      const request = new Request(input, options);
      bodies.push(await request.text());
      return request.headers.has('PAYMENT-SIGNATURE') ? new Response('paid') : challenge();
    });
    const agent = account({ onPaymentRequired: () => { init.body = makeBody(); return true; } });
    expect((await agent.fetch(url, init)).status).toBe(200);
    expect(bodies).toEqual(['refreshed upload', 'refreshed upload']);
    expect(agent.spentAmount).toBe(0.3);
  });

  it.each(['transport', 'response reconstruction'])(
    'keeps an unread async iterable available after a transient %s error', async kind => {
    const source = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('original upload')); controller.close();
    } });
    let iterator: AsyncIterator<Uint8Array> | undefined;
    const body = { [Symbol.asyncIterator]() {
      return iterator = (source as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    } };
    let attempts = 0;
    const signatures: string[] = [];
    const client = createX402Client({
      wallets: { solana: await createKeypairWallet(walletPrivateKey) }, adapters: [createSolanaAdapter()],
      maxRetries: 1, retryDelayMs: 0,
      fetch: async (input, init) => {
        const signature = new Headers(init?.headers).get('PAYMENT-SIGNATURE');
        if (!signature) return challenge();
        signatures.push(signature);
        if (++attempts === 1) {
          if (kind === 'transport') throw new TypeError('temporary transport failure');
          const consumedResponse = new Response(new ReadableStream({ start(controller) { controller.close(); } }));
          await consumedResponse.text();
          new Response(consumedResponse.body); // Real native response reconstruction failure.
        }
        return new Response(await new Request(input, init).text());
      },
    });
    try {
      const response = await client.fetch(url, { method: 'POST', body: body as unknown as RequestInit['body'], duplex: 'half' } as RequestInit);
      expect(await response.text()).toBe('original upload');
      expect(source.locked).toBe(false);
      expect(signatures).toHaveLength(2);
      expect(signatures[1]).toBe(signatures[0]);
      expect(buildTransaction).toHaveBeenCalledTimes(1);
    } finally { await iterator?.return?.(); }
  });

  it('does not record a payment if body creation fails before dispatch', async () => {
    const onPaymentRequired = vi.fn(() => true);
    const body = vi.fn(() => { throw new Error('body creation failed'); });
    vi.stubGlobal('fetch', async () => challenge());
    const agent = account({ onPaymentRequired });
    await expect(agent.fetch(url, { method: 'POST', get body() { return body(); } })).rejects.toThrow('body creation failed');
    expect(onPaymentRequired).toHaveBeenCalledTimes(1);
    expect(buildTransaction).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledTimes(1);
    expect(agent.payments).toBe(0);
    expect(agent.spentAmount).toBe(0);
  });
});
