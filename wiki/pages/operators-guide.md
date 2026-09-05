---
page: operators-guide
title: Operators guide
section: operate
status: live
audience: public
owner: unassigned
generated_by: starter-edition
verified_at: "2026-08-14"
verified_by: starter-edition
watch:
  - "lake:shared/wiki/_release.txt@71b8aebd9209c5b60ca8ccc1ef4bb906ec2a7a5e39d77743e915866794b5d323"
---

# Operators guide

**Approvals** tells you what authorises privileged work and why that changed. The
**Systems manual** tells you what the parts are and why they behave as they do. This page
is only what you do, and it is written to be followed at 2am by someone who did not build
it: nine numbered tasks, then the things that are irreversible, then the things not to do.
Where a mechanism is named here without being explained, the manual explains it.

Two habits make everything below cheaper. Read the command, not the summary beside it. And
when something reports success, check the world rather than the log -- the log has more ways
to be empty than the world has ways to be unchanged.

## What is different from the page you may remember

If you have followed an older copy of this guide, three of its instructions will send you
somewhere that no longer exists. They are corrected in place below, but they are worth
naming up front because each one is a wasted trip in the dark.

**There is no `/gate`.** The route, the 142KB document behind it, `GET /jobs`, `GET
/pastes` and every redirect into them are deleted. Those three paths return 404 now, and
that 404 is correct. An anonymous request to `/harness`, `/wiki`, `/flow`, `/chat`,
`/lakeview` or `/flowhood` gets **401 with the locked page served in place**, at the URL you
asked for -- no redirect, no `?next=`.

**There is no per-job tap for shell work.** On a fresh install `PC_AUTO_APPROVE=1`, so a
`run_command` is approved, signed and executed in the same call that stages it. And
`PC_GUARDRAILS` defaults to `0`, so a destructive command runs and a lockout-class change
runs. Both are journalled. The operator's ruling that produced this, verbatim: *"we don't
add speed bumps we add accelerators"*, and *"there is no gate going forward for a job to
show up in for me to approve because nothing needs approved its all coming from me the chat
is just my hands."* `PC_GUARDRAILS=1` restores both refusals for an adopter who wants them.

**Every pre-ship check is untouched, and the distinction is the whole point.** `oss/gen.py`
still refuses a bad cut, `control-plane/route-audit.mjs` and `blob-audit.mjs` still fail the
build, the leak ceilings still bite, `devgate/smoke.py` still judges, and the
compare-and-swap on `git_push` is unchanged. Checks that fail a CUT stayed. Refusals that
stop a RUN went.

---

## 1. Sign in

Open the console host in a browser. `GET /` is a 302 to `/harness` and that is the whole
front door; there is nothing else to type.

Two doors stand in front of it, in this order.

**Identity-Aware Proxy**, in front of the console service, authenticating a Google account.
Signing in to that account at IAP's prompt is the only sign-in there is. The posture this
fleet runs is an account carrying a hardware security key (Titan), plus the org policy `constraints/iam.allowedPolicyMemberDomains`, which makes granting an
out-of-domain account *impossible* rather than merely discouraged -- the grant is refused at
the moment it is written. Measured: adding a consumer Gmail address returned
`FAILED_PRECONDITION`, "not in permitted organization".

The caveat travels with that claim and must never be dropped from it: **the constraint is
enforced when a binding is WRITTEN, not retroactively.** Disabling the policy, adding the
account and re-enabling it does work, and the exception it creates is permanent. So the
recommendation for a second pair of hands is a second **in-domain** account with its own
key, not a personal address let in through a temporary hole.

**Then the approver allow-list.** A fresh install seeds `WA_APPROVER_EMAILS` with the
installing account, and the application's own check is satisfied by the verified IAP
identity you already presented -- the control plane checks the assertion's signature and
audience itself, on every request, and trusts no bare header. There is nothing to enrol and
nothing to unlock. The one credential the console issues is a session cookie signed under
`WA_SESSION_SECRET`; `WA_SESSION_MIN=240` bounds it at four hours, and a missing or short
secret means no session is issued or accepted at all. An anonymous caller carries no IAP
identity, so it gets the 401 with the locked document served in place; because that 401 is
served at the URL you asked for, the way back is a **reload**, which is why `?next=` was
deleted rather than reimplemented.

**Add a second operator now, before you need one.** The console fails closed with nobody on
the allow-list, and there is no console path around it: recovery from zero is a redeploy and
is not a documented happy path. Two grants do it -- the account on the console service's IAP
binding, and its address in `WA_APPROVER_EMAILS` on both services. Treat two accounts able to
reach the console as an operating requirement, not advice.

### There is no second way in

IAP, the Google identity it verifies, the approver allow-list and the session cookie are the
whole of console authentication. There is no credential of the console's own to register
and no switch that adds one. If the identity provider in front of the console fails, the
console is unreachable until it is back; if you lock yourself out by configuration, the
recovery is a deploy-time change from Cloud Shell, which you hold. Both `WA_APPROVER_EMAILS`
and the IAP binding are Cloud Run configuration, so no job can change them and no compromised
control plane can widen them.

One error worth recognising:

**`403 forbidden: no console session`** -- the message names both possibilities on purpose.
Either you have no unlocked session, or **you are calling the MCP host for a console path**.
The console routes answer on the MCP surface too, where there is no IAP and never a session
cookie, so a copied URL with the wrong hostname produces exactly this.

## 2. Read a job log

`read_job_log(job_id)` is the transport. The manual documents the projection and the one
field it lies about. Read the fields in this order, because each one makes the next
meaningful or irrelevant.

1. **`status` / `ran`.** `executed` is the only value that means the command ran.
2. **`reason`, then the raw reason fields.** Non-null means a control fired. Read the raw
   fields to learn *which*, not just that one did.
3. **`exec_http`.** Present and outside 200-299 means the executor was reached and refused,
   or was never reached. `exec_failed_reason` will begin "DID NOT RUN". Take it literally:
   that is a transport or authorization failure at the executor, not a failure of your
   command.
4. **`exit_code`.** Only now.

Who may read what: a principal reads the jobs **it** staged. Only principals named in
`LOG_READ_ALL` -- default `fleet-advisor` -- read everything. A denied read says so and
names `staged_by`; it is not a missing job.

### Four results that mean something other than they look

**`exit_code: 0` with empty `stdout`.** Zero means the command exited zero. It is not
evidence that nothing ran -- it is the projection artefact the manual describes. The
procedure:

1. Re-read once. You pick up `status` and `exit_code`, which the executor does write.
2. **Do not wait and re-read again for the output.** It is not coming, at any delay. The
   field holding it is not in the projection.
3. Verify the world instead.

**`exit_code: null`.** Nothing ran. Read `exec_failed_reason` and `exec_http`.

**`exit_code: 124`.** The subprocess hit its own ceiling and `stderr` names the seconds.
Read that number off the serving revision rather than assuming it. On a fresh install this
is close to unreachable, because the request ceiling arrives first.

**A non-zero exit from a job that did most of its work.** The command runs as one bash
file, and not with `-e`. A failure in the middle does not stop the rest, and the exit code
is the exit code of the *last* thing. A job can report failure having already changed your
project. Check the world before you re-run.

### Verifying the world

When the log cannot tell you, ask the thing itself. These cover almost every job:

```
# did the revision that is actually serving change?
gcloud run services describe <service> --region $REGION --project $PROJECT \
  --format='value(status.latestReadyRevisionName)'

# does that revision carry the value you think you set?
gcloud run revisions describe <revision> --region $REGION --project $PROJECT --format=json \
  | python3 -c 'import sys,json
d = json.load(sys.stdin)
cs = ((d.get("spec") or {}).get("containers")) or []
e = dict((x.get("name",""), x.get("value","")) for c in cs for x in (c.get("env") or []))
print(e.get("VARIABLE_NAME","") or "UNSET")'

# did the IAM binding land?
gcloud projects get-iam-policy $PROJECT --format=json

# what does the system say it did?
read_journal(limit 50)
```

The second is the shape `install.sh` uses for its own read-backs, for the same reason: a
deploy that reports success and a revision that carries the value are two different facts,
and only the second is worth anything. Use it for every env-var check below.

## 3. Stage and run work

### The common case: it already ran

`run_command` stages a job document and then, with `PC_AUTO_APPROVE=1`, immediately stamps a
**real** pre-approval on it -- KMS-signed, with the approver field reading
`auto:lockout-check` because there is no human in that path and the audit trail must not
claim one -- and fires it. What comes back is:

```
RAN job <job_id> (run_cmd) exit <n>
<last 6000 bytes of stdout>
```

Nothing was skipped to get there. The executor's rungs all still run on that job: the
`approved_sha256` pin, the approval signature (`APPROVAL_REQUIRE_SIGNED=1`), the single-use
claim written as an object in the exec-records bucket, and the lockout checker.

With `PC_GUARDRAILS=0` -- the shipped default -- a destructive command and a lockout-class
change both run. The detection did not go away, only the refusal: the checker still runs and
writes `exec_lockout_class_ran` naming the rules that matched, so the transcript can answer
"what took the console out" without anyone guessing. `read_journal(limit 50)` is where you
read that back, alongside `auto_run_executed`.

With `PC_GUARDRAILS=1` you get one of two answers instead, and neither of them ran anything:

```
NEEDS YOUR OK — NOT RUN, NOT QUEUED.
NEEDS YOUR OK — REFUSED BY THE LOCKOUT CHECK, NOT RUN.
```

Re-issuing with `confirm=true` is the deliberate override. The acknowledgement rides *inside*
the job's `arguments`, which the approval signature covers, so it cannot be added in transit
by anything that can reach the executor. An acked run is journalled separately, as
`exec_lockout_acked`, so "a human said yes to a lockout-class change" can never be confused
in the transcript with "the checker found nothing".

### What auto-runs, and this is the part to know at 2am

`run_command`, `stage_privileged_job`, every `gcp_api` mutation and `run_roll` all go through
the same auto-run path: with `PC_AUTO_APPROVE=1` the job is stamped, signed and fired in the
call that staged it. **Two things still stop at `pending`:** a staged job that carries no
command text for the executor to run, and -- with `PC_GUARDRAILS=1` -- a destructive body,
which is handed back to you in chat. Those return `STAGED ... job <id>`, or
`{ mode: "staged", job_id }`.

So the single most useful thing to read in a tool result is the first word. **`RAN` means it
happened. `STAGED` means it did not.** If you read `STAGED` and walk away believing the work
is done, nothing will tell you otherwise until you check the world.

### Where the remaining queue lives

A job that stopped at `pending` sits there. Nothing comes along and runs it -- no timer, no
retry, no approval route and no console page that fires it. `list_pending_confirm` lists the
pile, `read_job_log` reads one job's outcome afterwards, and `POST /api/jobs/supersede`
retires a proposal you no longer want, recording who did it and why. If what you staged
should have run, the fix is the switch -- `PC_AUTO_APPROVE=1` on both services -- or running
the command yourself from Cloud Shell.

### Refusals at stage time, which cost you nothing

**A byte-identical duplicate is refused, and nothing waiting is destroyed.** If a job with
the same `staged_by`, the same `command_type` and the same command bytes is already pending,
the second stage is rejected with "NOT STAGED, AND NOTHING WAS DESTROYED" naming the job that
is already there. Approve or deny *that* one.

**There is a per-role cap on the pending queue**, `PC_PENDING_MAX_PER_ROLE`, default 25. Past
it a stage is refused and the waiting jobs are untouched.

**A queue that cannot be read refuses the stage.** An unreadable queue is indistinguishable
from an empty one, and admitting on an unreadable queue is how a cap is bypassed by inducing
an error. If this keeps happening, the control plane cannot reach Firestore -- in which case
no job could be approved either.

### Two things that used to be true here and are not

**The automatic supersede is deleted.** An older version of this page told you that a second
`run_command` from the same role silently discarded the first, through the supersede key, and
that you should therefore approve the first before the second was staged. That loop is gone.
It ran on every load of the pending list, wrote `status: superseded` with no note, no
superseding job id and no role, and so destroyed staged work that afterwards reported
`reason: null` forever. Nothing retires a pending job behind your back now. The concerns it
could have served are answered at stage time instead, on the exact command bytes, with a loud
refusal that destroys nothing.

**Nothing expires a pending job either.** There is no time-to-live and no sweep: a job
that stopped at `pending` stays there until it is superseded on purpose. `read_job_log`
still projects `expired_reason` and `quarantine_reason` for records an earlier release
wrote, so an old job's reason is not lost.

Two classes of bad job still never get staged at all: one that destroys a Secret Manager
secret without invoking the destroy preflight, and one whose command contains an unpaired
UTF-16 surrogate. Both are refused before staging. You are not the check for either.

## 4. Deploy from the store

**The store is authoritative.** The repository lives as refs in Firestore and objects in the
lake, and those objects are PCV1-encrypted, which is the reason this task has a procedure at
all: no build system can read them directly.

**The two plaintext mirrors are dead.** `gs://<lake>/shared/repo/HEAD/` and
`gs://<project>-source/<repo>.git` are both stale and neither is a source of truth. This is
not a stylistic point -- agents that read them reported, in detail and with confidence, code
that had not existed for weeks. If a script you inherited clones from either, that script is
building the wrong tree.

There are two supported ways to get a checkout, and they are for different callers.

**Inside a gated job**, the long form is `deploy/BUILD-FROM-THE-STORE.md`. The short form:

```
gcloud storage cp gs://<lake>/shared/deploy/lane-fetch.py /tmp/lane-fetch.py
python3 /tmp/lane-fetch.py <your-exporter-object> /tmp/pcgit-export.py
python3 /tmp/pcgit-export.py --out /tmp/src.git --head refs/heads/main \
  --expect-ref refs/heads/<branch>=<oid>
git clone /tmp/src.git /tmp/work
gcloud run deploy <service> --source /tmp/work/control-plane --region $REGION --project $PROJECT
```

The first line is a **raw** copy and that is correct: `shared/deploy/` is a cleartext prefix,
so the fetcher is always stored in the clear. The second line must go through `lane-fetch.py`
and a raw copy of it fails in the worst way -- the copy succeeds and python dies on
`SyntaxError: source code cannot contain null bytes`, which means you fetched ciphertext.

**Pass `--expect-ref`.** It is the difference between building the commit you meant and
building whatever the store happened to hold.

**Use `gcloud storage`, never `gsutil`.** Inside a job, `gcloud` runs as the approving human
through the injected token; `gsutil` ignores that token, falls back to a service account with
no access, and dies 403.

**For a machine that is not a gated job**, `GET /git/archive` on the MCP surface serves the
repository as a gzipped tarball. There is no shared secret: the caller presents a
Google-signed ID token for its own service account, the audience is pinned to the MCP public
URL, and the email must be on `PC_ARCHIVE_ALLOWED_SA`. **That allowlist fails closed when
unset** -- unset means no caller, not any caller. The response carries `x-pcgit-commit`,
`x-pcgit-files` and `x-pcgit-bytes` so a build can assert coverage rather than trust a byte
count.

**Then re-pin the traffic.** `gcloud` misreports which revision it deployed, so the revision
name must be read back from the deploy itself and the traffic pointed at it explicitly. See
the next task; it is the same fact from the other direction.

## 5. Roll back a revision

Traffic is a pointer. Rolling back moves the pointer; it does not rebuild anything, it does
not need the store, and it is a Cloud Run API call rather than a gated job -- which is why it
stays available in the state where nothing else does.

```
# what is serving right now?
gcloud run services describe <service> --region $REGION --project $PROJECT \
  --format='value(status.traffic.filter("percent:100").revisionName)'

# what else is there?
gcloud run revisions list --service <service> --region $REGION --project $PROJECT

# put it back
gcloud run services update-traffic <service> --region $REGION --project $PROJECT \
  --to-revisions <revision>=100
```

**`gcloud` lies about which revision it deployed, and this is the trap that costs a
promotion.** Record the revision at the moment of the deploy that created it:

```
gcloud run deploy <service> ... --no-traffic \
  --format='value(status.latestCreatedRevisionName)' > /workspace/cp.rev
test -s /workspace/cp.rev
```

Never re-derive "the latest revision" later and assume it is the same one. A concurrent
deploy between the two reads makes them different revisions, and you would verify one and
promote the other. An empty answer means the deploy did not tell you what it made, which is a
refusal, not something to guess past. `pipeline/cloudbuild-prod.yaml` does exactly this, and
`test -s` is the whole reason it can be trusted.

**The rollback marker is what tells you the name to go back TO.** The prod pipeline writes it
**before any traffic shift**, at the point where refusing is still free -- both new revisions
exist at zero traffic and nothing serving has changed. It lands at:

```
gs://<project>-datalake/deploys/<TS>-<short>.json
```

and carries `cp_new`, `mc_new`, `cp_prev`, `mc_prev` and the previous `BUILD_COMMIT` of each.
If the currently-serving pair cannot be read, the promotion **refuses there** rather than
shifting traffic with no recorded way back. At 2am, that file is the fastest honest answer to
"what was serving before this?"

Two things to keep in mind while you are in there:

* `--set-env-vars` and `--set-secrets` **replace the whole set**. `--update-env-vars` and
  `--update-secrets` merge. A `--set-*` against either auth surface is a lockout-class change
  regardless of what you intended by it.
* Verify by reading back off the serving revision, never by the exit code of the command that
  claims to have done it.

## 6. Mint and revoke a session key

A session key is how a chat gets an identity. It matters because an MCP connector is
account-level: one connector serves every chat, so every unbound chat resolves to the same
default role and none of them is the strain you meant.

**Mint** from the console at `/harness` -- the **Session pastes** button in the header. This
moved off the deleted gate console and nothing server-side changed with it; it is the same
`GET /api/sessions/roles` and `POST /api/sessions/mint`. One role per key.

* **The value is shown once.** Only its hash is stored. A mint you did not copy is gone.
* Only a strain that is **active** *and* explicitly **`pasteable`** can be minted. Those are
  different questions and conflating them is a real hazard -- a service identity (the
  unpasteable OAuth default, or a break-glass recovery role) must stay off the mint list,
  because a chat that holds that key is that identity. A strain provisioned later is not
  pasteable until a human marks it, which is the correct direction for a flag that hands out
  identity.
* A fresh install sets `PC_KEY_TTL_DAYS=7`.

**Revoke** with the identifier prefix the console shows you.

* **Revoke matches by prefix**, so a short prefix revokes every key whose hash starts with
  it. Pass the full prefix displayed and check the returned count is the number you meant.
* **Revocation is a flag, not a delete,** and the lookup behind it is cached for sixty
  seconds per serving instance. Revoking clears the cache on the instance that served your
  request; another instance can honour the old answer for up to a minute. For anything
  urgent, revoke and then confirm the agent is actually refused.
* **Keys minted before expiry existed are grandfathered valid forever.** Revoke those
  explicitly rather than waiting them out.

Deleting a strain revokes every key bound to that role in the same operation and reports how
many.

When an agent says its key stopped working, the refusal reads: "The session key in this chat
is not recognised, has EXPIRED, or has been revoked." Mint a fresh one and replace the key
line in the chat. **The refusal never degrades**, so if an agent proposes using the role name
instead, the answer is no -- a role name resolves to nothing. A request carrying more than one
distinct key across a batch is refused as `mixed`.

## 7. Driving it from your own machine

12.0 is a GCP MCP connector a person drives from an MCP client on their own machine. There
is no workstation VM, no autonomous loop, and nothing at all that runs unattended. You do not
add a box and you do not point `vm_*` tools at one -- those tools are not on this surface.

Connect an MCP client (Claude is the reference cockpit, not a dependency; Grok and any
client that can pass a session key as the `agent` argument also work) and mint a paste from
the harness header. Work items, the memory graph and the journal stay as a shared list and
shared memory a human or an agent reads and writes -- not a queue anything claims.

If an earlier release left a workstation instance in the project, `uninstall.sh` still
deletes it and says so first, because deleting an instance destroys its boot disk.

## 8. Recover when the control plane is down

A console you cannot reach does not mean the work is lost and does not mean you are locked
out. Three facts, in the order you will want them.

**The undo for a bad deploy is not a job.** Traffic shifts, `PC_AUTO_APPROVE` and
`PC_GUARDRAILS` are all Cloud Run configuration, so the way back is a revision or an
API call and stays available in exactly the state where no job could be approved. That is a
deliberate property, not an accident: the switch is out of reach of the thing it switches.

**Cloud Shell is the named recovery channel.** This is the trade the guardrails default makes
openly -- a lockout-class change can take the console's own auth out, and the way back is a
shell the operator holds. `deploy/LOCKOUT-CLASS.md` is the list of changes that can put you
here.

**The exec record survives Firestore.** The executor writes its single-use claim, its result
and its journal as objects in `PC_EXEC_BUCKET` (`<project>-exec-records`) under `claims/`,
`results/` and `journal/`. `gcloud storage ls` and `cat` on that bucket will tell you whether
a command ran and what it printed even when nothing can read the job document. It is also
required, not optional: with the bucket unset the executor refuses, because the claim is the
single-use protection and there is no longer any other place for it.

### A job has been `executing` for a long time

The control plane's request died and the document was never updated. Wait twenty minutes from
`started_at`; after that the in-flight guard treats the lock as stale and the job becomes
approvable again.

**Verify the world before you re-approve.** The first attempt may have completed. If it
consumed its claim you will get `409 this approval has already been spent`, which is the
right answer and is also how you learn the first attempt got further than you thought.

### Every approval started failing after a deploy

Three causes, in the order worth checking.

**The signing key version and the executor's allowlist no longer agree.** Read all three
values off the serving revisions -- `APPROVAL_SIG_KEY_VERSION` on the console and on the MCP
service, `APPROVAL_SIG_KEY_VERSIONS` on the executor -- with the env-var snippet in task 2.

Look for whitespace first. The signer does not trim and the verifier does, so one trailing
space produces an error that names the allowlist, which is the one thing that is not wrong.

Fix it by widening the executor's allowlist to include whatever the control plane is actually
signing with. Do not fix it by moving the control plane back; you would strand every approval
already signed with the new version.

**Somebody armed the executor's independent assertion check.** See "Things not to do".

**Somebody changed a variable in order to harden something.** Also below.

### A strain was deleted and its jobs will not approve

Expected, and not recoverable as jobs -- re-stage the work from a live strain.

The strain's history *is* recoverable. Deletion writes chat history, journal, work items and
the registry document to a JSON backup object in the lake **before** deleting any of them,
and the response returns that object's key as `backup` along with the counts removed. Keep
that key; nothing else records it.

### The wiki page you are reading went red or amber

Amber, `STALE`, means a watched artifact resolved and no longer matches: the page is
describing a version of something that has since changed. Re-verify the page and re-stamp it.
Red means something did not resolve at all, or the front matter is unparseable or names the
wrong slug. **Troubleshooting** has the full list of causes.

## 9. Read a CI verdict

Two judges, and they answer different questions. Do not read one as though it were the other.

**Does the tree ship?** `oss/gen.py` refuses a bad cut. `control-plane/route-audit.mjs` fails
the build when a route vanishes from the baseline, `blob-audit.mjs` guards the blob baseline,
and the leak ceilings bite. None of these were touched by the guardrails change and none of
them cost anything at runtime.

**Does the installed system work?** `devgate/smoke.py`. It is worth understanding two things
about it before you read its output.

It **makes no calls.** It reads one JSON evidence bundle off disk -- the import list is
`copy, json, os, re, sys, traceback` and nothing else -- so every assertion is a pure function
of the bundle, a defect can be seeded into a copy of it for free, and every check is made to
fail before it is trusted.

It has **three** statuses, and NOT-EXERCISED is not green. `PASS` held. `FAIL` did not.
`NOT-EXERCISED` did not run and carries a reason; it counts as green only if its id is on the
written-down `UNEXERCISABLE` list. Anything that drops out of "exercised" without being on
that list is a **coverage regression** and exits 11. A green install is not a working system,
and the judge exists because a rehearsal once returned verdict 0 on a release whose data-lake
tools had no bucket and whose VM tools pointed at no machine.

**`pipeline/promote-gate.sh` decides whether traffic moves.** It fails closed first, and its
exit codes are named so a wrapper can tell a refusal from a breakage -- `50 REFUSED-NO-RC`
means the smoke step produced no exit code at all, i.e. it died or never ran. It also treats
the exit code and the report as **two witnesses**: a run whose report carries no `VERDICT 0`
line is refused even if the exit code said zero.

### The failure shape that fools everybody

**A report that is confidently wrong about many things at once, while a `gcloud` command
beside it describes a healthy system.** That is a permissions failure wearing a product
failure's clothes. On 2026-08-12 an evidence collector read Cloud Run through urllib, so it
read as the executor service account rather than as the approver, so every read answered 403;
a refused read became an empty service, an empty service became an empty environment map, and
the judge returned 21 FAIL findings about variables that *were* set and were read back by
`gcloud` in the same job minutes later. The collector exited 0.

Suspect the identity before you suspect the deployment. `deploy/BUILD-FROM-THE-STORE.md` has
the mechanism: inside a gated job, `gcloud` is the approving human and python, curl and gsutil
are not.

### Reading a deploy's own log lines

The git tools print which of three things happened, and they are not interchangeable:

* `[gittools] registered 7 tools` -- healthy. The number is the length of what registration
  returned, so it cannot drift from the truth.
* `[gittools] registered 0 tools` -- **withheld on purpose**, because `GIT_REPO_ID` or
  `GIT_BUCKET` is unset. Not a crash and not a deploy problem. Nothing in a fresh install
  sets either, and the installer sets them on the MCP surface only -- so on the console
  surface this line is expected.
* `[gittools] not registered: <message>` -- the real crash. Registration sits in a
  `try/catch` that only logs, so a broken require removes all seven tools while the service
  still answers 200.

Be careful how you check. A `gcloud logging read` filtered only by `service_name` and
`--freshness` matches lines from the **previous** revision too, so it can report success for a
revision that registered nothing. Filter on `resource.labels.revision_name` as well, or prove
it the way that cannot lie: make a commit through `git_propose` and read its author back with
`git_log`.

---

## Rotating the approval signing key

**Order is the whole procedure.** Widen the verifier first, move the signer second, narrow
the verifier last. There is no intermediate state that is safe: the singular must be a member
of the plural at every instant, or every signed job 403s including the one that would undo it.

1. Add the new key version to `APPROVAL_SIG_KEY_VERSIONS` on the executor, **keeping the old
   one**. The value legitimately contains commas, so use gcloud's alternate delimiter:
   `--update-env-vars "^@^APPROVAL_SIG_KEY_VERSIONS=<old>,<new>"`.
2. Read it back off the serving revision.
3. Set `APPROVAL_SIG_KEY_VERSION` to the new version on **both** the console and the MCP
   service. Missing one leaves half your jobs signed with the old key.
4. Run one real job and watch it execute.
5. Only then remove the old version from the executor's allowlist.

The value is a KMS `cryptoKeyVersion` resource name and must contain no whitespace, no comma
and no `@`.

## Turning things off

### One agent, without touching anything else

Revoke its session key. Nothing else changes.

### One strain's reach, without deleting it

Set `tool_classes` on the strain's record to the classes it should keep -- `read`, `write`,
`stage`, `infra`, `browser`.

**This bites immediately.** `install.sh` sets `PC_TOOLS_ENFORCE=1` on both services, so there
is no observe-only grace period on an installed system: the tools disappear from that role's
surface on its next connection, within the sixty-second class cache. There is no dry run.
Decide the array before you write it.

Confirm afterwards rather than before:

```
read_journal(limit 50)
```

The `tool_surface_withheld` entry names the role, the classes it now holds, and every tool
that was withheld with its class. Read it against what you intended. To widen again, remove
the array or fix it -- absent, empty or malformed means every class.

A key can also be minted narrower than its strain, at mint time, for a subagent. That
narrowing is only ever subtractive, and an unknown class name is a 400 at the moment you mint
rather than a silent drop.

### The whole install

```
bash uninstall.sh PROJECT_ID $REGION
```

**This takes no confirmation prompt and has no dry-run mode.** It prints what it is about to
do and then does it.

Without `--keep-data` it deletes the Firestore database it created -- approvals, journal,
work items, strain records, session keys. Either way it deletes five Secret Manager secrets,
one of which is the executor's credential store. **Both are irreversible.** Pass `--keep-data`
if you intend to reinstall over the same state.

It deletes a leftover workstation instance from an earlier release if one exists, and says
so before each one, because deleting an instance destroys its boot disk.

`PC_LANE` must be the same value the install was run with. It is how the script decides which
names are yours.

Read the closing report rather than the exit code. `OURS` means one of its own deletes did not
work, usually the wrong `$REGION` or a missing permission. `HELD` means kept by design --
including both buckets, which hold agent memory, the handoffs, this wiki and the git object
store, and which the script will never delete. `UNCHECKED` means the check itself failed, and
is never reported as clean.

## Things not to do

**Do not set `PC_REQUIRE_ASSERTION=1`.** It reads like hardening and it is not usable on this
build: every approval would return 428 and you would have a console that can never approve
anything, including the job that would turn it off. The installer writes `=0` for that reason.
The manual has the mechanism.

**Do not delete `APPROVAL_REQUIRE_SIGNED` in order to tighten it.** A fresh install already
has it at `1`, set last by the installer once a key exists. Deleting the variable does not
leave it required -- the executor's in-code default is `"0"`, so an absent variable means an
approval carrying **no** signature is allowed. Deleting it relaxes the check. Set it to `0`
or `1` explicitly and read the value back off the serving revision.

**Do not narrow the signer before you widen the verifier.** The single most reliable way to
brick every signed job at once.

**Do not put a `#` on a backslash-continued line.** It swallows the continuation and `bash -n`
passes it. Standalone `#` header lines are fine and the system writes them itself.

**Do not treat `gcp_api` as a read tool.** A blessed in-project GET that comes back 401 or 403
does not fail -- it escalates and stages a job. "Just checking something" can put work in the
pending queue under your name.

**Do not assume `list_pending_confirm` is scoped to the caller.** `read_job_log` is: a
principal reads the jobs it staged, and only principals named in `LOG_READ_ALL` read
everything. `list_pending_confirm` has no such filter and returns the full pending documents,
command text included, to any principal that can call it.

**Do not grant a symmetric approval key back to the executor** to make a deploy succeed.
Handing a verifier the minting key removes the property the signature exists to provide.
Remove the stale secret binding instead; **Troubleshooting** has the command.

**Do not read the plaintext mirrors.** Covered in task 4 and repeated here because it is the
failure that produces detailed, confident, weeks-out-of-date answers rather than an error.

## One-way doors

Each is called out in place above. Collected so you can recognise one before you are in it.

| Action | What does not come back |
|---|---|
| `uninstall.sh` without `--keep-data` | the Firestore database: approvals, journal, work items, strains, session keys |
| `uninstall.sh`, either way | five Secret Manager secrets, including the executor's credential store |
| Deleting either Cloud Storage bucket | agent memory and the handoffs; the git object store, which is your commit history |
| Deleting a leftover workstation instance | its boot disk |
| Overwriting the vault master | every object sealed under the old one |
| Creating a KMS keyring or key | nothing -- but neither can ever be deleted, so a wrong name is permanent |
| Disabling `allowedPolicyMemberDomains` to admit one account | the exception: the binding survives re-enabling, permanently |
| Running a command | with `PC_AUTO_APPROVE=1` it has already run as you; no undo, no second reviewer |
| Losing every account on `WA_APPROVER_EMAILS` | console access; recovery is a redeploy |

## When you are not sure

The runtime brakes are off by default, which changes what "being careful" means here. It no
longer means waiting for a refusal -- with `PC_GUARDRAILS=0` there will not be one. It means
the two habits at the top of this page: read the command before you send it, and check the
world after.

What has not changed is that the cheap checks are still cheap. A `gcloud ... describe` read
costs nothing and answers the question the log cannot. A journal read tells you what actually
happened rather than what was reported. And the way back from a bad deploy is a traffic shift
that does not need the system that broke.
