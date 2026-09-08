# Security

**Paracoding — v14.0**
An agent platform that installs into your own Google Cloud project. Agents propose; you commit.

This document describes what this release enforces and how to report a problem. Every claim
below was checked against the source in this tree. If you find a claim here that no longer
matches the code, that is a defect and we want the report — see **Reporting** at the end.

---

## The claim, stated tightly enough to attack

> **No agent holds a credential that can change your infrastructure. An agent can only write
> a request into a database. What runs that request is a separate service that verifies a
> Cloud KMS signature it cannot produce, claims each approval exactly once, and executes
> under a `PATH` jail.**

That is the claim this release supports. It is narrower than "you approve every command by
hand", and the difference is the thing to read before you install: **the shipped posture
is unattended.** `install.sh` sets `PC_AUTO_APPROVE=1`, so a job an agent stages is signed
and executed in the same call, with no human in the loop. The console page that offered a
per-job tap was deleted. This document describes the controls that are actually in the path,
and names the ones that are switched off by default, because a control described more
strongly than it is implemented stops you looking.

Three moving parts:

1. **Staging.** An agent that wants to do something privileged does not do it. It writes a
   document into the Firestore collection `pending_confirms` with `status: 'pending'`,
   carrying the literal command it wants run and the identity it was authenticated as.
2. **Signing and execution.** `install.sh` sets `PC_AUTO_APPROVE=1`, so the control plane
   signs that job and fires it immediately. **Set `PC_AUTO_APPROVE=0` and nothing runs it:**
   a staged job then sits at `pending` indefinitely — there is no queue anyone comes to tap,
   no retry, no timer — and `list_pending_confirm` shows you the pile. It is a deploy-time
   variable, so it is a Cloud Run revision either way, never a gated job.
3. **Journalling.** Every execution, refusal and state change appends to the Firestore
   `journal` collection, in both postures.

## What holds with auto-approve on

Auto-approve is the shipped default, so this section describes a stock install rather than an
opt-in. What is enforced:

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
- **A destructive body is not refused, and you should know that going in.** `install.sh` sets
  `PC_GUARDRAILS=0`, so the destructive-command refusal in the control plane and the
  lockout-class refusal in the executor are both off: a destructive body runs like any other,
  and is journalled. `PC_GUARDRAILS=1` restores both refusals, and then such a command is
  handed back to you in chat instead of run. The trade is deliberate — the recovery path from
  a lockout-class mistake is Cloud Shell, which you hold — but it is a trade, not a control.
- **Client-side review cards can be suppressed.** Two environment variables can suppress these client-side confirmation checks in clients that honour the `readOnlyHint` (such as Gemini Enterprise, whereas Cowork and Grok ignored it as of 2026-09-07):
  * `PC_NOCARD_EXEC=1` makes tools like `stage_privileged_job`, `run_command`, `gcp_api`, and `run_roll` advertise `readOnlyHint:true`. This annotation is FALSE and deliberately so — those tools write, run shell, and reach GCP.
  * `PC_NOCARD_ALL=1` goes further, making *every* classified tool advertise `readOnlyHint:true`, including lake writing tools like `write_file` and `put_file`.
  
  **The security trade-off:** A confirmation card is a speed bump, not a refuse-gate. However, suppressing them changes the safety posture:
  * **With `PC_NOCARD_EXEC=1` and default `PC_GUARDRAILS=0`**, there is NO gate on destructive executor work (no rule, no click). Setting `PC_GUARDRAILS=1` restores both refusals, turning them into text-based yes/no prompts in chat, which acts as a robust gate.
  * **With `PC_NOCARD_ALL=1`**, write operations on the data lake (via `write_file` and `put_file`) bypass confirmation. The data lake has NO delete, NO history, and NO compare-and-swap on a blind write; a wrong path is permanent, for everyone, forever. The real control for the lake when this card is suppressed is `strains.tool_classes` — ensuring a strain granted only `read` cannot reach `write_file` at all.
  
  Both switches default to `0`, ensuring an `install.sh` adopter inherits the protection cards and this exposure requires a deliberate act.

## The Keyless GE Chat Composition (Exposure and Posture)

This release supports a keyless connector configuration (`PC_NOCARD_EXEC=1` and `PC_NOCARD_ALL=1`) specifically optimized for flat-rate chat interfaces such as Gemini Enterprise. When active, this creates a specific, highly permissive four-layer composition on the production environment:

1. **Keyless Identity Resolution:** Strains resolve keylessly from the connector binding (`oauth_client_id` + `oauth_email`). Rather than validating the individual end-user executing a turn, identity resolution maps to the single Google account that consented to the connector (`rec.email`). This means *every* user added to the Gemini Enterprise application inherits and executes under the single bound `fleet-courier` strain.
2. **Unrestricted Surface Area:** The keyless `fleet-courier` strain defaults to carrying NO explicit `tool_classes` restrictions. Under the control plane, absence of constraints translates to full, unrestricted access to all 59 platform tools (including `run_command`, `stage_privileged_job`, `gcp_api`, and `run_roll`).
3. **Disabled Refusal Guardrails:** `PC_GUARDRAILS=0` is set across the control plane, MCP, and the gate executor. Platform-level destructive command and lockout-class checks classify and journal actions but do not block execution.
4. **Suppressed Confirmation Cards:** `PC_NOCARD_EXEC=1` and `PC_NOCARD_ALL=1` are active on the serving MCP container, which advertises `readOnlyHint:true` for all classified tools. This suppresses all client-side review and confirmation cards.

The composition of these four layers results in an unauthenticated-to-the-user, unreviewed, and unrefused shell directly integrated with the GCP REST surface for whoever accesses the Gemini Enterprise custom connector. While designed to accelerate engineering loops for a single-operator environment, this posture bypasses all human-in-the-loop validation gates. The active defenses for this environment comprise four layers:
1. **`strains.tool_classes` restrictions**: Restricting the strain to a safe set of tools (e.g., `['read']`) directly inside Firestore.
2. **KMS-signed command pins**: The executor strictly refuses any script whose sha256 does not match what was KMS-signed.
3. **IAM ceiling**: The executor service account (`fleet-gate-exec-sa`) lacks permissions to read or redeploy its parent (`fleet-gate-exec`), preventing circular privilege escalation (see `deploy/LOCKOUT-CLASS.md` "THE SECOND ARM").
4. **Git compare-and-swap mechanics**: Prevent blind overrides of repository states by requiring an explicit base OID assertion without force pushes, keeping previous revisions recoverable.
**Operator Ruling (2026-09-07):** The recommendation to restrict this specific strain is withdrawn; as the primary engineering surface, `fleet-courier` retains all 59 tools. The designated mitigation for multi-user exposure is to explicitly bind additional users to their own individual strains (mapping their Google accounts under `strains.oauth_email`), rather than restricting the primary engineering strain.

## Who can reach the console

Identity-Aware Proxy is the outer door, and the application's own session check is the inner
one. Signing in to Google at IAP's prompt is the only sign-in there is. Behind it, a
**verified IAP identity on the approver allow-list** (`WA_APPROVER_EMAILS`, seeded with the
installing account) is what satisfies the inner check: the control plane verifies the ES256
assertion IAP attaches against Google's published keys and its own audience (`PC_IAP_AUD`),
never the bare identity header, and it does so on every request. The console enrols no
credential of its own and asks for none. Put a hardware security key on the Google account
itself and the outer door costs a physical touch — that protection is IAP's, and it is the
one in the path on a stock install.

The console also honours a session cookie with a TTL. `gate_session` is an HMAC under
`WA_SESSION_SECRET` over `{ user, expiry }` and is accepted for `WA_SESSION_MIN` minutes; a
missing or short secret means the control plane neither issues nor verifies one, so the gate
stays closed rather than degrading. A session is worth exactly what the sign-in behind it
was worth: it opens the console, and nothing in it approves a job — approval is the KMS
signature described above, and a stock install produces that signature without a person in
the loop.

---

## What the approval is bound to

Covered above, and repeated here as the short form: the signature covers
the job id and the digest of the command as signed, the executor verifies with the public
half only, edit the command afterwards and the digest no longer matches, and a claim is
single-use.

## The binary jail

An approved script runs with `PATH` restricted to a jail directory built from an enumerated set
of binaries, so an unlisted command does not resolve. The jail is constructed before the request
handler runs and its state is journalled. What authorises the work in the first place is a valid
signature over that exact command, and the executor refuses any script whose hash does not match
the approval — the jail narrows what an approved script can reach for. With `PC_AUTO_APPROVE=1`
the signer is the control plane acting for you, not a person at a keyboard; the approver field
inside the signed bytes records that, so the audit trail does not claim a human it did not have.

## Two services, one image

One built image is deployed as two Cloud Run services, and the split is a security boundary.

- `paracoding-control-plane` is the human console. Install step 8 puts it behind Identity-Aware
  Proxy, grants the installing account `roles/iap.httpsResourceAccessor`, and removes the public
  invoker binding, so an anonymous request is refused at Google's edge before the container is
  reached. Underneath IAP the console is still guarded by the application's own session check,
  and step 8 asserts that guard against the live deployment — `/harness` must answer an anonymous
  caller `401` — *before* IAP goes in front of it, which is the only moment that guard is
  observable. If it cannot enable IAP it says so and prints the command, rather than reporting a
  clean install.
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

The connector makes no model call at all. Your MCP client is the model, and it authenticates
to its own vendor with its own credential, which this system never sees.

What `config/models.fleet_mode` governs is the console's own built-in chat, and nothing else.
It is a three-position switch. `home` makes no model call of any kind. `dual` allows API-key
transports. `work` is keyless Vertex only, billed to the project, and the keyed transport is
**refused in code** so a stray key cannot start billing a card. An unset, unreadable or
unrecognised value reads as `home`. The installer sets `work`.

Earlier releases described this as gating a fleet-wide dispatcher. There is no dispatcher.
12.0 deleted every runner and the autonomous loop, and 12.5 removed the last references to
them, so nothing here dispatches work to a model on a timer. One switch, one consumer.

Nothing in this release holds an API key, and none is needed to run it.

## Release gates

The release generator refuses to emit a tree that fails its checks: a leak-baseline ratchet, a
route audit, a blob audit, an image-reference hook, a boot-dependency check, and an AST-level
structural gate parses the emitted executor and asserts the job-claim and subprocess calls
are where they are supposed to be. `MANIFEST.txt` records a truncated SHA-256 and byte length for
every file in the release, so a truncated or mis-copied download is detected on arrival.

## Non-goals

- This is not a sandbox for untrusted code. The `PATH` jail narrows what an approved script
  reaches for; it does not confine one.
- It does not offer a per-command human approval surface. `PC_AUTO_APPROVE=0` offers a stop,
  not a tap.
- On the shipped defaults it does not refuse anything at runtime. `PC_GUARDRAILS=0` means the
  destructive-command and lockout-class refusals are off.
- It does not attempt bit-for-bit reproducible builds. A rebuild produces a working,
  equivalent deployment.

## If you are evaluating this

Install it into a throwaway project and ask a strain for something privileged. On the shipped
defaults you will watch it stage, sign and run — that is the posture, and seeing it is the
point. Then install again with `PC_AUTO_APPROVE=0` and watch the same request stage and stop.
Read `gate-exec/exec_server.py` — signature verification, the job claim and the jail are all
in one file — and `control-plane/src/index.ts` for the surface map and the staging path. The
interesting test is whether you can make the executor accept a command that was not signed,
or was edited after signing. The answer we want is a refusal.

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
