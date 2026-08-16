# Build Context

## Stack

| Field | Value |
|---|---|
| Package | `@dexterai/x402` |
| Architecture | TypeScript SDK with Solana Native Tab V2 |
| Reviewed at | 2026-08-16T14:12:11Z |

## Source Status

| Field | Value |
|---|---|
| Native Tab V2 source complete | Yes |
| Root package install, typecheck, build, and tests | Yes |
| Package artifact and clean consumer import/typecheck | Yes |
| Security train committed and merged | Yes (`132baf4945d8bbcbd28475987ef35f1811e37149`) |
| rc.1 release record merged | No; release PR pending |
| Published | No |
| Deployed and production-proven | No |

## Review

| Field | Value |
|---|---|
| Security score | A- |
| Quality score | A- |
| Ready for mainnet | No; release and production acceptance remain |

### Resolved findings

- Binds each released V2 payment claim to its exact authority-signed Solana reservation transaction.
- Releases claims only after finalized chain proof and coherent finalized account readback.
- Preserves and reconciles the exact close transaction across ambiguous transport outcomes.
- Uses Vault 0.43.2 exact-state V3 revocation and rejects stale or mismatched state.
- Keeps every documented ESM and CommonJS package entrypoint loadable; the server bundle no longer leaks its ESM-only sponsored-access runtime dependency into `require()` consumers.
- Fails closed across V2 refusal, ambiguity, rollback, and concurrent signing paths.
- Rejects unsupported V1 buyer opening in v6 while retaining seller verification of historical V1 claims.

### Evidence

- Root clean install passed.
- Typecheck and declaration build passed.
- Full SDK suite: 589/589 passed across 68 files.
- Dry package: 63 files, 346,328 bytes; deterministic SHA-256 `db3cad36726ac92ebad62c89e7ae0af8a526e45e86ab90850895765db0b393cd`.
- Clean external ESM and CommonJS loads passed for every exported package path.
- Strict NodeNext TypeScript consumer checks passed for V2 receipt transport, seller middleware, buyer routes, and the Solana verifier.

### Remaining release boundary

The security train is merged. The rc.1 release record still must be committed, reviewed, merged, tagged, and published under `next`. The four maintained example locks are pinned to the exact deterministic tarball planned for publication, but must be regenerated from a fresh npm cache and verified against registry integrity after rc.1 becomes visible. Consumer deployment and fresh production acceptance remain separate, explicitly out-of-scope steps.
