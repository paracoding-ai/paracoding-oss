---
page: index
title: Start here
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

# Start here

You just installed an agent platform into your own Google Cloud project. Nothing
here runs on somebody else's infrastructure. There is no vendor account, no shared
tenancy, and no hosted control plane. If you delete the project, the whole system
is gone.

This wiki ships as a starter set. It is written for you, on day one, and it is
yours to edit. Pages are objects in your data lake, not code, so correcting a
sentence costs one file write and no deploy. See **Changing the code** for how.

## The one idea

**You are the authorisation. The chat is your hands.**

An agent connected to this system reads, plans, writes files and stages a job -- and
on the shipped defaults that job runs, in the same breath, because the decision was
already made when you said what you wanted. There is no per-job tap and nothing to
enrol before you start. The ruling that produced this posture,
verbatim, so you can disagree with it on purpose: *"we don't add speed bumps we add
accelerators"*, and *"there is no gate going forward for a job to show up in for me to
approve because nothing needs approved its all coming from me the chat is just my
hands."*

What that moves rather than deletes is where the authentication sits. It is the
account that got past Identity-Aware Proxy, its place on the approver allow-list, and
the IAM grant on the executor's own service account -- which is the real ceiling on
what an auto-run job can do to your project, because when a job auto-runs there is no
human credential in the path to borrow. Every job is still journalled, including the
ones an older build would have refused.

`PC_AUTO_APPROVE=0 PC_GUARDRAILS=1 ./install.sh` restores the older system entire --
the per-job tap and the runtime refusals both. Both variables are read from the
environment, so they are a Cloud Run configuration revision and **no job can arm or
disarm them.**

Read **Authorisation** next; it is still the page that matters most, and it is the one
that states exactly what is and is not refused now.

## What the installer actually built

### Two Cloud Run services, from one image

The split is a security boundary, not packaging.

| service | who talks to it | reachable how |
|---|---|---|
| the console | you, in a browser | behind Identity-Aware Proxy, then behind the approver allow-list |
| the MCP service | agent clients | publicly invokable, token-authenticated, IAP off |

They have to be separate. IAP on Cloud Run is one switch per service with no
path-level carve-out, and IAP consumes the `Authorization` header. Put IAP in front
of the MCP surface and `POST /mcp` is refused at Google's edge before your container
sees it, so no agent client can connect at all. Leave IAP off the console and the
browser pages are exposed to anyone who finds the hostname.

So: one build, two services, two URLs, and they are **not interchangeable**. The
installer printed both when it finished.

- Console URL, at `/harness` -- open this in a browser. `GET /` on the console host is
  an unconditional 302 to `/harness`, and it is the only redirect left in front of the
  console: it reads nothing and issues no session.
- MCP URL, at `/mcp` -- give this to an agent client. See **Connect an agent**.

Underneath IAP the console is still guarded by the application's own session check; a
fresh install sets `PC_REQUIRE_PASSKEY=0`, and in that mode a verified IAP identity on
the approver allow-list is what satisfies it. Two independent locks, on purpose. If IAP
were ever removed, the console would still not be readable by an anonymous caller:
`/harness`, `/wiki`, `/flow`, `/chat`, `/lakeview` and `/flowhood` answer an anonymous
request with `401` and the locked document served **in place**, at the URL you asked
for -- no redirect and no `?next=`. Unlocking therefore reloads you where you already
were, rather than dropping you at a front door.

**There is no `/gate` page, and looking for one is the surest sign you are reading
something out of date.** That route, the document behind it, `GET /jobs`, `GET /pastes`
and all ten redirects into it were deleted on 2026-08-14; measured against a running
build, all three URLs return `404`. If a bookmark, a script or an older page sends you
to `/gate`, the destination you actually want is `/harness`.

One route on the MCP service is worth naming here because it is neither a browser page
nor an agent tool: `GET /git/archive` serves the repository as a gzipped tarball to a
caller presenting a Google-signed service-account ID token, audience-pinned and
allow-listed by `PC_ARCHIVE_ALLOWED_SA`, which **fails closed when unset** -- with no
allow-list configured, nobody gets a tarball. It exists because the git store in the
lake is PCV1-encrypted, so a build system cannot read those objects directly. See
**Changing the code** for the build-from-the-store path.

### How the console is actually protected

Three controls, and the third is the one people leave out.

1. **A phishing-resistant hardware key.** IAP authenticates you against your Google
   account, so whatever that account requires is what the console requires. Put a
   Titan key or a passkey on it and reaching the console costs a physical touch.
   There is no password to phish and no code to relay.
2. **Enforced at the edge, not by the app.** IAP refuses an unauthenticated request
   at Google's front door. Your container is never reached, so a bug in the
   application cannot be the thing that lets somebody in.
3. **A domain constraint that makes a mistake impossible, not merely unlikely.**
   With the project in a Google Cloud organization and
   `constraints/iam.allowedPolicyMemberDomains` in force, an account outside your
   domain **cannot be granted console access at all** -- not by a typo, not by a
   tired operator at 2am, not by an agent following an instruction it should have
   questioned. The grant is refused when it is written.

That third one is worth dwelling on, because it is the difference between a policy
and a control. Documenting "do not grant access to personal accounts" is a policy;
somebody eventually does it anyway. This refuses the write. It was measured on
2026-08-14: an attempt to add a consumer Gmail address to the console's IAP binding
came back `FAILED_PRECONDITION ... not in permitted organization` and nothing
changed.

It also survives the obvious workaround. Turning the constraint off, adding the
account, and turning it back on DOES work -- because the constraint is enforced when
a binding is written, not retroactively -- which means the exception you told
yourself was temporary is permanent. If you need a second operator, add a second
account **in your domain** and give it its own key. You keep the control and you get
the redundancy.

**This is security that accelerates instead of slowing you down.** There is no
approval queue in this path, no ticket, no security review before you can open your
own console. One touch of a key and you are in. The strength comes from the identity
being unphishable and the blast radius being bounded by a constraint that cannot be
fat-fingered away -- not from making you wait for anybody.

### The gated executor

A third Cloud Run service, private, never publicly invokable -- the installer grants
`roles/run.invoker` on it to the control plane's service account and to nothing else.
It runs a job only if that job carries an approval whose signature verifies, and it
holds the **public** half of a Cloud KMS asymmetric key: it can check that a signature
is genuine and it cannot produce one. The control plane holds the private half.

With the shipped defaults the approval it checks was stamped by the control plane and
not by you, so read that signature as **provenance rather than permission**. It answers
"did this come from the control plane's key, for this job id, over this exact command
and these arguments" -- a question worth keeping once the per-job tap is gone. The
approver recorded inside the *signed* bytes reads `auto:lockout-check`, precisely so
that no transcript can ever be read as a person having approved when nobody did.

That asymmetry is still the point. Firestore IAM has no per-collection granularity, so
something with database access can corrupt an approval record. It cannot forge one.

### The data lake

A Cloud Storage bucket. Agent memory, state files, handoffs, and this wiki all live
there. Objects outside a short list of cleartext prefixes are sealed at rest with a
PCV1 vault key. If the vault key could not be minted during install, the lake is
fail-closed -- writes throw rather than silently falling back to plaintext.

### Firestore

Approvals, journal, work items, chat history, strain records, session keys.

## Where to go next

| page | read it when |
|---|---|
| **Authorisation** | now. This is the security model, and it changed on 2026-08-14. |
| **Connect an agent** | you want an agent client talking to this install. |
| **The strains** | you want to know who the four default agents are. |
| **Operators guide** | you are running this day to day. |
| **Architecture and code walkthrough** | you want the shape of the system as diagrams, then a guided read of the code that implements it. |
| **Systems manual** | you want the exhaustive reference -- every service, route, variable and rung. |
| **Changing the code** | you want to change something -- start with branding. |
| **Model configuration** | chat is answering from the wrong model, or costing money. |
| **The workstation** | you need a VM with a browser and a desktop. |
| **Troubleshooting** | something is already wrong. Start with the symptom tables there. |

**Authorisation** is still filed under the slug `the-gate`, because the slug is the key
the wiki's allow-list is written against and renaming it would take the page off the
air. The slug is a routing fact; it is not a description of a route that still exists.

## Honest limits

`README.md` and `SECURITY.md` ship in the release and both document what is not
done. Read them. Short version:

- A rebuild produces a working, equivalent deployment. It does not produce a
  bit-identical container image.
- This release has been installed from zero a small number of times, not a large
  number.
- The seven git tools **are** registered on a fresh install, and that is the
  installer's doing rather than a default. The module registers nothing unless both
  `GIT_REPO_ID` and `GIT_BUCKET` are set, because a tool that advertises itself and
  then fails on its first call is worse than no tool. The installer makes the object
  bucket, grants the control plane on that bucket and nothing else, and sets both
  variables on the MCP service, which is where the git tools are served. See
  **Changing the code**.
- Console access rests entirely on one Google identity being on the approver
  allow-list. The console fails closed with no approver on it, and recovery from that
  state is a redeploy rather than a documented happy path. Add a second account **in
  your domain** to `WA_APPROVER_EMAILS` and to the IAP binding before you need it.
- Some steps are manual and stay manual: the Google OAuth client and the org-policy
  decisions are yours to make. The installer names them and continues.

If you find something wrong, the design intends that finding it costs you a refusal
rather than an incident.

## About this wiki

It is not a public surface. Both wiki routes require a console session and answer
`401` with the locked page otherwise -- in place, at the URL you asked for, so
signing in returns you to the page rather than to a front door. Reading a page
costs the same sign-in the console does. **Systems manual** has the rest of the
route's behaviour.

Every object lives under `shared/wiki/` in your lake:

- `shared/wiki/_index.json` -- the nav tree, and simultaneously the slug allow-list.
  A page not listed here is not served, whatever exists in the bucket.
- `shared/wiki/_shell.html` -- the chrome and the markdown renderer.
- `shared/wiki/pages/<slug>.md` -- one object per page.

The coloured badge at the top of each page is a freshness verdict, computed on every
request and never cached in your browser. It is GREEN only when every artifact the
page's `watch` list names resolved and matched. Absent front-matter, an empty watch
list, or a lookup that failed are all RED. It fails safe: it will call itself
unverified rather than call itself current.
