<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-x402-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/x402</h1>

<p align="center">
  <strong>Give your agent a spending limit it cannot exceed — without ever giving up your wallet.</strong>
</p>

<p align="center">
  Open a tab, set a cap, and your agent pays as it works. No signature per charge, no escrow, no custodian. Your USDC stays in your own wallet the entire time, and the seller is still guaranteed payment.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/x402"><img src="https://img.shields.io/npm/v/@dexterai/x402.svg" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E=18-brightgreen.svg" alt="Node"></a>
  <img src="https://img.shields.io/badge/non--custodial-passkey-brightgreen" alt="Non-custodial">
  <a href="https://dexter.cash/sdk"><img src="https://img.shields.io/badge/Try_it-real_payments-blueviolet" alt="Live Demo"></a>
</p>

<p align="center">
  <a href="https://dexter.cash/sdk"><strong>Try it with real payments →</strong></a>
</p>

---

## The problem

An agent that pays for things needs money it can reach without you in the loop for every charge. The two usual ways to give it that each cost you something you shouldn't have to give up.

- **Prefund an escrow** and your money leaves your wallet to sit with a custodian before you've bought anything. Your balance is on the table, and you've paid a stranger in advance.
- **Hand it a spending delegate** and you keep custody — but you can also pull the funds mid-charge, so the seller can be left unpaid. Serious sellers decline it.

## The tab

A **tab** keeps both halves. You open one against your own wallet with a single passkey tap and set a cap. Your agent spends against that cap call by call, with no signature on each charge. The money never leaves your wallet — and while the tab is open, the Solana program blocks you from pulling it out from under what the agent has already run up. The seller gets paid when they settle, automatically.

The cap is enforced at consensus by an on-chain program — not by this library, and not by Dexter. The closest familiar shape is an auth-and-capture card hold, except the hold lives on-chain instead of inside a processor, and no one ever takes your money.

```ts
import { payUrlWithTab } from '@dexterai/x402/tab';

const tabs = new Map();                          // one open tab per seller, reused across calls
const { result, tab } = await payUrlWithTab(
  'https://api.example.com/paid/infer',
  { method: 'GET' },
  { vault, perUnitCap: '0.01', totalCap: '1.00', tabs },
);
// ...the agent keeps calling; every call reuses the same tab, with no new prompt...
await tab?.close();                              // one on-chain settle pays the seller for everything
```

That's the whole loop: one tap to open, unlimited calls under the cap, one settle to close. The seller's address comes off the wire from the URL's own `402` challenge — never from your code. The `vault` is built once from your passkey-rooted wallet; see [Setup](#setup).

---

## Why you can trust it

"Unruggable" has to be earned, so here is what backs it. Every property below is enforced by the on-chain program, not by this SDK and not by Dexter.

- **Non-custodial.** Your USDC never leaves your wallet. The program holds no funds — it records bindings and gates withdrawals. There is no escrow account and no custodian to fail.
- **The cap is consensus-enforced.** The limit is checked by the Solana program at consensus, not by this library. Read the program and verify it yourself: [`Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`](https://solscan.io/account/Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc) on Solana mainnet.
- **Only your passkey moves money.** Withdrawals require a WebAuthn assertion verified by Solana's secp256r1 precompile. Neither the SDK nor the facilitator holds a key that can drain your wallet.
- **The seller is protected, surgically.** As the agent spends, accrued charges crystallize on-chain into a reservation sized to exactly what's been spent — never the whole wallet. The buyer keeps spending or withdrawing the rest of their balance freely, the seller is guaranteed what they're owed, and if a seller ever goes silent the buyer reclaims the abandoned reservation after a fixed grace period. No one's funds can be frozen indefinitely.
- **Live on mainnet, pre-audit, and we say so.** Tabs settle on Solana mainnet today; an external audit is funded and in flight. The report and any findings publish in the [`dexter-vault`](https://github.com/Dexter-DAO/dexter-vault) program repo. Responsible disclosure: branch@dexter.cash.

The full threat model and trust assumptions live in the program's [`SECURITY.md`](https://github.com/Dexter-DAO/dexter-vault).

---

## Setup

Install the SDK alongside `@dexterai/vault` — it's a peer dependency, so your app and the tab adapter share one vault instance:

```bash
npm install @dexterai/x402 @dexterai/vault
```

Build a `vault` adapter once, from the wallet addresses you receive when you enroll at [dexter.cash](https://dexter.cash), plus your passkey signer:

```ts
import { createSolanaVaultAdapter } from '@dexterai/x402/tab/adapters/solana';

const vault = createSolanaVaultAdapter({
  connection,      // your Solana Connection (any RPC)
  swigAddress,     // the vault's Swig state account, from enrollment
  vaultPda,        // the vault's gate PDA, from enrollment
  passkeySigner,   // browser: vault's DexterApiBrowserPasskeySigner · agent: passkeySignerFromP256Keypair(kp)
  feePayer,        // lamport fee payer (a Signer)
});
```

That `vault` drives [the tab loop above](#the-tab). To inspect a seller's price before you spend, `resolveTabTerms(url)` reads the terms without paying — for consent screens, directories, or an agent that plans ahead.

---

## Get paid (sellers)

You get paid for exactly what you serve, and you hold no key. As an agent spends against its tab, charges crystallize on-chain into a reservation against the buyer's wallet; one settle at close pays your address for everything metered. One middleware advertises both a tab and a one-shot price in a single `402`, so tab-native agents and one-shot callers pay at the same rate.

```ts
import { tabOrExactMiddleware, requireTab, openSse } from '@dexterai/x402/tab/seller';
import type { X402Request } from '@dexterai/x402/server';

app.get('/paid/tick',
  tabOrExactMiddleware({ connection, sellerPubkey, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', perUnit: '0.01' }),
  async (req, res) => {
    if ((req as X402Request).x402) { res.json({ data: '...' }); return; }   // one-shot caller, already paid
    const meter = openSse(res, { tab: requireTab(req), perUnit: '0.01' });  // tab caller
    await meter.charge(1);                  // demand a fresh voucher; throws if the cap is exceeded
    meter.send(JSON.stringify({ data: '...' }));
    await meter.end();                      // always await — persists the final delivered amount
  });
```

Want a tab-only endpoint, or to compose the pieces yourself? The full seller surface is in [REFERENCE.md](./REFERENCE.md#sellers).

---

## Hosted approval (partners)

When a partner's app opens a tab for a user, the approval runs on one Dexter-hosted consent screen, deep-linked from the partner's app. The user sees the counterparty, the cap, and the expiry, taps their passkey once, and control returns to the app. The partner builds no approval UI and never handles a passkey.

The screen is hosted for a structural reason, not a stylistic one: the vault's passkey can only sign on Dexter's own origin, so a user cannot be phished into approving on a look-alike page. The safety is a property of *where the key signs*. Flow and routing: [docs.dexter.cash](https://docs.dexter.cash).

---

## Also in this package

Tabs are the headline. The same install carries the rest of the x402 surface — each documented in full in [REFERENCE.md](./REFERENCE.md).

- **One-shot payments** — a single discrete purchase over HTTP `402`, USDC on Solana and the major EVM chains. `payAndFetch` (client), `x402Middleware` (server), `useX402Payment` (React).
- **Batch settlement (EVM)** — prepay an escrow once, make many paid calls with off-chain vouchers, settle in a handful of transactions to amortize gas. `openBatchChannel`.
- **Discovery** — make any protected route findable by capability through the x402 bazaar spec. `bazaarExtension()`.
- **Sponsored access & auto-listing** — endpoints paid through Dexter's facilitator are auto-discovered, named, quality-tested, and surfaced in `x402_search` across MCP clients, with no registration step.

---

## Supported networks

Tabs are Solana. One-shot and batch settlement span Solana and the major EVM chains; USDC on every chain. Full live list: [Dexter facilitator](https://x402.dexter.cash/supported).

| Network | CAIP-2 | Status |
|---------|--------|--------|
| Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Production |
| Base | `eip155:8453` | Production |
| Polygon | `eip155:137` | Production |
| Arbitrum | `eip155:42161` | Production |
| Optimism | `eip155:10` | Production |
| Avalanche | `eip155:43114` | Production |
| BSC | `eip155:56` | Production |
| SKALE Base | `eip155:1187947933` | Production (zero gas) |

---

## More

- **[REFERENCE.md](./REFERENCE.md)** — every export, option table, and example: tabs, one-shot, batch settlement, discovery.
- **Upgrading?** `5.0.0` makes `@dexterai/vault` a peer dependency (`>=0.19`) and unifies the passkey signer on `signOperation`. Migration from v4/v3: [REFERENCE.md](./REFERENCE.md#migration).
- **License** — MIT, see [LICENSE](./LICENSE).

---

<p align="center">
  <a href="https://x402.dexter.cash">Dexter Facilitator</a> ·
  <a href="https://dexter.cash/opendexter">OpenDexter Catalog</a> ·
  <a href="https://dexter.cash/sdk">Live Demo</a> ·
  <a href="https://dexter.cash/onboard">Become a Seller</a>
</p>
