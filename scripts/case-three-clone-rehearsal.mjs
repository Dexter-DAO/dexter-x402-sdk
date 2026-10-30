#!/usr/bin/env node
// Runs the whole local sequence under the caller's shared heavy-command lock.
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

const { values: v } = parseArgs({ options: Object.fromEntries(['out', 'consumer', 'api', 'facilitator-source', 'fixtures', 'validator', 'read-rpc-file', 'pin-env'].map(k => [k, { type: 'string' }])) });
for (const name of ['out', 'consumer', 'api', 'facilitator-source', 'fixtures', 'validator', 'read-rpc-file', 'pin-env']) if (!v[name]) throw new Error(`--${name} required`);
const scripts = dirname(fileURLToPath(import.meta.url)), out = resolve(v.out), consumer = resolve(v.consumer);
const node = process.execPath, facilitator = resolve(v['facilitator-source']);
const rpc = 'http://127.0.0.1:27899', facilitatorUrl = 'http://127.0.0.1:27901';
// RPC+3 is the validator's faucet; keep the book server outside that port.
const local = 'http://127.0.0.1:27905', statePath = join(out, 'state.json');
mkdirSync(out, { mode: 0o700 });
const consumerScripts = join(consumer, 'scripts'); mkdirSync(consumerScripts, { recursive: true, mode: 0o700 });
for (const file of ['case-two-key.mjs', 'case-two-self-held.mjs', 'case-two-reservation.mjs', 'case-two-refusal.mjs', 'case-two-clone.mjs',
  'case-three-self-held.mjs', 'case-three-seller-tools.mjs', 'case-three-refusal.mjs', 'case-three-clone-approve.mjs']) copyFileSync(join(scripts, file), join(consumerScripts, file));
const consumerRequire = createRequire(join(consumer, 'package.json'));
const { Connection, Keypair, PublicKey } = consumerRequire('@solana/web3.js');
const { getAssociatedTokenAddressSync } = consumerRequire('@solana/spl-token');
const pause = ms => new Promise(done => setTimeout(done, ms));
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const command = (file, args, cwd = consumer) => {
  const result = spawnSync(node, [file, ...args], { cwd, encoding: 'utf8', timeout: 240000 });
  if (result.status !== 0) throw new Error(`${file.split('/').at(-1)} failed; ${result.stderr.slice(-4000)}`);
  // Child stdout is public evidence. Private validator/HTTP logs stay in the run directory.
  if (result.stdout.trim()) console.log(result.stdout.trim());
};
const cli = (name, args) => command(join(consumerScripts, name), args);
const c3 = args => cli('case-three-self-held.mjs', args);
const waitForFile = async (file, child) => {
  for (let n = 0; n < 120; n++) {
    if (child.exitCode !== null) throw new Error('owned clone service exited; inspect its private log');
    try { return read(file); } catch {}
    await pause(500);
  }
  throw new Error('owned clone service readiness timed out');
};
const start = (file, args, cwd, log) => spawn(node, [file, ...args], { cwd, stdio: ['ignore', openSync(log, 'ax', 0o600), openSync(`${log}.stderr`, 'ax', 0o600)] });
let service, bookstore, failure;
try {
  cli('case-two-clone.mjs', ['boot', '--out', out, '--port', '27899', '--fixtures', resolve(v.fixtures), '--validator', resolve(v.validator), '--mainnet-rpc-file', resolve(v['read-rpc-file'])]);
  cli('case-two-clone.mjs', ['birth', '--out', out]);
  const state = read(statePath);
  command(join(facilitator, 'node_modules/tsx/dist/cli.mjs'), [join(facilitator, 'scripts/case-two-clone-pin.ts'), '--state', statePath,
    '--template-env', resolve(v['pin-env']), '--out', join(out, 'clone-release.env')], facilitator);
  service = start(join(facilitator, 'node_modules/tsx/dist/cli.mjs'), [join(facilitator, 'scripts/case-two-clone-service.ts'), '--state', statePath,
    '--release-env', join(out, 'clone-release.env'), '--seller-sdk', consumer, '--port', '27901'], facilitator, join(out, 'facilitator.log'));
  for (let n = 0; n < 120; n++) {
    if (service.exitCode !== null) throw new Error('clone facilitator startup failed; inspect its private log');
    try { if ((await fetch(`${facilitatorUrl}/supported`)).ok) break; } catch {}
    await pause(500);
    if (n === 119) throw new Error('clone facilitator readiness timed out');
  }
  bookstore = start(join(resolve(v.api), 'node_modules/tsx/dist/cli.mjs'), [join(scripts, 'case-three-clone-bookstore.ts'), '--state', statePath,
    '--api', resolve(v.api), '--facilitator', facilitatorUrl, '--port', '27905'], resolve(v.api), join(out, 'bookstore.log'));
  const books = await waitForFile(join(out, 'books-store.json'), bookstore);
  const grant = join(out, 'grant.json'), key = join(out, 'agent.json');
  const canonical = slug => `https://books.dexter.cash/books/${slug}`;
  c3(['request', '--merchant', state.seller, '--seller-url', canonical('the-innovators-dilemma'), '--endpoint', `${local}/books/the-innovators-dilemma`,
    '--did-file', books.didFile, '--cap', '3', '--revolving', '1.50', '--max-single', '1.50', '--expiry-rule', '2.5h', '--key', key, '--grant', grant]);
  cli('case-three-clone-approve.mjs', ['--state', statePath, '--grant', grant]);
  const catalog = await (await fetch(`${local}/catalog`)).json();
  const slugs = ['the-innovators-dilemma', 'the-sovereign-individual'];
  for (const [i, slug] of slugs.entries()) {
    const item = catalog.items.find(item => item.productId === `book:${slug}`);
    if (!item || item.fulfillment !== 'demonstration') throw new Error('expected chosen demonstration edition');
    const body = { catalogVersion: catalog.catalogVersion, orderId: randomUUID(), productId: item.productId, editionId: item.editionId,
      quantity: 1, asset: 'USDC', totalAmountAtomic: '1000000', fulfillment: item.fulfillment };
    writeFileSync(join(out, `order-${i + 1}.json`), JSON.stringify(body), { flag: 'wx', mode: 0o600 });
    c3(['buy', '--check-seller', ...(i === 0 ? ['--pay-claim'] : ['--hold-settlement', '--no-hold']), '--grant', grant, '--vault', state.vault,
      '--rpc', rpc, '--facilitator', facilitatorUrl, '--seller-url', canonical(slug), '--endpoint', `${local}/books/${slug}`, '--did-file', books.didFile,
      '--body', join(out, `order-${i + 1}.json`), '--reason', `Record ${slug} demonstration edition. No text and no shipment.`,
      '--receipt', join(out, `purchase-${i + 1}.json`), '--env-file', join(out, 'services/facilitator.env')]);
  }
  const impostor = Keypair.generate().publicKey.toBase58(), claim = read(join(out, 'purchase-2.json')).claim.address;
  writeFileSync(join(out, 'impostor.json'), JSON.stringify({ address: impostor }), { flag: 'wx', mode: 0o600 });
  const refusal = (kind, flags, amount) => cli('case-three-refusal.mjs', ['--send', '--rpc', rpc, '--vault', state.vault,
    '--seller', kind === 'no-permission' ? impostor : state.seller, '--kind', kind, '--authority-key', state.authorityKeyPath,
    '--fee-payer-key', state.feePayerKeyPath, '--receipt', join(out, `${kind}.json`), ...(amount ? ['--agent-key', key, '--amount', amount] : []), ...flags]);
  refusal('payout-redirect', ['--claim', claim, '--redirect-to', impostor, '--env', join(out, 'services/facilitator.env')]);
  c3(['settle-held', '--no-hold', '--claim', claim, '--grant', grant, '--receipt', join(out, 'purchase-2.json'), '--payout', join(out, 'payout-2.json'),
    '--facilitator', facilitatorUrl, '--rpc', rpc, '--env-file', join(out, 'services/facilitator.env')]);
  refusal('no-permission', ['--approved-seller', state.seller], '1000000');
  refusal('over-limit', [], '1500000');
  // Retain the successful money leg before the expiry restart creates another ledger.
  const connection = new Connection(rpc, 'finalized');
  const mint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const balances = {};
  for (const [name, owner] of [['buyer', state.wallet], ['store', state.seller], ['treasury', read(join(out, 'services/treasury.json')).publicKey]]) {
    const ata = getAssociatedTokenAddressSync(mint, new PublicKey(owner), true);
    balances[name] = { account: ata.toBase58(), amountAtomic: (await connection.getTokenAccountBalance(ata, 'finalized')).value.amount };
  }
  if (balances.buyer.amountAtomic !== '8000000' || balances.store.amountAtomic !== '1980000' || balances.treasury.amountAtomic !== '20000') throw new Error('two-book token balances differ from gross and 100bps clone fee');
  writeFileSync(join(out, 'balances.json'), JSON.stringify({ schema: 'case-three/clone-balances/v1', ...balances }), { flag: 'wx', mode: 0o600 });
  const approval = read(`${grant}.approval.json`), signatures = new Set([state.preparationTx, state.birthTx, approval.registerTx, approval.lookupTable.transaction]);
  for (let n = 1; n <= 2; n++) {
    const journal = read(join(out, `purchase-${n}.json`));
    for (const signature of [journal.reservationReceipt.transaction, journal.claim.lockSignature, journal.claim.payoutSignature]) if (signature) signatures.add(signature);
  }
  for (const kind of ['no-permission', 'payout-redirect', 'over-limit']) signatures.add(read(join(out, `${kind}.json`)).transactionSignature);
  mkdirSync(join(out, 'transactions'), { mode: 0o700 });
  const archive = async signature => {
    let tx;
    for (let n = 0; n < 120; n++) {
      tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
      if (tx) break;
      await pause(250);
    }
    if (!tx) throw new Error('clone transaction not finalized before archival');
    const meta = Object.fromEntries(['err', 'fee', 'logMessages', 'preTokenBalances', 'postTokenBalances', 'loadedAddresses', 'preBalances', 'postBalances'].map(key => [key, tx.meta?.[key]]));
    writeFileSync(join(out, 'transactions', `${signature}.json`), JSON.stringify({ schema: 'case-three/chain-transaction/v1', signature,
      slot: tx.slot, blockTime: tx.blockTime, meta, messageBase64url: Buffer.from(tx.transaction.message.serialize()).toString('base64url'),
      signatures: tx.transaction.signatures }), { flag: 'wx', mode: 0o600 });
  };
  for (const signature of signatures) await archive(signature);
  const compiled = spawnSync('cc', ['-shared', '-fPIC', '-O2', join(scripts, 'case-two-clone-clock.c'), '-o', join(out, 'clone-clock.so')], { encoding: 'utf8' });
  if (compiled.status !== 0) throw new Error('clone clock shim compile failed');
  cli('case-two-clone.mjs', ['advance-time', '--out', out, '--seconds', '14400', '--clock-library', join(out, 'clone-clock.so')]);
  refusal('expired', [], '1000000');
  await archive(read(join(out, 'expired.json')).transactionSignature);
  writeFileSync(join(out, 'rehearsal-complete.json'), JSON.stringify({ schema: 'case-three/clone-rehearsal/v1', completedAt: new Date().toISOString(),
    vault: state.vault, seller: state.seller, impostor, cloneOnly: true, redisHoldExercised: false }), { flag: 'wx', mode: 0o600 });
} catch (error) { failure = error; throw error; }
finally {
  for (const child of [bookstore, service]) if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(done => child.once('exit', done));
  }
  if (existsSync(statePath) && read(statePath).validatorPid) {
    try { cli('case-two-clone.mjs', ['stop', '--out', out]); }
    catch (error) { if (!failure) throw error; console.error('Owned validator cleanup failed; inspect saved PID before recovery'); }
  }
}
