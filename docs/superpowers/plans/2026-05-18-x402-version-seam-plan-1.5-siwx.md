# Task 10.5 — SIW-X Inside the payAndFetch Seam

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `payAndFetch` handle Sign-In-With-X (SIW-X) transparently, so every
caller — verifier, pay route, anyone — gets CAIP-122/EIP-4361/SIWS identity auth
for free, the same way they get v1/v2 payment dispatch for free.

**Architecture:** A 402 carrying `extensions["sign-in-with-x"]` is discovered the
same way a payment 402 is. `payAndFetch` probes through a fetch wrapped by
`@x402/extensions`' `wrapFetchWithSIWx`, built from a SIW-X signer derived from
the `WalletSet`. If the merchant declares SIW-X, the wrapper signs the proof and
retries before payment dispatch runs; if not, the wrapper is a transparent
pass-through. The verifier's bespoke `siwx.ts` is then deleted — SIW-X lives in
the SDK.

**Tech Stack:** `@x402/extensions` (`wrapFetchWithSIWx`), viem (`privateKeyToAccount`
for the EVM SIW-X signer), `@solana/web3.js` `Keypair` + `tweetnacl` for the Solana
SIW-X signer, vitest, tsup.

---

## Why the WalletSet alone is not enough

`wrapFetchWithSIWx(fetch, signer)` needs a `SIWxSigner`:

- **`EVMSigner`** — `{ signMessage({message}): Promise<string>; address?: string; account?: {address} }`
- **Solana `WalletAdapterSigner`** — `{ signMessage(Uint8Array): Promise<Uint8Array>; publicKey: string | {toBase58()} }`

The SDK's `WalletSet` holds:

- `EvmWallet` — `{ address, signTypedData, signTransaction }` — **no `signMessage`**.
- `KeypairWallet` — `{ publicKey: {toBase58()}, [KEYPAIR_SYMBOL]: Keypair, ... }`.

So the EVM wallet object cannot satisfy `EVMSigner` as-is. Two parts fix this:

1. `createEvmKeypairWallet` gains a `signMessage` method (Task 10.5-1) so an
   `EvmWallet` made from a key is a valid `EVMSigner`.
2. A `toSiwxSigner(walletSet)` adapter (Task 10.5-3) maps the `WalletSet` to a
   `SIWxSigner` — EVM via the new `signMessage`, Solana via `KEYPAIR_SYMBOL` +
   `tweetnacl`.

Browser-supplied wallets (wagmi / wallet-adapter) already expose `signMessage`
in their own shape; the adapter handles the keypair-wallet case (the verifier's
case) and passes through anything that already looks like a `SIWxSigner`.

---

## File Structure

- Modify: `src/client/evm-wallet.ts` — add `signMessage` to `createEvmKeypairWallet`'s wallet.
- Modify: `src/adapters/evm.ts` — add optional `signMessage` to the `EvmWallet` interface.
- Create: `src/payment/siwx-signer.ts` — `toSiwxSigner(wallets): SIWxSigner | null`.
- Create: `src/payment/__tests__/siwx-signer.test.ts`.
- Modify: `src/payment/dispatcher.ts` — probe through the SIW-X-wrapped fetch.
- Modify: `src/payment/__tests__/dispatcher.test.ts` — SIW-X passthrough + auth tests.
- Modify: `package.json` — add `@x402/extensions` dependency; version bump to 3.6.0.

---

### Task 10.5-1: EvmWallet gains signMessage

**Files:**
- Modify: `src/adapters/evm.ts` (the `EvmWallet` interface, ~line 84)
- Modify: `src/client/evm-wallet.ts` (the returned wallet object in `createEvmKeypairWallet`)
- Test: `src/client/__tests__/evm-wallet.test.ts` (create if absent; otherwise extend)

- [ ] **Step 1: Write the failing test**

```typescript
// src/client/__tests__/evm-wallet.test.ts
import { describe, it, expect } from 'vitest';
import { createEvmKeypairWallet } from '../evm-wallet';

// A deterministic throwaway test key — not a real funded account.
const TEST_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('createEvmKeypairWallet — signMessage', () => {
  it('signs a plain string message and returns a 0x hex signature', async () => {
    const wallet = await createEvmKeypairWallet(TEST_KEY);
    expect(typeof wallet.signMessage).toBe('function');
    const sig = await wallet.signMessage!({ message: 'hello siwx' });
    expect(sig).toMatch(/^0x[0-9a-f]+$/i);
    // EIP-191 personal_sign signatures are 65 bytes => 132 hex chars incl 0x.
    expect(sig.length).toBe(132);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/client/__tests__/evm-wallet.test.ts`
Expected: FAIL — `wallet.signMessage` is undefined.

- [ ] **Step 3: Add `signMessage` to the EvmWallet interface**

In `src/adapters/evm.ts`, inside `interface EvmWallet`, after the `signTypedData`
block, add:

```typescript
  /**
   * Sign a plain message (EIP-191 personal_sign). Used by the SIW-X
   * (Sign-In-With-X) seam for CAIP-122 / EIP-4361 identity proofs.
   * Optional: browser wallets supply their own; keypair wallets get it
   * from createEvmKeypairWallet.
   */
  signMessage?(params: { message: string }): Promise<string>;
```

- [ ] **Step 4: Implement `signMessage` in createEvmKeypairWallet**

In `src/client/evm-wallet.ts`, in the object returned by
`createEvmKeypairWallet`, add a `signMessage` method alongside `signTypedData`:

```typescript
    signMessage: (params: { message: string }) =>
      account.signMessage({ message: params.message }),
```

(viem's `privateKeyToAccount` account exposes `signMessage({message})` →
`Promise<\`0x${string}\`>`, EIP-191. No new import needed.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/client/__tests__/evm-wallet.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green; tsc clean. (`isEvmKeypairWallet` still passes — it only
checks `address` + `signTypedData`.)

- [ ] **Step 7: Commit**

```bash
git add src/adapters/evm.ts src/client/evm-wallet.ts src/client/__tests__/evm-wallet.test.ts
git commit -m "feat(evm-wallet): EvmWallet.signMessage for the SIW-X seam"
```

---

### Task 10.5-2: Add @x402/extensions as a dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the extension package**

Run: `cd ~/websites/dexter-x402-sdk && npm install @x402/extensions@^2.12.0`

(Match the major of the already-present `@x402/core@^2.12.0` / `@x402/evm@^2.12.0`.
If `^2.12.0` does not resolve, run `npm view @x402/extensions version` and use
the latest 2.x; record the version used.)

- [ ] **Step 2: Verify the import resolves**

Run:
```bash
node -e "const m = require('@x402/extensions/sign-in-with-x'); console.log(typeof m.wrapFetchWithSIWx);"
```
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add @x402/extensions for the SIW-X seam"
```

---

### Task 10.5-3: The SIW-X signer adapter

**Files:**
- Create: `src/payment/siwx-signer.ts`
- Test: `src/payment/__tests__/siwx-signer.test.ts`

**Context:** `toSiwxSigner` turns a `WalletSet` into a `SIWxSigner` for
`wrapFetchWithSIWx`. EVM is preferred when present (most live SIW-X declarers
are EVM); Solana is supported via the keypair behind `KEYPAIR_SYMBOL`. Returns
`null` when neither wallet can produce a signer — in which case the dispatcher
skips SIW-X wrapping entirely (a no-op, identical to today's behaviour for
non-SIW-X merchants).

The `SIWxSigner` types come from `@x402/extensions/sign-in-with-x`:
`EVMSigner` = `{ signMessage({message}): Promise<string>; address?: string }`;
Solana `WalletAdapterSigner` = `{ signMessage(Uint8Array): Promise<Uint8Array>; publicKey: {toBase58()} }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/payment/__tests__/siwx-signer.test.ts
import { describe, it, expect } from 'vitest';
import { toSiwxSigner } from '../siwx-signer';
import { createEvmKeypairWallet } from '../../client/evm-wallet';
import { createKeypairWallet } from '../../client/keypair-wallet';

const EVM_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// A deterministic 64-byte Solana secret key (throwaway, unfunded).
const SOL_KEY = Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256);

describe('toSiwxSigner', () => {
  it('returns null for an empty wallet set', () => {
    expect(toSiwxSigner({})).toBeNull();
  });

  it('derives an EVM SIW-X signer that signs strings', async () => {
    const evm = await createEvmKeypairWallet(EVM_KEY);
    const signer = toSiwxSigner({ evm });
    expect(signer).not.toBeNull();
    const sig = await (signer as { signMessage: (a: { message: string }) => Promise<string> })
      .signMessage({ message: 'siwx test' });
    expect(sig).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('prefers EVM when both wallets are present', async () => {
    const evm = await createEvmKeypairWallet(EVM_KEY);
    const solana = await createKeypairWallet(SOL_KEY);
    const signer = toSiwxSigner({ evm, solana });
    // EVM signer shape: has signMessage taking an object, has address.
    expect(typeof (signer as { address?: string }).address).toBe('string');
    expect((signer as { address: string }).address.startsWith('0x')).toBe(true);
  });

  it('derives a Solana SIW-X signer that signs byte messages', async () => {
    const solana = await createKeypairWallet(SOL_KEY);
    const signer = toSiwxSigner({ solana }) as {
      signMessage: (m: Uint8Array) => Promise<Uint8Array>;
      publicKey: { toBase58: () => string };
    };
    expect(signer).not.toBeNull();
    const out = await signer.signMessage(new Uint8Array([1, 2, 3]));
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(64); // Ed25519 signature is 64 bytes.
    expect(typeof signer.publicKey.toBase58()).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/payment/__tests__/siwx-signer.test.ts`
Expected: FAIL — cannot find module `../siwx-signer`.

- [ ] **Step 3: Implement the adapter**

```typescript
// src/payment/siwx-signer.ts
/**
 * SIW-X signer adapter.
 *
 * wrapFetchWithSIWx (from @x402/extensions) needs a SIWxSigner. The
 * payment seam carries a WalletSet of wallet *objects*; this maps that
 * WalletSet to a SIWxSigner so the dispatcher can offer Sign-In-With-X
 * to every payAndFetch caller.
 *
 * EVM is preferred when present — most live SIW-X declarers are EVM.
 * Returns null when no wallet can produce a signer; the dispatcher then
 * skips SIW-X wrapping (a transparent no-op).
 *
 * MUST NOT import v1-strategy or v2-strategy.
 */
import nacl from 'tweetnacl';
import type { SIWxSigner } from '@x402/extensions/sign-in-with-x';
import type { WalletSet } from '../adapters/types';
import { KEYPAIR_SYMBOL } from '../client/keypair-wallet';

/**
 * Map a WalletSet to a SIWxSigner for wrapFetchWithSIWx, or null when
 * neither wallet can sign SIW-X proofs.
 */
export function toSiwxSigner(wallets: WalletSet): SIWxSigner | null {
  // EVM first. A wallet with both an address and a signMessage method is
  // a valid EVMSigner — keypair wallets get signMessage from
  // createEvmKeypairWallet; browser wallets already have it.
  const evm = wallets.evm as
    | { address?: string; signMessage?: (a: { message: string }) => Promise<string> }
    | undefined;
  if (evm && typeof evm.signMessage === 'function' && typeof evm.address === 'string') {
    return {
      address: evm.address,
      signMessage: evm.signMessage,
    } as SIWxSigner;
  }

  // Solana fallback. The keypair behind KEYPAIR_SYMBOL holds the 64-byte
  // secret key; tweetnacl signs the SIW-X message bytes (Ed25519).
  const solana = wallets.solana as
    | (Record<symbol, unknown> & { publicKey?: { toBase58?: () => string } })
    | undefined;
  if (solana) {
    const keypair = solana[KEYPAIR_SYMBOL] as
      | { secretKey: Uint8Array; publicKey: { toBase58: () => string } }
      | undefined;
    if (keypair && keypair.secretKey && keypair.publicKey) {
      return {
        publicKey: keypair.publicKey,
        signMessage: async (message: Uint8Array): Promise<Uint8Array> =>
          nacl.sign.detached(message, keypair.secretKey),
      } as SIWxSigner;
    }
  }

  return null;
}
```

> **Implementer note:** Confirm `tweetnacl` is already a dependency
> (`grep tweetnacl package.json` / `node -e "require('tweetnacl')"`). The SDK
> uses `@solana/web3.js` whose `Keypair` is `tweetnacl`-backed, so `tweetnacl`
> is almost certainly already in the tree — if it is a transitive-only dep, add
> it as a direct dependency in this task and note it. Confirm the `Keypair`
> object exposes `.secretKey` (a 64-byte `Uint8Array`) — it does in
> `@solana/web3.js` 1.x; if the field name differs, adapt and report.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/payment/__tests__/siwx-signer.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/payment/siwx-signer.ts src/payment/__tests__/siwx-signer.test.ts package.json package-lock.json
git commit -m "feat(payment): WalletSet -> SIW-X signer adapter"
```

---

### Task 10.5-4: Dispatcher probes through the SIW-X-wrapped fetch

**Files:**
- Modify: `src/payment/dispatcher.ts`
- Modify: `src/payment/__tests__/dispatcher.test.ts`

**Context:** Today `payAndFetch` probes with bare `fetch`. After this task it
probes with `wrapFetchWithSIWx(fetch, signer)` when a SIW-X signer can be
derived. `wrapFetchWithSIWx` only acts on a 402 that declares
`extensions["sign-in-with-x"]` AND whose `supportedChains` includes the signer's
chain — otherwise it returns the original response unchanged. So:

- Merchant declares SIW-X → wrapper signs + retries → we get back a 200 (auth
  sufficed) or a payment 402 (auth done, now pay). Either way the rest of
  `payAndFetch` is unchanged: a non-402 returns `{ok:true}`, a 402 dispatches to
  v1/v2.
- Merchant declares no SIW-X → wrapper is a pass-through → behaviour identical
  to today.
- No signer derivable (`toSiwxSigner` returns null) → probe with bare `fetch`,
  identical to today.

`wrapFetchWithSIWx` is dynamically imported (it pulls in `siwe`/`jose`/`ajv`);
a static import would bloat every consumer that never touches SIW-X.

- [ ] **Step 1: Write the failing tests**

Add to `src/payment/__tests__/dispatcher.test.ts`, inside the `payAndFetch`
describe block:

```typescript
  it('probes with bare fetch and still pays when no SIW-X signer is derivable', async () => {
    // Empty wallet set -> toSiwxSigner returns null -> bare-fetch probe.
    // A v2 402 with no wallet to pay still surfaces a typed failure, not a crash.
    const mockFetch = vi.fn(async () => makeV2Response());
    vi.stubGlobal('fetch', mockFetch);
    const result = await payAndFetch(
      'https://example.com/api',
      { method: 'GET' },
      {},
      {},
    );
    // No wallet -> v2 strategy cannot pay -> typed failure (not no_payment_options:
    // the challenge WAS recognised). Accept any ok:false reason.
    expect(result.ok).toBe(false);
    expect(mockFetch).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('returns a non-402 SIW-X-authed response directly', async () => {
    // Simulates a merchant where SIW-X auth alone unlocks the resource:
    // the (wrapped) probe yields a 200, so payAndFetch returns it as ok:true
    // without any payment dispatch. With an empty wallet set the wrapper is
    // skipped, but a plain 200 from the probe must still pass straight through.
    const mockFetch = vi.fn(async () => new Response('{"authed":true}', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    const result = await payAndFetch('https://example.com/me', { method: 'GET' }, {}, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response.status).toBe(200);
    vi.unstubAllGlobals();
  });
```

> **Implementer note:** these tests exercise the no-signer path and the
> pass-through path deterministically without a network. A full
> live-SIW-X-handshake test is out of scope for unit tests — it is covered by
> Task 13's real-merchant verification against the QuickNode SIW-X endpoint.
> Do not mock the internals of `wrapFetchWithSIWx`.

- [ ] **Step 2: Run tests to verify they pass or fail as expected**

Run: `npx vitest run src/payment/__tests__/dispatcher.test.ts`
Expected: the two new tests describe behaviour that already partly holds (the
200 pass-through) and partly needs the new wiring. Note which fail; the 200
pass-through likely already passes, the no-signer probe test should pass once
Step 3 lands cleanly. If both already pass against current code, that is fine —
they are regression guards for this task; proceed to Step 3.

- [ ] **Step 3: Wire the SIW-X-wrapped probe into payAndFetch**

In `src/payment/dispatcher.ts`, add an import of the signer adapter and replace
the bare-`fetch` probe with a SIW-X-aware probe.

Add near the top imports:

```typescript
import { toSiwxSigner } from './siwx-signer';
```

Add a helper above `payAndFetch`:

```typescript
/**
 * Build the fetch used for the probe. When the WalletSet can produce a
 * SIW-X signer, the probe goes through @x402/extensions' wrapFetchWithSIWx,
 * which signs + retries Sign-In-With-X challenges and is a transparent
 * pass-through for everything else. When no signer is derivable, the bare
 * global fetch is used. wrapFetchWithSIWx is imported dynamically so
 * consumers that never hit SIW-X do not pay its bundle cost.
 */
async function buildProbeFetch(wallets: WalletSet): Promise<typeof fetch> {
  const signer = toSiwxSigner(wallets);
  if (!signer) return fetch;
  try {
    const mod = await import('@x402/extensions/sign-in-with-x');
    return mod.wrapFetchWithSIWx(fetch, signer) as typeof fetch;
  } catch {
    // If the extension cannot load, fall back to bare fetch — SIW-X
    // merchants will then fail their challenge, but payment still works.
    return fetch;
  }
}
```

In `payAndFetch`, replace the probe block. The current code is:

```typescript
  let probe: Response;
  try {
    // Probe with the original requestInit — body is guaranteed to be a
    // string-or-nullish by the guard above, so it is safe to re-send.
    probe = await fetch(url, { ...requestInit });
  } catch (err) {
```

Change it to:

```typescript
  let probe: Response;
  try {
    // Probe through a SIW-X-aware fetch — it signs Sign-In-With-X
    // challenges transparently and is a pass-through otherwise. Body is
    // guaranteed string-or-nullish by the guard above, safe to re-send.
    const probeFetch = await buildProbeFetch(wallets);
    probe = await probeFetch(url, { ...requestInit });
  } catch (err) {
```

Leave the non-string-body guard, the 402 dispatch loop, and everything else
untouched.

- [ ] **Step 4: Run the dispatcher tests + full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/payment/dispatcher.ts src/payment/__tests__/dispatcher.test.ts
git commit -m "feat(payment): payAndFetch probes through the SIW-X seam"
```

---

### Task 10.5-5: Export + publish 3.6.0

**Files:**
- Modify: `src/payment/index.ts`
- Modify: `src/client/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Re-export the new surface**

In `src/payment/index.ts`, add:

```typescript
export { toSiwxSigner } from './siwx-signer';
```

In `src/client/index.ts`, in the x402 version-seam export block, add
`toSiwxSigner` to the value export:

```typescript
export { payAndFetch, detectStrategy, toNetworkRef, toSiwxSigner } from '../payment';
```

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS — all tests including the new SIW-X tests.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `tsup` succeeds, exit 0.

- [ ] **Step 4: Confirm the new symbols are in the build**

Run: `grep -c "toSiwxSigner" dist/client/index.js dist/client/index.d.ts`
Expected: non-zero for both.

- [ ] **Step 5: Bump the version**

Run: `npm version minor --no-git-tag-version`
Expected: `v3.6.0` (3.5.0 → 3.6.0).

- [ ] **Step 6: Commit and publish**

```bash
git add src/payment/index.ts src/client/index.ts package.json
git commit -m "feat(payment): export SIW-X seam; release 3.6.0"
npm publish --access public
```

Expected: `+ @dexterai/x402@3.6.0`

- [ ] **Step 7: Verify on the registry**

Run: `npm view @dexterai/x402@3.6.0 version`
Expected: `3.6.0` (poll ~1 min for registry lag).

---

## Task 10.5-6: Rewire the verifier through the seam (dexter-api)

**Files:**
- Modify: `~/websites/dexter-api/src/tasks/verifier/payment.ts`
- Delete: `~/websites/dexter-api/src/tasks/verifier/siwx.ts`
- Modify: `~/websites/dexter-api/package.json`

**Context:** Task 10 (commit `0287a2d`) migrated `payment.ts` onto `payAndFetch`
but left two `TODO(plan-2):` comments deferring SIW-X. With the seam now handling
SIW-X, those comments are removed and the verifier's bespoke `siwx.ts` is deleted.

- [ ] **Step 1: Install the new SDK**

Run: `cd ~/websites/dexter-api && npm install @dexterai/x402@3.6.0`
Expected: `package.json` shows `@dexterai/x402@^3.6.0`.

- [ ] **Step 2: Remove the SIW-X deferral from payment.ts**

In `src/tasks/verifier/payment.ts`:
- Delete the `import { withSiwx } from './siwx.js';` line.
- Delete both `// TODO(plan-2):` comment blocks about SIW-X.
- Confirm nothing else references `withSiwx` (the SIW-X handling is now inside
  `payAndFetch`, which the file already calls).

- [ ] **Step 3: Delete the bespoke SIW-X module**

Run: `git rm src/tasks/verifier/siwx.ts`

- [ ] **Step 4: Check for other importers**

Run: `grep -rn "verifier/siwx" src/`
Expected: no output. If anything else imports it, migrate that caller the same
way (it should also be a `payAndFetch` consumer) — report if found.

- [ ] **Step 5: Drop the now-unused @x402/extensions dep if the verifier no longer uses it**

Run: `grep -rn "@x402/extensions" src/`
If `siwx.ts` was the only user, remove `@x402/extensions` from
`dexter-api/package.json` dependencies. If other files still use it, leave it.
Report which.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — clean.

- [ ] **Step 7: Confirm SIW-X is gone from the verifier and lives in the SDK**

Run: `grep -rn "siwx\|sign-in-with-x" src/tasks/verifier/`
Expected: no output (the verifier no longer mentions SIW-X — the SDK owns it).

- [ ] **Step 8: Commit**

```bash
cd ~/websites/dexter-api
git add -A
git commit -m "refactor(verifier): SIW-X handled by the @dexterai/x402 seam

Deletes the bespoke siwx.ts wrapper and the TODO(plan-2) deferral.
Sign-In-With-X is now handled inside payAndFetch for every caller,
not bolted onto this one call site. Bumps to @dexterai/x402@3.6.0."
```

---

## Self-Review

- **Spec coverage:** SIW-X discovered in the dispatcher (10.5-4) ✓; signer from
  the WalletSet for both chains (10.5-3) ✓; EvmWallet can sign messages (10.5-1)
  ✓; verifier loses its bespoke copy (10.5-6) ✓; published so dexter-api can
  consume it (10.5-5) ✓.
- **No placeholders:** every step has concrete code / commands.
- **Type consistency:** `toSiwxSigner` is the name in 10.5-3, 10.5-4, 10.5-5.
  `signMessage` is the method added in 10.5-1 and consumed in 10.5-3. `SIWxSigner`
  is imported from `@x402/extensions/sign-in-with-x` consistently.
- **Carry-forward:** Task 13's real-merchant verification must add the QuickNode
  SIW-X endpoint (`https://x402.quicknode.com/hype-mainnet/hypercore` or the Base
  one) as a live SIW-X check, since unit tests deliberately do not exercise the
  full handshake.
