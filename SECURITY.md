# Security

**Paracoding — v8.5**
An agent platform that installs into your own Google Cloud project. Agents propose; you commit.

This document describes what this release enforces and how to report a problem. Every claim
below was checked against the source in this tree. If you find a claim here that no longer
matches the code, that is a defect and we want the report — see **Reporting** at the end.

---

## The claim, stated tightly enough to attack

> **No agent holds a credential that can change your infrastructure, and on a default
> install no agent can cause a privileged command to run at all. It can write a request into
> a database. Something outside the agent has to run it, and on a fresh install that
> something is you, by hand.**

That is the claim this release can actually support. It is narrower than "you approve every
command with a passkey", which is what earlier versions of this document said, and it is
narrower on purpose: the console page that offered a per-job approval was deleted, and a
security document that keeps describing a control after the control is gone is worse than no
document, because it stops you looking.

Three moving parts:

1. **Staging.** An agent that wants to do something privileged does not do it. It writes a
   document into the Firestore collection `pending_confirms` with `status: 'pending'`,
   carrying the literal command it wants run and the identity it was authenticated as.
2. **Nothing runs it.** `install.sh` sets `PC_AUTO_APPROVE=0`. A staged job sits at
   `pending` indefinitely — there is no queue anyone comes to tap, no retry, no timer. The
   shipped tool descriptions say this in as many words, and `list_pending_confirm` exists to
   show you the pile.
3. **Journalling.** Every execution, refusal and state change appends to the Firestore
   `journal` collection.

## If you turn auto-approve on

`PC_AUTO_APPROVE=1` makes a staged job sign and execute in the same call, with no human in
the loop. That is a real change of posture and it should be a deliberate one. What still
holds when you make it:

- **The approval is signed.** The control plane signs with a Cloud KMS asymmetric key over a
  length-prefixed canonical message (`PC-APPROVAL-CANON-V2`) covering the job id, the command
  digest, the command type, the argument digest, the key version, the approver, the issued-at
  and the expiry.
- **The executor holds only the public half.** It verifies a signature it cannot produce.
  Firestore IAM has no per-collection granularity, so something with database access can
  *corrupt* an approval — it cannot forge one.
- **One approval is one run.** The executor claims the job in a transaction before running
  anything, so a crash mid-run cannot leave it spendable, and the age of the approval is
  bounded from the signed issued-at.
- **A destructive body is still refused.** `install.sh` sets `PC_GUARDRAILS=1`, so a command
  the classifier reads as destructive is not run and is handed back to you in chat. Setting
  `PC_GUARDRAILS=0` removes that, and then a destructive body runs like any other.

## The passkey, described accurately

`PC_REQUIRE_PASSKEY=1` is the installed default, and Identity-Aware Proxy sits in front of
the console on top of it. Together they control **who can reach the browser surface**. That
is what the WebAuthn credential does in this release.

It is not a per-command approval. The routes for one still exist — `/api/webauthn/confirm/*`
for a live assertion, `/api/webauthn/preapprove` and `/api/jobs/fire` for a signed
run-later token with a single-use secret, a 12-hour expiry and a command-digest recheck that
returns 409 if the command moved — and `preapprove` hard-refuses a destructive body with 403.
But **no console page calls any of them**: `harness.html` does not reference `preapprove` at
all. They are an API surface, not something you can go and use.

---

## What the approval is bound to

Covered above under auto-approve, and repeated here as the short form: the signature covers
the job id and the digest of the command as signed, the executor verifies with the public
half only, edit the command afterwards and the digest no longer matches, and a claim is
single-use.

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

- This is not a sandbox for untrusted code. The `PATH` jail narrows what an approved script
  reaches for; it does not confine one.
- It does not offer a per-command human approval surface. It offers a stop.
- It does not attempt bit-for-bit reproducible builds. A rebuild produces a working,
  equivalent deployment.

## If you are evaluating this

Install it into a throwaway project, ask a strain for something privileged, and watch it
stage and stop. Then read `gate-exec/exec_server.py` — signature verification, the job claim
and the jail are all in one file — and `control-plane/src/index.ts` for the surface map and
the staging path. The interesting test is whether you can make it run something you did not
turn on. The answer we want is a refusal.

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
