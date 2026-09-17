#!/usr/bin/env node
// Exercise the published client entrypoint in an installed consumer.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

async function qualify(mode, expectedCoreVersion) {
  const { default: assert } = await import('node:assert/strict');
  const { createRequire } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  globalThis.fetch = async () => { throw new Error('Network access forbidden in client import qualification'); };
  const require = createRequire(join(process.cwd(), 'package.json'));
  const client = mode === 'esm' ? await import('@dexterai/x402/client') : require('@dexterai/x402/client');
  // Resolve through the SDK so a nested dependency cannot hide a stale floor.
  const sdkRequire = createRequire(require.resolve('@dexterai/x402/client'));
  const coreEntry = sdkRequire.resolve('@dexterai/x402-core');
  const core = JSON.parse(readFileSync(join(dirname(coreEntry), '..', 'package.json'), 'utf8'));
  assert.equal(core.name, '@dexterai/x402-core');
  if (expectedCoreVersion) assert.equal(core.version, expectedCoreVersion);
  for (const name of ['payAndFetch', 'createKeypairWallet', 'createSolanaAdapter',
    'capturePaymentReceipt', 'getPaymentReceipt', 'capabilitySearch']) {
    assert.equal(typeof client[name], 'function', `${mode}: missing client export ${name}`);
  }
  assert.equal(typeof client.SOLANA_MAINNET, 'string');
  console.log(JSON.stringify({ mode, coreVersion: core.version,
    checks: ['installed client entrypoint', 'public client exports'],
    scope: 'package imports only; no signing, network request or payment' }));
}

const consumer = resolve(process.argv[2] ?? process.cwd());
const expectedCoreVersion = process.argv[3] ?? null;
for (const mode of ['cjs', 'esm']) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `await (${qualify.toString()})(${JSON.stringify(mode)}, ${JSON.stringify(expectedCoreVersion)});`],
  { cwd: consumer, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
