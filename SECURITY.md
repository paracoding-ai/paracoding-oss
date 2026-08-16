# Security

**Paracoding — v8.4**
An agent platform that installs into your own Google Cloud project. Agents propose; you commit.

This document describes what this release enforces and how to report a problem. Every claim
below was checked against the source in this tree. If you find a claim here that no longer
matches the code, that is a defect and we want the report — see **Reporting** at the end.

---

## The claim, stated tightly enough to attack

> **No agent holds a credential that can change your infrastructure. The only principal that
> can is you. The only mechanism is a WebAuthn assertion produced on your own device, seconds
> before the command runs, bound to the exact command the gate showed you.**

Four moving parts:

1. **Staging.** An agent that wants to do something privileged does not do it. It writes a
   document into the Firestore collection `pending_confirms` with `status: 'pending'`, carrying
   the literal command it wants run and the identity it was authenticated as.
2. **The gate.** A Cloud Run service serves an approval page. You authenticate with a platform
   passkey. Reading the queue needs a valid session; approving needs a fresh assertion.
3. **Authority forwarding.** The gate's own service account is deliberately weak. On approval,
   the gate takes *your* short-lived Google OAuth token, forwards it to a separate private
   executor for one request, and never stores it. The command runs as you, with your scope, for
   the lifetime of one token.
4. **Journalling.** Every execution appends to the Firestore `journal` collection.

All standing privilege is concentrated in a human holding a hardware-backed key. The agents are
left with a database write.

---

## What the approval is bound to

An approval is signed at approval time with a Cloud KMS asymmetric key. The signature covers the
job id **and** the digest of the command as shown on the approval page.

- The control plane holds the private half. The executor that runs the job holds only the public
  half — it can verify a signature without being able to produce one.
- Edit the command after approval and the digest no longer matches; the executor refuses it.
- A claim is single-use: the executor claims the job for execution in a transaction, so the same
  approval cannot be replayed into a second run.
- Firestore IAM has no per-collection granularity. Something with database access can *corrupt*
  an approval. It cannot forge one.

## The binary jail

An approved script runs with `PATH` restricted to a jail directory built from an enumerated set
of binaries, so an unlisted command does not resolve. The jail is constructed before the request
handler runs and its state is journalled. What authorises the work in the first place is that a
human approved that exact command and the executor refuses any script whose hash does not match
the approval — the jail narrows what an approved script can reach for.

## Two services, one image

One built image is deployed as two Cloud Run services, and the split is a security boundary.

- `paracoding-control-plane` is the human console. Install step 8 puts it behind Identity-Aware
  Proxy, grants the installing account `roles/iap.httpsResourceAccessor`, and removes the public
  invoker binding, so an anonymous request is refused at Google's edge before the container is
  reached. Underneath IAP the console is still guarded by the application's own passkey session,
  and step 8 asserts that guard against the live deployment — `/harness` must answer an anonymous
  caller `401` with the locked page — *before* IAP goes in front of it. If it cannot enable IAP it
  says so and prints the command, rather than reporting a clean install.
- `paracoding-mcp` is the machine-facing surface: the MCP transports, OAuth 2.1 and its discovery
  documents, the agent cards, and the token-authenticated agent API. It is publicly invokable
  because IAP consumes the `Authorization` header and an MCP client has no Google identity to
  present. `POST /mcp` answers `401` to anything unauthenticated; a client that connects with no
  credential resolves to no role and receives exactly one tool, `whoami`.

Every route in the 90-route surface map is declared as `console`, `mcp` or `both`. A route that
maps to neither surface throws at boot rather than shipping a surface nobody audited.

## Identity

Every strain is a first-class identity with its own scope, journal lane and memory, and cannot
read another's — a leaked session key leaks a role, not the system. Role is resolved server-side
from the key when it is presented; it is never trusted from anything the caller sends. Session
keys are minted by you, expire (seven days by default), and are deliberately not shipped inside
any release artifact.

## Encryption at rest

Git objects and the data lake are sealed in the same envelope: AES-256-GCM with HKDF-derived
keys under X-Wing, the hybrid post-quantum KEM combining ML-KEM-768 and X25519 (1120-byte
ciphertext). Breaking it requires breaking both the lattice and the elliptic curve. The git
server itself has no git binary and no disk: refs live in Firestore under a serializable
compare-and-swap inside a transaction, objects in Cloud Storage as atomic whole-packfile writes.
There is no force push.

## Model access and billing

`config/models.fleet_mode` is a three-position switch. `home` makes no model call of any kind.
`dual` allows API-key transports. `work` is keyless Vertex only, billed to the project, and the
keyed transport is **refused in code** so a stray key cannot start billing a card. An unset,
unreadable or unrecognised value reads as `home`. The installer sets `work`.

Nothing in this release holds an API key, and none is needed to run it.

## Release gates

The release generator refuses to emit a tree that fails its checks: a leak-baseline ratchet, a
route audit, a blob audit, an image-reference hook, a boot-dependency check, and an AST-level
structural gate that parses the emitted executor and asserts the job-claim and subprocess calls
are where they are supposed to be. `MANIFEST.txt` records a truncated SHA-256 and byte length for
every file in the release, so a truncated or mis-copied download is detected on arrival.

## Non-goals

- This is not a sandbox for untrusted code. It is an approval boundary: the control is that a
  human approved one exact command, not that the command is confined afterwards.
- It does not defend a compromised approver device. A passkey on a machine an attacker already
  controls approves what that attacker asks for.
- It does not attempt bit-for-bit reproducible builds. A rebuild produces a working, equivalent
  deployment.

## If you are evaluating this

Read `gate-exec/exec_server.py` first — signature verification, job claim and the jail are all
there, in one file. Then `control-plane/src/index.ts` for the surface map and the staging path.
Then install it into a throwaway project and try to make it run something you did not approve.
That is the interesting test, and the answer we want is a refusal.

---

## Reporting

**If it is exploitable, do not open an issue.** Use GitHub's private vulnerability reporting on
this repository — the *Report a vulnerability* button under the Security tab. That channel is
private to the maintainers until a fix ships, and it is the only private channel offered. There
is no PGP key, and one will not be invented for this: a key nobody rotates and nobody has tested
receiving on is worse than telling you plainly that there isn't one.

**No service-level agreement, and no bounty.** This is maintained by a very small number of
people. You will get an acknowledgement when someone reads it, not on a clock, and there is no
money. Saying so is not a disclaimer — it is the input you need to decide how long to wait.

**If you get no response in two weeks, disclose publicly.** That is not a threat to manage, it is
permission granted in advance, and the two weeks starts when you send the report rather than when
someone reads it. A private channel that swallows a report is worse than no private channel,
because it converts your finding into silence and leaves every user of this tree exposed while
believing themselves covered. Escalating on that timetable is the correct behaviour and it will
not be treated as bad faith.

**Everything that is not exploitable belongs in a public issue**, and that emphatically includes a
claim in this document the code does not support. A documentation defect is a security defect
here: a control described more strongly than it is implemented stops you from looking, which is
worse than no control at all.

Apache-2.0. Keep the copyright headers and the NOTICE file.
