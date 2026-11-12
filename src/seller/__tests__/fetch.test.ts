import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFetchDidDocument, DidDocumentUnavailable } from '../fetch';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('defaultFetchDidDocument', () => {
  it('returns exact streamed bytes with private no-redirect fetch options', async () => {
    const chunks = [new Uint8Array([0, 255]), new Uint8Array([10, 13, 32])];
    const mock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { chunks.forEach((chunk) => controller.enqueue(chunk)); controller.close(); },
    })));
    vi.stubGlobal('fetch', mock);
    expect(await defaultFetchDidDocument('https://dexter.cash/.well-known/did.json'))
      .toEqual(new Uint8Array([0, 255, 10, 13, 32]));
    expect(mock).toHaveBeenCalledWith('https://dexter.cash/.well-known/did.json', expect.objectContaining({
      redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { accept: 'application/did+json, application/json' }, signal: expect.any(AbortSignal),
    }));
  });

  it('fetch refuses a redirect and a 70 KB body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 302 })));
    await expect(defaultFetchDidDocument('https://dexter.cash/did')).rejects.toMatchObject({ reason: 'redirect' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array(70 * 1024))));
    await expect(defaultFetchDidDocument('https://dexter.cash/did')).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('refuses a response marked redirected even when its status is 200', async () => {
    const response = new Response('{}');
    Object.defineProperty(response, 'redirected', { value: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(defaultFetchDidDocument('https://dexter.cash/did')).rejects.toMatchObject({ reason: 'redirect' });
  });

  it('accepts 65536 bytes and cancels a stream as soon as the cap is exceeded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array(65536))));
    expect((await defaultFetchDidDocument('https://dexter.cash/did')).length).toBe(65536);
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65536)); controller.enqueue(new Uint8Array(1)); },
      cancel,
    }))));
    await expect(defaultFetchDidDocument('https://dexter.cash/did')).rejects.toMatchObject({ reason: 'too_large' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('reports non-200 status and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    await expect(defaultFetchDidDocument('https://dexter.cash/did')).rejects.toMatchObject({ reason: 'status' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(defaultFetchDidDocument('https://dexter.cash/did')).rejects.toBeInstanceOf(DidDocumentUnavailable);
    await expect(defaultFetchDidDocument('https://dexter.cash/did')).rejects.toMatchObject({ reason: 'network' });
  });

  it('classifies a redirect cause when the runtime exposes it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })));
    await expect(defaultFetchDidDocument('https://dexter.cash/did')).rejects.toMatchObject({ reason: 'redirect' });
  });

  it('times out after five seconds and forwards caller cancellation', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })));
    const timed = expect(defaultFetchDidDocument('https://dexter.cash/did')).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await timed;
    expect(signals[0].aborted).toBe(true);
    const controller = new AbortController();
    const cancelled = expect(defaultFetchDidDocument('https://dexter.cash/did', controller.signal))
      .rejects.toMatchObject({ reason: 'network' });
    controller.abort();
    await cancelled;
    expect(signals[1].aborted).toBe(true);
  });
});
