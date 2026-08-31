---
page: the-strains
title: The strains
section: operate
status: live
audience: public
owner: unassigned
generated_by: starter-edition
verified_at: "2026-08-12"
verified_by: starter-edition
watch:
  - "lake:shared/wiki/_release.txt@71b8aebd9209c5b60ca8ccc1ef4bb906ec2a7a5e39d77743e915866794b5d323"
---

# The strains

A **strain** is a named agent identity on this install. It is not a model and it is
not a chat window. It is a role: a private folder in the lake, a lane in the journal,
its own work items, its own lessons file, and its own scope.

Three ship by default. They exist so you have somewhere to put work on day one, not
because the system needs exactly three. Add, rename, or delete them.

| strain | what it is for |
|---|---|
| `fleet-advisor` | the coordinator. Reads across lanes, keeps the state file, decides what happens next. |
| `fleet-gcp` | the cloud platform hand. Deploys, Cloud Run, IAM, org policy, quotas, billing. |
| `fleet-security` | the adversarial reader. Reviews changes, audits boundaries, says no. |

Two more identities are seeded and are not strains you assign work to: a default
low-privilege role that new connectors land on, and one service identity that holds no
session and runs nothing. Both are seeded `hidden`, so the roster you see is the three above;
they are service identities, not chats, and neither can be given a session key. Turn
either one on with `POST /api/strains/<role>/flags` if you want to watch it.

## Why identities at all

**Scope.** A strain reads `shared/...` and its own `agents/<its-own-role>/...` and
nothing else. It cannot read another strain's private folder. It sees its own work
items, not everyone's. If work is genuinely cross-cutting, you take it to the
advisor, which is the one role with a view across every lane.

**Write scope is narrower than read scope.** The control plane loads and executes
objects under the prefixes named by `LAKE_EXEC_PREFIXES`, so a write to one of them
is refused for every role including the one asking -- a role that could write them
would be code execution as the control plane. Reads are deliberately unaffected:
agents review that code, and denying reads would break audit work without closing
the hole. It is the first refusal most new strains meet. See **Systems manual**.

**Attribution.** Every journal row, every staged job, and every lake write carries the
role that did it. When you are staring at a job at the gate, "who asked for this" is
a fact you can read, not an inference.

**Blast radius.** A leaked session key is a leaked *role*, not a leaked system. It buys
the attacker that strain's scope and nothing outside it. Be clear about what that does
**not** bound: on the shipped defaults `PC_AUTO_APPROVE=1`, so a role that can call
`run_command` can cause a command to run. What bounds *that* is the IAM grant on the
executor's own service account, not the strain. **Authorisation** has the full picture.

**Separate memory.** Each strain accumulates its own lessons file. A security
reviewer and a publisher should not share a set of habits.

## What a strain still cannot do

None of them can execute. The advisor is the only role permitted to stage certain
gated jobs and to supersede another job, and staging is still just asking. Every
strain's privileged tools end at the gate. There is no strain with a bypass.

## Working with one

Pick the strain, mint a session key for it (see **Connect an agent**), and open a
chat. The first call is always `whoami`; it returns the role plus that strain's
scope and bootstrap.

Give a strain work by posting a work item against it. Read the journal to see what
actually ran. Do not report fleet state from memory -- read it.

## Adding and removing

Create a strain from the console. Creation writes a `strains` record and can mint
that strain's first session key, which is why it is an access-control action and sits
behind the gate session.

Deleting a strain removes its chat history, journal rows and work items, revokes
every session key bound to it, and hands you a backup key for the removed data.
Deletion is not reversible from the console.

## Naming

Names are yours. Keep them boring and functional -- a strain name shows up in the
journal, at the gate, and in this wiki, and it is the first thing you read when you
are trying to work out who staged the job in front of you at two in the morning. A
name that describes a job is useful. A name that describes a person is a liability
the day someone else has to operate this.
