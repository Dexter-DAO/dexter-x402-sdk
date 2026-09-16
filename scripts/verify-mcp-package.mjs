#!/usr/bin/env node
// Run against an installed consumer using only package exports and local fixtures.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

async function qualify(mode) {
  const { default: assert } = await import('node:assert/strict');
  const { createRequire } = await import('node:module');
  const { join } = await import('node:path');
  const require = createRequire(join(process.cwd(), 'package.json'));
  const mcp = mode === 'esm' ? await import('@dexterai/x402/mcp') : require('@dexterai/x402/mcp');
  for (const name of ['createPaidMcpTool', 'createMcpFacilitatorProcessor', 'probeMcpTool',
    'callMcpToolWithPayment', 'attachMcpPayment', 'getMcpPaymentRequired', 'getMcpPaymentReceipt']) {
    assert.equal(typeof mcp[name], 'function', `${mode}: missing MCP export ${name}`);
  }
  const required = {
    x402Version: 2,
    resource: { url: 'mcp://fixture.test/report' },
    accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: 'fixture-token',
      payTo: 'fixture-seller', amount: '1', maxTimeoutSeconds: 60 }],
  };
  const challenge = mcp.createMcpPaymentRequiredResult(required);
  assert.deepEqual(mcp.getMcpPaymentRequired(challenge), required);
  assert.deepEqual(JSON.parse(challenge.content[0].text), required);
  const payment = { x402Version: 2, accepted: required.accepts[0], payload: { fixture: true } };
  const request = { name: 'report', arguments: { topic: 'fixture' }, _meta: { retained: true } };
  const receipt = { success: true, network: 'eip155:8453', transaction: 'fixture-transaction' };
  const response = { content: [{ type: 'text', text: 'fixture result' }],
    structuredContent: { retained: true },
    _meta: { retained: true, 'x402/payment-response': receipt } };
  let recorded = false;
  let calls = 0;
  const outcome = await mcp.callMcpToolWithPayment({
    request, paymentRequired: required, payment,
    beforeDispatch: async paid => {
      assert.deepEqual(paid._meta['x402/payment'], payment);
      recorded = true;
    },
    transport: async paid => {
      assert.equal(recorded, true);
      assert.equal(paid._meta.retained, true);
      calls++;
      return response;
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(outcome.result, response);
  assert.deepEqual(outcome.receipt, receipt);
  assert.equal(outcome.paymentStatus, 'seller_reported_settled');
  assert.equal(outcome.deliveryStatus, 'result_received');
  console.log(JSON.stringify({ mode, checks: ['MCP exports', 'challenge binding',
    'resource-less proof', 'durable dispatch hook', 'single dispatch', 'complete result and receipt'],
    scope: 'offline installed-package compatibility; no payment or settlement proof' }));
}

const consumer = resolve(process.argv[2] ?? process.cwd());
for (const mode of ['esm', 'cjs']) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `await (${qualify.toString()})(${JSON.stringify(mode)});`], { cwd: consumer, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
