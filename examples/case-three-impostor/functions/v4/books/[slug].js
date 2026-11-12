import { paymentRequired } from '../../../lib/payment.js';
export const onRequest = context => paymentRequired(context, 'V4');
