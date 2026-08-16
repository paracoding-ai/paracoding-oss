#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# fleet-gate-exec -- the GATED EXECUTION ENGINE (the crown jewel)
# SECURITY MODEL:
#  * Option A: Approver-scoped ephemeral credentials. Approved jobs run AS THE HUMAN who approved them.
#  * This SA is MINIMAL. It has NO standing org-admin/editor roles. It only reads pending_confirms, injects ephemeral creds, and runs the script.
#  * Triggers via POST /run with {"job_id": "...", "access_token": "...", "script_b64": "..."}, verifies pending_confirms/{job_id} == 'executing'/'confirmed'.
#  * Full audit/journal of every run.
#
# --- EXEC-ALLOWLIST-OBSERVE-A-v1 : THE FIRST-TOKEN ALLOWLIST IS OBSERVE-ONLY BY DEFAULT ---------------
#  READ THIS BEFORE YOU "HARDEN" IT BACK. Standing this control down was deliberate.
#
#  WHAT IT DID: the allowlist below checks the FIRST TOKEN OF EVERY LINE of an
#  already-approved script against {echo, gcloud, firebase, npm, node, python3}.
#  Every real staged job opens with `set -uo pipefail`, so first_token == "set"
#  -> HTTP 400 and NOTHING RAN. Variable assignments (D=gs://...), `if`, `else`,
#  `fi`, `for` and `exit` all died the same way. This is not a corner case; it is
#  every multi-line job the fleet stages.
#
#  WHY FAIL-OPEN IS CORRECT *HERE SPECIFICALLY*: this check had sat UNSHIPPED in
#  the lake for a long time. A Cloud Shell deploy pushed the lake copy live for the
#  first time and it went live as a surprise. IT WAS NEVER LIVE BEFORE, so enforcing
#  it was a REGRESSION -- not a protection being removed -- and its enforcement is
#  what broke production. Defaulting to observe restores the behaviour this endpoint
#  actually shipped with for its whole life.
#
#  A first-token check is a WEAK control, and it is NOT what makes this endpoint
#  safe. The approval flow already guarantees far more:
#    * a HUMAN approved this exact command at the gate -- the pending_confirms
#      status check below still refuses anything not confirmed/executing, and
#    * the command-pin below refuses any presented script_b64 whose sha256 does
#      not match the sha256 of the command on the approved job document, so the
#      request body cannot substitute a different script for the approved one.
#      [SEC-EXEC-CMD-BRICK-V1] SAY WHAT THIS ACTUALLY DOES. An earlier revision of this
#      header claimed the pin guarantees the executing bytes are BYTE-IDENTICAL
#      to the approved bytes. IT DOES NOT. It compares against arguments.command
#      (or .cmd) RE-READ FROM FIRESTORE AT EXECUTION TIME, not against a digest
#      captured when the human approved. Anything able to write the job document
#      between approval and execution moves BOTH sides of that comparison
#      together, and the pin still passes. Closing that needs an approval-time
#      hash (approved_sha256) compared with a fallback for documents predating
#      the field; that change is specified but deliberately NOT made here.
#      [SEC-APPROVED-SHA-REQUIRED-V1] BOTH HALVES LANDED LATER AND THE FALLBACK IS NOW
#      GONE. The approval-time hash is stamped by EVERY approval path, and a document
#      that carries none is REFUSED below rather than excused. The sentence above is
#      kept as written because it was true of the change that wrote it.
#      Do not cite byte-identity as a reason to stand any other control down.
#  Neither of those is touched by this change.
#
#  IT IS NOT A SILENT BYPASS. Observe mode JOURNALS every non-allowlisted first
#  token as action "exec_allowlist_observe", so a skip is visible in the journal and
#  can never be mistaken for the check having passed -- that exact confusion is a
#  documented recurring defect in this fleet. Those journal rows are also the data
#  needed to decide whether enforcement is ever worth turning on.
#
#  SUPERSEDED 2026-08-16 BY [EXEC-BIN-JAIL-V82]. EXEC_BINARY_ALLOWLIST_ENFORCE NO LONGER
#  EXISTS -- it was deleted rather than defaulted off, because a switch whose documented
#  effect is "HTTP 400 on every multi-line job" is a footgun aimed at production. The scan
#  described above survives as TELEMETRY ONLY and was never a boundary.
#  THE BOUNDARY IS NOW A PATH JAIL: the child process runs with PATH restricted to a
#  directory of symlinks to the permitted binaries, so an unlisted binary does not resolve.
#  Builtins and keywords do not use PATH, so `set -uo pipefail` -- the line that broke
#  production last time -- cannot be affected. Disable with EXEC_BIN_JAIL=0.
#  KNOWN GAP, MEASURED NOT ASSUMED: an ABSOLUTE PATH still runs. This is a real control,
#  not a sandbox.
# ----------------------------------------------------------------------------------
import os, subprocess, tempfile, json, base64, hashlib, hmac
from flask import Flask, request, jsonify

# ---- [SEC-EXEC-NO-DATASTORE-V1] NO FIRESTORE CLIENT, AND NO FIRESTORE IMPORT ----
# THE GRANT IS GONE. roles/datastore.user -- read AND write on every document in every
# collection, the largest standing grant in the fleet -- is no longer held by this service
# account. install.sh REMOVES it, then reads the project policy back and DIES if any
# roles/datastore.* role is still bound to this account, so a future edit that adds it back
# fails the install rather than shipping.
#
# THREE COMMITS MADE THAT POSSIBLE AND EACH PAID FOR PART OF IT. PC-APPROVAL-CANON-V2
# extended the approval signature to cover command_type and a hash of the arguments, so the
# execution context no longer rests on database integrity. EXEC-BUCKET-V1 moved the
# single-use claim, the result and the journal onto objects in a bucket where this service
# holds roles/storage.objectCreator and NOT objectViewer. This commit removes what is left.
#
# THE IMPORT IS DELETED RATHER THAN LEFT UNUSED, AND THAT IS WHY THIS LINE IS BLANK RATHER
# THAN COMMENTED OUT. An unused import is one edit away from being used, and the next person
# who needs "just one read" would find a client already constructed and a module already
# imported. There is nothing here to reach for: a grep for firestore in this file returns
# comments and nothing else.
#
# WHERE THE JOB DOCUMENT WENT. Everything this service used to read off pending_confirms now
# arrives in the REQUEST BODY under "approval", placed there by the control plane, which does
# hold the read. Every field that decides WHAT RUNS is inside the PC-APPROVAL-CANON-V2 signed
# bytes, so altering one in transit does not change what runs -- it destroys the signature.
# run() names the fields that are covered, the one that is redundant, and the two that did
# not survive the move, with the argument for why losing the second class is acceptable.

app = Flask(__name__)
MAX_SECONDS = int(os.environ.get("EXEC_TIMEOUT", "900"))
# [SEC-NAMED-DB-V1] said: match the control plane, our own named database, never (default).
# It was right while there was a client to configure. There is no client, so there is no
# database to name, and PC_FIRESTORE_DB is now read nowhere in this file.

def log_journal(action, message, job_id=None):
    # ---- [EXEC-BUCKET-V1] THE OBJECT IS WRITTEN FIRST, AND IT IS THE RECORD ----
    # WHY THIS SERVICE JOURNALS AT ALL, restated because it is the thing that must survive
    # the move: it journals INDEPENDENTLY of the control plane, so a compromised control
    # plane cannot suppress the record of a refusal it caused. That property is worth
    # nothing if the writer can also edit what it wrote. Under roles/datastore.user this
    # service can rewrite or delete any of these rows; under roles/storage.objectCreator on
    # the bucket -- create, no read, no overwrite, no delete -- it cannot. The object write
    # therefore goes FIRST and is the one that counts.
    #
    # [SEC-EXEC-NO-DATASTORE-V1] THE MIRROR IS DELETED, EXACTLY AS THE PARAGRAPH ABOVE SAID
    # IT WOULD BE. A Firestore write sat below this one as the legacy mirror, kept only while
    # roles/datastore.user still existed so the gate page and read_journal would not go blank
    # mid-migration. The grant is gone, so the mirror goes with it -- and the rows still reach
    # the collection, written by the control plane ingest [EXEC-BUCKET-INGEST-V1] out of these
    # very objects. That is what made the mirror redundant BEFORE it was removed rather than
    # after, and it is the only order in which removing it is safe.
    #
    # THE DELETION IS A GAIN, NOT A COST. This service can now append an audit record and can
    # never re-read, amend or delete it. Holding datastore.user it could rewrite its own
    # journal rows, and a service that can edit its own audit trail does not have one.
    #
    # THE WRITE CANNOT BLOCK A REFUSAL. It is wrapped, it fails to stdout, and it returns a
    # value no caller tests. A journal that can veto the decision it is journalling is a worse
    # failure than a missing line.
    try:
        pc_write_journal_object(action, message, job_id)
    except Exception as e:
        print(f"Failed to write journal object: {e}")

# ---- [EXEC-SINGLE-USE-V1] ----
# ONE APPROVAL = ONE RUN, AND AN APPROVAL GOES STALE.
# The status field is not a ticket, it is a mood. Four producers write a status
# this service accepts and none of them tear it up: waLegacyApply writes
# "confirmed" and executes nothing; the legacy REST /api/confirm/verify writes
# "confirmed" and fire-and-forgets a POST /run with no Authorization header,
# which our own edge drops, stranding the job; waRunGodmode and /api/jobs/fire
# write "executing" before calling us.
# [APPROVAL-INTEGRITY-V1] pinned WHAT runs to the approved command. It cannot
# refuse the SAME approved command presented a second time -- the sha matches,
# so it must pass -- and it cannot tell a tap from a minute ago from a tap from
# last week. So a stranded approval was a bearer token with no expiry, and the
# only thing that ever ended one was the terminal "executed" write at the END of
# a successful run: a crash mid-run left it live again.
# Two controls, here, because this is the one chokepoint every path traverses:
#   claim_job_for_execution() consumes the approval atomically BEFORE the
#     subprocess, in its own field, so no status write and no stale gate page can
#     un-spend it; the transaction re-reads status, so it is a compare-and-set
#     too and a job denied or superseded mid-flight is refused, not run.
#   approval_staleness_refusal() bounds how long a "confirmed" job stays
#     spendable. "executing" is never bounded, so the two live paths that set it
#     immediately before calling us are untouched.
# Both fail CLOSED: if the check cannot be completed, nothing runs.
# datetime is imported HERE, not on the module's existing import line, so the
# [APPROVAL-INTEGRITY-V1] edit to that line is left exactly as it was applied.
import datetime as _dt

APPROVAL_MAX_AGE = int(os.environ.get("EXEC_APPROVAL_MAX_AGE_SECONDS", "3600"))

# ---- [EXEC-BUCKET-V1] ONE CREATE-ONLY BUCKET, AND WHY IT IS STRONGER THAN THE DATABASE ----
# THE PRIVILEGE THIS EXISTS TO RETIRE. This service holds project-wide roles/datastore.user:
# read AND write on every document in every collection, because Firestore IAM has no
# per-collection granularity. It is the largest standing grant in the fleet. Exactly three
# things needed it -- the single-use claim below, the result write at the end of a run, and
# this file own journal writes -- and all three move HERE, onto objects in ONE bucket on
# which this service is granted roles/storage.objectCreator AND NOTHING ELSE. No
# objectViewer, no objectAdmin, no legacy bucket-writer.
#
# WRITE-ONLY IS NOT A LIMITATION, IT IS THE ARGUMENT. With create and no read, no overwrite
# and no delete, this service can APPEND an audit record and can never re-read it, amend it
# or remove it. Today, holding datastore.user, it can rewrite its own journal entries and
# its own result documents -- a service that can edit its own audit trail does not have one.
# So on the journal and the result this is not a like-for-like port to a different store: it
# is STRICTLY STRONGER than what it replaces, and it is stronger from this commit, before
# roles/datastore.user is dropped rather than after.
#
# ifGenerationMatch=0 IS AN ATOMIC CREATE-IF-ABSENT, and it is the whole reason a claim can
# live under create-only permission. The write lands only when NO object exists at that
# name; when one does, Cloud Storage writes nothing and answers 412. THE 412 IS THE READ --
# it is how a principal that may not read learns that a name is taken, and it is the only
# read it needs. Two racing creates of one name are serialised by the object generation, so
# exactly one gets a 2xx and every other gets 412: the same exactly-once guarantee the
# Firestore transaction gave, taken from the storage layer instead of the database.
#
# THE THIRD OUTCOME IS THE ONE THAT MATTERS. A 403, a 500, a timeout, a DNS failure and a
# token that could not be minted are none of them "created" and none of them "exists". They
# are UNKNOWN, they are kept as a third answer all the way to the caller, and the caller
# REFUSES on them. "I could not tell whether this approval was already spent" is not
# permission to spend it.
PC_EXEC_BUCKET = os.environ.get("PC_EXEC_BUCKET", "")
PC_GCS_HOST = os.environ.get("PC_GCS_HOST", "https://storage.googleapis.com")
PC_CLAIM_PREFIX = "claims/"
PC_RESULT_PREFIX = "results/"
PC_JOURNAL_PREFIX = "journal/"
PC_BUCKET_TIMEOUT = int(os.environ.get("EXEC_BUCKET_TIMEOUT", "20"))
import urllib.parse as _pc_urlparse

# _pc_urlreq / _pc_urlerr / _pc_metadata_token are defined further down this file, beside the
# signature verifier that also speaks HTTP. Python resolves globals at CALL time, so the
# helpers here are whole long before the first request is served. They are written here, next
# to the claim, because the claim is the reason they exist.


def pc_arming_refusal():
    """The two configuration facts this service may not serve a job without. Returns a reason
    string, or None when the service is armed.

    [SEC-EXEC-NO-DATASTORE-V1] WHY THIS EXISTS AT ALL, AND WHY IT IS A REFUSAL RATHER THAN A
    WARNING. Both of these used to be OPTIONAL because a Firestore path stood behind them,
    and in both cases that path was the thing this commit removed. A default that was merely
    permissive while there was a fallback becomes UNPINNED once the fallback is gone, and an
    unpinned executor is the one outcome worse than an executor that refuses.

      PC_EXEC_BUCKET unset. It used to fall back to the Firestore claim transaction. There is
        no transaction now, so an unset bucket is not a degraded mode -- it is single-use
        protection that does not exist. A fallback that needs the grant would keep the grant
        alive as dead code, which is precisely what this commit is removing, so the bucket is
        REQUIRED and its absence is a refusal with a message that says which variable.

      APPROVAL_REQUIRE_SIGNED not "1". With a signature present, approved_sha256 duplicates
        the signed csha field. With the flag at "0" an UNSIGNED approval reaches the command,
        and approved_sha256 was the only thing pinning it -- a value that used to be re-read
        from a document this service could not write, and that now arrives in the request
        body from the caller alongside the command it is supposed to pin. Both sides in one
        hand is not a pin. So dropping the read creates a hard dependency on this flag, and
        the dependency is ENFORCED here rather than assumed in a comment: unsigned approvals
        are refused because they cannot be checked, not because a default happens to be set.

    READ AT CALL TIME, not captured at import, so /healthz reports the state the next request
    will actually meet rather than the state this process started in."""
    if not PC_EXEC_BUCKET:
        return ("this executor has no PC_EXEC_BUCKET configured. The single-use claim, the "
                "result and the journal are objects in that bucket and there is no longer any "
                "other place for them: the Firestore fallback was deleted together with this "
                "service's roles/datastore.user grant. Set PC_EXEC_BUCKET on this service to "
                "the name of a bucket on which it holds roles/storage.objectCreator")
    if os.environ.get("APPROVAL_REQUIRE_SIGNED", "0") != "1":
        return ("this executor requires APPROVAL_REQUIRE_SIGNED=1 and it is not set. Since "
                "roles/datastore.user was removed, every field describing the approval "
                "arrives in the request body, and the ONLY thing that makes those fields "
                "trustworthy is the approval signature -- which covers the job id, the "
                "command digest, the command_type and a hash of the arguments. With the "
                "requirement off, an approval carrying no signature would reach the command "
                "with nothing pinning it at all. Set APPROVAL_REQUIRE_SIGNED=1 on this "
                "service, from the deploy surface, not through the gate")
    return None


def pc_obj_part(s):
    """A job id is an identifier, not a path, and an object name is a path.

    Maps one id to one bounded, slash-free name part -- DETERMINISTICALLY, because the claim
    name must be a pure function of the job id or the claim is not a claim -- and appends a
    short digest of the original so two ids that flatten to the same characters can never
    collide on one name and silently claim each other."""
    t = str(s)
    keep = "".join(c if (c.isalnum() or c in "._-") else "_" for c in t)[:96]
    return keep + "-" + hashlib.sha256(t.encode("utf-8")).hexdigest()[:16]


def pc_bucket_create(name, payload):
    """Create ONE object, ONLY if nothing is at that name. NEVER RAISES. Returns exactly one of

        ("created", None)    nothing was at that name; this call put it there
        ("exists",  detail)  something IS at that name -- HTTP 412 from ifGenerationMatch=0
        ("unknown", detail)  ANY other outcome at all

    The three are never merged. A caller that got "unknown" has not been told the name was
    free and has not been told it was taken."""
    if not PC_EXEC_BUCKET:
        return ("unknown", "no bucket is configured (PC_EXEC_BUCKET is unset)")
    try:
        tok = _pc_metadata_token()
    except Exception as e:
        return ("unknown", "no access token could be minted for Cloud Storage (%s)"
                           % e.__class__.__name__)
    url = (PC_GCS_HOST + "/upload/storage/v1/b/"
           + _pc_urlparse.quote(PC_EXEC_BUCKET, safe="")
           + "/o?uploadType=media&ifGenerationMatch=0&name="
           + _pc_urlparse.quote(name, safe=""))
    body = payload if isinstance(payload, bytes) else payload.encode("utf-8")
    req = _pc_urlreq.Request(url, data=body, method="POST",
                             headers={"Authorization": "Bearer " + tok,
                                      "Content-Type": "application/json; charset=utf-8",
                                      "Content-Length": str(len(body))})
    try:
        with _pc_urlreq.urlopen(req, timeout=PC_BUCKET_TIMEOUT) as r:
            code = int(getattr(r, "status", None) or r.getcode())
    except _pc_urlerr.HTTPError as e:
        if e.code == 412:
            return ("exists", "an object already exists at %s" % name)
        # The code ONLY. A Cloud Storage error body can echo the bucket and the object path
        # back, and a refusal message written here is permanent.
        return ("unknown", "Cloud Storage refused the write with HTTP %d" % e.code)
    except Exception as e:
        return ("unknown", "the write to Cloud Storage did not complete (%s)"
                           % e.__class__.__name__)
    if 200 <= code < 300:
        return ("created", None)
    # urllib turns >=400 into HTTPError, so this is a 3xx or a 1xx: neither a create nor a
    # 412, therefore unknown, therefore a refusal.
    return ("unknown", "Cloud Storage answered HTTP %d, which is neither a create nor a 412"
                       % code)


def pc_now_stamp():
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:23] + "Z"


def pc_write_journal_object(action, message, job_id):
    """Append ONE journal object. Returns the outcome string; never raises, never logs through
    log_journal (that would recurse), and never blocks a refusal on its own failure.

    ONE OBJECT PER ENTRY, under a per-job prefix, named by time and by 8 random bytes: entries
    are appended, never accumulated into one object that would have to be read back and
    rewritten -- which create-only permission cannot do, and which is exactly the mutability
    this move is getting rid of."""
    if not PC_EXEC_BUCKET:
        return "skipped"
    name = (PC_JOURNAL_PREFIX + pc_obj_part(job_id or "no-job") + "/" + pc_now_stamp()
            + "-" + hashlib.sha256(os.urandom(16)).hexdigest()[:16] + ".json")
    body = json.dumps({"agent_id": "fleet-gate-exec", "action": action,
                       "message": message, "job_id": job_id or "",
                       "written_at": pc_now_stamp()}, sort_keys=True) + chr(10)
    outcome, detail = pc_bucket_create(name, body)
    if outcome != "created":
        # print() and nothing else. Journalling a failure to journal through the journal is
        # how a loop starts, and Cloud Run captures stdout.
        print("journal object %s not written: %s (%s)" % (name, outcome, detail))
    return outcome


def pc_write_result_object(job_id, payload):
    """Write THE result of one run as one object, before the executor returns.

    ifGenerationMatch=0 again, for a different reason: one approval buys one claim buys one
    run, so a second result for a job id means something has gone wrong and the FIRST result
    is the one to keep. Create-only cannot overwrite anyway -- this makes the refusal legible
    instead of a bare 403."""
    name = PC_RESULT_PREFIX + pc_obj_part(job_id) + ".json"
    outcome, detail = pc_bucket_create(name, json.dumps(payload, sort_keys=True) + chr(10))
    return (name, outcome, detail)


class ExecClaimUnknown(Exception):
    """The claim outcome could not be established. NEVER means "the name was free"."""
    pass


def approval_staleness_refusal(job):
    """Returns a refusal reason for a stale approval, else None.

    [SEC-EXEC-NO-DATASTORE-V1] THIS CHECK NOW RUNS ON A SIGNED FIELD, AND THAT IS THE WHOLE
    CHANGE. It used to bound job['confirmed_at'] and only for status == 'confirmed'. Both of
    those were Firestore reads, and BOTH WERE UNSIGNED: confirmed_at is stamped by the control
    plane with a server timestamp and appears in no canon, so once the job document arrives in
    the request body a caller could simply say the approval was confirmed a second ago.

    approval_sig_iat IS A CANON FIELD -- field seven of nine in PC-APPROVAL-CANON-V2, field
    five of seven in V1 -- so it is inside the signed bytes and cannot be moved by anyone who
    cannot sign. This is therefore not a like-for-like port: bounding a signed timestamp is
    STRICTLY STRONGER than bounding an unsigned one, and it is strictly stronger from the
    commit that removes the read rather than from some later one.

    TWO SMALLER THINGS ALSO GET BETTER, NEITHER OF THEM ACCIDENTAL:
      * The status test is gone, so 'executing' is bounded too. It never was. The two live
        paths that write 'executing' call /run immediately, so their iat age is ~0 and nothing
        real changes for them -- but "this state is never bounded" was a hole whether or not
        anything was walking through it.
      * The refusal no longer depends on the field being ABSENT to notice a problem. An
        approval that reaches here has verified, so iat is present, well-formed and signed, or
        pc_verify_approval_signature already refused it. The absence branch below is therefore
        unreachable in practice and is kept anyway, because a control whose correctness rests
        on another control having run is one refactor from being wrong.

    WHY THIS IS KEPT AT ALL WHEN THE SIGNATURE CARRIES ITS OWN exp. The signer chooses exp
    (APPROVAL_SIG_TTL_SEC, default 3600s). This bound is chosen by the EXECUTOR'S operator
    (EXEC_APPROVAL_MAX_AGE_SECONDS, default 3600s) and can be set BELOW it. A control plane
    cannot widen it by stamping a longer exp, so it is the one age bound on this path that
    does not depend on the signer's configuration. 0 disables (escape hatch, not recommended).
    """
    if APPROVAL_MAX_AGE <= 0:
        return None
    ts = job.get("approval_sig_iat")
    if ts is None or ts == "":
        return ("this approval carries no approval_sig_iat, so the age of the approval cannot "
                "be established from a signed field; refusing rather than trusting it")
    # _pc_parse_rfc3339 is defined further down this file, beside the verifier that reads the
    # same two timestamps. Python resolves globals at CALL time, so it is whole long before
    # the first request; it is deliberately not duplicated here, because two readers of one
    # timestamp format is how the two disagree.
    when, why = _pc_parse_rfc3339(ts)
    if why:
        return ("this approval's approval_sig_iat could not be read (%s); refusing rather "
                "than trusting it" % why)
    age = _dt.datetime.now(_dt.timezone.utc).timestamp() - when
    if age > APPROVAL_MAX_AGE:
        return ("this approval was signed %d seconds ago (limit %d). A human approval is not "
                "a standing authorisation; re-approve it" % (int(age), APPROVAL_MAX_AGE))
    return None


def claim_job_for_execution(job_id):
    """Atomically consume this approval. Returns (claim_id, None) on success, or
    (None, reason) if it was already spent or is no longer approvable. Raises on
    transport error; the caller refuses.

    [EXEC-CLAIM-BUCKET-V1] THE CLAIM IS NOW AN OBJECT, AND HERE IS EVERY PROPERTY THE
    FIRESTORE TRANSACTION HAD AND WHERE EACH ONE WENT.

      1. EXACTLY ONE CLAIM PER APPROVAL. Was: a transaction that read exec_claim_id and
         refused if it was set. Now: one object per job under claims/, created with
         ifGenerationMatch=0. The name is a pure deterministic function of the job id, so
         every run of a job aims at the SAME name, and the second one to arrive is refused
         by Cloud Storage itself. No read permission is needed to learn that -- the 412 IS
         the read.

      2. ATOMICITY UNDER CONCURRENCY. Was: transaction serialisation. Now: object generation
         serialisation. Two fires of one job id racing at the same instant both attempt the
         same name; the generation precondition admits exactly ONE (2xx) and refuses every
         other (412). Neither primitive can produce two winners.

      3. FAIL CLOSED ON ANYTHING ELSE. Was: the transaction raised and the caller refused.
         Now: pc_bucket_create returns "unknown" for a 403, a 500, a timeout, a DNS failure
         or an unmintable token, and this function raises ExecClaimUnknown, which the caller
         refuses on with 503 and NOTHING RUN. The refusal deliberately does NOT claim the
         approval was spent, because it is not known whether it was: the write may have
         landed and the answer been lost. Ambiguity refuses; it never runs and never
         reports a spend it cannot prove.

      4. THE CLAIM IS IDENTIFIED AND TIMESTAMPED. Was: exec_claim_id, exec_claimed_at and
         exec_claimed_from_status written onto the job document. Now: the same three values
         are the BODY of the claim object. This service cannot read them back -- that is the
         point -- but the control plane ingest can, and the claim id still travels back in
         this function return value exactly as before, so the exec_claim journal line is
         unchanged.

      5. COMPARE-AND-SET ON STATUS. [SEC-EXEC-NO-DATASTORE-V1] IT IS GONE, AND THE ARGUMENT
         FOR WHAT REPLACES IT SITS HERE, WHERE THE CODE USED TO BE, BECAUSE THE PREVIOUS
         COMMIT ASKED FOR EXACTLY THAT AND A COMMENT IS THE ONLY PLACE A DELETED CONTROL CAN
         BE ARGUED. The pre-claim re-read of status needed roles/datastore.user. Keeping it
         would keep the grant, and a control that requires the privilege the change exists to
         remove is not a control that can be kept. So it is deleted rather than faked from a
         request body: STATUS IS NOT IN ANY CANON, so a status carried in the body is a
         caller's assertion about itself and refusing on it would be theatre.

         WHAT IT DEFENDED AGAINST, HONESTLY. A control plane firing a job the human denied.
         But the control plane is what RECORDS a denial, so against a compromised control
         plane the check bought nothing: the same principal writes status=confirmed and calls
         /run in the same breath. And against anyone else it was never the operative control,
         because /run is deployed --no-allow-unauthenticated and the ONLY roles/run.invoker
         binding on this service is the control plane's. The set of principals that can reach
         this endpoint is a SUBSET of the set that could already write the document, so a
         status forged in the body is available to nobody who could not already have written
         the same status to Firestore.

         WHAT REMAINS, AND IT IS ENOUGH:
           * the supersede route refuses anything not still pending, so an APPROVED job
             cannot be superseded out from under this run at all;
           * pre-approve refuses any status that is not pending, so a denied, superseded,
             expired or executed job cannot be re-armed on one human intent;
           * the signature carries its own exp, and it is checked;
           * approval_staleness_refusal bounds the age of the SIGNED iat, below the signer's
             exp if the operator wants it lower;
           * and the claim below is the single-use gate, which is what actually answers
             "has this approval already been spent" -- it always was.

         THE RESIDUE, STATED RATHER THAN GLOSSED: a job approved, left unfired, then denied
         by a direct API call (the gate page only ever renders pending jobs, so this is not a
         path the UI offers), and then fired inside the signature's exp, would now run where
         before it would have been refused. Firing it requires the control plane's own
         identity, which is the principal that recorded the denial. That is the whole of what
         is lost, and EXEC_APPROVAL_MAX_AGE_SECONDS bounds it.

      6. THERE IS NO PRE-READ, so there is no advisory check that can fail, and
         exec_claim_precheck_unavailable can no longer be journalled. Fail-closed applies to
         the CLAIM, which is the thing that answers "was this already spent", and it always
         did.

    PC_EXEC_BUCKET UNSET NO LONGER FALLS BACK TO ANYTHING. The Firestore transaction is
    deleted, not disabled: a fallback that needs roles/datastore.user would keep the grant
    alive as dead code, and dead code with a live privilege behind it is how a privilege comes
    back. pc_arming_refusal() turns an unset bucket into a refusal at the top of run(), with a
    message naming the variable, so the absence is never silent and never permissive.
    """
    claim_id = hashlib.sha256(os.urandom(32)).hexdigest()[:32]
    claimed_at = pc_now_stamp()
    # The claim body keeps its shape. exec_claimed_from_status is the one field that lost its
    # source: this service can no longer read a status, and "unread" is a value that field
    # could already take, so the record stays readable to anything already parsing it rather
    # than changing schema to say the same nothing.
    prior_status = "unread"
    name = PC_CLAIM_PREFIX + pc_obj_part(job_id) + ".json"
    body = json.dumps({"job_id": str(job_id), "exec_claim_id": claim_id,
                       "exec_claimed_at": claimed_at,
                       "exec_claimed_from_status": str(prior_status),
                       "claimed_by": "fleet-gate-exec"}, sort_keys=True) + chr(10)
    outcome, detail = pc_bucket_create(name, body)
    if outcome == "created":
        return (claim_id, None)
    if outcome == "exists":
        # The Firestore refusal named the prior claim id and time off the document it had
        # just read. There is no read here and there does not need to be one: the tail of
        # the sentence -- the part that tells the operator what to DO -- is unchanged.
        return (None, "this approval was already consumed (the claim object %s already exists; "
                "this service may not read it and does not need to, the 412 is the read); "
                "one approval = one run, re-stage the job to run it again" % name)
    raise ExecClaimUnknown(detail or "the claim write neither succeeded nor was refused")


# [SEC-EXEC-NO-DATASTORE-V1] _claim_job_via_firestore() WAS HERE AND IS DELETED.
# It was the pre-[EXEC-CLAIM-BUCKET-V1] @firestore.transactional claim, kept reachable behind
# an unset PC_EXEC_BUCKET so a deployment predating the bucket would not lose single-use in an
# upgrade. That reason expired with the grant. The function needed roles/datastore.user for
# both its read and its write, so leaving it in place -- even unreachable on every configured
# deployment -- would mean the grant could never actually be removed, only stop being used.
# The whole point of this commit is that the privilege cannot come back by accident, and an
# unreachable code path with a live privilege behind it is exactly the accident.
#
# THE UPGRADE CASE IT PROTECTED IS HANDLED BETTER BY REFUSING. A deployment with no
# PC_EXEC_BUCKET now gets pc_arming_refusal() at the top of run() -- every job refused, with a
# message naming the variable -- instead of silently running on a claim path whose permission
# has been revoked underneath it and failing somewhere less legible.


# ---- [SEC-KMSSIGN-EXEC-V1] PC-APPROVAL-CANON-V1 SIGNATURE VERIFICATION -- PUBLIC KEY ONLY ----
# WHAT REPLACED THE HMAC AND WHY. The old control recomputed an HMAC with the symmetric
# approval-MAC secret -- the same key that produced it -- so this service could MINT a valid
# approval for any command it liked, while already holding project-wide roles/datastore.user
# and receiving the approver's OAuth token in the request body. The adversary the design
# names was handed the signing key. Only ASYMMETRY fixes that.
#
# THIS SERVICE HOLDS PUBLIC KEYS AND NOTHING ELSE. It cannot sign.
#
# THE CANONICAL MESSAGE is PC-APPROVAL-CANON-V1, specified in
# shared/state/security-lane/kmssign/CANON-SPEC.md. Every field is LENGTH-PREFIXED:
#
#   DOMAIN         = b"PC-APPROVAL-CANON-V1\n"   (21 bytes, trailing LF)
#   F(name,value)  = len(utf8(name)) ":" name "=" len(utf8(value)) ":" value ";"
#   canonical      = DOMAIN F(alg) F(jid) F(csha) F(appr) F(kver) F(iat) F(exp)
#
# WHY LENGTH PREFIXES AND NOT A SEPARATOR. With a '|' join these two DIFFERENT tuples
# produce the SAME bytes, so one signature covers both:
#     appr="x"        kver="<KV>|y"
#     appr="x|<KV>"   kver="y"
# Length prefixes make that collision unconstructible, so ':' '=' ';' '|' LF and NUL are
# LEGAL INSIDE VALUES and are round-tripped with no escaping and no rejection -- the length
# was already read. Lengths are UTF-8 BYTE lengths, not characters and not UTF-16 units.
#
# THE BYTES ARE NEVER PARSED. They are REBUILT and the signature verified over the rebuild.
# There is no parser, therefore no parser bug.
import urllib.request as _pc_urlreq
import urllib.error as _pc_urlerr
# Imported under a private alias rather than added to the module's existing import line,
# so the [APPROVAL-INTEGRITY-V1] edit to that line is left exactly as it was applied.
import re as _pc_re

PC_CANON_ID = "PC-APPROVAL-CANON-V1"
PC_CANON_DOMAIN = b"PC-APPROVAL-CANON-V1\n"
PC_SIG_ALG = "EC_SIGN_P256_SHA256"
PC_CANON_FIELDS = ("alg", "jid", "csha", "appr", "kver", "iat", "exp")
PC_IAT_SKEW_SEC = int(os.environ.get("APPROVAL_SIG_SKEW_SEC", "300"))

# [PC-APPROVAL-CANON-V2 LANDING DEFAULT = PERMISSIVE] V1 ACCEPTANCE IS A MIGRATION STATE
# AND NOT A POSTURE. The in-code default is "1": a stamp naming PC-APPROVAL-CANON-V1 is
# still accepted unless APPROVAL_ACCEPT_CANON_V1=0 is set explicitly. This is the SAME
# reasoning, and deliberately the same shape, as the APPROVAL_REQUIRE_SIGNED landing
# default further down -- landing V2 with V1 acceptance already OFF enters Stage B and
# Stage C in one commit and refuses every approval stamped before the V2 signer shipped,
# INCLUDING the one that would undo it. That is the ed-S39 self-lockout and it is
# permanently banned here.
# DO NOT "fix" this by deleting the variable: DELETING IT RELAXES THIS CHECK RATHER THAN
# TIGHTENING IT -- absent reads as "1", so a V1 stamp is accepted. Set it explicitly, to
# "1" or to "0". Flip it to "0" only after the exec_approval_sig_ok_v1 journal line below
# has stopped appearing and stayed gone.
# NOTE WHAT THIS DOES *NOT* RELAX, and it is the whole point of shipping V2 permissively:
# a V1 stamp is accepted for LOCAL EXECUTION ONLY. It can never authorise a non-local branch,
# whatever this flag says, because V1's signed field set never covered the destination.
# [SEC-SSHTOOL-REMOVED-V1] There is only a local branch today, so that refusal cannot fire --
# it is a standing guard for the next branch, not dead weight. See pc_exec_branch().
PC_ACCEPT_CANON_V1 = os.environ.get("APPROVAL_ACCEPT_CANON_V1", "1") == "1"

# ALLOWLIST, not a single key. Holding ONE public key would make the kver field decorative:
# a stamp naming any version would still be checked against the one key we happen to hold.
PC_SIG_KEYS = [k.strip() for k in
               os.environ.get("APPROVAL_SIG_KEY_VERSIONS", "").split(",") if k.strip()]
PC_KMS_HOST = os.environ.get("PC_KMS_HOST", "https://cloudkms.googleapis.com")
PC_METADATA_HOST = os.environ.get("PC_METADATA_HOST", "http://metadata.google.internal")

# Successes only. A key VERSION is immutable so a cached public key cannot go stale, and a
# rotation is a new version and therefore a new cache entry. FAILURES ARE NEVER CACHED: a
# transient KMS outage must not poison this process into permanent refusal.
_pc_pubkey_cache = {}


def _pc_canon_field(name, value):
    nb = name.encode("utf-8")
    vb = value.encode("utf-8")
    return b"%d:%s=%d:%s;" % (len(nb), nb, len(vb), vb)


def pc_approval_canon_v1(alg, jid, csha, appr, kver, iat, exp):
    """Rebuild the canonical bytes. Returns (bytes, None) or (None, reason); never raises.
    The control plane's pcApprovalCanonV1() must produce these exact bytes."""
    vals = (alg, jid, csha, appr, kver, iat, exp)
    for nm, v in zip(PC_CANON_FIELDS, vals):
        if not isinstance(v, str):
            return (None, "%s is a %s, not a string" % (nm, type(v).__name__))
    out = PC_CANON_DOMAIN
    for nm, v in zip(PC_CANON_FIELDS, vals):
        out += _pc_canon_field(nm, v)
    return (out, None)


# ---- [PC-APPROVAL-CANON-V2] THE EXECUTION CONTEXT JOINS THE SIGNED BYTES ----
# WHAT V1 LEFT OUT, AND WHY IT MATTERS HERE MORE THAN ANYWHERE ELSE. V1 signs
# alg, jid, csha, appr, kver, iat, exp. That proves a named human approved THIS COMMAND
# TEXT for THIS JOB ID under THIS KEY inside THIS WINDOW. It says nothing whatever about
# HOW the text is executed. This file used to read command_type and arguments.targetNode off
# the job document, and those two selected
#     ssh -o StrictHostKeyChecking=no -i <key> <targetNode> <command>
# versus a local bash. NEITHER WAS SIGNED. So a principal holding roles/datastore.user could
# take a command a human genuinely approved for local execution, set command_type to "ssh",
# point targetNode at a machine the approver never saw, and every signed byte still
# verified. Firestore integrity was the only thing standing in that gap -- and removing
# this service's roles/datastore.user grant is the whole direction of travel, so Firestore
# integrity cannot go on being the only thing.
#
# [SEC-SSHTOOL-REMOVED-V1] THAT BRANCH IS GONE AND ctyp/asha ARE STILL SIGNED, DELIBERATELY.
# The example above is historical; the property is not. What these two fields buy is that an
# approval names WHICH EXECUTION SEMANTICS were authorised, and the ssh branch was merely the
# first thing that could diverge from them. Narrow the canon to today's single branch and the
# gap reopens the day a second one is added -- by whoever adds it, who will not have read this.
#
# THE V2 FIELD SET, AND WHY THESE NAMES IN THIS ORDER:
#
#     alg  jid  csha  ctyp  asha  appr  kver  iat  exp
#
# The two new fields are INSERTED after csha, not appended after exp, and the choice is not
# cosmetic. Fields 2-5 now say WHAT IS BEING AUTHORISED -- which job, which command text,
# which execution branch, which arguments -- and fields 6-9 say WHO AUTHORISED IT, UNDER
# WHICH KEY, AND FOR HOW LONG. That is exactly the grouping V1 already had; the new facts
# are placed in the group they belong to rather than parked at the end. A reviewer diffing
# V1 against V2 then reads an INSERTION INTO ONE GROUP instead of a nine-field permutation,
# and a permutation is the change most likely to be waved through unread.
#
#   ctyp  the job's command_type, verbatim, "" when the field is absent. It is the branch
#         selector, so it is the single smallest edit that redirects an approved command at
#         another host.
#   asha  sha256, lowercase hex, of the canonicalised arguments object. THE HASH, NOT THE
#         OBJECT: arguments is unbounded, and inlining it would carry a whole script into
#         the signed message twice -- once inside asha and once inside csha.
#
# WHY A HASH OF THE WHOLE ARGUMENTS OBJECT RATHER THAN A targetNode FIELD. targetNode lives
# INSIDE arguments. Hashing the object covers targetNode and every other argument in one
# field, including arguments this file does not read today but may read tomorrow. A
# dedicated targetNode field would be a second, weaker statement of a fact asha already
# makes, and it would need its own convention for "absent" that could disagree with the
# object's.
#
# csha IS KEPT even though asha covers arguments.command. csha is taken over the command
# string AFTER the command/cmd precedence this file applies, which is not recoverable from
# asha alone, and retiring a control that works in order to tidy a field list is not a
# trade this file makes.
#
# THE FRAMING IS V1'S, UNCHANGED. The same _pc_canon_field(), the same UTF-8 BYTE lengths,
# so ':' '=' ';' '|', newline and NUL stay legal inside ctyp and asha, round-tripped with
# no escaping and no rejection, for the same reason they are legal inside appr and kver:
# the length was already read. The two new fields inherit that property rather than needing
# a fresh argument for it.
#
# ONLY THE DOMAIN LINE CHANGES BESIDES THE FIELDS, AND IT MUST. A V1 message and a V2
# message begin with different bytes, so a signature over one can never be replayed as a
# signature over the other -- which is what makes accepting both during migration a
# bounded decision rather than an open one.
PC_CANON_V2_ID = "PC-APPROVAL-CANON-V2"
PC_CANON_V2_DOMAIN = b"PC-APPROVAL-CANON-V2\n"
PC_CANON_V2_FIELDS = ("alg", "jid", "csha", "ctyp", "asha", "appr", "kver", "iat", "exp")


def pc_approval_canon_v2(alg, jid, csha, ctyp, asha, appr, kver, iat, exp):
    """Rebuild the V2 canonical bytes. Returns (bytes, None) or (None, reason); never raises.
    The control plane's pcApprovalCanonV2() must produce these exact bytes."""
    vals = (alg, jid, csha, ctyp, asha, appr, kver, iat, exp)
    for nm, v in zip(PC_CANON_V2_FIELDS, vals):
        if not isinstance(v, str):
            return (None, "%s is a %s, not a string" % (nm, type(v).__name__))
    out = PC_CANON_V2_DOMAIN
    for nm, v in zip(PC_CANON_V2_FIELDS, vals):
        out += _pc_canon_field(nm, v)
    return (out, None)


# ---- [PC-APPROVAL-CANON-V2] THE ARGUMENT CANONICALISATION, AND ITS REFUSALS ----
# asha is sha256 over pc_stable_json(arguments), and pc_stable_json HERE must agree BYTE
# FOR BYTE with pcStableJson() in control-plane/src/index.ts. That function already exists
# there and is already trusted to decide whether a displayed job and a stored job are the
# same job, precisely so that key order cannot make one intention look like two. This is
# the Python half of it, and it is written out rather than delegated to json.dumps because
# THE TWO LANGUAGES DISAGREE IN THREE PLACES THAT json.dumps WILL NOT TELL YOU ABOUT:
#
#  1. KEY ORDER. JavaScript's Array.prototype.sort() with no comparator orders strings by
#     UTF-16 CODE UNIT. Python's sorted() orders by CODE POINT. Those differ for every
#     astral character: U+1F600 sits one code point above U+FFFD, but its leading UTF-16
#     unit is 0xD83D, which sits BELOW 0xFFFD -- so the same two keys come out in opposite
#     orders and the two sides hash different objects. Sorting on s.encode("utf-16-be")
#     reproduces the JavaScript order exactly.
#  2. NUMBERS. Firestore hands Python an int for an integer and a float for a double;
#     JavaScript receives a Number for both, and JSON.stringify prints 5.0 as 5. Integral
#     values are normalised to their integer spelling here so the two agree. ANYTHING ELSE
#     IS REFUSED rather than approximated -- see below.
#  3. STRING ESCAPING. Written out explicitly instead of hoping json.dumps matches
#     JSON.stringify at the edges. The escape set is JSON.stringify's exactly: quote,
#     backslash, the five named control escapes, and lowercase four-hex for the remaining
#     C0 controls. Non-ASCII is emitted literally by both sides.
#
# WHAT IS REFUSED, AND WHY REFUSING BEATS APPROXIMATING. A non-integral float has no
# spelling the two languages are guaranteed to agree on -- CPython and V8 switch to
# exponent notation at different magnitudes -- and bytes, timestamps and document
# references have no JSON spelling at all. Each of those returns a REASON here, the
# verifier reports "unverifiable", and the executor refuses. It does NOT fall back to V1
# and it does NOT hash something else. The signer applies the identical test and simply
# declines to stamp a V2 signature it could not honestly produce, so both sides refuse the
# same documents rather than one side silently signing what the other cannot rebuild.
_PC_JSON_ESC = {0x08: "b", 0x09: "t", 0x0a: "n", 0x0c: "f", 0x0d: "r"}
_PC_SAFE_INT_MAX = (1 << 53) - 1
_PC_BSLASH = chr(92)
_PC_DQUOTE = chr(34)


def _pc_json_string(s):
    """JSON.stringify() of one string, byte for byte. (text, None) or (None, reason)."""
    out = [_PC_DQUOTE]
    for ch in s:
        c = ord(ch)
        if 0xD800 <= c <= 0xDFFF:
            # Unreachable from the signing side -- [SEC-CANON-SURROGATE-V1] refuses these
            # before anything is stamped -- and refused here anyway, because this file is
            # the half that does not get to assume the other half ran.
            return (None, "a string contains an unpaired UTF-16 surrogate")
        if ch == _PC_DQUOTE or ch == _PC_BSLASH:
            out.append(_PC_BSLASH + ch)
        elif c in _PC_JSON_ESC:
            out.append(_PC_BSLASH + _PC_JSON_ESC[c])
        elif c < 0x20:
            out.append(_PC_BSLASH + "u%04x" % c)
        else:
            out.append(ch)
    out.append(_PC_DQUOTE)
    return ("".join(out), None)


def pc_stable_json(v):
    """(text, None) or (None, reason). Byte-identical to pcStableJson() in index.ts for
    every value it returns text for. Every other value is a REFUSAL, never a guess."""
    if v is None:
        return ("null", None)
    # bool BEFORE int: in Python bool is a subclass of int, so the order of these two
    # branches is load-bearing. Reversed, True canonicalises as 1 and the two sides diverge
    # on the single most common non-string argument in this fleet (arguments.danger).
    if isinstance(v, bool):
        return ("true" if v else "false", None)
    if isinstance(v, int):
        if abs(v) > _PC_SAFE_INT_MAX:
            return (None, "an integer argument is outside the range the two languages "
                          "spell identically")
        return (str(v), None)
    if isinstance(v, float):
        if v != v or v == float("inf") or v == float("-inf"):
            return (None, "a non-finite number has no JSON spelling")
        if not v.is_integer():
            return (None, "a non-integral number cannot be spelled identically by both "
                          "languages")
        iv = int(v)
        if abs(iv) > _PC_SAFE_INT_MAX:
            return (None, "a number argument is outside the range the two languages spell "
                          "identically")
        return (str(iv), None)
    if isinstance(v, str):
        return _pc_json_string(v)
    if isinstance(v, list):
        parts = []
        for item in v:
            t, why = pc_stable_json(item)
            if why:
                return (None, why)
            parts.append(t)
        return ("[" + ",".join(parts) + "]", None)
    if isinstance(v, dict):
        keys = []
        for k in v:
            if not isinstance(k, str):
                return (None, "an argument object has a non-string key")
            keys.append(k)
        # UTF-16 code-unit order, NOT code-point order. See note 1 in the header above.
        keys.sort(key=lambda s: s.encode("utf-16-be", "surrogatepass"))
        parts = []
        for k in keys:
            kt, why = _pc_json_string(k)
            if why:
                return (None, why)
            vt, why = pc_stable_json(v[k])
            if why:
                return (None, why)
            parts.append(kt + ":" + vt)
        return ("{" + ",".join(parts) + "}", None)
    return (None, "an argument of type %s has no canonical JSON spelling" % type(v).__name__)


def pc_canon_args_sha(args):
    """sha256 hex of the canonicalised arguments. (hex, None) or (None, reason).

    ABSENT AND NULL ARE THE SAME VALUE HERE, DELIBERATELY. The control plane signs
    pcStableJson(args === undefined ? null : args), so a job with no arguments field and a
    job whose arguments field is null both canonicalise to the four bytes "null".

    THIS MUST BE HANDED THE RAW FIELD -- job.get("arguments") -- and never the {} default
    the run handler uses for its own convenience: "{}" and "null" are different bytes and
    would produce different signatures for the same document."""
    t, why = pc_stable_json(args)
    if why:
        return (None, why)
    return (hashlib.sha256(t.encode("utf-8")).hexdigest(), None)


# ---- [PC-APPROVAL-CANON-V2] THE BRANCH SELECTOR, NAMED ONCE ----
# The V1-acceptance rule below and the actual dispatch in run() must never be able to
# disagree about what "runs locally" means, so they ask the SAME function rather than each
# testing command_type themselves.
#
# [SEC-SSHTOOL-REMOVED-V1] THERE IS NOW EXACTLY ONE BRANCH, AND THIS FUNCTION STAYS ANYWAY.
# The "ssh" branch it used to select is gone -- see the removal note above ssh's old home in
# run() -- so this returns "local" for every command_type there is. THAT IS NOT A REASON TO
# DELETE IT AND INLINE `True`, WHICH IS THE OBVIOUS TIDY-UP AND IS WRONG. This function is
# the ONE named place that answers "does this job run somewhere other than here", and the V1
# stamp refusal downstream is built on that answer. Delete it and the next person to add a
# second execution branch adds it in run() alone; nothing then refuses a V1 stamp for it, and
# the hole PC-APPROVAL-CANON-V2 exists to close reopens silently under a new name.
#
# SO: IF A SECOND EXECUTION BRANCH IS EVER ADDED TO run(), IT IS ADDED HERE IN THE SAME
# CHANGE -- otherwise a V1 stamp starts authorising a destination nobody decided it should.


def pc_exec_branch(command_type):
    """Which branch of run() a command_type selects. Currently "local" for everything;
    a second branch is added HERE and in run() together, never in run() alone."""
    return "local"


def _pc_parse_rfc3339(s):
    """Exactly YYYY-MM-DDTHH:MM:SS.mmmZ. Returns (epoch_seconds_float, None) or (None, why).
    Deliberately strict: this is a machine-written field, not human input."""
    if not isinstance(s, str) or len(s) != 24:
        return (None, "timestamp is not a 24-character RFC3339 UTC string")
    if not _pc_re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", s):
        return (None, "timestamp is not YYYY-MM-DDTHH:MM:SS.mmmZ")
    try:
        d = _dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=_dt.timezone.utc)
    except Exception as e:
        return (None, "timestamp could not be read (%s)" % str(e)[:80])
    return (d.timestamp(), None)


def _pc_metadata_token():
    req = _pc_urlreq.Request(
        PC_METADATA_HOST + "/computeMetadata/v1/instance/service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"})
    with _pc_urlreq.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))["access_token"]


def pc_fetch_public_key(key_version):
    """Fetch and cache the PUBLIC KEY for ONE key version. Returns (pem, None) or
    (None, reason). The only KMS surface this file touches is this publicKey read; the SA
    running this service is granted the Cloud KMS public-key-viewer role, which carries no
    signing permission at all."""
    hit = _pc_pubkey_cache.get(key_version)
    if hit:
        return (hit, None)
    try:
        tok = _pc_metadata_token()
        req = _pc_urlreq.Request(PC_KMS_HOST + "/v1/" + key_version + "/publicKey",
                                 headers={"Authorization": "Bearer " + tok})
        with _pc_urlreq.urlopen(req, timeout=10) as r:
            doc = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return (None, "the public key could not be fetched (%s)" % str(e)[:160])
    alg = doc.get("algorithm", "")
    if alg != PC_SIG_ALG:
        return (None, "the key version's algorithm is %r, not %s" % (alg[:64], PC_SIG_ALG))
    pem = doc.get("pem") or ""
    if not pem:
        return (None, "the key version returned no public key material")
    _pc_pubkey_cache[key_version] = pem
    return (pem, None)


def pc_verify_approval_signature(job, job_id, cmd_sha, cmd_type, args_sha, args_why=None,
                                 now=None):
    """The whole check. Returns (outcome, detail); outcome is exactly one of:

        "ok"            present and verified under PC-APPROVAL-CANON-V2
        "ok_v1"         present and verified under PC-APPROVAL-CANON-V1, accepted only
                        during migration and a STRICTLY NARROWER authorisation than "ok" --
                        the caller must refuse it for any non-local command_type
        "absent"        no approval_sig on the document
        "unverifiable"  present but COULD NOT be checked
        "bad"           present and DID NOT verify (or is expired / future-dated)

    "unverifiable" is NEVER "ok" and the caller refuses on it. Never raises, never allows.

    jid, csha, ctyp and asha are taken from THE JOB BEING EXECUTED, the COMMAND ABOUT TO
    RUN and the EXECUTION CONTEXT ABOUT TO BE USED -- never from the stamp. Taking them
    from the document would let anyone with roles/datastore.user move both sides of the
    comparison together, which is the exact defect Stage C exists to close. That rule is
    why ctyp and asha are PARAMETERS here and are not stored on the document beside appr
    and kver: appr, kver, iat and exp are not derivable from the job, so they must be
    carried; ctyp and asha are, so carrying them would be handing the adversary the answer
    key."""
    sig_b64 = job.get("approval_sig")
    if sig_b64 is None or sig_b64 == "":
        return ("absent", "the document carries no approval_sig")
    if not isinstance(sig_b64, str):
        return ("unverifiable", "approval_sig is a %s, not a string" % type(sig_b64).__name__)

    # [PC-APPROVAL-CANON-V2] TWO CANONS ARE ACCEPTABLE AND EVERY OTHER STRING IS NOT.
    # The canon id selects which message is REBUILT; it is never parsed out of the
    # signature, and a V1 and a V2 message differ in their first line, so a stamp cannot
    # be relabelled from one to the other and still verify.
    _named = job.get("approval_sig_canon")
    if _named == PC_CANON_V2_ID:
        _canon_kind = "v2"
    elif _named == PC_CANON_ID:
        if not PC_ACCEPT_CANON_V1:
            return ("unverifiable",
                    "the stamp names %s and this deployment has finished migrating "
                    "(APPROVAL_ACCEPT_CANON_V1=0), so only %s is accepted. Stage and "
                    "approve the job again to get a stamp that covers the execution "
                    "context" % (PC_CANON_ID, PC_CANON_V2_ID))
        _canon_kind = "v1"
    else:
        return ("unverifiable", "the stamp names canonicalisation %r, which is neither %s "
                "nor %s" % (str(_named)[:40], PC_CANON_V2_ID, PC_CANON_ID))
    if job.get("approval_sig_alg") != PC_SIG_ALG:
        return ("unverifiable", "the stamp names algorithm %r, not %s"
                % (str(job.get("approval_sig_alg"))[:40], PC_SIG_ALG))

    kver = job.get("approval_sig_key")
    if not PC_SIG_KEYS:
        return ("unverifiable",
                "this service has no APPROVAL_SIG_KEY_VERSIONS allowlist configured, so the "
                "signature CANNOT be checked. Refusing: an unchecked signature is not a pass")
    if not isinstance(kver, str) or not kver:
        return ("unverifiable", "the document names no approval_sig_key")
    if not any(hmac.compare_digest(kver, k) for k in PC_SIG_KEYS):
        return ("unverifiable", "the document names a key version that is not in this "
                                "service's allowlist")

    appr = job.get("approval_sig_approver")
    iat_s = job.get("approval_sig_iat")
    exp_s = job.get("approval_sig_exp")
    if _canon_kind == "v2":
        # THE ARGUMENTS MUST HAVE CANONICALISED. An arguments object this file cannot spell
        # the way the signer spelled it is not a mismatch to be resolved in favour of
        # running: there is no message to verify against, so there is nothing to check.
        if not isinstance(args_sha, str) or not args_sha:
            return ("unverifiable", "the arguments on this job could not be canonicalised "
                    "(%s), so the signed message cannot be rebuilt"
                    % (args_why or "no reason recorded"))
        msg, why = pc_approval_canon_v2(PC_SIG_ALG, job_id, cmd_sha, str(cmd_type or ""),
                                        args_sha, appr, kver, iat_s, exp_s)
    else:
        msg, why = pc_approval_canon_v1(PC_SIG_ALG, job_id, cmd_sha, appr, kver, iat_s,
                                        exp_s)
    if why:
        return ("unverifiable", "the signed message cannot be rebuilt: %s" % why)

    try:
        sig = base64.b64decode(sig_b64, validate=True)
    except Exception:
        return ("unverifiable", "approval_sig is not valid base64")
    if not sig:
        return ("unverifiable", "approval_sig decodes to nothing")

    pem, why = pc_fetch_public_key(kver)
    if why:
        return ("unverifiable", why)

    try:
        from cryptography.hazmat.primitives import hashes as _pc_h
        from cryptography.hazmat.primitives.asymmetric import ec as _pc_ec
        from cryptography.hazmat.primitives.asymmetric import utils as _pc_u
        from cryptography.hazmat.primitives.serialization import load_pem_public_key
        pub = load_pem_public_key(pem.encode("utf-8"))
    except Exception as e:
        return ("unverifiable", "the public key could not be parsed (%s)" % str(e)[:120])
    if not isinstance(pub, _pc_ec.EllipticCurvePublicKey) or \
            not isinstance(pub.curve, _pc_ec.SECP256R1):
        return ("unverifiable", "the configured key is not an ECDSA P-256 public key")

    try:
        digest = hashlib.sha256(msg).digest()
        pub.verify(sig, digest, _pc_ec.ECDSA(_pc_u.Prehashed(_pc_h.SHA256())))
    except Exception:
        return ("bad", "the signature does not verify against the rebuilt approval tuple")

    # TIME IS CHECKED ONLY AFTER THE SIGNATURE VERIFIES. Checking first would report an
    # unsigned document as "expired" rather than as unsigned -- a weaker, more confusing fact.
    iat_t, why = _pc_parse_rfc3339(iat_s)
    if why:
        return ("unverifiable", "iat: %s" % why)
    exp_t, why = _pc_parse_rfc3339(exp_s)
    if why:
        return ("unverifiable", "exp: %s" % why)
    n = float(now) if now is not None else _dt.datetime.now(_dt.timezone.utc).timestamp()
    if n > exp_t:
        return ("bad", "the signature is valid but EXPIRED (%d seconds ago); a human "
                       "approval is not a standing authorisation" % int(n - exp_t))
    if iat_t > n + PC_IAT_SKEW_SEC:
        return ("bad", "the signature is valid but the stamp is FUTURE-DATED by %d seconds "
                       "(skew allowance %d)" % (int(iat_t - n), PC_IAT_SKEW_SEC))
    return (("ok" if _canon_kind == "v2" else "ok_v1"),
            "verified against %s under %s"
            % (kver.rsplit("/", 1)[-1], PC_CANON_V2_ID if _canon_kind == "v2"
               else PC_CANON_ID))



# [SEC-MINTER-V1] Self-test endpoint. Exercises the assertion verifier INSIDE the running
# service, so we find out here rather than during an approval. Read-only: it never runs a
# command and never logs a credential.
#
# [SEC-MINTER-REMOVE-V1] THE "mint" ROW IS GONE, NOT BROKEN, AND THAT IS THE HONEST STATE.
# It called pcmint.mint_job_credential() -- a KMS -> JWT -> STS -> impersonate chain needing
# PC_KMS_KEY, PC_PROJECT_NUMBER, PC_EXEC_SA and a Workload Identity pool, none of which any
# installer ever created and none of which any execution path ever used. It therefore
# reported mint:{ok:false} on every deployment that has ever existed. A self-test row that
# can only ever fail teaches its reader to skim the self-test, which is worse than having no
# row at all. The chain is deleted from pcmint.py and this row is deleted with it, so
# /selftest no longer reports on a component that does not exist.
@app.get("/selftest")
def selftest():
    import os, json, base64, hashlib
    out = {"verifier": []}
    try:
        import pcwebauthn as W
        from cryptography.hazmat.primitives import hashes as _h
        from cryptography.hazmat.primitives.asymmetric import ec as _ec
        b64u = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
        rp = os.environ.get("PC_RP_ID", "example.invalid")
        chal_raw = os.urandom(24) + hashlib.sha256(b"j1|approve").digest()
        chal = b64u(chal_raw)
        k = _ec.generate_private_key(_ec.SECP256R1())
        n = k.public_key().public_numbers()
        cid = b64u(b"selftest-cred")
        creds = {cid: {"crv": "P-256", "x": b64u(n.x.to_bytes(32, "big")), "y": b64u(n.y.to_bytes(32, "big"))}}
        def mk(uv=True, ch=None):
            cdj = json.dumps({"type": "webauthn.get", "challenge": ch or chal, "origin": "https://" + rp}).encode()
            ad = hashlib.sha256(rp.encode()).digest() + bytes([0x01 | (0x04 if uv else 0)]) + (1).to_bytes(4, "big")
            sig = k.sign(ad + hashlib.sha256(cdj).digest(), _ec.ECDSA(_h.SHA256()))
            return {"id": cid, "response": {"clientDataJSON": b64u(cdj), "authenticatorData": b64u(ad), "signature": b64u(sig)}}
        try:
            W.verify(mk(), creds, chal, rp); out["verifier"].append("valid:accepted")
        except Exception as e:
            out["verifier"].append("valid:REJECTED:%s" % e)
        for name, a, c in (("no-uv", mk(uv=False), chal), ("wrong-challenge", mk(ch=b64u(os.urandom(56))), chal)):
            try:
                W.verify(a, creds, c, rp); out["verifier"].append("%s:ACCEPTED-BAD" % name)
            except Exception:
                out["verifier"].append("%s:rejected" % name)
        out["verifier"].append("bound-own:%s" % W.challenge_is_bound(chal, "j1", "approve"))
        out["verifier"].append("bound-other:%s" % W.challenge_is_bound(chal, "j2", "approve"))
    except Exception as e:
        out["verifier"].append("MODULE_ERROR:%s" % e)
    return jsonify(out)


# ---- [SEC-SSHTOOL-REMOVED-V1] THE SSH KEY PREFLIGHT USED TO LIVE HERE ----
# ssh_key_preflight() and EXEC_SSH_KEY_SECRET are gone with the branch they served. What they
# solved is worth remembering, because the shape recurs: an ssh job used to read its key
# BELOW claim_job_for_execution(), so a job that could never run still CONSUMED the one-shot
# approval a human had just spent a passkey tap on. The fix was to move the read above the
# claim. THE RULE THAT OUTLIVES THE BRANCH: anything that can refuse a job must refuse it
# ABOVE the claim, never below, or a refusal costs the operator an approval and buys nothing.

@app.get("/healthz")
def healthz():
    # [SEC-EXEC-NO-DATASTORE-V1] AN UNARMED EXECUTOR REPORTS UNHEALTHY RATHER THAN LYING.
    # There is no configuration in which this service should serve traffic while
    # pc_arming_refusal() has something to say, so the readiness answer and the /run answer
    # are the same answer. Reported here as well as refused there because "every job is
    # refused" is a fact an operator should be able to learn without spending an approval.
    _why = pc_arming_refusal()
    if _why:
        return jsonify({"error": "refused: this executor is not armed", "detail": _why}), 503
    return "ok", 200

# ---- [EXEC-BIN-JAIL-V82] THE BINARY BOUNDARY IS NOW THE FILESYSTEM, NOT A TEXT SCAN ----
# WHAT WAS WRONG. The check below is a first-token-per-line scan of the approved script. It
# could never enforce anything: every real staged job opens with `set -uo pipefail`, so the
# first token is `set` and arming it returned HTTP 400 and ran nothing -- that is what broke
# production the one time it was live. Widening the set to admit shell keywords and
# assignments stops it constraining binaries at all, and even fully widened it is evaded by
# CONSTRUCTION rather than cleverness: $(...), pipes, ';' and '&&' chains, xargs, and
# X=$(curl ...) all put the real binary somewhere that is not the first token of a line.
#
# WHY THE OPERATOR'S ORIGINAL INSTRUCTION -- "arm it, but widen the list first" -- WAS RIGHT,
# and was refused for the wrong reason: widening is useless for a TEXT SCAN and is exactly
# correct for a PATH JAIL. This process controls the child's environment, so restricting PATH
# to a directory containing only the permitted binaries makes the boundary the filesystem.
# Shell BUILTINS and KEYWORDS (set, if, for, case, [[, cd, export, echo) do not resolve
# through PATH at all, so the failure that killed the last attempt CANNOT recur.
#
# MEASURED before arming, on this executor image: all seven
# realistic job bodies -- the `set -uo pipefail` preamble, keywords/assignments/loops,
# command substitution and pipes, the gcloud+git+python3 deploy path, the lane-fetch
# bootstrap, base64/sha256sum/tar handling and a grep|sed|sort pipeline -- ran clean under
# the jail, while `gsutil` and `ssh` both answered "command not found". That gsutil line is
# the exact case this executor previously journalled as
# "not allowlisted (observe-only, executing anyway)" and then ran.
#
# THE GAP, STATED RATHER THAN PAPERED OVER. An ABSOLUTE PATH bypasses PATH resolution:
# /usr/bin/env still runs, measured in the same job. So this raises the floor from "no
# boundary at all" to "an enumerated set, unless the script names a full path". It is a real
# control and it is not a sandbox. Closing that needs an execution-layer change -- an image
# containing only the permitted binaries, or a seccomp/container boundary -- and is
# deliberately NOT attempted here. The primary controls remain what they always were: a human
# approved this exact command, and the executor refuses any script whose sha256 does not match
# the approval-time hash.
#
# NOTE ALSO MEASURED: node, npm and firebase are NOT ON THIS IMAGE. The old allowlist named
# all three, so a third of what it claimed to permit did not exist.
EXEC_BIN_ALLOWED = [
    "gcloud", "bq", "python3", "python", "pip", "pip3", "node", "npm", "npx", "firebase",
    "git", "curl", "wget",
    "bash", "sh", "cat", "cp", "mv", "rm", "mkdir", "rmdir", "ls", "ln", "chmod", "chown",
    "touch", "test", "true", "false", "echo", "printf", "pwd", "dirname", "basename",
    "readlink", "realpath", "env", "which", "sleep", "date", "seq", "expr", "uname", "id",
    "grep", "egrep", "fgrep", "sed", "awk", "cut", "tr", "sort", "uniq", "head", "tail",
    "wc", "tee", "diff", "cmp", "find", "xargs", "jq", "od", "file", "stat", "split", "paste",
    "tar", "gzip", "gunzip", "zip", "unzip", "base64", "sha256sum", "md5sum", "openssl",
]


def pc_build_bin_jail():
    """A directory of symlinks to the permitted binaries. Returns (dir, linked, missing).

    Returns (None, [], []) when disabled, so the caller leaves PATH alone. A binary that is
    not on the image is simply not linked -- there is nothing to link and nothing to refuse.
    """
    if os.environ.get("EXEC_BIN_JAIL", "1") != "1":
        return None, [], []
    import shutil as _sh
    d = tempfile.mkdtemp(prefix="pcbinjail.")
    linked, missing = [], []
    for _n in EXEC_BIN_ALLOWED:
        _p = _sh.which(_n)
        if not _p:
            missing.append(_n)
            continue
        try:
            os.symlink(_p, os.path.join(d, _n))
            linked.append(_n)
        except OSError:
            missing.append(_n)
    return d, linked, missing


@app.post("/run")
def run():
    # [SEC-EXEC-NO-DATASTORE-V1] THE ARMING GATE IS THE FIRST THING, ABOVE EVERY OTHER CHECK
    # AND ABOVE ANY PARSING OF THE BODY. Both facts it tests used to be optional because a
    # Firestore path stood behind them; that path is gone, so they are not optional and this
    # refuses rather than assuming. See pc_arming_refusal() for which two and why each one
    # became load-bearing at the moment roles/datastore.user was removed.
    _arm = pc_arming_refusal()
    if _arm:
        return jsonify({"error": "refused: this executor is not armed", "detail": _arm}), 503
    body = request.get_json(force=True, silent=True) or {}
    job_id = body.get("job_id")
    if not job_id:
        return jsonify({"error": "job_id is required"}), 400

    # ---- [SEC-EXEC-NO-DATASTORE-V1] THE APPROVAL ARRIVES IN THE BODY, AND HERE IS THE
    # ---- CLASSIFICATION OF EVERY FIELD THAT USED TO COME OFF THE JOB DOCUMENT ----
    # This block used to be db.collection("pending_confirms").document(job_id).get(). It is a
    # dict out of the request body now, put there by the control plane, which holds the read
    # this service has given up. Passing a field in the body is safe EXACTLY WHEN the
    # signature covers it, so every field is in one of three classes and each is named:
    #
    #  COVERED BY THE SIGNATURE -- alter one in transit and the signature fails, so these are
    #  no less trustworthy in a request body than in a database this service could not write:
    #    arguments        -> asha, field 5 of PC-APPROVAL-CANON-V2 (sha256 of the canonical
    #                        JSON of the whole object, so arguments.command, arguments.cmd and
    #                        arguments.targetNode are all inside it)
    #    command_type     -> ctyp, field 4, verbatim, "" when absent
    #    the command      -> csha, field 3, recomputed below from the arguments about to be
    #                        used, never taken from the stamp
    #    approval_sig_approver / _key / _iat / _exp -> appr, kver, iat, exp, fields 6 to 9
    #    the job id       -> jid, field 2. It came from the request body before this commit
    #                        too, and always did: it is what selected the document.
    #  SELF-PROTECTING RATHER THAN SIGNED, which is a different argument and is made
    #  separately: approval_sig_canon selects WHICH message is rebuilt, and a V1 and a V2
    #  message differ in their first line, so relabelling a stamp cannot make it verify and
    #  any third value is refused outright; approval_sig_alg is compared against a constant.
    #  Neither can be altered into an acceptance.
    #
    #  REDUNDANT: approved_sha256. It duplicates csha whenever a signature is present, and
    #  the caller now supplies BOTH it and the command it pins, so it is no longer a control
    #  -- it is a consistency assertion, kept because its refusals are in the operator's
    #  vocabulary and cost nothing. THE CONTROL IS csha, INSIDE THE SIGNED BYTES. What makes
    #  that sufficient is pc_arming_refusal() refusing to serve at all unless
    #  APPROVAL_REQUIRE_SIGNED=1, because with the flag off an unsigned approval would reach
    #  the command with only this caller-supplied assertion between them. The dependency is
    #  enforced, not assumed.
    #
    #  GENUINELY LOST: status and confirmed_at. Neither is in any canon and neither can be,
    #  because a signature is made at approval time and cannot speak for a state that changes
    #  afterwards. status is argued at length in claim_job_for_execution(); confirmed_at is
    #  replaced by approval_staleness_refusal() bounding the SIGNED approval_sig_iat, which is
    #  the same control over a field a caller cannot move.
    job = body.get("approval")
    if not isinstance(job, dict):
        # NOT a 404. The old shape's "job not found" was a statement about a database this
        # service can no longer see, and reporting a missing envelope as a missing job would
        # send the operator to look in the wrong place.
        return jsonify({"error": "refused: this executor reads the approval from the request "
                                 "body and the request carries no 'approval' object",
                        "detail": "the control plane holds the Firestore read; this service "
                                  "does not, and no longer needs to"}), 400

    # [SEC-EXEC-NO-DATASTORE-V1] THE status GATE WAS HERE AND IS DELETED. It refused anything
    # not 'confirmed' or 'executing'. status is not a canon field, so re-asserting it out of
    # the body would be the caller vouching for itself; the argument for why nothing is lost,
    # and what the residue is, is in claim_job_for_execution() note 5.

    # [SEC-RUN-ASSERTION-V1] INDEPENDENT APPROVAL CHECK -- the point of the whole minter design.
    # EVERYTHING ABOVE THIS LINE IS THE CALLER'S ACCOUNT OF ITSELF; below it, the signature is
    # what makes any of it true. Before [SEC-EXEC-NO-DATASTORE-V1] the same sentence read
    # "everything above this line trusts Firestore", and it was the same weakness wearing a
    # database: the control plane could write Firestore, so a compromised one approved anything
    # by setting status=confirmed and calling us. With PC_REQUIRE_ASSERTION=1 the caller must
    # ALSO present the operator's WebAuthn assertion, verified HERE against credentials the
    # control plane cannot write. It cannot forge one -- forging requires the operator's
    # device, not database access and not a request body.
    if os.environ.get("PC_REQUIRE_ASSERTION", "0") == "1":
        try:
            import pcwebauthn as _W
            import pcmint as _M
            _assn = body.get("assertion") or {}
            _chal = body.get("expected_challenge") or ""
            _action = body.get("action") or "approve"
            if not _assn or not _chal:
                log_journal("exec_assertion_missing", "no assertion presented", job_id)
                return jsonify({"error": "assertion required"}), 428
            if not _W.challenge_is_bound(_chal, job_id, _action):
                log_journal("exec_assertion_unbound", "challenge not bound to this job/action", job_id)
                return jsonify({"error": "assertion is not bound to this job"}), 403
            _creds = _M.load_creds()
            if not _creds:
                # Refuse, never allow. An empty credential store means we cannot verify, and
                # "cannot verify" must never read as "verified".
                log_journal("exec_assertion_no_creds", "credential store empty or unreadable", job_id)
                return jsonify({"error": "no enrolled credentials to verify against"}), 403
            _W.verify(_assn, _creds, _chal, os.environ.get("PC_RP_ID", ""))
            log_journal("exec_assertion_verified", "assertion verified by the executor itself", job_id)
        except Exception as _e:
            log_journal("exec_assertion_refused", str(_e)[:200], job_id)
            return jsonify({"error": "assertion refused: %s" % str(_e)[:200]}), 403

    command_type = job.get("command_type", "")
    args = job.get("arguments", {})

    # [APPROVAL-INTEGRITY-V1] APPROVAL INTEGRITY. The approved pending_confirms document is
    # the ONLY authority on what runs. Before this fix the executor preferred
    # body["script_b64"] and never compared it to the approved command, so the
    # human approved job X and whatever arrived in the request body executed.
    # Status was checked; the command was not. Every control in the control
    # plane (Face ID job binding, identity quarantine, danger classification,
    # approver allowlist) sat on top of that gap.
    # script_b64 is still ACCEPTED because the live control plane sends it, but
    # it is now VERIFIED against the approved command and refused on mismatch.
    # [SEC-EXEC-CMD-BRICK-V1] READ THE COMMAND THE WAY THE CONTROL PLANE WRITES IT.
    # live/index.js waJobCommand():
    #     const command = jx.arguments && (jx.arguments.command || jx.arguments.cmd) || "";
    # APPROVAL-INTEGRITY-V1 correctly made the approved document authoritative,
    # but it read arguments.command ONLY. A cmd-shaped job then took a valid
    # script_b64 from the CP and a hard 403 "approved job carries no command"
    # here -- permanently, and unrepairable by any agent, because every agent
    # path (stage_privileged_job -> gate -> waCallExec -> /run) ends at this
    # endpoint. Precedence below is IDENTICAL to waJobCommand: command wins,
    # cmd is the fallback, "" if neither -- and, as in JS, an empty-string
    # command falls through to cmd rather than pinning against "".
    # This widens WHERE the approved command is read from. It does not widen
    # WHAT is authoritative: the pin below still compares any presented
    # script_b64 against this document-sourced value and refuses on mismatch.
    approved = args.get("command") or args.get("cmd") or ""
    script_b64 = body.get("script_b64")
    if script_b64:
        try:
            presented = base64.b64decode(script_b64).decode("utf-8")
        except Exception:
            return jsonify({"error": "script_b64 is not valid base64 utf-8"}), 400
        if not approved:
            log_journal("exec_refused_no_approved_command",
                        "REFUSED job %s: a script was presented but the approved job carries no command to match it against." % job_id,
                        job_id)
            return jsonify({"error": "refused: approved job carries no command; a presented script cannot be authorised"}), 403
        pd = hashlib.sha256(presented.encode("utf-8")).hexdigest()
        ad = hashlib.sha256(approved.encode("utf-8")).hexdigest()
        if pd != ad:
            # Never echo either command or either full digest -- job stdout is
            # permanent in Firestore. Short prefixes are enough to correlate.
            log_journal("exec_refused_command_mismatch",
                        "REFUSED job %s: presented script does not match the approved command (presented sha %s..., approved sha %s...). Nothing ran." % (job_id, pd[:12], ad[:12]),
                        job_id)
            return jsonify({"error": "refused: presented script does not match the approved command",
                            "presented_sha_prefix": pd[:12],
                            "approved_sha_prefix": ad[:12]}), 403
    command = approved

    # ---- [APPROVED-SHA256-ENFORCE-V1] ----
    # Placed AFTER `command = approved` on purpose: attempt 1 sat before it, referenced
    # `command`, and raised UnboundLocalError -> HTTP 500 on every stamped job.
    #
    # The pin above compares a presented script against a value re-read from Firestore in
    # this same request. This service's own SA can write that document, so that comparison
    # can be satisfied by rewriting both sides. approved_sha256 is stamped by the control
    # plane AT APPROVAL TIME and is the only thing here the document cannot restate later.
    #
    # [SEC-APPROVED-SHA-REQUIRED-V1] A MISSING PIN NOW REFUSES. THE FALLBACK IS DELETED,
    # NOT WEAKENED, AND "absent" IS NO LONGER A WAY TO REACH THE COMMAND.
    #
    # WHY THIS IS SAFE NOW AND WAS NOT BEFORE. The deleted fallback's own stated exit
    # condition was that the absence journal reach zero on its own. IT NEVER COULD, and the
    # reason was a defect rather than a backlog: the control plane had exactly ONE writer of
    # approved_sha256, inside the passkey approve route, and the pre-approve ->
    # POST /api/jobs/fire path never passes through that route. EVERY pre-approved job
    # therefore arrived here with the field absent, permanently, so the absence count was
    # pinned above zero by live traffic and the fallback could never retire itself.
    # That writer gap is closed in the SAME change as this refusal --
    # [APPROVED-SHA256-WRITER-V2] in control-plane/src/index.ts stamps approved_sha256
    # beside cmd_sha at pre-approval time -- so from this commit forward every approval
    # path that can reach this endpoint stamps a pin, and this rung is reachable for all
    # of them rather than for one of them.
    #
    # WHAT THIS COSTS, ACCEPTED DELIBERATELY AND STATED IN THE COMMIT MESSAGE RATHER THAN
    # EXCUSED IN A FALLBACK: a job approved or pre-approved BEFORE this commit and not yet
    # executed carries no pin, and it is refused here. It must be staged and approved
    # again. That is a one-time cost, paid once, and it is the entire point -- an unpinned
    # job is one whose command nobody can prove a human ever saw.
    #
    # THIS IS NOT THE ed-S39 SELF-LOCKOUT, AND THE DIFFERENCE IS THE WRITER. That lockout
    # was enforcement shipping WITHOUT a writer, which 403s every job forever including the
    # one that would undo it. The writer is present here and lands with it. An undo is also
    # not a gated job: it is a source change carried by the build, so it never has to pass
    # this rung to be applied.
    _asha = job.get("approved_sha256")
    if _asha is None or _asha == "":
        # NEVER SILENT. A fail-closed control that refuses without saying which job and why
        # is indistinguishable from a broken executor, and the operator is the one who has
        # to tell those apart at the gate.
        log_journal("exec_refused_sha_absent",
                    "REFUSED job %s: it carries no approved_sha256, so it PREDATES THE COMMAND "
                    "PIN and there is nothing on this document that proves the command is the "
                    "one a human approved. Stage it and approve it again to get a pinned job. "
                    "NOTHING RAN." % job_id,
                    job_id)
        return jsonify({"error": "refused: this job predates the command pin and carries no "
                                 "approved_sha256; stage and approve it again",
                        "predates_pin": True}), 403
    _ok = isinstance(_asha, str) and len(_asha) == 64
    if _ok:
        try:
            int(_asha, 16)
        except Exception:
            _ok = False
    if not _ok:
        # Present but unreadable is NOT absent. Treating it as absent would hand anyone
        # who can write this document a bypass: write junk, skip the check.
        log_journal("exec_refused_sha_unreadable",
                    "REFUSED job %s: approved_sha256 is present but is not a 64-char hex "
                    "digest. Refusing rather than falling back. NOTHING RAN." % job_id,
                    job_id)
        return jsonify({"error": "refused: approved_sha256 is present but unreadable"}), 403
    _live = hashlib.sha256(command.encode("utf-8")).hexdigest()
    if _live != str(_asha).lower():
        # Never echo either command or either full digest; job stdout is permanent.
        log_journal("exec_refused_command_changed_after_approval",
                    "REFUSED job %s: the command on this document no longer hashes to the "
                    "digest captured when a human approved it (now %s..., approved %s...). "
                    "NOTHING RAN." % (job_id, _live[:12], str(_asha)[:12]),
                    job_id)
        return jsonify({"error": "refused: the command changed after it was approved",
                        "current_sha_prefix": _live[:12],
                        "approved_sha_prefix": str(_asha)[:12]}), 403


    # ---- [SEC-KMSSIGN-EXEC-V1] APPROVAL SIGNATURE, ASYMMETRIC (PC-APPROVAL-CANON-V1) ----
    # TOP LEVEL, AND IT MUST STAY THAT WAY. This was once nested inside the
    # approved_sha256 else-branch and that was a real bug: a document with no
    # approved_sha256 took the "absent -> allowed" path above and never reached the
    # signature check, so ONE deleted field turned off BOTH controls. That
    # absent-allowed path is itself gone as of [SEC-APPROVED-SHA-REQUIRED-V1] above --
    # a missing pin now REFUSES -- so the original trap can no longer be sprung, but the
    # rule outlives it: do NOT nest this check inside any approved_sha256 branch. The
    # adversary this design names is the one who can write the document, and writing
    # includes deleting.
    #
    # WHAT THIS SERVICE HOLDS: a PUBLIC KEY. Nothing here can sign. The previous
    # control verified an HMAC with the symmetric approval-MAC secret -- the same key
    # that produced it -- so this service could mint approvals for itself. That is
    # deleted, not
    # weakened, and that secret's environment variable is no longer read anywhere in
    # this file.
    #
    # FAIL CLOSED, ON EVERY RUNG. The rung this replaces tested the symmetric key for
    # emptiness and ALLOWED, journalling that it had not checked. That is why
    # withdrawing the key from this service made the system WORSE: the control did not
    # fail closed, it evaporated into a log line. Here, "could not check" REFUSES.
    _cmd_sha = hashlib.sha256(command.encode("utf-8")).hexdigest()
    # [SEC-KMSSIGN-EXEC-V1 LANDING DEFAULT = PERMISSIVE] The in-code default is "0",
    # i.e. an ABSENT signature is ALLOWED unless APPROVAL_REQUIRE_SIGNED=1 is set
    # explicitly. This is DELIBERATE and it is the difference between landing this
    # control and bricking the fleet. Landing the verifier with require-on enters
    # Stage B and Stage C in the same commit and 403s every document approved before
    # the signer shipped -- INCLUDING THE UNDO THAT WOULD REMOVE THIS BLOCK, which is
    # the ed-S39 self-lockout that is permanently banned here.
    # DO NOT "fix" this by deleting the variable: DELETING IT RELAXES THIS CHECK
    # RATHER THAN TIGHTENING IT -- absent reads as "0", so an unsigned approval RUNS.
    # Set it explicitly, to "0" or to "1". Flip it to "1" only after the
    # absent-signature journal line below has stopped appearing and stayed gone.
    # NOTE WHAT THIS DOES *NOT* RELAX: "bad" and "unverifiable" below refuse
    # UNCONDITIONALLY and are not gated on this flag. A missing, empty or unfetchable
    # key NEVER permits execution.
    _require_signed = os.environ.get("APPROVAL_REQUIRE_SIGNED", "0") == "1"
    # [PC-APPROVAL-CANON-V2] THE EXECUTION CONTEXT THE SIGNATURE IS CHECKED AGAINST IS THE
    # ONE WE ARE ABOUT TO USE. command_type is the same value the dispatch below reads, and
    # the arguments are read RAW -- job.get("arguments"), NOT the `args` dict above, which
    # defaults to {} for its own convenience. The control plane signs "null" for an absent
    # arguments field and "{}" for an empty object, and those are different bytes; using
    # `args` here would break every job that carries no arguments at all.
    _args_sha, _args_why = pc_canon_args_sha(job.get("arguments"))
    _sig_outcome, _sig_detail = pc_verify_approval_signature(
        job, job_id, _cmd_sha, command_type, _args_sha, _args_why)

    if _sig_outcome == "bad":
        # Checked, and failed. Never conditional on the mode: a signature that is
        # present and wrong is an attack, not a migration artefact.
        # [PC-APPROVAL-CANON-V2] NAME THE FIELDS THAT CAN HAVE MOVED, AND SAY HOW WE KNOW.
        # This is a deduction, not a guess. Of the nine V2 fields, alg, appr, kver, iat and
        # exp are read off the document and fed into the rebuild unchanged, so a change to
        # any of them changes both sides together and cannot be what failed here. jid is the
        # document id we were asked for. csha was compared against approved_sha256 ABOVE and
        # matched, or this line would be unreachable. That leaves EXACTLY ctyp and asha --
        # the execution context -- and their current values are printed so the operator can
        # hold them against the job they remember approving.
        # WE CANNOT SAY WHICH OF THE TWO, AND THAT IS THE PRICE OF NOT STORING THEM. The
        # signed values of ctyp and asha are deliberately absent from this document; storing
        # them so this message could be sharper would hand whoever rewrote command_type the
        # matching value to rewrite beside it. A vaguer refusal is the correct trade.
        _ctx = ""
        if job.get("approval_sig_canon") == PC_CANON_V2_ID:
            _ctx = (" The command text still matches the digest a human approved, so what "
                    "diverged is the EXECUTION CONTEXT this run would have used: "
                    "command_type is now %r (the %s branch) and the arguments now hash to "
                    "%s. One or both of those is not what was signed; this service cannot "
                    "say which, because neither signed value is stored on this document, "
                    "on purpose."
                    % (str(command_type)[:40], pc_exec_branch(command_type),
                       (str(_args_sha)[:16] + "...") if _args_sha else "(uncanonicalisable)"))
        log_journal("exec_refused_approval_sig",
                    "REFUSED job %s: %s. The command and its digest agree with each other, "
                    "which means BOTH were rewritten together -- exactly what the signature "
                    "exists to catch.%s NOTHING RAN." % (job_id, _sig_detail, _ctx),
                    job_id)
        return jsonify({"error": "refused: the approval signature does not verify"}), 403

    if _sig_outcome == "unverifiable":
        # COULD NOT CHECK. This is the rung that used to allow. It refuses regardless
        # of APPROVAL_REQUIRE_SIGNED, because "we were not given the means to check"
        # must never be a way to switch the check off.
        log_journal("exec_refused_approval_sig_unverifiable",
                    "REFUSED job %s: a signature is present but COULD NOT BE CHECKED (%s). "
                    "An unchecked signature is not a pass. NOTHING RAN." % (job_id, _sig_detail),
                    job_id)
        return jsonify({"error": "refused: the approval signature could not be verified"}), 403

    if _sig_outcome == "absent":
        if _require_signed:
            # OPT-IN, and NOT the default in this landing. Reached only when
            # APPROVAL_REQUIRE_SIGNED=1 is set explicitly on the service. See the
            # landing-default note above for why the in-code default is "0".
            log_journal("exec_refused_unsigned_approval",
                        "REFUSED job %s: this deployment requires signed approvals and the "
                        "document carries none (%s). NOTHING RAN. If this is an A->B->C "
                        "migration that has not reached C, set APPROVAL_REQUIRE_SIGNED=0 on "
                        "this service -- from the deploy surface, not through the gate."
                        % (job_id, _sig_detail),
                        job_id)
            return jsonify({"error": "refused: this deployment requires signed approvals"}), 403
        # MIGRATION FALLBACK, and it is the ONLY rung that still allows. Documents
        # predating the signer must keep running during A->B. Said out loud rather
        # than passed silently: an attacker who can write this document can DELETE
        # approval_sig to reach this rung, which is why the permissive default is a
        # MIGRATION STATE AND NOT A POSTURE, and why install.sh arms
        # APPROVAL_REQUIRE_SIGNED=1 last, so a fresh install never opens this door.
        log_journal("exec_approval_sig_absent",
                    "job %s carries no approval_sig (%s). Allowed ONLY because "
                    "APPROVAL_REQUIRE_SIGNED=0 on this service. This is not a pass. Set it "
                    "to 1 once this line stops appearing." % (job_id, _sig_detail),
                    job_id)
    elif _sig_outcome == "ok_v1":
        # [PC-APPROVAL-CANON-V2] A V1 STAMP IS A NARROWER AUTHORISATION THAN A V2 ONE, AND
        # THE DIFFERENCE IS THE DESTINATION. V1's signed field set covers the command TEXT
        # and the job id and nothing about where the text runs. So a V1 signature is
        # evidence that a human approved these bytes, and NO evidence at all that they
        # approved them being carried to another machine. Accepting one for a non-local job
        # would leave the original hole open under a new name: rewrite command_type and
        # targetNode on an approved local job and every signed byte still verifies.
        # [SEC-SSHTOOL-REMOVED-V1] No non-local branch exists right now, so this refusal is
        # unreachable today. IT STAYS. It is the guard that makes adding one safe, and the
        # cost of keeping it is nine lines; the cost of re-deriving it later is a CVE.
        # THIS REFUSAL IS NOT GATED ON APPROVAL_ACCEPT_CANON_V1. That flag decides whether a
        # V1 stamp is worth anything at all; it does not decide what a V1 stamp MEANS.
        if pc_exec_branch(command_type) != "local":
            log_journal("exec_refused_v1_stamp_non_local",
                        "REFUSED job %s: it carries a %s approval signature, which covers "
                        "the command text but NOT command_type and NOT the arguments, and "
                        "command_type %r selects the %s branch rather than local execution. "
                        "A %s stamp CANNOT authorise a destination it never signed -- that "
                        "is the exact gap %s exists to close. Stage and approve the job "
                        "again to get a %s stamp, which covers both. NOTHING RAN."
                        % (job_id, PC_CANON_ID, str(command_type)[:40],
                           pc_exec_branch(command_type), PC_CANON_ID, PC_CANON_V2_ID,
                           PC_CANON_V2_ID),
                        job_id)
            return jsonify({"error": "refused: a %s approval signature cannot authorise a "
                                     "non-local command_type" % PC_CANON_ID,
                            "canon": PC_CANON_ID,
                            "command_type": str(command_type)[:40]}), 403
        log_journal("exec_approval_sig_ok_v1",
                    "job %s: approval signature verified (%s), but under %s, which does NOT "
                    "cover command_type or the arguments. Allowed ONLY because command_type "
                    "%r selects local execution AND APPROVAL_ACCEPT_CANON_V1=1 on this "
                    "service. This is a migration state, not a pass: set it to 0 once this "
                    "line stops appearing."
                    % (job_id, _sig_detail, PC_CANON_ID, str(command_type)[:40]),
                    job_id)
    else:
        log_journal("exec_approval_sig_ok",
                    "job %s: approval signature verified (%s). The command text, the "
                    "command_type and the arguments are all inside the signed bytes."
                    % (job_id, _sig_detail),
                    job_id)

    if not command:
        return jsonify({"error": "No command found in the approved job arguments"}), 400

    # ---- [GCP-LOCKOUT-CHECK-V1] PRE-EXECUTE LOCKOUT-CLASS REFUSAL ----
    # deploy/LOCKOUT-CLASS.md names nine categories of change that DESTROY THE WAY BACK
    # IN, and names this exact position for the check: "pre-execute, over every job body
    # before execution". It sits HERE, and not earlier, because `command` is only fully
    # resolved, pinned to approved_sha256 and signature-verified ABOVE this line -- and
    # nothing has been spent yet: approval_staleness_refusal and claim_job_for_execution
    # are both BELOW it. So a refusal here burns no approval, and the same job remains
    # approvable by hand on the human path.
    #
    # THIS IS THE CONTROL THAT REPLACES THE CLICK. IT IS NOT A SECOND COPY OF IT.
    # Removing the human tap moves the class from "a human reads every job" to "this
    # reads every job, and only the nine named categories reach a human". A refusal is
    # therefore ROUTED, never dropped: 403 carrying the rule ids, journalled by rule id,
    # and the job is left where a human can still approve it.
    #
    # [SEC-NOBRAKES-V1] 2026-08-14, OPERATOR RULING, AND IT REVERSES WHAT THIS BLOCK USED TO SAY.
    # The text here read 'FAIL-CLOSED, DELIBERATELY, AND NOT SWITCHABLE' and argued that the
    # checker's disable switch must not be reachable from the path it guards. That argument is
    # sound and it is no longer the operator's policy. Verbatim: 'breakage is acceptable we have
    # checks to prevent[;] if we break we figure it out in chat and cowork a cloudshell or I paste
    # the fix[;] we roll forward[;] we don't add speed bumps we add accelerators'.
    #
    # WHAT THAT MEANS PRECISELY, because it is a narrower change than 'checks are off':
    # every check that fails a CUT stays exactly as it is -- oss/gen.py's refusals, route-audit,
    # blob-audit, the leak ceilings, smoke.py, the compare-and-swap on push. Those cost zero
    # runtime friction and catch a defect before it can ship, which is the accelerator. What is
    # switched off is the refusal that stops a job the operator already asked for.
    #
    # THE RECOVERY PATH IS THE ONE THEY NAMED. A lockout-class change can take the console's own
    # auth out, and the way back is Cloud Shell, which they hold and have used repeatedly today.
    # This file no longer decides that for them.
    #
    # THE CHECKER STILL RUNS AND STILL JOURNALS. Detection is not friction: knowing which rule
    # matched is exactly what makes 'we figure it out in chat' possible after the fact. Only the
    # 403 is gone. PC_GUARDRAILS=1 restores the refusal for an adopter who wants it; it defaults
    # to 0 because the operator's posture is the shipped posture.
    #
    # A MISSING OR BROKEN CHECKER NO LONGER REFUSES EITHER. Failing closed on an import error
    # would be a speed bump arriving for a reason that has nothing to do with the job.
    _lc_guard = os.environ.get("PC_GUARDRAILS", "0").strip() == "1"
    _lc_hits = []
    try:
        import lockout_check as _lc
        _lc_hits = _lc.check(command)
    except Exception as _lc_err:
        log_journal("exec_lockout_checker_unavailable",
                    "job %s: the lockout checker did not run (%s). It is advisory now, so this "
                    "is recorded and the job continues."
                    % (job_id, type(_lc_err).__name__),
                    job_id)
        if _lc_guard:
            return jsonify({"error": "refused: lockout checker unavailable and PC_GUARDRAILS=1",
                            "detail": type(_lc_err).__name__}), 403
    if _lc_hits:
        _lc_ids = [rid for rid, _ in _lc_hits]
        # THE OPERATOR'S ACKNOWLEDGEMENT RIDES INSIDE `arguments`, AND THAT IS THE WHOLE
        # POINT OF PUTTING IT THERE. arguments is covered by asha -- field 5 of
        # PC-APPROVAL-CANON-V2 -- so adding or flipping lockout_ack in transit changes the
        # canonical arguments hash and the approval signature verified ABOVE this line
        # fails. A header, a query parameter or a top-level body field would all have been
        # forgeable by whoever could reach this endpoint; this one cannot be.
        #
        # WITH THE GATE CONSOLE REMOVED, THE HUMAN PATH IS CHAT. The operator no longer
        # approves by tapping a page, so a refusal here is relayed upward as a question and
        # comes back, if they say yes, as a re-issued job carrying this ack. The decision is
        # still a human's; only the channel changed. It is journalled under its own action
        # so that "a human said yes to a lockout-class change" can never be confused in the
        # transcript with "the checker found nothing".
        if args.get("lockout_ack") is True:
            log_journal("exec_lockout_acked",
                        "job %s matched lockout-class rule(s) %s and carried a signed operator "
                        "acknowledgement, so it RAN. This is the deliberate override path, not "
                        "a checker miss." % (job_id, ",".join(_lc_ids)),
                        job_id)
        elif not _lc_guard:
            log_journal("exec_lockout_class_ran",
                        "job %s matched lockout-class rule(s) %s and RAN anyway: PC_GUARDRAILS is "
                        "off, which is the shipped default. Recorded here so the transcript can "
                        "answer 'what took the console out' without anyone guessing."
                        % (job_id, ",".join(_lc_ids)),
                        job_id)
        else:
            log_journal("exec_refused_lockout_class",
                        "REFUSED job %s: lockout-class rule(s) %s matched, PC_GUARDRAILS=1 and no "
                        "operator acknowledgement was present. Relayed to the operator, NOT dropped."
                        % (job_id, ",".join(_lc_ids)),
                        job_id)
            return jsonify({"error": "refused: lockout-class change -- needs an operator acknowledgement",
                            "rules": _lc_ids,
                            "reasons": [r for _, r in _lc_hits]}), 403

    allowlist = {"echo", "gcloud", "firebase", "npm", "node", "python3"}
    for line in command.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        first_token = line.split()[0]
        if first_token not in allowlist:
            # EXEC-ALLOWLIST-OBSERVE-A-v1 OBSERVE-ONLY BY DEFAULT. See the header comment for why.
            # Absence of the env var means OBSERVE, never enforce: this control was
            # never live, and enforcing it (`set -uo pipefail` -> 400) is what broke
            # production. The human approval at the gate and the sha-pin are the real
            # controls; this one is weak and is now evidence-gathering, not a gate.
            # The skip is JOURNALLED so it can never look like the check passing.
            # [EXEC-BIN-JAIL-V82] EXEC_BINARY_ALLOWLIST_ENFORCE IS DELETED, NOT DEFAULTED OFF.
            # Leaving a switch whose documented effect is "return 400 on every multi-line job"
            # is a footgun aimed at production, and it is superseded: the PATH jail below is
            # the control now. This scan survives ONLY as telemetry -- it says what a script
            # opened its lines with, which is useful signal and was never a boundary.
            log_journal("exec_allowlist_observe", "job %s: first token %r is outside the named set (telemetry only; the PATH jail is the control)" % (job_id, first_token), job_id)

    access_token = body.get("access_token")

    env = dict(os.environ)
    env["CLOUDSDK_CORE_DISABLE_PROMPTS"] = "1"
    # [EXEC-BIN-JAIL-V82] Restrict PATH to the permitted binaries. Built per request so a
    # change to the image is picked up without a restart, and journalled once per job so the
    # boundary that was actually applied is a fact in the audit trail rather than an
    # assumption. Disable with EXEC_BIN_JAIL=0 if an install needs a binary not on the list.
    # [EXEC-BIN-JAIL-FAILOPEN-V84] If the jail cannot be BUILT, run unjailed and say so loudly
    # rather than refusing the job. The jail is defence in depth; the primary controls -- a human
    # approved this exact command, and the sha256 pin -- are untouched by its absence. An executor
    # that refuses every job because it could not make a temp directory is a self-inflicted outage
    # that also takes away the operator's only way to fix it, which is a strictly worse failure
    # than running with one secondary control missing. The journal row is the detection.
    try:
        _jail_dir, _jail_linked, _jail_missing = pc_build_bin_jail()
    except Exception as _je:
        _jail_dir, _jail_linked, _jail_missing = None, [], []
        try:
            log_journal("exec_bin_jail_unavailable",
                        "job %s: the binary PATH jail could not be built (%r); running UNJAILED. "
                        "The approval and the sha256 pin are unaffected." % (job_id, _je), job_id)
        except Exception:
            pass
    if _jail_dir:
        env["PATH"] = _jail_dir
        log_journal("exec_bin_jail",
                    "job %s: PATH restricted to %d permitted binaries (%d of the named set are "
                    "not on this image). Absolute paths are NOT blocked by this control."
                    % (job_id, len(_jail_linked), len(_jail_missing)), job_id)
    if access_token:
        # Bind gcloud/gsutil/bq to the approver's identity
        env["CLOUDSDK_AUTH_ACCESS_TOKEN"] = access_token

    # ---- [EXEC-SINGLE-USE-V1] ----
    # Bound the age of the approval, then consume it -- both BEFORE anything
    # runs. Every refusal above this line (status, sha mismatch, allowlist)
    # happens first and consumes nothing, so a failed substitution attempt
    # cannot burn a genuine approval.
    _stale = approval_staleness_refusal(job)
    if _stale:
        log_journal("exec_refused_stale_approval",
                    "REFUSED job %s: %s. NOTHING RAN." % (job_id, _stale),
                    job_id)
        return jsonify({"error": "refused: stale approval", "detail": _stale}), 403
    try:
        claim_id, claim_err = claim_job_for_execution(job_id)
    except Exception as e:
        # [EXEC-CLAIM-BUCKET-V1] THE OUTCOME IS UNKNOWN, AND THE LINE SAYS UNKNOWN. A 403, a
        # 500, a timeout or a lost reply leaves it genuinely undetermined whether the claim
        # landed. Writing "already spent" here would be a guess recorded as a fact, and the
        # operator would re-stage on the strength of it; writing "not spent" would be the
        # same guess in the other direction, and a re-fire could then double-run the job.
        # So the journal says what is true: nothing ran, and the state of the approval is
        # not established from here. The bucket is where the answer is, if there is one.
        log_journal("exec_refused_claim_error",
                    "REFUSED job %s: the claim outcome is UNKNOWN -- the approval may or may "
                    "not now be spent, and this service cannot tell which (%s). Fail closed "
                    "-- NOTHING RAN." % (job_id, e),
                    job_id)
        return jsonify({"error": "refused: the approval could not be consumed atomically; nothing ran",
                        "detail": "the claim outcome is UNKNOWN; nothing ran and the approval "
                                  "may or may not be spent"}), 503
    if not claim_id:
        # [SEC-EXEC-NO-DATASTORE-V1] The status was printed here and is not printed any more.
        # It would now be a value the caller supplied about itself, and a journal line that
        # repeats an unverified assertion as though it were an observation is worse than one
        # that omits it -- this journal is read to reconstruct refusals.
        log_journal("exec_refused_replay",
                    "REFUSED job %s: %s. NOTHING RAN." % (job_id, claim_err),
                    job_id)
        return jsonify({"error": "refused: this approval has already been spent (one approval = one run)",
                        "detail": claim_err}), 409
    log_journal("exec_claim",
                "Consumed approval for job %s (claim %s). This approval is now spent."
                % (job_id, claim_id[:12]),
                job_id)

    log_journal("exec_start", f"Starting execution of job {job_id} ({command_type}) with approver-scoped creds", job_id)

    exit_code = -1
    stdout, stderr = "", ""
    try:
        # [SEC-SSHTOOL-REMOVED-V1] ONE BRANCH. This used to be `if ssh ... else local`, and
        # the ssh half wrote a private key to a temp file and shelled out to `ssh <targetNode>`.
        # It is gone: nothing could stage such a job, no deployment ever configured the key,
        # and a branch that has never executed is not a feature. Adding a second branch back
        # means updating pc_exec_branch() in the same change -- read the note there first.
        with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=True) as f:
            f.write(command)
            f.flush()
            r = subprocess.run(["bash", f.name], env=env, capture_output=True, text=True, timeout=MAX_SECONDS)
            exit_code = r.returncode
            stdout = (r.stdout or "")[-8000:]
            stderr = (r.stderr or "")[-8000:]

    except subprocess.TimeoutExpired as e:
        exit_code = 124
        stdout = (e.stdout or "")[-8000:] if e.stdout else ""
        stderr = f"TIMEOUT after {MAX_SECONDS}s"
    except Exception as e:
        exit_code = 1
        stderr = str(e)

    # ---- [EXEC-BUCKET-V1] THE RESULT IS AN OBJECT, WRITTEN BEFORE THIS RETURNS ----
    # WHAT THE RESULT WRITE IS FOR, unchanged: a long job has to be survivable when the
    # caller request dies. The record is written HERE, at the end of the run and before the
    # response, so a caller that is gone by now -- a closed browser, a proxy timeout, a
    # dropped connection -- costs nothing. That is why it is written before the return and
    # not handed back only in the body.
    #
    # THE OBJECT IS THE RECORD, AND NOW IT IS THE ONLY ONE THIS SERVICE WRITES. Create-only
    # means this service cannot come back and edit a result it has written, which is exactly
    # what makes the result worth reading. [SEC-EXEC-NO-DATASTORE-V1] the legacy Firestore
    # mirror that used to follow it is deleted with the grant, as the line that used to sit
    # here said it would be. The console is not left blank by that: the control plane ingest
    # writes status, exit_code, stdout_tail and stderr_tail onto the job document from THIS
    # object, and the god-mode path writes them from the response body as well, so the row the
    # gate page reads has two independent producers and neither of them is this service.
    #
    # IF THE CONTROL PLANE INGEST NEVER RUNS, THE RESULT IS STILL THERE. It is an object in
    # a bucket, named deterministically from the job id, and it is recoverable with one
    # command by anyone who can read the bucket:
    #     gcloud storage cat gs://$PC_EXEC_BUCKET/results/<job-id>-<digest>.json
    # Ingest is a convenience that puts the row back where the console expects it. It is
    # not custody, and nothing is lost by it never running.
    _res_payload = {
        "job_id": job_id,
        "exec_claim_id": claim_id,
        "command_type": command_type,
        "status": "executed",
        "exit_code": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "executed_at": pc_now_stamp(),
    }
    # No `if PC_EXEC_BUCKET:` guard any more -- pc_arming_refusal() refused this request at
    # the top of run() if the bucket were unset, so by this line it is configured and the
    # conditional could only ever hide a state that cannot occur.
    _res_name, _res_outcome, _res_detail = pc_write_result_object(job_id, _res_payload)
    if _res_outcome != "created":
        # LOUD, and never fatal. The job HAS RUN by this line; refusing to return now
        # would lose the only other copy of the result -- the response body -- as well.
        log_journal("exec_result_object_unwritten",
                    "job %s RAN (exit %d) and its result object %s was NOT written (%s: "
                    "%s). The result is in this response body ONLY -- the Firestore mirror "
                    "went with roles/datastore.user. An 'exists' here means a second result "
                    "for one job id, which one approval = one run says cannot happen; "
                    "investigate rather than "
                    "retrying." % (job_id, exit_code, _res_name, _res_outcome, _res_detail),
                    job_id)

    log_journal("exec_complete", f"Completed job {job_id} with exit code {exit_code}", job_id)

    return jsonify({"job_id": job_id, "exit_code": exit_code, "stdout": stdout, "stderr": stderr}), 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
