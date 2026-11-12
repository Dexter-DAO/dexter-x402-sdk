<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-x402-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/x402</h1>

<p align="center">
  <strong>Build the financial operations of an agent-run business.</strong>
</p>

<p align="center">
  Let a business sell its work, buy services from other businesses, and authorize agents to spend through its account. Supplier Tabs support recurring commerce, with spending authority and payment obligations attached to the business.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/x402"><img src="https://img.shields.io/npm/v/@dexterai/x402.svg" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E=22-brightgreen.svg" alt="Node"></a>
  <img src="https://img.shields.io/badge/non--custodial-passkey-brightgreen" alt="Non-custodial">
  <a href="https://dexter.cash/sdk"><img src="https://img.shields.io/badge/Try_it-real_payments-blueviolet" alt="Live Demo"></a>
</p>

<p align="center">
  <a href="https://dexter.cash/sdk"><strong>Try it with real payments →</strong></a>
</p>

---

## Businesses buying from businesses

A business can sell research, software or creative work while buying the data, inference and compute needed to produce it. Its agents need authority to transact, its suppliers need commitments they can collect, and its owner needs control over the business's money and the value it creates.

Dexter is building the operating and financial system for those businesses: self-custodial accounts, supplier relationships, productive financing and defined economic rights. Each business retains its assets and customer relationships, along with the knowledge and financial history created by its work.

This SDK provides HTTP and MCP payments, supplier Tabs, seller middleware and client integrations. [OpenDexter](https://github.com/Dexter-DAO/opendexter-ide) connects agents to service discovery and commerce; [Connect](https://github.com/Dexter-DAO/dexter-connect) brings identity and owner-granted authority into applications. Existing businesses and independent agent runtimes can participate through these interfaces.

<a id="the-tab"></a>

## Supplier Tabs

A Tab gives an agent continuing purchasing authority with a named supplier under an owner-approved limit. The supplier meters work as it is delivered, and the buyer's account carries the resulting payment obligation. This supports recurring inference, data services and work supplied by other agent-run businesses.

The owner approves the seller, session limits and expiry. The agent signs vouchers within that grant. Buyer funds stay in their own wallet until settlement, with the Vault's reservation rules protecting outstanding obligations. The implementation and transaction checks are described under [Authorization and settlement](#authorization-and-settlement).

```ts
import { payUrlWithTab, type ReserveFinalVoucherV2 } from '@dexterai/x402/tab';

const reserveFinalVoucherV2: ReserveFinalVoucherV2 = async (input) => {
  const response = await fetch('/api/native-tab/reserve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`reservation failed: ${response.status}`);
  return response.json();
};
const tabs = new Map();                          // one open tab per seller, reused across calls
const { result, tab } = await payUrlWithTab(
  'https://api.example.com/paid/infer',
  { method: 'GET' },
  {
    vault,
    perUnitCap: '0.01',
    totalCap: '1.00',
    tabs,
    reserveFinalVoucherV2,
  },
);
// ...the agent keeps calling; every call reuses the same tab, with no new prompt...
await tab?.close();                              // one on-chain settle pays the seller for everything
```

That's the whole loop: one tap to open, unlimited calls under the cap, one settle to close. The seller's address comes off the wire from the URL's own `402` challenge — never from your code. The `vault` is built once from your passkey-rooted wallet; see [Setup](#setup). The reservation route belongs in your authenticated backend: it returns a voucher-bound receipt once the exact Solana transaction is confirmed. Buyer and seller each independently verify that transaction, its Dexter-authority-signed voucher-binding Memo, and coherent Vault/SessionAccount state anchored at the transaction slot. Processed-only evidence is rejected; finalized evidence is accepted when already present, but paid requests do not wait for finalization. Session close/revoke remains the finalized terminal step.

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

That `vault` drives [the tab loop above](#supplier-tabs). To inspect a seller's price before you spend, `resolveTabTerms(url)` reads the terms without paying — for consent screens, directories, or an agent that plans ahead.

---

## Get paid (sellers)

The seller middleware verifies vouchers and their reservations before admitting paid work. Settlement pays the seller address bound to the session. `tabOrExactMiddleware` advertises both a tab and a one-shot price in a single `402`, so callers can use either payment route.

```ts
import {
  FileChannelLedger,
  tabOrExactMiddleware,
  requireTab,
  openSse,
} from '@dexterai/x402/tab/seller';
import type { X402Request } from '@dexterai/x402/server';

const ledgerDir = process.env.TAB_LEDGER_DIR;
const channelIdCutover = process.env.TAB_CHANNEL_ID_CUTOVER;
if (!ledgerDir) throw new Error('TAB_LEDGER_DIR must name persistent storage');
if (channelIdCutover !== 'legacy-case-aliases-migrated-or-empty') {
  throw new Error('prove the seller ledger empty or complete the documented alias migration first');
}
const ledger = new FileChannelLedger(ledgerDir, { channelIdCutover });

app.get('/paid/tick',
  tabOrExactMiddleware({
    connection,
    sellerPubkey,
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    perUnit: '0.01',
    ledger,
    ledgerSafetyMode: 'production-single-instance',
  }),
  async (req, res) => {
    if ((req as X402Request).x402) { res.json({ data: '...' }); return; }   // one-shot caller, already paid
    const meter = openSse(res, { tab: requireTab(req), perUnit: '0.01' });  // tab caller
    await meter.charge(1);                  // demand a fresh voucher; throws if the cap is exceeded
    meter.send(JSON.stringify({ data: '...' }));
    await meter.end();                      // always await — closes the metered response
  });
```

`FileChannelLedger` is restart-safe for one seller process; keep its directory
on persistent storage. `TAB_CHANNEL_ID_CUTOVER` is an operator assertion, never
a copy/paste default: set it only for a proven-empty store or after completing
the mixed-case alias merge in
[CHANGELOG.md](./CHANGELOG.md#seller-ledger-upgrade-and-redis-keyspace-migration).
Multiple replicas must use `RedisChannelLedger` with
`ledgerSafetyMode: 'production-multi-instance'`, verified durability, and the
documented writer/keyspace cutovers. Production configuration is explicit; the
in-memory default is accepted only in exact `test` or `development`
environments.

Want a tab-only endpoint, or to compose the pieces yourself? The full seller surface is in [REFERENCE.md](./REFERENCE.md#sellers).

---

## Hosted approval (partners)

When a partner's app opens a tab for a user, the approval runs on one Dexter-hosted consent screen, deep-linked from the partner's app. The user sees the counterparty, the cap, and the expiry, taps their passkey once, and control returns to the app. The partner builds no approval UI and never handles a passkey.

The screen is hosted for a structural reason, not a stylistic one: the vault's passkey can only sign on Dexter's own origin, so a user cannot be phished into approving on a look-alike page. The safety is a property of *where the key signs*. Flow and routing: [docs.dexter.cash](https://docs.dexter.cash).

---

## Also in this package

Tabs are the headline. The same install carries the rest of the x402 surface — each documented in full in [REFERENCE.md](./REFERENCE.md).

Paid MCP tools use the `@dexterai/x402/mcp` entrypoint. The [MCP guide](./docs/mcp.md) covers the seller adapter, durable storage contract, and buyer dispatch with complete result preservation.

- **One-shot payments** — a single discrete purchase over HTTP `402`, USDC on Solana and the major EVM chains. `payAndFetch` (client), `x402Middleware` (server), `useX402Payment` (React).
- **Batch settlement (EVM)** — prepay an escrow once, make many paid calls with off-chain vouchers, settle in a handful of transactions to amortize gas. `openBatchChannel`.
- **Discovery** — make any protected route findable by capability through the x402 bazaar spec. `bazaarExtension()`.
- **Sponsored access & auto-listing** — endpoints paid through Dexter's facilitator are auto-discovered, named, quality-tested, and surfaced in `x402_search` across MCP clients, with no registration step.

---

## Supported networks

Tabs are Solana. One-shot and batch settlement span Solana and the major EVM chains; USDC on every chain (Paxos USDG on Robinhood Chain, which has no native USDC). Full live list: [Dexter facilitator](https://x402.dexter.cash/supported).

| Network | CAIP-2 | Status |
|---------|--------|--------|
| Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Production |
| Base | `eip155:8453` | Production |
| Polygon | `eip155:137` | Production |
| Arbitrum | `eip155:42161` | Production |
| Optimism | `eip155:10` | Production |
| Avalanche | `eip155:43114` | Production |
| BSC | `eip155:56` | Production |
| World Chain | `eip155:480` | Production |
| Monad | `eip155:143` | Production |
| Robinhood Chain | `eip155:4663` | Production (USDG) |
| SKALE Base | `eip155:1187947933` | Production (zero gas) |

---

## Authorization and settlement

The owner-approved registration binds the session key, seller, expiry and spending limits. The agent signs vouchers within that session. See the [registration and voucher checks](./src/tab/seller/verify.ts).

For each FINAL V2 voucher, the buyer and seller independently verify the exact Solana transaction, voucher-binding Memo and coherent Vault/SessionAccount state. The [reservation verifier](./src/tab/adapters/solana/reservation-verifier.ts) requires at least confirmed commitment; a broadcast signature alone is insufficient. The [reservation-provider contract](./REFERENCE.md#final-v2-reservation-provider) describes the backend integration.

The deployed Vault program is [`Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`](https://solscan.io/account/Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc) on Solana mainnet. Operator availability, wallet-management permissions and program upgrade authority are part of its trust model.

The Vault program source and threat model are maintained in a private repository. For security reports, audit inquiries or review access, contact [branch@dexter.cash](mailto:branch@dexter.cash).

---

## More

Release maintainers can follow the [GitHub OIDC publishing workflow](./docs/releases.md).

- **[REFERENCE.md](./REFERENCE.md)** — every export, option table, and example: tabs, one-shot, batch settlement, discovery.
- **Upgrading?** v6 requires `@dexterai/vault@^0.44.0`, requires voucher-bound V2 reservation receipts, and uses exact-state V3 revocation. Migration from v5/v4/v3: [REFERENCE.md](./REFERENCE.md#migration).
- **License** — MIT, see [LICENSE](./LICENSE).

---

<p align="center">
  <a href="https://x402.dexter.cash">Dexter Facilitator</a> ·
  <a href="https://dexter.cash/opendexter">OpenDexter Catalog</a> ·
  <a href="https://dexter.cash/sdk">Live Demo</a> ·
  <a href="https://dexter.cash/onboard">Become a Seller</a>
</p>
