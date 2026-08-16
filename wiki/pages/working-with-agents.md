---
page: working-with-agents
title: Working with your agents
section: operate
status: live
audience: public
owner: unassigned
generated_by: starter-edition
verified_at: "2026-08-16"
verified_by: starter-edition
watch:
  - "lake:shared/wiki/_release.txt@71b8aebd9209c5b60ca8ccc1ef4bb906ec2a7a5e39d77743e915866794b5d323"
---

# Working with your agents

Your install ships with three agents already defined. They know the rules, they know their
own job, and they can reach your cloud project, your repository and your build path without
you configuring anything further.

This page is the part you read. It says what each one is for, what to ask it first, what you
need installed, and what the agents already know so you do not have to explain it.

---

## The three strains

A **strain** is an identity: a role name, its own folder in the lake, its own lane in the
journal, and its own session keys. Work is attributed to it and scoped by it.

| strain | owns | ask it about |
|---|---|---|
| **fleet-advisor** | strategy, planning, the queue | what to do next, triage, plans, summaries |
| **fleet-gcp** | cloud infrastructure | deploys, revisions, IAM, cost, rollback |
| **fleet-security** | review, audit, refusal | is this safe, is this true, what can an agent actually do |

Each one is handed two documents at the start of every session, automatically, before it does
anything:

- **`shared/fleet/BOOTSTRAP.md`** — the rules every strain follows. Identity, memory,
  repository, privileged work, build and deploy, how to report.
- **`shared/fleet/strains/<role>.md`** — that strain's own charter. What it owns, what to ask
  it, how it works, and what it must not do.

Both live in your lake, not in the image. **Edit them.** A change is picked up within a
minute and applies to every session from then on. If you want a strain to work differently,
change its charter — that is the intended way to steer them, not repeating yourself in chat.

If you delete `BOOTSTRAP.md`, agents are told they have no delivered rules and to say so
before doing anything privileged. That is deliberate.

---

## Your first hour

Mint a session key for **fleet-advisor** (Autoclave → New strain session), paste it into your
agent, and ask:

```
What is deployed right now, what is outstanding, and what should I do first?
```

Then try one of these, which exercise the three different things this system can do:

**Read the truth about the install** — ask fleet-gcp:
```
What is deployed, from which commit, and does the marker agree?
```

**Change the code** — ask fleet-gcp or fleet-advisor:
```
Change the console heading to say <something>, propose it, and show me the diff
before you push.
```

**Get a second opinion** — ask fleet-security:
```
Read that change and tell me whether it is safe to ship.
```

The pattern that works: **ask for the measurement before the change.** An agent that has read
the current state proposes better changes than one that has not.

---

## What you need installed

**Required — you already have it.** The MCP connector for this install. Your agent client
adds it once; the URL is the MCP service, not the console. See
[Connecting an agent](connect-an-agent).

**Required for the agent to touch your cloud.** Nothing further. The control plane holds the
credentials; the agent never does. It asks the control plane, which is the whole point of the
design.

**Optional, and useful.**

- **A second strain key.** Running planning and execution as different identities keeps the
  attribution honest and the blast radius small. It costs nothing.
- **A workstation.** Not installed by `install.sh` — run `workstation.sh` separately if you
  want a VM with a browser your agents can drive.
- **A CI trigger.** Everything needed ships; see the build path below.

**Not required, and a common mistake:** you do not need to give an agent a Google credential,
a service-account key, or `gcloud` on its own machine. If an agent asks you for one, that is
a signal something is wrong, not a setup step.

---

## What agents already know about your repository

You do not have to teach them this. It is in `BOOTSTRAP.md` §3 and in every strain charter.

Your source lives in a **git store this install owns** — refs in Firestore, objects in your
own bucket, encrypted at rest. It is not GitHub and there is nothing to clone.

Agents reach it with tools, not a checkout:

| tool | what it does |
|---|---|
| `git_read` `git_list` `git_log` `git_diff` | read the tree at any ref |
| `git_archive` | the **whole tree in one call**, as a tarball |
| `git_propose` `git_propose_patch` | write files into a commit that is not yet visible |
| `git_push` | move the branch, by compare-and-swap |

The rules they already follow:

- **Propose, verify, then push.** `git_propose` returns a tree oid; a careful agent rebuilds
  that tree locally and compares before pushing. That turns "I think I sent the right bytes"
  into an assertion.
- **No force push.** A lost race returns `STALE` rather than clobbering anyone. The agent
  re-reads the branch and rebuilds.
- **Large files do not travel as arguments.** They are uploaded to `/git/blob` and referenced
  by oid, so nothing is retyped.

The worked example, end to end, is in [Changing the code](change-the-code).

---

## The build path, and how to arm it

Source in the repository → build reads the repository → deploy ships the build. Agents are
told never to restore an image to change what is running: they roll traffic between revisions
that already exist.

**A deploy is three steps and the middle one is not optional.** Build, deploy to a
**zero-traffic** revision with a tag, verify that tagged URL, then shift traffic. A revision
at zero traffic has changed nothing for you, which is exactly why it is safe to look at
first. Ask for it that way and an agent will do it that way.

**What ships under `pipeline/`:**

| file | what it is |
|---|---|
| `publish-build-request.sh` | publishes the build request — after re-verifying the bundle it names |
| `cloudbuild-dev.yaml` | the dev build; verifies the bundle digest before extracting |
| `cloudbuild-prod.yaml` | promotion: capture the revision, pin the traffic |
| `cloudbuild-release-check.yaml` | verify-only: would a downloader still get a true tree? |
| `promote-gate.sh` | the promotion gate, with named exit codes |
| `collect-evidence.py` | gathers the evidence bundle the gate judges |
| `secret-destroy-preflight.py` | does anything still reference this secret, before you destroy it |

**CI is deliberately shipped unfinished, and this is the honest account of what is
missing.** Read it before asking an agent to "turn CI on", because an agent that guesses
here produces a pipeline that looks complete and dies on every push.

A successful `git_push` publishes a **ref-moved notice** — `{commit, short, ref}` — to
`PC_CI_TOPIC`. That is all it can truthfully say. The dev build consumes a different,
larger message, the **build request**: `{commit, short, archive, sha256, ref}`, where
`archive` and `sha256` name a single-commit git *bundle*. `git bundle create` is not
byte-reproducible, so that digest cannot be known at push time — and step 1 of the dev
build verifies it before extracting anything. A guessed digest is a red build that proves
nothing about your code.

So two pieces stand between you and a working lane, and **only one of them ships**:

1. **A bundle producer — you write this.** Something that, after main moves, creates a
   single-commit bundle for that commit, uploads it to `PC_CI_TREES` with its digest
   sidecar, and then calls `publish-build-request.sh <commit>`. This tree ships no such
   producer. `publish-build-request.sh` does *not* create the bundle: it re-downloads the
   published bytes, re-derives the digest, unbundles it, checks the head is the commit you
   asked for, and only then publishes — refusing with `21` (no such object) or `25` (no
   published digest sidecar) if you point it at a bundle nobody made.
2. **A Cloud Build trigger — one command.** The installer created the topic and granted the
   publisher role but did not create this, and prints the exact command at the end of its
   run. It is shaped like:

```
gcloud builds triggers create pubsub --name=paracoding-on-main \
  --topic=$PC_CI_TOPIC --project=$PROJECT \
  --service-account=projects/$PROJECT/serviceAccounts/$PC_BUILD_SA \
  --inline-config=pipeline/cloudbuild-dev.yaml \
  --substitutions='_COMMIT=$(body.message.data.commit),_ARCHIVE=$(body.message.data.archive),_SHA256=$(body.message.data.sha256)'
```

`--service-account` is mandatory; omitting it returns a content-free `400 Request contains
an invalid argument` that names nothing. Its value is the resource path, not the bare email.

Your topic name is printed by the installer and set on the MCP service as `PC_CI_TOPIC`. Ask
fleet-gcp for it — "what is PC_CI_TOPIC set to on the MCP service?" — rather than guessing.

Until `PC_CI_TOPIC` is set, `git_push` reports `DISABLED_NO_TOPIC` and publishes nothing.
That is the correct state for an install with no CI project. Nothing is broken; the lane is
simply not connected yet, and it is visible rather than silent.

Reading a verdict afterwards is covered in [Operators guide](operators-guide) §9.

---

## What agents will refuse, and why that is working

They are told to push back rather than guess. Expect an agent to stop and ask when you say:

- **"Delete X."** There is no undo on a lake object. It will ask you to confirm what is going.
- **"Grant broad access."** It will ask which permission actually failed.
- **"Make it public."** It will ask who is meant to reach it.
- **"Ship it."** — if nobody has looked at the zero-traffic revision.

An agent that refuses and explains the cost is doing its job. One that silently complies with
an irreversible instruction is not.

---

## Making them yours

The three strains are a starting point, not a fixed set.

- **Change a charter.** Edit that strain's charter file — both paths are listed at the top of
  this page. This is the main lever.
- **Change the rules for everyone.** Edit the fleet bootstrap, beside it.
- **Change what a new chat is told.** The console's "start an agent" paste is rendered from
  `shared/bootstrap/cowork-prompts.md` in your lake, sliced on the literal lines
  `## PROMPT 1` (advisor) and `## PROMPT 2` (worker). Edit it and the next paste changes; no
  deploy. Remove a marker and the console falls back to a built-in prompt rather than handing
  out a broken one.
- **Add a strain.** Create it in the console; it gets its own lane and a starting lessons
  file. Give it a charter beside the others.
- **Narrow a key.** A session key can be minted with a subset of tool classes, so a key that
  only ever needs to read cannot write.

See [The strains](the-strains) for identities and lanes, and
[Connecting an agent](connect-an-agent) for keys and revocation.
