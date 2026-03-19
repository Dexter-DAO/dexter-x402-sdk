## @dexterai/x402 v2.0 Tweet Thread

---

**Tweet 1:**

@dexterai/x402 v2.0 is live

The x402 SDK now lets AI agents discover, pay for, and budget APIs across 7 blockchains — with the first protocol-native advertising system for AI built in.

What's new:

---

**Tweet 2:**

Budget Accounts

Give your agent a spending limit and let it operate autonomously. Total budget, per-request caps, hourly rate limits, domain allowlists. Full spend ledger.

```
const agent = createBudgetAccount({
  walletPrivateKey: key,
  budget: { total: '50.00', perRequest: '1.00' },
});
```

---

**Tweet 3:**

API Discovery

Agents can now search the Dexter marketplace for paid APIs by query, category, price, network, and quality score — then call them directly.

```
const apis = await searchAPIs({ query: 'sentiment', maxPrice: 0.10 });
await x402Fetch(apis[0].url);
```

---

**Tweet 4:**

Ads for Agents (Sponsored Access)

The first advertising system where the impression is a blockchain transaction and the conversion is cryptographically provable.

When an agent pays for an API, it can receive a sponsored recommendation for a related tool. If it follows through, two on-chain tx hashes prove it.

---

**Tweet 5:**

Pre-payment inspection

Agents can review payment requirements before signing. Budget controls, confirmation prompts, spend policies — all in one callback.

---

**Tweet 6:**

Settlement webhooks

onSettlement and onVerifyFailed callbacks fire on every payment. Build dashboards, trigger Slack alerts, update your CRM.

---

**Tweet 7:**

Also in v2.0:
- x402 v2 protocol spec compliant
- Auto-retry with exponential backoff
- 7 chains: Solana, Base, Polygon, Arbitrum, Optimism, Avalanche, SKALE
- 52 tests, CI/CD, 58% smaller package
- Full docs at docs.dexter.cash

---

**Tweet 8:**

npm install @dexterai/x402@2.0.0

GitHub: github.com/Dexter-DAO/dexter-x402-sdk
Docs: docs.dexter.cash/docs/build-with-x402
