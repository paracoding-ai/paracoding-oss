---
page: change-the-code
title: Changing the code -- a branding change, end to end
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

# Changing the code -- a branding change, end to end

The source of the thing you are running ships with it. You are not extending a black
box through a plugin API. You have the whole control plane, the executor, the
installer, and the build.

This page is a worked example. We are going to put your name on it.

## 0. Where the source is -- in two places, and they start identical

**On disk**, in the release directory you installed from. **And in the repository**,
because the installer committed that same tree to `main` at step 8b/10 and read it back
before it would call the install complete. So an agent that has never seen your disk
can still read every file, and the very first `git_list` works.

The tree you care about:

```
control-plane/src/index.ts        the control plane -- the bulk of it, one file
control-plane/src/gittools.ts     the seven git tools, a separate bundle
control-plane/src/gppatch.ts      git_propose_patch, the strict unified-diff applier
control-plane/src/mcp2.ts         the MCP transport shims
control-plane/src/mcp2026.ts
control-plane/src/pcgit/          the object store: refs in Firestore, blobs in the lake
control-plane/src/dash.html       the dashboard
control-plane/src/harness.html    the main console UI
control-plane/src/locked.html     the 401 page, served in place at any human URL
control-plane/Dockerfile          the build
gate-exec/exec_server.py          the executor
install.sh  workstation.sh        provisioning
README.md  SECURITY.md  NOTICE    the documents
```

`index.ts` is the biggest file by a wide margin, but it is **not** the whole control
plane, and an older version of this page said it was. The Dockerfile carries a separate
hardcoded `esbuild` line per module, each ending in `&& test -s dist/<name>.js` so a
missing bundle fails the image build rather than failing quietly at runtime. If you add
a module, you add it to the Dockerfile. Editing the `build` script in `package.json`
compiles nothing -- the Dockerfile does not run it.

Ask an agent for the change. That is the intended workflow: you describe the outcome,
it finds the strings, it shows you the diff. It can do that against the repository
without any access to your machine.

> **The repository is the only source of truth, and two old mirrors are not.**
> `gs://<lake>/shared/repo/HEAD/` and `gs://<project>-source/<repo>.git` are stale.
> They are plaintext, so they are the easy thing for an agent to reach for, and that is
> exactly the hazard: agents reading them have reported code -- confidently, in detail --
> that had not existed for weeks. If a script you inherited clones from either, it is
> building the wrong tree. Read through the git tools, or through `GET /git/archive`
> (section 4).

## 1. Find where the branding lives

There are exactly three places, and they behave differently. Knowing which one you
are in tells you whether you need a deploy.

### (a) The three HTML files -- needs a rebuild

`dash.html`, `harness.html`, `locked.html`. **Three, not four.** The fourth was
`gate.html`, roughly 142KB of it, and it is deleted along with the `/gate` route that
served it. If you are working from an older checkout or an older copy of this page and
you go looking for it, it is not missing -- it is gone on purpose.

These are real files on disk. `index.ts` reads them at boot with a helper, so they are
baked into the running container. The product name, the page titles, the header, the
colours and the footer copy are all in here.

`locked.html` is worth knowing the shape of before you edit it, because its role changed
with the gate. It is no longer a page you get redirected *to*. An anonymous request to
`/harness`, `/wiki`, `/flow`, `/chat`, `/lakeview` or `/flowhood` is answered **401 with
this document served in place, at the URL the caller asked for** -- no redirect, no
`?next=`. `GET /` is a 302 to `/harness`. With `PC_REQUIRE_PASSKEY=1`, which is the
default and what the installer sets, this small document is also the working passkey
unlock page.

Find them:

```
grep -rn "Paracoding" control-plane/src/*.html
```

### (b) The wiki chrome -- needs **no** deploy

`shared/wiki/_shell.html` is a lake object, read on every request with `no-store`.
The wiki's palette, the nav, the fonts and the footer sentence live there. Editing it
is a file write. The next page load is already changed.

This is the fast path. If all you want is the docs to look like yours, do (b) and
stop.

### (c) The documents -- no deploy, no runtime effect

`README.md`, `NOTICE`, `SECURITY.md`, the wiki pages under `shared/wiki/pages/`.
Prose only.

> **NOTICE is not branding.** The release is Apache-2.0 and the licence requires you
> to keep the copyright headers and the `NOTICE` file. Rebrand the product surface;
> leave the attribution alone. This is the one edit on this page that is a legal
> question rather than a taste question.

## 2. The one name you must not change

**Do not rename the console Cloud Run service.**

The WebAuthn Relying Party ID is that service's hostname -- the installer sets
`WA_RP_ID` and `WA_RP_ORIGIN` from it directly. Every passkey already registered is
bound to it. Rename the service and the hostname changes and **every registered passkey
stops working.**

An older version of this page finished that sentence with "which means nobody can
approve the job that would fix it." That is no longer the reason to care, because there
is no approval queue. The reason to care now is narrower and still good: the passkey
unlock is the way back into the console **if the identity provider in front of it ever
fails**. IAP is the outer door and the passkey is the inner one, and breaking the inner
one leaves you depending on the outer one being healthy on the day you need it.

Change the display name in the HTML. Leave the service name alone. If you genuinely
must move to your own domain, register new passkeys against the new hostname *before*
you retire the old one, and keep the old console reachable until you have proved the
new one works.

## 3. Propose the change

### Over the git tools

**They are already on, and the code is already in there.** There is nothing to enable,
no bucket to make and no commands to run first. The installer created the git object
bucket, granted the control plane `objectAdmin` on that bucket alone, set `GIT_REPO_ID`
and `GIT_BUCKET` on the **MCP service** -- the pair the module requires before it
registers anything -- and then, at step 8b/10, committed this release tree to `main` and
read it back with `git_list` and `git_read`. If any of that had failed, the install
would have said so and refused to print INSTALL COMPLETE.

There are **seven** git tools -- `git_read`, `git_list`, `git_log`, `git_diff`,
`git_propose`, `git_propose_patch`, `git_push` -- and a branding change, end to end, is
four calls out of that set:

1. `git_list` with `ref: main` -- the top of the tree, so the agent can see the layout.
2. `git_read` with `ref: main`, `path: control-plane/src/harness.html` -- the file and its
   blob id. **Keep that blob id.** It is the input to the next step.
3. `git_propose_patch` with `branch: main`, a unified diff, and `expected_blob_sha`
   naming each path you are touching against the 40-hex blob oid you just read (or
   `null`, meaning the file must not exist yet). Nothing is visible yet; it returns a
   `commitOid` and the `baseOid` it was built on. **Read the diff here.**
4. `git_push` with `branch: main`, `expected_oid` set to that `baseOid`, and `commit_oid`
   set to the `commitOid` from step 3. That is a compare-and-swap on the branch: if
   anything else moved it in the meantime you get `ok:false code:STALE`, it does not
   retry, and nothing is lost. There is no force push.

**The two compare-and-swaps are different and you want both.** `expected_blob_sha` is
per file: it fails if the *file* changed under you, even on a branch that did not move.
`expected_oid` is per branch: it fails if the *branch* moved, even in files you did not
touch. Passing only the second is the common shortcut and it is how two agents editing
adjacent regions of one 106KB HTML file quietly produce a commit that keeps one edit.

The patch applier is strict on purpose: every hunk must match the current bytes exactly
at the line it names -- no fuzz, no offset search -- and any hunk that does not apply
fails the whole call with nothing committed. It edits content only. It cannot create,
delete, rename or chmod a file, and it refuses binaries. `git_propose` writes whole
files instead, which is the right tool for a new file or a rewrite.

Two things worth knowing before you rely on this:

- **Landing a commit does not deploy anything.** The repository is the source of truth
  for the code; the running container is whatever was last built. Section 4 is what puts
  a change in front of your users, and on a default install nothing stands between the
  push and that deploy except you deciding to run it.
- **Re-running the installer will not overwrite your commits.** The seed asks
  `git_list` first and writes nothing at all if the branch already has a tree.

`FIRESTORE_DATABASE` is deliberately left unset so the tools follow the database
everything else already uses. Setting it to something different is refused at
startup rather than quietly serving you an empty repository.

### Or on disk

Edit the files in the release directory. Use whatever review you already trust, and
understand what you are trading: a deploy `--source` from your disk builds **what is on
your disk**, which is not necessarily what is on `main`. That is fine for a first
install and it is how the installer itself works. It is a poor habit afterwards, because
the next person to build from the store gets a different tree and no message tells them
so. Push first, then build from the store.

Either way: **read the diff before you deploy it.** This is the sentence that used to
say the gate protected your infrastructure from an agent. It did not survive the change
described on `the-gate`: on a default install `PC_GUARDRAILS=0`, there is no approval
queue and no per-job tap, and the thing standing between a bad edit and your users is
you reading the diff. The pre-ship checks that fail a *cut* are all still in place --
`oss/gen.py`, `control-plane/route-audit.mjs`, `blob-audit.mjs`, `devgate/smoke.py` --
and none of them has an opinion about your header copy.

## 4. Build it, from the store

**The store is authoritative, and it is encrypted.** The repository is refs in Firestore
and objects in the lake, and those objects are PCV1-sealed, which is the whole reason
this step has a procedure instead of a `git clone`. No build system can read them
directly. Something has to decrypt them first, and the two things that can are below.

`deploy/BUILD-FROM-THE-STORE.md` is the long form. It carries detail this page does not
-- the exit codes, the KMS path, the two-identity trap -- and if any line here disagrees
with it, that file wins.

### The path a human takes, inside a job

```
gcloud storage cp gs://<lake>/shared/deploy/lane-fetch.py /tmp/lane-fetch.py
python3 /tmp/lane-fetch.py <your-exporter-object> /tmp/pcgit-export.py
python3 /tmp/pcgit-export.py --out /tmp/src.git --head refs/heads/main \
  --expect-ref refs/heads/main=<the oid you just pushed>
git clone /tmp/src.git /tmp/work
gcloud run deploy <console-service> --source /tmp/work/control-plane \
  --region <your-region> --project <your-project>
```

Four things about those five lines, each of which has cost somebody a deploy:

- **The first line is a raw copy and that is correct.** `shared/deploy/` is a cleartext
  prefix, so the fetcher is always stored in the clear. That is the bootstrap, and it is
  deliberately un-breakable by a re-encryption sweep: the fetcher and the codec it loads
  at run time both live in cleartext prefixes.
- **The second line must go through `lane-fetch.py`.** A raw `gcloud storage cp` of the
  exporter fails in the worst possible way -- the *copy succeeds*, so the job looks
  healthy, and then `python3` dies on `SyntaxError: source code cannot contain null
  bytes`. That line means you fetched ciphertext. Nothing is corrupt and the file is not
  damaged; you used the wrong fetcher.
- **Pass `--expect-ref`.** It is the difference between building the commit you meant and
  building whatever the store happened to hold when the job ran. The exporter also
  refuses a tree it cannot verify -- `git fsck --connectivity-only`, every ref resolving
  to a real commit, history walkable to a root.
- **Use `gcloud storage`, never `gsutil`.** Inside a job `gcloud` runs as the approving
  human through an injected token; `gsutil` ignores that token, falls back to a service
  account with no access, and dies 403.

> **Which identity runs this matters more than anything else on the page, and it is the
> one place the gate removal genuinely bites.** `lane-fetch.py` decrypts by asking Cloud
> KMS to decapsulate the vault key, and it authenticates that call with `gcloud auth
> print-access-token`. Inside a job started by a human, `gcloud` picks up the injected
> `CLOUDSDK_AUTH_ACCESS_TOKEN` -- **that human's** token -- and the decapsulate succeeds
> as them. That is measured, and it is documented at length in
> `deploy/BUILD-FROM-THE-STORE.md`.
>
> The consequence, which is reasoning from the code rather than something this page has
> watched fail: on the path where **no human is in the loop**, the control plane forwards
> an **empty** token deliberately, so the executor runs the body under its own scoped
> service account. That account holds `datastore.user` and `logging.logWriter` and
> nothing else -- no KMS. A store deploy attempted that way should fail at the
> decapsulate with `ABORT: KMS decapsulate http 403`, not build the wrong tree. **If you
> want a build with no human in it, use `GET /git/archive` below.** It is the endpoint
> built for exactly that case, because the decryption happens inside the process that
> already holds the vault instead of inside your job.
>
> Watch for the failure mode this creates, because it is the expensive one: a python
> script in a job that reaches a Google API through `urllib` or `requests` gets the
> executor's identity, not the human's, and the two are indistinguishable in the source.
> A 403 parsed as an empty result becomes a confident, detailed, wrong report. If you get
> a report that is wrong about many things at once while a `gcloud` command beside it
> describes a healthy system, suspect the identity before you suspect the deploy.

### The path a build system takes, with no human in it

`GET /git/archive` on the MCP surface hands back the repository as a gzipped tarball.
This is the answer to "how does CI get a checkout when the objects are encrypted and
there is nobody to approve a job" -- one reader, inside the process that already holds
the vault, serving a tree to a caller Google has already authenticated.

**There is no shared secret, on purpose.** The caller presents a Google-signed ID token
for its own service account; the audience is pinned to the MCP public URL; the email
must appear in `PC_ARCHIVE_ALLOWED_SA`. Nothing to rotate, nothing to leak.

**That allowlist fails closed when unset.** Unset means *no* caller, not any caller --
an empty list read as "everyone" would hand your whole private source tree to any
service account in any project that found the URL. If you have not set it, the endpoint
answers 401 and says why in the log.

The response carries `x-pcgit-commit`, `x-pcgit-files` and `x-pcgit-bytes`, so a build
step can assert coverage against what it actually extracted rather than trusting a byte
count. The archive is also byte-reproducible for a given commit -- mtimes are zeroed and
the gzip level is fixed -- so two builds of one commit can be compared instead of merely
re-run. File modes come from the tree, not a default, which is what keeps `install.sh`
arriving as `100755`.

Every fetch is journalled with the caller, the ref, the commit and the file count.

### Then the second service, from the same image

One build, two services. The console is deployed from source, which produces the image;
the MCP service is then deployed **from that exact image**, so the two cannot drift.

```
REV=$(gcloud run services describe <console-service> \
  --region <your-region> --project <your-project> \
  --format 'value(status.latestReadyRevisionName)')

IMG=$(gcloud run revisions describe "$REV" \
  --region <your-region> --project <your-project> \
  --format 'value(spec.containers[0].image)')

gcloud run deploy <mcp-service> --image "$IMG" \
  --region <your-region> --project <your-project>
```

Do not skip this and do not deploy the MCP service `--source`. Two independent builds of
the same tree are two images, and a route that exists on one service and not the other
is the kind of fault that shows up as "it works in the browser but the agent says the
tool is gone".

## 5. Re-pin the traffic, and read the revision back

**`gcloud` misreports which revision it deployed.** This is the step most likely to be
skipped and it is the one that produces "I deployed the fix and nothing changed". Do not
trust the revision name the deploy prints in its progress output. Capture the revision
from the deploy itself:

```
gcloud run deploy <console-service> --source /tmp/work/control-plane \
  --region <your-region> --project <your-project> --no-traffic \
  --format='value(status.latestCreatedRevisionName)' > /tmp/cp.rev
test -s /tmp/cp.rev
```

`status.latestCreatedRevisionName`, not `latestReadyRevisionName`, and read off **this**
deploy rather than re-derived later. Those are two different questions: a concurrent
deploy between the two reads makes "the revision I just built" and "the latest revision"
different revisions, and you would verify one and promote the other. `test -s` is not
decoration -- an empty answer means the deploy did not tell you what it made, and that
is a refusal to act on, not something to guess past. `pipeline/cloudbuild-prod.yaml`
does exactly this, which is why it can be trusted.

Then send traffic to the name you captured:

```
gcloud run services update-traffic <console-service> \
  --to-revisions "$(cat /tmp/cp.rev)=100" \
  --region <your-region> --project <your-project>
```

### Confirm it is serving

A deploy that reports success and a revision that is actually serving are two different
facts. Verify by reading back off the service, never by the exit code of the command
that claims to have done it:

```
gcloud run services describe <console-service> \
  --region <your-region> --project <your-project> \
  --format='value(status.traffic.filter("percent:100").revisionName,status.url)'
```

Then open the console URL and hard-reload. If you changed `locked.html` you will see it
**without signing in** -- an anonymous request gets it at 401, in place -- and that is
the fastest confirmation available anywhere in this system, because it needs no session,
no passkey and no IAP round trip.

If the page is unchanged: you are looking at a cached asset, or the revision serving
traffic is not the one you just built. Check the serving revision name first. That single
check resolves most "my change did not deploy" reports.

## 6. The wiki-only path, for comparison

```
gcloud storage cp _shell.html gs://<your-lake-bucket>/shared/wiki/_shell.html
```

Reload the wiki. Done. No build, no revision, no downtime. Anything served from the
lake behaves this way, which is exactly why the wiki lives there: a documentation
system that needs a deploy to fix a wrong sentence stays wrong.

The same is true of these pages. `shared/wiki/pages/<slug>.md`, one object each, and
`shared/wiki/_index.json` is both the nav tree and the allow-list -- a page not listed
there is not served no matter what is in the bucket.

## 7. Rolling back

Cloud Run keeps revisions, and **traffic is a pointer**. Rolling back moves the pointer.
It rebuilds nothing, it does not touch the store, and it is a plain Cloud Run API call
rather than a job -- which is exactly why it stays available in the state where nothing
else does.

```
# what is serving right now?
gcloud run services describe <console-service> \
  --region <your-region> --project <your-project> \
  --format='value(status.traffic.filter("percent:100").revisionName)'

# what else is there?
gcloud run revisions list --service <console-service> \
  --region <your-region> --project <your-project>

# put it back
gcloud run services update-traffic <console-service> \
  --to-revisions <previous-revision>=100 \
  --region <your-region> --project <your-project>
```

Note the revision name **before** you deploy, not after it breaks. That is the same
`latestCreatedRevisionName` discipline from section 5, read from the other direction:
the name you captured going forward is the name you need going back. Roll back **both**
services if you deployed both -- a console on the new image and an MCP surface on the
old one is the drift the shared-image rule exists to prevent.

## The premise, stated plainly

You can change this system because you have all of it, in your project, under your
account, with the build that made it.

An earlier version of this page ended by saying an agent could read every line and write
every proposal and still could not put a revision in front of your users without you
tapping a key. **That is no longer true and you should not plan around it.** The tap is
gone; on a default install `PC_GUARDRAILS=0` and there is no approval queue. What
actually holds now is a smaller set of things, and they are worth naming honestly
because they are what you have:

- **The push is a compare-and-swap.** Nothing overwrites a branch, no force push exists,
  and a lost race is a `STALE` that destroys nothing.
- **Every commit is a commit.** A bad edit is recoverable by reading `git_log` and
  proposing the inverse. The store keeps the history that lets you.
- **Traffic is a pointer and rolling it back is one call.** The previous revision is
  still there and it does not need a build.
- **The pre-ship checks that fail a cut all survived.** `oss/gen.py`'s refusals,
  `route-audit.mjs`, `blob-audit.mjs`, the leak ceilings, `devgate/smoke.py`.
- **Reading the diff is yours.** That was always the part no mechanism did for you; it
  is now the only part.

If that trade is not the one you want to make, `PC_GUARDRAILS=1` puts the refusals back.
`the-gate` documents exactly what it restores and what it does not.
