import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FacilitatorClient } from '../facilitator-client';
import type { PaymentAccept } from '../../types';

type Operation = 'supported' | 'verify' | 'settle';

const REQUIREMENTS: PaymentAccept = {
  scheme: 'exact',
  network: 'solana:fixture',
  asset: 'fixture',
  amount: '1',
  payTo: 'fixture',
  maxTimeoutSeconds: 1,
};
const PAYMENT = btoa(JSON.stringify({ x402Version: 2, payload: { fixture: true } }));
const TIMEOUT_MS = 80;

async function call(client: FacilitatorClient, operation: Operation) {
  if (operation === 'supported') return client.getSupported();
  if (operation === 'verify') return client.verifyPayment(PAYMENT, REQUIREMENTS);
  return client.settlePayment(PAYMENT, REQUIREMENTS);
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Response exceeded the fixture deadline')), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('FacilitatorClient HTTP response deadlines', () => {
  const closeFixtures: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closeFixtures.splice(0).map(close => close()));
  });

  async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const requests: Array<{ path: string; body: string }> = [];
    let closedResponses = 0;
    const server = createServer((req, res) => {
      res.on('close', () => { closedResponses++; });
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requests.push({ path: req.url!, body });
        handler(req, res);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    closeFixtures.push(() => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const client = new FacilitatorClient(`http://127.0.0.1:${address.port}`, {
      timeoutMs: TIMEOUT_MS,
      maxRetries: 3,
      retryBaseMs: 1,
    });
    return { client, requests, closedResponses: () => closedResponses };
  }

  async function expectTimeout(client: FacilitatorClient, operation: Operation) {
    if (operation === 'supported') {
      await expect(within(call(client, operation))).rejects.toMatchObject({ name: 'AbortError' });
    } else if (operation === 'verify') {
      expect(await within(call(client, operation))).toEqual({
        isValid: false, invalidReason: 'facilitator_timeout',
      });
    } else {
      expect(await within(call(client, operation))).toEqual({
        success: false, network: REQUIREMENTS.network, errorReason: 'facilitator_timeout',
      });
    }
  }

  it.each<Operation>(['supported', 'verify', 'settle'])('bounds %s before headers', async operation => {
    const f = await fixture(() => {});
    await expectTimeout(f.client, operation);
    expect(f.requests).toHaveLength(1);
    await expect.poll(f.closedResponses).toBe(1);
  });

  it.each<Operation>(['supported', 'verify', 'settle'])('bounds %s after successful headers', async operation => {
    const f = await fixture((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      res.write('{');
    });
    await expectTimeout(f.client, operation);
    expect(f.requests).toHaveLength(1);
    await expect.poll(f.closedResponses).toBe(1);
  });

  it.each<Operation>(['supported', 'verify', 'settle'])('does not extend %s deadline for incoming body chunks', async operation => {
    const f = await fixture((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
      const interval = setInterval(() => res.write(' '), 10);
      res.on('close', () => clearInterval(interval));
    });
    await expectTimeout(f.client, operation);
    expect(f.requests).toHaveLength(1);
    await expect.poll(f.closedResponses).toBe(1);
  });

  it.each<Operation>(['verify', 'settle'])('bounds %s error body reads without retrying a timeout', async operation => {
    const f = await fixture((_, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.write('incomplete error');
    });
    await expectTimeout(f.client, operation);
    expect(f.requests).toHaveLength(1);
    await expect.poll(f.closedResponses).toBe(1);
  });

  it.each<Operation>(['supported', 'verify', 'settle'])('cancels the unread %s rejection body', async operation => {
    const f = await fixture((_, res) => {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.write('incomplete rejection');
    });
    if (operation === 'supported') {
      await expect(within(call(f.client, operation))).rejects.toThrow('returned 400');
    } else if (operation === 'verify') {
      expect(await within(call(f.client, operation))).toEqual({
        isValid: false, invalidReason: 'facilitator_error_400',
      });
    } else {
      expect(await within(call(f.client, operation))).toEqual({
        success: false, network: REQUIREMENTS.network, errorReason: 'facilitator_error_400',
      });
    }
    expect(f.requests).toHaveLength(1);
    await expect.poll(f.closedResponses).toBe(1);
  });

  it('caches only the complete supported body', async () => {
    const supported = { kinds: [{ x402Version: 2, scheme: 'exact', network: REQUIREMENTS.network }] };
    let complete = false;
    const f = await fixture((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (complete) res.end(JSON.stringify(supported));
      else res.write('{');
    });
    await expectTimeout(f.client, 'supported');
    complete = true;
    expect(await f.client.getSupported()).toEqual(supported);
    expect(await f.client.getSupported()).toEqual(supported);
    expect(f.requests).toHaveLength(2);
  });

  it.each<Operation>(['verify', 'settle'])('preserves %s retries of complete 5xx responses and exact request bytes', async operation => {
    let attempts = 0;
    const expected = operation === 'verify'
      ? { isValid: true, payer: 'fixture' }
      : { success: true, transaction: 'fixture', network: REQUIREMENTS.network };
    const f = await fixture((_, res) => {
      attempts++;
      res.writeHead(attempts < 3 ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(attempts < 3 ? { error: 'fixture' } : expected));
    });
    expect(await within(call(f.client, operation))).toEqual(expected);
    expect(f.requests).toHaveLength(3);
    expect(new Set(f.requests.map(request => request.body)).size).toBe(1);
    expect(JSON.parse(f.requests[0].body)).toEqual({
      x402Version: 2,
      paymentPayload: JSON.parse(atob(PAYMENT)),
      paymentRequirements: REQUIREMENTS,
    });
    expect(f.requests.map(request => request.path)).toEqual(Array(3).fill(`/${operation}`));
  });

  it.each<Operation>(['verify', 'settle'])('does not retry a dropped successful %s body', async operation => {
    const f = await fixture((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
      setTimeout(() => res.destroy(), 10);
    });
    const result = await within(call(f.client, operation));
    expect(result).toMatchObject(operation === 'verify'
      ? { isValid: false, invalidReason: 'terminated' }
      : { success: false, errorReason: 'terminated' });
    expect(f.requests).toHaveLength(1);
    await expect.poll(f.closedResponses).toBe(1);
  });

  it.each<Operation>(['verify', 'settle'])('does not retry malformed successful %s JSON', async operation => {
    const f = await fixture((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{');
    });
    expect(await within(call(f.client, operation))).toMatchObject(operation === 'verify'
      ? { isValid: false }
      : { success: false });
    expect(f.requests).toHaveLength(1);
  });
});
