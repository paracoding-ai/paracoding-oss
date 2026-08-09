# Paracoding v3 — Security Whitepaper

**Release v3 · 2026-08-03**

An agent platform that installs into your own Google Cloud project. Agents propose; you
commit. This document states what v3 enforces, what changed to get here, and what it still
does not do. Every claim was checked against the source in this tree.

Three phrases do not appear in this document: *appears secure*, *should be safe*,
*industry standard*. They are the three ways security prose lies without technically lying.

`SECURITY.md` in this tree is the detailed, per-control document and is the authority where
the two differ. This whitepaper is the shape of the argument and the record of the v3 cut.

---

## 1. The claim

> **No agent holds a credential that can change your infrastructure. The only principal that
> can is you. The only mechanism is a WebAuthn assertion produced on your own device, seconds
> before the command runs, bound to the exact command the gate showed you.**

Four moving parts: an agent *stages* a job into Firestore; a Cloud Run *gate* shows it to you
and takes a passkey assertion; on approval the gate forwards *your* short-lived OAuth token to
a private *executor* for one request and never stores it; every execution *journals*.

All standing privilege is concentrated in a human holding a hardware-backed key. The agents
hold a database write.

---

## 2. Status at the v3 cut

| | |
|---|---|
| Open security work items | **0** |
| Jobs pending at the gate | **0** |
| Known defects | **2** (§2a) |
| Known limitations, documented | **8** (§6, and `SECURITY.md` §7) |

A *defect* here means what `SECURITY.md` says it means: a claim in the documentation that no
longer matches the code. A *limitation* is a control that is weaker than someone might assume,
described accurately. The first is a bug. The second is a boundary. Conflating them is how
security documents start lying.

### 2a. The known defects

Both are the same kind: something the release *registers* or *references* that `install.sh`
does not *provision*. Both were measured against the emitted tree at this cut, not inferred.

1. **Ten of the 43 registered tools have no backing infrastructure in this release.**
   `read_file`, `write_file`, `list_files` and `put_file` read and write a Cloud Storage
   bucket; `vm_status` and `ssh_executor` act on a Compute Engine instance; `browser_open`,
   `browser_navigate`, `browser_eval` and `browser_tabs` need a Chrome DevTools endpoint.
   The code reads `DATA_LAKE_BUCKET`, `LAKE_BUCKET`, `WS_VM`, `WS_ZONE` and `WS_CDP_PORT`;
   the installer sets none of them and creates none of those resources. The tools register
   cleanly and then fail when called. `README.md` tells the adopter so under "Not included".
2. **`PC_CREDS_SECRET` names a secret that is never created.** Step 7/10 passes
   `projects/<project>/secrets/pc-webauthn-creds` to the executor. `install.sh` never
   creates that secret and never grants the executor access to it. It is inert today only
   because the release ships `PC_REQUIRE_ASSERTION=0`; arming per-job assertions without
   fixing this first turns a security upgrade into an outage.

Neither is a claim this document made that the code failed to honour. They are claims the
*packaging* made. The row above said **0** because nobody had counted; it has now been
counted, mechanically, against the emitted tree.

---

## 3. What v3 changed

### Identity is resolved server-side, and expires

A chat binds to a strain with a server-minted session key. The key is a **credential to be
looked up, never a claim to be believed**: a value that does not resolve is refused outright,
never downgraded to a weaker role and never silently upgraded. Only `sha256(key)` is stored.

Keys now carry an expiry — seven days by default, `PC_KEY_TTL_DAYS` — enforced server-side at
resolution. Before v3 a key was valid forever, so one pasted into a transcript, a screenshot or
a shared log was a permanent credential that only an explicit revoke could kill.

**Possession of the key is the identity.** Every chat reaches the control plane through one
account-level connector: one bearer, one client ID, a stateless transport. The server has no
signal distinguishing chat A from chat B. Two chats given the same paste are the same role.

### Workloads authenticate; they do not assert

A workload presents a Google-signed service-account ID token. Google verifies signature and
expiry, the audience is pinned to this deployment's own public URL as a replay guard, the
identity must be a `.iam.gserviceaccount.com` principal, and it resolves against the `strains`
registry by `sa_email` with `status == active`.

A workload **cannot claim another strain's identity** without that service account's
credentials. And because the service account carries its own IAM, which strain a workload is
also bounds what it can do in your project. This is authentication, and it is real authority.

There is deliberately no strain picker on the consent page. That page is reachable by anyone,
and a form field is not an authorization boundary.

### Per-role tool surfaces exist and are enforcing

`strains/<role>.tool_classes` selects which classes of tool a role receives — read, write,
stage, infra, browser — filtered at **registration**, so a role never sees a tool it may not
use rather than discovering the fact through a denial. `PC_TOOLS_ENFORCE=1` ships on.

An absent, empty or malformed field means **every class**. `whoami` is never withheld, so a
role can always report what it is. A role holding a class nobody defined gets `whoami` only,
not nothing.

This deployment narrows no strain, so every admitted role currently receives the same toolset.
That is a setting left open, not a capability the platform lacks: narrowing a role is a
database field that takes effect on the next request, with no deploy.

### OAuth credentials are revocable

`oauth_tokens` and `oauth_refresh` carry a `revoked` flag honoured in **both** the bearer path
and the `refresh_token` grant. Enforcing it in only the first would be worse than not having
it — a credential would be reported dead while it still minted access tokens.

A successful authorization marks prior credentials for the same `client_id` **and** `email`
revoked, so authorizations stop accumulating. Scoped by both fields because a client
registration can be shared, and one principal signing in must not retire another's session.
The sweep is fail-soft and journalled: tidying old credentials never blocks a sign-in.

`revoked` is read as `=== true`, never `!== false`, so records predating the change keep
working until something explicitly revokes them.

At the v3 cut this was proven against the live service — a credential was minted, refreshed
successfully, revoked, and the same token refused with nothing minted — and 87 accumulated
records were retired.

### Approvals are signed with a key the executor cannot use, and spent exactly once

The control plane records `sha256(command)` at approval time and signs the approval with a
**Cloud KMS asymmetric key** (`EC_SIGN_P256_SHA256`). The executor verifies it with the **public
half only**: it holds `roles/cloudkms.publicKeyViewer` on that key and nothing that can sign.

That asymmetry is the change. Until v3 the stamp was a symmetric HMAC under a Secret Manager
key, and the executor held that same key in order to verify — so the service this threat model
names as the adversary was also holding the signing key, and could mint an approval for any
command it liked. The symmetric MAC is gone from the executor: it reads no `APPROVAL_MAC_KEY`
and computes no HMAC.

How far that has been carried differs by installation, and the difference is worth stating rather
than blurring. **A new installation does not provision `pc-approval-mac-key` at all** — the
installer no longer creates the secret, grants it, or injects it into any service, because after
the executor stopped reading it the key verified nothing and was pure rotation burden. **An
existing installation keeps it until the dual-emit is removed at source.** The control plane's
approve path still writes the legacy HMAC beside the KMS signature when the key is present, which
is what an executor predating the change relies on; the emit is conditional on the variable, so
its absence on a new install skips the HMAC and leaves the KMS signature standing alone rather
than failing the approval. The honest summary is that the MAC is gone from the executor and gone
from new installs, not gone.

The signed message is `PC-APPROVAL-CANON-V1`: a 21-byte domain tag and seven length-prefixed
fields — `alg`, `jid`, `csha`, `appr`, `kver`, `iat`, `exp` — with UTF-8 byte lengths and RFC3339
UTC timestamps. The executor never parses it; it rebuilds it and verifies over the rebuild,
taking the job id from the job it is running and the command digest from the command it is about
to run rather than from the stamp. Length prefixes rather than a delimiter, because a `|` join
lets two different field tuples produce identical bytes and one signature would then cover both.

Failure is not one condition. Present and not verifying, or verifying but expired or
future-dated, is `bad`. Present but uncheckable — no key-version allowlist, a version off the
allowlist, an unfetchable or wrong-algorithm public key, a malformed field — is `unverifiable`.
Both are 403 **unconditionally**, gated on no flag. Only a wholly absent signature can be
allowed, and only where `APPROVAL_REQUIRE_SIGNED=0`.

Firestore IAM has **no per-collection granularity**, and the executor genuinely needs writes: it
spends the approval in a `@firestore.transactional` claim, journals every path including
refusals, and writes `executed_at`. So it must hold project-wide `datastore.user`, meaning it can
rewrite the document it verifies. What it cannot do is sign one. **A principal with database
access can corrupt an approval; it cannot forge one.** Anything corrupted is refused.

The approval is consumed atomically in its own field before the subprocess starts, inside a
transaction that re-reads status. A crash mid-run does not leave a live approval, and a
`confirmed` approval expires after an hour.

### The build refuses encoded documents

`blob-audit.mjs` runs beside the route audit, before esbuild: a base64 literal decoding to
markup, source or a gzip stream fails the build, and a failed build produces no image.

It exists because 57% of this control plane's published source was once base64 — four HTML
documents inlined as constants — while the release scanner read plaintext only and declared the
tree publishable. The release generator now decodes and gunzips long runs before applying its
banned patterns, so an operator name hidden inside a blob is found rather than reported clean.

It does not ban base64: `data:` URIs and runtime environment decodes are exempt, because a gate
that cannot be satisfied gets deleted by whoever hits it next. Its limit, stated plainly: it
sees single-line runs of 200 or more base64 characters. A document split across concatenated
literals evades it.

### The enrolment credential does not live in the service

`WA_BOOTSTRAP_SECRET` gates first-passkey enrolment and is checked **only** when zero
credentials exist. Adding devices later goes through a separate path gated by an unlocked
session or a five-minute pairing link, which never reads it.

The installer mounts it, you enrol, and it is removed. On this deployment it has been removed
entirely and the stored secret deleted — nothing kept, nothing to leak. Re-enabling first
enrolment is a deliberate act by someone with project access, using a value they generate at
that moment.

---

## 4. What the release refuses to ship

The generator will not emit a release that fails any of these:

- **Wrong lineage.** Seven security markers must be present in the control plane and three in
  the executor, and the function responsible for a past outage must be absent.
- **Missing files.** An absent source used to be a skipped file and a green report. It is now a
  refusal — emitting less than promised is not a warning.
- **Operator-specific values.** Project IDs, session keys, bucket names, bearer tokens, API
  keys, the operator's name and the operator's hostnames. The scan decodes base64 first.

The banned-hostname patterns are deliberately narrow: they match hosts and URLs, not the
product name, because an earlier draft matched the trademark string and could never have been
satisfied.

---

## 5. Threat model

**Assumed sound:** Google Cloud's control plane, Firestore, Cloud Storage; your device's secure
element; TLS; and that you read the command on the approval screen before tapping. That last
one is load-bearing.

| Actor | What they get | Bounded by |
|---|---|---|
| Anonymous internet | the gate page and `/`. `POST /mcp` is 401, `/rdp` is 403, the executor is not publicly invokable | §3 |
| Someone holding your unlocked device | everything you have | non-goal |
| A compromised agent session key | stage jobs, read and write the shared drop zone, read job output — **cannot approve** | §3 |
| A principal with database write | corrupt an approval into a refusal; rewrite the journal. **Cannot forge an approval** | §3 |
| You | full project authority | intended |

Spoofing the human is hard: WebAuthn with user verification enforced and per-job assertion
binding. Spoofing a workload is hard: Google-attested tokens against a fail-closed registry.
**Tampering carries the residual risk**, and the approval signature is what carries it.

---

## 6. Known limitations

Ordered by what would be fixed first. These are accurate descriptions, not defects.

1. **The executor holds project-wide database access.** Firestore IAM cannot scope a grant to a
   collection, and the executor genuinely needs the writes — the single-use claim, the journal
   on every path, the result. The architectural fix — pass the approved command and its
   signature in the request, take the database away entirely — is not done.
2. **An unsigned approval is refused only where the executor is armed.**
   `APPROVAL_REQUIRE_SIGNED` gates the *absent* case alone; `bad` and `unverifiable` are 403
   regardless. A fresh install provisions the KMS key and sets it to `1`. An upgrade, a
   hand-pinned key version, or a `--rehearse` run with no KMS leaves it unset, and an absent
   signature is then allowed and journalled as `exec_approval_sig_absent`.
3. **The route audit proves less than it looks like.** "Guarded" is a substring test; rate
   limiters count as guards; WebSocket upgrade handlers are invisible to it.
4. **The installer's self-test does not exercise the execution path.** Approve one trivial job
   before trusting a new install.
5. **The manifest detects accident, not tampering.** Nothing signs the manifest.
6. **Builds are not reproducible.**
7. **Secrets touch disk during installation.** The removal is not on a trap.
8. **The installer needs an interactive terminal.**

Also true, and chosen rather than overlooked: no strain narrows its tool classes, so role
binding does not yet restrict what any admitted role can do; the data lake is plaintext at rest
and the envelope-encryption code in the tree is scaffolding reachable from two internal
callers; and a principal that can write Firestore can forge a pairing token, which is a
blast-radius property of a control-plane compromise rather than a standalone vulnerability.

---

## 7. Non-goals

**Multi-tenancy.** One operator, one project. **Separation of duty.** The approver is the
project owner; no two-person rule. **Least privilege at approval time.** Approval forwards your
full `cloud-platform` scope. **Protection against a compromised device.** The passkey is the
root of trust. **Agent alignment.** Nothing here constrains what an agent wants; the gate
constrains what it can do without you. **Confidentiality from your cloud provider.** No CMEK
and no application-layer envelope encryption.

---

## 8. If you are evaluating this

1. Approve one trivial job. `INSTALL COMPLETE` does not cover the execution path.
2. Confirm your authenticator performs user verification — a biometric or PIN every time, not
   just a tap.
3. Confirm `APPROVAL_REQUIRE_SIGNED=1` on the executor — a fresh install sets it, an upgrade
   does not. If not, watch the journal for `exec_approval_sig_absent` and set it once that line
   stops.
4. Read `control-plane/route-baseline.json` to see which routes are public. Do not infer it
   from a green build.
5. Treat the Content-Security-Policy as absent until it stops being report-only.
6. Verify state from the journal, not from a document in the shared drop zone.

## Reporting

If you find a claim in this document or in `SECURITY.md` that the code does not support, open
an issue. A control described more strongly than it is implemented stops you from looking,
which is worse than no control at all.

Apache-2.0. Keep the copyright headers and the NOTICE file.
