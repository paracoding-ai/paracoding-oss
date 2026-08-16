# Paracoding — what's in it

What this is, feature by feature. Every count and name here was read out of the tree this
file ships in, not recalled — the route totals from `PC_SURFACE_MAP`, the tool names from the
registrations, the installer behaviour from `install.sh`. Version and commit are in `oss/VERSION` and `MANIFEST.txt` rather than repeated here, so this
page cannot drift from the release that carries it.

---

## 1. It installs itself into a bare GCP project

- **One command.** `bash install.sh YOUR_PROJECT_ID` takes an empty project to a running
  control plane in 10 phases.
- **It stops where a human is genuinely required** and says exactly what to do — passkey
  registration, the Google OAuth client, the org-policy decisions.
- **Resume, not restart.** A failed run picks up where it stopped instead of re-creating
  what already exists. Every phase is existence-checked.
- **A refusal is never a silent skip.** Missing sources, absent files, a step that declines
  — each one prints `##PCSTEP FAIL` or a named warning. Optional components (the Windows
  workstation) *warn* and continue; required ones abort.
- **`uninstall.sh` removes what it made**, including secrets it created and nothing it didn't.
- **A workstation VM** is optional, idle-stopped, and refuses to be created with a public
  RDP port — the refusal is the feature.

## 2. Two services from one image

One container image, one route table (**90 routes**), deployed twice with different env:

| | Console | MCP |
|---|---|---|
| Who reaches it | a human in a browser | an agent / MCP client |
| IAP | **on** | **off** |
| Routes registered | 67 | 28 |
| Routes withheld | 23 | 62 |

A route that lands on neither surface **throws at boot** rather than shipping a silently
broken install. The split exists because IAP consumes the `Authorization` header an MCP
client needs — the two-service split is what lets a browser and a machine client each get
the auth they require.

## 3. Access control that fails closed

- **Google IAP** as the outer door, with hardware-key or passkey accounts.
- **WebAuthn passkey session** as the inner door. A weak `WA_SESSION_SECRET` means *no valid
  sessions at all*, because an empty-key HMAC is forgeable.
- **A session minted while passkeys were off does not survive turning them back on.**
- **Org policy** (`allowedPolicyMemberDomains`) makes out-of-domain access *impossible to
  grant*, not merely discouraged — enforced when the binding is written.
- **401 served in place**, at the URL you asked for. No `?next=` redirect, so no enumeration
  oracle and no browser credential dialog.
- **Elevation is separate from session** and is bound to *one job id and one command digest*
  — an edited command is refused. "The human did a Face ID recently" has never been enough.

## 4. Agent identity — strains

- A **strain** is a role: its own lake folder, journal lane, work items, lessons file, scope.
- **Scope is real.** A strain reads `shared/…` and its own `agents/<role>/…` and nothing
  else. It cannot read another strain's private folder.
- **A leaked session key is a leaked *role*, not a leaked system** — and still buys nothing
  privileged, because execution sits behind the passkey regardless of who asks.
- **Attribution is a fact, not an inference.** Every journal row, staged job and lake write
  carries the role that did it.
- Three ship by default (advisor, gcp, security). Two service identities are seeded hidden.
- **Session keys are credentials, not names** — a role name resolves to nothing, and a key
  that doesn't resolve is refused rather than downgraded.

## 5. The MCP surface — ~55 tools

Full OAuth 2.1 (PKCE, dynamic client registration, discovery) **and** a legacy bearer path.

- **Work** — `post_work_item`, `list_work_items`, `complete_work_item`, `cancel_work_item`,
  `dispatch`, `run_roll`, `run_status`
- **Memory graph** — `create_entities`, `create_relations`, `add_observations`,
  `open_nodes`, `search_nodes`, `read_graph`, plus delete/retract
- **History & audit** — `read_journal`, `append_journal`, `read_history`, `search_history`,
  `log_history`, `read_job_log`
- **Lake** — `read_file`, `write_file`, `put_file` (binary), `list_files`
- **Git** — `git_read`, `git_list`, `git_log`, `git_diff`, `git_propose`,
  `git_propose_patch`, `git_push`
- **Execution** — `run_command`, `stage_privileged_job`, `list_pending_confirm`
- **Infra** — `gcp_api`, `vm_start`, `vm_stop`, `vm_resize`, `vm_status`
- **Messaging** — `ask_agent`, `answer_message`, `list_my_messages`, `check_answer`
- **Browser** — `browser_open`, `browser_navigate`, `browser_tabs`
- **Identity** — `whoami`, which also delivers the fleet memory digest and bootstrap

An unauthenticated client gets exactly one tool — `whoami` — which explains why.

## 6. Two MCP protocol eras on one endpoint

The modern **`2026-07-28`** revision — stateless, per-request metadata — is served on the
**same `POST /mcp`** that keeps answering the 2025-era `initialize` handshake. A client of
either generation connects to one URL and gets the protocol it speaks.

- **Routing is a pure function of one request's bytes.** No connection state, no cache, no
  clock, no per-instance flag — because clients are told to cache the era for the lifetime of
  the origin, and two instances answering differently would make a client pin the wrong one
  for its whole process.
- **The two branches cannot leak into each other.** The modern error codes `-32020` /
  `-32021` / `-32022` and the HTTP `404` / `405` / `406` answers exist in the modern file and
  nowhere else, so a legacy request can never be answered in a dialect it does not know.
- **The v2 SDK is asserted at boot, not at first use.** A dedicated module checks that the
  dependency resolves *and* exposes `createMcpHandler`, and throws — deliberately uncaught —
  if it does not. A broken dependency fails the boot, so Cloud Run keeps serving the previous
  good revision instead of routing traffic to a green container missing a capability.
- **`DELETE /mcp` is registered on purpose.** The modern transport mints no session, so
  DELETE-to-terminate is gone; leaving the verb unregistered returns a bare 404, which a
  dual-era client reads as "no modern endpoint here" and follows by probing the deprecated
  SSE transport — a failure whose diagnostic points at the wrong thing.

## 7. It ships as an agent plugin

An **Agent Plugins 1.0.0** package (`plugin.json`, `mcp.json`, a README) rides in the release,
so agent clients other than this project's own console can reach the control plane.

- **The version is derived from the release**, not typed, so the connector an adopter installs
  never reports a version the tarball is not.
- **The manifest ships with a placeholder host**, because Cloud Run assigns the hostname at
  deploy time and it cannot be known when the release is cut. `install.sh` prints the real
  value at the end of a successful run and writes a ready-to-use copy beside the release.
- **That generated copy is deliberately excluded from `MANIFEST.txt`** — editing a manifested
  file in place is exactly the drift this release refuses to allow.
- **It declares no `headers` block, on purpose.** The credential is yours, it expires, and it
  does not belong in a file that ships in a release tarball. Mint a session key first.

## 8. A git server that stores encrypted objects

`pcgit` — a real git implementation over Firestore + Cloud Storage.

- **Refs in Firestore, objects in Cloud Storage.** Refs get true serializable
  compare-and-swap; objects get atomic whole-packfile writes that a 1 MiB document limit
  can't hold.
- **Every object is sealed** with a PCV1 envelope: AES-256-GCM, HKDF-derived keys, and the
  **full object key bound into the AAD** so two repos at the same virtual path can't collide.
- **Compare-and-swap above isomorphic-git**, because its own `writeRef` is a blind overwrite
  and its lock is in-process only. `git_push` *requires* `expected_oid`. Outcomes are
  classified (`STALE` / `NOT_FOUND` / `ALREADY_EXISTS`), never retried. **There is no force push.**
- **`GET /git/archive`** hands a build a reproducible gzipped tarball — mtime 0, gzip level 9,
  so the same commit archives to the same bytes. Authenticated by a Google-signed service
  account ID token, audience-pinned, allowlist **fails closed when unset**.
- **`POST /git/blob`** takes raw bytes straight into the object store, so landing a large or
  binary file never means retyping it through a model.

## 9. The vault

- **PCV1 envelope**, epoch-versioned, with a **post-quantum X-Wing KEM** master key in Cloud KMS.
- Cleartext prefixes are explicit and minimal, so the bootstrap path can always be read.
- A blob that isn't PCV1 is returned verbatim and never decoded to a string — a git object is
  a zlib stream and a UTF-8 round trip corrupts it silently.

## 10. Authorised execution — the gate

- Jobs are staged with a **command digest**, then executed by a **separate Cloud Run service**
  that holds no standing admin roles and, since `SEC-EXEC-NO-DATASTORE-V1`, **no database
  access at all**.
- The approval arrives in the request body and is trusted **exactly as far as its KMS
  signature covers**: job id, command digest recomputed from the arguments about to run, a
  hash of the canonical JSON of the whole argument object, approver, key version, expiry.
- **One approval is one run**, consumed atomically. A failed substitution can't burn a real
  approval, and an *unknown* claim outcome means the job does not run.
- **Lockout classes** — nine categories of change that destroy the way back in (service
  rename, domain mappings, OAuth, auth secrets, KMS, the signer, identity writes, env
  clobber). Refusal is **by rule id, never by vibe**, so it can be argued with.
- **The result is an object before it is a response** — written create-only to a bucket, so a
  caller that went away costs nothing.
- **Guardrails are one switch** (`PC_GUARDRAILS`), off by default per the operator's ruling,
  on for anyone who wants the brakes.
- **A binary PATH jail.** The approved script runs with `PATH` restricted to a directory of
  symlinks to an enumerated set of binaries, so an unlisted binary does not resolve — `gsutil`
  and `ssh` answer `command not found`. Shell builtins and keywords do not resolve through
  `PATH`, so an ordinary `set -uo pipefail` preamble is unaffected. Command substitution, pipes
  and `xargs` resolve through `PATH` too, so they are covered rather than evaded.

## 11. Memory that survives the session

- **Knowledge graph** with typed entities, relations, and observations carrying a confidence
  level — `measured` / `inferred` / `reported` — and evidence (job id, path, revision).
- **Corrections supersede, never overwrite.** Retracted history stays readable, so you can
  tell a corrected claim from a current one.
- **Three layers, read in order when something is disputed**: the graph, then the journal
  (written by services — the audit trail), then history (written by agents — what an agent
  *believed*, including claims later retracted).
- `whoami` **delivers** the digest rather than telling an agent to go and read it.

## 12. The console

- **Flowhood chat** — talk to a strain, which can run tools and build things. Claude and
  Gemini, with a 16-round tool loop sized to fit the build-and-deploy flow it documents.
- **When a model ends a turn silently, you get a report** — how many tools ran, what each
  returned, whether the round limit cut it off, and the model's own stop reason.
- **Dashboard** — public shell, but every data call checks the session and 401s an anonymous
  caller *before* touching Firestore or BigQuery.
- **A terminal, VM controls, fleet views**, and a **built-in wiki** with 11 pages.
- **Freshness badges.** Each wiki page declares the artifacts it watches and goes amber when
  they move — a page can prove it is current, or admit it can't.
- **Mushroom mode and regular mode** — gold or blue-green, and a lexicon that rewrites the
  product's own vocabulary.

## 13. Release engineering that refuses

`gen.py` cuts the public release and is the largest pre-ship check in the system.

- **Cut twice, diff — identical.** `oss/VERSION` is an *input*; the generator refuses a
  missing or malformed version rather than bumping a counter.
- **Leak gates with a ratchet.** Operator identity, project ids, hostnames — each category
  has a ceiling in `leak-baseline.json`; at or below passes, above **refuses**, and the
  standing rule is remove the reference rather than raise the ceiling.
- **Route audit** as a build step before esbuild: a new unguarded route, a vanished route, a
  wildcard, or a registration not at column zero **fails the build**, so no image is produced.
- **Blob audit** for encoded documents in string literals.
- **Image gate** — an emitted document referencing an image that is neither in the tree nor a
  declared branding hook refuses the cut, and a declared hook nothing references any more
  refuses it too, so the exemption list can't rot.
- **Boot-dependency gate** — every HTML file the emitted code loads must exist in the tree.
- **Roster gates** — the seeded roster, the pasteable roster and the demo roster must agree,
  or the cut refuses.
- **Nothing operator-specific ships**: the release tree is checked clean of the operator's
  company, email, project and hostnames.

## 14. Observability and spend control

- **Everything is journalled** with a named action — `stage_job`, `exec_claim`, `exec_start`,
  `exec_refused_replay`, `exec_refused_stale_approval`, `archive_served`, and more. "What
  took the console out" is a query, not a guess.
- **Fleet mode** (`home` / `dual` / `work`) is one switch that decides whether model buses may
  be called at all — and a refusal is journalled with the reason and the exact config path.
- **Hard monthly caps** on model spend, checked before the agent loop opens.
- **A BigQuery forever-archive, provisioned by the installer.** Phase 6c creates the
  `pc_archive` dataset and both time-partitioned tables (`journal`, `chat_history`), grants the
  control plane `bigquery.jobUser` at project level and dataset-scoped WRITER. Non-fatal by
  design: an org policy or a missing `bq` CLI warns and the install continues. It exists so
  history outlives Firestore's 120-day window — and the documented rule is create and seed it
  *before* enabling the TTL, or pre-deploy transcripts are destroyed with no copy.

## 15. Deploy discipline

- **Source in the repository → build reads the repository → deploy ships the build.**
- Deploy `--no-traffic --tag`, verify, then shift — **and pin traffic to the revision name
  captured from that deploy**, because `gcloud` misreports which revision it made.
- `test -s` the captured name: an empty answer means the deploy didn't tell you what it built,
  and that is a refusal to act on.
- The whole chain is in `pipeline/cloudbuild-prod.yaml`, done correctly, for both services.

---

`SECURITY.md` ships in this release and documents the security model in full — the boundaries,
what each control does and does not cover, and the reasoning behind them. Read it alongside
this page.
