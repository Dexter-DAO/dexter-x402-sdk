import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generatePrivateKey } from 'viem/accounts';
import { parseSIWxHeader, verifySIWxSignature } from '@x402/extensions/sign-in-with-x';
import { payAndFetch } from '../dispatcher';
import { v2Strategy } from '../v2-strategy';
import { createEvmKeypairWallet } from '../../client/evm-wallet';

const realFetch = globalThis.fetch;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type Mode = 'success' | 'wrong-domain' | 'wrong-uri' | 'signed-redirect' | 'still-payment' | 'free' | 'plain-payment' | 'payment-redirect' | 'paid' | 'signed-network-error' | 'round-trip';
async function fixture(mode: Mode, redirectStatus = 302) {
  const wallet = await createEvmKeypairWallet(generatePrivateKey());
  const originalSign = wallet.signMessage as (args: { message: string }) => Promise<string>;
  const sign = vi.fn(originalSign);
  const originalPaymentSign = wallet.signTypedData!;
  const permitOfflinePayment = mode === 'payment-redirect' || mode === 'paid';
  const paymentSign = vi.fn(async (...args: Parameters<typeof originalPaymentSign>) => {
    if (permitOfflinePayment) return originalPaymentSign(...args);
    throw new Error('Economic signing forbidden in this HTTP fixture');
  });
  wallet.signMessage = sign;
  wallet.signTypedData = paymentSign;
  const calls: { server: string; method?: string; path?: string; proof: boolean; payment: boolean; body: string; contentType?: string; authorization?: string; cookie?: string; proxyAuthorization?: string }[] = [];
  const errors: string[] = [];
  let merchantUrl = '';
  let thirdUrl = '';
  let directoryUrl = '';
  const servers: Server[] = [];
  async function listen(handler: RequestListener) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const third = await listen((_req, res) => { calls.push({ server: 'third', proof: false, payment: false, body: '' }); res.end('unexpected'); });
  thirdUrl = `${third}/unexpected`;
  const merchant = await listen(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      const proof = req.headers['sign-in-with-x'];
      calls.push({ server: 'merchant', method: req.method, path: req.url, proof: Boolean(proof), payment: Boolean(req.headers['payment-signature']), body, contentType: req.headers['content-type'], authorization: req.headers.authorization, cookie: req.headers.cookie, proxyAuthorization: req.headers['proxy-authorization'] as string | undefined });
      if (mode === 'round-trip' && req.url === '/start') { res.writeHead(302, { location: directoryUrl }); res.end(); return; }
      if (req.headers['payment-signature']) {
        if (mode === 'payment-redirect') { res.writeHead(302, { location: thirdUrl }); res.end(); return; }
        res.writeHead(200, { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, network: 'eip155:8453', transaction: 'offline-fixture-hash' })).toString('base64') }); res.end('paid offline fixture'); return;
      }
      if (proof) {
        const parsed = parseSIWxHeader(String(proof));
        expect(await verifySIWxSignature(parsed)).toEqual({ isValid: true, payer: wallet.address });
        expect(parsed.uri).toBe(merchantUrl);
        if (mode === 'signed-network-error') { req.socket.destroy(); return; }
        if (mode === 'signed-redirect') { res.writeHead(302, { location: thirdUrl }); res.end(); return; }
        if (!['still-payment', 'payment-redirect', 'paid'].includes(mode)) { res.writeHead(200); res.end('authorized'); return; }
      }
      if (mode === 'free') { res.writeHead(200); res.end('free'); return; }
      const required = {
        x402Version: 2, resource: { url: merchantUrl },
        accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '10000', payTo: '0x1111111111111111111111111111111111111111', maxTimeoutSeconds: 60, extra: { decimals: 6 } }],
        ...(mode === 'plain-payment' ? {} : { extensions: { 'sign-in-with-x': {
          info: { domain: mode === 'wrong-domain' ? 'wrong.example' : new URL(merchantUrl).host, uri: mode === 'wrong-uri' ? `${third}/wrong` : merchantUrl, version: '1', nonce: 'unfundedhttpfixture123456', issuedAt: new Date().toISOString() },
          supportedChains: [{ chainId: 'eip155:8453', type: 'eip191' }],
        } } }),
      };
      res.writeHead(402, { 'content-type': 'application/json', 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64') });
      res.end(JSON.stringify(required));
    } catch (error) { errors.push(String(error)); res.writeHead(500); res.end('fixture failure'); }
  });
  merchantUrl = `${merchant}/protected`;
  const directory = await listen(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    calls.push({ server: 'directory', method: req.method, path: req.url, proof: Boolean(req.headers['sign-in-with-x']), payment: Boolean(req.headers['payment-signature']), body });
    res.writeHead(redirectStatus, { location: merchantUrl }); res.end();
  });
  directoryUrl = `${directory}/link`;
  const allowed = new Set([merchant, directory, third]);
  vi.stubGlobal('fetch', async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!allowed.has(new URL(request.url).origin)) {
      if (permitOfflinePayment) {
        const rpc = JSON.parse(await request.text()) as { method: string };
        expect(rpc.method).toBe('eth_call');
        return Response.json({ jsonrpc: '2.0', id: 1, result: `0x${'f'.repeat(64)}` });
      }
      throw new Error('External network forbidden');
    }
    return realFetch(request);
  });
  return {
    wallet, sign, paymentSign, calls, errors, merchantUrl, directoryUrl: `${directory}/link`,
    close: async () => { await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); expect(errors).toEqual([]); if (!permitOfflinePayment) { expect(paymentSign).not.toHaveBeenCalled(); expect(calls.some(call => call.payment)).toBe(false); } },
  };
}

describe('SIWX proof destination over actual HTTP', () => {
  it('signs a direct merchant challenge with an actual unfunded key', async () => {
    const f = await fixture('success');
    try {
      const result = await payAndFetch(f.merchantUrl, {}, { evm: f.wallet }, { maxAmountAtomic: '0' });
      expect(result.ok && !result.paid).toBe(true);
      expect(f.sign).toHaveBeenCalledTimes(1);
      expect(f.calls.map(c => [c.server, c.proof])).toEqual([['merchant', false], ['merchant', true]]);
    } finally { await f.close(); }
  });

  it('sends the proof directly to the final merchant after an unsigned cross-origin redirect', async () => {
    const f = await fixture('success');
    try {
      const result = await payAndFetch(f.directoryUrl, {}, { evm: f.wallet }, { maxAmountAtomic: '0' });
      expect(result.ok && !result.paid).toBe(true);
      expect(f.calls.map(c => [c.server, c.proof])).toEqual([['directory', false], ['merchant', false], ['merchant', true]]);
    } finally { await f.close(); }
  });

  it('preserves a direct POST body and headers on its signed retry', async () => {
    const f = await fixture('success');
    try {
      const body = JSON.stringify({ query: 'exact body 💚' });
      const result = await payAndFetch(f.merchantUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer direct-fixture', cookie: 'direct-fixture=value', 'proxy-authorization': 'direct-fixture' }, body }, { evm: f.wallet }, { maxAmountAtomic: '0' });
      expect(result.ok && !result.paid).toBe(true);
      expect(f.calls).toHaveLength(2);
      expect(f.calls.every(c => c.method === 'POST' && c.body === body)).toBe(true);
      expect(f.calls.filter(c => c.server === 'merchant').every(c => c.contentType === 'application/json' && c.authorization === 'Bearer direct-fixture' && c.cookie === 'direct-fixture=value' && c.proxyAuthorization === 'direct-fixture')).toBe(true);
      expect(f.calls.filter(c => c.proof).map(c => c.server)).toEqual(['merchant']);
    } finally { await f.close(); }
  });

  it('does not restore credentials after an A to B to A redirect chain', async () => {
    const f = await fixture('round-trip');
    try {
      const result = await payAndFetch(f.merchantUrl.replace('/protected', '/start'), { headers: { authorization: 'Bearer roundtrip-fixture', cookie: 'roundtrip-fixture=value', 'proxy-authorization': 'roundtrip-fixture' } }, { evm: f.wallet }, { maxAmountAtomic: '0' });
      expect(result.ok && !result.paid).toBe(true);
      expect(f.calls[0].authorization).toBe('Bearer roundtrip-fixture');
      expect(f.calls.filter(c => c.server === 'merchant' && c.path === '/protected').every(c => !c.authorization && !c.cookie && !c.proxyAuthorization)).toBe(true);
      expect(f.calls.filter(c => c.proof).map(c => [c.server, c.path])).toEqual([['merchant', '/protected']]);
    } finally { await f.close(); }
  });

  it.each([302, 303, 307, 308])('refuses redirected POST after%s without signing or paying', async status => {
    const f = await fixture('success', status);
    const pay = vi.spyOn(v2Strategy, 'pay');
    try {
      const result = await payAndFetch(f.directoryUrl, { method: 'POST', body: 'kept private' }, { evm: f.wallet }, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.detail).toMatch(/final resource URL/);
      expect(f.sign).not.toHaveBeenCalled();
      expect(pay).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(2);
    } finally { await f.close(); }
  });

  it.each(['wrong-domain', 'wrong-uri'] as const)('refuses%s before signing or payment fallback', async mode => {
    const f = await fixture(mode);
    const pay = vi.spyOn(v2Strategy, 'pay');
    try {
      const result = await payAndFetch(f.directoryUrl, {}, { evm: f.wallet }, { maxAmountAtomic: '0' });
      expect(result.ok).toBe(false);
      expect(f.sign).not.toHaveBeenCalled();
      expect(pay).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(2);
    } finally { await f.close(); }
  });

  it.each(['signed-redirect', 'signed-network-error'] as const)('refuses%s without contacting a third origin or falling through to payment', async mode => {
    const f = await fixture(mode);
    const pay = vi.spyOn(v2Strategy, 'pay');
    try {
      const result = await payAndFetch(f.directoryUrl, {}, { evm: f.wallet }, { maxAmountAtomic: '0' });
      expect(result.ok).toBe(false);
      expect(f.sign).toHaveBeenCalledTimes(1);
      expect(pay).not.toHaveBeenCalled();
      expect(f.calls.map(c => [c.server, c.proof])).toEqual([['directory', false], ['merchant', false], ['merchant', true]]);
    } finally { await f.close(); }
  });

  it.each(['still-payment', 'signing-unavailable'] as const)('keeps%s payment fallback bound to the final merchant without redirects', async mode => {
    const f = await fixture(mode === 'still-payment' ? 'still-payment' : 'success');
    if (mode === 'signing-unavailable') f.sign.mockRejectedValue(new Error('wallet unavailable'));
    const pay = vi.spyOn(v2Strategy, 'pay').mockResolvedValue({ ok: false, reason: 'no_payment_options' });
    try {
      await payAndFetch(f.directoryUrl, { method: 'GET' }, { evm: f.wallet }, { maxAmountAtomic: '0' });
      expect(pay).toHaveBeenCalledTimes(1);
      expect(pay.mock.calls[0][0]).toBe(f.merchantUrl);
      expect(pay.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
      expect(f.calls.some(c => c.server === 'directory' && c.proof)).toBe(false);
    } finally { await f.close(); }
  });

  it.each(['paid', 'payment-redirect'] as const)('uses the actual builder/client for%s fallback at the final URL with no credential or redirect forwarding', async mode => {
    const f = await fixture(mode);
    try {
      const result = await payAndFetch(f.directoryUrl, { headers: { authorization: 'Bearer fixture-private', cookie: 'fixture-private=value', 'proxy-authorization': 'fixture-private' } }, { evm: f.wallet }, { maxAmountAtomic: '10000' });
      expect(f.paymentSign).toHaveBeenCalledTimes(1);
      expect(f.calls.filter(c => c.payment).map(c => c.server)).toEqual(['merchant']);
      expect(f.calls.some(c => c.server === 'third' || (c.server === 'directory' && c.proof))).toBe(false);
      expect(f.calls.filter(c => c.server === 'merchant').every(c => !c.authorization && !c.cookie && !c.proxyAuthorization)).toBe(true);
      if (mode === 'paid') expect(result).toMatchObject({ ok: true, paid: true });
      else expect(result).toMatchObject({ ok: false, reason: 'payment_unconfirmed' });
    } finally { await f.close(); }
  });

  it('preserves ordinary exact strategy selection when SIWX is absent', async () => {
    const f = await fixture('plain-payment');
    const pay = vi.spyOn(v2Strategy, 'pay').mockResolvedValue({ ok: false, reason: 'no_payment_options' });
    try {
      await payAndFetch(f.merchantUrl, { method: 'POST', body: '{}' }, { evm: f.wallet }, {});
      expect(pay).toHaveBeenCalledTimes(1);
      expect(pay.mock.calls[0][0]).toBe(f.merchantUrl);
      expect(pay.mock.calls[0][1]).toEqual({ method: 'POST', body: '{}' });
      expect(f.sign).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('returns ordinary200 without requesting a proof', async () => {
    const f = await fixture('free');
    try {
      const result = await payAndFetch(f.merchantUrl, {}, { evm: f.wallet }, {});
      expect(result.ok && !result.paid).toBe(true);
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(1);
    } finally { await f.close(); }
  });
});
