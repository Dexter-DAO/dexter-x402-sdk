# Liveness vs. Custody — what "non-custodial" means when the facilitator is unreachable

The one-line answer: **Dexter can fail to deliver a payment; Dexter cannot take or redirect one.**

The tab rail has exactly one Dexter-operated component on the money path: the
facilitator (`https://x402.dexter.cash`), which arms tab protection at open and
executes settlement at close. This document states precisely what depends on it
being reachable — and what provably does not.

## Custody: who can move the money

The facilitator can never move a buyer's funds anywhere it chooses. The only
transfer it can execute against a vault is a settle whose **destination is the
registered counterparty** of a session the *buyer's passkey* created, for an
amount the *buyer's session key* signed in a voucher, bounded by the caps the
buyer set when opening the tab. These constraints are enforced by the
dexter-vault program on-chain — there is no instruction path that sends a
buyer's USDC to Dexter, to a third party, or to any address other than the
seller the buyer explicitly opened a tab with.

The freeze that blocks withdrawal while a tab is open is not a custody handle
either: it is a temporary, **buyer-escapable** gate (`force_release`, signed by
the buyer's own passkey, after the grace period). It exists to protect the
seller from a buyer draining mid-tab — not to give Dexter a hold on anyone's
funds.

## Buyer recovery: keeper-free, proven on mainnet

With the facilitator fully unreachable, a buyer recovers their funds using only
their passkey, any Solana RPC, and any fee payer:

1. `request_withdrawal` — passkey-signed, sets the pending withdrawal on the
   vault.
2. `finalize_withdrawal` — passkey-signed; gated **only by on-chain state**
   (`PendingVouchersExist` while a tab is open; the reservation invariant for
   locked claims). No Dexter signature, service, or endpoint participates.
3. If a pending voucher count is stuck (e.g. a tab was never settled),
   `force_release` — buyer-passkey-signed, after the grace period — clears it.

This machinery is exercised on Solana mainnet by the adversarial canary
(`dexter-vault/tests/canary-tab-freeze.ts`): the same run that proves a
withdrawal is *blocked* while a tab is open (the seller's protection) proves it
*succeeds* once the tab closes — both legs submitted directly to the chain,
with no facilitator involvement in either withdrawal transaction.

So the property under test holds in the strongest form: **buyer funds are
recoverable with zero Dexter components alive.**

## Seller settlement: the present architecture, stated plainly

Settling a tab voucher today goes through the facilitator's `/tab/settle`,
because the settlement transaction is executed with the session authority key
the facilitator holds. A seller holding an accrued-but-unsettled voucher
therefore depends on the facilitator being reachable to realize that value.

Consequences, stated without drama:

- The seller's exposure is **accrued-but-unsettled value only**, bounded by
  settle frequency (default: settle on tab close; high-volume sellers can
  settle more often to shrink the window).
- If a voucher is never settled, the value does not strand with Dexter — it
  remains in the **buyer's vault**, recoverable by its owner (above). The
  failure mode of this system is funds reverting to their owner, which is the
  signature of genuine non-custody.
- This is a liveness dependency, priced like any counterparty exposure — not a
  custody risk.

**Unverified, noted for a future authority audit:** whether a seller can
self-submit a settlement carrying the buyer-signed voucher without the
facilitator's key. This document is written against current known behavior
(facilitator-executed settle); if a seller-self-submit path exists or is added,
the dependency above shrinks accordingly.

## Summary table

| Scenario (facilitator unreachable) | Outcome |
|---|---|
| Buyer wants funds out, no open tab | Withdraws directly on-chain (passkey). No Dexter involvement. |
| Buyer wants funds out, tab open | Waits out the grace period, `force_release`, then withdraws. No Dexter involvement. |
| Seller holds an unsettled voucher | Cannot settle until the facilitator returns; value remains in the buyer's vault meanwhile. Exposure bounded by settle frequency. |
| New tab open / new settle | Unavailable (service outage, like any API downtime). No funds at risk. |
