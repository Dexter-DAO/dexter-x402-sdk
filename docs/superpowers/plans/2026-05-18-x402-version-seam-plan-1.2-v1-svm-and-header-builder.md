# Task 12b — v1-SVM Signing + buildV1PaymentHeader

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `@dexterai/x402` SDK fully owns x402 v1 payment construction — EVM AND
Solana — and exposes a standalone `buildV1PaymentHeader` so consumers that manage
their own fetch (like dexter-api's `x402Pay.ts` route) can get a v1 `X-PAYMENT`
header string without the upstream `x402` library.

**Architecture:** v1 SVM `exact` signing is a thin envelope around the SDK's
existing, tested v2 Solana adapter (`createSolanaAdapter().buildTransaction`) —
which already builds the exact 3-instruction partially-signed transaction the v1
SVM payload needs. The v1 header-construction logic currently inlined inside
`v1-strategy.ts`'s `pay()` (domain-check → sign → base64) is extracted into an
exported `buildV1PaymentHeader`; `pay()` then calls it. v1 SVM signing requires
a Solana RPC endpoint — the only new public-API surface (`solanaRpcUrl`).

**Tech Stack:** `@solana/web3.js` 1.x + `@solana/spl-token` (already SDK deps, via
the Solana adapter), viem (v1 EVM), vitest, tsup.

**Research basis:** `docs/superpowers/research/2026-05-18-v1-svm-exact-scheme.md` —
read it before implementing. Key facts: v1 SVM `exact` = a base64 v0 wire
transaction (3 instructions: SetComputeUnitLimit, SetComputeUnitPrice,
TransferChecked; fee payer = `extra.feePayer`; client partially signs the transfer
authority). The `X-PAYMENT` payload is
`{ x402Version:1, scheme:'exact', network:<bare>, payload:{ transaction:<base64> } }`.
The v2 `buildTransaction` already produces exactly that `serialized` base64.

---

## Current state — what is being changed

`src/payment/v1-strategy.ts` today:
- `signV1EvmPayment(wallet, option, wireNetwork)` — builds+signs the EVM EIP-3009 payload (KEEP, unchanged).
- `pay()` — for each challenge option: picks an EVM option (SVM is skipped at lines ~196-197 with "SVM v1 signing is not implemented"), budget-checks, domain-checks, calls `signV1EvmPayment`, base64-encodes to `X-PAYMENT`, builds a fresh request, fetches, maps the result.
- The header construction in `pay()` steps 3-5 (domain check, sign, base64) is INLINE — it will be extracted into `buildV1PaymentHeader`.

`PayAndFetchOptions` (in `src/payment/types.ts`): `{ maxAmountAtomic?, timeoutMs? }` —
gains an optional `solanaRpcUrl`.

The Solana adapter `src/adapters/solana.ts`: `createSolanaAdapter()` →
`buildTransaction(accept, wallet, rpcUrl?)` returns `{ serialized: string, ... }`
where `serialized` is the base64 v0 wire transaction. It is v1/v2-agnostic — it
already falls back to `accept.maxAmountRequired` when `accept.amount` is absent.
**Reused as-is. Do not modify the adapter.**

---

## File Structure

- Modify: `src/payment/types.ts` — add `solanaRpcUrl?` to `PayAndFetchOptions`; add the `V1PaymentHeader` result/error shape if needed.
- Create: `src/payment/v1-header.ts` — `buildV1PaymentHeader(...)`, the extracted EVM logic + the new SVM envelope.
- Modify: `src/payment/v1-strategy.ts` — `pay()` delegates header construction to `buildV1PaymentHeader`; remove the SVM skip; keep `signV1EvmPayment` (moved into `v1-header.ts`).
- Create: `src/payment/__tests__/v1-header.test.ts`.
- Modify: `src/payment/index.ts` + `src/client/index.ts` — export `buildV1PaymentHeader`.
- Modify: `package.json` — version bump to 3.7.0.

---

### Task 1: Add solanaRpcUrl to PayAndFetchOptions

**Files:**
- Modify: `src/payment/types.ts`
- Test: `src/payment/__tests__/types.test.ts` (only if one exists; otherwise this is a type-only change verified by tsc — skip the test step and note it)

- [ ] **Step 1: Add the field**

In `src/payment/types.ts`, in the `PayAndFetchOptions` interface, add:

```typescript
  /**
   * Solana RPC endpoint for v1 SVM payment signing. v1 Solana `exact`
   * signing builds a real transaction and needs RPC access (mint lookup,
   * recent blockhash). Ignored for EVM-only flows. Defaults to the public
   * Solana RPC when omitted — callers should pass their own for
   * reliability.
   */
  solanaRpcUrl?: string;
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. (No test — this is an additive optional field; the consuming
code in later tasks is what exercises it.)

- [ ] **Step 3: Commit**

```bash
git add src/payment/types.ts
git commit -m "feat(payment): solanaRpcUrl option for v1 SVM signing"
```

---

### Task 2: Extract buildV1PaymentHeader (EVM path)

**Files:**
- Create: `src/payment/v1-header.ts`
- Modify: `src/payment/v1-strategy.ts`
- Test: `src/payment/__tests__/v1-header.test.ts`

**Context:** Move `signV1EvmPayment`, `V1_AUTHORIZATION_TYPES`, `V1EvmPayment`,
and `randomNonce` from `v1-strategy.ts` into `v1-header.ts`. Add the exported
`buildV1PaymentHeader` that does: pick an option (by available wallet family),
budget-check, and for EVM — the domain check + `signV1EvmPayment` + base64. This
task handles EVM only; SVM is added in Task 3 (the SVM branch returns a
"not yet implemented" typed result in this task, replaced in Task 3).

`buildV1PaymentHeader` returns a typed result — never throws for an expected
failure — so `pay()` and external callers handle it uniformly:

```typescript
export type V1HeaderResult =
  | { ok: true; headerValue: string; option: ChallengeOption }
  | { ok: false; reason: 'unsupported_network' | 'budget_exceeded' | 'merchant_rejected' | 'error'; detail?: string };
```

- [ ] **Step 1: Write the failing test**

```typescript
// src/payment/__tests__/v1-header.test.ts
import { describe, it, expect } from 'vitest';
import { buildV1PaymentHeader } from '../v1-header';
import { createEvmKeypairWallet } from '../../client/evm-wallet';
import type { PaymentChallenge } from '../types';

const EVM_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// A v1 EVM challenge option for Base with a complete EIP-712 domain.
function evmChallenge(): PaymentChallenge {
  return {
    x402Version: 1,
    options: [
      {
        scheme: 'exact',
        network: { caip2: 'eip155:8453', bare: 'base', family: 'evm' },
        amount: '10000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x0000000000000000000000000000000000000001',
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
  };
}

describe('buildV1PaymentHeader — EVM', () => {
  it('builds a base64 X-PAYMENT header for a v1 EVM exact option', async () => {
    const evm = await createEvmKeypairWallet(EVM_KEY);
    const result = await buildV1PaymentHeader(evmChallenge(), { evm }, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Header is base64 of a JSON v1 PaymentPayload.
      const decoded = JSON.parse(
        Buffer.from(result.headerValue, 'base64').toString('utf8'),
      );
      expect(decoded.x402Version).toBe(1);
      expect(decoded.scheme).toBe('exact');
      // NO network rewrite — the wire network is the merchant's bare name.
      expect(decoded.network).toBe('base');
      expect(typeof decoded.payload.signature).toBe('string');
      expect(decoded.payload.authorization.to).toBe(
        '0x0000000000000000000000000000000000000001',
      );
    }
  });

  it('fails merchant_rejected when the EIP-712 domain is missing', async () => {
    const evm = await createEvmKeypairWallet(EVM_KEY);
    const ch = evmChallenge();
    ch.options[0].extra = {}; // no name/version
    const result = await buildV1PaymentHeader(ch, { evm }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('merchant_rejected');
  });

  it('fails budget_exceeded when amount exceeds maxAmountAtomic', async () => {
    const evm = await createEvmKeypairWallet(EVM_KEY);
    const result = await buildV1PaymentHeader(evmChallenge(), { evm }, {
      maxAmountAtomic: '1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('budget_exceeded');
  });

  it('fails unsupported_network when no wallet matches any option', async () => {
    const result = await buildV1PaymentHeader(evmChallenge(), {}, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_network');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/payment/__tests__/v1-header.test.ts`
Expected: FAIL — cannot find module `../v1-header`.

- [ ] **Step 3: Create v1-header.ts**

Move `V1_AUTHORIZATION_TYPES`, `V1EvmPayment`, `randomNonce`, and
`signV1EvmPayment` verbatim from `v1-strategy.ts` into a new `src/payment/v1-header.ts`
(keep their doc comments — especially the EIP-712 domain comment and the
no-network-rewrite comment). Then add:

```typescript
import type {
  PaymentChallenge,
  ChallengeOption,
  PayAndFetchOptions,
} from './types';
import type { WalletSet } from '../adapters/types';
import type { EvmWallet } from '../adapters/evm';

/** Result of building a v1 X-PAYMENT header value. Never thrown. */
export type V1HeaderResult =
  | { ok: true; headerValue: string; option: ChallengeOption }
  | {
      ok: false;
      reason:
        | 'unsupported_network'
        | 'budget_exceeded'
        | 'merchant_rejected'
        | 'error';
      detail?: string;
    };

/**
 * Build a v1 `X-PAYMENT` header value for one of a challenge's options.
 *
 * This is the v1 payment-construction seam: it picks the first option
 * whose chain family has a usable wallet, signs the v1 `exact` payload
 * (EIP-3009 for EVM; a partially-signed Solana transaction for SVM),
 * and base64-encodes the v1 PaymentPayload. It does NOT send a request —
 * the caller owns the fetch. payAndFetch's v1 strategy uses this; so do
 * external consumers that manage their own request flow.
 *
 * Returns a typed result; never throws for an expected failure.
 *
 * NO NETWORK REWRITE: the `network` field on the wire is the merchant's
 * advertised v1 bare name verbatim (option.network.bare).
 */
export async function buildV1PaymentHeader(
  challenge: PaymentChallenge,
  wallets: WalletSet,
  opts: PayAndFetchOptions,
): Promise<V1HeaderResult> {
  try {
    // Pick the first option whose chain family has a usable wallet.
    for (const option of challenge.options) {
      if (option.network.family === 'evm' && wallets.evm) {
        const evmWallet = (await wallets.evm) as EvmWallet;
        return await buildEvmHeader(option, evmWallet, opts);
      }
      if (option.network.family === 'svm' && wallets.solana) {
        // SVM implemented in Task 3.
        return {
          ok: false,
          reason: 'error',
          detail: 'v1 SVM signing not yet implemented',
        };
      }
    }
    return { ok: false, reason: 'unsupported_network' };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function buildEvmHeader(
  option: ChallengeOption,
  evmWallet: EvmWallet,
  opts: PayAndFetchOptions,
): Promise<V1HeaderResult> {
  // Budget check.
  if (opts.maxAmountAtomic !== undefined) {
    if (BigInt(option.amount) > BigInt(opts.maxAmountAtomic)) {
      return { ok: false, reason: 'budget_exceeded' };
    }
  }
  // The v1 challenge must carry the exact-scheme EIP-712 domain. A wrong
  // domain produces an unspendable signature, so it is never guessed.
  const extra = (option.extra ?? {}) as Record<string, unknown>;
  const domainName = extra.name;
  const domainVersion = extra.version;
  if (
    typeof domainName !== 'string' ||
    domainName.length === 0 ||
    typeof domainVersion !== 'string' ||
    domainVersion.length === 0
  ) {
    return {
      ok: false,
      reason: 'merchant_rejected',
      detail:
        'v1 challenge missing exact-scheme EIP-712 domain (extra.name / extra.version)',
    };
  }
  // NO network rewrite — wire network is the merchant's advertised bare name.
  const wireNetwork = option.network.bare;
  const payment = await signV1EvmPayment(evmWallet, option, wireNetwork);
  const headerValue = Buffer.from(
    JSON.stringify(payment),
    'utf8',
  ).toString('base64');
  return { ok: true, headerValue, option };
}
```

- [ ] **Step 4: Rewire v1-strategy.ts to use buildV1PaymentHeader**

In `src/payment/v1-strategy.ts`:
- Delete `V1_AUTHORIZATION_TYPES`, `V1EvmPayment`, `randomNonce`, `signV1EvmPayment` (now in `v1-header.ts`).
- Import `buildV1PaymentHeader` from `./v1-header`.
- In `pay()`, replace steps 1-5 (option pick, budget check, domain check, sign,
  base64) with a single `buildV1PaymentHeader(challenge, wallets, opts)` call.
  Map its `V1HeaderResult` to `PayResult`: on `ok:false`, return
  `{ ok:false, reason: <map>, detail }` (the `V1HeaderResult` reasons are a
  subset of `PayResult` reasons — `unsupported_network`, `budget_exceeded`,
  `merchant_rejected`, `error` all exist on `PayResult` — pass through directly).
  On `ok:true`, use `result.headerValue` for the `X-PAYMENT` header and
  `result.option` for the post-response `amountPaid`/`network`.
- Keep steps 6-7 (fresh request build, fetch, `decodeTxSignature`, result
  mapping) exactly as they are.
- `pay()` must still never throw.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green (the v1-header tests pass; existing v1-strategy tests still
pass since behaviour is unchanged for EVM); tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/payment/v1-header.ts src/payment/v1-strategy.ts src/payment/__tests__/v1-header.test.ts
git commit -m "refactor(payment): extract buildV1PaymentHeader (EVM)"
```

---

### Task 3: v1 SVM signing in buildV1PaymentHeader

**Files:**
- Modify: `src/payment/v1-header.ts`
- Test: `src/payment/__tests__/v1-header.test.ts`

**Context:** Replace the SVM "not yet implemented" branch with a real
implementation that reuses the v2 Solana adapter. Per the research note: the v2
adapter's `buildTransaction(accept, wallet, rpcUrl?)` already builds the exact
partially-signed 3-instruction transaction v1 SVM needs and returns
`{ serialized }` (base64 wire transaction). The v1 SVM job is purely the
envelope.

The adapter expects an `accept` object shaped like a v2/x402 `PaymentAccept`
(it reads `accept.network`, `accept.asset`, `accept.payTo`, `accept.amount`
falling back to `accept.maxAmountRequired`, `accept.extra.feePayer`). The v1
strategy carries a `ChallengeOption` (`{ scheme, network: NetworkRef, amount,
asset, payTo, maxTimeoutSeconds, extra }`). Build the `accept` the adapter wants
from the `ChallengeOption`: `network` must be the BARE name (`option.network.bare`),
`amount`/`maxAmountRequired` from `option.amount`, `asset`/`payTo`/`extra` direct.
Read `src/adapters/solana.ts` `buildTransaction` to confirm the exact field
names it reads before constructing the input — do not guess; match what the
adapter actually destructures.

- [ ] **Step 1: Write the failing test**

```typescript
// add to src/payment/__tests__/v1-header.test.ts
import { createKeypairWallet } from '../../client/keypair-wallet';

// A deterministic throwaway 64-byte Solana secret key. The exact bytes
// must form a valid keypair — generate one and paste it, do NOT use an
// arithmetic sequence (Keypair.fromSecretKey validates the pubkey half).
// Implementer: run `node -e "console.log(JSON.stringify([...require('@solana/web3.js').Keypair.generate().secretKey]))"`
// once and paste the result here.
const SOL_KEY: number[] = [/* implementer: paste a generated 64-byte key */];

describe('buildV1PaymentHeader — SVM', () => {
  it('fails error when a v1 SVM option omits extra.feePayer', async () => {
    const solana = await createKeypairWallet(SOL_KEY);
    const ch: PaymentChallenge = {
      x402Version: 1,
      options: [
        {
          scheme: 'exact',
          network: { caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', bare: 'solana', family: 'svm' },
          amount: '10000',
          asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          payTo: '11111111111111111111111111111111',
          maxTimeoutSeconds: 60,
          extra: {}, // no feePayer
        },
      ],
    };
    const result = await buildV1PaymentHeader(ch, { solana }, {});
    expect(result.ok).toBe(false);
    // feePayer is mandatory for v1 SVM — fail with a clear typed result.
    if (!result.ok) {
      expect(result.reason).toBe('merchant_rejected');
      expect(result.detail).toMatch(/feePayer/i);
    }
  });
});
```

> **Implementer note:** a full end-to-end "builds a valid SVM header" unit test
> needs live Solana RPC (mint lookup + blockhash) and funded ATAs — that is NOT
> a unit test. It is covered by Task 12c's real-merchant verification. The unit
> test here covers the deterministic, offline-checkable failure (missing
> `feePayer`). If you can construct a meaningful adapter-level test with a mocked
> RPC without it becoming a brittle internal-mock, add it — but do NOT mock the
> adapter's internals just to manufacture a green test. The missing-feePayer
> path is the honest unit-level coverage; the happy path is Task 12c's job.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/payment/__tests__/v1-header.test.ts`
Expected: the new SVM test FAILS (current branch returns
`reason:'error', detail:'v1 SVM signing not yet implemented'`, not the
feePayer-specific `merchant_rejected`).

- [ ] **Step 3: Implement the SVM branch**

Read `src/adapters/solana.ts` `buildTransaction` first — confirm the exact
`accept` field names and the `SolanaWallet` interface it needs. Confirm a
keypair wallet from `createKeypairWallet` satisfies `isSolanaWallet` /
`SolanaWallet` (it should — `createKeypairWallet` builds a `SolanaWallet`).

In `v1-header.ts`, add a `buildSvmHeader` and call it from the SVM branch of
`buildV1PaymentHeader`:

```typescript
import { createSolanaAdapter } from '../adapters';
import type { SolanaWallet } from '../adapters/solana';

async function buildSvmHeader(
  option: ChallengeOption,
  solanaWallet: SolanaWallet,
  opts: PayAndFetchOptions,
): Promise<V1HeaderResult> {
  // Budget check.
  if (opts.maxAmountAtomic !== undefined) {
    if (BigInt(option.amount) > BigInt(opts.maxAmountAtomic)) {
      return { ok: false, reason: 'budget_exceeded' };
    }
  }
  // v1 SVM exact is unsignable without the facilitator fee payer.
  const extra = (option.extra ?? {}) as Record<string, unknown>;
  if (typeof extra.feePayer !== 'string' || extra.feePayer.length === 0) {
    return {
      ok: false,
      reason: 'merchant_rejected',
      detail: 'v1 SVM challenge missing extra.feePayer (required as the transaction fee payer)',
    };
  }
  // The v2 Solana adapter already builds the exact 3-instruction
  // partially-signed transaction v1 SVM exact requires; it is v1/v2-agnostic
  // (falls back to maxAmountRequired). Reuse it; wrap the serialized wire
  // transaction in the v1 PaymentPayload envelope.
  //
  // NO network rewrite — the wire network is the merchant's bare name.
  const wireNetwork = option.network.bare;
  const accept = {
    scheme: option.scheme,
    network: wireNetwork,
    asset: option.asset,
    payTo: option.payTo,
    amount: option.amount,
    maxAmountRequired: option.amount,
    maxTimeoutSeconds: option.maxTimeoutSeconds,
    extra,
  };
  const adapter = createSolanaAdapter();
  // buildTransaction does the RPC work (mint lookup, blockhash) and returns
  // { serialized } — the base64 v0 wire transaction.
  const built = await adapter.buildTransaction(
    accept as never,
    solanaWallet,
    opts.solanaRpcUrl,
  );
  const payment = {
    x402Version: 1,
    scheme: option.scheme,
    network: wireNetwork,
    payload: { transaction: built.serialized },
  };
  const headerValue = Buffer.from(
    JSON.stringify(payment),
    'utf8',
  ).toString('base64');
  return { ok: true, headerValue, option };
}
```

Then in `buildV1PaymentHeader`, replace the SVM stub branch:

```typescript
      if (option.network.family === 'svm' && wallets.solana) {
        const solanaWallet = (await wallets.solana) as SolanaWallet;
        return await buildSvmHeader(option, solanaWallet, opts);
      }
```

> **Implementer:** verify the `accept as never` cast — if the adapter exports a
> proper `PaymentAccept` type, import and use it instead of `never`. The cast is
> a fallback only if the adapter's input type is not cleanly importable. Match
> the adapter's real expected shape; the field list above is from the research
> note — confirm against `solana.ts`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/payment/v1-header.ts src/payment/__tests__/v1-header.test.ts
git commit -m "feat(payment): v1 SVM exact signing via the Solana adapter"
```

---

### Task 4: Export buildV1PaymentHeader + publish 3.7.0

**Files:**
- Modify: `src/payment/index.ts`, `src/client/index.ts`, `package.json`

- [ ] **Step 1: Export from the payment barrel**

In `src/payment/index.ts` add:

```typescript
export { buildV1PaymentHeader } from './v1-header';
export type { V1HeaderResult } from './v1-header';
```

- [ ] **Step 2: Export from the client barrel**

In `src/client/index.ts`, in the x402 version-seam export block, add
`buildV1PaymentHeader` to the value export and `V1HeaderResult` to the type
export.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: PASS — all tests.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: `tsup` succeeds, exit 0.

- [ ] **Step 5: Confirm the symbol is in the build**

Run: `grep -c "buildV1PaymentHeader" dist/client/index.js dist/client/index.d.ts`
Expected: non-zero for both.

- [ ] **Step 6: Version bump**

Run: `npm version minor --no-git-tag-version`
Expected: `v3.7.0`.

- [ ] **Step 7: Commit and publish**

```bash
git add src/payment/index.ts src/client/index.ts package.json
git commit -m "feat(payment): export buildV1PaymentHeader; release 3.7.0"
npm publish --access public
```

> **PAUSE:** confirm with the orchestrator before `npm publish` — publishing is
> outward-facing and irreversible. (The orchestrator handles the publish gate.)

- [ ] **Step 8: Verify on the registry**

Run: `npm view @dexterai/x402@3.7.0 version`
Expected: `3.7.0` (poll ~1 min for registry lag).

---

## Self-Review

- **Spec coverage:** `solanaRpcUrl` option (T1) ✓; `buildV1PaymentHeader` extracted,
  EVM path, `pay()` rewired (T2) ✓; v1 SVM signing via the adapter (T3) ✓;
  exported + published (T4) ✓.
- **No placeholders:** the one deliberate gap is `SOL_KEY` in the T3 test — the
  implementer must generate and paste a real 64-byte key (instruction given
  inline). Everything else is concrete.
- **Type consistency:** `buildV1PaymentHeader`, `V1HeaderResult`, `buildEvmHeader`,
  `buildSvmHeader` used consistently. `V1HeaderResult` reasons are a subset of
  `PayResult` reasons so the `v1-strategy.ts` mapping is a pass-through.
- **No network rewrite:** both `buildEvmHeader` and `buildSvmHeader` use
  `option.network.bare` for the wire `network` — the load-bearing invariant
  from the original v1-strategy is preserved in both paths.
- **Carry-forward:** Task 12c (dexter-api `x402Pay.ts` migration) consumes
  `buildV1PaymentHeader@3.7.0`. Task 13's real-merchant verification must include
  a live v1-SVM merchant — the v1 SVM happy path is not unit-tested (needs RPC +
  funded ATAs), so the live check is its real coverage.
