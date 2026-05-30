# Tab streaming — OTS-backed streaming payments in @dexterai/x402

**Status:** Design accepted. Skeleton in `src/tab/` defines the contract; phased implementation tracked in this doc.

**Date:** 2026-05-30

**Audience:** SDK contributors, x402 partners (MoonPay, Coinbase, etc.) reading this to understand where streaming sits in the ecosystem.

---

## 1. The hole this fills

The SDK today has two payment modalities and they sit at two ends of an axis:

| Subpath | Settlement model | What it's for |
|---|---|---|
| `@dexterai/x402` (default) | One request, one on-chain settlement | Single-shot paid API call |
| `@dexterai/x402/batch-settlement` | Many discrete requests, one channel, one close-out claim | API calls amortized over a session |
| **`@dexterai/x402/tab` (new)** | **Continuous metered consumption, settled on close** | **Streamed deliverables: tokens, MB, RPC calls, seconds** |

The middle modality (batch-settlement) is for **N discrete charges**. The new modality is for **continuous consumption**, where the unit of billing is smaller than a request and where there is no "natural" request boundary at all — a token, a byte, a frame, a millisecond.

The `batch-settlement/index.ts` module comment already calls this out verbatim:

> This is NOT a streaming primitive. Dexter's streaming product is Tab/OTS, a separate project.

This document specifies that separate project as a peer module under the same SDK.

## 2. Why streaming matters

A non-exhaustive list of use cases that require continuous metered billing and that today have no payment rail:

- **Per-token LLM inference.** A single token at GPT-4 prices is ~$0.00003. No payment rail clears $0.00003 economically. The only existing options are (a) a flat sub or (b) post-paid invoice with a credit card on file. Both require trust and KYC.
- **Pay-per-call RPC.** Solana RPC, Helius, QuickNode, Alchemy — all bill via API keys and monthly invoices. A pay-as-you-go customer can't onboard in seconds.
- **Live data feeds.** Pyth, Birdeye, Helius streams — billed by connection-hour today, billed by *bytes-while-connected* tomorrow.
- **GPU/compute time rental.** Fine-tuning by the minute. Render by the frame.
- **Bandwidth/CDN per MB delivered.** Today enterprise-only because micropayments-per-MB don't clear.

All of these share the same shape:
- Many tiny charges, continuously, over a single session
- One buyer paying one seller over an open authorization
- Latency-critical (verifying each unit can't make an RPC round-trip)
- The buyer wants to **walk away mid-session**; the seller wants to **claim what's owed**
- Custody is a non-starter — the buyer can't escrow $1000 to consume $0.40

That is the exact problem profile of OTS. Tab streaming is the SDK module that makes the protocol usable for these workloads.

## 3. The public surface

### 3.1 Buyer side (mirrors `openBatchChannel` shape)

```ts
import { openTab } from '@dexterai/x402/tab';

const tab = await openTab({
  vault: vaultAdapter,         // OTS vault adapter (Solana adapter ships first)
  network: 'solana:mainnet',
  seller: 'https://api.example.com',
  perUnitCap: '0.001',         // safety: max per voucher (sub-cent OK)
  totalCap: '5.00',            // safety: max cumulative for this tab
});

// Streaming request — returns an async iterable. Each chunk has a voucher
// behind it; the voucher is signed before the chunk is delivered to the
// caller so the seller is paid for what they've already served.
const stream = await tab.stream('https://api.example.com/inference', {
  method: 'POST',
  body: JSON.stringify({ prompt: 'Hello' }),
});

for await (const chunk of stream) {
  process.stdout.write(chunk);
}

await tab.close();             // settles cumulative voucher on chain via facilitator
```

Mental model: same as `openBatchChannel`. Two new concepts:
- **`perUnitCap`**: limits any single voucher's incremental amount. The seller can't claim "you owe me a dollar" for one byte.
- **`stream()`**: returns an `AsyncIterable<Uint8Array>` rather than a `Response`. The voucher accrual is internal.

### 3.2 Seller side (`@dexterai/x402/tab/seller`)

```ts
import { tabMiddleware, openSse } from '@dexterai/x402/tab/seller';

app.post('/inference',
  tabMiddleware({
    perToken: '0.00003',
    network: 'solana:mainnet',
    settle: 'on-close',          // or 'periodic' for long-running streams
    facilitator: 'https://facilitator.dexter.cash',
  }),
  async (req, res) => {
    const tab = req.tab;          // injected by middleware
    const meter = openSse(res, tab);
    for await (const token of llm(req.body.prompt)) {
      await meter.charge(1);      // signs cumulative voucher
      meter.send(token);          // emits SSE event to buyer
    }
    meter.end();                  // closes the SSE stream, NOT the tab
  }
);
```

Seller mental model: "charge for what I serve." Voucher management is internal. The seller never touches `pending_voucher_count` directly; that's facilitator work.

### 3.3 React (`useTab()` hook in `@dexterai/x402/react`)

```tsx
import { useTab } from '@dexterai/x402/react';

function Chat() {
  const { tab, open, close, state } = useTab({ vault, seller, perUnitCap });
  return (
    <>
      <button onClick={open}>Start chat</button>
      <StreamUi tab={tab} />
      <button onClick={close}>Close tab — settle ${state.spentUsd}</button>
    </>
  );
}
```

Wraps the buyer-side `openTab` with reactive state.

## 4. Architectural contract

### 4.1 The vault adapter

`vault: VaultAdapter` is the abstraction that lets one SDK call site serve OTS on every chain. The adapter shape:

```ts
interface VaultAdapter {
  network: ChainId;
  swigAddress: string;               // wallet that holds funds
  vaultPda: string;                  // gate account holding pending_voucher_count
  // ROOT signer — invoked once per session to mint a session key (§4.2).
  // The browser path goes through WebAuthn (one Touch ID). The CLI path
  // signs with @noble/curves/p256 directly.
  authorizeSession(scope: SessionScope): Promise<SessionKey>;
  // SESSION signer — invoked many times per tab, freely, after the session
  // is authorized. Cheap, prompt-less, scope-limited.
  signWithSession(session: SessionKey, payload: VoucherPayload): Promise<SignedVoucher>;
  signOpenTab(session: SessionKey, channelId: string): Promise<SignedOpenTab>;
  signCloseTab(session: SessionKey, channelId: string, cumulativeAmount: bigint): Promise<SignedCloseTab>;
}
```

On the Solana adapter, `authorizeSession` uses the passkey (P-256 / secp256r1) via WebAuthn in browser, or via `@noble/curves/p256` in CLI/Node. The on-chain program does not care which path the signature came from — it verifies the curve math against the registered pubkey.

### 4.2 The session-key layer (the Touch-ID-per-token fix)

> **Canonical on-chain spec:** the source of truth for the session-key on-chain instruction format, account layout, and program semantics is [`dexter-vault/docs/DESIGN-vault-v2-session-keys.md`](https://github.com/Dexter-DAO/dexter-vault/blob/main/docs/DESIGN-vault-v2-session-keys.md). This section describes the layer from the SDK's perspective; if anything here drifts from the on-chain spec, the on-chain spec wins. Public tracking: [Dexter-DAO/dexter-vault#4](https://github.com/Dexter-DAO/dexter-vault/issues/4).

OTS as the on-chain spec defines passkey-as-root-authority. That's correct, but at the browser-UX layer it would mean a biometric prompt per voucher, which is unusable. **The protocol layered on top of the spec is: the passkey authorizes a session key once per tab; the session key signs every voucher during the stream; the session key dies when the tab closes.**

This pattern — infrequent expensive cryptography (the passkey) authorizing frequent cheap cryptography (the session key) — is standard practice in modern wallet design. Apple Pay does it. Ethereum's ERC-4337 session keys do it. SSH agent forwarding does it. The Swig smart-wallet program that OTS already depends on natively supports scoped, time-limited, amount-capped secondary signers. The on-chain primitive is *already there*; OTS-tab is the protocol that uses it.

#### Session scope

A session is authorized at tab-open time with these limits:

```ts
interface SessionScope {
  channelId: string;          // bound to this specific tab
  maxAmountAtomic: bigint;    // cumulative cap (e.g. $1.00 of USDC)
  expiresAtUnix: number;      // wall-clock expiry (e.g. now + 1 hour)
  allowedCounterparty: string; // the seller's address
}

interface SessionKey {
  publicKey: Uint8Array;      // ed25519 or secp256k1 — cheap to sign with
  privateKey: Uint8Array;     // lives in memory ONLY, never persisted
  scope: SessionScope;
}
```

A session key is just an ordinary keypair generated in browser memory (or in Node memory for CLI). Its authorization isn't in the key itself — it's in the fact that the buyer's passkey signed a registration message saying "from now until `expiresAtUnix`, this session pubkey is allowed to act for this vault, up to `maxAmountAtomic`, only with `allowedCounterparty`."

#### How the seller verifies a voucher

A voucher signed by the session key, presented to the seller, contains:

```
{
  channelId,
  cumulativeAmount,
  sequenceNumber,
  sessionPubkey,          // which session signed this
  sessionRegistration,    // the passkey-signed authorization for that session
  sessionSignature,       // the session-key signature over (channelId, amount, seq)
}
```

The seller's middleware verifies:
1. `sessionSignature` is valid for `sessionPubkey` over the voucher contents
2. `sessionRegistration` is valid (passkey signature, recognized vault root)
3. `cumulativeAmount <= sessionRegistration.maxAmountAtomic`
4. `now < sessionRegistration.expiresAtUnix`
5. Seller's address matches `sessionRegistration.allowedCounterparty`

All five checks are local — no chain calls, microsecond latency. The seller delivers nothing without all five checks passing.

#### Why this is safe even if the session key leaks

The session key is short-lived, capped, and counterparty-bound. A leaked session key can spend up to the scope already authorized, with the seller already configured, before the expiry already set. It cannot drain the vault. It cannot rotate the passkey. It cannot open new tabs with a different seller. The blast radius of leakage is "the buyer was going to spend up to $1 with this seller anyway." That's why this pattern works in production wallets — the cost of leakage is bounded by the scope.

#### Implications for the on-chain program

The OTS vault program needs an instruction (or instruction args) recognizing session-key signatures on `settle_voucher` and `request_withdrawal`. Specifically:
- `settle_voucher` already takes the recorded `dexter_authority` signature; this is unchanged. The session key never touches `settle_voucher` directly — it signs vouchers off-chain, which the facilitator then aggregates.
- `request_withdrawal` today requires the passkey directly. To allow session-key-driven withdrawals (e.g. an agent reclaiming unspent funds at end of session), the program needs to also accept session signatures bound by a registration. Optional — the conservative path is "withdrawal stays passkey-only, session keys only sign off-chain vouchers."

The conservative path is the right v1. Session keys touch only the off-chain protocol. The on-chain program is unchanged. Phase 1.5 (below) adds session-key recognition to the on-chain program when there's a concrete reason to extend it.

### 4.3 Model 2: seller-demands-signature-before-delivery (no penny of loss)

The voucher cadence question I waffled on earlier resolves cleanly with session keys: **the seller never delivers a chunk without a fresh signed IOU in hand**. Session-key signatures are cheap (microseconds, no prompts), so demanding one per chunk has no UX cost. The seller's worst-case loss on disconnect is zero — they only deliver what's been paid for.

The cadence question becomes: how big is "one chunk"? Tokens? Sentences? Bytes? That's a parameter the seller picks based on their delivery model. For LLM streams, "per token" is fine; for video, "per N-frame buffer" is fine; for RPC, "per call" is fine. The SDK ships with sensible defaults but the seller's middleware accepts a `chargeUnit` override.

### 4.4 EVM parity, via the same VaultAdapter interface

When EVM vault parity ships, an `EvmVaultAdapter` slots into the same `VaultAdapter` interface — including `authorizeSession` and `signWithSession`. The SDK call site is unchanged. The session-key layer translates cleanly: EVM-side, the session key is a regular EOA, authorized by the passkey-controlled smart account via an ERC-4337 session-key validator module. Same scope semantics, same expiry, same counterparty binding. **This is the architectural promise of the OpenDexter strategy doc, made concrete in code.**

### 4.5 What the seller can and cannot do

The seller's middleware:
- VERIFIES vouchers locally (no chain calls, microsecond latency) — the five-check list in §4.2
- ACCUMULATES the cumulative-amount voucher across stream chunks
- PERSISTS the latest signed voucher (so a process crash doesn't lose the last second's work)
- ON CLOSE: posts the cumulative voucher to the facilitator for on-chain settle

The seller's middleware does NOT:
- Open the tab on chain (the buyer's `openTab()` does that)
- Decrement `pending_voucher_count` (only the facilitator authority can)
- Move buyer funds (only the buyer's passkey can authorize withdrawal)

### 4.6 What the facilitator does

The facilitator is a *paid service surface*, not part of the SDK. The SDK posts to a facilitator URL the developer configures (defaults to `https://facilitator.dexter.cash`, overridable per call). The facilitator:
- Receives the close-time cumulative voucher
- Calls `settle_voucher(amount, increment: false)` with the recorded `dexter_authority` key
- Returns the on-chain signature

A self-hosting seller can run their own facilitator using the open vanilla version of the code — with their own `dexter_authority` key, recorded on the vaults *they* manage. The Dexter-operated facilitator stays private-source (proprietary monitoring, fraud detection, batching). The on-chain protocol is open; the operator runtime can be either.

### 4.7 The seller-protection invariant, surfaced via the SDK

While `tab.close()` has not yet posted on-chain settle, the buyer's `request_withdrawal` against the vault is **rejected on chain** with `PendingVouchersExist`. This is the OTS guarantee. The SDK does not enforce it — the program does. The SDK simply exposes it: a buyer who runs `tab.close()` and then tries `vault.withdraw()` will see the rejection cleanly returned from `vault.withdraw()`.

The reference example (§5) demonstrates this end-to-end.

## 5. The reference example (`examples/`)

Two files, both runnable on mainnet:

### 5.1 `examples/server-tab-llm.ts`

A small Express server that wraps a local Ollama (or OpenAI passthrough; choice via env var) and serves per-token-billed inference via `tabMiddleware`. Configurable per-token price, model, port. Runs as-is on the EC2 if Ollama is installed, otherwise points to an OpenAI key.

### 5.2 `examples/client-tab-streaming.ts`

A CLI buyer that:
1. Loads a P-256 keypair from `~/.dexter/tab-demo-key` (generated on first run via `@noble/curves`)
2. If no vault exists for that keypair, enrolls one on mainnet
3. Loads $1 USDC into the vault from the demo treasury (or prompts the user to deposit)
4. Opens a tab against the server from §5.1
5. Streams a prompt's worth of tokens, prints them to stdout as they arrive
6. Tries `vault.withdraw()` mid-stream — prints the rejection
7. Closes the tab — prints the settlement signature
8. Retries `vault.withdraw()` — succeeds
9. Prints a story-shaped log of every step with Solscan links

This is the artifact MoonPay / Coinbase / other partners actually want to see. It shows OTS as the missing payment layer for AI, not as a Solana program in isolation.

### 5.3 Why these two files together are the demo

The story reads:

```
$ node examples/client-tab-streaming.ts
[1] Loaded buyer keypair: pub=2a7f... (P-256)
[2] Vault: 7FE9... enrolled (tx abc...)
[3] Tab opened against http://localhost:4444/inference (tx def...)
[4] Streaming tokens:
    The quick brown fox jumped over the lazy dog because it had nothing else to do.
[5] Tokens delivered: 18 · cumulative voucher: $0.00054
[6] Attempting mid-stream withdrawal...
    REJECTED: PendingVouchersExist (this is the seller-protection invariant)
[7] Closing tab — settling $0.00054 on chain (tx ghi...)
[8] Retrying withdrawal: SUCCESS (tx jkl...)
[9] Done. All txs on mainnet:
    enroll:    https://solscan.io/tx/abc...
    open:      https://solscan.io/tx/def...
    settle:    https://solscan.io/tx/ghi...
    withdraw:  https://solscan.io/tx/jkl...
```

That's a real LLM-inference-by-token payment, on mainnet, with on-chain rejection of a mid-stream drain attempt, in nine lines of output. That is the demo that lands.

## 6. Phased implementation

Each phase ships a real artifact. Each is independent enough to be merged on its own.

### Phase 1 — Contract lock

- Create `src/tab/index.ts` with all the public types from §3 and §4.2 and `openTab` declared but throwing `not_implemented`.
- Create `src/tab/seller/index.ts` likewise.
- Add the subpath exports to `package.json`.
- Add the import to the SDK README ("coming: `@dexterai/x402/tab` for streamed metered payments").
- The skeleton compiles. The shape can't drift.

### Phase 1.5 — Session-key sub-authority in the vault program (dexter-vault)

This is a parallel, on-chain track. It's the substrate that the SDK's session-key flow rides on. The two phases can land in either order — Phase 1.5 unblocks browser-native streaming UX.

- Define a `register_session_key` instruction (or equivalent) in the vault program. Accepts: passkey signature over `(sessionPubkey, channelId, maxAmountAtomic, expiresAtUnix, allowedCounterparty)`. Records the registration on the vault account.
- Define recognition of session-key signatures on `settle_voucher` (via the OTS off-chain path, this is unchanged) — vouchers verify off-chain against the registration, the facilitator presents the aggregate.
- The conservative v1 keeps `request_withdrawal` passkey-only. Future work can extend to session-key-driven withdrawals if a real use case emerges.
- Mainnet deploy as a new vault program version (10th instruction). Update OTS-STANDARDS-PROPOSAL.md to specify the session-key registration format.

### Phase 2 — Buyer side (Solana adapter, real, session-key-aware)

- `SolanaVaultAdapter` implementation:
  - `authorizeSession()` — uses passkey via WebAuthn in browser, via `@noble/curves/p256` in Node, signs the session-key registration message.
  - `signWithSession()` — uses the session-key (in-memory ed25519 or secp256k1, generated at tab-open time).
- `openTab()`:
  - Generates an ephemeral session keypair in memory.
  - Calls `authorizeSession()` once (one Touch ID in browser; instant in CLI).
  - Calls dexter-api to post on-chain settle_voucher(+1).
- `tab.stream()` does HTTP + per-chunk voucher signing via `signWithSession()`. No Touch ID.
- `tab.close()` posts cumulative voucher to facilitator, which settles on chain. Discards the session key.

### Phase 3 — Seller middleware

- `tabMiddleware()` — verifies vouchers locally, persists state, exposes `req.tab`.
- `openSse()` helper — turns an Express response into an SSE stream tied to a tab.
- Failure modes: voucher-not-incrementing, cap-exceeded, signature-invalid, buyer-disconnected. All handled cleanly.

### Phase 4 — Reference example

- The two files in §5.
- Polished output, comments good enough that a reader following along learns OTS.

### Phase 5 — React hook

- `useTab()` in `src/react/useTab.ts`.

### Phase 6 — EVM vault adapter

- New, separate effort, dependent on EVM OTS vault primitives shipping. The SDK call site is unchanged.

## 7. Resolved defaults + open questions

Most of the original open questions resolved cleanly once the session-key layer (§4.2) was added. Captured here for the record:

1. ~~Voucher transport.~~ **Resolved by §4.2 + §4.3.** Per-chunk voucher signed by the session key. Cheap (microseconds), no Touch ID, seller demands signature before delivery. Zero seller loss on disconnect.

2. **What model does the LLM example use.** Local Ollama (cleanest, no API key) vs. OpenAI passthrough (impressive at low effort) vs. own small model. Default: **local Ollama**, with OpenAI as a one-line env var swap.

3. **CLI vs. browser-first for the example.** CLI is more compelling for developers; browser is more shareable on Twitter. Default: **ship CLI first as `examples/client-tab-streaming.ts`**, follow up with a browser demo on a Dexter property.

4. ~~Where does the facilitator URL live in config.~~ **Resolved.** Per-call with a default of `https://facilitator.dexter.cash`, overridable. Matches batch-settlement's pattern.

5. **Recovery semantics for a stranded tab.** If the buyer's process crashes mid-stream, the tab is still open on chain. Force-release after grace handles this. The SDK should expose a `resumeTab(channelId)` analogous to `resumeBatchChannel`. Default: **yes, ship `resumeTab()` in Phase 2.**

6. **Off-chain voucher persistence on the seller.** Memory only (lose state on restart) vs. file vs. Redis. Default: **pluggable VoucherStore, file-backed default, matching batch-settlement's ChannelStore.**

7. **Session-key lifetime defaults.** Tab opens with a session-key valid for 1 hour OR `maxAmountAtomic`, whichever expires first. Both overridable per `openTab()` call. Aggressive limits are the buyer's first defense against a stolen session.

8. **Session-key persistence.** In-memory only. **Never persisted to disk.** A crashed process forfeits the session and re-prompts the passkey on next attempt. This is the right default because a leaked session key on disk is a real attack surface; the cost of re-authorizing is one Touch ID.

## 8. What this means for the OTS pitch

A working `@dexterai/x402/tab` plus the LLM-streaming reference example turns the OTS pitch from a Solana program with a security model into a usable payment rail for AI infrastructure. Specifically:

- MoonPay/Coinbase/other partners get a 9-line buyer snippet they can paste into their next dev memo.
- The README turns into "OTS is the streaming case; here's `openTab()`."
- Any future EVM vault parity work has a concrete API contract to satisfy — there's no ambiguity about what "EVM parity" means at the SDK level.
- The strategy doc's "two distributions over the same primitive" claim becomes literally true in code, not just an architectural assertion.

## 9. Where this lives

- Design doc: `dexter-x402-sdk/docs/DESIGN-tab-streaming.md` (this file)
- Skeleton: `dexter-x402-sdk/src/tab/`, `dexter-x402-sdk/src/tab/seller/`
- Reference example: `dexter-x402-sdk/examples/client-tab-streaming.ts`, `dexter-x402-sdk/examples/server-tab-llm.ts`
- Tracked in the dexter-facilitator task list as #118 (split into sub-tasks as phases land).

---

**Decision needed before starting Phase 1:** none. Shape is locked. Open questions in §7 can be resolved as Phase 2 work surfaces them.
