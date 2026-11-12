import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReservationFence } from './case-two-reservation.mjs';

function input() {
  return { idempotencyKey: 'native-tab-v2:123', voucherDigest: '123', buyerSwigAddress: 'swig', vaultPda: 'vault', seller: 'seller',
    channelId: 'channel', reservationAmountAtomic: '1000000', voucher: {
      sessionPublicKey: new Uint8Array(32), sessionSignature: new Uint8Array(64), sessionRegistration: new Uint8Array(188),
      payload: { cumulativeAmount: '1000000', sequenceNumber: 2147483649 },
    } };
}

test('ambiguous dispatch retries persisted request without a new operation or receipt identity', async () => {
  const journal = new Map();
  const sent = [];
  const fence = createReservationFence({ facilitatorUrl: 'https://facilitator.test', internalToken: 'secret',
    readRecord: async key => journal.get(key), writeRecord: async (key, value) => journal.set(key, value),
    fetchImpl: async (url, options) => {
      assert.ok(journal.get('native-tab-v2:123'), 'request must be durable before dispatch');
      assert.equal(options.redirect, 'error');
      sent.push(options.body);
      if (sent.length === 1) throw new Error('connection lost after dispatch');
      return new Response(JSON.stringify({ armed: true, receipt: { transaction: 'reserved' } }), { status: 200 });
    },
  });
  await assert.rejects(fence(input()), /connection lost/);
  assert.deepEqual(await fence(input()), { transaction: 'reserved' });
  assert.equal(sent[0], sent[1]);
});

test('changed voucher under the same journal identity is refused before dispatch', async () => {
  let record;
  let calls = 0;
  const fence = createReservationFence({ facilitatorUrl: 'https://facilitator.test', internalToken: 'secret',
    readRecord: async () => record, writeRecord: async (_key, value) => { record = value; },
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: 'pending' }), { status: 202 }); },
  });
  await assert.rejects(fence(input()), /reservation_not_armed/);
  const changed = input(); changed.voucher.payload.cumulativeAmount = '2000000';
  await assert.rejects(fence(changed), /journal_identity_conflict/);
  assert.equal(calls, 1);
});
