import { describe, it, expect } from 'vitest';
import { isValidRouteTemplate } from '../extensions/bazaar/route-template';

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
