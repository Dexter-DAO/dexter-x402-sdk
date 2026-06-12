# The custody dial — where the root key lives, and what each position earns

The one-line answer: **the chain's guarantees don't depend on where your root key lives; the claim "my agent is bounded" does.**

The tab rail has two tiers of authority. The **root credential** (the passkey —
hardware-backed or software) can mint new authority: register tabs, withdraw,
revoke. The **session key** can only sign vouchers within the
`(counterparty, cap, expiry)` the root registered on-chain. This document
states which guarantees hold no matter where the root lives, and which
guarantee each placement of the root — the custody dial — actually earns.

## The conditional the chain enforces

The on-chain guarantee is a conditional:

> An agent holding **only a session key** cannot exceed the cap, the
> counterparty, or the expiry.

That conditional is true in every deployment. The program verifies a secp256r1
signature; it cannot know whether that signature came from Face ID or from a
key file on disk. What varies between deployments is whether a given setup
**satisfies the condition** — can the agent reach the root credential, or can
it not? The chain enforces the conditional; your key placement decides whether
its premise holds.

## What holds at every position of the dial

These properties do not move when the dial does:

| Property | Why |
|---|---|
| Dexter cannot initiate a payment | Every settlement consumes a fresh buyer-signed voucher; see [LIVENESS.md](./LIVENESS.md) |
| Settlement is bounded by the buyer-signed cap | Cumulative voucher amount is checked on-chain against the session cap |
| Session keys are bounded to `(counterparty, cap, expiry)` | The session PDA is seed-bound to the counterparty; cap and expiry are program-enforced |
| The freeze is buyer-escapable | `force_release` is buyer-passkey-signed; funds recover keeper-free (proven on mainnet, see LIVENESS.md) |
| The seller's protection is identical at every posture | The freeze and voucher verification run the same regardless of how the buyer stores their root |
| Postures do not compose across users | No shared root, no pooled key — each vault is its own box. One user keeping their root next to their agent weakens that user's box and nobody else's, the way a careless safe-deposit-box holder endangers one box, not the bank vault |

## The three postures

| | Root placement | What the cap bounds | The earned claim |
|---|---|---|---|
| (a) | Biometric hardware (passkey in a secure enclave) | The agent itself | "The agent can never exceed what you approved" |
| (b) | Key file in a separate context from the agent | The agent, against agent compromise | Same claim, conditional on the separation holding |
| (c) | Key file readable by the agent process | Leaked session keys and vouchers — not the agent | "Machine-is-custody"; the cap is not a boundary on the agent |

**(a) Root in biometric hardware.** The agent physically cannot reach the root
credential; minting new authority requires a human gesture on a device the
agent does not control. The cap is therefore a hard boundary on the agent, not
a convention. This is the consumer posture, and it is the only posture that
has earned the sentence "the agent can never exceed what you approved" without
qualification.

**(b) Root file in a separate context from the agent.** A different OS user, a
different box, or a one-shot grant moment after which the root is out of
reach. Against agent compromise — prompt injection, a malicious dependency
inside the agent process — the boundary holds: the compromised agent has only
the session key. Against full machine compromise it is an ordinary hot-key
posture and should be priced as one.

**(c) Root readable by the agent process.** Machine-is-custody mode. The cap
does **not** bound the agent itself: whoever is inside the agent process can
use the root to self-grant a new session or withdraw outright. What survives
at this posture is still real — leaked session keys and vouchers remain
bounded, and Dexter still cannot initiate a payment — but the agent-boundedness
claim is gone. This posture is legitimate for operators who already accept
that the machine is the custodian (it is how most server-side hot wallets work
today); it must be chosen knowingly, never arrived at by default.

Stated plainly: the marketing sentence "the agent can never exceed what you
approved" belongs to postures (a) and (b) only. Documentation and tooling that
let posture (c) borrow it are overclaiming.

## Defaults

An ecosystem's security level is set by its defaults, not by its maximum.

- **Consumer surface:** posture (a) by construction. The Connect-a-Tab flow
  (`https://dexter.cash/tab/connect`) registers the session from the user's
  passkey device; no root material ever exists where the agent runs.
- **CLI quickstart:** session-key-only agent plus grant-from-the-phone. The
  agent generates a session keypair and prints
  `https://dexter.cash/tab/connect?url=<service>&agent=<sessionPubkey>`; the
  human opens it on any device and approves with their passkey. The CLI is the
  transport for the session key, not the home of the root —
  CLI-as-transport does not force key-on-disk-as-custody.
- **Posture (c) is a named opt-in:** where tooling supports running with a
  root key on the agent's machine, it is gated behind an explicit flag spelled
  to say what it means (e.g. `--custody=machine`), and it is never the
  quickstart path.

## Liveness vs. custody

This document answers *who can the cap bound*; [LIVENESS.md](./LIVENESS.md)
answers *what still works when Dexter is unreachable* — different questions,
and both documents deliberately claim only the halves the chain proves.
