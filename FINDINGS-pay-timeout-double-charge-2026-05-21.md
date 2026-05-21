# FINDINGS — `payAndFetch` silently double-charges on a slow merchant

**Found by:** bake-off audit (m01 / opendexter), 2026-05-21.
**Reporter:** Claude Opus 4.7, working with Branch. Handed to the SDK owner — this doc describes *what was observed and proven*, not how to fix it. Fix design is the SDK expert's call.
**Affected package:** `@dexterai/x402` v3.8.1 (the version installed and recorded). Source repo: `~/websites/dexter-x402-sdk`.
**Severity:** real loss of user funds, in shipped product, on the happy path of any slow x402 endpoint. Not a bake-off artifact.

---

## One-line summary

A paid call to a merchant that takes longer than 15 seconds to respond **settles the USDC on-chain, then reports `Payment failed: timeout` to the caller** — losing the money and inviting a retry that loses it again.

---

## How it surfaced

Bake-off mission m01 (meme-coin gut-check), opendexter pane, recorded 2026-05-21 00:51 UTC against `@dexterai/opendexter@1.14.2`.

Post-run reconciliation showed a spend mismatch:

| source | total spend |
|---|---|
| OpenDexter tape (settlement events) | **$0.17** |
| OpenDexter wallet delta (before/after probe) | **$0.67** |
| Base chain truth (8 outgoing USDC transfers from the wallet, recording window) | **$0.67** |

$0.50 left the wallet that the tape never accounted for. Chain truth and wallet delta agree exactly; the tape is the odd one out.

The funding wallet is a single Base address — `0xE1B4Eec2F02c8E55D5D68e2fd060CD282923e73d`. No second wallet, no cross-chain movement. Every transfer came off that one address.

---

## The two missing payments

Of the 8 on-chain USDC transfers, 6 matched tape settlement events. The two that did not:

```
$0.25  ->0x29322ea7ecb34aa6164cb2ddeb9ce650902e4f60  block 46267735  tx 0x9c2001108c46d8b5a048897e4e604ff7a1b5dbe654089c214226c679b32e09d0
$0.25  ->0x29322ea7ecb34aa6164cb2ddeb9ce650902e4f60  block 46267744  tx 0x8cd421e0246bee1792674c751e187b2ffbda8710e3c8939fa8b69b40f0d8e3ad
```

Both went to the same recipient, back-to-back, within ~20 seconds.

### What the agent saw vs. what the chain shows

| # | tool call (tape) | result the agent received (tape) | chain truth |
|---|---|---|---|
| 1 | `x402_fetch scout.hugen.tokyo/scout/research` at `00:52:58.780` | at `00:53:14.839`: `{"status":402,"error":"Payment failed: timeout","requirements":null}` | $0.25 settled, tx `0x9c200110…` |
| 2 | retry `x402_fetch scout.hugen.tokyo/scout/research` at `00:53:17.795` | at `00:53:33.184`: `{"status":402,"error":"Payment failed: timeout","requirements":null}` | $0.25 settled, tx `0x8cd421e0…` |

**The agent was told both payments failed. Both payments succeeded.** It got no data, paid $0.50, and — believing it had spent $0.00 on this endpoint — moved on. The retry happened *because* the first call reported failure.

### The timing is the tell

- Call 1: request → result = `00:53:14.839 − 00:52:58.780` = **16.06 s**
- Call 2: request → result = `00:53:33.184 − 00:53:17.795` = **15.39 s**

Two independent failures landing within 0.7 s of each other, both at ~15 s. That is not network jitter — that is a fixed deadline firing.

---

## Who the three actors are — identified, not guessed

Each actor was resolved from on-chain receipts cross-referenced against the x402gle catalog (`x402gle_facilitator_addresses`, `x402gle_facilitators`, `x402_resources`). This is the part the first draft of this doc got wrong by assuming — it is now evidenced.

### Payer

`0xE1B4Eec2F02c8E55D5D68e2fd060CD282923e73d` — the OpenDexter bake-off wallet. The `from` on both USDC transfer logs. This is the user's money.

### Facilitator: **Coinbase**

The two transactions were *submitted* (gas paid, broadcast) by two different addresses:

```
tx 0x9c200110…  submitted-by  0x97acce27d5069544480bde0f04d9f47d7422a016
tx 0x8cd421e0…  submitted-by  0x67b9ce703d9ce658d7c4ac3c289cea112fe662af
```

Both resolve in x402gle's facilitator registry to **Coinbase**:

```
0x97acce27…  facilitator_id=coinbase  name=Coinbase  role=fee_payer  (base + 7 other chains)
0x67b9ce70…  facilitator_id=coinbase  name=Coinbase  role=fee_payer  (base + 7 other chains)
```

Coinbase's facilitator (`x402_version=2`, base_url `https://api.cdp.coinbase.com`, 80M+ lifetime txns) relayed both settlements. It rotates fee-payer hot wallets, which is why two different submitter addresses appear for two back-to-back calls.

**Crucially: this is NOT the Dexter facilitator.** The Dexter facilitator's Base fee-payer address derives to `0x402Feee072D655B85e08f1751AF9ddbCd249521f` (registry `facilitator_id=dexter`). It does not match either submitter. The settlement path was entirely Coinbase's, end to end. There is no Dexter-side hook in this flow.

### Merchant: `scout.hugen.tokyo`

The payTo `0x29322ea7ecb34aa6164cb2ddeb9ce650902e4f60` is `scout.hugen.tokyo`'s receiving address — confirmed by x402gle: 19 catalog endpoints on that host all share that exact payTo. The endpoint the agent called, `https://scout.hugen.tokyo/scout/research`, is in the catalog with `verification_status='pass'`. It is a real, catalog-verified, working research endpoint — not a scam, not broken, not flaky. It was simply slow: ~15-16 s, which is normal latency for an LLM-backed "research" endpoint.

---

## Fault — separated by actor, with evidence

**Not Coinbase's fault.** Coinbase's facilitator received two valid, signed payment authorizations and settled both — both transactions are `status: 0x1` (success) on-chain. A facilitator settles what it is handed; it has no way to know the second authorization was a client-side timeout artifact rather than a deliberate second purchase. Coinbase did its job correctly, twice.

**Not the merchant's fault.** `scout.hugen.tokyo/scout/research` is catalog-verified (`pass`). It returned a valid v2 402 payment challenge, then began computing the research result. It was slower than 15 s — but slow is not broken, and 15-16 s is ordinary for that endpoint class. It never asked to be paid twice; the SDK hung up on it before it could deliver, then paid it again.

**Entirely `@dexterai/x402`'s fault.** The SDK:
1. Authorized payment #1; Coinbase settled it on-chain.
2. Aborted its own HTTP wait at the 15 s default.
3. Returned `reason: 'timeout'`, which `x402-mcp-tools` rendered as `Payment failed: timeout` — a string that is factually false (Coinbase had already settled) and that reads to an agent as safe-and-free to retry.
4. On the retry, authorized payment #2; Coinbase settled that too.
5. Had no idempotency guard, settled-payment cache, or recent-payment check to catch that the same URL had been paid 19 s earlier.

The double-charge originated entirely in `@dexterai/x402`. The facilitator and the merchant are both downstream of an SDK that issued two payment authorizations when the user only ever wanted one result.

**Implication for the fix:** because the facilitator is **Coinbase (third-party), not Dexter**, there is no facilitator-side idempotency key or de-dupe backstop available to us. The fix has to stand entirely on its own inside the SDK. We cannot lean on `dexter-facilitator` to catch a duplicate authorization, because `dexter-facilitator` is not in this path — and will not be in the path of any Coinbase-registered merchant.

---

## Where the deadline lives (code trace)

The error string `Payment failed: timeout` was traced through the stack:

1. **`@dexterai/x402-mcp-tools` `x402_fetch` handler** — calls `payAndFetch(...)`; on a non-ok result builds the message `Payment failed: ${payResult.reason}`. So `payResult.reason === 'timeout'`.

2. **`@dexterai/x402` — `src/payment/dispatcher.ts` `payAndFetch`** — has no timeout of its own; probes once, then delegates to `strategy.pay()`.

3. **`@dexterai/x402` — `src/payment/v2-strategy.ts` `pay()`** — this is the origin. Relevant lines (v3.8.1):

```ts
// v2-strategy.ts
103   const controller = new AbortController();
104   const timeoutId = setTimeout(
105     () => controller.abort(),
106     opts.timeoutMs ?? 15000,          // ← the 15 s deadline
107   );
...
118   freshInit.signal = composedSignal;  // ← that deadline's signal is attached here
...
124   try {
125     const response = await client.fetch(url, freshInit);   // ← settles payment AND
                                                                //   awaits merchant response,
                                                                //   both under the one signal
126     clearTimeout(timeoutId);
...
160   } catch (err: unknown) {
161     clearTimeout(timeoutId);
162     const e = err as { name?: string; message?: string };
163     if (e?.name === 'AbortError') {
164       return { ok: false, reason: 'timeout' };   // ← returned with no check
                                                      //   of whether the tx already broadcast
165     }
166     return { ok: false, reason: 'error', detail: e?.message ?? String(err) };
167   }
```

`opts.timeoutMs` was not set by the `x402_fetch` caller, so the `?? 15000` default applied.

---

## What the trace establishes (observations, not prescriptions)

1. **One deadline spans two phases.** `client.fetch()` at line 125 is a single composite operation: it signs and broadcasts the on-chain USDC payment (relayed by Coinbase) *and* waits for the merchant's HTTP response. Both phases are governed by the same `AbortController` and the same 15 s deadline. There is no observable checkpoint between "payment broadcast" and "abort fired."

2. **`reason: 'timeout'` is returned without consulting settlement state.** Line 163-164 flips on `AbortError` alone. At the moment that branch runs, the payment may already be irreversibly on-chain (it was, twice, in this recording). The returned `PayResult` carries no tx hash and no "paid but unanswered" signal.

3. **The caller cannot tell the two cases apart.** From `x402-mcp-tools`' perspective, `reason: 'timeout'` is indistinguishable from "payment never went out." It rendered `Payment failed: timeout` — a string that is factually wrong when the chain shows a settled tx, and that reads to an agent as "safe and free to retry."

4. **Nothing prevented the retry from paying again.** The second call, 19 s after the first, settled a second independent $0.25 payment to the same endpoint. There is no idempotency guard, settled-payment cache, or recent-payment check at the `payAndFetch` / strategy layer — and, as established above, no third-party-facilitator backstop either.

5. **15 s is short for the endpoint class involved.** `scout.hugen.tokyo/scout/research` is an LLM-backed research endpoint; a 15-16 s response is normal for that kind of work, not pathological. Under the current default, an honest, correctly-functioning, catalog-verified merchant of this class loses the caller money every time.

---

## Blast radius

- Any agent using `@dexterai/x402` `payAndFetch` (directly, or via `@dexterai/x402-mcp-tools` / `@dexterai/opendexter`) against any x402 endpoint that takes >15 s to respond — regardless of which facilitator settles it.
- The failure is **silent**: no error thrown, the `PayResult` looks like an ordinary expected failure, and the only evidence the money moved is on-chain. A consumer that trusts the SDK's own `reason` (as `x402-mcp-tools` does, as the bake-off tape does) will under-report spend and never know a payment happened.
- "Research", "deep analysis", "agent", and "scout"-style endpoints — an entire and growing category in the x402 catalog — routinely exceed 15 s. This is not an edge case for a narrow set of slow merchants; it is the expected behavior for a whole capability class.
- The facilitator being Coinbase (the largest x402 facilitator, 80M+ txns) means a large share of the catalog settles through exactly this path. There is no facilitator-side mitigation we can ship; the SDK is the only place this can be fixed.

---

## Reproduction

1. Point `payAndFetch` (or `x402_fetch`) at any x402 endpoint whose handler sleeps / computes for >15 s before responding 200.
2. Observe the returned `PayResult`: `{ ok: false, reason: 'timeout' }`.
3. Check the funding wallet on-chain for the recording window: a settled USDC transfer to the merchant's payTo will be present.
4. The two diverge — SDK says failed, chain says paid.

Live evidence from this audit (Base mainnet, both verifiable on basescan):
- `0x9c2001108c46d8b5a048897e4e604ff7a1b5dbe654089c214226c679b32e09d0`
- `0x8cd421e0246bee1792674c751e187b2ffbda8710e3c8939fa8b69b40f0d8e3ad`

Both are $0.25 USDC, from `0xE1B4Eec2F02c8E55D5D68e2fd060CD282923e73d`, to `0x29322ea7ecb34aa6164cb2ddeb9ce650902e4f60`, in blocks 46267735 / 46267744, each submitted by a Coinbase fee-payer address.

---

## How this affected the work that found it

- The bake-off m01 scoreboard would have credited OpenDexter with $0.17 spend (model-citizen, well under the $0.30 mission budget) when the true spend was $0.67 — 2× over budget. The tape was honest; it faithfully recorded what the SDK *told* it. The SDK told it wrong.
- The mission's spend-discipline finding inverts: OpenDexter did not *choose* to overspend. $0.50 of the $0.67 was burned by this bug on a merchant that never delivered a byte of data.
- Any bake-off scoring that reads self-reported settlement totals (rather than chain truth) is unreliable for OpenDexter until this is fixed — the product cannot currently report its own spend accurately when a merchant is slow.

---

## Related prior findings (context, not the same bug)

The bake-off has previously logged receipt-accounting gaps on *other* products (Agentcash partial receipts, Pay.sh receipt blackout). Those were *reporting* gaps — the money was spent as intended, just not surfaced. **This is different and worse:** here the SDK both loses money the user did not knowingly authorize a second time *and* misreports the first loss as a non-event.

---

## Open question for the SDK owner

There is one design question this audit cannot answer from the outside, and it gates the fix: **at the point `client.fetch()` is aborted, does the SDK already know whether the payment transaction was broadcast?** If `client.fetch` settles before it awaits the merchant, the SDK has the tx hash in hand and the "paid but unanswered" state is fully knowable. If settlement and response are interleaved deeper inside `createX402Client`, recovering that knowledge may need a change there. That is the SDK expert's call — flagging it as the crux.
