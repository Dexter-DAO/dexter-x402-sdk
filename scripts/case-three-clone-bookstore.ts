#!/usr/bin/env node
// A persistent loopback wrapper around W2's actual books registrar and ledger.
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readKey } from './case-two-key.mjs';
import { runIdentity } from './seller-identity.mjs';
import { save } from './case-two-self-held.mjs';

const { values } = parseArgs({ options: {
  state: { type: 'string' }, api: { type: 'string' }, facilitator: { type: 'string' }, port: { type: 'string' },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('case-three-clone-bookstore.ts --state <clone/state.json> --api <W2-checkout> --facilitator <loopback-url> --port <unused-port>');
  process.exit(0);
}
for (const name of ['state', 'api', 'facilitator', 'port'] as const) if (!values[name]) throw new Error(`--${name} required`);
const api = realpathSync(values.api!);
if (existsSync(resolve(api, '.env')) || existsSync('.env')) throw new Error('production_env_forbidden');
const stateFile = resolve(values.state!), out = realpathSync(dirname(stateFile));
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const loopback = (value: string) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password) throw new Error('loopback_only');
};
loopback(state.rpc); loopback(values.facilitator!);
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_port');
const receivingPath = realpathSync(state.merchantKeyPath);
if (!receivingPath.startsWith(out + sep)) throw new Error('receiving_key_must_belong_to_clone');
let receiving: ReturnType<typeof readKey>;
try { receiving = readKey(receivingPath); }
catch { throw new Error('clone_receiving_key_invalid'); }
const seller = receiving.publicKey.toBase58(); receiving.secretKey.fill(0);
if (state.seller !== seller) throw new Error('clone_state_seller_differs_from_disposable_receiving_key');
const runtimeFile = resolve(out, 'books-store.json');
if (existsSync(runtimeFile)) throw new Error('books_store_run_already_exists');
const quotePath = resolve(out, 'books-quote.pkcs8');
const didPath = resolve(out, 'books-did.json');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const quotePrivate = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const quotePublicX = publicKey.export({ format: 'jwk' }).x!;
writeFileSync(quotePath, quotePrivate, { flag: 'wx', mode: 0o600 });
try {
  runIdentity(['document', '--did', 'did:web:dexter.cash', '--host', 'books.dexter.cash', '--name', 'Dexter Bookstore',
    '--receiving-key', receivingPath, '--quote-key', quotePath, '--quote-format', 'pkcs8-b64', '--kid', 'books-quote-1', '--out', didPath]);
} catch { throw new Error('clone_seller_document_generation_failed'); }

const apiRequire = createRequire(resolve(api, 'package.json'));
const express = apiRequire('express');
const { Client } = apiRequire('pg');
const password = randomUUID(), dockerName = `case-three-books-${randomUUID()}`;
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const docker = (...args: string[]) => {
  // Docker receives the disposable password through its environment, never argv.
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000, env: { ...process.env, POSTGRES_PASSWORD: password } });
  if (result.status !== 0) throw new Error(`docker_${args[0]}_failed ${result.error?.code ?? result.status}: ${String(result.stderr).replaceAll(password, '[redacted]').slice(-1500)}`);
  return result.stdout.trim();
};
let started = false, db: any, prisma: any, server: any, phase = 'database_start';
try {
  started = true;
  docker('run', '--pull=never', '--rm', '-d', '--name', dockerName, '--memory=512m', '--cpus=1',
    '--tmpfs', '/var/lib/postgresql/data:rw,size=268435456', '--env', 'POSTGRES_PASSWORD',
    '--env', 'POSTGRES_DB=case_three_books_disposable', '-p', '127.0.0.1::5432', 'postgres:17');
  let ready = false;
  for (let attempt = 0; attempt < 120 && !ready; attempt++) {
    const logs = spawnSync('docker', ['logs', dockerName], { encoding: 'utf8', timeout: 5000 });
    ready = `${logs.stdout}${logs.stderr}`.includes('PostgreSQL init process complete; ready for start up.')
      && spawnSync('docker', ['exec', dockerName, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore', timeout: 5000 }).status === 0;
    if (!ready) await wait(250);
  }
  if (!ready) throw new Error('disposable_postgres_not_ready');
  const dbPort = docker('port', dockerName, '5432/tcp').match(/:(\d+)$/)?.[1];
  if (!dbPort) throw new Error('disposable_postgres_port_missing');
  const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${dbPort}/case_three_books_disposable`;
  Object.assign(process.env, { DATABASE_URL: databaseUrl, NODE_ENV: 'test', SOLANA_RPC_ENDPOINT: state.rpc,
    HELIUS_RPC_URL: state.rpc, SOLANA_RPC_URL: state.rpc, X402_FACILITATOR_INTERNAL_URL: values.facilitator,
    X402_FACILITATOR_URL: values.facilitator, SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'disposable-unused',
    WALLET_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    DEXTER_INTERNAL_TOKEN: readFileSync(resolve(out, 'services/internal-token'), 'utf8').trim() });
  phase = 'database_schema';
  db = new Client({ connectionString: databaseUrl }); await db.connect();
  for (const migration of ['20260927213000_tab_seller_postgres_ledger', '20261029022000_bookstore_shelf_two_orders']) {
    await db.query(readFileSync(resolve(api, 'prisma/migrations', migration, 'migration.sql'), 'utf8'));
  }
  const { PrismaClient } = apiRequire('@prisma/client');
  prisma = new PrismaClient(); (globalThis as any).prisma = prisma;
  phase = 'ledger_initialization';
  const ledger = await import(pathToFileURL(resolve(api, 'src/services/tabSellerLedger.ts')).href);
  await ledger.importRedisTabSellerLedger(prisma, { generation: randomUUID(), snapshot: [], snapshotDigest: ledger.redisTabSnapshotDigest([]),
    writerFenceEvidenceDigest: createHash('sha256').update('disposable empty database has no other writers').digest('hex'),
    capturedAt: new Date(), writersStoppedAt: new Date(Date.now() - 1000) });
  phase = 'books_registration';
  const { registerBooksStoreRoutes } = await import(pathToFileURL(resolve(api, 'src/routes/booksStore.ts')).href);
  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: () => void) => {
    if (!(req.path === '/' || req.path === '/catalog' || req.path.startsWith('/books/'))) { res.sendStatus(404); return; }
    req.headers.host = 'books.dexter.cash';
    req.url = `/api/books-store${req.url}`;
    next();
  });
  registerBooksStoreRoutes(app, { seller, privateKey: quotePrivate, publicKeyX: quotePublicX });
  phase = 'http_listen';
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((done, reject) => { server.once('listening', done); server.once('error', reject); });
  const origin = `http://127.0.0.1:${port}`;
  const probe = await fetch(`${origin}/books/the-innovators-dilemma`, { signal: AbortSignal.timeout(10000) });
  if (probe.status !== 402) throw new Error('books_quote_not_ready');
  const body: any = await probe.json();
  if (!body.accepts?.some((accept: any) => accept.scheme === 'tab' && accept.payTo === seller)) throw new Error('books_quote_seller_mismatch');
  const runtime = { schema: 'case-three/clone-bookstore/v1', origin, seller, didFile: didPath, quotePublicX,
    catalog: `${origin}/catalog`, books: ['the-innovators-dilemma', 'the-sovereign-individual'].map(slug => `${origin}/books/${slug}`),
    pid: process.pid, createdAt: new Date().toISOString() };
  save(runtimeFile, runtime, true);
  state.booksStore = runtime; save(stateFile, state);
  console.log(JSON.stringify({ runtimeFile, ...runtime }));
  phase = 'serving';
  await new Promise<void>(done => { process.once('SIGINT', done); process.once('SIGTERM', done); });
} catch (error: any) {
  // Driver and crypto messages can carry inputs. Retain the operation and bounded code only.
  const code = /^[A-Za-z0-9_]+$/.test(error?.code ?? '') ? error.code : 'operation_failed';
  const detail = String(error?.message ?? 'operation failed').replaceAll(password, '[redacted]')
    .replaceAll(quotePrivate, '[redacted]').replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[redacted database URL]');
  console.error(`clone bookstore ${phase} failed: ${code}: ${detail}`);
  process.exitCode = 1;
} finally {
  const closed = await Promise.allSettled([
    ...(server ? [new Promise<void>(done => server.close(() => done()))] : []),
    ...(prisma ? [prisma.$disconnect()] : []), ...(db ? [db.end()] : []),
  ]);
  if (closed.some(result => result.status === 'rejected')) { console.error('clone bookstore client cleanup failed'); process.exitCode = 1; }
  if (started) {
    try { docker('rm', '--force', dockerName); }
    catch { console.error('clone bookstore container cleanup failed'); process.exitCode = 1; }
  }
}
// API modules may retain background clients; this standalone harness owns the process.
process.exit(process.exitCode ?? 0);
