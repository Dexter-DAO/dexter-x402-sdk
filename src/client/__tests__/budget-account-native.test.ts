import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
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

// The transport and request bodies are native; signing and balance are local fixtures.
vi.mock('../../adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('../../adapters')>();
  return {
    ...actual,
    createSolanaAdapter: (): ChainAdapter => ({
      name: 'Solana',
      networks: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
      canHandle: network => network.startsWith('solana:'),
      isConnected: () => true,
      getAddress: () => 'fixture-wallet',
      getDefaultRpcUrl: () => 'http://127.0.0.1',
      getBalance: async () => 100,
      buildTransaction,
    }),
  };
});

const network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const walletPrivateKey = Keypair.fromSeed(new Uint8Array(32).fill(19)).secretKey;
const { Request: ForeignRequest } = createRequire(import.meta.url)('node-fetch') as { Request: typeof Request };
let server: Server;
let origin: string;
let received: { paid: boolean; body: string }[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function expectAbort(outcome: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      outcome,
      new Promise(resolve => { timer = setTimeout(() => resolve('abort did not finish'), 1000); }),
    ]);
    expect(result).toMatchObject({ name: 'AbortError' });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function account(options: Partial<BudgetAccountConfig> = {}) {
  return createBudgetAccount({ walletPrivateKey, budget: { total: '1.00' }, ...options });
}

function url(amount: number, accessPass = false, lost = false) {
  return `${origin}/data?amount=${amount}&pass=${accessPass}&lost=${lost}`;
}

beforeEach(async () => {
  buildTransaction.mockReset();
  buildTransaction.mockResolvedValue({ serialized: 'fixture-signature' });
  received = [];
  server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url!, origin);
    if (requestUrl.pathname === '/unpaid') {
      response.end(JSON.stringify({ method: request.method, header: request.headers['x-fixture'] }));
      return;
    }
    if (requestUrl.searchParams.get('free') === 'true') {
      const body = await new Promise<string>(resolve => request.once('data', chunk => resolve(chunk.toString())));
      received.push({ paid: false, body });
      response.end('first chunk received');
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    const paid = !!request.headers['payment-signature'];
    received.push({ paid, body });
    if (requestUrl.searchParams.get('pass') === 'true' && request.headers.authorization?.startsWith('Bearer fixture.')) {
      response.end('cached pass accepted');
      return;
    }
    if (paid) {
      if (requestUrl.searchParams.get('passfailure') === 'true' && requestUrl.searchParams.has('tier')) {
        response.writeHead(500); response.end('pass failed'); return;
      }
      if (requestUrl.searchParams.get('retry') === 'true' && received.filter(entry => entry.paid).length === 1) {
        response.writeHead(503); response.end('retry'); return;
      }
      if (requestUrl.searchParams.get('lost') === 'true') {
        request.socket.destroy();
        return;
      }
      if (requestUrl.searchParams.get('pass') === 'true') {
        const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
        response.setHeader('ACCESS-PASS', `fixture.${payload}.signature`);
      }
      response.end('paid');
      return;
    }
    const amount = Math.round(Number(requestUrl.searchParams.get('amount')) * 1e6);
    const accepts = [{
      scheme: 'exact', network, amount: String(amount), asset: 'fixture-mint',
      payTo: 'fixture-recipient', maxTimeoutSeconds: 60,
      extra: { decimals: 6, feePayer: 'fixture-fee-payer' },
    }];
    response.writeHead(402, {
      'PAYMENT-REQUIRED': btoa(JSON.stringify({ x402Version: 2, accepts })),
      ...(requestUrl.searchParams.get('pass') === 'true' ? {
        'X-ACCESS-PASS-TIERS': btoa(JSON.stringify({ tiers: [{ id: '1h', price: String(amount / 1e6) }] })),
      } : {}),
    });
    response.end('payment required');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('budget account with native fetch', () => {
  it.each(['signal', 'body'] as const)('preserves custom init identity with a %s getter', async kind => {
    class CustomInit {
      method = 'POST';
      #value = 'private';
      route() { return this.#value; }
    }
    const init = new CustomInit();
    Object.defineProperty(init, kind, { get: () => kind === 'signal' ? new AbortController().signal : new ReadableStream({ start(c) { c.close(); } }) });
    const metadata = new WeakMap<object, string>([[init, 'metadata']]);
    const client = createX402Client({ wallets: {}, fetch: async (_input, options) => {
      expect(options).toBe(init);
      expect((options as CustomInit).route()).toBe('private');
      expect(metadata.get(options!)).toBe('metadata');
      return new Response('custom');
    } });
    expect((await client.fetch('http://127.0.0.1/free', init)).status).toBe(200);
  });

  it('leaves unused data-property Proxy traps unread in native free and paid requests', async () => {
    const unused = vi.fn(() => { throw new Error('unused option'); });
    const init = new Proxy({ method: 'POST', body: 'proxy', unusedOption: 1 }, {
      get(target, key, receiver) { return key === 'unusedOption' ? unused() : Reflect.get(target, key, receiver); },
    });
    const agent = account();
    await agent.fetch(`${origin}/unpaid`, init);
    await agent.fetch(url(0.6), init);
    expect(unused).not.toHaveBeenCalled();
    expect(agent.spentAmount).toBe(0.6);
  });

  it.each([false, true])('supports reusing a transport-cached stream across SDK calls (access pass: %s)', async accessPass => {
    const nativeFetch = globalThis.fetch;
    const cache = new WeakMap<ReadableStream, ArrayBuffer>();
    vi.stubGlobal('fetch', async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      let body = init?.body;
      if (body instanceof ReadableStream) {
        if (!cache.has(body)) cache.set(body, await new Response(body).arrayBuffer());
        body = cache.get(body);
      }
      return nativeFetch(input, { ...init, body });
    });
    try {
      const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('reusable')); c.close(); } });
      const init = { method: 'POST', body };
      const agent = account({ budget: { total: '2' }, ...(accessPass ? { accessPass: { preferTier: '1h' } } : {}) });
      expect((await agent.fetch(url(0.6, accessPass), init)).status).toBe(200);
      expect((await agent.fetch(url(0.6, accessPass), init)).status).toBe(200);
      expect(agent.spentAmount).toBe(accessPass ? 0.6 : 1.2);
      expect(agent.payments).toBe(accessPass ? 1 : 2);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['freeze', 'seal'] as const)('forwards a %s streaming init unchanged on a free request', async kind => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('frozen')); controller.close(); } });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' };
    if (kind === 'freeze') Object.freeze(init); else Object.seal(init);
    expect((await account().fetch(`${origin}/unpaid`, init)).status).toBe(200);
  });

  it('reads one-shot body and signal getters only once for a free native request', async () => {
    let bodyReads = 0;
    let signalReads = 0;
    const init = {
      method: 'POST',
      get body() { if (++bodyReads > 1) throw new Error('body already created'); return 'lazy'; },
    };
    Object.defineProperty(init, 'signal', { get() {
      if (++signalReads > 1) throw new Error('signal already created');
      return new AbortController().signal;
    } });
    expect((await account().fetch(`${origin}/unpaid`, init)).status).toBe(200);
    expect(bodyReads).toBe(1);
    expect(signalReads).toBe(1);
  });

  it('keeps transport ownership of a streaming response', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('echo stream')); controller.close(); } });
    const client = createX402Client({ wallets: {}, fetch: async (_input, init) => new Response(init?.body) });
    expect(await (await client.fetch('http://127.0.0.1/echo', { body })).text()).toBe('echo stream');
  });

  it.each([false, true])('reads a Request input signal getter once (explicit signal: %s)', async explicit => {
    let reads = 0;
    const signal = new AbortController().signal;
    const init = { get signal() {
      if (++reads > 1) throw new Error('signal already created');
      return explicit ? signal : undefined;
    } };
    expect((await account().fetch(new Request(`${origin}/unpaid`), init)).status).toBe(200);
    expect(reads).toBe(1);
  });

  it('forwards free Proxy options without descriptor reflection', async () => {
    const init = new Proxy({ method: 'POST', body: 'opaque options' }, {
      getOwnPropertyDescriptor() { throw new Error('descriptor reflection disabled'); },
    });
    expect((await account().fetch(`${origin}/unpaid`, init)).status).toBe(200);
  });

  it('reads a free native Proxy signal only in the transport', async () => {
    let reads = 0;
    const init = new Proxy({ signal: new AbortController().signal }, {
      get(target, key, receiver) {
        if (key === 'signal' && ++reads > 1) throw new Error('signal already created');
        return Reflect.get(target, key, receiver);
      },
    });
    expect((await account().fetch(`${origin}/unpaid`, init)).status).toBe(200);
    expect(reads).toBe(1);
  });

  it('leaves a free custom transport Proxy signal unread', async () => {
    const unused = vi.fn(() => { throw new Error('unused signal'); });
    const init = new Proxy({ signal: undefined }, {
      get(target, key, receiver) { return key === 'signal' ? unused() : Reflect.get(target, key, receiver); },
    });
    const client = createX402Client({ wallets: {}, fetch: async (_input, options) => {
      expect(options).toBe(init);
      return new Response('cache hit');
    } });
    expect(await (await client.fetch('http://127.0.0.1/free', init)).text()).toBe('cache hit');
    expect(unused).not.toHaveBeenCalled();
  });

  it.each(['web', 'node', 'async-iterator'].flatMap(kind => [false, true].map(proxy => ({ kind, proxy }))))(
    'refreshes a $kind body factory after a failed pass purchase (Proxy: $proxy)', async ({ kind, proxy }) => {
    let reads = 0;
    const makeBody = () => {
      reads++;
      if (kind === 'node') return Readable.from(['factory payload']) as unknown as NonNullable<RequestInit['body']>;
      if (kind === 'async-iterator') return (async function* () { yield new TextEncoder().encode('factory payload'); })() as unknown as NonNullable<RequestInit['body']>;
      return new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('factory payload')); controller.close();
      } });
    };
    const options = { method: 'POST', duplex: 'half' as const };
    const init = proxy ? new Proxy(options, {
      get(target, key, receiver) { return key === 'body' ? makeBody() : Reflect.get(target, key, receiver); },
    }) : { ...options, get body() { return makeBody(); } };
    const agent = account({ accessPass: { preferTier: '1h' } });
    expect((await agent.fetch(`${url(0.3, true)}&passfailure=true`, init)).status).toBe(200);
    expect(reads).toBe(3);
    expect(received.map(entry => entry.body)).toEqual(Array(3).fill('factory payload'));
    expect(agent.spentAmount).toBe(0.6);
    expect(agent.payments).toBe(2);
  });

  it('keeps prototype reflection optional for native Proxy options', async () => {
    const init = new Proxy({ method: 'POST', body: 'opaque prototype' }, {
      getPrototypeOf() { throw new Error('prototype reflection disabled'); },
    });
    const agent = account();
    expect((await agent.fetch(url(0.6), init)).status).toBe(200);
    expect(received.map(entry => entry.body)).toEqual(['opaque prototype', 'opaque prototype']);
    expect(agent.spentAmount).toBe(0.6);
  });

  it.each([false, true])('keeps the authorization counted when native fetch rejects a consumed Node stream (access pass: %s)', async accessPass => {
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    const init = { method: 'POST', duplex: 'half' as const, body: Readable.from(['one shot']) as unknown as NonNullable<RequestInit['body']> };
    await expect(agent.fetch(url(0.6, accessPass), init))
      .rejects.toMatchObject(accessPass ? { code: 'amount_exceeds_max' } : { name: 'TypeError' });
    expect(received).toEqual([{ paid: false, body: 'one shot' }]);
    expect(agent.spentAmount).toBe(0.6);
    expect(agent.payments).toBe(1);
  });

  it('reads a non-global Request signal getter once', async () => {
    let reads = 0;
    const signal = new AbortController().signal;
    const init = { get signal() {
      if (++reads > 1) throw new Error('signal already created');
      return signal;
    } };
    const request = new ForeignRequest(`${origin}/unpaid`);
    expect(request).not.toBeInstanceOf(Request);
    expect((await account().fetch(request, init)).status).toBe(200);
    expect(reads).toBe(1);
  });

  it.each([false, true])('observes the caller signal on a non-global Request (access pass: %s)', async accessPass => {
    const entered = deferred<void>();
    const approval = deferred<boolean>();
    const controller = new AbortController();
    const agent = account({
      ...(accessPass ? { accessPass: { preferTier: '1h' } } : {}),
      onPaymentRequired: () => { entered.resolve(); return approval.promise; },
    });
    const pending = agent.fetch(new ForeignRequest(url(0.6, accessPass)), { signal: controller.signal });
    const outcome = pending.catch(error => error);
    await entered.promise;
    controller.abort();
    try { await expectAbort(outcome); } finally { approval.resolve(true); }
    await pending.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(buildTransaction).not.toHaveBeenCalled();
    expect(received.filter(entry => entry.paid)).toHaveLength(0);
    expect(agent.spentAmount).toBe(0);
  });

  it('leaves unused Proxy properties and body getters unread on a free request', async () => {
    const unused = vi.fn(() => { throw new Error('unused body'); });
    const init = new Proxy({ unusedOption: 'internal', get body() { return unused(); } }, {
      get(target, key, receiver) { if (key === 'unusedOption') throw new Error('unused option'); return Reflect.get(target, key, receiver); },
    });
    const client = createX402Client({ wallets: {}, fetch: async (_input, options) => {
      expect(options).toBe(init); return new Response('cache hit');
    } });
    expect(await (await client.fetch('http://127.0.0.1/free', init)).text()).toBe('cache hit');
    expect(unused).not.toHaveBeenCalled();
  });

  it('sends plain paid options that can be copied across an IPC boundary', async () => {
    const client = createX402Client({ wallets: { solana: await createKeypairWallet(walletPrivateKey) },
      fetch: (input, init) => fetch(input, structuredClone(init)),
    });
    expect((await client.fetch(url(0.6), { method: 'POST', body: 'ipc' })).status).toBe(200);
    expect(received.map(entry => entry.body)).toEqual(['ipc', 'ipc']);
  });

  it.each([false, true])('preserves earlier records when native fetch rejects another authorization (access pass: %s)', async accessPass => {
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    await agent.fetch(url(0.3));
    const body = new ReadableStream({ start(controller) { controller.close(); } });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' };
    await expect(agent.fetch(url(0.6, accessPass), init))
      .rejects.toMatchObject(accessPass ? { code: 'amount_exceeds_max' } : { name: 'TypeError' });
    expect(agent.spentAmount).toBeCloseTo(0.9);
    expect(agent.payments).toBe(2);
    expect(agent.ledger.map(record => record.amount)).toEqual([0.3, 0.6]);
    await expect(agent.fetch(url(0.6))).rejects.toMatchObject({ code: 'amount_exceeds_max' });
    expect(agent.payments).toBe(2);
  });

  it.each(['virtual', 'override'] as const)('preserves Proxy options on free and paid requests (%s)', async kind => {
    const options = { method: 'POST', body: 'proxy payload', headers: { 'x-fixture': 'kept' } };
    const init = new Proxy(kind === 'virtual' ? {} : { method: 'GET', body: '', headers: {} }, {
      get(target, key, receiver) {
        return Object.hasOwn(options, key) ? Reflect.get(options, key) : Reflect.get(target, key, receiver);
      },
    });
    const agent = account();
    const free = await agent.fetch(`${origin}/unpaid`, init);
    expect(await free.json()).toEqual({ method: 'POST', header: 'kept' });
    expect((await agent.fetch(url(0.6), init)).status).toBe(200);
    expect(received.map(request => request.body)).toEqual(['proxy payload', 'proxy payload']);
    expect(agent.spentAmount).toBe(0.6);
  });

  it.each([false, true])('allows a custom transport to buffer and replay stream bodies (access pass: %s)', async accessPass => {
    const nativeFetch = globalThis.fetch;
    const cache = new WeakMap<ReadableStream, ArrayBuffer>();
    const bufferingFetch: typeof fetch = async (input, init) => {
      let body = init?.body;
      if (body instanceof ReadableStream) {
        if (!cache.has(body)) cache.set(body, await new Response(body).arrayBuffer());
        body = cache.get(body);
      }
      return nativeFetch(input, { ...init, body });
    };
    vi.stubGlobal('fetch', bufferingFetch);
    try {
      const body = new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('buffered payload'));
        controller.close();
      } });
      const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
      expect((await agent.fetch(url(0.6, accessPass), { method: 'POST', body })).status).toBe(200);
      expect(received).toEqual([{ paid: false, body: 'buffered payload' }, { paid: true, body: 'buffered payload' }]);
      expect(agent.spentAmount).toBe(0.6);
      expect(agent.payments).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([false, true])('replays a getter-provided stream body (access pass: %s)', async accessPass => {
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST', duplex: 'half',
      get body() { return new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('getter payload')); controller.close();
      } }); },
    };
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    expect((await agent.fetch(url(0.6, accessPass), init)).status).toBe(200);
    expect(received.map(request => request.body)).toEqual(['getter payload', 'getter payload']);
    expect(agent.spentAmount).toBe(0.6);
  });

  it.each(['freeze', 'seal'] as const)('allows a custom transport to %s getter options', async kind => {
    const client = createX402Client({
      wallets: { solana: await createKeypairWallet(walletPrivateKey) },
      fetch: (input, init) => {
        if (init) { if (kind === 'freeze') Object.freeze(init); else Object.seal(init); }
        return fetch(input, init);
      },
    });
    const init = { get method() { return 'POST'; }, get body() { return 'frozen payload'; } };
    expect((await client.fetch(url(0.6), init)).status).toBe(200);
    expect(received.map(request => request.body)).toEqual(['frozen payload', 'frozen payload']);
  });

  it('preserves a custom init identity and private methods on an unpaid request', async () => {
    class CustomInit {
      method = 'DELETE';
      #route = 'private route';
      route() { return this.#route; }
    }
    const init = new CustomInit();
    const metadata = new WeakMap<object, string>([[init, 'caller metadata']]);
    const client = createX402Client({ wallets: {}, fetch: (input, options) => {
      expect(options).toBe(init);
      expect((options as CustomInit).route()).toBe('private route');
      expect(metadata.get(options!)).toBe('caller metadata');
      return fetch(input, options);
    } });
    expect((await client.fetch(`${origin}/unpaid`, init)).status).toBe(200);
  });

  it('forwards an opaque custom transport cancellation token', async () => {
    const signal = { aborted: false } as AbortSignal;
    const client = createX402Client({ wallets: {}, fetch: async (_input, init) => {
      expect(init?.signal).toBe(signal);
      return new Response('custom response');
    } });
    expect(await (await client.fetch('http://127.0.0.1/custom', { signal })).text()).toBe('custom response');
  });

  it.each([false, true])('releases aborted approval before it resolves (access pass: %s)', async accessPass => {
    const entered = deferred<void>();
    const approval = deferred<boolean>();
    const controller = new AbortController();
    const agent = account({
      ...(accessPass ? { accessPass: { preferTier: '1h' } } : {}),
      onPaymentRequired: accept => {
        if (accept.amount !== '600000') return true;
        entered.resolve();
        return approval.promise;
      },
    });
    const pending = agent.fetch(url(0.6, accessPass), { signal: controller.signal });
    const outcome = pending.then(() => undefined, error => error);
    try {
      await entered.promise;
      controller.abort();
      await expectAbort(outcome);
      expect(agent.spentAmount).toBe(0);
      expect(agent.payments).toBe(0);
      expect(buildTransaction).not.toHaveBeenCalled();
      await agent.fetch(url(0.7));
      approval.resolve(true);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(buildTransaction).toHaveBeenCalledTimes(1);
      expect(received.filter(request => request.paid)).toHaveLength(1);
      expect(agent.spentAmount).toBe(0.7);
    } finally {
      approval.resolve(false);
      await pending.catch(() => {});
    }
  });

  it.each([false, true])('releases aborted signing before it resolves (access pass: %s)', async accessPass => {
    const entered = deferred<void>();
    const signature = deferred<Awaited<ReturnType<ChainAdapter['buildTransaction']>>>();
    buildTransaction.mockImplementationOnce(() => { entered.resolve(); return signature.promise; });
    const controller = new AbortController();
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    const pending = agent.fetch(url(0.6, accessPass), { signal: controller.signal });
    const outcome = pending.then(() => undefined, error => error);
    try {
      await entered.promise;
      controller.abort();
      await expectAbort(outcome);
      expect(agent.spentAmount).toBe(0);
      await agent.fetch(url(0.7));
      signature.resolve({ serialized: 'late-signature' });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(buildTransaction).toHaveBeenCalledTimes(2);
      expect(received.filter(request => request.paid)).toHaveLength(1);
      expect(agent.spentAmount).toBe(0.7);
    } finally {
      signature.resolve({ serialized: 'late-signature' });
      await pending.catch(() => {});
    }
  });

  it('observes a Request signal while approval stays unresolved', async () => {
    const entered = deferred<void>();
    const approval = deferred<boolean>();
    const controller = new AbortController();
    const agent = account({ onPaymentRequired: accept => {
      if (accept.amount !== '600000') return true;
      entered.resolve();
      return approval.promise;
    } });
    const pending = agent.fetch(new Request(url(0.6), { signal: controller.signal }));
    const outcome = pending.then(() => undefined, error => error);
    try {
      await entered.promise;
      controller.abort();
      await expectAbort(outcome);
      await agent.fetch(url(0.7));
      expect(agent.spentAmount).toBe(0.7);
    } finally {
      approval.resolve(true);
      await pending.catch(() => {});
    }
  });

  it.each([false, true])('keeps the original cancellation signal after caller mutation (access pass: %s)', async accessPass => {
    const entered = deferred<void>();
    const signature = deferred<Awaited<ReturnType<ChainAdapter['buildTransaction']>>>();
    buildTransaction.mockImplementationOnce(() => { entered.resolve(); return signature.promise; });
    const controller = new AbortController();
    const replacement = new AbortController();
    const init: RequestInit = { signal: controller.signal };
    const agent = account({
      ...(accessPass ? { accessPass: { preferTier: '1h' } } : {}),
      onPaymentRequired: accept => {
        if (accept.amount === '650000') init.signal = replacement.signal;
        return true;
      },
    });
    const pending = agent.fetch(url(0.65, accessPass), init);
    const outcome = pending.then(() => undefined, error => error);
    try {
      await entered.promise;
      controller.abort();
      await expectAbort(outcome);
      await agent.fetch(url(0.7));
      signature.resolve({ serialized: 'late-signature' });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(received.filter(request => request.paid)).toHaveLength(1);
      expect(agent.spentAmount).toBe(0.7);
      expect(agent.payments).toBe(1);
    } finally {
      signature.resolve({ serialized: 'late-signature' });
      await pending.catch(() => {});
    }
  });

  it.each([false, true])('keeps the authorization counted when native fetch rejects a consumed web body (access pass: %s)', async accessPass => {
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('stream payload'));
      controller.close();
    } });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' };
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    await expect(agent.fetch(url(0.6, accessPass), init))
      .rejects.toMatchObject(accessPass ? { code: 'amount_exceeds_max' } : { name: 'TypeError' });
    expect(received).toEqual([{ paid: false, body: 'stream payload' }]);
    expect(agent.spentAmount).toBe(0.6);
    expect(agent.payments).toBe(1);
    await expect(agent.fetch(url(0.7))).rejects.toMatchObject({ code: 'amount_exceeds_max' });
    expect(received).toHaveLength(2);
    expect(received[1].paid).toBe(false);
  });

  it('keeps a Request POST body reusable for payment validation', async () => {
    const agent = account();
    await agent.fetch(new Request(url(0.6), { method: 'POST', body: 'request payload' }));
    expect(received.map(request => request.body)).toEqual(['request payload', 'request payload']);
    expect(agent.spentAmount).toBe(0.6);
    expect(agent.payments).toBe(1);
  });

  it('allows an unpaid streaming request to respond before its body closes', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      source = controller;
      source.enqueue(new TextEncoder().encode('first chunk'));
    } });
    const controller = new AbortController();
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST', body, duplex: 'half', signal: controller.signal,
    };
    const agent = account();
    const pending = agent.fetch(`${origin}/data?free=true`, init);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        pending,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('request waited for stream EOF')), 1000); }),
      ]);
      expect(await response.text()).toBe('first chunk received');
      expect(buildTransaction).not.toHaveBeenCalled();
      expect(agent.spentAmount).toBe(0);
    } finally {
      if (timer) clearTimeout(timer);
      source.close();
      controller.abort();
      await pending.catch(() => {});
    }
  });

  it('snapshots request options before an approval callback mutates them', async () => {
    const init: RequestInit = { method: 'POST', body: 'payload' };
    const agent = account({ onPaymentRequired: () => { init.method = 'GET'; return true; } });
    expect((await agent.fetch(url(0.6), init)).status).toBe(200);
    expect(received).toEqual([{ paid: false, body: 'payload' }, { paid: true, body: 'payload' }]);
    expect(agent.spentAmount).toBe(0.6);
    expect(agent.payments).toBe(1);
  });

  it.each([false, true])('accepts a signal without throwIfAborted (access pass: %s)', async accessPass => {
    const signal = new AbortController().signal;
    Object.defineProperty(signal, 'throwIfAborted', { value: undefined });
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    expect((await agent.fetch(url(0.6, accessPass), { signal: signal as AbortSignal })).status).toBe(200);
    expect(agent.spentAmount).toBe(0.6);
    expect(agent.payments).toBe(1);
  });

  it.each([false, true])('keeps a dispatched payment counted after response loss (access pass: %s)', async accessPass => {
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    await expect(agent.fetch(url(0.6, accessPass, true))).rejects.toThrow();
    expect(received.filter(request => request.paid)).toHaveLength(1);
    expect(agent.spentAmount).toBe(0.6);
    expect(agent.payments).toBe(1);
    await expect(agent.fetch(url(0.7))).rejects.toMatchObject({ code: 'amount_exceeds_max' });
  });

  it.each([
    { relative: true, accessPass: false },
    { relative: true, accessPass: true },
    { relative: false, accessPass: false },
  ])('preserves custom fetch URL resolution (%o)', async ({ relative, accessPass }) => {
    const client = createX402Client({
      wallets: { solana: await createKeypairWallet(walletPrivateKey) },
      adapters: [createSolanaAdapter()],
      ...(accessPass ? { accessPass: { preferTier: '1h' } } : {}),
      fetch: (input, init) => {
        const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(new URL(address, origin), init);
      },
    });
    const address = relative ? `/data?amount=0.6&pass=${accessPass}` : url(0.6);
    expect((await client.fetch(address)).status).toBe(200);
    expect(received.filter(request => request.paid)).toHaveLength(1);
  });

  it.each([false, true])('preserves a custom fetch default POST method (access pass: %s)', async accessPass => {
    const onPaymentDispatched = vi.fn();
    const client = createX402Client({
      wallets: { solana: await createKeypairWallet(walletPrivateKey) },
      adapters: [createSolanaAdapter()], onPaymentDispatched,
      ...(accessPass ? { accessPass: { preferTier: '1h' } } : {}),
      fetch: (input, init) => fetch(input, { method: 'POST', ...init }),
    });
    expect((await client.fetch(url(0.6, accessPass), { body: 'default method body' })).status).toBe(200);
    expect(received).toEqual([
      { paid: false, body: 'default method body' },
      { paid: true, body: 'default method body' },
    ]);
    expect(onPaymentDispatched).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('preserves a global fetch default POST method (access pass: %s)', async accessPass => {
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => nativeFetch(input, { method: 'POST', ...init }));
    try {
      const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
      expect((await agent.fetch(url(0.6, accessPass), { body: 'global default method body' })).status).toBe(200);
      expect(received).toEqual([
        { paid: false, body: 'global default method body' },
        { paid: true, body: 'global default method body' },
      ]);
      expect(agent.spentAmount).toBe(0.6);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([false, true])('preserves a global fetch default abort signal during signing (access pass: %s)', async accessPass => {
    const nativeFetch = globalThis.fetch;
    const controller = new AbortController();
    const entered = deferred<void>();
    const signature = deferred<Awaited<ReturnType<ChainAdapter['buildTransaction']>>>();
    buildTransaction.mockImplementationOnce(() => { entered.resolve(); return signature.promise; });
    const signals: boolean[] = [];
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      signals.push(Object.hasOwn(init ?? {}, 'signal'));
      return nativeFetch(input, { signal: controller.signal, ...init });
    });
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    const pending = agent.fetch(url(0.6, accessPass));
    const outcome = pending.then(() => undefined, error => error);
    try {
      await entered.promise;
      controller.abort();
      signature.resolve({ serialized: 'late signature' });
      if (accessPass) {
        await expect(outcome).resolves.toMatchObject({ code: 'amount_exceeds_max' });
      } else {
        await expectAbort(outcome);
      }
      expect(received.filter(entry => entry.paid)).toHaveLength(0);
      expect(signals.every(hasSignal => !hasSignal)).toBe(true);
    } finally {
      signature.resolve({ serialized: 'late signature' });
      await pending.catch(() => {});
      vi.unstubAllGlobals();
    }
  });

  it('preserves a custom fetch default signal on a cached pass request', async () => {
    const controller = new AbortController();
    const signals: boolean[] = [];
    let cachedAttempts = 0;
    const client = createX402Client({
      wallets: { solana: await createKeypairWallet(walletPrivateKey) },
      adapters: [createSolanaAdapter()], accessPass: { preferTier: '1h' },
      fetch: (input, init) => {
        signals.push(Object.hasOwn(init ?? {}, 'signal'));
        const nativeInit = { signal: controller.signal, ...init };
        if (new Headers(init?.headers).has('Authorization')) {
          cachedAttempts++;
          return fetch(new URL('/data?amount=0.6', origin), nativeInit);
        }
        return fetch(input, nativeInit);
      },
    });
    await client.fetch(url(0.6, true));
    controller.abort();
    await expect(client.fetch(url(0.6, true))).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals.every(hasSignal => !hasSignal)).toBe(true);
    expect(cachedAttempts).toBe(1);
    expect(received.filter(entry => entry.paid)).toHaveLength(1);
  });

  it.each([false, true])('allows a null signal to override an aborted Request signal (access pass: %s)', async accessPass => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request(url(0.6, accessPass), { signal: controller.signal });
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    expect((await agent.fetch(request, { signal: null })).status).toBe(200);
    expect(agent.spentAmount).toBe(0.6);
    expect(agent.payments).toBe(1);
  });

  it.each(['prototype', 'non-enumerable', 'Request'])('keeps inherited fetch options for an unpaid request (%s)', async kind => {
    const init: RequestInit = kind === 'Request'
      ? new Request(`${origin}/unused`, { method: 'DELETE', headers: { 'x-fixture': 'kept' } })
      : kind === 'non-enumerable'
        ? Object.defineProperties({}, { method: { value: 'DELETE' }, headers: { value: { 'x-fixture': 'kept' } } })
        : Object.create({ method: 'DELETE', headers: { 'x-fixture': 'kept' } });
    const agent = account();
    const response = await agent.fetch(`${origin}/unpaid`, init);
    expect(await response.json()).toEqual({ method: 'DELETE', header: 'kept' });
    expect(buildTransaction).not.toHaveBeenCalled();
    expect(agent.spentAmount).toBe(0);
  });

  it.each([
    ['prototype', false], ['non-enumerable', false], ['own', false],
    ['prototype', true], ['non-enumerable', true], ['own', true],
  ] as const)('keeps the native dispatcher (%s, access pass: %s)', async (kind, accessPass) => {
    await fetch(`${origin}/unpaid`);
    const defaultDispatcher = Reflect.get(globalThis, Symbol.for('undici.globalDispatcher.1')) as {
      dispatch: (...args: unknown[]) => boolean;
    };
    const dispatcher = { dispatch: vi.fn((...args: unknown[]) => defaultDispatcher.dispatch(...args)) };
    const init: RequestInit = kind === 'prototype'
      ? Object.create({ dispatcher })
      : kind === 'non-enumerable'
        ? Object.defineProperty({}, 'dispatcher', { value: dispatcher })
        : Object.assign({}, { dispatcher });
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    await agent.fetch(url(0.4, accessPass), init);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
    if (accessPass) {
      await agent.fetch(url(0.4, true), init);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(3);
    }
    expect(agent.spentAmount).toBe(0.4);
    expect(agent.payments).toBe(1);
  });

  it.each([
    ['prototype', false], ['non-enumerable', false], ['getter', false],
    ['prototype', true], ['non-enumerable', true], ['getter', true],
  ] as const)('preserves arbitrary custom transport options (%s, access pass: %s)', async (kind, accessPass) => {
    const marker = Symbol('transport option');
    const options = {
      agent: {}, next: { revalidate: 30 }, cf: { cacheTtl: 30 },
      fixtureRoute: {}, proxy: 'fixture-proxy', client: {}, timeout: 1000,
      [marker]: {},
    };
    let getterReads = 0;
    class TransportInit {
      declare method?: string;
      #route = options.fixtureRoute;
      constructor() {
        const descriptors = Object.getOwnPropertyDescriptors(options);
        delete (descriptors as Record<string, unknown>).fixtureRoute;
        Object.defineProperties(this, descriptors);
      }
      get fixtureRoute() { getterReads++; return this.#route; }
    }
    function makeInit(): RequestInit {
      return kind === 'prototype'
        ? Object.create(options)
        : kind === 'non-enumerable'
          ? Object.defineProperties({}, Object.fromEntries(Reflect.ownKeys(options).map(key => [key, { value: Reflect.get(options, key), configurable: true }])))
          : new TransportInit();
    }
    const init = makeInit();
    const seen: unknown[] = [];
    const client = createX402Client({
      wallets: { solana: await createKeypairWallet(walletPrivateKey) },
      ...(accessPass ? { accessPass: { preferTier: '1h' } } : {}),
      fetch: (input, requestInit) => {
        if (Reflect.get(requestInit!, 'fixtureRoute') !== options.fixtureRoute) throw new Error('custom route was lost');
        seen.push(Object.fromEntries(Reflect.ownKeys(options).map(key => [key, Reflect.get(requestInit!, key)])));
        return fetch(input, requestInit);
      },
      onPaymentRequired: () => true,
    });
    await client.fetch(url(0.4, accessPass), init);
    if (accessPass) await client.fetch(url(0.4, true), makeInit());
    expect(seen).toHaveLength(accessPass ? 3 : 2);
    for (const observed of seen) {
      for (const key of Reflect.ownKeys(options)) expect(Reflect.get(observed as object, key)).toBe(Reflect.get(options, key));
    }
    if (kind === 'getter') expect(getterReads).toBe(accessPass ? 4 : 3);
    expect(buildTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('leaves unused transport getters unread (access pass: %s)', async accessPass => {
    const unusedGetter = vi.fn(() => { throw new Error('unused option was read'); });
    const init = Object.create(Object.defineProperties({}, {
      cf: { get: unusedGetter }, arbitraryTransportOption: { get: unusedGetter },
    }));
    const agent = account(accessPass ? { accessPass: { preferTier: '1h' } } : {});
    await agent.fetch(url(0.4, accessPass), init);
    if (accessPass) await agent.fetch(url(0.4, true), init);
    expect(unusedGetter).not.toHaveBeenCalled();
    expect(agent.spentAmount).toBe(0.4);
    expect(agent.payments).toBe(1);
  });

  it.each([false, true])('keeps configured hooks when overrides are undefined (approved: %s)', async approved => {
    const onPaymentRequired = vi.fn(() => approved);
    const onPaymentDispatched = vi.fn();
    const client = createX402Client({
      wallets: { solana: await createKeypairWallet(walletPrivateKey) },
      adapters: [createSolanaAdapter()], onPaymentRequired, onPaymentDispatched,
    });
    const pending = client.fetch(url(0.6), undefined, {
      onPaymentRequired: undefined, onPaymentDispatched: undefined,
    });
    if (approved) {
      expect((await pending).status).toBe(200);
      expect(onPaymentDispatched).toHaveBeenCalledTimes(1);
    } else {
      await expect(pending).rejects.toMatchObject({ code: 'payment_rejected' });
      expect(onPaymentDispatched).not.toHaveBeenCalled();
      expect(buildTransaction).not.toHaveBeenCalled();
    }
    expect(onPaymentRequired).toHaveBeenCalledTimes(1);
  });
});
