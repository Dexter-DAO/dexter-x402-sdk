/**
 * Extension registry — runs resource-server extensions while a 402
 * PaymentRequired response is being built and collects their outputs.
 */

import type { ResourceServerExtension, PaymentRequiredContext } from './types';

/**
 * Run each registered extension's `enrichPaymentRequiredResponse` hook and
 * collect the results into an object keyed by extension `key`.
 *
 * - An extension with no `enrichPaymentRequiredResponse` hook is skipped.
 * - An extension with no entry in `declarations` is skipped (nothing to do).
 * - An extension whose hook returns `undefined` contributes no key.
 * - An extension whose hook throws is caught, logged, and skipped — a
 *   broken extension degrades the 402 to bare-but-valid, never throws.
 *
 * @returns the assembled `extensions` object, or `undefined` when nothing
 *   was produced (so the caller omits the `extensions` key entirely).
 */
export async function applyExtensions(
  extensions: ResourceServerExtension[],
  declarations: Record<string, unknown>,
  context: PaymentRequiredContext,
): Promise<Record<string, unknown> | undefined> {
  const collected: Record<string, unknown> = {};

  for (const ext of extensions) {
    if (!ext.enrichPaymentRequiredResponse) continue;
    if (!(ext.key in declarations)) continue;
    try {
      const result = await ext.enrichPaymentRequiredResponse(
        declarations[ext.key],
        context,
      );
      if (result !== undefined) {
        collected[ext.key] = result;
      }
    } catch (e) {
      console.warn(`[x402:extensions] extension "${ext.key}" failed:`, e);
    }
  }

  return Object.keys(collected).length > 0 ? collected : undefined;
}
