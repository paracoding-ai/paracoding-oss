---
page: the-gate
title: Authorisation -- how work is allowed to run
section: start
status: live
audience: public
owner: unassigned
generated_by: starter-edition
verified_at: "2026-08-14"
verified_by: starter-edition
watch:
  - "lake:shared/wiki/_release.txt@71b8aebd9209c5b60ca8ccc1ef4bb906ec2a7a5e39d77743e915866794b5d323"
---

# Authorisation -- how work is allowed to run

This page is still called `the-gate`, and that is a routing fact rather than a description:
the slug is the key the wiki route's allow-list is written against, so renaming it would
take the page off the air. What the page describes has changed completely, and the change
is the first thing you need to know.

**There is no approval queue for shell work and there is no per-job tap.** The `/gate`
route, the document behind it, `GET /jobs` and `GET /pastes` are deleted; measured against
a running build, all three answer 404. An anonymous request to `/harness`, `/wiki`,
`/flow`, `/chat`, `/lakeview` or `/flowhood` gets a 401 with the locked page served **in
place**, at the URL you asked for -- no redirect, no `?next=`. `GET /` is a 302 to
`/harness`.

On a fresh install nothing waits for a human tap. That is deliberate, and the rest of this
page is what authorises work instead.

## What authorises a job now

Four things, in this order, and none of them is a tap.

**The operator's instruction.** The decision is made when you say what you want, in chat,
and the agent is the mechanism that carries it out rather than a party asking permission.
The ruling that produced this posture, verbatim, so you can disagree with it on purpose:
*"we don't add speed bumps we add accelerators"*, and *"there is no gate going forward for
a job to show up in for me to approve because nothing needs approved its all coming from me
the chat is just my hands."* If you do not run this way -- if the person issuing the
instruction is not the person who owns the project -- see **Turning the refusals back on**
below, because that is the switch built for you.

**The identity holding the chat.** An agent reaches the control plane over the MCP surface
carrying a key bound to a named role. Every staged job records `staged_by`, and that name
governs what can be read back afterwards: a principal reads the jobs **it** staged, and only
principals named in `LOG_READ_ALL` -- default `fleet-advisor` -- read everything. A denied
read says so and names `staged_by`; it is not a missing job.

**IAM, and specifically the executor's own service account.** This is the real ceiling and
it deserves more attention than it used to get, because with the tap gone it is doing work
the tap used to appear to do. When a job auto-runs there is no human in the path, so the
control plane forwards an **empty** access token and the executor runs the body under its
own scoped identity rather than borrowing a live human's credential. What an auto-run job
can do to your project is therefore exactly what that service account is granted and no
more. If you want a narrower blast radius, that grant is the lever -- not a confirmation
prompt.

**The signed approval, which is now provenance rather than permission.** Nothing was
bypassed to remove the tap: the control plane stamps a **real** pre-approval into the same
Firestore fields the legacy approve route writes, signs it with the same Cloud KMS
asymmetric key under the same `PC-APPROVAL-CANON-V2` bytes, and the executor verifies it
exactly as it verifies a human's. The approver field inside the *signed* bytes reads
`auto:lockout-check`, because there is no person in that path and a transcript must never
be readable as someone having approved when nobody did. The signature no longer answers
"may I" -- it answers "did this come from the control plane's key, for this job id, over
this command and these arguments", which is a question worth keeping.

## The two doors in front of the console

The authentication root moved from a per-job tap to the account behind the console login,
so it is worth stating what that account has to get past.

**Identity-Aware Proxy**, in front of the console service, authenticating a Google account.
Signing in to that account at IAP's prompt is the only sign-in there is. The posture this
fleet runs is an account carrying a hardware security key (Titan), plus the organization
policy `constraints/iam.allowedPolicyMemberDomains`, which makes
granting an out-of-domain account *impossible* rather than merely discouraged -- the grant
is refused at the moment it is written. Measured: adding a consumer Gmail address returned
`FAILED_PRECONDITION`, "not in permitted organization".

**The caveat travels with that claim and must never be dropped from it.** The constraint is
enforced when a binding is WRITTEN, not retroactively. Disabling the policy, adding the
account and re-enabling it *does* work, and the exception it creates is permanent. So the
recommendation for a second pair of hands is a second **in-domain** account with its own
key, not a personal address let in through a temporary hole.

**Then the approver allow-list.** A fresh install seeds `WA_APPROVER_EMAILS` with the
installing account, and the application's own check is satisfied by a verified IAP identity
on that list -- the control plane verifies the assertion IAP attaches against Google's
published keys and its own audience (`PC_IAP_AUD`) on every request, and never trusts the
bare identity header. There is no enrolment and no credential of the console's own to
register. The one thing the console issues is a session cookie, `gate_session`, signed under
`WA_SESSION_SECRET` and honoured for `WA_SESSION_MIN` minutes (`install.sh` writes 240, four
hours); a missing or short secret means no session is ever issued or accepted, so the gate
fails closed rather than open. An anonymous caller, who carries no IAP identity at all, gets
the 401 with the locked document served in place, at the URL asked for.

## What is refused at runtime: by default, nothing

Two deploy-time variables carry the current posture, and they are separate on purpose.

| Variable | In-code default | What `install.sh` writes | What it decides |
|---|---|---|---|
| `PC_AUTO_APPROVE` | `0` | `1` | whether a staged job is stamped with a real pre-approval and fired in the same breath instead of waiting for a person |
| `PC_GUARDRAILS` | `0` | `0` | whether runtime **refusals** exist at all -- the destructive-command refusal in the control plane and the lockout-class refusal in the executor |

Both are read from the environment, so both are a Cloud Run configuration revision and
**neither can be flipped by a job.** That matters in both directions: an agent cannot arm
them, and the undo stays available in the state where no job could be approved. One name,
`PC_GUARDRAILS`, is read by the control plane *and* by `gate-exec/exec_server.py`, so there
is one thing to flip and one thing to document rather than a flag per brake.

With the shipped defaults, a destructive command runs and a lockout-class change runs. Both
are journalled. Detection is not friction, and the record is what makes rolling forward
possible: knowing which rule matched is exactly what makes *"we figure it out in chat"*
possible after the fact.

### Turning the refusals back on

Both variables are read with a shell default, so they are set on the command line at install
time:

```
PC_GUARDRAILS=1 ./install.sh                          # refusals back
PC_AUTO_APPROVE=0 PC_GUARDRAILS=1 ./install.sh        # the older system entire
```

`PC_GUARDRAILS=1` restores exactly three behaviours, and it is worth being precise about
which:

- **The destructive-command refusal in the control plane.** A command matching the
  destructive classifier is not run and not queued; the answer comes back as
  `NEEDS YOUR OK — NOT RUN, NOT QUEUED.` and you re-issue with `confirm=true` if you want
  it. The verdict is re-derived from the command text rather than trusted from the caller.
- **The lockout-class 403 in the executor.** A body matching one of the nine rules is
  refused with the rule ids, `NEEDS YOUR OK — REFUSED BY THE LOCKOUT CHECK, NOT RUN.`, and
  the refusal happens **before** the approval is consumed, so a refused job costs nothing
  and the same approval can be presented again once the cause is fixed.
- **Failing closed when the checker itself cannot run.** With the guardrails off, an import
  error in the lockout checker is journalled and the job continues; with them on, it is a
  403.

`PC_AUTO_APPROVE=0` is the separate, larger change: every privileged action stops at
`pending` and stays there. Nothing comes along and runs it -- not a timer, not a retry. Be
clear about what that buys and what it does not: it is a **stop**, not a tap. No console
page fires a pending job, and the approval routes that remain are an API surface rather than
something you can go and click. **Operators guide** covers the legacy posture end to end if
what you want is the older per-job approval.

WHY THE DEFAULT IS THIS WAY ROUND, stated so you can weigh it rather than inherit it: a tap
that arrives forty times an hour stops being read, and an approval nobody reads writes
`human_approved: true` for something nobody looked at. That is a FALSE record, not merely a
weak one. If your operation is one where each action genuinely gets read, set the variables
and get a real control back.

## What is still refused, with the guardrails off

The distinction that makes this posture defensible is between checks that ask **DOES THIS DO
WHAT IT SAYS** and refusals that ask **MAY I**. Only the second kind went. Everything below
still bites on a default install.

**In the executor, on every job.** The service refuses to serve at all unless
`PC_EXEC_BUCKET` is set and `APPROVAL_REQUIRE_SIGNED=1` -- an arming gate, 503, naming the
variable, because carrying approval fields in a request body is safe exactly when the
signature covers them. Then, in a fixed order: the sha256 of the presented script must equal
the approved command's; `approved_sha256`, stamped at approval time, must still match the
live command; the KMS approval signature must verify; the signed `approval_sig_iat` must be
within `EXEC_APPROVAL_MAX_AGE_SECONDS` (default 3600) so an approval is not a standing
authorisation; and the single-use claim -- an atomic object create in `PC_EXEC_BUCKET` --
must succeed. Everything above the claim consumes nothing, so a refused substitution attempt
cannot burn a real approval. The systems manual carries the full rung table.

**At staging, a secret-destroying job is refused outright.** Five patterns match a Secret
Manager delete, destroy or disable; if none of the job's live lines also invokes the destroy
preflight, nothing is staged, no approval is spent and nothing is fired. This one is
deliberately **not** governed by `PC_GUARDRAILS`, and the reason is measured rather than
philosophical: it refuses at stage time and destroys nothing, and the failure it prevents is
an outage this fleet actually had on 2026-08-10, about seventy minutes after the change, at
the first cold start -- a `secretKeyRef` mount is a hard boot dependency resolved by the
platform, so "no code reads the variable" is not "safe to delete".

**Every pre-ship check is untouched.** `oss/gen.py` still refuses a bad cut,
`control-plane/route-audit.mjs` and `blob-audit.mjs` still fail the build, the leak ceilings
still bite, `devgate/smoke.py` still judges, and the compare-and-swap on `git_push` is
unchanged. Checks that fail a CUT stayed. Refusals that stop a RUN went.

**The binary boundary is the filesystem, and it used to be nothing.** Until v8.2 this was a
first-token-per-line text scan, observe-only, that journalled a non-listed binary and ran it
anyway -- `gsutil` is on record doing exactly that. It could not be armed: every real staged
job opens with `set -uo pipefail`, so the first token is `set`, and enforcing it returned 400
and broke production.

It is now a **PATH jail**. The executor runs your script with `PATH` pointing at a directory
holding symlinks to an enumerated set of binaries and nothing else, so an unlisted binary does
not resolve at all -- `gsutil` and `ssh` answer `command not found`. Shell **builtins and
keywords do not resolve through PATH**, which is why `set -uo pipefail`, `if`, `for` and
variable assignment are untouched: the failure that killed the previous attempt cannot recur.
Command substitution, pipes and `xargs` all resolve through PATH too, so they are covered
rather than evaded.

**The gap, stated plainly: an absolute path still runs.** `/usr/bin/env` was measured doing so.
This raises the floor from "no boundary at all" to "an enumerated set, unless the script names
a full path"; it is a real control and it is not a sandbox. Closing it needs an execution-layer
change -- an image containing only the permitted binaries, or a container/seccomp boundary.
`EXEC_BINARY_ALLOWLIST_ENFORCE` is **deleted**, not defaulted off, because a switch whose
effect is "400 on every multi-line job" is a footgun aimed at production. Disable the jail with
`EXEC_BIN_JAIL=0` if an install needs a binary the list does not name.

## The lockout class, and what it still means with refusals off

`deploy/LOCKOUT-CLASS.md` names nine categories of change that **destroy the way back in**,
and they remain the most useful list in this system even now that matching one does not stop
anything. As a concept the class is not about danger in general -- it has no opinion about
whether a command is a good idea -- it is about recoverability. Everything in it can leave
you unable to reach the console that would let you undo it.

The nine, as rule ids you will see in the journal: `LC1` console service rename (renaming it
changes the console hostname, which is the IAP audience the control plane checks -- so it
takes out the way in), `LC2` the
MCP service name and its domain mapping, `LC3` the OAuth config, `LC4` the auth-path
secrets, `LC5` the approval KMS keyrings, `LC6` the signer's own code and config, `LC7`
`PC_REQUIRE_ASSERTION`, `LC8` writes to the identity collections, `LC9`
`--set-env-vars`/`--set-secrets` against an auth surface.

`gate-exec/lockout_check.py` still runs pre-execute on every job body, and it runs at the
one position where the command is fully resolved, pinned and signature-verified but nothing
has been spent yet. What changed is only the answer. With `PC_GUARDRAILS=0` a match is
journalled under its own action, `exec_lockout_class_ran`, naming the rules -- *"so the
transcript can answer 'what took the console out' without anyone guessing"* -- and the job
runs. `read_journal` is where you read that back.

**The accepted cost, stated rather than hedged.** A lockout-class change can take the
console's own authentication out. The recovery path is Cloud Shell, which the operator
holds and has used. Breakage is the accepted cost and rolling forward is the accepted cure.
If that trade is not yours to make, `PC_GUARDRAILS=1` is the answer and this section
describes what it gives you back.

**Run the checker yourself, before you ask for something.** It is the cheapest way to find
out whether what you are about to do is recoverable:

```
python3 gate-exec/lockout_check.py --self-test
python3 gate-exec/lockout_check.py --body 'gcloud run services update ...'
```

Exit `0` means clean, `51` means at least one rule matched and prints the rule ids, `2`
means no body was supplied, and `3` means the self-test itself failed -- in which case trust
nothing the file says until it passes. The self-test drives fifteen seeded bodies through
the same entrypoint the executor calls: nine that must be refused **by rule id**, and six
ordinary deploy-shaped bodies that must pass. Asserting the rule id rather than merely "it
refused" is what catches a rule that has stopped being able to fail.

**Configure it for your install.** The checker takes your service, secret and key names from
the environment rather than hardcoding anyone's: `PC_LOCKOUT_CP_SVC`, `PC_LOCKOUT_MC_SVC`,
`PC_LOCKOUT_SERVICES`, `PC_LOCKOUT_SECRETS`, `PC_LOCKOUT_KEYRINGS`. The verb-based rules
work with no configuration at all; the rules that must know which service names are
legitimate refuse rather than pass quietly when the list is unset.

**There is one override, and it is signed.** `lockout_ack: true` rides **inside** the job's
`arguments`, which is covered by `asha`, field five of the approval canon -- so adding or
flipping it in transit changes the canonical arguments hash and the signature verified above
it fails. A header, a query parameter or a top-level body field would all have been forgeable
by whoever could reach the endpoint. With `PC_GUARDRAILS=1` that ack is what lets an
acknowledged lockout-class job through, journalled as `exec_lockout_acked` so "a human said
yes to a lockout-class change" can never be confused in the transcript with "the checker
found nothing".

## What auto-runs, and this is the part to know at 2am

`run_command`, `stage_privileged_job`, every `gcp_api` mutation and `run_roll` all go through
the same auto-run path: with `PC_AUTO_APPROVE=1` the job is stamped, signed and fired in the
call that staged it, and the result comes straight back. Two things still stop at `pending`
on a stock install: a staged job that carries no command text for the executor to run, and
-- with `PC_GUARDRAILS=1` -- a destructive body, which is handed back to you in chat instead.
Those return `STAGED ... job <id>`, or `{ "mode": "staged", "job_id": "..." }`.

So the most useful thing to read in a tool result is the first word. **`RAN` means it
happened. `STAGED` means it did not.** If you read `STAGED` and walk away believing the work
is done, nothing will tell you otherwise until you check the world.

Note also that `gcp_api` escalates: a GET on a small blessed set of in-project endpoints runs
instantly as the control plane's own service account, and if that comes back 401 or 403 it
stages a gated job rather than failing. Calling it "just to read something" can put a real
job in the queue.

## A job that did wait

A job that stopped at `pending` -- because `PC_AUTO_APPROVE` is off, or because it carried
nothing the executor could run -- sits there. Nothing comes along and runs it: there is no
timer, no retry, no approval route and no console page that fires a pending job. Read the
pile with `list_pending_confirm`, read one job's outcome afterwards with `read_job_log`, and
retire a proposal you no longer want with `POST /api/jobs/supersede`, which records who did
it and why. Nothing else retires it: a job that stopped at `pending` stays there until you do.

If what you staged should have run, the fix is the switch, not a queue: set
`PC_AUTO_APPROVE=1` on both services, or run the command yourself from Cloud Shell.

**Nothing supersedes automatically.** Every staged job stays listed until it is superseded
on purpose. An earlier automatic supersede -- which retired every
pending job that was not the newest of its `staged_by` + `command_type` key, at the moment
the list was read -- is deleted.

## Reading the result

After execution the agent reads the outcome with `read_job_log(job_id)`. It gets status, exit
code, a stdout tail and a stderr tail, plus the reason fields if a control fired. Read
`status` first -- `executed` is the only value that means the command ran -- then `reason`,
then `exec_http`, and only then `exit_code`. A refusal is not a malfunction; do not re-stage
blindly.

## What this does not stop

Say it plainly, because the credibility of what remains depends on knowing its edges.

- **Nothing reviews intent.** There is no second reader, and with the guardrails off there is
  no second question either. The instruction you give is the authorisation, so an instruction
  you did not mean is a change you did not mean.
- **An agent that is talked into something is not stopped by the mechanism any more.** The
  older design's strongest claim was that an agent which must ask cannot be talked into
  acting by a clever prompt or a poisoned document, because the refusal lived in the
  mechanism rather than in the model's judgement. That claim is FALSE on a default install
  today and it would be dishonest to leave it standing. What bounds the damage instead is
  IAM on the executor's service account, the signed-approval chain, and the fact that a
  compromised agent still cannot mint an approval. If prompt injection is in your threat
  model, `PC_GUARDRAILS=1` plus `PC_AUTO_APPROVE=0` is the configuration that answers it.
- **The lockout checker matches SHAPES**, not intent -- a service-rename shape, a
  secret-destroy shape, an env-clobber shape. Even with refusals on it is a floor, not a
  reviewer, and it protects the way back in rather than the outcome.
- **Non-privileged tools were never gated.** Reading your lake, writing agent memory, posting
  work items, editing files in the lake -- these do not stage. The boundary is around
  execution and infrastructure mutation, not around reading.
- **A corrupted approval record is possible; a forged one is not.** Something with Firestore
  access can break an approval. It cannot make one the executor accepts, because the signing
  key is not in Firestore -- the control plane can sign, the executor can only verify.
- **The executor is not addressable from the internet.** It has no public invoker binding;
  the installer grants `roles/run.invoker` on it to the control plane's service account and
  to nothing else.
- **A job can fail having already changed your project.** The command runs as one bash file
  and not with `-e`, so a failure in the middle does not stop the rest and the exit code is
  the exit code of the *last* thing. Check the world before you re-run.

## Adding a second operator

There is no credential to enrol. Console access is a Google identity that IAP admits and
that appears on `WA_APPROVER_EMAILS`, so adding a second pair of hands is two grants: put the
account on the console service's IAP binding, and add its address to `WA_APPROVER_EMAILS` on
both services. Both are Cloud Run configuration, so it is a revision rather than a job.

Make it a second **in-domain** account with its own hardware key, for the reason in **The two
doors** above: the domain constraint is enforced when a binding is written, and the temporary
hole you open to admit a personal address does not close again.

Do this before you need it. The console fails closed with nobody on the allow-list, there is
no console path around that, and recovery from zero is a redeploy rather than a documented
happy path.

Keep at least two accounts able to reach the console. Treat that as an operating requirement,
not advice.
