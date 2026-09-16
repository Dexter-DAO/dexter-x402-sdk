#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const proof = mkdtempSync(join(tmpdir(), 'dexter-x402-tab-package-'));
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
const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', proof], root, true))[0];
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(proof, packed.filename), vault], consumer);
for (const name of ['@dexterai/x402', '@dexterai/vault']) {
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8'));
  const expected = name === manifest.name ? manifest.version : manifest.peerDependencies[name];
  if (installed.version !== expected) throw new Error(`${name}: expected ${expected}, found ${installed.version}`);
}
run(process.execPath, [join(root, 'scripts/verify-tab-package.mjs'), consumer], root);
writeFileSync(join(proof, 'proof.json'), JSON.stringify({
  sourceCommit: run('git', ['rev-parse', 'HEAD'], root, true).trim(),
  package: packed, vault, consumer,
  scope: 'Installed ESM/CJS Tab compatibility with local fixtures; no payment or deployment proof',
}, null, 2) + '\n');
console.log(`Package proof: ${join(proof, 'proof.json')}`);
