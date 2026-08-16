<!-- SPDX-License-Identifier: Apache-2.0 -->

# Wiring the build-request publish into the bundle job

[SEC-CI-PUBLISH-WIRE-V1], 2026-08-11.

This file completes `BUILD-REQUEST-PUBLISHING.md`. That file argued *where* the
build request must be emitted from and left one question open: **which identity
carries the publish, and can it?** That question is now answered by measurement,
and the answer is that no new IAM binding is required.

Read this with `BUILD-REQUEST-PUBLISHING.md` (the design), `publish-build-request.sh`
(the standalone implementation and its self-test), `cloudbuild-dev.yaml` and
`cloudbuild-release-check.yaml` (the two consumers).

---

## 1. The identity question, settled

A gate job has **two identities in one shell** and the choice is invisible in the
source:

| What runs | Which identity | How |
|---|---|---|
| `gcloud` | the **approving human** | `CLOUDSDK_AUTH_ACCESS_TOKEN` is set in the job environment |
| `python3` | the **gate executor's runtime service account** | no such variable; it reaches the metadata server |

`BUILD-REQUEST-PUBLISHING.md` section 4 recorded that this made the publish
doubtful, because "that identity's rights on the dev topic are **not
established**". They are now.

### What was measured, 2026-08-11

Two calls, both returning rather than reasoned:

1. `POST pubsub.googleapis.com/v1/projects/<dev>/topics/fleet-main-moved:testIamPermissions`
   returns `pubsub.topics.get` and `pubsub.topics.publish`, and **not**
   `setIamPolicy`. The dev publishing service account can publish to the topic.

2. `POST iam.googleapis.com/v1/projects/<dev>/serviceAccounts/<dev-publishing-sa>:getIamPolicy`
   returns a **single** binding, `roles/iam.serviceAccountTokenCreator`, whose
   members are:

   * the **prod gate executor's runtime service account** -- i.e. the principal
     `python3` runs as inside a gate job;
   * the **prod control-plane service account**;
   * the **approving human** -- i.e. the principal `gcloud` runs as inside a gate job.

**Both** identities present in a gate job are therefore members of the binding.
The chain closes from either side:

    gate-job principal (gcloud=human, or python3=executor SA)
      --[roles/iam.serviceAccountTokenCreator, read off the dev publishing SA's own policy]-->
    the dev publishing service account
      --[pubsub.topics.publish, returned by testIamPermissions ON THE TOPIC]-->
    the build-request topic

### The decision, and why

**`gcloud` carries the publish, impersonating the dev publishing service account.**

* It is the shorter measured path: one flag, `--impersonate-service-account`,
  against a binding the human is directly a member of. No hand-rolled metadata
  fetch and no `iamcredentials` call to get wrong.
* It does **not** depend on the human holding `pubsub.topics.publish` directly --
  which remains **unmeasured and must not be assumed**. The impersonation is what
  makes the rights concrete, and it is exactly the hop that was measured.
* The executor-SA path is equally proven and is the fallback if the job's `gcloud`
  authentication ever changes. It is not a silent fallback: there is no `||` that
  swaps identities, because a publisher that quietly changes principal is a
  publisher nobody can audit.

**No new binding is needed. This is not a blocker.**

The narrower direct grant (`roles/pubsub.publisher` on the topic, to the acting
principal) still cannot be set from dev -- `setIamPolicy` is absent from the
`testIamPermissions` result above. It belongs in `dev-project-bootstrap.sh`, which
runs as an owner. It is a **convenience**, not a prerequisite.

## 2. The payload contract, verified against the live triggers

Read back on 2026-08-11 from
`GET cloudbuild.googleapis.com/v1/projects/<dev>/triggers`, **not** from
documentation:

| Trigger | Id | Binds |
|---|---|---|
| `fleet-dev-on-main` | `<your-dev-on-main-trigger-id>` | `_COMMIT` `_SHORT` `_ARCHIVE` `_SHA256` |
| `fleet-release-check` | `<your-release-check-trigger-id>` | `_COMMIT` `_ARCHIVE` `_SHA256` |

Each is `$(body.message.data.<key>)`. `fleet-release-check` does **not** bind
`_SHORT`; `fleet-dev-on-main` does, and uses it only to emit a `WARN` when it
disagrees with the verified commit. So the payload must carry all four keys, and
`short` must still be correct even though only one consumer reads it.

`ref` is bound by nothing. Carry it for the reader; check nothing against it.

Both triggers subscribe to the **same topic**, so **one publish fires two builds**.

## 3. The command lines

Append these to the bundle-publish job, after the artifact proof has run and set
`PROOF`. They assume `PROOF`, `COMMIT`, `ARCHIVE` and `SHA256` are already set by
the verification that precedes them -- `SHA256` being the digest **re-derived from
the re-downloaded object**, never the one the producer claimed.

**There is not a single comment among them, and that is deliberate**: a comment
inside a backslash-continued command truncates it, the remainder runs as a
separate command, and `bash -n` does not catch it.

```
test "$PROOF" = "0" || { echo "RESULT PUBLISH SKIPPED proof not established (PROOF=$PROOF)" ; exit 71 ; }
PUB_SA=<dev-publishing-sa>
PUB_TOPIC=projects/<dev-project>/topics/fleet-main-moved
PUB_SHORT=$(printf '%s' "$COMMIT" | cut -c1-8)
PUB_MSG="{\"commit\":\"$COMMIT\",\"short\":\"$PUB_SHORT\",\"archive\":\"$ARCHIVE\",\"sha256\":\"$SHA256\",\"ref\":\"refs/heads/main\"}"
echo "PUBLISH IDENTITY gcloud=$(gcloud config get-value account 2>/dev/null) impersonating=$PUB_SA"
echo "PUBLISH IDENTITY python3=$(curl -s -H Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email 2>/dev/null || echo unavailable)"
echo "PUBLISH PAYLOAD $PUB_MSG"
PUB_MSG_JSON="$PUB_MSG" python3 -c "import json,os,sys;d=json.loads(os.environ['PUB_MSG_JSON']);sys.exit(0 if len(d.get('commit',''))==40 and len(d.get('sha256',''))==64 and len(d.get('short',''))==8 and d.get('short')==d.get('commit')[:8] and d.get('archive','').startswith('gs://') and d.get('archive','').endswith('.bundle') else 1)" || { echo "RESULT PUBLISH FAIL payload does not parse or a trigger-bound field is the wrong shape" ; exit 70 ; }
gcloud pubsub topics publish "$PUB_TOPIC" --impersonate-service-account="$PUB_SA" --message="$PUB_MSG" --attribute=origin=bundle-publish-job --format='value(messageIds[0])' > /tmp/pubid.txt 2> /tmp/puberr.txt || { echo "PUBLISH STDERR $(head -5 /tmp/puberr.txt | tr '\n' ' ')" ; echo "RESULT PUBLISH FAIL the publish call returned non-zero" ; exit 70 ; }
test -s /tmp/pubid.txt || { echo "RESULT PUBLISH FAIL the publish returned zero messageIds" ; exit 70 ; }
echo "PUBLISHED messageId $(cat /tmp/pubid.txt) topic $PUB_TOPIC"
echo "RESULT PUBLISH PASS"
```

### Why each line is the way it is

* **`PROOF` gates everything.** If the artifact did not verify, **nothing is
  published** and the job says `RESULT PUBLISH SKIPPED` and exits `71`. Firing a
  build against an unverified archive is the exact failure this design exists to
  prevent, and silence here would be indistinguishable from success.
* **The verdict is not flipped, but the failure is loud.** These lines run *after*
  the bundle's own verdict. A publish failure exits `70` -- a code used by nothing
  else -- and prints `RESULT PUBLISH FAIL`. The archive really was published and
  verified; saying otherwise would corrupt the record. But `RESULT PUBLISH` is
  emitted on **every** path, so "has the publisher been dead for a week" is a
  grep, not archaeology. **There is no catch that only logs.** This fleet's
  bootstrap forbids it because it turns a broken path into a silent one.
* **Both identities are printed before the publish.** A publisher that does not
  say which principal it used cannot be debugged from its own transcript, and the
  two principals in this shell are easy to confuse precisely because the source
  looks identical either way.
* **The payload is parsed, not eyeballed.** The `python3` line re-parses the JSON
  and asserts the width of every field the triggers bind: `commit` 40 hex-width,
  `sha256` 64, `short` 8 **and equal to the commit's first 8** (so a stale `short`
  cannot ride along), `archive` a `gs://` URL ending `.bundle`. A malformed
  payload binds empty substitutions and dies at `test -n "${_ARCHIVE}"` inside the
  build, which reddens a build for a reason that has nothing to do with the code.
* **Zero `messageIds` is a failure.** A `200` carrying no ids is a failed publish,
  not a success, so the id file is required to be non-empty.
* **Exit codes are distinct** because "why did it refuse" is the question at 2am:
  `70` publish failed, `71` proof was not established.

## 4. A standing trap: the trigger's inline config drifts from this directory

**Editing a YAML file here changes nothing by itself.** Both triggers carry an
**inline** build config. The YAML in this directory is the reviewed source of
truth; the trigger holds a *copy*, and the copy is what runs.

It has already cost a build once. `cloudbuild-release-check.yaml` carried the
corrected three-positional invocation

    python3 oss/gen.py . /workspace/_cut ${_COMMIT}

while trigger `<your-release-check-trigger-id>` still carried the superseded

    python3 oss/gen.py --out /workspace/_cut

so every release-check build died at step 1 with
`REFUSING: ['missing source: --out/control-plane/src/index.ts', ...]`, **whatever
the state of the tree**, and never reached its blocking verdict in step 2.

**THAT PARTICULAR DRIFT IS CLOSED, AND THIS PARAGRAPH USED TO SAY OTHERWISE.** It
was written in the present tense -- "still carries", "the fix in git is real and is
not in effect" -- and it stayed that way after the trigger was re-synced, so the one
section of this document whose job is to detect drift was itself asserting a drift
that no longer existed. A document that invents a defect costs more than one that
misses a defect, because it sends the next reader to fix something that is already
fixed. Re-measured 2026-08-11 by `GET .../triggers`: trigger `<your-release-check-trigger-id>` carries
the three-positional form, and after [SEC-CI-CUT-COMPARE-V1] all FIVE of its step
script bodies are byte-identical to `cloudbuild-release-check.yaml` blob `99f11207`
at main `ac377517`, compared by length and sha256 rather than by reading them.

**Report this section's state as of a measurement, never as a standing fact.** The
next person to change a YAML here re-measures and rewrites this paragraph; that is
the whole point of it.

**Whoever changes a file in this directory must re-sync the trigger and say so in
the trigger description**, which is where the source blob oid is recorded. A
description naming a blob oid that is no longer at head is the signal that this
drift has happened again.
