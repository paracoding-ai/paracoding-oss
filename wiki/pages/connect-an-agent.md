---
page: connect-an-agent
title: Connecting an agent
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

# Connecting an agent

An agent reaches this system over MCP, against the **MCP service**, never the
console. Those are two Cloud Run services built from one image: `PC_SURFACE=console`
registers the browser pages and the `/api/*` those pages call, `PC_SURFACE=mcp`
registers `/mcp`, the OAuth and discovery endpoints, and the legacy bearer-token agent
API. The split exists because IAP on Cloud Run is one switch per service with no
path-level carve-out, and the two halves need opposite answers: the console is behind
IAP, the MCP service has IAP **off** and carries a public `roles/run.invoker` binding
so a client can reach it at all -- the application does its own bearer auth once the
request is inside. Handing a connector the console URL is the mistake the split exists
to prevent.

(If you left `PC_SURFACE` unset you are running one service carrying every route, which
is supported and is the pre-split behaviour byte for byte. Then there is one host and
the distinction below collapses. The installer sets both surfaces, so on an installed
fleet you have two hosts and they are not interchangeable.)

## The URL

```
https://<your-mcp-service-host>/mcp
```

The installer printed this host when it finished. If you have lost it:

```
gcloud run services describe <mcp-service> \
  --region <your-region> --project <your-project> \
  --format 'value(status.url)'
```

Then append `/mcp`. The path matters. The bare host is not an MCP endpoint.

**Do not use the console host.** The console is behind Identity-Aware Proxy, IAP
consumes the `Authorization` header, and an MCP client has no Google identity to
present. A client pointed at the console gets refused at Google's edge and never
reaches your container. This is the single most common connection failure. See
**Troubleshooting**.

**And the mirror image of that mistake, which is harder to read.** The console's own
session guard is an `app.use` middleware, not a route registration, so the `PC_SURFACE`
filter -- which only wraps `app.get`/`app.post`/etc. -- never sees it and it is
installed on **both** services. Ask the MCP host for a console path (`/chat`,
`/api/shell/*`, `/api/chat`, `/api/keys/*`, `/api/vm/*`, `/api/ops/*`,
`/api/security/*`) and you get a console-shaped `403`:

```
forbidden: no console session. Open the console host in a browser and sign in.
If you are calling the MCP host, this path is not on that surface.
```

That message names both possibilities on purpose, because the failure it describes is
ambiguous from the outside: on the MCP surface there is no IAP and there is never a
session cookie, so the sentence about signing in can never be the fix there. **Being
answered by that middleware is not evidence that you reached the console.** If you see
it, check which host you asked before you go looking for a login problem.

## Two ways to authenticate

### 1. OAuth, for clients that support it

The MCP service serves OAuth 2.1 and its discovery documents. A client that speaks the
connector flow will walk you through authorising it in a browser. The role the connector
acts as is resolved server-side from the bearer token; the installer sets
`OAUTH_DEFAULT_ROLE=fleet-onboarder`, so new connectors land on a low-privilege default
role, not on a privileged one.

**On a fresh install, OAuth alone does not get you a working chat, and this catches
people.** The installer sets `PC_SESSION_ENFORCE=1` on both services. With it on, the
bearer identity carries the handshake and tool enumeration and nothing else: any
`tools/call` that arrives without a session key in its `agent` argument is **denied**,
with a message saying so. The reason is structural rather than cautious -- an MCP
connector in Claude is *account-level*, one connector serving every chat on the account,
so if the bearer were sufficient then every chat you ever open would resolve to the same
identity and none of them would be the strain you meant. OAuth is how the client
attaches. A session key is how a chat acquires an identity.

### 2. A session key, for everything else

Mint one from the console: reach the console host through IAP as an account on the
approver allow-list, and click **Session pastes** in the harness header. You get a paste
block to drop into a new chat.

The panel used to live on the gate console. `/gate` is deleted, and the minter moved
into `control-plane/src/harness.html` -- it appends itself to the header at runtime and
calls the same two endpoints it always called, `GET /api/sessions/roles` and
`POST /api/sessions/mint`, both session-gated and both classed `console`. So this was a
move of the UI, not a new capability. `/flowhood` still exists and, for a caller with a
valid session, is a redirect to `/harness`, so either name reaches the same page.
Several strings inside the running code still tell you to mint "at the Flow Hood
(Autoclave, New strain session)" -- that is this page, under its older names.

**Not every strain is offered.** The role list is a fail-closed allow-list: a strain
appears only if it is `active` *and* explicitly marked `pasteable`, and the mint route
re-checks both and returns `403 role is not pasteable` otherwise. A strain provisioned
later is **not** pasteable until a human marks it (`POST /api/sessions/roleflags`). The
reason is that `active` and `pasteable` answer different questions: a service identity
(the unpasteable OAuth default, or `fleet-breakglass` as a recovery path) must stay off
the mint list -- neither should ever become a chat's identity. If the strain you
want is missing from the list, that flag is why, and it is the correct direction for a
switch that hands out identity.

Three things about session keys, and all three matter:

**The key is shown once.** Only its SHA-256 hash is stored. Lose it and you mint another;
there is no recovery path, by design.

**It is a credential, not a role name.** The value begins with the prefix `pcs_`
followed by random bytes. You pass it as the `agent` argument on **every** tool call, not
just the first. The server hashes it and looks it up. Passing the *name* of a role --
typing something that looks like a role identifier into that argument -- resolves to
nothing and the call is refused. It is not downgraded to a weaker role and it is never
silently upgraded to a stronger one. That last clause is not decoration: an earlier cut
gated the fallback on `PC_SESSION_ENFORCE`, so one mistyped character in a pasted key
silently promoted the chat to `fleet-advisor`. A presented-but-unrecognised key is now an
error, never an absence. A batch request carrying more than one distinct key is refused
as `mixed` rather than resolved to whichever one came first.

**It expires.** Seven days by default, tunable with `PC_KEY_TTL_DAYS`. The expiry is
enforced server-side off the stored record, never from anything the caller presents. A
record with no expiry field is grandfathered valid, because keys minted before the field
existed predate it and treating absent-as-expired would have cut every live chat on
deploy. When one lapses the chat is told so, and you mint a fresh paste.

A key can also be minted **restricted**, with an explicit `tool_classes` list. That is
subtractive only -- it can take classes away from what the strain already holds, never
add one -- and the restriction is honoured unconditionally, not behind
`PC_TOOLS_ENFORCE`, so a tool withheld by a key restriction is absent from `tools/list`
rather than merely refused on call.

Once resolved, the role is fixed for the whole request. No tool argument can change it
mid-call.

## First call, every session

Have the agent call `whoami` before anything else. It returns the role actually resolved,
plus the memory digest and the bootstrap describing how work is done on this install. An
agent that skips it re-derives things the system already knows.

`whoami` is also the floor: an identity that is not an active strain in the registry is
admitted with a **whoami-only** server -- no lake, no journal, no staging, nothing that
writes or runs -- and that connection's `whoami` says so in as many words. If an agent
reports that it has exactly one tool, it is not broken; it is unprovisioned.

## Using a client that is not this console

`agent-plugin/` in the release directory is an Agent Plugins package -- the
vendor-neutral format for wrapping an MCP server into a portable directory. Point any
client that reads that format at it.

`agent-plugin/mcp.json` ships with a **placeholder URL**, because your Cloud Run
hostname does not exist until you install. The installer prints the exact value to
substitute and writes a resolved copy beside it (`agent-plugin.local/`) that is not part
of the signed manifest.

One stale pointer to know about, measured in this release tree on 2026-08-14 rather than
assumed: the packaged `agent-plugin/README.md` and the installer's closing summary both
still tell you to mint a key at `<your-host>/pastes`. That route was deleted with the
gate and answers `404`. Mint from the harness header as described above. If your copy has
been corrected in a later cut, this paragraph is the stale one -- check the tree.

## What the agent can and cannot do once connected

It can read your lake under `shared/` and its own `agents/<role>/` folder, read and write
memory, read the journal, post and complete work items, and write files.

**It can also run privileged work, and on a fresh install it does so immediately.** There
is no staging-and-waiting step for `run_command`: the installer ships `PC_AUTO_APPROVE=1`
and `PC_GUARDRAILS=0` on both services. What actually happens when an agent calls
`run_command`:

- A job document is written first, so the record exists before anything executes, and
  `staged_by` names the role that asked.
- The control plane then stamps a **real** pre-approval into the same Firestore fields
  the legacy approve route used to write, signs it with the same Cloud KMS asymmetric
  key over the same `PC-APPROVAL-CANON-V2` bytes, and fires it. Nothing was bypassed --
  the executor verifies that signature exactly as it verified a human's.
- The approver inside the *signed* bytes reads `auto:lockout-check`, because there is no
  person in that path and a transcript must never be readable as someone having approved
  when nobody did.

So there is no queue to watch and no tap to wait for. The ceiling is IAM, and
specifically the executor's own service account: with no human in the path the control
plane forwards an **empty** access token, so the body runs under the executor's own
scoped identity rather than borrowing a live human's credential. What an auto-run job can
do to your project is exactly what that service account is granted and no more. If you
want a narrower blast radius, that grant is the lever -- not a confirmation prompt.

Destructive and lockout-class work is **journalled, not refused**, on the shipped
defaults. A command the classifier calls destructive runs; a body matching one of the
lockout-class rules in `gate-exec/lockout_check.py` runs too, and the executor writes
`exec_lockout_class_ran` naming the rules that matched, so the transcript can answer what
took the console out without anyone guessing. Setting `PC_GUARDRAILS=1` restores both
refusals: the control plane hands a destructive command back to chat instead of running
it, and the executor answers `403`, which the control plane relays upward as a question
naming the rules. Saying yes then re-issues the job with `confirm=true`, which rides as
`lockout_ack` **inside** `arguments` -- covered by the approval signature, so it cannot
be added in transit.

None of that touches the pre-ship checks, and the distinction is the whole point:
`oss/gen.py`'s cut refusals, `control-plane/route-audit.mjs`, `blob-audit.mjs`, the leak
ceilings, `devgate/smoke.py` and the compare-and-swap on `git_push` all still bite.
Checks that fail a **cut** stayed. Refusals that stop a **run** went.

**The seven git tools are registered, and there is nothing for you to do.** The installer
creates the git object bucket, grants the control plane `objectAdmin` on that bucket
alone, and sets `GIT_REPO_ID` and `GIT_BUCKET` **on the MCP service** -- the pair
`gittools.ts` requires before it registers anything, and the right service, because these
are MCP tools and setting the variables on the console does nothing. The installer's own
tool census **fails the install** if all seven are not registered afterwards, so a green
run is a measurement that they are there. See **Changing the code**.

`vm_*` and `browser_*` are not on this surface. 12.0 has no workstation and no Chrome
DevTools bridge. Setting `WS_VM` or `WS_CDP_PORT` does not bring them back.

## Revoking

Deleting a strain revokes every session key bound to that role: the delete route walks
`session_keys` for that role and marks each one revoked, and it reports the count back in
its response.

An individual key is revoked with `POST /api/sessions/revoke`, which is session-gated
like everything else on the console surface. It takes an **id prefix**, and that id is
the one `GET /api/sessions` lists -- the first twelve characters of `sha256(key)`, not
the key. A prefix of a hash is not a credential, which is why the listing can safely show
it. There is no button for this in the console HTML that ships today (measured: no
occurrence of `revoke` in `control-plane/src/*.html`), so it is a call you make from a
browser that already holds an unlocked console session.

**Revocation takes effect within about a minute, not the same instant, and the earlier
claim that it was immediate was wrong.** The lookup does happen on every call rather than
being frozen into a long-lived session -- there is no such session here -- but it sits
behind a 60-second per-instance cache. The revoke route clears that cache in the instance
that served it; any other running instance keeps honouring the key until its own entry
ages out. Strain deletion clears no cache at all and relies entirely on the TTL. Sixty
seconds is the honest number to plan around.
