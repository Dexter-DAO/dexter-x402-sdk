// src/payment/__tests__/fixtures.ts
/**
 * Real-shape x402 402 responses for strategy tests.
 *
 * v2 — challenge in a base64 PAYMENT-REQUIRED header, empty body.
 *      Shape taken from api.reloadpi.com (a live v2 merchant).
 * v1 — challenge in the JSON body, bare network name, no header.
 *      Shape taken from the x402 v1 specification.
 */

const v2Challenge = {
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'https://example.com/api', mimeType: 'application/json' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '2000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x8a598A28a435Fe44D31854251b1c88d0781ea822',
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};

/** A v2 402: empty body, base64 PAYMENT-REQUIRED header. */
export function makeV2Response(): Response {
  const header = Buffer.from(JSON.stringify(v2Challenge)).toString('base64');
  return new Response('{}', {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'payment-required': header,
    },
  });
}

const v1Body = {
  x402Version: 1,
  error: 'X-PAYMENT header is required',
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x8a598A28a435Fe44D31854251b1c88d0781ea822',
      resource: 'https://example.com/api',
      description: 'Example v1 resource',
      maxTimeoutSeconds: 60,
    },
  ],
};

/** A v1 402: challenge in the JSON body, no PAYMENT-REQUIRED header. */
export function makeV1Response(): Response {
  return new Response(JSON.stringify(v1Body), {
    status: 402,
    headers: { 'content-type': 'application/json' },
  });
}

/** A 402 with neither a header nor a usable body — unrecognisable. */
export function makeEmptyResponse(): Response {
  return new Response('{}', {
    status: 402,
    headers: { 'content-type': 'application/json' },
  });
}
