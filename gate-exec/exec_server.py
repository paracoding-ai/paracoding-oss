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
#      Do not cite byte-identity as a reason to stand any other control down.
#  Neither of those is touched by this change.
#
#  IT IS NOT A SILENT BYPASS. Observe mode JOURNALS every non-allowlisted first
#  token as action "exec_allowlist_observe", so a skip is visible in the journal and
#  can never be mistaken for the check having passed -- that exact confusion is a
#  documented recurring defect in this fleet. Those journal rows are also the data
#  needed to decide whether enforcement is ever worth turning on.
#
#  TO ENFORCE: set EXEC_BINARY_ALLOWLIST_ENFORCE=1 in the service environment.
#  Absence of that variable means OBSERVE, never enforce. Do not flip the default
#  without reading the exec_allowlist_observe journal first.
# ----------------------------------------------------------------------------------
import os, subprocess, tempfile, json, base64, hashlib, hmac
from flask import Flask, request, jsonify
from google.cloud import firestore

app = Flask(__name__)
MAX_SECONDS = int(os.environ.get("EXEC_TIMEOUT", "900"))
# [SEC-NAMED-DB-V1] Match the control plane: our own named database, never (default).
db = firestore.Client(database=os.environ.get("PC_FIRESTORE_DB", "(default)"))

def log_journal(action, message, job_id=None):
    try:
        db.collection("journal").add({
            "agent_id": "fleet-gate-exec",
            "action": action,
            "message": message,
            "job_id": job_id or "",
            "timestamp": firestore.SERVER_TIMESTAMP
        })
    except Exception as e:
        print(f"Failed to log to journal: {e}")

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


def approval_staleness_refusal(job):
    """Returns a refusal reason for a stale 'confirmed' approval, else None.
    Only 'confirmed' is bounded: 'executing' means a control-plane approval path
    is driving this run right now. 0 disables (escape hatch, not recommended)."""
    if APPROVAL_MAX_AGE <= 0:
        return None
    if job.get("status") != "confirmed":
        return None
    ts = job.get("confirmed_at")
    if ts is None:
        return ("this job is 'confirmed' but carries no confirmed_at, so the age of the "
                "approval cannot be established; refusing rather than trusting it")
    try:
        if isinstance(ts, _dt.datetime):
            when = ts if ts.tzinfo else ts.replace(tzinfo=_dt.timezone.utc)
        elif isinstance(ts, (int, float)):
            secs = float(ts) / 1000.0 if float(ts) > 1e11 else float(ts)
            when = _dt.datetime.fromtimestamp(secs, _dt.timezone.utc)
        else:
            return ("this job's confirmed_at is a %s, which cannot be read as a time; "
                    "refusing rather than trusting it" % type(ts).__name__)
        age = (_dt.datetime.now(_dt.timezone.utc) - when).total_seconds()
    except Exception as e:
        return "this job's confirmed_at could not be read (%s); refusing rather than trusting it" % e
    if age > APPROVAL_MAX_AGE:
        return ("this approval is %d seconds old (limit %d). A human approval is not a "
                "standing authorisation; re-approve it" % (int(age), APPROVAL_MAX_AGE))
    return None


def claim_job_for_execution(job_ref, job_id):
    """Atomically consume this approval. Returns (claim_id, None) on success, or
    (None, reason) if it was already spent or is no longer approvable. Raises on
    transport error; the caller refuses."""
    claim_id = hashlib.sha256(os.urandom(32)).hexdigest()[:32]

    @firestore.transactional
    def _claim(tx):
        snap = job_ref.get(transaction=tx)
        if not snap.exists:
            return (None, "the job document disappeared before the approval could be consumed")
        d = snap.to_dict() or {}
        prior = d.get("exec_claim_id")
        if prior:
            return (None, "this approval was already consumed (claim %s, at %s); one approval = "
                    "one run, re-stage the job to run it again"
                    % (str(prior)[:12], str(d.get("exec_claimed_at") or "an earlier time")))
        now_status = d.get("status")
        if now_status not in ["confirmed", "executing"]:
            return (None, "the job stopped being approvable while we were starting it "
                    "(status is now %s)" % now_status)
        tx.update(job_ref, {
            "exec_claim_id": claim_id,
            "exec_claimed_at": firestore.SERVER_TIMESTAMP,
            "exec_claimed_from_status": now_status,
        })
        return (claim_id, None)

    return _claim(db.transaction())


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


def pc_verify_approval_signature(job, job_id, cmd_sha, now=None):
    """The whole check. Returns (outcome, detail); outcome is exactly one of:

        "ok"            present and verified
        "absent"        no approval_sig on the document
        "unverifiable"  present but COULD NOT be checked
        "bad"           present and DID NOT verify (or is expired / future-dated)

    "unverifiable" is NEVER "ok" and the caller refuses on it. Never raises, never allows.

    jid and csha are taken from THE JOB BEING EXECUTED and the COMMAND ABOUT TO RUN --
    never from the stamp. Taking them from the document would let anyone with
    roles/datastore.user move both sides of the comparison together, which is the exact
    defect Stage C exists to close."""
    sig_b64 = job.get("approval_sig")
    if sig_b64 is None or sig_b64 == "":
        return ("absent", "the document carries no approval_sig")
    if not isinstance(sig_b64, str):
        return ("unverifiable", "approval_sig is a %s, not a string" % type(sig_b64).__name__)

    if job.get("approval_sig_canon") != PC_CANON_ID:
        return ("unverifiable", "the stamp names canonicalisation %r, not %s"
                % (str(job.get("approval_sig_canon"))[:40], PC_CANON_ID))
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
    msg, why = pc_approval_canon_v1(PC_SIG_ALG, job_id, cmd_sha, appr, kver, iat_s, exp_s)
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
    return ("ok", "verified against %s" % kver.rsplit("/", 1)[-1])



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


# ---- [SEC-SSHKEY-PREFLIGHT-V1] AN SSH JOB MUST NOT SPEND AN APPROVAL AND THEN DIE ----
# WHAT WAS WRONG. The ssh branch below used to read a Secret Manager secret whose name was
# HARDCODED here, that no installer has ever created, and it read it INSIDE the try block --
# which sits BELOW claim_job_for_execution(). So a command_type=="ssh" job passed every
# check, CONSUMED the one-shot approval a human had just spent a passkey tap on, and only
# then raised "Failed to get SSH key". One approval, no run, nothing left to re-spend, and
# the operator had to be asked for a second tap to learn the same thing.
#
# TWO CHANGES, AND THE ORDER OF THEM IS THE POINT.
#
#  1. THE SECRET NAME IS CONFIGURATION AND HAS NO DEFAULT. An unset EXEC_SSH_KEY_SECRET
#     means this deployment has no SSH key and ssh jobs are REFUSED. It does not mean "guess
#     a name". The guessed default this replaces was a private, operator-specific resource
#     name that reached a public tree, and a name nobody creates is indistinguishable at
#     runtime from a name nobody has permission to read.
#
#  2. THE READ HAPPENS ABOVE THE CLAIM, beside the refusals the EXEC-SINGLE-USE-V1 comment
#     already promises "consume nothing". Unconfigured, unreadable, and empty-payload all
#     refuse before the approval is spent, so a refused ssh job costs the operator nothing
#     and the same approval can be re-presented once the key exists.
#
# WHAT THIS DOES NOT CLAIM TO FIX. The refusal still arrives AFTER the human has tapped,
# because this service is only reached post-approval. Refusing to STAGE an ssh job on a
# deployment with no key configured belongs in the control plane's ssh_executor handler and
# is not this file's to make.
EXEC_SSH_KEY_SECRET = os.environ.get("EXEC_SSH_KEY_SECRET", "")


def ssh_key_preflight(env):
    """Resolve the private key for a command_type=='ssh' job BEFORE the approval is claimed.

    Returns (key, None) or (None, reason). Never raises. An empty payload is a REASON, not a
    key: writing a zero-byte identity file would push the failure back down into ssh, i.e.
    below the claim, which is the whole defect being closed here.
    """
    if not EXEC_SSH_KEY_SECRET:
        return (None, "this deployment has no SSH key configured -- EXEC_SSH_KEY_SECRET "
                      "names no Secret Manager secret, so ssh jobs cannot run here. Create a "
                      "secret holding the private key, grant this service secretAccessor on "
                      "THAT SECRET ONLY, and set EXEC_SSH_KEY_SECRET to its name")
    try:
        p = subprocess.run(["gcloud", "secrets", "versions", "access", "latest",
                            "--secret=" + EXEC_SSH_KEY_SECRET],
                           env=env, capture_output=True, text=True, timeout=60)
    except Exception as e:
        return (None, "the SSH key secret %r could not be read (%s)"
                      % (EXEC_SSH_KEY_SECRET, str(e)[:160]))
    if p.returncode != 0:
        # The exit code only. gcloud's stderr on this command can echo back the resource
        # path, and job stdout is permanent in Firestore.
        return (None, "the SSH key secret %r could not be read (gcloud exit %d); check that "
                      "the secret exists and that this service holds secretAccessor on it"
                      % (EXEC_SSH_KEY_SECRET, p.returncode))
    if not (p.stdout or "").strip():
        return (None, "the SSH key secret %r resolved to an EMPTY payload; refusing rather "
                      "than writing a zero-byte identity file" % EXEC_SSH_KEY_SECRET)
    return (p.stdout, None)


@app.get("/healthz")
def healthz():
    return "ok", 200

@app.post("/run")
def run():
    body = request.get_json(force=True, silent=True) or {}
    job_id = body.get("job_id")
    if not job_id:
        return jsonify({"error": "job_id is required"}), 400

    job_ref = db.collection("pending_confirms").document(job_id)
    job_doc = job_ref.get()
    if not job_doc.exists:
        return jsonify({"error": f"Job {job_id} not found"}), 404

    job = job_doc.to_dict()
    # Control-plane sets status to "executing" right before calling us.
    if job.get("status") not in ["confirmed", "executing"]:
        return jsonify({"error": f"Job {job_id} is not confirmed/executing. Status is {job.get('status')}"}), 403

    # [SEC-RUN-ASSERTION-V1] INDEPENDENT APPROVAL CHECK -- the point of the whole minter design.
    # EVERYTHING ABOVE THIS LINE TRUSTS FIRESTORE, and the control plane can write Firestore
    # (datastore.user is project-wide; Firestore IAM has no per-collection granularity). So a
    # compromised control plane approves anything by setting status=confirmed and calling us.
    # With PC_REQUIRE_ASSERTION=1 the caller must ALSO present the operator's WebAuthn assertion,
    # verified HERE against credentials the control plane cannot write. It cannot forge one --
    # forging requires the operator's device, not database access.
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
    target = args.get("targetNode", "")

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
    # FALLBACK, DELIBERATE AND LOAD-BEARING: a document with no approved_sha256 is ALLOWED.
    # Enforcement without it 403s every gated job forever including its own undo, which is
    # why ed-S39-sha-pin.py is permanently banned. Absences are journalled; when that count
    # reaches zero on its own, and only then, a hard pin becomes discussable.
    _asha = job.get("approved_sha256")
    if _asha is None or _asha == "":
        log_journal("exec_approval_sha_absent",
                    "job %s carries no approved_sha256 (approved before the writer shipped, or a "
                    "job shape with no command). Allowed by the documented fallback." % job_id,
                    job_id)
    else:
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
    # TOP LEVEL, not nested inside the approved_sha256 else-branch. That nesting was
    # a real bug once: a document with no approved_sha256 took the "absent -> allowed"
    # path above and never reached the signature check, so ONE deleted field turned
    # off BOTH controls. The adversary this design names is the one who can write the
    # document, and writing includes deleting.
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
    # DO NOT "fix" this by deleting the variable: absent then reads as require and
    # you get the lockout you were trying to avoid. Flip it to "1" only after the
    # absent-signature journal line below has stopped appearing and stayed gone.
    # NOTE WHAT THIS DOES *NOT* RELAX: "bad" and "unverifiable" below refuse
    # UNCONDITIONALLY and are not gated on this flag. A missing, empty or unfetchable
    # key NEVER permits execution.
    _require_signed = os.environ.get("APPROVAL_REQUIRE_SIGNED", "0") == "1"
    _sig_outcome, _sig_detail = pc_verify_approval_signature(job, job_id, _cmd_sha)

    if _sig_outcome == "bad":
        # Checked, and failed. Never conditional on the mode: a signature that is
        # present and wrong is an attack, not a migration artefact.
        log_journal("exec_refused_approval_sig",
                    "REFUSED job %s: %s. The command and its digest agree with each other, "
                    "which means BOTH were rewritten together -- exactly what the signature "
                    "exists to catch. NOTHING RAN." % (job_id, _sig_detail),
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
        # approval_sig to reach this rung, which is exactly why the default is
        # require and why a fresh install never opens this door.
        log_journal("exec_approval_sig_absent",
                    "job %s carries no approval_sig (%s). Allowed ONLY because "
                    "APPROVAL_REQUIRE_SIGNED=0 on this service. This is not a pass. Set it "
                    "to 1 once this line stops appearing." % (job_id, _sig_detail),
                    job_id)
    else:
        log_journal("exec_approval_sig_ok",
                    "job %s: approval signature verified (%s)." % (job_id, _sig_detail),
                    job_id)

    if not command:
        return jsonify({"error": "No command found in the approved job arguments"}), 400

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
            if os.environ.get("EXEC_BINARY_ALLOWLIST_ENFORCE", "0") == "1":
                return jsonify({"error": f"Binary not allowlisted: {first_token}"}), 400
            log_journal("exec_allowlist_observe", "job %s: first token %r not allowlisted (observe-only, executing anyway)" % (job_id, first_token), job_id)

    access_token = body.get("access_token")

    env = dict(os.environ)
    env["CLOUDSDK_CORE_DISABLE_PROMPTS"] = "1"
    if access_token:
        # Bind gcloud/gsutil/bq to the approver's identity
        env["CLOUDSDK_AUTH_ACCESS_TOKEN"] = access_token

    # [SEC-SSHKEY-PREFLIGHT-V1] ABOVE THE CLAIM, DELIBERATELY. env is built here rather than
    # after the claim for exactly this: the secret read runs as the approver, and a job that
    # cannot get its key must refuse while the approval is still unspent.
    ssh_key = None
    if command_type == "ssh":
        ssh_key, _ssh_why = ssh_key_preflight(env)
        if ssh_key is None:
            log_journal("exec_refused_ssh_key_unavailable",
                        "REFUSED job %s: %s. NOTHING RAN and the approval was NOT consumed, "
                        "so it can be presented again once the key is configured."
                        % (job_id, _ssh_why),
                        job_id)
            return jsonify({"error": "refused: ssh jobs are not usable on this deployment",
                            "detail": _ssh_why}), 412

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
        claim_id, claim_err = claim_job_for_execution(job_ref, job_id)
    except Exception as e:
        log_journal("exec_refused_claim_error",
                    "REFUSED job %s: the approval could not be consumed atomically (%s). "
                    "Fail closed -- NOTHING RAN." % (job_id, e),
                    job_id)
        return jsonify({"error": "refused: the approval could not be consumed atomically; nothing ran"}), 503
    if not claim_id:
        log_journal("exec_refused_replay",
                    "REFUSED job %s (status %s): %s. NOTHING RAN." % (job_id, job.get("status", ""), claim_err),
                    job_id)
        return jsonify({"error": "refused: this approval has already been spent (one approval = one run)",
                        "detail": claim_err}), 409
    log_journal("exec_claim",
                "Consumed approval for job %s (claim %s, from status %s). This approval is now spent."
                % (job_id, claim_id[:12], job.get("status", "")),
                job_id)

    log_journal("exec_start", f"Starting execution of job {job_id} ({command_type}) with approver-scoped creds", job_id)

    exit_code = -1
    stdout, stderr = "", ""
    try:
        if command_type == "ssh":
            # [SEC-SSHKEY-PREFLIGHT-V1] ssh_key was resolved, validated non-empty and
            # refused-on-failure ABOVE the claim. Nothing is fetched here, so there is no
            # longer any way for this branch to fail on a missing key after the approval
            # has been spent.
            with tempfile.NamedTemporaryFile("w", delete=True) as key_file:
                key_file.write(ssh_key)
                key_file.flush()
                os.chmod(key_file.name, 0o600)
                
                # run ssh command
                ssh_cmd = ["ssh", "-o", "StrictHostKeyChecking=no", "-i", key_file.name, target, command]
                r = subprocess.run(ssh_cmd, env=env, capture_output=True, text=True, timeout=MAX_SECONDS)
                exit_code = r.returncode
                stdout = (r.stdout or "")[-8000:]
                stderr = (r.stderr or "")[-8000:]
        else:
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

    # write result back. Note that live/index.js also updates status to "executed".
    result_data = {
        "status": "executed",
        "exit_code": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "executed_at": firestore.SERVER_TIMESTAMP
    }
    job_ref.update(result_data)
    
    log_journal("exec_complete", f"Completed job {job_id} with exit code {exit_code}", job_id)

    return jsonify({"job_id": job_id, "exit_code": exit_code, "stdout": stdout, "stderr": stderr}), 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
