import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertCloneState, approveCloneGrant } from './case-three-clone-approve.mjs';

function state(out, rpc = 'http://127.0.0.1:27899') {
  return { out, rpc, feePayerKeyPath: join(out, 'feePayer.json'), authorityKeyPath: join(out, 'authority.json'),
    softwareOwnerPath: join(out, 'owner.json') };
}

test('clone approval rejects remote endpoints before opening a private key', async t => {
  const out = mkdtempSync(join(tmpdir(), 'case-three-approve-'));
  t.after(() => rmSync(out, { recursive: true }));
  const file = join(out, 'state.json');
  writeFileSync(file, JSON.stringify(state(out, 'https://api.mainnet-beta.solana.com')));
  await assert.rejects(approveCloneGrant({ state: file, grant: join(out, 'missing-grant.json') }), /only loopback/);
});

test('clone approval requires generated key paths beside its state file', () => {
  const out = '/disposable-clone';
  const valid = state(out);
  assertCloneState(valid, join(out, 'state.json'));
  assert.throws(() => assertCloneState({ ...valid, softwareOwnerPath: '/outside/owner.json' }, join(out, 'state.json')), /generated files/);
  assert.throws(() => assertCloneState({ ...valid, rpc: 'http://user:secret@localhost:27899' }, join(out, 'state.json')), /only loopback/);
});
