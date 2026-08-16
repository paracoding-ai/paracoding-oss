<!-- SPDX-License-Identifier: Apache-2.0 -->

# Publishing the build request

[SEC-CI-PUBLISH-IDENTITY-V1], 2026-08-11.

How an unattended dev CI cycle is started, why it is started from where it is, and
which identity carries it. This lives in git rather than in a lane file because a
design that lives only in a lane file is one the next strain re-derives.

Companion files: `publish-build-request.sh` (the implementation),
`cloudbuild-dev.yaml` (the consumer), `cloudbuild-release-check.yaml` (the second
consumer on the same topic).

---

## 1. Why the push cannot emit the build request

The message a build trigger consumes names an `archive` and a `sha256`:

    {"commit","short","archive","sha256","ref"}

`archive` is a **single-commit git bundle** of the pushed tree, and `sha256` is that
bundle's digest. Step 1 of `cloudbuild-dev.yaml` **verifies** the digest before it
will extract anything.

The bundle is produced **after** the push, by a **gated** job. `git bundle create`
is **not byte-reproducible** -- the same tree bundled twice yields different bytes.
So at push time the digest of an artifact that does not yet exist **cannot be
predicted**, and a guessed digest produces a red build whose redness says nothing
about the code. A red build that proves nothing is how a pipeline gets switched off.

This is not a limitation to route around. It is the reason the design is split.

## 2. Why bundle-publish time is the correct emission point

The bundle job is the **only actor that can tell the truth about the archive**: it
has just produced it, re-downloaded it, and hashed the bytes that are actually in
the bucket. Emitting there makes the invariant **structural** rather than a
convention:

> The only message that can fire a build is emitted by an actor that has just
> verified the archive exists and hashes to the digest it is about to name.

### Rejected alternatives, recorded so they are not relitigated

| Option | Why it was rejected |
|---|---|
| Make the bundle job ungated so it can publish freely | An unattended writer to the **prod datalake** is precisely the safety property the gate exists to protect. |
| A dev-side watcher that polls for new bundles | Replaces an event with a schedule and invents a second moving part to keep alive. |
| Build the bundle inside `git_push` and publish in one step | Minutes of latency welded onto the fleet's only write surface; Cloud Run also throttles CPU after the response, so the work cannot honestly be deferred. |
| Emit the request from `git_push` with a placeholder digest | Fires a build that dies at the digest check on every push. |

`git_push` instead emits a **ref-moved notice** -- `{"commit","short","ref"}`, no
archive, no digest -- on a **different** topic. It must be a different topic:
`fleet-dev-on-main` carries **no message filter**, so every message on its topic
starts a build, and a notice landing there would bind an empty `_ARCHIVE` and die at
`test -n "${_ARCHIVE}"` on every single push.

## 3. The message schema

    {"commit":"<40 hex>",
     "short":"<8 hex>",
     "archive":"gs://<bucket>/<prefix>/fleet-<commit>.bundle",
     "sha256":"<64 hex of that bundle>",
     "ref":"refs/heads/main"}

base64-encoded into `messages[].data`, with an `origin` attribute naming who asked.

**Verify this against the trigger, never against this file.** Read the live
definition back before trusting it:

    GET https://cloudbuild.googleapis.com/v1/projects/<dev>/triggers/fleet-dev-on-main

As read back on 2026-08-11, `fleet-dev-on-main` binds

    _COMMIT  = $(body.message.data.commit)
    _SHORT   = $(body.message.data.short)
    _ARCHIVE = $(body.message.data.archive)
    _SHA256  = $(body.message.data.sha256)

Those four keys are the contract. `ref` is carried for the reader and is bound by
nothing -- do not remove it, and do not assume anything checks it.

`BUILD_COMMIT` is derived from the **verified working tree**, never from the
message. The message proposes; the bundle proves.

### One message fires two builds

`fleet-release-check` subscribes to the **same topic**. Cloud Build gives each
trigger its own subscription, so one message fans out to both. Publishing here
starts **two** builds, not one.

> `CREATE-TRIGGERS.sh` section 4 still states that `fleet-release-check` is
> deliberately not created. That is **stale** -- the trigger exists.

## 4. The publishing identity

**Measure this; do not assume it.** A gate job has *two* identities in one shell:

| What runs | Which identity | How |
|---|---|---|
| `gcloud` | the **approving human** | `CLOUDSDK_AUTH_ACCESS_TOKEN` is set in the job environment |
| `python3` | the **gate executor's runtime service account** | no such variable; it reaches the metadata server |

This matters because `publish-build-request.sh` publishes with
`gcloud pubsub topics publish` -- so **the approving human carries that publish**,
and that identity's rights on the dev topic are **not established**. The operator's
Workspace identity is not a member of the only binding on the dev publishing service
account, and nothing in the fleet demonstrates it holds `pubsub.topics.publish` in
dev.

### The chain that is fully measured

No new IAM grant is needed, and each hop was **called**, not reasoned:

    gate executor SA
      --[roles/iam.serviceAccountTokenCreator, read off the dev SA's own IAM policy]-->
    the dev publishing service account
      --[pubsub.topics.publish, returned by testIamPermissions ON THE TOPIC]-->
    the build-request topic

So a publisher running inside a gate job should:

1. read the metadata server for its own token and email;
2. call `iamcredentials` `generateAccessToken` for the dev publishing SA;
3. publish with **that** token;
4. **print both identities** -- a publisher that does not say which identity it used
   cannot be debugged from its own transcript.

### The binding that is still missing, and it is a convenience

The narrower direct grant (`roles/pubsub.publisher` on the topic) still cannot be
set from dev: `testIamPermissions` on the topic returns `pubsub.topics.get` and
`pubsub.topics.publish` and **not** `setIamPolicy`. It belongs in
`dev-project-bootstrap.sh`, which runs as an owner. Until it is set, any dev-editor
principal can publish -- bounded by dev being dev, by the mandatory digest check,
and by the deploy being `--no-traffic`.

## 5. The `RESULT PUBLISH` contract

A publisher that dies quietly is worse than one that was never built, because the
pipeline still *looks* wired.

- **Publish only on proof.** If artifact verification did not establish its proof,
  publish nothing. Firing a build against an unverified artifact is the exact
  failure this design exists to avoid.
- **A failed publish must not flip the artifact verdict.** The bundle really was
  published and verified; saying otherwise corrupts the record.
- **But it must be loud.** Emit an explicit line and exit with a distinct code:

      RESULT PUBLISH PASS          exit 0
      RESULT PUBLISH FAIL <rc>     exit 70
      RESULT PUBLISH SKIPPED ...   exit 71   (proof was not established)

  "The publisher has been dead for a week" must be a query, not archaeology. A
  catch that only logs is forbidden by this fleet's bootstrap for exactly this
  reason: it converts a broken path into a silent one.
- **Publishing nothing is a failure.** A 200 response carrying **zero**
  `messageIds` is a failed publish, not a success.
- **Never put a comment inside a staged command.** A comment in a
  backslash-continued command truncates it, and `bash -n` does not catch it.

## 6. What the first unattended cycle actually produced

Run on 2026-08-11 against the verified `e15c0fcb` bundle. Recorded because a real
verdict is worth more than a description of one.

**Dev build** -- 5 of 6 steps green, then the gate refused:

| Step | Result |
|---|---|
| `fetch-and-verify-bundle` | SUCCESS -- provenance OK, `rev-parse HEAD` == the requested commit |
| `deploy-notraffic` | SUCCESS -- a new revision at **zero traffic** |
| `collect-evidence` | SUCCESS |
| `smoke` | SUCCESS -- **VERDICT 10 FUNCTIONAL-FAILED**, 14 PASS / 9 FAIL / 12 NOT-EXERCISED |
| `readback-and-marker` | SUCCESS -- marker carries the real verdict |
| `promote-gate` | **FAILURE, exit 51 -- REFUSED, TRAFFIC WAS NOT MOVED** |

The smoke harness additionally proved **33/33** of its checks can fail and **12/12**
of its skips cannot render as green, so the red is a verdict and not an absence.

**This is the pipeline working, not the pipeline broken.** A red judgement reached
the gate, the gate refused to move traffic, and the previously serving revision is
untouched. A revision at zero traffic has changed nothing.

The first FAIL is `F1.3.CP_CAN_READ_WRITE`: the dev control-plane service account is
missing `storage.objects.create` and `storage.objects.get` on the lake bucket, which
then cascades into the round-trip and at-rest findings.

**Release-check build** -- step 0 green (both negative controls, and a census of 174
blob / 1 commit / 44 tree), step 1 red, and **not** for the stale-tree reason that
was predicted:

    + python3 oss/gen.py --out /workspace/_cut
    source commit: unknown
    REFUSING: ['missing source: --out/control-plane/src/index.ts',
               'missing source: --out/gate-exec/exec_server.py']

`gen.py` does not accept `--out`. It read the flag itself as the **source root**
and joined its source paths onto it. The invocation in
`cloudbuild-release-check.yaml` step 1 is **wrong at head**, and `bash -n` could
never have caught it -- parsing a command is not invoking it. Fix the invocation
before reading anything into that build's colour.
