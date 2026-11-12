#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBytes, parseCanonical, parseSellerDocument, verifyAddressProofs } from '../dist/seller/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'seller-identity-test-'));
const checks = [];
function invoke(args, succeeds = true) {
  const result = spawnSync(process.execPath, [join(root, 'scripts/seller-identity.mjs'), ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status === 0, succeeds, result.stderr);
  if (!succeeds) { assert.equal(result.stdout, ''); return result; }
  return JSON.parse(result.stdout);
}
try {
  for (const format of ['pkcs8-b64', 'jwk']) {
    const receiving = join(directory, `${format}-receiving.json`);
    const quote = join(directory, `${format}-quote.key`);
    const out = join(directory, `${format}-did.json`);
    const keyArgs = ['keys', '--receiving-out', receiving, '--quote-out', quote, '--quote-format', format];
    const keys = invoke(keyArgs);
    assert.deepEqual(Object.keys(keys).sort(), ['quotePublicX', 'receivingAddress']);
    for (const path of [receiving, quote]) assert.equal(statSync(path).mode & 0o777, 0o600);
    checks.push(`${format}: public-only output and mode 600`);
    const original = readFileSync(receiving);
    invoke(keyArgs, false);
    assert.deepEqual(readFileSync(receiving), original);
    const uncreated = join(directory, `${format}-partial.json`);
    invoke(['keys', '--receiving-out', uncreated, '--quote-out', quote, '--quote-format', format], false);
    assert.equal(existsSync(uncreated), false);
    checks.push(`${format}: overwrite and partial-output refusal`);

    const args = ['document', '--did', 'did:web:dexter.cash', '--host', 'books.dexter.cash',
      '--host', 'shop.dexter.cash', '--name', 'Dexter Bookstore', '--receiving-key', receiving,
      '--quote-key', quote, '--quote-format', format, '--kid', 'books-quote-1', '--out', out];
    const output = invoke(args);
    assert.equal(output.receivingAddress, keys.receivingAddress);
    assert.equal(output.quotePublicX, keys.quotePublicX);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    const bytes = new Uint8Array(readFileSync(out));
    assert.equal(output.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(canonicalBytes(parseCanonical(bytes)), bytes);
    assert.notEqual(bytes.at(-1), 10);
    const parsed = parseSellerDocument(bytes, 'did:web:dexter.cash');
    assert.equal(typeof parsed, 'object');
    assert.deepEqual(parsed.profiles[0].hosts, ['books.dexter.cash', 'shop.dexter.cash']);
    assert.equal(verifyAddressProofs(parsed.profiles[0], parsed.doc.id), true);
    checks.push(`${format}: canonical document parses and address proof verifies`);
    invoke(args, false);
    assert.deepEqual(new Uint8Array(readFileSync(out)), bytes);
    checks.push(`${format}: document overwrite refused`);
    const invalid = [...args]; invalid[invalid.indexOf('Dexter Bookstore')] = 'Non-ASCII é';
    invalid[invalid.length - 1] = join(directory, `${format}-invalid.json`);
    invoke(invalid, false);
    assert.equal(existsSync(invalid.at(-1)), false);
    const badReceiving = join(directory, `${format}-bad.json`);
    const badKey = JSON.parse(readFileSync(receiving, 'utf8')); badKey[63] ^= 1;
    writeFileSync(badReceiving, JSON.stringify(badKey), { mode: 0o600 });
    const invalidKeyArgs = [...invalid]; invalidKeyArgs[invalidKeyArgs.indexOf(receiving)] = badReceiving;
    invoke(invalidKeyArgs, false);
    checks.push(`${format}: invalid document and mismatched receiving key refused`);
    console.log(JSON.stringify({ format, ...output, checks: 5 }));
  }
  console.log(JSON.stringify({ verified: true, checks: checks.length, names: checks, scope: 'throwaway keys and offline document proof only' }));
} finally { rmSync(directory, { recursive: true, force: true }); }
