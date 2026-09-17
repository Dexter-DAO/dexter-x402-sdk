/** Capabilities of the per-request builders, shared by selection and signing. */
interface ExactPaymentOption {
  scheme?: string;
  extra?: Record<string, unknown>;
}

export function exactPaymentCapabilityError(
  option: ExactPaymentOption,
  family: 'evm' | 'svm',
): string | undefined {
  const scheme = option.scheme ?? 'exact';
  if (scheme !== 'exact' && !(family === 'evm' && scheme === 'exact-approval')) {
    return `Unsupported payment scheme: ${scheme}`;
  }
  const flow = option.extra?.paymentFlow;
  if (flow !== undefined && flow !== 'authorization') {
    return `Unsupported payment flow: ${String(flow)}`;
  }
  const method = option.extra?.assetTransferMethod;
  // The legacy approval builder has its own wire format. It does not honor
  // EIP-3009 or Permit2 labels, even though those work with scheme exact.
  const methods = scheme === 'exact-approval' ? []
    : family === 'evm' ? ['eip3009', 'permit2'] : ['default'];
  if (method !== undefined && (typeof method !== 'string' || !methods.includes(method))) {
    return `Unsupported payment asset transfer method: ${String(method)}`;
  }
  return undefined;
}

/** Optional extensions remain available; this client cannot satisfy required identifiers. */
export function requiresPaymentIdentifier(extensions: Record<string, unknown> | undefined): boolean {
  const identifier = extensions?.['payment-identifier'];
  if (!identifier || typeof identifier !== 'object' || Array.isArray(identifier)) return false;
  const info = (identifier as Record<string, unknown>).info;
  return !!info && typeof info === 'object' && !Array.isArray(info)
    && (info as Record<string, unknown>).required === true;
}
