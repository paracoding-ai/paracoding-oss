# devgate

**Systems manual and operators guide for the dev gate: the pipeline that builds a
commit, judges the deployment it produced, and refuses to move traffic on anything
it could not certify.**

Rewritten 2026-08-12 at main f4733261. The previous revision described a manual
rehearsal harness driven by the `dev_api` MCP tool against a separate dev project.
`dev_api` was deleted the same night. Everything that depended on it is gone, and
this file now says so instead of describing a door that is not there.

---

## 0. STATUS -- READ THIS FIRST

| Thing | State |
|---|---|
| The automatic pipeline in the standalone dev project | **WORKS.** Untouched by the `dev_api` deletion; it never used it. |
| `smoke.py`, the judge | **WORKS.** Pure, runs anywhere python3 runs, no credentials. |
| `promote-gate.sh`, the promotion gate | **WORKS.** Six conditions, negative control runs every build. |
| Manual one-off rehearsal of a `run_cmd` body | **NO TRANSPORT.** See section 2. |
| Running the pipeline against the `dev-` lane in the production project | **NOT WIRED.** See section 6 for the list of what is missing and what each item costs. |

If you are here because a build went red, go to **section 7**. If you are here to
smoke a commit in the lane, go to **section 6** and read the whole of it before
staging anything.

---

## 1. THE TWO RULES THAT PAID FOR THIS

**A gated job must be the SECOND time a command has run, never the first.**
Five approval taps were burned in one week and every cause was discoverable in
thirty seconds somewhere cheap.

**A green install is not a working system, and the harness must say which one it
proved.** The old rehearsal returned verdict 0 with every install step green on a
release whose data-lake tools had no bucket, whose VM tools pointed at no machine,
and which named a secret nobody had created. It proved the installer RUNS. It did
not prove the installed system WORKS. That is why the judge exists and why it is
separate from the installer's own exit code.

The single most important consequence, and the reason "did it error" is not a test:
the control plane's four lake tools return a **successful** MCP tool result whose
text is `data lake not configured (DATA_LAKE_BUCKET unset)`. A smoke test that
checks for an exception, an error field or a non-2xx status goes GREEN on that.
Only comparing read-back bytes catches it.

---

## 2. THE TRANSPORT, STATED HONESTLY

There were two ways to make code run in dev. They had nothing in common and only
one of them still exists.

### 2.1 The pipeline -- ALIVE

Event driven, no agent in the loop:

    git_push moves main
      -> a ref-moved notice on one topic (no archive, no digest)
      -> a GATED job cuts a single-commit git bundle, publishes it, re-downloads it,
         re-hashes it, and only then runs pipeline/publish-build-request.sh
      -> that publishes the BUILD REQUEST on the build topic
      -> the build trigger fires pipeline/cloudbuild-dev.yaml
      -> deploy (no traffic) -> collect -> judge -> marker -> promotion gate

This never used `dev_api`. It is unaffected by the deletion and it is what actually
smokes commits today. See `pipeline/BUILD-REQUEST-PUBLISHING.md` for the message
contract and `pipeline/CI-PUBLISH-WIRING.md` for the trigger bindings. Read the
trigger back before trusting either file; both say so themselves.

### 2.2 The manual rehearsal harness -- DEAD, AND NOT REPLACED

The old way to rehearse an arbitrary `run_cmd` body was: an agent called `dev_api`,
which POSTed a one-off Cloud Build into the standalone dev project, ungated,
running as a dev service account, and read the transcript back out of the dev lake
through the same tool. That gave an agent an unattended, unapproved code-execution
path.

**`dev_api` was deleted deliberately.** In the single-project layout the lane lives
in the production project, so the same tool would have been an unaudited
cross-surface bypass: an ungated writer inside the project the gate exists to
protect. Deleting it was correct. It also means:

> **There is currently NO transport by which an agent can run an arbitrary command
> in a dev environment without a human approval.** The rehearsal harness has no
> door. `run_command` and `stage_privileged_job` are gated, which is the point of
> them, and a gated rehearsal is not a rehearsal -- it spends the tap the rehearsal
> was invented to save.

This is a gap, not a bug, and it is recorded here rather than papered over. If
cheap rehearsal is wanted back, it has to be designed: something that can execute a
proposed command in an environment that resembles the executor, without handing any
agent an ungated execution path in the production project. Nobody has built that.
Do not go looking for the old tool.

What survives from the old harness and is still true is in **section 8** -- the
failure classes it found. Those cost real taps and they are still the things that
bite.

---

## 3. THE PIECES

| File | What it is |
|---|---|
| `pipeline/cloudbuild-dev.yaml` | The build. Eight steps. Every project, bucket and service name is a substitution. |
| `pipeline/collect-evidence.py` | **Reads only.** Produces `evidence.json`. Every cloud call lives here and nowhere else. |
| `devgate/smoke.py` | **The judge. Pure.** Reads `evidence.json`, writes `smoke-report.txt`, exits 0/10/11/12. No network, no filesystem beyond those two paths. |
| `pipeline/promote-gate.sh` | Moves traffic, or refuses. Driven entirely by files on disk, so every path is runnable on a laptop. |
| `pipeline/publish-build-request.sh` | Publishes the build request after proving the bundle exists and hashes correctly. |

The split is the whole design:

    collect()   ONLY cloud reads     ->  evidence.json
    judge(ev)   ONLY pure functions  ->  [Finding]
    selftest()  seeds a defect per assertion and requires the verdict to flip

Because `judge()` is pure, `selftest()` can seed a defect into a deep copy of the
evidence for **every** assertion and prove that assertion bites -- in memory,
mutating nothing, at zero cost. A defect-seeding regime that has to break a real
deployment gets run once and quietly dropped. One that is free runs every time.

It also solves the installer's `die()` problem: `die()` exits, so only one step
failure is obtainable per run. The judge runs after the process has exited, over a
static bundle, so it reports ALL of its findings instead of stopping at the first.

---

## 4. WHAT THE JUDGE ASSERTS

Groups, not a full list -- the report names every finding it reached.

    F0   the readback is off the revision the deploy JUST created, never the
         serving one and never the install log
    F1   lake round trip AND encryption at rest. Bytes are compared; the stored
         size is compared against the plaintext size; pcv1 metadata is required
    F2   every registered tool is classified and its backing resource exists;
         POST /mcp answers exactly 401 with an RFC 9728 challenge naming this
         server's own metadata URL
    F3   every env var the code reads with no fallback is set on the NEW revision,
         on BOTH surfaces, and no var is set that nothing reads
    F4   the Firestore indexes the code queries actually exist
    F5   the approval key exists, is asymmetric, and the VERIFIER CANNOT SIGN
    F6   the two-surface split: console behind IAP, MCP not behind IAP, each
         judged against what IT is supposed to be
    F7   the route table matches the committed baseline, cross-checked against the
         JS scanner's own emission rather than a python port nobody diffed

### The three statuses

    PASS            asserted or exercised, and it held
    FAIL            asserted, and it did not hold
    NOT-EXERCISED   did not run. Carries a reason. IT IS NOT GREEN.

A NOT-EXERCISED finding is compatible with exit 0 **only if its id is on the
reviewed `UNEXERCISABLE` list inside `smoke.py`**, and every entry's text is
reprinted verbatim in the report so the confession travels with the result.
Anything that drops out of "exercised" and is not on that list is a **coverage
regression** and exits 11. The harness cannot quietly stop testing something.

Each finding also declares **EXERCISED** (a real call was made against the
installed system) or **ASSERTED** (the backing resource was proven to exist because
the real call is unsafe or needs a human). The census lists both sets by name.
These are never blurred, because blurring them is what happened the first time.

### Exit codes

Install phase, unchanged:

    3   STEP-GENUINELY-FAILED       an installer step died
    0   COMPLETE-NEEDS-HUMAN-AT-9   reached the boundary AND every exercisable
                                    functional assertion passed
    4   STOP-NOT-HONOURED           the installer ran past the boundary

Functional phase, deliberately outside that range:

    10  FUNCTIONAL-FAILED           the installed system does not do its job
    11  FUNCTIONAL-COVERAGE-LOST    an assertion did not run and is not on the
                                    reviewed list, OR the selftest found a check
                                    that cannot fail
    12  FUNCTIONAL-EVIDENCE-MISSING collect() could not gather an input

**0 now means both things**: the script exited 0 AND the thing it installed answers.

---

## 5. RUNNING IT IN THE STANDALONE DEV PROJECT (works today)

You do not run the build by hand. You cause a build request to be published.

1. Land the commit on `main`.
2. Stage the bundle-publish job. It cuts the single-commit bundle, uploads it,
   **re-downloads it and re-derives the digest from the bytes in the bucket**, then
   runs `pipeline/publish-build-request.sh <40-hex-commit>`. Do not shortcut the
   re-download; a guessed digest is a red build that proves nothing.
3. One publish fires TWO builds -- the dev build and the release check subscribe to
   the same topic.
4. Watch the dev build. Artifacts land in the dev bucket under `devgate/` and the
   marker under `devbuilt/<commit>.json`, all published unconditionally before the
   step that writes them can die.

To judge a bundle you already have, with no cloud at all:

    SMOKE_EVIDENCE=/path/evidence.json \
    SMOKE_REPORT=/path/smoke-report.txt \
    SMOKE_INSTALL_EXIT=20 \
    python3 devgate/smoke.py ; echo "SMOKE EXIT $?"

That is the entire judge. It needs no credentials and no network. Use it to
re-judge an old bundle after changing an assertion.

To prove the collector's MCP/SSE parser still discriminates, also with no cloud:

    python3 pipeline/collect-evidence.py --selftest ; echo "SELFTEST EXIT $?"

Exit 3 means a control failed and no MCP field in any bundle may be believed.

---

## 6. RUNNING IT AGAINST THE `dev-` LANE -- WHAT IS MISSING

The lane is `paracoding-dev-control-plane`, `paracoding-dev-mcp` and
`paracoding-dev-gate-exec`, installed by `install.sh` with `PC_LANE=dev` into the
production project, with its own Firestore database, its own lake bucket and its
own KMS keyring. Set these once and use the variables; every command below reads
them:

    PC_LANE_PROJECT=your-prod-project
    PC_LANE_RGN=us-east1
    PC_LANE_CP=paracoding-dev-control-plane
    PC_LANE_MC=paracoding-dev-mcp
    PC_LANE_GX=paracoding-dev-gate-exec
    PC_LANE_LAKE="$PC_LANE_PROJECT-dev-datalake"

**The harness is now lane-ADDRESSABLE. It is not yet lane-REACHABLE.** Those are
different claims and only the first one is done. Addressable means no project,
bucket, service, database or key is assumed any more -- every one is a flag or a
substitution, defaulting to what it has always been. Reachable means there is
something that actually runs the collector and the judge against the lane. There
is not.

### 6.1 The prerequisites, each with what it costs

**P1. A build config runner in the lane's project.** The dev build runs in the
standalone dev project under that project's build identity. Nothing equivalent
exists in the production project, and the existing trigger cannot reach across.
Either a trigger there subscribing to a lane topic, or a hand-submitted build.
Cost: one trigger plus one topic, or one submit per run. Half a day with the IAM.

**P2. `logsBucket` in `cloudbuild-dev.yaml` is the one line that is still a
literal.** It is deliberately not a substitution: whether Cloud Build expands
substitutions in that field is UNVERIFIED, and turning a working pipeline red to
find out is the wrong trade. A lane build must override it at submit time or carry
a one-line variant. Cost: minutes, once someone has checked the field.

**P3. A smoke identity in the lane.** The collect step impersonates
`pc-devgate-smoke@<project>` and needs a matching ACTIVE strains document whose
`sa_email` is that account, in the LANE's Firestore database. Without it
`PC_SMOKE_ID_TOKEN` is left unset ON PURPOSE -- the pipeline refuses to substitute
the builder's own token -- and F1.4, F1.5 and F2.2 stay red and honest. Override
with `_SMOKE_SA`. Cost: one service account, one binding, one Firestore document.

**P4. The second surface must be NAMED or smoke is red.** `install.sh` sets
`PC_SURFACE=console` on the console service of every two-service install. The judge
derives "is this a split" from the evidence, not from a flag, so a bundle carrying
`PC_SURFACE=console` and no second surface is **half a split** and F6.0 FAILS. It
does not skip. Pass `_MC_SVC` (which becomes `--mcp-service`) or accept a red F6.
Cost: one substitution -- but see 6.2, because naming it is necessary and not
sufficient.

**P5. IAP will not be toggled in the lane's project, and that is now enforced.**
The collector used to disable IAP on the target service around its probes, fenced
by nothing but a comment saying "DEV ONLY. Never prod." In a shared project that
comment is not a fence. The toggle is now restricted to
`--iap-toggle-projects`, which defaults to the standalone dev project, so in the
lane it does not happen and the bundle records why. The probes then run with IAP in
front and are judged on what they actually saw.

**P6. The lane's own key, bucket and database are discovered, not assumed.** The
collector reads `PC_FIRESTORE_DB` and `DATA_LAKE_BUCKET` off the deployed revision,
and now derives the KMS key from `APPROVAL_SIG_KEY_VERSION` when that variable
carries a full resource path. `--lake` exists for the case where
`DATA_LAKE_BUCKET` is absent, because the old fallback -- `<project>-datalake` --
names the NEIGHBOURING lane in a shared project and would have reported a healthy
read of a bucket this deployment does not own.

### 6.2 The thing that will still be red, and why it should be

In an organization with domain-restricted sharing, `allUsers` cannot hold
`roles/run.invoker`. The MCP surface in the lane will therefore refuse every
anonymous caller at the Cloud Run frontend. `smoke.py` will excuse that ONLY if the
evidence bundle carries the org-policy refusal text, and a read-only collector
cannot honestly produce one -- the refusal is generated by ATTEMPTING the binding,
which is a write. So F6.3, F6.4, F6.6 and F6.7 fail.

**Do not fix this by inferring the refusal from an org-policy read.** That converts
a FAIL into a NOT-EXERCISED for a transport that genuinely nobody can reach, which
is a bought green. The correct fix is that the INSTALLER records its own refusal --
it already sees it, and already prints a warning about it -- into somewhere the
bundle can carry. Cost: one line in the installer, one field in the collector, and
a review of whether an unreachable MCP surface is acceptable in the lane at all.

### 6.3 What you actually run once P1-P4 exist

    python3 pipeline/collect-evidence.py \
      --project "$PC_LANE_PROJECT" --region "$PC_LANE_RGN" \
      --service "$PC_LANE_CP" --gate-exec "$PC_LANE_GX" \
      --mcp-service "$PC_LANE_MC" --lake "$PC_LANE_LAKE" \
      --tree /workspace/work --tag "c<first 8 of the commit>" \
      --out /workspace/evidence.json

    SMOKE_EVIDENCE=/workspace/evidence.json \
    SMOKE_REPORT=/workspace/smoke-report.txt \
    SMOKE_INSTALL_EXIT=20 python3 devgate/smoke.py ; echo "SMOKE EXIT $?"

    SVC="$PC_LANE_CP" REGION="$PC_LANE_RGN" PROJECT="$PC_LANE_PROJECT" \
      WORK=/workspace bash pipeline/promote-gate.sh ; echo "GATE EXIT $?"

No `--iap-toggle-projects` is passed, so the toggle is fenced off. `--firestore-db`
and `--keyring` are not passed either: both are read off the deployed revision.
Pass them only if the revision does not carry them, and check the bundle's
`kms_key_channel` and `gitvault_bucket_channel` fields to see which source was used.

---

## 7. READING THE OUTPUT AT 2AM

### The report, top to bottom

1. The header: `BUILD_COMMIT:` -- **check it is the commit you think you are
   judging** before reading anything else. A stale bundle is the most common way to
   read a green that means nothing.
2. The finding list. `[FAIL ]` lines carry the reason inline.
3. The selftest census: `N/N proved they can fail`. If N is smaller than the total,
   a control went vacuous and the report says which.
4. The skip-proof census: `M/M skipped assertion(s) proved they cannot render as
   green`. A `HOLE` here pins exit 11 permanently and is not negotiable.
5. `CENSUS -- NOT-EXERCISED IS NOT GREEN`, then `VERDICT <n>`.

**Read the census before the verdict.** A verdict of 0 with three NOT-EXERCISED
findings is a real result, but it is a NARROWER result than it looks, and the
census is the only place that narrowness is written down.

### The promotion gate's exit codes

    0   PROMOTED             traffic moved, and the move was CONFIRMED BY RE-READ
    50  REFUSED-NO-RC        the smoke step produced no exit code
    51  REFUSED-NOT-ZERO     smoke exited non-zero
    52  REFUSED-NO-REPORT    no report, or an empty one
    53  REFUSED-VERDICT      the report does not say VERDICT 0
    54  REFUSED-CENSUS       the report contradicts itself
    55  REFUSED-STALE        the report is for a different commit than this build
    56  PROMOTE-FAILED       the gate said yes and the traffic move failed
    57  PROMOTE-UNCONFIRMED  the move reported success and the re-read disagrees
    61  REFUSED-COUPLING     the gate can no longer read its own inputs
    63  REFUSED-NO-TARGET    the gate could not identify which revision it judged

    58/59/60 are the YAML step's own codes (gate file missing, does not parse,
    negative control did not refuse). 62 is the collector selftest's.

**61 is the one people misread.** It does not mean the build is bad. It means a
literal this gate scrapes out of the report has disappeared from the judge that
emits it -- a rename in `smoke.py` that would otherwise have degraded a `grep` into
a silent no-op and let a dead check promote itself. The message names the missing
string. Fix the coupling; do not delete the check.

**The gate proves it can still refuse on every build.** Before it looks at the real
artifacts it runs itself over a scratch fixture holding a red verdict and requires
exit EXACTLY 51. Not merely non-zero -- a stub returning 1 is also non-zero, and a
gate that refuses everything is a different broken, not a working one.

---

## 8. WHAT IT DOES NOT CATCH, AND WHAT HAS COST US

### Not caught

- **Production-only IAM.** The build identity is not the executor's runtime service
  account and is not the approving human. An IAM-propagation poll goes green
  instantly wherever the runner already has access -- it exercises the code path, it
  does not prove a grant propagates.
- **The real approval path.** No signature is produced or verified end to end. F5's
  round trip is declared and then skipped, in the judge's own words.
- **Real state.** No job documents, no journal history, no `pcv1` metadata on
  objects anyone else wrote.
- **The executor's hard timeout.** A build gets far longer than a staged job does.
  Do not size an approval window from a build's runtime.

### Failure classes that have each cost a tap

- **A `tee` pipeline produced a ZERO-BYTE log and a SUCCESS build in five seconds.**
  Redirect a shell FUNCTION as a whole; never read `$?` after a pipeline.

      run_all() { bash /workspace/run.sh; }
      run_all > /workspace/probe.log 2>&1

- **A job whose phase failed exited 0.** Capturing a return code is not propagating
  it: the script stored the failure in a variable and then ran more commands whose
  status became the script's status. Catch `$?` on the trap's FIRST line, keep a
  distinct code for "revoke failed" so a leaked privilege is never reported as the
  same outcome as a failed migration, and print the components.

- **Conditional IAM bindings change gcloud's behaviour.** Against a policy that
  contains any condition, gcloud refuses BOTH add and remove non-interactively
  unless `--condition=None` is passed. Fixing only the grant is not a fix: the
  revoke sits on an EXIT trap and fails on the identical error, so a half-fixed job
  opens a privilege window its own trap cannot close.

- **A comment inside a backslash-continued command truncates it** and the remainder
  runs as a separate command. `bash -n` does not catch it. Staged commands carry no
  comments at all.

- **`POST /mcp` answers `text/event-stream`.** A bare `json.loads` yielded the empty
  string, so `sha_read` became the sha256 of nothing and a write check became
  vacuously true over `''`. The collector's parser now handles both encodings and
  `--selftest` proves both directions, including that the OLD predicate accepted
  exactly what the new one refuses.

- **A python port of a JS scanner drifted and nobody diffed it.** The route table is
  now emitted by the JS scanner as a file and cross-checked by machine.

---

## 9. RULES FOR CHANGING ANY OF THIS

1. **A change that weakens an assertion is worse than no change.** If you touch an
   assertion, break it deliberately and show it still bites. The selftest is where
   that proof lives.
2. **Never make an unmeasured thing render as green.** NOT-EXERCISED is a status,
   not a pass, and the reviewed list is the only place an unexercised assertion may
   be excused. Adding an id to that list is a decision with a written reason.
3. **The judge stays pure.** No network, no filesystem beyond the two environment
   paths, no clock. Everything that touches cloud belongs in the collector.
4. **Keep the gate's coupling list in lockstep with its scrapes.** A scrape with no
   entry in `COUPLED_LITERALS` is exactly the unguarded coupling that once refused a
   perfectly green build on its own typo.
5. **The right end state for that coupling is a machine-readable census** -- one
   `SELFTEST_PROVED <n> <total>` line or a JSON sidecar -- after which the scrapes
   and the literal list are deleted together.
6. **The repository is leak-ratcheted.** Adding a project id, a bucket name, a
   region literal in a command, a bare 40-hex oid or an internal lake path to any
   file in this repository can push a category over its ceiling and refuse the next
   release cut. Several categories currently sit AT their ceiling. Put topology in a
   variable, reference the variable, and re-run the scan before proposing.
7. **New python in the gate-exec image must be added to `GX_ENV_SOURCES`** in the
   collector, or F3.2 invents a false "set but never read" finding for every
   variable that file introduces. A harness that INVENTS a finding costs more than
   one that misses a finding, because it teaches its readers to delete things.
