import { describe, it, expect } from 'vitest';
import { buildDiscoveryExtension } from '../extensions/bazaar/build';

describe('buildDiscoveryExtension — GET / query methods', () => {
  it('builds info + schema for a GET with path params', () => {
    const ext = buildDiscoveryExtension(
      {
        method: 'GET',
        pathParamsSchema: {
          properties: { address: { type: 'string' } },
          required: ['address'],
        },
        output: { example: { ok: true } },
      },
      { pathParams: { address: 'X4o2' }, routeTemplate: '/trust/wallet/:address' },
    );
    expect(ext.info.input.type).toBe('http');
    expect(ext.info.input.method).toBe('GET');
    expect(ext.info.input.pathParams).toEqual({ address: 'X4o2' });
    expect(ext.info.output).toEqual({ type: 'json', example: { ok: true } });
    expect(ext.routeTemplate).toBe('/trust/wallet/:address');
    expect(ext.schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('builds info for a GET with query params', () => {
    const ext = buildDiscoveryExtension(
      {
        method: 'GET',
        input: { verdict: 'wash' },
        inputSchema: { properties: { verdict: { type: 'string' } } },
      },
      {},
    );
    expect(ext.info.input.queryParams).toEqual({ verdict: 'wash' });
    expect(ext.routeTemplate).toBeUndefined();
  });

  it('omits routeTemplate when it is invalid', () => {
    const ext = buildDiscoveryExtension(
      { method: 'GET' },
      { routeTemplate: '/trust/../admin' },
    );
    expect(ext.routeTemplate).toBeUndefined();
  });

  it('omits output when no example is given', () => {
    const ext = buildDiscoveryExtension({ method: 'GET' }, {});
    expect(ext.info.output).toBeUndefined();
  });
});

describe('buildDiscoveryExtension — POST / body methods', () => {
  it('builds info + schema for a POST with a json body', () => {
    const ext = buildDiscoveryExtension(
      {
        method: 'POST',
        bodyType: 'json',
        input: { addresses: ['a', 'b'] },
        inputSchema: {
          properties: { addresses: { type: 'array', items: { type: 'string' } } },
          required: ['addresses'],
        },
        output: { example: { count: 2 } },
      },
      {},
    );
    expect(ext.info.input.type).toBe('http');
    expect(ext.info.input.method).toBe('POST');
    expect(ext.info.input.bodyType).toBe('json');
    expect(ext.info.input.body).toEqual({ addresses: ['a', 'b'] });
    expect(ext.info.output).toEqual({ type: 'json', example: { count: 2 } });
  });
});

describe('buildDiscoveryExtension — schema self-consistency', () => {
  it('produces a schema with input required', () => {
    const ext = buildDiscoveryExtension({ method: 'GET' }, {});
    expect((ext.schema as { required: string[] }).required).toContain('input');
  });
});
