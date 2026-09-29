import { afterEach, describe, expect, it, vi } from 'vitest';
import { FacilitatorClient } from '../facilitator-client';
import { x402Middleware } from '../middleware';
import { publicSettlementReceipt } from '../settlement-outcome';
import type { SettleResponse } from '../../types';

const network = 'eip155:8453';
const transaction = `0x${'12'.repeat(32)}`;
const unknown: SettleResponse = {
  success: false, network, transaction, errorCode: 'settlement_unknown',
  errorReason: 'https://internal.example?auth=secret\ninternal stack',
  facilitatorResponse: { status: 500, body: 'upstream secret', bodyComplete: true, bodyTruncated: false },
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function request(settlement?: SettleResponse) {
  vi.spyOn(FacilitatorClient.prototype, 'getSupported').mockResolvedValue({
    kinds: [{ x402Version: 2, scheme: 'exact', network, extra: { decimals: 6 } }],
  });
  const verify = vi.spyOn(FacilitatorClient.prototype, 'verifyPayment').mockResolvedValue({ isValid: true });
  const settle = vi.spyOn(FacilitatorClient.prototype, 'settlePayment');
  if (settlement) settle.mockResolvedValue(settlement);
  const mw = x402Middleware({ network, payTo: '0x1111111111111111111111111111111111111111', amount: '0.01' });
  const payment = btoa(JSON.stringify({ x402Version: 2, accepted: { network, amount: '10000' }, payload: { fixture: true } }));
  const req = { method: 'GET', protocol: 'https', path: '/report', originalUrl: '/report',
    headers: { 'payment-signature': payment },
    get: (name: string) => name.toLowerCase() === 'payment-signature' ? payment : 'merchant.example',
  } as unknown as Parameters<typeof mw>[0];
  const headers = new Map<string, unknown>();
  let body: unknown;
  const response = {
    statusCode: 200,
    setHeader: (name: string, value: unknown) => { headers.set(name.toLowerCase(), value); },
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { body = value; return this; },
  };
  const next = vi.fn();
  await mw(req, response as unknown as Parameters<typeof mw>[1], next);
  return { headers, body, status: response.statusCode, verify, settle, next };
}

describe('unknown seller settlement', () => {
  it('responds with recovery metadata and no new payment challenge or upstream secrets', async () => {
    const result = await request(unknown);
    expect(result.status).toBe(503);
    expect(result.headers.has('payment-required')).toBe(false);
    const encoded = String(result.headers.get('payment-response'));
    expect(encoded.length).toBeLessThan(1024);
    expect(JSON.parse(atob(encoded))).toEqual({ success: false, network, transaction, errorCode: 'settlement_unknown' });
    expect(result.body).toEqual({ error: 'Settlement outcome unknown', success: false, network,
      transaction, errorCode: 'settlement_unknown', recoveryRequired: true });
    expect(JSON.stringify(result.body)).not.toContain('secret');
    expect(result.verify).toHaveBeenCalledTimes(1);
    expect(result.settle).toHaveBeenCalledTimes(1);
    expect(result.next).not.toHaveBeenCalled();
  });

  it('keeps definitive refusal behavior', async () => {
    const result = await request({ success: false, network, errorReason: 'invalid_signature' });
    expect(result.status).toBe(402);
    expect(result.body).toEqual({ error: 'Payment settlement failed', reason: 'invalid_signature' });
    expect(result.next).not.toHaveBeenCalled();
  });

  it.each<[number, Record<string, unknown>]>([
    [408, { error: 'request_timeout' }],
    [429, { error: 'rate_limited' }],
    [402, { success: false, errorCode: 'settlement_pending', transaction }],
    [409, { success: false, errorCode: 'duplicate_in_flight' }],
    [400, { success: true, transaction }],
    [422, { success: false, transaction }],
  ])('does not issue a new payment challenge after ambiguous facilitator HTTP %s', async (status, receipt) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ...receipt,
      upstream: 'https://internal.example?auth=secret', stack: 'internal stack' }), { status }));
    vi.stubGlobal('fetch', fetch);
    const result = await request();
    expect(result.status).toBe(503);
    expect(result.headers.has('payment-required')).toBe(false);
    const expected = { success: false, network, errorCode: 'settlement_unknown',
      ...('transaction' in receipt ? { transaction: receipt.transaction } : {}) };
    expect(JSON.parse(atob(String(result.headers.get('payment-response'))))).toEqual(expected);
    expect(result.body).toEqual({ error: 'Settlement outcome unknown', ...expected, recoveryRequired: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.settle).toHaveBeenCalledTimes(1);
    expect(result.next).not.toHaveBeenCalled();
  });

  it('keeps an actual facilitator invalid_signature refusal definitive', async () => {
    const fetch = vi.fn(async () => new Response('{"error":"invalid_signature"}', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const result = await request();
    expect(result.status).toBe(402);
    expect(result.body).toEqual({ error: 'Payment settlement failed', reason: 'facilitator_error_400' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.next).not.toHaveBeenCalled();
  });

  it.each(['https://private.example?auth=secret', 'x'.repeat(300), 'stack\ntrace'])('omits malformed transaction metadata: %s', transaction => {
    expect(publicSettlementReceipt({ ...unknown, transaction })).toEqual({ success: false, network, errorCode: 'settlement_unknown' });
    expect(unknown.facilitatorResponse?.body).toBe('upstream secret');
  });
});
