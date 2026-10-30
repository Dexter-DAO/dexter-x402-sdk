import { DID_DOCUMENT_MAX_BYTES, DID_FETCH_TIMEOUT_MS } from './types';

export type DidDocumentUnavailableReason = 'network' | 'timeout' | 'status' | 'redirect' | 'too_large';

export class DidDocumentUnavailable extends Error {
  readonly name = 'DidDocumentUnavailable';
  constructor(readonly reason: DidDocumentUnavailableReason) {
    super(`did_document_unavailable: ${reason}`);
  }
}

function isRedirectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Browsers deliberately hide why redirect:'error' failed. Node may expose a cause.
  return /redirect/i.test(error.message) || ('cause' in error && isRedirectError(error.cause));
}

export async function defaultFetchDidDocument(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DID_FETCH_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const options = {
      redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { accept: 'application/did+json, application/json' }, signal: controller.signal,
    } as const;
    const response = await fetch(url, options);
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new DidDocumentUnavailable('redirect');
    }
    if (response.status !== 200) throw new DidDocumentUnavailable('status');
    if (!response.body) return new Uint8Array();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > DID_DOCUMENT_MAX_BYTES) {
        controller.abort();
        void reader.cancel().catch(() => {});
        throw new DidDocumentUnavailable('too_large');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } catch (error) {
    if (error instanceof DidDocumentUnavailable) throw error;
    throw new DidDocumentUnavailable(timedOut ? 'timeout' : isRedirectError(error) ? 'redirect' : 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    reader?.releaseLock();
  }
}
