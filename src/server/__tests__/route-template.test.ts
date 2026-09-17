import { describe, it, expect } from 'vitest';
import { isValidRouteTemplate } from '../extensions/bazaar/route-template';
import { bazaarExtension } from '../extensions/bazaar/index';

describe('isValidRouteTemplate', () => {
  it('accepts a valid static template', () => {
    expect(isValidRouteTemplate('/trust/wallet')).toBe(true);
  });

  it('accepts a valid parameterized template', () => {
    expect(isValidRouteTemplate('/trust/wallet/:address')).toBe(true);
    expect(isValidRouteTemplate('/weather/:country/:city')).toBe(true);
  });

  it('rejects undefined and empty string', () => {
    expect(isValidRouteTemplate(undefined)).toBe(false);
    expect(isValidRouteTemplate('')).toBe(false);
  });

  it('rejects a template not starting with /', () => {
    expect(isValidRouteTemplate('trust/wallet')).toBe(false);
  });

  it('rejects path traversal', () => {
    expect(isValidRouteTemplate('/trust/../admin')).toBe(false);
  });

  it('rejects percent-encoded path traversal', () => {
    expect(isValidRouteTemplate('/trust/%2e%2e/admin')).toBe(false);
  });

  it.each([
    '/%252e%252e/admin', '/%25252e%25252e/admin',
    '/x/http%253A%252F%252Fevil.com', '/x/http%25253A%25252F%25252Fevil.com',
  ])('rejects nested encoded traversal or schemes: %s', value => {
    expect(isValidRouteTemplate(value)).toBe(false);
  });

  it('accepts harmless percent encoding that reaches a fixed point', () => {
    expect(isValidRouteTemplate('/weather/%63ity/:name')).toBe(true);
    expect(isValidRouteTemplate('/weather/%2563ity/:name')).toBe(true);
  });

  it('rejects deeper encodings beyond the decoding bound', () => {
    expect(isValidRouteTemplate('/%252525252563ity')).toBe(false);
  });

  it.each(['/%252e%252e/admin', '/%25252e%25252e/admin', '/x/http%253A%252F%252Fevil.com'])('omits unsafe route templates through the public Bazaar extension: %s', async path => {
    const output = await bazaarExtension().enrichPaymentRequiredResponse!({ method: 'GET' }, {
      response: { x402Version: 2, resource: { url: 'https://fixture.invalid' }, accepts: [] },
      request: { method: 'GET', path, params: {} },
    });
    expect(output).not.toHaveProperty('routeTemplate');
  });

  it('rejects a URL scheme injection', () => {
    expect(isValidRouteTemplate('/x/http://evil.com')).toBe(false);
  });

  it('rejects disallowed characters', () => {
    expect(isValidRouteTemplate('/trust/wallet?q=1')).toBe(false);
    expect(isValidRouteTemplate('/trust/wallet $')).toBe(false);
  });

  it('rejects a value that fails to percent-decode', () => {
    expect(isValidRouteTemplate('/trust/%ZZ')).toBe(false);
  });
});
