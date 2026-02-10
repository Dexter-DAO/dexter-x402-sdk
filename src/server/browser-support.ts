/**
 * x402 Browser Support Middleware
 *
 * Express middleware that automatically renders a branded HTML paywall page
 * when a browser (Accept: text/html) receives a 402 Payment Required response.
 * API clients continue to receive the standard JSON response unchanged.
 *
 * This is a protocol-level concern: the 402 response is part of x402, and
 * providing a human-readable payment page for browsers is the natural UX.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { x402Middleware, x402BrowserSupport } from '@dexterai/x402/server';
 *
 * const app = express();
 * app.use(express.json());
 * app.use(x402BrowserSupport()); // one line -- all 402s render HTML for browsers
 *
 * app.post('/api/data',
 *   x402Middleware({ payTo: '...', amount: '0.01' }),
 *   (req, res) => res.json({ data: 'protected' })
 * );
 * ```
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Configuration for x402BrowserSupport middleware.
 * All fields are optional -- sensible defaults are used.
 */
export interface X402BrowserSupportConfig {
  /**
   * Custom title shown on the paywall page.
   * @default 'Payment Required'
   */
  title?: string;

  /**
   * Custom branding text shown at the bottom.
   * @default 'Powered by x402'
   */
  branding?: string;

  /**
   * URL to link for SDK/documentation.
   * @default 'https://x402.org'
   */
  sdkUrl?: string;

  /**
   * Whether to include the request method and path on the page.
   * @default true
   */
  showEndpoint?: boolean;
}

/**
 * Generate the paywall HTML page from decoded payment requirements.
 */
function generatePaywallHtml(
  paymentRequiredHeader: string,
  requestUrl: string,
  method: string,
  config: Required<Pick<X402BrowserSupportConfig, 'title' | 'branding' | 'sdkUrl' | 'showEndpoint'>>,
): string {
  let price = '?';
  let description = 'This resource requires payment';
  let network = '';

  try {
    const decoded = JSON.parse(Buffer.from(paymentRequiredHeader, 'base64').toString());
    const accept = decoded.accepts?.[0];
    if (accept) {
      const amount = accept.amount || accept.maxAmountRequired || '0';
      const decimals = accept.extra?.decimals || 6;
      price = (Number(amount) / Math.pow(10, decimals)).toFixed(decimals > 4 ? 4 : 2);
      network = accept.network || '';
    }
    if (decoded.resource?.description) {
      description = decoded.resource.description;
    }
  } catch {
    // If we can't decode, show generic paywall
  }

  const chainName = network.includes('solana')
    ? 'Solana'
    : network.includes('eip155')
      ? 'Base'
      : 'Unknown';

  const endpointSection = config.showEndpoint
    ? `<div class="endpoint"><code>${method} ${requestUrl}</code></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${config.title} — $${price} USDC</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.paywall{max-width:460px;width:100%;background:#141414;border:1px solid #2a2a2a;border-radius:16px;padding:2.5rem;text-align:center}
.paywall h1{font-size:1.35rem;margin-bottom:.35rem;color:#f1f5f9;font-weight:600}
.desc{color:#94a3b8;font-size:.95rem;margin-bottom:1.5rem;line-height:1.5}
.price-badge{display:inline-block;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;padding:.6rem 2rem;border-radius:999px;font-size:1.75rem;font-weight:700;margin:1rem 0;letter-spacing:-.02em}
.chain{color:#64748b;font-size:.8rem;margin-bottom:1.5rem}
.endpoint{background:#1e1e1e;border:1px solid #333;border-radius:8px;padding:.6rem 1rem;margin-bottom:1.5rem}
.endpoint code{font-family:'SF Mono',Monaco,Consolas,monospace;font-size:.85rem;color:#60a5fa}
.info{background:#1a1a2e;border:1px solid #2d2d5e;border-radius:10px;padding:1rem 1.25rem;font-size:.85rem;color:#a0aec0;line-height:1.6;text-align:left}
.info strong{color:#e2e8f0}
.info code{background:#2a2a3e;padding:2px 6px;border-radius:4px;font-size:.8rem;color:#818cf8;font-family:'SF Mono',Monaco,Consolas,monospace}
.info a{color:#60a5fa;text-decoration:none;font-weight:600}
.info a:hover{text-decoration:underline}
.powered{margin-top:1.5rem;font-size:.75rem;color:#475569}
.powered a{color:#64748b;text-decoration:none}
.powered a:hover{color:#94a3b8}
.x402-badge{display:inline-flex;align-items:center;gap:.35rem;background:#1a1a2e;border:1px solid #2d2d5e;padding:.25rem .75rem;border-radius:999px;font-size:.7rem;color:#818cf8;margin-top:.75rem;font-weight:500}
</style>
</head>
<body>
<div class="paywall">
  <h1>${config.title}</h1>
  <p class="desc">${description}</p>
  <div class="price-badge">$${price} USDC</div>
  <div class="chain">${chainName} network</div>
  ${endpointSection}
  <div class="info">
    <strong>How to access this endpoint:</strong><br><br>
    Use any x402-compatible client or SDK. The client handles wallet connection and payment automatically.<br><br>
    <code>npm install @dexterai/x402</code><br><br>
    <a href="${config.sdkUrl}">Learn more about x402 &rarr;</a>
  </div>
  <div class="powered">${config.branding}</div>
  <div class="x402-badge">x402 protocol</div>
</div>
</body>
</html>`;
}

/**
 * Create x402 browser support middleware.
 *
 * Wraps `res.json()` to intercept 402 Payment Required responses.
 * When the request is from a browser (Accept: text/html) and no
 * payment-signature header is present, renders a branded HTML paywall
 * instead of raw JSON.
 *
 * API clients are completely unaffected -- they receive normal JSON.
 *
 * @param config - Optional configuration
 * @returns Express middleware
 */
export function x402BrowserSupport(config: X402BrowserSupportConfig = {}): RequestHandler {
  const resolvedConfig = {
    title: config.title ?? 'Payment Required',
    branding: config.branding ?? 'Powered by <a href="https://x402.org">x402</a>',
    sdkUrl: config.sdkUrl ?? 'https://x402.org',
    showEndpoint: config.showEndpoint ?? true,
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const originalJson = res.json.bind(res);

    res.json = function (body: unknown) {
      // Only intercept 402 responses for browsers without a payment signature
      if (
        res.statusCode === 402 &&
        req.accepts('html') &&
        !req.headers['payment-signature']
      ) {
        const paymentRequired =
          (res.getHeader('PAYMENT-REQUIRED') as string) ||
          (res.getHeader('payment-required') as string);

        if (paymentRequired && typeof paymentRequired === 'string') {
          const html = generatePaywallHtml(
            paymentRequired,
            req.originalUrl,
            req.method,
            resolvedConfig,
          );
          res.status(402).type('html').send(html);
          return res;
        }
      }

      return originalJson(body);
    } as typeof res.json;

    next();
  };
}
