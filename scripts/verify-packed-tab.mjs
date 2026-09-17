#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const requestedProof = process.env.DEXTER_X402_PACKAGE_PROOF_DIR;
const proof = requestedProof ? resolve(requestedProof) : mkdtempSync(join(tmpdir(), 'dexter-x402-tab-package-'));
if (requestedProof) {
  if (!existsSync(proof)) mkdirSync(proof, { recursive: true });
  if (readdirSync(proof).length !== 0) throw new Error('DEXTER_X402_PACKAGE_PROOF_DIR must be empty');
}
const consumer = join(proof, 'consumer');
mkdirSync(consumer);
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} failed with exit ${result.status}`);
  }
  return result.stdout;
}

// A pre-publication Vault artifact can be supplied explicitly. Its installed
// version must still match the exact peer contract in the release manifest.
const vault = process.argv[2] ? resolve(process.argv[2]) : `@dexterai/vault@${manifest.peerDependencies['@dexterai/vault']}`;
const coreMinimum = manifest.dependencies['@dexterai/x402-core'].match(/^\^(\d+\.\d+\.\d+)$/)?.[1];
if (!coreMinimum) throw new Error('x402-core dependency must declare an explicit caret minimum');
const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', proof], root, true))[0];
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(proof, packed.filename), vault,
  `@dexterai/x402-core@${coreMinimum}`], consumer);
for (const name of ['@dexterai/x402', '@dexterai/vault']) {
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8'));
  const expected = name === manifest.name ? manifest.version : manifest.peerDependencies[name];
  if (installed.version !== expected) throw new Error(`${name}: expected ${expected}, found ${installed.version}`);
}
run(process.execPath, [join(root, 'scripts/verify-client-package.mjs'), consumer, coreMinimum], root);
run(process.execPath, [join(root, 'scripts/verify-tab-package.mjs'), consumer], root);
run(process.execPath, [join(root, 'scripts/verify-mcp-package.mjs'), consumer], root);
writeFileSync(join(proof, 'proof.json'), JSON.stringify({
  sourceCommit: run('git', ['rev-parse', 'HEAD'], root, true).trim(),
  package: packed, vault, consumer, coreMinimum,
  scope: 'Installed ESM/CJS client, Tab and MCP compatibility at the declared core minimum; local fixtures only',
}, null, 2) + '\n');
console.log(`Package proof: ${join(proof, 'proof.json')}`);
