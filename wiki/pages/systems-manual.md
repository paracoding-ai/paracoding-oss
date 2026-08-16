---
page: systems-manual
title: Systems manual
section: extend
status: live
audience: public
owner: unassigned
generated_by: starter-edition
verified_at: "2026-08-14"
verified_by: starter-edition
watch:
  - "lake:shared/wiki/_release.txt@71b8aebd9209c5b60ca8ccc1ef4bb906ec2a7a5e39d77743e915866794b5d323"
---

# Systems manual

This is the page to read before you change anything. The other pages tell you how to
operate the system; this one tells you what it is, where the boundaries are, and which
things look like a control and are not.

Where a claim here is about a default, the default is the one in the code. Where it is
about a value, the value is the one `install.sh` writes. Those are different facts, and
most of the confusion in this system lives in the gap between them.

## What actually runs

Six things. Nothing else is load-bearing.

| Thing | What it is |
|---|---|
| the console service | Cloud Run, Node/Express. The harness, dashboard, wiki and lakeview, behind Identity-Aware Proxy. |
| the MCP service | Cloud Run, **the same image**. `/mcp`, OAuth and discovery, the legacy bearer-token API, and `GET /git/archive`. IAP off. |
| the gated executor | Cloud Run, Python/Flask. `--no-allow-unauthenticated`, so it is not addressable from the internet. |
| Firestore, a named database | `pending_confirms`, `journal`, `work_items`, `chat_history`, `strains`, `session_keys`, `repos/<id>/refs`, `repos/<id>/ci_emissions`. |
| the data lake | one GCS bucket. Agent memory, the wiki, git objects, the vault master. |
| the executor records bucket | a second GCS bucket, `<project>-<lane>exec-records`. The single-use claim, every executor journal line and every job result are objects in it. |

**There is no gate page.** `/gate` -- the route, the document behind it, `GET /jobs`,
`GET /pastes` and every redirect into it -- is deleted. The human URLs are `/harness`,
`/wiki`, `/dash`, `/flow`, `/lakeview` and `/chat`, plus `/mcp` for machine clients, and
`GET /` is an unconditional 302 to `/harness`. An anonymous caller to a console page gets
**401 with the locked document served in place**, at the URL they asked for. The section
**The edge, and the session check behind it** below says what that document is and what it
is still for.

The executor records bucket is the sixth thing, and it is new enough to be worth naming
here rather than only where it is used: the executor holds **no Firestore client at all**.
It creates objects in that bucket and cannot read, overwrite or delete them, which is the
whole reason its audit trail is worth reading. The control plane sweeps the bucket back
into Firestore. That pipeline is described under **How a result gets back**.

The installer derives every name from a lane prefix, `PC_LP`, so a second lane can live
in the same project without colliding: `paracoding-${PC_LP}control-plane`,
`paracoding-${PC_LP}mcp`, `paracoding-${PC_LP}gate-exec`, and service accounts
`pc-${PC_LP}control-plane@`, `pc-${PC_LP}gate-exec@`, `pc-${PC_LP}build@`. With no lane
set the prefix is empty and the names are the bare ones.

**The runtime has never heard of a lane.** `PC_LANE` and `PC_LP` appear in the control
plane's source only inside one comment. That is why a new lane needs no new image, and
why every cross-lane accident in this system is a *configuration* accident rather than a
code one.

The buckets and the KMS keyrings are what a teardown leaves behind. `uninstall.sh` reports
them under `HELD` with the exact removal commands rather than deleting them, and `HELD`
suppresses its "everything is gone" claim. Keyrings and keys cannot be deleted by anyone,
ever, so getting their names right is a precondition of minting a lane.

## The surface split

One image, deployed twice. `PC_SURFACE` tells each copy which half of the route table
to register.

| `PC_SURFACE` | Effect |
|---|---|
| unset | every route registers. The wrapper is not even installed. |
| `console` | browser pages plus the cookie-session-gated `/api/*` those pages call. No `/mcp`. |
| `mcp` | the MCP transports, OAuth and discovery, and the legacy bearer API. No browser pages. |
| anything else | `throw` at boot. Not a warning, not a default. |

**Start here** states why they must be separate services. Three things about the
mechanism will bite whoever edits it:

- **The split is a wrapper on the Express app, not an `if` around each registration.**
  It rebinds all eight verb methods and takes the decision *inside* the registration
  call, so routes stay at column zero -- which the route audit below requires.
- **Every route must name its surface.** A path absent from `PC_SURFACE_MAP` throws at
  boot. A route landing on neither service is a silently broken install, and this table
  exists to make that impossible. It can only bite when `PC_SURFACE` is set, so it
  cannot brick a single-service deployment.
- **`both` is honoured and unused.** The split follows the auth mechanism each handler
  uses -- a cookie session only from a browser that reached the console through
  IAP, a bearer or OAuth token only from a machine client -- and those two partition the
  table with no overlap.

Measured at this release, counted directly out of `PC_SURFACE_MAP` rather than inherited
from an earlier note: 82 registrations, 58 `console`, 24 `mcp`, 0 `both`.

`GET /git/archive` is the one entry whose placement looks wrong and is not. It is a browser
URL by shape and an `mcp` route by mechanism: its caller presents a Google-signed service
account ID token, not a session cookie, and IAP in front of the console would consume that
`Authorization` header before the container saw it. See **The repository, to a machine**.

### The route audit is a build step, and it fails harder than you would guess

`route-audit.mjs` runs before esbuild in the control plane's Dockerfile, so a non-zero
exit means no image and therefore no deploy. Its verdicts, run against this release:

| Change | Result |
|---|---|
| baseline | `total 82 / guarded 67 / public 15`, `ROUTE AUDIT PASS`, exit 0 |
| indent a registration into an `if` | `ROUTE AUDIT FAIL: ... route registration(s) NOT at column zero`, exit 1 |
| add a new route with no guard | `ROUTE AUDIT FAIL: ... NEW route(s) with no auth guard`, exit 1 |
| delete a route the baseline records | `ROUTE AUDIT FAIL: ... baseline route(s) NO LONGER REGISTERED`, exit 1 |
| register a route the baseline does not record | fail, naming the route |

**The blind spot in the fourth row is closed, and this is the correction that matters
most in this section.** Until 2026-08-12 the baseline recorded only the *public* set --
16 of 85 routes at the time -- and the vanished-route check ran over that list and
nothing else, so deleting the whole registration of a **guarded** route PASSED the build.
That was measured, not argued: deleting `GET /api/models` printed `84/68/16` and exit 0,
while deleting `GET /dash` from the same tree exited 1 and named it. Sixty-nine of
eighty-five routes could be lost in a merge without a word, and an earlier version of this
page recorded that as a known limit rather than as a defect. The baseline now carries a
flat `registered` list of every `METHOD PATH` key the audit can see, guarded and public
alike, and losing any of them fails the build. A **deliberate** removal costs one line
deleted from `registered` -- and from `public` too if the route had one -- in the same
commit as the source change; a deliberate addition costs one line added, because a list
allowed to go stale stops being a ratchet.

A set, not a count, and for a reason worth keeping: a count cannot name the route that
went, and it is satisfied by any swap that loses one route and adds another.

The audit blanks comments before matching guard names, because a guard mentioned in prose
near a handler once marked that handler guarded while its real guard had been deleted.
That blanker itself had to be fixed: it tracked `'`, `"` and `` ` `` and nothing else, so
a regex literal containing a quote desynchronised its state and 406 comment lines were
never blanked, seven of them naming a guard token. `blob-audit.mjs` runs beside it and
fails the build on an encoded document held in a string literal.

None of this changed on 2026-08-14 and none of it was meant to. **Every check that fails a
CUT is untouched** -- this audit, the blob audit, `oss/gen.py`'s own refusals, the leak
ceilings, `devgate/smoke.py`, and the compare-and-swap on `git_push`. What was removed that
day was a different class of thing: refusals that stopped a job the operator had already
asked for. The distinction runs through the rest of this page and it is the single most
useful idea in it.

## Identity: how the system knows who is asking

There are three separate questions and the system answers them in three places.

**Which role is this?** Resolved server-side, never from anything the caller claims. An
agent presents a session key as the `agent` argument; the server hashes it and looks the
hash up, and the plaintext exists once, in the browser that minted it. Editing your paste
to name a different role does nothing, because the role lives in a record keyed by a value
you cannot guess. A key that does not resolve is **refused** -- never downgraded to a
weaker role, never silently upgraded -- but that refusal is `PC_SESSION_ENFORCE`, whose
in-code default is *off*. The installer writes `1` on both services, so an installed system
denies; the unenforced state resolves keys and denies nothing, and it is not a state a
fresh install is ever in. Keys carry a TTL (`PC_KEY_TTL_DAYS`, default and
installed value 7); a record with no expiry field is grandfathered valid, because
absent-as-expired would have cut every live chat the day the field shipped.

Possession of the key *is* the identity: every chat shares one bearer, one client id and
one source address, and the transport is stateless, so two chats given the same paste are
the same role. This is an attribution and blast-radius mechanism, not an authorization
boundary between chats.

**What may this role call?** Every tool is mapped to one of `read`, `write`, `stage`,
`infra`, `browser` in `PC_TOOL_CLASS`, and `PC_TOOLS_ENFORCE` (which the installer sets
to 1) decides whether the map bites. The narrowing comes from a `tool_classes` array on
the role's record -- and **absent, empty or malformed means every class**. Only an
explicit non-empty array narrows anything. A failed registry read prefers last-known-good
and otherwise grants every class, deliberately: admission control has already failed
closed on whether this principal may be here at all, and a registry hiccup must not be
the reason a fleet loses its tools.

`whoami` is exempt, and enforcement is what makes that true rather than convention: a
role that cannot say what it is cannot be debugged. Two placements surprise people:
`gcp_api` and `run_roll` are `infra`, not `stage`; `stage_privileged_job` and
`run_command` are `stage`.

**What may this role touch in the lake?** A role reads and writes `shared/` and its own
prefix under `agents/`, and another role's private prefix is refused by name. On top of
that there is a write-only denial:

> The control plane **loads and executes** objects under the nine prefixes in
> `LAKE_EXEC_PREFIXES`. A token-bound role that could write them would be remote code
> execution as the control plane. So writes there are refused for every role including
> the one asking. **Reads are deliberately unaffected** -- agents review this code, and
> denying reads would break audit work without closing the hole.

The list is compiled in with a sha256 of its own sorted contents, and the module refuses
to serve the lake tools if the two disagree -- it is one boundary with two independent
implementations, in two languages on two deploy schedules, and the digest is what stops
them drifting. It is **not** `VAULT_CLEARTEXT_PREFIXES`, which grants and denies nothing
and is an encryption exemption. Five of the nine names overlap, which is why they get
conflated.

Six identities are seeded: four strains you assign work to, one where unclaimed OAuth
connectors land (`OAUTH_DEFAULT_ROLE`), and one worker that executes queued work. The last
two are unpasteable -- you cannot mint a chat key for the thing that runs the queue.

## The tool surface, in one place

`PC_TOOL_CLASS` is the inventory as well as the permission map, so it is the honest place to
read what an agent can actually do. Measured at this release: **51 tools mapped**, 22
`read`, 19 `write`, 2 `stage`, 5 `infra`, 3 `browser`.

| Class | What is in it |
|---|---|
| `read` | the four read-only git tools, the knowledge graph readers, `read_file`, `list_files`, `read_journal`, `read_history`, `search_history`, `read_job_log`, `run_status`, `vm_status`, `list_pending_confirm`, `whoami`, `get_time` |
| `write` | `git_propose`, `git_propose_patch`, `git_push`, the knowledge-graph mutators, `write_file`, `put_file`, `append_journal`, the work-item and messaging writers, `refresh` |
| `stage` | `stage_privileged_job`, `run_command` |
| `infra` | `gcp_api`, `run_roll`, `vm_start`, `vm_stop`, `vm_resize` |
| `browser` | `browser_open`, `browser_navigate`, `browser_eval` |

Three placements are worth pinning because people guess wrong. `gcp_api` and `run_roll` are
`infra`, **not** `stage`, even though both can end up staging a job. `git_push` is `write`
and not `stage`, because the compare-and-swap is its control rather than an approval.
`whoami` is `read` and additionally **exempt from enforcement** -- a role that cannot say
what it is cannot be debugged.

`ssh_executor` is **gone**. It was an artifact of an earlier architecture that had
addressable nodes; measured before removal, no installer this product ships ever created the
private key it needed, and a branch that has never executed is not a feature. The executor's
matching `ssh` branch went in the same change, which is why the executor now has exactly one
execution branch.

The browser tools reach the workstation's Chrome through a DevTools Protocol bridge.
`install.sh` provisions no workstation and therefore no bridge; `workstation.sh` stands one
up when it builds a machine, on **loopback only** and behind a token, with no firewall rule
opened for it -- so the control plane still cannot reach it, and the tools are **withheld
rather than registered to fail on first call**, the same doctrine as the git tools. You
reach the bridge yourself over the IAP tunnel. `WS_CDP_PORT` is the discriminator, and it is
the honest one: the port used to carry a default of `8025` that nothing listens on, which is
a guess dressed as configuration. An explicit `WS_CDP_PORT` is the only signal that a
deployer actually stood a bridge up. `browser_eval` is an ungated mutation primitive against
a browser holding the operator's live sessions, so it additionally needs `PC_BROWSER_EVAL=1`.
So the 51 in the table is what the map covers, not what a given install serves.

## The execution path, end to end

There is **no approval queue and no per-job tap**. This is the largest change on this page
and it is a policy decision, landed 2026-08-14, not a drift. The operator's ruling,
verbatim: *"we don't add speed bumps we add accelerators"*, and *"there is no gate going
forward for a job to show up in for me to approve because nothing needs approved its all
coming from me the chat is just my hands"*.

Two deploy-time variables carry it, and they are separate on purpose:

| Variable | In-code default | What `install.sh` writes | What it decides |
|---|---|---|---|
| `PC_AUTO_APPROVE` | `0` | `1` | whether a staged job is stamped with a real pre-approval and fired in the same breath, instead of waiting for a person |
| `PC_GUARDRAILS` | `0` | `0` | whether runtime **refusals** exist at all -- the destructive-command refusal in the control plane and the lockout-class refusal in the executor |

Both are read from the environment, so both are a Cloud Run configuration revision and
**neither can be flipped by a job**. That matters in both directions: arming them is not
something an agent can do, and disarming them is still available in the state where no job
could be approved. One name, `PC_GUARDRAILS`, is read by the control plane *and* by
`gate-exec/exec_server.py`, so there is one thing to flip and one thing to document rather
than a flag per brake.

With the shipped defaults the path is:

```
agent   stage_privileged_job -->  pending_confirms/<id>  status=pending
control plane pcAutoRun      -->  status=preapproved, cmd_sha, approved_sha256,
                                  single_use run_token, 15-minute expiry,
                                  KMS-SIGNED with approver "auto:lockout-check"
control plane  -- awaited -->     POST <executor>/run    (synchronous, in the request,
                                  carrying the whole approval envelope in the body)
executor                     -->  eleven refusal rungs, above an arming gate
executor                     -->  bash <tempfile>, as ITS OWN service account
                                  (empty access_token: no human, no borrowed credential)
executor                     -->  gs://<exec-records>/results/<job>.json   (create-only)
control plane ingest sweep   -->  Firestore {status, exit_code, stdout_tail, stderr_tail}
agent   read_job_log         -->  the projection
```

**Nothing was skipped to get there, and that is the point.** `pcAutoRun` stamps a *real*
pre-approval in the same field names the legacy approve route writes, rather than
bypassing the path -- so the executor's rungs all still run: the `approved_sha256` pin, the
KMS approval signature, the single-use claim, the lockout check. What changed is the
delivery mechanism for the decision, not the machinery that carries it. The approver field
inside the **signed** bytes reads `auto:lockout-check`, because there is no human in that
path and the audit trail must never later be read as a person having approved it.

The 15-minute expiry on the auto-stamped token is short because nothing here is waiting for
a person. Pre-approval for an *absent* human is 12 hours; this fires immediately, so 15
minutes is generous and keeps a stamped-but-unfired token from lingering as a usable
credential.

`PC_AUTO_APPROVE=0` restores the tap. `PC_GUARDRAILS=1` restores the refusals. An adopter
who wants brakes sets both and gets the older system back without a rebuild.

### What was removed, and what a removed refusal costs

Two refusals went, and it is worth being exact about which:

- **The destructive-command refusal in the control plane.** `pcAutoRun` used to stop a
  command `waIsDangerous()` matched and hand the question back to chat. With
  `PC_GUARDRAILS=0` that branch is not taken at all, so a destructive command runs. It is
  still journalled.
- **The lockout-class 403 in the executor.** `gate-exec/lockout_check.py` still runs on
  every job body and still journals every rule it matches -- detection is not friction --
  but a match no longer refuses. A job that matched and ran anyway is journalled under its
  own action, `exec_lockout_class_ran`, naming the rules, *"so the transcript can answer
  'what took the console out' without anyone guessing"*. A missing or broken checker no
  longer refuses either; that too is journalled and the job continues.

The accepted cost is stated rather than hedged: a lockout-class change can take the
console's own authentication out, and the recovery is Cloud Shell, which the operator
holds. Breakage is the accepted cost and rolling forward is the accepted cure.

**One asymmetry survives and it is worth naming rather than tidying away.**
`POST /api/webauthn/preapprove` -- the route that authorises a job to be fired *later, while
the human is away* -- still hard-refuses a destructive command, unconditionally, with no
`PC_GUARDRAILS` in front of it. Its argument is narrower than the one the ruling addressed
and still holds: an authorisation collected now cannot be re-demanded at fire time, so
accepting one there would only buy a signature authorising an unattended destructive run up
to twelve hours afterwards with nobody present to abort it. `pcAutoRun` fires in the same breath as the
request, so there is no such window. The distinction is *unattended later* versus *now, at the
operator's instruction*, and it is the reason these two look inconsistent and are not.

There is one override that survives in both directions. `lockout_ack: true` rides **inside**
`arguments`, which is covered by `asha`, field five of the approval canon -- so adding or
flipping it in transit changes the canonical arguments hash and the approval signature fails.
A header, a query parameter or a top-level body field would all have been forgeable by
whoever could reach the endpoint. With `PC_GUARDRAILS=1` that ack is what lets an
acknowledged lockout-class job through, journalled as `exec_lockout_acked` so a human saying
yes can never be confused in the transcript with the checker finding nothing.

### Staged jobs coexist, and expiry only runs when the console is open

With `PC_AUTO_APPROVE=1` most jobs never sit in the queue at all -- they are stamped and
fired inside the staging call. The queue is still real machinery, though, and everything
below still applies to a job that does wait: an install running `PC_AUTO_APPROVE=0`, and any
job whose auto-run leg failed before it fired.

`GET /api/webauthn/pending` is where that queue is read. It survives the gate's deletion; the
harness polls it to light its pending indicator. Read every sentence below that says "when
the console is open" as meaning *that poll*, from a browser holding an unlocked session.

**There is no automatic supersede.** There used to be: this endpoint retired every pending
job that was not the newest of its `staged_by` + `|` + `command_type` key, on every load of
the list, writing only `status` and `superseded_at` -- so the destroyed job reported
`reason: null` forever and two chats of one role sharing one `command_type` erased each
other's work at the moment the operator opened the page to read it. It is gone. Every staged
job stays listed until it is approved, denied, superseded on purpose, quarantined, or
expires.

What replaces it runs at STAGE time, refuses loudly, and destroys nothing:

- **Byte-identical double submit is refused.** A stage whose `staged_by`, `command_type` and
  `command_sha256` all match a job already waiting is not staged; the waiting job's id comes
  back untouched. The key is the exact staged arguments, so two different commands of the
  same type are two different proposals and both wait side by side.
- **`PC_PENDING_MAX_PER_ROLE`** (default 25) caps how many jobs one role may have waiting.
  Over it the stage is refused and journalled; nothing waiting is touched.
- A read failure while checking either of those **refuses the stage** rather than admitting
  it, because an unreadable queue and an empty queue look identical.

Expiry lives on that same endpoint and runs only when it is polled. Nothing expires on a
timer: if nobody opens the console, jobs sit pending past their TTL indefinitely, and the
moment somebody does, a batch of them flips to `expired` at once. Expiry writes
`expired_reason`, and a job whose expiry write FAILS is listed rather than hidden.

- **A job with no creation timestamp never expires.** It still lists.
- The query is capped at `PC_PENDING_LIST_MAX` (default 500) pending documents. Past that the
  poll sees a subset and says so in the service log.

The same pass quarantines any pending job whose `staged_by` is not an active provisioned
strain, once, in a transaction. Delete a strain and its pending jobs become unapprovable
at the next poll. If the strain registry read is empty or fails the filter is
**skipped** for that request and nothing is quarantined -- the approve path refuses a
non-provisioned identity independently, and a registry outage must not hide every job.

### Two staging behaviours that surprise people

**`gcp_api` auto-escalates, and escalation stages a job.** A GET on a small blessed set of
in-project endpoints runs instantly as the control plane's own service account. If that
comes back 401 or 403 it does not fail -- it stages a gated job instead. Everything else,
including every mutation, stages unconditionally. So calling `gcp_api` "just to read
something" can put a real job through the executor. It cannot supersede anything: an
earlier version of this page said staging "can supersede one that shares its key", which
contradicted the section directly above it and was left behind when automatic supersede was
deleted. Nothing supersedes automatically any more.

**A secret-destroying job is refused at staging, not at execution.** Five patterns match a
Secret Manager delete, destroy or disable; if none of the job's live (non-comment) lines
also invokes the destroy preflight, staging is refused outright -- nothing is staged, no
approval spent, nothing fired. The escape is to do the work, not to set a flag: run the
preflight in the same job and make the destroy conditional on it. This one **enforces** by
default, unlike the executor's allowlist, and the difference is that it reads only jobs
that destroy a secret, so it cannot repeat the allowlist's failure and removing it is not
itself a secret-destroy command.

It is also **not** governed by `PC_GUARDRAILS`, and that is deliberate rather than an
oversight. It refuses at STAGE time and destroys nothing, so it is not the class of refusal
the 2026-08-14 ruling switched off; and the failure it prevents is not a policy question but
a measured outage -- a `secretKeyRef` mount is a hard boot dependency resolved by the
platform, so "no code reads the variable" is not "safe to delete". That exact reasoning took
production down on 2026-08-10, about seventy minutes later, at the first cold start.

### Which identity a job body actually runs as

**When a human approved the job**, the executor puts that person's access token into the
environment as `CLOUDSDK_AUTH_ACCESS_TOKEN`, which binds `gcloud`, `gsutil` and `bq` and
nothing else. The metadata server is untouched and still hands out the executor's own service
account. So in one script `gcloud ...` acts as the approver and anything fetching a metadata
token acts as the executor. The choice is invisible in the source; to probe the service
account's own permissions from inside a job, prefix with
`env -u CLOUDSDK_AUTH_ACCESS_TOKEN`.

**On the auto-run path there is no second identity at all**, and this is the single most
practical consequence of removing the tap. `pcAutoRun` forwards an **empty** access token,
for the same reason `/api/jobs/fire` does: there is no human in that path, so the executor
must run under its own scoped identity rather than borrowing a live human's credential. With
the variable unset, `gcloud` falls through to the metadata server and the whole script runs
as **the executor's service account** -- which is a *narrower* identity than the operator's
Google account, not a wider one. So a job that worked when a person tapped it can fail with a
permission error when it auto-runs. Read that failure as a missing grant on the executor's
service account, not as a broken executor.

If the exec call itself cannot be reached, the job goes back to `pending` -- not to a failure
state. It was never run, so the human path must still be able to pick it up; a job that
auto-running dropped on the floor would be the silent-drop failure `deploy/LOCKOUT-CLASS.md`
forbids.

### How a result gets back

The executor writes its result as an **object**, `results/<job-id>-<digest>.json` in the
executor records bucket, before it returns. That ordering is the whole design: a long job
has to survive a caller that is already gone -- a closed browser, a proxy timeout, a dropped
connection -- so the record is written at the end of the run and before the response, not
handed back only in the body.

The bucket grant is `roles/storage.objectCreator`: create, no read, no overwrite, no
delete. **The executor cannot amend or delete a result or a journal line it has written**,
and it holds no Firestore client at all. A service that can edit its own audit trail does
not have one; this one cannot.

Getting those rows back into Firestore is a sweep in the control plane. It rides
`GET /api/webauthn/pending` -- a path the console already polls -- at most once every
`PC_EXEC_INGEST_MIN_MS` (default 30,000) and never twice at once, and it is **fired, not
awaited**, so a slow or failing bucket cannot delay the poll. There is deliberately no
Cloud Scheduler behind it: that would be a new resource, a new service account, a new IAM
binding and a new thing to uninstall, to move rows between two stores this service already
talks to.

It is idempotent by construction rather than by bookkeeping. Every row is written to a
document id derived from the object name, and every field -- including the timestamp -- comes
from the immutable object rather than being stamped at ingest, so running the sweep twice
rewrites identical documents in place. No duplicate rows, no second journal line for one
refusal, and therefore no delete is ever needed: the control plane holds READ on that bucket
and nothing more. Neither end of the pipe can destroy the audit trail.

**If the sweep never runs, nothing is lost.** The result is an object named deterministically
from the job id and any principal who can read the bucket recovers it with one command:

```
gcloud storage cat gs://$PC_EXEC_BUCKET/results/<job-id>-<digest>.json
```

Ingest is a convenience that puts the row back where the console expects it. It is not
custody.

### What `read_job_log` returns

A fixed projection. `ran` is derived, not stored: it is `status === 'executed'`. `reason`
is the first non-empty of `fire_refused_reason`, `quarantine_reason`, `exec_failed_reason`,
`supersede_note`, `expired_reason`, `error` -- each of which is also returned raw, so you can tell *which*
refusal fired rather than only that one did.

You may read the jobs you staged; principals named in `LOG_READ_ALL` (default one
coordinator role, `*` accepted) read everything. A denial is an ordinary tool result whose
first key is `error`, carrying `job_id`, `staged_by` and `denied: true` -- not a thrown
exception and not a transport failure.

`stdout` in the projection reads the field `stdout_tail`, and `stderr` reads `stderr_tail`.
Those two fields now have **two independent producers**: the control plane copies the
executor's HTTP response into them on the normal path, and the ingest sweep writes them from
the executor's result object on every other path.

**This used to be a documented lie and it no longer is.** The older text on this page said
that when the control plane's request died before the executor answered, `read_job_log`
showed empty stdout for that job *permanently* -- because the executor wrote `stdout` and
`stderr` under its own names and only the control plane wrote the tails. That gap is closed
by the result object and the sweep: the executor's output reaches `stdout_tail` even when
nobody was listening. The honest residue is a **delay, not a hole**. The sweep only runs
when the console is polled and at most every 30 seconds, so a job whose caller died can read
back with empty tails until somebody opens the console. Re-read after the sweep, or read the
object out of the bucket directly with the command above.

Both fields are tails: the executor truncates to the last 8,000 characters, the control
plane and the ingest to the last 6,000.

## The executor's refusal ladder

`POST /run` runs an arming gate and then eleven checks in a fixed order, and the order is
load-bearing: everything above the claim consumes nothing, so a refused substitution attempt
cannot burn a real approval.

| # | Check | Refusal | Consumes the approval? |
|---|---|---|---|
| 0 | **arming gate**: `PC_EXEC_BUCKET` set AND `APPROVAL_REQUIRE_SIGNED=1` | 503, naming which variable | no |
| 1 | `job_id` present | 400 | no |
| 2 | the body carries an `approval` object | 400 | no |
| 3 | WebAuthn assertion, **only if** `PC_REQUIRE_ASSERTION=1` | 428 missing / 403 unbound / 403 no creds / 403 refused | no |
| 4 | sha256 of the presented script equals the approved command's | 400 bad base64 / 403 no approved command / 403 mismatch | no |
| 5 | `approved_sha256`, stamped at approval time, matches the live command | 403 absent / 403 unreadable / 403 changed-after-approval | no |
| 6 | KMS approval signature | 403 bad / 403 unverifiable / 403 unsigned-when-required / 403 V1 stamp on a non-local job | no |
| 7 | command non-empty | 400 | no |
| 8 | lockout-class check | **advisory by default**; 403 with the rule ids when `PC_GUARDRAILS=1` | no |
| 9 | binary PATH jail (`EXEC_BIN_JAIL`, default on) | unlisted binary does not resolve; absolute paths still run | no |
| 10 | approval staleness, bounding the **signed** `approval_sig_iat` (default 3600 s) | 403 | no |
| 11 | atomic single-use claim, an object create in `PC_EXEC_BUCKET` | 409 already spent / 503 claim outcome unknown | **yes, on success** |
| — | run | 200 | — |

### Which rungs were removed, and why

Renumbering this table is not cosmetic. Three rungs that earlier editions of this page
described are gone, and each went for a different reason.

- **"Document exists -> 404" is gone**, and so is **"status is `confirmed` or
  `executing`"**. Both were Firestore reads, and the executor no longer holds
  `roles/datastore.user`. Every field describing the approval now arrives in the request
  **body**, put there by the control plane, which still holds the read. Rung 2 replaces the
  first: a missing job is established where the read still lives, and `waCallExec` returns a
  404-shaped refusal without a round trip. Nothing replaces the second, and the argument for
  that is made in the source where the code used to be: **status is not in any canon**, so a
  status carried in a request body is the caller vouching for itself, and refusing on it
  would be theatre. What it defended against was a control plane firing a job a human had
  denied -- but the control plane is also what *records* a denial, so against a compromised
  control plane the check was never evidence.
- **The lockout-class 403 became advisory.** It is rung 8 and it still runs and still
  journals; only the refusal is behind `PC_GUARDRAILS`. See **What was removed** above.

What makes it safe to carry those fields in a body rather than read them from a database is
**rung 0**, and this is the dependency to hold onto: passing a field in a request body is
safe exactly when the signature covers it. `arguments`, `command_type`, the command digest,
the approver, the key version, the issued-at and the expiry are all inside the signed bytes.
So the executor **refuses to serve at all** unless `APPROVAL_REQUIRE_SIGNED=1`. The
dependency is enforced, not assumed in a comment.

`approved_sha256` moved class in the same change. With a signature present it duplicates the
signed `csha` field, and the caller now supplies both it and the command it pins, so it is a
**consistency assertion** rather than a control. The control is `csha`, inside the signed
bytes. It is kept because its refusals are in the operator's vocabulary and cost nothing.

### The rungs that are weaker than they look

**Rung 4 does not prove byte-identity with what a human read.** It compares the presented
script against the approved command **taken from the same request body**, so anything that
can compose that body moves both sides together. **Rung 5 and rung 6 are what close it**:
rung 5's digest is stamped at approval time, and rung 6's signature is made with a key the
executor does not hold. A document carrying **no** `approved_sha256` is **refused**.

There used to be a fallback there that allowed an absent pin, on the reasoning that
enforcing it unconditionally would 403 every job predating the field, including the job
that would undo the change. It is gone, and the reason it could go is that the missing
half was found: the control plane had exactly **one** writer of `approved_sha256`, inside
the legacy approve route, and the pre-approve to `POST /api/jobs/fire` path never passes
through that route. **Every** pre-approved job therefore arrived with the field absent,
permanently -- so the fallback's own stated exit condition, that the absence count reach
zero on its own, could never be met. That was not a legacy-document problem. It was a live
one.

Three writers now exist. The legacy approve route stamps the pin whenever the job has a
command to hash; the pre-approve route stamps it beside `cmd_sha` when it mints the
single-use `run_token` that `POST /api/jobs/fire` later redeems; and `pcAutoRun` stamps it
under the **same field names** when it pre-approves a job for immediate firing. A different
shape in that third writer would have been a second approval format for the executor to
understand, and two formats is how a rung starts accepting the weaker one.

**A job approved before that change and not yet executed will be refused** and must be
staged again. That is deliberate: an unpinned job is one whose command nobody can prove
anybody ever saw. The refusal is journalled as `exec_refused_sha_absent` naming the job, so
it is never silent.

**Rung 6 fails closed on two outcomes of three.** A signature present and wrong, and one
that cannot be checked, refuse **unconditionally** regardless of any flag -- "we were not
given the means to check" must never read as "checked". Only an *absent* signature is
allowed, and only while `APPROVAL_REQUIRE_SIGNED` is off.

**`APPROVAL_REQUIRE_SIGNED` is no longer a flag you can quietly delete, and the warning that
used to sit here is now false.** Earlier editions said that deleting the variable *relaxes*
the gate -- that an absent variable reads as `"0"`, the requirement becomes false, and an
unsigned approval executes. The read is still literally
`os.environ.get("APPROVAL_REQUIRE_SIGNED", "0") == "1"`, so that sentence was true of the
signature rung in isolation. It is no longer true of the service, because **rung 0 refuses
to serve any job at all when the variable is not `1`**. Deleting it now produces a 503 on
every job, naming the variable, rather than a silent widening. The failure mode moved from
*dangerous and invisible* to *total and legible*, which is the trade the arming gate exists
to make.

The permissive in-code default survives underneath it, and it is worth knowing why rather
than reading it as a leftover: landing the verifier with require-on would have entered
migration stages B and C in one commit and 403'd every document approved before the signer
shipped, **including the undo that would remove the block**. `install.sh` arms it last, so a
fresh install never opens that door -- and the arming gate now means a deployment that fails
to arm it cannot run anything at all.

**A V1 stamp cannot authorise a non-local job.** The signature canon has two versions.
`PC-APPROVAL-CANON-V1` signs seven fields and covers the command *text*; V2 inserts `ctyp`
and `asha` after `csha` and covers the command **type** and a hash of the whole arguments
object as well. A V1 stamp is therefore evidence that somebody approved these bytes and no
evidence at all that they approved them being carried somewhere else. There is only a local
execution branch today, so that refusal is unreachable -- **it stays anyway**, because it is
the guard that makes adding a second branch safe, and the cost of keeping it is nine lines
against the cost of re-deriving it later. Both control-plane signing sites emit V2, and a
fresh install sets `APPROVAL_ACCEPT_CANON_V1=0` on the executor so only V2 stamps are
accepted; an existing deployment upgrading in place leaves it unset, where it reads as
accept-V1, and migrates.

**Rung 9 is not a control and must stay off.** The allowlist is `echo`, `gcloud`,
`firebase`, `npm`, `node`, `python3`, tested against the first token of every non-blank,
non-comment line. You can prove enforcement is unusable without leaving the source: the
script this system builds for **every** `gcp_api` job leads with `printf` and `curl`, and
neither is on that list, so turning enforcement on 400s every `gcp_api` job the control
plane stages. Shell that any multi-line job opens with -- `set`, `if`, `for`, a bare
variable assignment -- fails the same way. It defaults to observe and journals every skip,
so a skip can never look like a pass.

**Do not set `PC_REQUIRE_ASSERTION=1` on this build.** Rung 3 requires *two* body fields,
an assertion and an expected challenge; the control plane sends five fields --
`script_b64`, `access_token`, `job_id`, `assertion` and `approval` -- and the challenge is
not among them. `expected_challenge` does not occur in the control plane's source at all;
measured, it appears zero times. Every job would return 428. The installer writes `=0` for
that reason.

**One approval is one run, and the claim is now an object rather than a transaction.**
Rung 11 creates `claims/<job-id>-<digest>` in `PC_EXEC_BUCKET` with
`ifGenerationMatch=0`. The name is a pure deterministic function of the job id, so every
run of one job aims at the same name and Cloud Storage itself refuses the second arrival
with a 412 -- and **no read permission is needed to learn that: the 412 is the read**. Two
fires racing at the same instant both attempt the same name and generation serialisation
admits exactly one. Neither primitive can produce two winners.

Every property of the old Firestore transaction has a named home. Atomicity moved from
transaction serialisation to object generation serialisation. The claim id, its timestamp
and its origin are the body of the object rather than three fields on the job document --
the executor cannot read them back, which is the point, and the claim id still travels home
in the function's return value so the `exec_claim` journal line is unchanged.

Two things did **not** survive, and both are stated rather than papered over:

- **The compare-and-set on status is gone**, for the reason given in the removed-rungs note
  above: it needed `roles/datastore.user`, and a control that requires the privilege the
  change exists to remove is not a control that can be kept.
- **An ambiguous claim outcome refuses and says so.** A 403, a 500, a timeout, a DNS
  failure or an unmintable token leaves it genuinely undetermined whether the write landed.
  The executor answers **503** and journals `exec_refused_claim_error` saying the outcome is
  UNKNOWN. It deliberately does not claim the approval was spent -- writing "already spent"
  would be a guess recorded as a fact and the operator would re-stage on the strength of it;
  writing "not spent" is the same guess in the other direction and a re-fire could
  double-run. Ambiguity refuses. The bucket is where the answer is, if there is one.

Staleness at rung 10 got **stronger** in the same change, not weaker. It used to bound
`confirmed_at`, a Firestore server timestamp that appears in no canon -- so once the job
arrived in a request body a caller could simply say the approval was confirmed a second
ago. It now bounds `approval_sig_iat`, which is inside the signed bytes and cannot be moved
by anyone who cannot sign. The status test went with it, so what was formerly the unbounded
`executing` state is bounded too.

**The command is one bash file.** The executor has exactly one execution branch, and it
writes the whole command string to a temporary `.sh` file and runs `bash` on it, so
multi-line shell is safe and normal. The
folklore that a staged command may carry no comments is too broad: the system stages
comment headers itself on every `gcp_api` job, and the executor skips comment lines in its
allowlist scan. The real hazard is narrow and it has bitten the installer -- **a `#` on a
backslash-continued line swallows the continuation**, the remainder runs as its own
command, and `bash -n` passes it. That once dropped four environment variables off the
executor's deploy on every install.

## The approval signature

The control plane signs. The executor holds a **public key only** and cannot sign.
That asymmetry is the whole design: something with write access to the approval record can
corrupt it, and cannot forge one, because the signing key is not in that record. Since the
executor gave up its database read, this is also what makes it safe for the approval to
travel in a request body at all.

The signed message is a fixed domain string followed by nine fields --
`alg jid csha ctyp asha appr kver iat exp`, in that literal order -- each written as
`len(name):name=len(value):value;`. Length prefixes rather than a separator, because with
a `|` join `appr="x", kver="K|y"` and `appr="x|K", kver="y"` produce identical bytes and
one signature covers both. Lengths are UTF-8 **byte** lengths; a verifier that counts
characters derives different bytes and refuses every genuine approval.

That is `PC-APPROVAL-CANON-V2`. `ctyp` is the job's `command_type`, verbatim, `""` when
absent; `asha` is a sha256 over the canonicalised arguments object -- **the hash, not the
object**, so a large argument set does not enter the signed message twice. The two are
**inserted after `csha` rather than appended after `exp`**, which makes a V1 message and a
V2 message differ in a field position and not only in a length, so relabelling a stamp
cannot make it verify. `csha` is kept even though `asha` already covers
`arguments.command`, because `csha` is taken over the command **about to run** rather than
over the arguments object, and retiring a working control to tidy a field list is not a
trade worth making.

`PC-APPROVAL-CANON-V1` was the same construction over seven fields, `alg jid csha appr kver
iat exp`. It proved that a named approver approved this command TEXT for this job id under
this key inside this window, and said nothing about **where** the text would run. Both
signing sites emit V2 now.

**The bytes are never parsed.** They are rebuilt from stored fields and the signature is
verified over the rebuild. No parser, therefore no parser bug.

Three properties are easy to break and hard to notice:

- `jid`, `csha`, `ctyp` and `asha` come from **the job being executed**, **the command about
  to run** and **the arguments about to be used**, never from the stamp that travelled with
  them. Taking them from the stamp would let anyone who can compose it move both sides
  together. `ctyp` and `asha` are therefore parameters at the verifier, not stored fields
  beside the signature -- storing them would be handing the adversary the answer.
- The verifier holds an **allowlist** of key versions, not one key. Holding exactly one
  would make the key-version field decorative.
- Public keys are cached on **success only**. A key version is immutable so a cached key
  cannot go stale, but a transient KMS outage must not poison the process into permanent
  refusal. Time is checked *after* the signature verifies, so an unsigned document reports
  as unsigned rather than as expired.

The two variable names differ by one letter and live on two services. The control plane
takes the **singular** `APPROVAL_SIG_KEY_VERSION`, one resource name, untrimmed and signed
verbatim into the message. The executor takes the **plural**
`APPROVAL_SIG_KEY_VERSIONS`, a comma-separated allowlist whose members are trimmed. The
singular must appear character for character as one member of the plural; when it does
not, the executor answers "unverifiable" and every gated job 403s including the one that
would undo it. It fails closed -- nothing is forged -- but nothing runs either. The undo is
a Cloud Run configuration change and never a job, which is what keeps it reachable. The
installer compares the two and is the only thing that does.

Supply no key versions and `install.sh` provisions a P-256 key, grants the control plane
`roles/cloudkms.signer` and the executor `roles/cloudkms.publicKeyViewer`, and then
**last** sets `APPROVAL_REQUIRE_SIGNED=1`. Arming it last is the point: writing the
requirement before the key versions would refuse every approval in the window between.
Pin your own versions instead and arming is left to you. If the key cannot be provisioned
the installer refuses to continue rather than leave signing half-built.

One legacy field survives on approved documents: a symmetric HMAC stamp, emitted only when
a key is configured and **verified by nothing**. Handing a verifier the minting key was
the hole asymmetric signing replaced; a fresh install creates no such secret.

## The edge, and the session check behind it

There are two independent locks on a console page and they belong to different systems.

**IAP is the outer one and it is not this application's code.** Identity-Aware Proxy sits
in front of the console service and authenticates a Google account at Google's front door;
an unauthenticated request never reaches the container, so a bug in this application cannot
be the thing that lets somebody in. Put a hardware key -- a Titan, or a passkey on the
account -- behind that Google account and reaching the console costs a physical touch. There
is no password to phish.

The third control there is the one people leave out, and it is worth being precise about
what it does and does not do. With the project in a Google Cloud organization and
`constraints/iam.allowedPolicyMemberDomains` in force, an account outside your domain
**cannot be granted console access**: the grant is refused when it is written. Measured
2026-08-14 -- adding a consumer Gmail address to the console's IAP binding returned
`FAILED_PRECONDITION ... not in permitted organization` and nothing changed. **The caveat
travels with the claim:** the constraint is enforced at WRITE time, not retroactively.
Turning it off, adding the account and turning it back on **does** work, which means the
exception you told yourself was temporary is permanent. If you need a second operator, add a
second account **in your domain** with its own key.

**The session check is the inner one and it is this application's.** A fresh install sets
`PC_REQUIRE_PASSKEY=0`, so a verified IAP identity on `WA_APPROVER_EMAILS` satisfies it with
nothing to enrol and nothing to unlock. A caller carrying no IAP identity at all still gets
**401 with `control-plane/src/locked.html` served in place**, at the URL it asked for --
unlock, first-time setup, device enrolment, nothing else. Three things about that shape are
deliberate:

1. **There is no `?next=` and no redirect.** The caller's URL never changed, so unlocking
   lands them where they already were by reloading. There is no target to carry, and with it
   goes the enumeration oracle the `/wiki` routes were written to avoid -- the anonymous
   response no longer varies with caller input at all, held by construction rather than by
   remembering not to echo the slug.
2. **The status is 401, not 200 behind a 302.** An anonymous `curl` gets a code that MEANS
   refused; the old redirect was indistinguishable from a working page that had moved, and
   the installer's own guard check read that 302 as proof the console was guarded. No
   `WWW-Authenticate` header is sent, so no browser credential dialog appears.
3. **The WebAuthn path did not go away with the gate page.** It lost the larger of its two
   documents and kept the small one, and all fifteen `webauthn` routes are still in the tree.
   With `PC_REQUIRE_PASSKEY=1` this IS the working unlock page, and it is the way back in if
   the identity provider in front of the console ever fails. **Operators guide** has that
   switch.

The API middleware answers differently and says why. A console `/api/*` path with no session
returns 403 JSON naming **both** possibilities: no console session, or you are calling the
MCP host, where this path does not live. That second half is not padding -- the middleware
is not wrapped by the `PC_SURFACE` filter, so it answers on the MCP surface too, where there
is no IAP and never a session cookie.

| Setting | In-code default | What `install.sh` writes |
|---|---|---|
| `WA_SESSION_MIN` | 10 | 240 |
| `WA_ELEVATE_MIN` | 5 | not set |
| `WA_JOB_TTL_MIN` | 60 | not set |
| `PC_REQUIRE_PASSKEY` | on | 0 |
| `WA_SESSION_SECRET` | — | from Secret Manager |
| `WA_APPROVER_EMAILS` | — | your account |

Two of those are fail-closed and are the ones to check first when the console will not
unlock. A session secret shorter than 16 characters disables sessions entirely -- the
service refuses to *issue* one, not merely to accept one -- because an empty-key HMAC is
forgeable and a forgeable session cookie is a forgeable approval. An empty approver
allowlist denies the Google-identity approval path outright; an empty list used to
short-circuit the check and accept any authenticated Google identity.

**When a human does approve a job, the approval is bound to that job.** This is the manual
approval path. It is still present, no console page calls it on a stock install, and
`PC_REQUIRE_PASSKEY=1` is what puts it back in front of a person. With that gate on, the
approve route demands a fresh elevation bound to *that* job: the elevation cookie carries
both the job id and the sha256 of the job's command as it stands now. A generic "this
browser authenticated recently" cookie satisfies nothing, and an edited command
is refused. The danger verdict is kept only for the wording of the prompt -- it never
decides whether a tap is needed. Assertions are bound the same way: the last 32 bytes of the
challenge must equal the sha256 of the job id, a pipe, and the action, which is what makes
one usable for exactly one job and one action.

**Replay protection is two checks and you need both.** The first refuses a re-approve of a
job already `executed`; the second refuses one still `executing` within 20 minutes of its
start. Both return 409 carrying `preserved_exit_code`. Without the second, a second click
on a still-running job walked past the first, the executor correctly refused the replay
with 409, and the failure branch **overwrote the running job's record** with a null exit
code and "DID NOT RUN" -- nothing double-executed, the operator was simply lied to. A
missing or unreadable start time reads as zero, hence stale, hence allowed, so a control
plane that dies mid-flight cannot jam a job forever.

### The confirm route there used to be two of

There is now exactly one confirm endpoint, and it is the WebAuthn one. A second
endpoint used to sit on the MCP surface guarded by a shared bearer secret in a header
rather than by a credential, carrying none of the danger or elevation checks its
twin has. It has been **removed**, along with the secret it read: nothing binds that
secret to either service any more, and the installer no longer creates it.

It was removed rather than documented because it was never a working path in the first
place. It set the job to `confirmed` and then fire-and-forgot a request to the executor
**with no `Authorization` header** -- which the edge drops, because the executor is
private -- so the job stranded in `confirmed` with nothing running. What it did do was
make a single long-lived shared string sufficient to mark a privileged job approved, on
the surface that has no IAP in front of it.

Staging is unaffected: `POST /api/confirm/stage` is a different route on a different
credential, and it stages work rather than approving it. `list_pending_confirm` also
survives: it is a pure Firestore reader over `pending_confirms` and never called that route.

Its removal is also the worked example of how the route audit's `registered` list is meant
to be used. `POST /api/confirm/verify` was listed public, so retiring it cost **two**
deletions in the same commit as the source change -- the identical line out of `public` and
out of `registered` -- plus the surface-split counts. Leaving either line in place fails the
build, which is the intended behaviour and was rehearsed against exactly this removal.

## The data lake and the PCV1 vault

The bucket name is `DATA_LAKE_BUCKET`, then `LAKE_BUCKET`, then nothing. There is no third
rung. An earlier version ended with a guess derived from the project id, which in a
two-lane project resolved to the *other* lane's bucket -- and the lake path writes, so a
service redeployed without its lake variable wrote into the wrong lake and reported
success. Resolution throws per call rather than at boot, on purpose: a module-level
refusal turns a missing variable into a crash-looping revision and takes the console, the
unlock page and every route that never touches the lake down with it.

### The envelope

| Field | Value |
|---|---|
| magic | `PCV1`, 4 ASCII bytes |
| epoch | 2 |
| epoch 2 KEM | X-Wing, ciphertext 1120 bytes (ML-KEM-768 1088 + X25519 32) |
| cipher | AES-256-GCM |
| per-object key | `HKDF-SHA256(master, salt="paracoding-vault-hkdf-salt-v1", info = b"pcv1:" + utf8(path) + b":e" + byte(epoch), 32)` |
| AAD | magic, epoch, flags, **and the object path** |
| overhead | exactly **34 bytes** (4 magic + 1 epoch + 1 flags + 12 nonce + 16 tag) |

The +34 is the most useful operational fact in the system, because checking it needs no
key: a sealed object is exactly 34 bytes longer than its plaintext and begins with `PCV1`,
and equal size means plaintext. Compare **bytes to bytes** -- an em dash is three UTF-8
bytes, so counting characters on a file with seven of them gives 48 and reads as a false
negative. Note also that the epoch in the key derivation is a **raw byte**, not its decimal
digit; anyone reimplementing from a formula that writes it as a character derives a
different key and decrypts nothing.

The master key is derived by downloading the vault master object, sending it to Cloud KMS
for decapsulation, and running HKDF over the shared secret. It is held in RAM, never
logged, cached per epoch, and **failures are never cached**. That object is a **JSON
envelope**, not a bare ciphertext: a reader that handed the whole JSON to KMS got a length
error on every call from the day the vault was created, so the lake's encryption never
worked for a period -- and worse, the write path threw while the read path swallowed the
same failure and returned an empty string, so it read as an *empty file* rather than an
error. The reader now checks the epoch and the KDF info string and fails closed, because
deriving with a different info string produces a key that encrypts happily and decrypts
nothing.

### "The lake is encrypted" is untrue without both carve-outs

The five prefixes in `VAULT_CLEARTEXT_PREFIXES` are stored plaintext by design: the control
plane loads and executes code from them at boot, and it cannot decrypt what it has not yet
started. That list must match its Python peer exactly. Second, the read path does a **dual
read** -- a buffer without the `PCV1` magic comes back byte-for-byte unchanged, so every
object written before encryption landed stays readable.

The write path is **fail-closed, not fail-plaintext**: it resolves the master *before* it
saves and there is no plaintext fallback branch. Where the master could not be minted,
reads and listing work and every write outside the cleartext prefixes throws -- which is
what an operator sees as "every lake write fails". The mint is conditional on the
installing machine having a Python cryptography library that implements ML-KEM-768; where
it does not, the installer names what is missing and skips it. It is never forged.

### Three ways to destroy the lake permanently

- **Overwrite the vault master.** Every object sealed under the old master becomes
  unreadable. There is no recovery.
- **Point at the wrong keyring.** The keyring and key are read from the environment, which
  the installer writes lane-namespaced on both services -- but the in-code fallback when
  those variables are absent is still a **bare literal**, which is the one combination that
  cannot work in a two-lane project. A redeploy that drops the vault environment therefore
  does not fail loudly; it silently resolves the unprefixed names. A control plane resolving
  the other lane's keyring holds no
  decapsulator on it, every master derivation 403s, and the symptom is every lake write
  failing -- which takes the git object store down with it. Granting the second lane
  decapsulator on the first lane's key would be strictly worse: it would let it derive the
  first lane's master key.
- **Seal something that must stay plaintext.** Directory markers are zero-byte objects
  identified by their size. Seal one and it becomes 34 bytes, stops being recognised,
  survives into the object store, and `git fsck` reports garbage.

## The git store

The repository is not a bucket of `.git` files. It is two halves:

| Half | Where | Written by |
|---|---|---|
| refs | Firestore, under the repo document | the compare-and-swap, and nothing else |
| objects | the lake, under the repo's object prefix | the GCS store adapter |

The compare-and-swap has to sit **above** isomorphic-git, because that library's ref
write is a blind overwrite with no expected-old-value and its lock is an in-process
mutex that provides exactly zero protection across Cloud Run instances. The refs module
never calls isomorphic-git at all.

| `expectedOid` | `newOid` | Meaning | Failure codes |
|---|---|---|---|
| `null` | oid | create | `ALREADY_EXISTS` |
| oid | oid | update | `NOT_FOUND`, `STALE` |
| oid | `null` | delete | `NOT_FOUND`, `STALE` |

A lost race returns a result object with `ok: false`, not an exception, because a lost
race is an ordinary outcome of a correct concurrent system. It **does not auto-retry on
mismatch**: re-reading and re-issuing would turn a compare-and-swap into a blind overwrite
with extra steps and silently discard the winner's commits. It *does* retry on transient
gRPC codes, which is safe because the comparison is re-evaluated from scratch inside the
new transaction -- a first attempt that actually committed makes the second return `STALE`
rather than double-applying.

Git objects are PCV1-sealed, and that does **not** break content addressing: the object id
is the sha1 of the plaintext, computed before the bytes reach the storage adapter, and
nothing re-derives an id from stored bytes. The adapter's `stat` must report the
**plaintext** size from a metadata stamp, because isomorphic-git records that size in the
index and a uniform +34 would make every indexed file look permanently modified.

### What the MCP git surface can and cannot do

Seven tools: `git_read`, `git_list`, `git_log`, `git_diff`, `git_propose`,
`git_propose_patch`, `git_push`.

`git_propose` writes **whole files only**, and each entry names exactly one of `content`,
`copy_from` or `delete: true` -- zero or two of them is refused. There is no anchor, no
hunk and no search-and-replace, because a patch API forces the server to guess what the
agent meant when an anchor is ambiguous, and a wrong guess writes plausible,
silently-wrong content into a commit.

Deletion **exists** and is explicit, one path at a time: no glob, no prefix, no recursive
directory removal. Removing a path that is not there is a **refusal**, never a silent
success, because a removal that quietly removed nothing would ship as a deletion and leave
the file in the tree. A directory left empty by a removal is pruned, because real git never
emits an empty subtree and a phantom entry would make the tree id diverge from the
canonical id for identical content.

`copy_from {path, ref}` reuses a blob already in the repository, writing its id straight
into the tree so none of its bytes cross the wire. It goes through the same ref gate and
path rules as a read, so it reaches nothing you could not already read.

`git_propose_patch` cannot create, delete, rename, chmod or patch binaries, and every hunk
must match the current bytes exactly at the line it names -- no fuzz, no offset search.
`git_push` takes `expected_oid` and there is no force push. Default caps: 2 MiB per blob
read, 100 files and 8 MiB per proposal, 200 files per diff, 200 commits per log.

Two configuration traps:

- **The tools are withheld, not broken, when unconfigured.** Without both a repo id and a
  bucket the module registers **nothing** and logs why. Before that guard, all seven
  registered cleanly on every install and threw on their first call -- an adopter must see
  no tool rather than a tool that lies about what it can do.
- **The database id is reconciled, and a conflict refuses at boot.** The git module reads
  its own database variable; the rest of the control plane reads the host's. An explicit
  value on the module wins, absent one it follows the host, and if both are set and
  disagree the module throws. The default database frequently *exists* in a Google Cloud
  project and simply has no repo collection, so addressing it returns an **empty
  repository rather than an error**, and an empty answer reads as "no such branch".

### The repository, to a machine: `GET /git/archive`

Because the objects are PCV1-sealed, a build system reading the lake directly gets
ciphertext. `GET /git/archive` is how a machine gets a tree instead: one reader, inside the
process that already holds the vault, serving `ref` (default `main`) and an optional `path`
as a gzipped tarball.

**There is no shared secret, on purpose.** The obvious build puts a bearer key in Secret
Manager and hands it to the builder. That works, and it is still a key: it can leak, it must
rotate, and possession alone is authority. Instead the caller presents a **Google-signed ID
token for its own service account**, Google attests it at `tokeninfo`, and IAM decides.
Nothing to rotate and nothing to leak. The verifier mirrors the OAuth strain verifier line
for line -- same call, same shape guard, same audience pin -- because a second, subtly
different verifier is how one of the two ends up weaker.

Four things must hold before a byte is served: a bearer token that parses as a three-segment
JWT; an email that ends in `.iam.gserviceaccount.com`; an audience equal to `MCP_PUBLIC_URL`
(or that plus `/git/archive`); and membership in `PC_ARCHIVE_ALLOWED_SA`.

**`PC_ARCHIVE_ALLOWED_SA` FAILS CLOSED WHEN UNSET.** Unset means *no* caller, not *any*
caller. An empty allowlist read as "everyone" would hand the whole private source tree to
any service account in any project that found the URL. The installer writes the project's
Compute and Cloud Build service accounts into it.

The manifest rides in **headers** -- `x-pcgit-commit`, `x-pcgit-files`, `x-pcgit-bytes` -- so
a build step can assert coverage rather than trust a byte count. A build comparing
`x-pcgit-files` against what it extracted turns a silently short archive into a red build
instead of a mystery three deploys later. Every served archive is journalled.

### The two plaintext mirrors are dead

`gs://<lake>/shared/repo/HEAD/` and `gs://<project>-source/<repo>.git` are both **STALE**
and neither is a source of truth. This is not a caution; it is a measured failure. Agents
read them **as** the repository and reported confident detail about code that had not
existed for weeks. Before the ruling that made the store authoritative, both stores were
writable and they drifted three times in a single day.

If you find a document, a job, or a helpful-sounding shell snippet that reads either path,
that document is out of date. The store is the writer, and `GET /git/archive` is how a
machine reads it.

## The build, and what happens when `main` moves

**Changing the code** covers the deploy. What matters inside the image: the route audit
runs, then the blob audit, then esbuild -- audits first, so a failure means no bundle is
ever emitted. The main source is **transpiled, not bundled**; the git tools module **is**
bundled, which is why the wiki route reaches its object-id resolver through that bundle
rather than importing it directly.

A `git_push` that actually moves `main` publishes a Pub/Sub notice carrying
`{commit, short, ref}` and records the outcome in Firestore beside the repo, so "has this
been dead for a week" is a query rather than a guess. The publish is **awaited**: Cloud
Run throttles CPU once the response is written, so a fire-and-forget emission is a
publisher that works on a warm instance and silently does not on a cold one. The service
account holds publisher **on that topic only**.

What is published is deliberately **not** a build request -- it says main moved. A build
request names an archive and its digest, and at push time that artifact does not exist and
its digest cannot be predicted; a message carrying an invented digest fires a build whose
first step verifies that digest, and a build that fails on a lie proves nothing. The Cloud
Build trigger that turns the notice into a build is created by hand and the installer
prints the command. That is also why `uninstall.sh` **holds** the CI build identity: the
installer adopts an account of that name when one exists, so teardown cannot tell one it
made from one that was already yours, and deleting it breaks the hand-made trigger and
every binding that names it.

### Materialising a checkout, and the one lie `gcloud` tells

`deploy/BUILD-FROM-THE-STORE.md` is the long form. The shape, proven end to end:

1. Fetch `shared/deploy/lane-fetch.py` with a **raw copy** -- it lives in a cleartext prefix,
   so a plain download reads it.
2. Use it to pull `<your-exporter-object>` **through the vault codec**.
   That prefix is sealed, so a raw `gcloud storage cp` of the exporter succeeds and hands you
   a PCV1 envelope; `python3` then dies with `SyntaxError: source code cannot contain null
   bytes`. If you see that line you fetched ciphertext -- nothing is corrupt and nothing is
   damaged, you used the wrong fetcher. It fails in the worst way because the *copy* looks
   healthy.
3. Export the store with `--expect-ref`, clone the result, then
   `gcloud run deploy --source`.

**`gcloud` misreports which revision it deployed.** Do not trust the revision name it prints.
Read `status.latestCreatedRevisionName` back off the service and re-pin traffic to that.
This is the step most likely to be skipped and the one that produces the "I deployed the fix
and nothing changed" report.

## Timeouts, and the number everybody gets wrong

`install.sh` passes `--timeout` to none of its Cloud Run deploys. On a fresh install both
the control plane and the executor therefore take Cloud Run's unset default of 300
seconds. The executor's *subprocess* ceiling is separate, `EXEC_TIMEOUT`, in-code default
900 seconds, and the installer does not set it either.

The call to the executor is **awaited synchronously inside the request that fires the
job** -- the approval request on the manual path, the staging call on the auto-run path --
over a bare `fetch` with no abort signal. So the effective ceiling on a job is the **control
plane's** request timeout, not the executor's, and raising `EXEC_TIMEOUT` changes nothing on
its own.

At the ceiling the caller's fetch and the control plane's handler both give up. Whether the
executor's own request survives depends on *its* Cloud Run timeout. If it does, it finishes
and writes its result object -- which is why this is now a **delay** rather than a lost
result: the ingest sweep picks that object up the next time the console is polled and fills
in `status`, `exit_code`, `stdout_tail` and `stderr_tail`. Until then the job reads as
having produced nothing.

If the subprocess itself times out you get **exit code 124** and a stderr line naming the
number of seconds -- read that number off the serving revision rather than assuming it. So:
124 means the executor timed out; empty tails with no 124 means the control plane gave up
and the executor may have finished without you. In that second case, wait for the sweep or
read the result object out of the bucket directly.

## This wiki is part of the system

**Start here** describes the objects. Two things about the route are not obvious.

**It is not public.** Both wiki routes require an unlocked console session and, without one,
answer **401 with the locked document at the requested URL**. They used to 302 to a constant
`/wiki` target for every slug, existing or not, precisely so the anonymous response was not
an enumeration oracle. That property is now held by construction rather than by remembering
not to echo the slug: the anonymous response does not vary with caller input at all. The "no
such page" body still never echoes the slug you asked for. There is deliberately no JSON API
behind the shell.

**A page containing a credential is withheld at render.** Two credential shapes are
matched, and a match replaces the whole body with a quarantine notice and a red badge. An
agent authors these pages, and a page that pastes a credential has created a second
permanent copy of it on a human-read surface.

## Known limits, collected

An honest limitation is worth more than a confident overview, so here they are in one
place. None of these is a bug report; each is a decision with its reason above.

- **Session-key binding is attribution, not isolation.** Two chats holding the same paste
  are the same principal and the server cannot tell them apart.
- **The tool-class filter narrows nothing by default.** A role with no explicit class array
  holds every class even with enforcement on.
- **There are no runtime refusals with the shipped defaults.** A destructive command runs. A
  lockout-class change runs. Both are journalled, and that is the whole of the mitigation:
  detection, plus a roll-forward. `PC_GUARDRAILS=1` restores both refusals. The recovery from
  a lockout-class mistake is Cloud Shell, and an adopter who does not have that should set
  the variable.
- **Nothing expires, ingests or quarantines unless the console is polled.** Expiry, identity
  quarantine and the executor-result sweep all ride `GET /api/webauthn/pending`. With nobody
  logged in, pending jobs sit past their TTL indefinitely and executed jobs read back with
  empty output. Nothing is lost -- the results are objects in a bucket -- but nothing is
  timely either.
- **The IAP domain constraint is enforced at write time, not retroactively.** Disabling it,
  granting an out-of-domain account, and re-enabling it works, and the exception it creates
  is permanent. Add a second in-domain account with its own key instead.
- **The buckets and the KMS keyrings are never deleted by the uninstaller**, by any flag.

Two limits that appeared in earlier editions of this page are **retired because they are no
longer true**, and they are named here so nobody re-derives them from an old copy:

- *"A guarded route can disappear without failing the build."* Closed 2026-08-12. The
  baseline now records every registered route, not only the public set, and losing any of
  them fails the build by name.
- *"`read_job_log` shows empty stdout permanently when the control plane's request dies."*
  Closed by the executor result object and the ingest sweep. What remains is a delay, bounded
  by when the console is next polled.
