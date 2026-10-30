#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const consumer = process.argv[2] ? resolve(process.argv[2]) : root;
const require = createRequire(join(consumer, 'package.json'));
const packageEntry = require.resolve('@dexterai/x402/seller');
const distEntry = join(dirname(packageEntry), 'index.js');
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const sourceImports = new Set();

function forbidden(path) {
  const normalized = path.replace(/\\/g, '/');
  return normalized.startsWith('node:') || builtins.has(normalized) ||
    /(?:^|\/node_modules\/)@x402\//.test(normalized) ||
    /(?:^|\/node_modules\/)@solana\/web3\.js(?:\/|$)/.test(normalized) ||
    /^@dexterai\/x402\/(?:client|server|tab)(?:\/|$)/.test(normalized) ||
    /(?:^|\/)(?:src|dist)\/(?:client|server|tab)(?:\/|$)/.test(normalized);
}

// Inspect the source graph as well: tsup may have inlined an internal module.
const result = await build({
  absWorkingDir: root,
  entryPoints: { artifact: distEntry, source: join(root, 'src/seller/index.ts') },
  outdir: join(root, '.seller-package-check'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  write: false,
  metafile: true,
  plugins: [{
    name: 'seller-boundaries',
    setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, (args) => {
        const resolved = args.path.startsWith('.') ? resolve(args.resolveDir, args.path) : args.path;
        if (forbidden(args.path) || forbidden(resolved)) {
          return { errors: [{ text: `seller imports forbidden module: ${args.path}` }] };
        }
        if (args.kind !== 'entry-point' && !args.path.startsWith('.') && !args.path.startsWith('/')) {
          sourceImports.add(args.path);
        }
      });
    },
  }],
});
for (const path of Object.keys(result.metafile.inputs)) {
  assert.equal(forbidden(path), false, `forbidden seller input: ${path}`);
}
const imports = [...new Set(Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((entry) => entry.path)))].sort();
assert.deepEqual(imports, [], 'browser seller bundle must be self-contained');

const publicEsm = await import(pathToFileURL(distEntry).href);
const publicCjs = require('@dexterai/x402/seller');
const mechanics = [
  'canonicalBytes', 'parseCanonical', 'verifyEd25519Strict', 'jwkThumbprint', 'ed25519JwkToBytes',
  'decodeCompactJws', 'decodeOfferPayload', 'parseSellerUrl', 'parseDidWebKid', 'registrableDomainOf',
  'displayHost', 'hostLookalike', 'normalizeSellerName', 'nameMatches', 'defaultFetchDidDocument',
  'parseSellerDocument', 'profileForHost', 'addressProofMessage', 'verifyAddressProofs', 'addressListSha256',
  'sellerOfferFromPaymentRequired', 'sellerBindingNonce', 'newSellerBindingSalt',
];
for (const [mode, api] of [['esm', publicEsm], ['cjs', publicCjs]]) {
  for (const name of mechanics) assert.equal(typeof api[name], 'function', `${mode}: missing seller export ${name}`);
  const bytes = api.canonicalBytes({ z: 2, a: 1 });
  assert.equal(new TextDecoder().decode(bytes), '{"a":1,"z":2}');
  assert.equal(api.sellerBindingNonce(bytes, new Uint8Array(32)).length, 32);
}
const esmProbe = spawnSync(process.execPath, ['--input-type=module', '--eval', `
  import * as seller from '@dexterai/x402/seller';
  for (const name of ${JSON.stringify(mechanics)}) {
    if (typeof seller[name] !== 'function') throw new Error('missing ESM seller export: ' + name);
  }
`], { cwd: consumer, encoding: 'utf8' });
if (esmProbe.error) throw esmProbe.error;
assert.equal(esmProbe.status, 0, esmProbe.stderr);
console.log(JSON.stringify({
  entry: distEntry,
  imports,
  sourceImports: [...sourceImports].sort(),
  modes: ['esm', 'cjs'],
  scope: 'Browser dependency boundaries and offline seller mechanics exports',
}, null, 2));
