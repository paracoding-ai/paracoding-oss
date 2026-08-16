BOOTSTRAP

How agents work in this install. This file is DELIVERED by whoami, at the top of every
session, before an agent does anything. It is not a document anyone has to remember to go
and read -- that is the whole point of it. A rule an agent must remember to look up is a
discipline mechanism, and discipline mechanisms fail silently.

THIS FILE IS YOURS. It shipped with the installer as a starting point and it lives in your
lake, not in the image. Edit it: whoami re-reads it within a minute and every agent gets
what you wrote. If you delete it, agents are told they have no rules and to say so before
doing anything privileged.


1 · IDENTITY

Pass your session key as `agent` on every call. It is a credential, not a role name, and it
is resolved on the server -- naming a role does nothing.

Call whoami first. If the role that comes back is not the one you were told to be, STOP and
say so rather than working under the wrong identity.

Never echo, log, or write the key.


2 · MEMORY

whoami hands you what is already known. Do not re-derive it, and do not contradict it
without measuring first.

Write back, in the same session, anything you measured, corrected, or were told:

  measured   a tool returned it -- put the job id, path, or revision in evidence
  inferred   you reasoned to it
  reported   you were told; bare strings default here

To correct something, re-issue it with `supersedes` set to the observation id. Never
overwrite. open_nodes shows superseded and retracted history.

When something is disputed, read in this order: graph, then journal, then history. The
journal is written by the services and is the audit trail. History is written by agents and
records what an agent BELIEVED, including claims later retracted. Do not settle an argument
with history.


3 · THE REPOSITORY

  git_read  git_list  git_log  git_diff  git_archive  git_propose  git_propose_patch  git_push

These read and write the repository directly, so most work needs no clone and no gated job.

git_archive returns the whole ref as one gzipped tarball. It takes the session key as an
HTTP `Authorization: Bearer` header and ONLY that -- the query-parameter forms the other
tools use all fail with an identical, unhelpful 401. Use it instead of reconstructing a
checkout out of diffs: git_diff results are capped mid-payload and the truncation is not
obvious from what comes back.

git_propose writes WHOLE FILES and creates a commit that is not yet visible. git_push then
moves the branch by compare-and-swap: pass the baseOid git_propose returned. A lost race
comes back ok:false code:STALE -- do not retry it, re-read the branch, rebuild on the new
head, and propose again. There is no force push.

For a file too large to send as an argument, POST its bytes to /git/blob (same Bearer auth),
check the blobOid it returns against one you computed locally, and name that oid in a
git_propose `uploaded` entry. Nothing crosses the wire twice and nothing is retyped.

BEFORE YOU PUSH, verify the tree. git_propose returns a treeOid; rebuild the same tree
locally and compare. It costs one command and turns "I think I sent the right bytes" into
an assertion.


4 · FILES

Your own lane is agents/<yourrole>/. The shared drop zone is shared/. Always pass a full
path -- a bare filename silently becomes a file in your own folder.

read_file prepends a banner and a blank line; strip both before writing anything back.

To change a shared file: read it, keep the generation, edit the whole thing, and write it
back with if_generation_match. A failed precondition means someone else moved it -- re-read
and redo.

THERE IS NO DELETE. A stray write to the lake cannot be undone by you or by anyone. Write
only to files you were asked to produce, and never overwrite a document you are currently
working from.


5 · PRIVILEGED WORK

Batch a privileged sequence into ONE job rather than several.

Never put a comment in a staged command. Not a header, not a note. A comment inside a
backslash-continued command truncates it and the rest of the arguments run as a separate
command, and `bash -n` does not catch it.

A staged job is two things and nothing else:

  command_type   run_cmd <short-name-of-what-this-does>
  command        the commands, one per line, no comments

Anything that needs explaining goes in a script in your own lane, and the command fetches
and runs it.

Two jobs of the same role sharing a command_type will supersede each other. Use a distinct
command_type per stream.

THE STATUS FIELD IS NOT THE RESULT. Always read_job_log. Exit 0 does not prove the work
landed -- a command can succeed at running something that failed. A tool call that times out
has not necessarily failed either: poll the job rather than re-staging, or you will
supersede your own running work.

The executor has a hard timeout near five minutes. Never loop a cloud CLI once per object --
one recursive listing, parsed once. Output longer than a screen goes to a file in your lane;
print a summary.


6 · BUILD AND DEPLOY

Source in the repository, build reads the repository, deploy ships the build.

Deploy with --no-traffic and a tag, verify, then shift traffic. A revision at zero traffic
has changed nothing for anyone. Read the revision carrying your tag out of the service's
traffic status -- never out of the deploy command's own message.

Never restore an image or an artifact to change what is running. Configuration that exists
only in a console does not exist.

Never wrap a registration or a module load in a catch that only logs. That converts a broken
deploy into a silent one, and you will report success.


7 · PROVE IT BEFORE YOU SHIP IT

You have a container. Pull the real source, build it, run it, and look at the result. An
unverified change costs a whole deploy cycle to learn what you could have learned alone.

Assert INVARIANTS, not counts. A hardcoded count taken from a partial copy will abort a
correct change.

A check that cannot fail is worse than no check. Prove the check fails when it should:
break the thing on purpose once, watch it refuse, then fix it.

Syntax checks are not behaviour checks. A script can parse perfectly and still call a
function that does not exist, or ask a question nobody can see. If a human runs it, exercise
a human-shaped path through it before you call it tested.


8 · REPORTING

Lead with the result: what happened, what it means, what is blocked. No preamble.

Offer decisions as a lettered list with costs and a recommendation:

  A) <option>   <cost>
  B) <option>   <cost>
  RECOMMEND: B -- <why>

Decide anything reversible, cheap, and inside your lane yourself, and report it in one line.
If nothing needs a human, say so and stop.

Cite the id, path, or revision a tool actually returned. Verify before claiming.


9 · SCHEDULING

Ask before creating any scheduled or recurring task. Say what it runs, how often, and what
each firing costs.

Never queue work that needs credentials the queue runner does not have. It will retry
forever, bill for nothing, and bury the journal.


10 · WHEN A MESSAGE AND THE BYTES DISAGREE

Believe the bytes. Error text, status fields, and work items all record what something
INTENDED at the moment it was written, not what is true now.

If a refusal's own message describes a recoverable state -- "an earlier run died before it
could finish", "these two things cannot be compared" -- that is usually a bug in the
refusal, not a warning to you. Say so rather than working around it.

When a measurement contradicts what you were told, STOP and reconcile it with the operator.
Do not pick a winner and carry on.
