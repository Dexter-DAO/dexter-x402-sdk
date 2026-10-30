#!/usr/bin/env node
// Reads the existing W7 test wallet and consent screens. It never clicks an action.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { save } from './case-two-self-held.mjs';

const { values } = parseArgs({ options: { harness: { type: 'string' }, links: { type: 'string' }, grant: { type: 'string' },
  out: { type: 'string' }, help: { type: 'boolean', default: false } } });
if (values.help) {
  console.log('case-three-screens.ts --harness <W6-checkout> --out <new-directory> (--links <copycat-directory> | --grant <grant-file>)');
  process.exit(0);
}
if (!values.harness || !values.out || !!values.links === !!values.grant) throw new Error('Require --harness, --out and exactly one of --links or --grant');
const harness = resolve(values.harness);
const required = createRequire(resolve(harness, 'package.json'));
const { chromium } = required('@playwright/test');
const { loadGuestWallet, openConsent, readConsentScreen } = await import(pathToFileURL(resolve(harness, 'tests/e2e/harness/consentHarness.ts')).href);
const identity = '/home/branchmanager/.local/share/dexter-case-three-test-wallet/identity.json';
const records = values.links ? ['V1', 'V2', 'V3', 'V4', 'V5'].map(variant => ({ variant,
  path: resolve(values.links!, `${variant}.json`), ...JSON.parse(readFileSync(resolve(values.links!, `${variant}.json`), 'utf8')) }))
  : [{ variant: 'approval', path: resolve(values.grant!), ...JSON.parse(readFileSync(values.grant!, 'utf8')) }];
mkdirSync(values.out, { mode: 0o700 });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Enforce the dry-run boundary even if the page ever tries to submit automatically.
  await context.route('**/*', async (route: any) => {
    const request = route.request(), url = new URL(request.url());
    let method: string | undefined;
    try { method = request.postDataJSON()?.method; } catch {}
    if ((request.method() !== 'GET' && /\/sign\/|\/grants\/register|\/sessions\/revoke/.test(url.pathname))
      || method === 'sendTransaction') return route.abort('blockedbyclient');
    return route.continue();
  });
  const page = await context.newPage();
  await loadGuestWallet(page, identity);
  const started = Date.now();
  for (const record of records) {
    const timestamp = Math.floor(Date.now() / 1000);
    if (values.links && (record.schema !== 'case-three/copycat-link/v1' || timestamp - record.generatedAt > 300
      || record.validUntil !== null && record.validUntil <= timestamp || Date.now() - started > 300000)) throw new Error(`${record.variant}: quote is not fresh for five-minute capture`);
    const consentUrl = record.consentUrl ?? `https://dexter.cash/tabs/new?req=${Buffer.from(JSON.stringify(record.request)).toString('base64url')}`;
    await openConsent(page, consentUrl);
    const reading = await readConsentScreen(page);
    const text = await page.locator('main').innerText();
    const screenshotPath = resolve(values.out, `${record.variant}.png`);
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true });
    chmodSync(screenshotPath, 0o600);
    const check = record.variant === 'approval'
      ? reading.sellerHost === 'books.dexter.cash' && /first payment/i.test(reading.sellerRelation ?? '')
        && /new key/i.test(reading.agentRelation ?? '') && /Calls itself "Claude"/.test(reading.agentClaim ?? '')
      : record.expected.approve === 'refused'
        ? !reading.hasApprove && reading.refusal?.rule === record.expected.rule && reading.refusal?.code === record.expected.code
        : reading.hasConfirm && reading.notices.some((notice: any) => notice.rule === record.expected.rule && notice.code === record.expected.code)
          && (record.variant !== 'V5' || reading.sellerHost === null);
    const capture = { schema: 'case-three/screen/v1', variant: record.variant, link: record.path, capturedAt: timestamp,
      reading, text, expectedMatched: check, pressedNothing: true,
      screenshot: { path: screenshotPath, sha256: createHash('sha256').update(screenshot).digest('hex') } };
    save(resolve(values.out, `${record.variant}.json`), capture, true);
    console.log(JSON.stringify(capture));
    if (!check) throw new Error(`${record.variant}: screen reading differs; evidence saved`);
  }
} finally { await browser.close(); }
