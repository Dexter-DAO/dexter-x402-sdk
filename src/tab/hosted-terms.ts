/**
 * Hosted-v1 commercial semantics advertised by the default Tab scheme.
 * A different refund/dispute or delivery rule requires a new terms version;
 * callers must never reinterpret these strings in place.
 */
export const HOSTED_TAB_TERMS_VERSION =
  'dexter-tab-hosted-pay-before-delivery/v1' as const;

export const HOSTED_TAB_ACCEPTANCE_RULE =
  'pay_before_delivery_seller_2xx' as const;

export const HOSTED_TAB_VOUCHER_HEADER = 'x-tab-voucher' as const;

export const HOSTED_TAB_REGISTRATION_ENCODING =
  'base64(188-byte sessionRegisterMessage)' as const;
