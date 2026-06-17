# Seller-side ChannelLedger Meter Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seller-side metering leak where `openSse` budgets each request against the buyer's *lifetime* cumulative but resets its own counter to zero per request — so a reused tab/channel lets the seller deliver up to the full lifetime amount on every subsequent request, giving away up to `previousCumulative` of free service.

**Architecture:** Introduce a durable per-channel **ChannelLedger** that persists, off-chain, the one quantity the chain never sees: `deliveredCumulativeAtomic` (cumulative service the meter has actually delivered, monotonic, never reset). The meter's per-request budget becomes `signedCumulative(thisVoucher) − deliveredCumulative`, which enforces the true invariant `deliveredCumulative ≤ signedCumulative ≤ maxAmount` and carries unused budget forward across requests. The ledger entry is shaped to MIRROR the on-chain `SessionRegistration` money ledger (`spent` / `crystallized_cumulative` / `current_outstanding` / `last_locked_sequence`) that already ships in V6 — those fields are reserved as an optional read-through snapshot so the Step-4 lock/LockedClaim model extends this ledger instead of replacing it. The same durable per-channel state is the substrate `resumeTab` / stranded-tab recovery needs.

**Tech Stack:** TypeScript, `@dexterai/x402` (`dexter-x402-sdk`), Express, Vitest, `tsup` build, `@solana/web3.js`. 6-decimal USDC atomic amounts via the existing `humanToAtomic` / `atomicToHuman` in `src/tab/tab.ts`.

---

## Background — exact current behavior (read before starting)

- **`src/tab/seller/meter.ts`** — `openSse(res, { tab, perUnit })`:
  - `meter.ts:54` `const budgetAtomic = BigInt(humanToAtomic(tab.cumulative()));` — budget = the voucher's *full lifetime* cumulative.
  - `meter.ts:63` `let chargedAtomic = 0n;` — resets to zero on EVERY `openSse` call (one per request).
  - `charge(units)` rejects with `ScopeViolationError('cumulative_exceeds_cap', …)` when `chargedAtomic + inc > budgetAtomic`.
  - `end()` is currently **synchronous** (`end(): void`).
- **`src/tab/seller/middleware.ts`** — `tabMiddleware`:
  - Builds `new SellerTabImpl(channelId, network, cumulative, chargeImpl)` at `middleware.ts:250`, where `cumulative = BigInt(voucher.payload.cumulativeAmount)` (the signed lifetime cumulative).
  - `chargeImpl` (the `SellerTab.charge()` path) is an intentional throwing stub at `middleware.ts:254-265` — leave it throwing; real metering is the `openSse` meter.
  - Persists the accepted voucher with `await store.set(channelId, voucher);` at `middleware.ts:246` (`store: VoucherStore`).
  - Keeps an in-process `SessionCache` (`middleware.ts:77-92`) for the parsed registration + `lastCumulativeAtomic` (monotonicity / one-time on-chain read). **Keep this cache** — it is the hot-path RPC amortizer; the ledger is the durable layer alongside it.
- **`src/tab/seller/types.ts`** — `SellerTab` (has `cumulative(): HumanAmount` and the throwing `charge()`), `VoucherStore` (`get`/`set`/`delete` of `SignedVoucher`), `TabMiddlewareOptions` (has `store?: VoucherStore`), `OpenSseOptions`, `SseMeter`.
- **`src/tab/seller/voucher-store.ts`** — `InMemoryVoucherStore`, `FileVoucherStore` (one JSON file per channel, hex-encodes the voucher's `Uint8Array` fields).
- **On-chain ground truth (shipped V6, mainnet `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`):** `SessionRegistration` carries `spent: u64`, `current_outstanding: u64`, `crystallized_cumulative: u64`, `last_locked_sequence: u32`. `lock_voucher` crystallizes the cumulative *delta* (`lock_voucher.rs:236` `cumulative_amount.checked_sub(session.crystallized_cumulative)`, `:267` `saturating_add(delta)`). The own-money path keeps `crystallized_cumulative == 0` and gates on `> spent` (`settle_tab_voucher.rs:189`). `deliveredCumulative` is the ONLY field that is intrinsically off-chain (per-token, hot-path).

The worked leak (perUnit `0.10`): req1 signs cumulative `0.10` → budget `0.10`, deliver `0.10`. req2 signs cumulative `0.20` → OLD budget `0.20` charged from 0 → seller can deliver `0.20` in req2 alone; total delivered `0.30` vs `0.20` authorized = `0.10` leaked. After the fix req2 budget = `0.20 − 0.10 = 0.10`; total capped at `0.20`.

## File Structure

- **Create `src/tab/seller/channel-ledger.ts`** — the `ChannelLedgerEntry` / `OnChainLedgerSnapshot` / `ChannelLedger` types, `InMemoryChannelLedger`, `FileChannelLedger`. Owns durable per-channel seller state and its (de)serialization. Supersedes `VoucherStore` (which stays exported-but-deprecated).
- **Modify `src/tab/seller/types.ts`** — add `deliveredCumulative()` + `recordDelivered()` to `SellerTab`; deprecate `VoucherStore`; swap `store?: VoucherStore` → `ledger?: ChannelLedger` on the middleware options. Make `SseMeter.end()` async.
- **Modify `src/tab/seller/meter.ts`** — budget = `signedCumulative − deliveredCumulative`; persist delivered on terminal events; `end()` becomes async.
- **Modify `src/tab/seller/middleware.ts`** — accept/default a `ChannelLedger`; read the delivered baseline; inject baseline + a `recordDelivered` closure into `SellerTabImpl`; persist the accepted voucher via the ledger. Export `SellerTabImpl` for unit testing.
- **Modify `src/tab/seller/index.ts`** — export the ledger types + impls; mark the `VoucherStore` exports deprecated; fix the docstring example to `await meter.end()`.
- **Create `src/tab/seller/__tests__/meter.test.ts`** — the headline two-request-reuse test + budget unit tests.
- **Create `src/tab/seller/__tests__/channel-ledger.test.ts`** — ledger roundtrip + durable-reload tests.

---

### Task 1: ChannelLedger types + InMemoryChannelLedger + SellerTab interface

**Files:**
- Create: `src/tab/seller/channel-ledger.ts`
- Modify: `src/tab/seller/types.ts` (add two `SellerTab` methods)
- Test: `src/tab/seller/__tests__/channel-ledger.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tab/seller/__tests__/channel-ledger.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryChannelLedger, type ChannelLedgerEntry } from '../channel-ledger';
import type { SignedVoucher } from '../../types';

function fakeVoucher(channelId: string, cumulativeAmount: string): SignedVoucher {
  return {
    payload: { channelId, cumulativeAmount, sequenceNumber: 1 },
    sessionPublicKey: new Uint8Array(32).fill(1),
    sessionRegistration: new Uint8Array(188).fill(2),
    sessionSignature: new Uint8Array(64).fill(3),
  };
}

describe('InMemoryChannelLedger', () => {
  const channelId = 'a'.repeat(64);

  it('returns null for an unknown channel', async () => {
    const ledger = new InMemoryChannelLedger();
    expect(await ledger.get(channelId)).toBeNull();
  });

  it('roundtrips lastVoucher + deliveredCumulativeAtomic', async () => {
    const ledger = new InMemoryChannelLedger();
    const entry: ChannelLedgerEntry = {
      lastVoucher: fakeVoucher(channelId, '100000'),
      deliveredCumulativeAtomic: '50000',
    };
    await ledger.set(channelId, entry);
    const got = await ledger.get(channelId);
    expect(got?.deliveredCumulativeAtomic).toBe('50000');
    expect(got?.lastVoucher.payload.cumulativeAmount).toBe('100000');
  });

  it('preserves the optional onChain snapshot when present', async () => {
    const ledger = new InMemoryChannelLedger();
    await ledger.set(channelId, {
      lastVoucher: fakeVoucher(channelId, '100000'),
      deliveredCumulativeAtomic: '0',
      onChain: {
        spentAtomic: '0',
        crystallizedCumulativeAtomic: '0',
        currentOutstandingAtomic: '0',
        lastLockedSequence: 0,
        fetchedAtUnixSec: 1718000000,
      },
    });
    const got = await ledger.get(channelId);
    expect(got?.onChain?.fetchedAtUnixSec).toBe(1718000000);
  });

  it('deletes a channel', async () => {
    const ledger = new InMemoryChannelLedger();
    await ledger.set(channelId, { lastVoucher: fakeVoucher(channelId, '1'), deliveredCumulativeAtomic: '0' });
    await ledger.delete(channelId);
    expect(await ledger.get(channelId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tab/seller/__tests__/channel-ledger.test.ts`
Expected: FAIL — `Cannot find module '../channel-ledger'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/tab/seller/channel-ledger.ts`:

```ts
/**
 * Durable per-channel seller ledger for OTS tab streaming.
 *
 * Supersedes VoucherStore: it persists the latest accepted voucher AND the
 * one quantity the chain never sees — `deliveredCumulativeAtomic`, the
 * cumulative service the meter has actually delivered on this channel across
 * ALL requests. Monotonic, never reset. This is what closes the channel-reuse
 * metering leak: the meter budgets each request against
 * `signedCumulative − deliveredCumulative`, not the lifetime cumulative.
 *
 * Shape mirrors the on-chain SessionRegistration money ledger
 * (spent / crystallized_cumulative / current_outstanding / last_locked_sequence)
 * that already ships in V6, via the optional `onChain` snapshot. That field is
 * RESERVED for the Step-4 lock/LockedClaim model (lock_voucher reads/writes
 * those on-chain) — the off-chain meter does not populate it today. Reserving
 * it here keeps the ledger forward-compatible without a later breaking change.
 *
 * The same durable state is the substrate resumeTab / stranded-tab recovery
 * needs (last voucher + delivered baseline per channel).
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';

import type { AtomicAmount, SignedVoucher } from '../types';

/**
 * Read-through cache of the on-chain SessionRegistration money ledger.
 * RESERVED for Step 4 (lock_voucher / LockedClaim). Not populated by the
 * off-chain meter today. All amounts are atomic (base units) strings.
 */
export interface OnChainLedgerSnapshot {
  spentAtomic: AtomicAmount;
  crystallizedCumulativeAtomic: AtomicAmount;
  currentOutstandingAtomic: AtomicAmount;
  lastLockedSequence: number;
  /** Unix seconds when this snapshot was read from chain. */
  fetchedAtUnixSec: number;
}

export interface ChannelLedgerEntry {
  /** Latest accepted voucher. `payload.cumulativeAmount` is the signedCumulative. */
  lastVoucher: SignedVoucher;
  /**
   * Off-chain cumulative the meter has DELIVERED on this channel across all
   * requests. Monotonic; never reset. The leak-fix field.
   */
  deliveredCumulativeAtomic: AtomicAmount;
  /** RESERVED (Step 4): on-chain money ledger snapshot. Unset today. */
  onChain?: OnChainLedgerSnapshot;
}

export interface ChannelLedger {
  get(channelId: string): Promise<ChannelLedgerEntry | null>;
  set(channelId: string, entry: ChannelLedgerEntry): Promise<void>;
  delete(channelId: string): Promise<void>;
}

// ── In-memory ledger (zero-config default; loses state on restart) ──────

export class InMemoryChannelLedger implements ChannelLedger {
  private map = new Map<string, ChannelLedgerEntry>();

  async get(channelId: string): Promise<ChannelLedgerEntry | null> {
    return this.map.get(channelId) ?? null;
  }

  async set(channelId: string, entry: ChannelLedgerEntry): Promise<void> {
    this.map.set(channelId, entry);
  }

  async delete(channelId: string): Promise<void> {
    this.map.delete(channelId);
  }
}

// ── Serialization helpers (Uint8Array voucher fields → hex) ─────────────

interface SerializedEntry {
  lastVoucher: {
    payload: SignedVoucher['payload'];
    sessionPublicKey: string;
    sessionRegistration: string;
    sessionSignature: string;
  };
  deliveredCumulativeAtomic: AtomicAmount;
  onChain?: OnChainLedgerSnapshot;
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (const x of b) out += x.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hex length must be even, got ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function serialize(entry: ChannelLedgerEntry): SerializedEntry {
  return {
    lastVoucher: {
      payload: entry.lastVoucher.payload,
      sessionPublicKey: bytesToHex(entry.lastVoucher.sessionPublicKey),
      sessionRegistration: bytesToHex(entry.lastVoucher.sessionRegistration),
      sessionSignature: bytesToHex(entry.lastVoucher.sessionSignature),
    },
    deliveredCumulativeAtomic: entry.deliveredCumulativeAtomic,
    onChain: entry.onChain,
  };
}

function deserialize(s: SerializedEntry): ChannelLedgerEntry {
  return {
    lastVoucher: {
      payload: s.lastVoucher.payload,
      sessionPublicKey: hexToBytes(s.lastVoucher.sessionPublicKey),
      sessionRegistration: hexToBytes(s.lastVoucher.sessionRegistration),
      sessionSignature: hexToBytes(s.lastVoucher.sessionSignature),
    },
    deliveredCumulativeAtomic: s.deliveredCumulativeAtomic,
    onChain: s.onChain,
  };
}

// FileChannelLedger is added in Task 2.
export const __ledgerSerde = { serialize, deserialize, bytesToHex, hexToBytes };
export { fs as __fs, join as __join, dirname as __dirname };
```

> Note: the `__ledgerSerde` / `__fs` exports are scaffolding consumed by Task 2's `FileChannelLedger` (kept in the same file). Task 2 replaces these throwaway exports with the class; do not ship them.

Add the two methods to `SellerTab` in `src/tab/seller/types.ts`. Find the `SellerTab` interface (currently ends after `charge(incrementHuman: HumanAmount): Promise<void>;`) and add, immediately before the closing `}`:

```ts
  /**
   * Off-chain cumulative (human amount) the meter has DELIVERED on this
   * channel across ALL requests, read from the ChannelLedger at request start.
   * The meter's per-request budget is `cumulative() − deliveredCumulative()`.
   */
  deliveredCumulative(): HumanAmount;
  /**
   * Persist a new delivered-cumulative checkpoint (atomic) to the ledger.
   * Called by the meter on terminal events (stream end / cap hit).
   */
  recordDelivered(cumulativeAtomic: AtomicAmount): Promise<void>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tab/seller/__tests__/channel-ledger.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tab/seller/channel-ledger.ts src/tab/seller/types.ts src/tab/seller/__tests__/channel-ledger.test.ts
git commit -m "feat(seller): ChannelLedger types + InMemoryChannelLedger + SellerTab delivered hooks"
```

---

### Task 2: FileChannelLedger (durable storage — shared with resumeTab)

**Files:**
- Modify: `src/tab/seller/channel-ledger.ts`
- Test: `src/tab/seller/__tests__/channel-ledger.test.ts`

> This is its own task because durable per-channel state is the substrate `resumeTab` / stranded-tab recovery reuse — it is not throwaway. The crash window is one request's delivery, identical to the existing `FileVoucherStore` window.

- [ ] **Step 1: Write the failing test**

Append to `src/tab/seller/__tests__/channel-ledger.test.ts`:

```ts
import { FileChannelLedger } from '../channel-ledger';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

describe('FileChannelLedger', () => {
  const channelId = 'b'.repeat(64);

  it('persists across instances (survives a simulated restart)', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'chanledger-'));
    try {
      const writer = new FileChannelLedger(dir);
      await writer.set(channelId, {
        lastVoucher: fakeVoucher(channelId, '200000'),
        deliveredCumulativeAtomic: '150000',
      });
      // New instance, same dir = a process restart.
      const reader = new FileChannelLedger(dir);
      const got = await reader.get(channelId);
      expect(got?.deliveredCumulativeAtomic).toBe('150000');
      expect(got?.lastVoucher.payload.cumulativeAmount).toBe('200000');
      expect(got?.lastVoucher.sessionSignature.length).toBe(64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a missing file and rejects unsafe channel ids', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'chanledger-'));
    try {
      const ledger = new FileChannelLedger(dir);
      expect(await ledger.get('c'.repeat(64))).toBeNull();
      await expect(
        ledger.set('../escape', { lastVoucher: fakeVoucher('x', '1'), deliveredCumulativeAtomic: '0' }),
      ).rejects.toThrow(/unsafe channelId/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tab/seller/__tests__/channel-ledger.test.ts`
Expected: FAIL — `FileChannelLedger is not exported` / not a constructor.

- [ ] **Step 3: Write minimal implementation**

In `src/tab/seller/channel-ledger.ts`, DELETE the throwaway final two `export` lines (`__ledgerSerde`, `__fs`/`__join`/`__dirname`) and append the class (it uses the module-level `fs`, `join`, `dirname`, `serialize`, `deserialize` already imported/defined):

```ts
// ── File-backed ledger (durable across restarts; one JSON file per channel) ──
//
// Atomicity matches FileVoucherStore: write-then-rename. The middleware
// serializes writes per channel, so concurrent same-channel writes don't race
// in practice. Production sellers expecting high concurrency implement
// ChannelLedger over Redis/Postgres and pass it into tabMiddleware.

export class FileChannelLedger implements ChannelLedger {
  constructor(private readonly dir: string) {}

  private pathFor(channelId: string): string {
    if (!/^[a-z0-9_-]+$/i.test(channelId)) {
      throw new Error(`unsafe channelId for filesystem: ${channelId}`);
    }
    return join(this.dir, `${channelId}.json`);
  }

  async get(channelId: string): Promise<ChannelLedgerEntry | null> {
    try {
      const raw = await fs.readFile(this.pathFor(channelId), 'utf8');
      return deserialize(JSON.parse(raw) as SerializedEntry);
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  async set(channelId: string, entry: ChannelLedgerEntry): Promise<void> {
    const path = this.pathFor(channelId);
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(serialize(entry)));
    await fs.rename(tmp, path);
  }

  async delete(channelId: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(channelId));
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tab/seller/__tests__/channel-ledger.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/tab/seller/channel-ledger.ts src/tab/seller/__tests__/channel-ledger.test.ts
git commit -m "feat(seller): FileChannelLedger — durable per-channel state (shared with resumeTab)"
```

---

### Task 3: Meter budget = signedCumulative − deliveredCumulative (+ the two-request-reuse test)

**Files:**
- Modify: `src/tab/seller/meter.ts`
- Modify: `src/tab/seller/types.ts` (`SseMeter.end` → `Promise<void>`)
- Test: `src/tab/seller/__tests__/meter.test.ts`

This task carries the **headline test**. It uses a hand-built `SellerTab` stub backed by an `InMemoryChannelLedger`, mirroring how the real middleware reads the delivered baseline once at request start and persists via `recordDelivered`.

- [ ] **Step 1: Write the failing test**

Create `src/tab/seller/__tests__/meter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openSse } from '../meter';
import { InMemoryChannelLedger } from '../channel-ledger';
import type { SellerTab } from '../types';
import { atomicToHuman, humanToAtomic } from '../../tab';

// Minimal SSE-capable fake Express Response that records writes and supports
// the 'close' event (for the buyer-disconnect anti-grief test).
function fakeSseRes() {
  const writes: string[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  return {
    headersSent: false,
    setHeader() {},
    flushHeaders() {},
    write(s: string) { writes.push(s); return true; },
    end() {},
    on(event: string, cb: () => void) { (listeners[event] ??= []).push(cb); return this; },
    _emit(event: string) { (listeners[event] ?? []).forEach((cb) => cb()); },
    _writes: writes,
  } as any;
}

// Flush the fire-and-forget persist kicked off by the 'close' handler.
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

// A SellerTab stub backed by the ledger. Mirrors the real middleware: the
// delivered baseline is read ONCE (async) and captured synchronously; the
// stub exposes it via deliveredCumulative() and persists via recordDelivered().
async function makeStubTab(
  channelId: string,
  signedCumulativeHuman: string,
  ledger: InMemoryChannelLedger,
): Promise<SellerTab> {
  const prior = await ledger.get(channelId);
  const deliveredBaselineAtomic = prior ? prior.deliveredCumulativeAtomic : '0';
  return {
    channelId,
    network: 'solana:mainnet',
    sessionPublicKey: new Uint8Array(32),
    cumulative: () => signedCumulativeHuman,
    deliveredCumulative: () => atomicToHuman(deliveredBaselineAtomic),
    charge: async () => { throw new Error('tab.charge stub'); },
    recordDelivered: async (cumulativeAtomic: string) => {
      await ledger.set(channelId, {
        // lastVoucher is irrelevant to the budget math; reuse prior or a stub.
        lastVoucher: prior?.lastVoucher ?? ({
          payload: { channelId, cumulativeAmount: humanToAtomic(signedCumulativeHuman), sequenceNumber: 1 },
          sessionPublicKey: new Uint8Array(32),
          sessionRegistration: new Uint8Array(188),
          sessionSignature: new Uint8Array(64),
        } as any),
        deliveredCumulativeAtomic: cumulativeAtomic,
      });
    },
  };
}

describe('openSse delivered-ledger budget — no channel-reuse leak', () => {
  const channelId = 'a'.repeat(64);

  it('first request budgets against the full signed cumulative (delivered baseline 0)', async () => {
    const ledger = new InMemoryChannelLedger();
    const tab = await makeStubTab(channelId, '0.10', ledger);
    const meter = openSse(fakeSseRes(), { tab, perUnit: '0.01' });
    for (let i = 0; i < 10; i++) await meter.charge(1); // 10 * 0.01 = 0.10, exactly budget
    await expect(meter.charge(1)).rejects.toThrow(/cumulative_exceeds_cap/);
    await meter.end();
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.10'));
  });

  it('request 2 budget = signedCumulative − deliveredCumulative (the increment), NOT lifetime; under-delivered headroom carries forward', async () => {
    const ledger = new InMemoryChannelLedger();

    // Request 1: signed 0.10, UNDER-deliver only 0.05, then end.
    const tab1 = await makeStubTab(channelId, '0.10', ledger);
    const m1 = openSse(fakeSseRes(), { tab: tab1, perUnit: '0.01' });
    for (let i = 0; i < 5; i++) await m1.charge(1); // 0.05 delivered
    await m1.end();
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.05'));

    // Request 2: buyer bumps signed to 0.20. Correct budget = 0.20 − 0.05 = 0.15
    // (0.10 fresh + 0.05 carried headroom). The OLD bug would allow 0.20 here.
    const tab2 = await makeStubTab(channelId, '0.20', ledger);
    const m2 = openSse(fakeSseRes(), { tab: tab2, perUnit: '0.01' });
    for (let i = 0; i < 15; i++) await m2.charge(1); // 0.15 — full carried budget
    await expect(m2.charge(1)).rejects.toThrow(/cumulative_exceeds_cap/); // 16th (0.16) rejected
    await m2.end();

    // Lifetime delivered is capped at the signed 0.20 — no leak.
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.20'));
  });

  it('persists delivered-so-far when a chunk is rejected for exceeding the cap', async () => {
    const ledger = new InMemoryChannelLedger();
    const tab = await makeStubTab(channelId, '0.03', ledger);
    const meter = openSse(fakeSseRes(), { tab, perUnit: '0.01' });
    await meter.charge(1);
    await meter.charge(1);
    await meter.charge(1); // 0.03, exactly budget
    await expect(meter.charge(1)).rejects.toThrow(/cumulative_exceeds_cap/);
    // delivered persisted at the cap even though end() was never called.
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.03'));
  });

  it('persists delivered when the buyer disconnects mid-stream before end() (anti-grief)', async () => {
    const ledger = new InMemoryChannelLedger();
    const tab = await makeStubTab(channelId, '0.10', ledger);
    const res = fakeSseRes();
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(1);
    await meter.charge(1); // delivered 0.02 in-flight, never reached end()
    res._emit('close');     // buyer drops the connection
    await flushMicrotasks(); // let the fire-and-forget persist settle
    // Without the close-handler this would be null/0 → req2 re-grants budget
    // (the quadratic giveaway). With it, delivered is committed at 0.02.
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.02'));
  });

  it('does not double-write on a normal end() (the res.end()-triggered close is ignored)', async () => {
    const ledger = new InMemoryChannelLedger();
    const tab = await makeStubTab(channelId, '0.10', ledger);
    const res = fakeSseRes();
    const meter = openSse(res, { tab, perUnit: '0.01' });
    await meter.charge(1); // 0.01
    await meter.end();     // sets ended=true, persists 0.01
    res._emit('close');    // would fire after res.end(); must be a no-op
    await flushMicrotasks();
    expect((await ledger.get(channelId))?.deliveredCumulativeAtomic).toBe(humanToAtomic('0.01'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tab/seller/__tests__/meter.test.ts`
Expected: FAIL — `meter.charge is not a function` is not the error; the real failures are (a) `tab.deliveredCumulative is not a function` inside `openSse`, and (b) the request-2 assertions (old budget is lifetime `0.20`, so the 16th charge would NOT reject and delivered would persist `0.35`/未cap). Confirms the bug is reproduced.

- [ ] **Step 3: Write minimal implementation**

Rewrite the body of `openSse` in `src/tab/seller/meter.ts`. Replace the block from `const tab: SellerTab = options.tab;` through the `return { charge, send, end };` with:

```ts
  const tab: SellerTab = options.tab;

  // Per-request budget = what the buyer authorized via THIS voucher's signed
  // cumulative, MINUS what the meter has already delivered on this channel
  // across prior requests (read from the ChannelLedger at request start).
  // This enforces lifetime `delivered ≤ signed` and carries unused budget
  // forward — closing the channel-reuse leak where budgeting against the full
  // lifetime cumulative let the seller re-deliver it every request.
  const signedAtomic = BigInt(humanToAtomic(tab.cumulative()));
  const deliveredBaselineAtomic = BigInt(humanToAtomic(tab.deliveredCumulative()));
  let budgetAtomic = signedAtomic - deliveredBaselineAtomic;
  if (budgetAtomic < 0n) budgetAtomic = 0n; // defensive; monotonicity upstream prevents this

  const perUnitAtomic = options.perUnit
    ? BigInt(humanToAtomic(options.perUnit))
    : null;

  // Cumulative delivered DURING this request (resets per request, as before).
  let chargedAtomic = 0n;
  let ended = false;

  // Persist the lifetime delivered cumulative (baseline + this request's
  // delivery) to the ledger. Called on EVERY terminal path — clean end,
  // cap-exceeded, AND client disconnect/abort — so a buyer CANNOT grief the
  // seller by consuming service then dropping the connection before end()
  // (that would otherwise leave delivered un-advanced and re-grant the budget
  // next request — a quadratic giveaway). The only unpersisted window left is a
  // hard process crash: not buyer-controllable, bounded to in-flight requests,
  // same class as the existing voucher-store crash window. Per-chunk
  // checkpointing would only SHRINK that hard-crash window (never close it —
  // you can always crash between chunk and write) at a write-per-token cost, so
  // we persist per terminal event instead.
  async function persistDelivered(): Promise<void> {
    await tab.recordDelivered((deliveredBaselineAtomic + chargedAtomic).toString());
  }

  // Buyer-controlled termination: if the client drops the connection mid-stream
  // the underlying response emits 'close'; commit what we delivered. Best-effort
  // (can't await in an event handler), but the ledger write completes because on
  // a disconnect the process is still alive. Guarded by `ended` so a normal
  // end() — which also emits 'close' via res.end() — doesn't double-write.
  res.on('close', () => {
    if (ended) return;
    ended = true;
    void persistDelivered();
  });

  async function charge(units = 1): Promise<void> {
    if (ended) throw new Error('meter ended');
    if (perUnitAtomic === null) throw new Error('charge() needs options.perUnit');
    const inc = perUnitAtomic * BigInt(units);
    const next = chargedAtomic + inc;
    if (next > budgetAtomic) {
      await persistDelivered(); // commit what we DID deliver before refusing
      throw new ScopeViolationError(
        'cumulative_exceeds_cap',
        `chunk would push delivered to ${atomicToHuman((deliveredBaselineAtomic + next).toString())} ` +
        `beyond signed cumulative ${atomicToHuman(signedAtomic.toString())} ` +
        `(per-request budget ${atomicToHuman(budgetAtomic.toString())})`,
      );
    }
    chargedAtomic = next;
  }

  function send(chunk: string | Uint8Array): void {
    if (ended) throw new Error('meter ended');
    const data = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const escaped = data.replace(/\n/g, '\\n');
    res.write(`data: ${escaped}\n\n`);
  }

  async function end(): Promise<void> {
    if (ended) return;
    ended = true;
    await persistDelivered();
    res.write(`event: end\ndata: {"chargedAtomic":"${chargedAtomic}"}\n\n`);
    res.end();
  }

  return { charge, send, end };
```

In `src/tab/seller/types.ts`, change `SseMeter.end` from `end(): void;` to `end(): Promise<void>;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tab/seller/__tests__/meter.test.ts`
Expected: PASS (5 tests — first-request budget, two-request-reuse, cap-reject persist, buyer-disconnect anti-grief, no-double-write-on-end).

- [ ] **Step 5: Commit**

```bash
git add src/tab/seller/meter.ts src/tab/seller/types.ts src/tab/seller/__tests__/meter.test.ts
git commit -m "fix(seller): meter budget = signed − delivered (close channel-reuse leak) + two-request-reuse test"
```

---

### Task 4: SellerTabImpl — implement deliveredCumulative()/recordDelivered()

**Files:**
- Modify: `src/tab/seller/middleware.ts` (`SellerTabImpl` class + export it)
- Test: `src/tab/seller/__tests__/meter.test.ts` (append a SellerTabImpl unit block)

- [ ] **Step 1: Write the failing test**

Append to `src/tab/seller/__tests__/meter.test.ts`:

```ts
import { SellerTabImpl } from '../middleware';

describe('SellerTabImpl delivered hooks', () => {
  const channelId = 'd'.repeat(64);

  it('exposes the injected delivered baseline and persists via the recordDelivered closure', async () => {
    const ledger = new InMemoryChannelLedger();
    const recorded: string[] = [];
    const tab = new SellerTabImpl(
      channelId,
      'solana:mainnet',
      BigInt(humanToAtomic('0.20')),         // signed cumulative
      BigInt(humanToAtomic('0.05')),         // delivered baseline
      async (cumAtomic: string) => { recorded.push(cumAtomic); },
      async () => { throw new Error('tab.charge stub'); },
    );
    expect(tab.cumulative()).toBe(atomicToHuman(humanToAtomic('0.20')));
    expect(tab.deliveredCumulative()).toBe(atomicToHuman(humanToAtomic('0.05')));
    await tab.recordDelivered(humanToAtomic('0.12'));
    expect(recorded).toEqual([humanToAtomic('0.12')]);
    void ledger;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tab/seller/__tests__/meter.test.ts`
Expected: FAIL — `SellerTabImpl is not exported` / constructor arity mismatch.

- [ ] **Step 3: Write minimal implementation**

In `src/tab/seller/middleware.ts`, change `class SellerTabImpl implements SellerTab {` to `export class SellerTabImpl implements SellerTab {`, then update the class to add the delivered baseline + record closure. Replace the constructor and add the two methods:

```ts
  private cumulativeAtomic: bigint;
  private deliveredBaselineAtomic: bigint;

  constructor(
    channelId: string,
    network: TabMiddlewareOptions['network'],
    initialCumulative: bigint,
    deliveredBaselineAtomic: bigint,
    private readonly recordDeliveredImpl: (cumulativeAtomic: string) => Promise<void>,
    private readonly chargeImpl: (incrementHuman: HumanAmount) => Promise<void>,
  ) {
    this.channelId = channelId;
    this.network = network;
    this.cumulativeAtomic = initialCumulative;
    this.deliveredBaselineAtomic = deliveredBaselineAtomic;
  }

  cumulative(): HumanAmount {
    return atomicToHuman(this.cumulativeAtomic.toString());
  }

  deliveredCumulative(): HumanAmount {
    return atomicToHuman(this.deliveredBaselineAtomic.toString());
  }

  async recordDelivered(cumulativeAtomic: AtomicAmount): Promise<void> {
    return this.recordDeliveredImpl(cumulativeAtomic);
  }
```

> The existing `bumpCumulative`, `setSessionPublicKey`, and `charge` methods stay. `AtomicAmount` is already imported in `middleware.ts` (from `../types`). The constructor's `chargeImpl` is now the LAST positional arg — Task 5 updates the single call site to match.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tab/seller/__tests__/meter.test.ts`
Expected: the new SellerTabImpl test PASSES. (The middleware call site still passes the old arg order — typecheck/other tests may break until Task 5; that is expected and fixed next.)

- [ ] **Step 5: Commit**

```bash
git add src/tab/seller/middleware.ts src/tab/seller/__tests__/meter.test.ts
git commit -m "feat(seller): SellerTabImpl delivered baseline + recordDelivered closure"
```

---

### Task 5: Middleware wiring — ChannelLedger replaces VoucherStore; thread baseline + persist

**Files:**
- Modify: `src/tab/seller/middleware.ts`
- Modify: `src/tab/seller/types.ts` (`TabMiddlewareOptions.store` → `ledger`)
- Test: `src/tab/seller/__tests__/middleware-ledger.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/tab/seller/__tests__/middleware-ledger.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { tabMiddleware } from '../middleware';
import { InMemoryChannelLedger } from '../channel-ledger';
import { Connection } from '@solana/web3.js';

const SELLER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

describe('tabMiddleware ledger config', () => {
  it('accepts a ChannelLedger and rejects a request with no voucher header (402) without touching the ledger', async () => {
    const ledger = new InMemoryChannelLedger();
    const mw = tabMiddleware({
      connection: new Connection('http://127.0.0.1:8899'),
      sellerPubkey: SELLER,
      perUnit: '0.01',
      network: 'solana:mainnet',
      settle: 'on-close',
      ledger,
    });
    let status = 0;
    let body: any;
    const req: any = { headers: {} };
    const res: any = {
      status(c: number) { status = c; return this; },
      json(b: unknown) { body = b; return this; },
    };
    await mw(req, res, () => { throw new Error('next should not be called'); });
    expect(status).toBe(402);
    expect(body.error).toBe('invalid_voucher');
    expect(await ledger.get('whatever'.padEnd(64, '0'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tab/seller/__tests__/middleware-ledger.test.ts`
Expected: FAIL — `ledger` is not a known option (type error is suppressed at runtime, but the middleware still references `config.store`/`InMemoryVoucherStore`); after the option rename the property won't exist yet. (If it happens to pass on the 402 path, Step 3 still required for the wiring below.)

- [ ] **Step 3: Write minimal implementation**

In `src/tab/seller/types.ts`, in `TabMiddlewareOptions`, replace the `store?: VoucherStore;` member with:

```ts
  /**
   * Durable per-channel state (latest voucher + delivered cumulative).
   * Default: in-memory (loses state on restart). Pass a FileChannelLedger or
   * your own ChannelLedger for restart-safe revenue + resumeTab support.
   */
  ledger?: ChannelLedger;
```

Add the import at the top of `types.ts`: `import type { ChannelLedger } from './channel-ledger';`. Mark `VoucherStore` deprecated with a JSDoc tag (keep the interface — Task 6 keeps it exported for back-compat):

```ts
/** @deprecated Superseded by ChannelLedger (channel-ledger.ts), which also persists deliveredCumulative. */
export interface VoucherStore {
```

In `src/tab/seller/middleware.ts`:

1. Update imports — replace `import { InMemoryVoucherStore } from './voucher-store';` with `import { InMemoryChannelLedger, type ChannelLedger } from './channel-ledger';` and drop the now-unused `VoucherStore` from the `./types` import list.
2. In `tabMiddleware`, replace `const store: VoucherStore = config.store ?? new InMemoryVoucherStore();` with:

```ts
  const ledger: ChannelLedger = config.ledger ?? new InMemoryChannelLedger();
```

3. Replace step 6 (`await store.set(channelId, voucher);`) and step 7 (the `new SellerTabImpl(...)` construction) — i.e. the block from `// 6. Persist the voucher` through `req.tab = tab;` — with:

```ts
      // 6. Read the durable delivered baseline for this channel, then persist
      //    the accepted voucher (delivered unchanged at acceptance time).
      const prior = await ledger.get(channelId);
      const deliveredBaselineAtomic = prior ? BigInt(prior.deliveredCumulativeAtomic) : 0n;
      await ledger.set(channelId, {
        lastVoucher: voucher,
        deliveredCumulativeAtomic: deliveredBaselineAtomic.toString(),
        onChain: prior?.onChain,
      });

      // 7. Update the hot-path registration cache and attach the SellerTab.
      cache.update(channelId, voucher.payload.cumulativeAmount);
      const tab = new SellerTabImpl(
        channelId,
        config.network,
        cumulative,
        deliveredBaselineAtomic,
        // recordDelivered: the meter calls this on terminal events to persist
        // the new lifetime delivered cumulative; keep lastVoucher + onChain.
        async (cumAtomic: string) => {
          const cur = await ledger.get(channelId);
          await ledger.set(channelId, {
            lastVoucher: cur?.lastVoucher ?? voucher,
            deliveredCumulativeAtomic: cumAtomic,
            onChain: cur?.onChain,
          });
        },
        // charge stub (unchanged): the route handler doesn't drive charging.
        async (_inc) => {
          throw new Error(
            'SellerTab.charge() is not driven by the route handler; the buyer ' +
            'presents a fresh voucher per chunk. Use openSse(res, tab) for the ' +
            'metered-stream pattern.',
          );
        },
      );
      tab.setSessionPublicKey(voucher.sessionPublicKey);
      req.tab = tab;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tab/seller/__tests__/middleware-ledger.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/tab/seller/middleware.ts src/tab/seller/types.ts src/tab/seller/__tests__/middleware-ledger.test.ts
git commit -m "feat(seller): wire ChannelLedger through tabMiddleware (delivered baseline + persist)"
```

---

### Task 6: Exports + docstring + full typecheck/test sweep

**Files:**
- Modify: `src/tab/seller/index.ts`
- Test: full suite + typecheck

- [ ] **Step 1: Update exports + example**

In `src/tab/seller/index.ts`:

1. Add to the public-types export block: `ChannelLedger`, `ChannelLedgerEntry`, `OnChainLedgerSnapshot` from `./channel-ledger`:

```ts
export type {
  ChannelLedger,
  ChannelLedgerEntry,
  OnChainLedgerSnapshot,
} from './channel-ledger';
export {
  InMemoryChannelLedger,
  FileChannelLedger,
} from './channel-ledger';
```

2. Keep the existing `VoucherStore` / `InMemoryVoucherStore` / `FileVoucherStore` exports (back-compat), but add a deprecation note in the comment above them: `// Deprecated voucher persistence — superseded by ChannelLedger above.`

3. Fix the docstring example: change `meter.end();` to `await meter.end();` (the meter loop is already inside an `async (req, res)` handler).

4. **README parity (same repo).** `dexter-x402-sdk/README.md` ships a seller example that calls `meter.end();` without await (the `tabOrExactMiddleware` block, ~line 105). Change it to `await meter.end();` so the copy-paste reference matches the now-async API. This rides WITH the meter fix on purpose — version-coupled, so the published README never references a sync `end()` against a build that made it async. (metadexter owns the same edit in his README *draft* `dexter-thesis/architecture/DRAFT-readme-x402-option-a-2026-06-17.md`, which has two such examples — coordinate; not edited by this task.)

- [ ] **Step 2: Run the full seller suite**

Run: `npx vitest run src/tab/seller/`
Expected: PASS — all seller tests green (channel-ledger, meter, middleware-ledger, plus the pre-existing challenge/dual/verify suites unaffected).

- [ ] **Step 3: Typecheck the whole package**

Run: `npm run typecheck`
Expected: exit 0, no errors. (If `FileVoucherStore`/`VoucherStore` are now unused internally, that is fine — they remain exported public API. If the build complains about an unused `InMemoryVoucherStore` import anywhere, remove that specific import.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: `tsup` succeeds, emits the `tab/seller` entry with the new exports.

- [ ] **Step 5: Commit**

```bash
git add src/tab/seller/index.ts
git commit -m "feat(seller): export ChannelLedger surface; deprecate VoucherStore; fix openSse example"
```

---

### Task 7: DEFERRED — on-chain read-through + lock-path verification (Step 4, do NOT build now)

**Files:** none yet — this task documents the forward-compat seam and the follow-up verification owed.

- [ ] **Step 1: Record the deferred work** (no code)

This task is intentionally NOT implemented in this plan. It is the Step-4 extension that the `OnChainLedgerSnapshot` field reserves space for, plus one verification owed from the design grounding:

1. **Read-through population:** when the lock/LockedClaim model (Step 4) lands, populate `ChannelLedgerEntry.onChain` from `fetchSessionAccount` (already imported in `verify.ts` from `@dexterai/vault/session`) — read `spent`, `crystallized_cumulative`, `current_outstanding`, `last_locked_sequence` and cache them per channel. The off-chain `deliveredCumulativeAtomic` stays the source of truth for SERVICE delivered; `spent`/`crystallized` are read-through (authoritative on-chain), never duplicated. The seller's "when do I `lock_voucher`" decision consumes `deliveredCumulative` against `crystallized_cumulative`.
2. **Verification owed (cheap, non-blocking):** trace `current_outstanding` mutation across `settle_locked_voucher` / `recover_abandoned_lock` in `dexter-vault/programs/dexter-vault/src/instructions/` to confirm the read-through field semantics before wiring step 1. The off-chain ledger decision in this plan does NOT depend on it (`deliveredCumulative` is off-chain regardless), but the snapshot field names should match the verified on-chain accounting.

Leave this task unchecked as a tracked marker. Do not write code for it in this plan.

---

## Self-Review

**1. Spec coverage (the 4 required elements from the greenlight):**
- (1) ChannelLedger abstraction with off-chain `deliveredCumulative` + last voucher + read-through cache of on-chain SessionRegistration → Task 1 (types + InMemory + `onChain` reserved field) + Task 2 (durable File impl). ✅
- (2) meter budget = `signedCumulative − deliveredCumulative`, threaded through middleware → Task 3 (meter) + Task 4 (SellerTabImpl hooks) + Task 5 (middleware wiring). ✅
- (3) two-request-reuse test (request-2 budget = increment not lifetime; under-delivery carries headroom) → Task 3, test #2 (under-delivers req1 to 0.05, asserts req2 budget 0.15 not 0.20, caps lifetime at 0.20). ✅
- (4) durable storage as its own task (shared with resumeTab) → Task 2, explicitly scoped + noted as the resumeTab substrate. ✅

**2. Placeholder scan:** No TBD/TODO/"handle edge cases". The one scaffolding shortcut (`__ledgerSerde`/`__fs` exports in Task 1) is explicitly flagged and deleted in Task 2 Step 3. The cap-exceeded persist and the negative-budget clamp are concrete code, not "add error handling".

**3. Type consistency:**
- `SellerTab` gains `deliveredCumulative(): HumanAmount` + `recordDelivered(cumulativeAtomic: AtomicAmount): Promise<void>` (Task 1) — used identically in the meter (Task 3), the stub (Task 3 test), and `SellerTabImpl` (Task 4). ✅
- `SellerTabImpl` constructor arg order: `(channelId, network, initialCumulative, deliveredBaselineAtomic, recordDeliveredImpl, chargeImpl)` — defined in Task 4, called with the same order in Task 5's middleware wiring and Task 4's unit test. ✅
- `ChannelLedger` (`get`/`set`/`delete` of `ChannelLedgerEntry`) — defined Task 1, implemented File in Task 2, consumed in Task 5. ✅
- `SseMeter.end` → `Promise<void>` (Task 3) — callers updated: tests `await meter.end()` (Task 3), docstring `await meter.end()` (Task 6). ✅
- `AtomicAmount` (atomic string) vs `HumanAmount` — `deliveredCumulativeAtomic` and `recordDelivered` are atomic; `cumulative()`/`deliveredCumulative()` return human; conversions via `humanToAtomic`/`atomicToHuman` (from `../tab`) in the meter and impl. ✅

**Anti-grief (closed in Task 3):** `deliveredCumulative` persists on EVERY terminal path — clean `end()`, cap-reject, AND buyer disconnect (`res.on('close')`). This closes the buyer-controllable griefing window (consume service → drop connection before `end()` → delivered un-advanced → budget re-granted next request = a quadratic giveaway). Covered by the `buyer disconnects mid-stream` and `no double-write on end()` tests. The only residual unpersisted window is a hard process crash (SIGKILL/power loss between the last in-memory charge and the persist) — NOT buyer-controllable, bounded to in-flight requests, same class as the existing voucher-store crash window. Per-chunk checkpointing would only shrink that hard-crash window, never close it, at a write-per-token cost → YAGNI for v1.
