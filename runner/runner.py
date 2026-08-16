#!/usr/bin/env python3
# Hardened deploy-runner.
# Safety model: approved-artifact + sha256 pin (NOT a binary allowlist).
# Runs ONLY the exact script whose sha256 the human approved. Any mismatch = hard
# abort, no-op. Confirmed-only trigger. Self-asserts its own image digest. Ephemeral.
import os, sys, hashlib, base64, gzip, subprocess
from google.cloud import firestore, storage
from datetime import datetime, timedelta, timezone

PROJECT = os.environ["PROJECT"]
BUCKET  = os.environ["BUCKET"]
REGION  = os.environ["REGION"]
JOB     = os.environ.get("JOB_NAME", "deploy-runner")
EXPECT  = os.environ.get("EXPECTED_IMAGE_DIGEST", "")   # e.g. sha256:abc...
TIMEOUT = int(os.environ.get("SCRIPT_TIMEOUT", "1800"))

# [SEC-TTL-STAMP-V1] Firestore TTL is FAIL-OPEN: a document missing the expireAt field is
# NEVER deleted, and the console does not say which documents are covered. The control plane
# stamps its own writes at one chokepoint (control-plane/src/index.ts, [SEC-TTL-CHOKEPOINT-V1]);
# this process writes Firestore with its OWN client, out of that chokepoint's reach, so it
# stamps here. Retention is the operator's parameter: journal 120 days (the pending_confirms .update() below touches a document
# the control plane created and stamped at creation, so only the journal add needs a stamp).
# Rows written here reach the forever-archive only via the seed/re-seed step in
# deploy/TTL-BIGQUERY-INFRA.md (this process has no archive path of its own).
def _ttl_expire_at(days):
    return datetime.now(timezone.utc) + timedelta(days=days)

def log(*a): print("[runner]", *a, flush=True)

def selfcheck():
    # Primary integrity guarantee is the digest-pinned Job spec (Cloud Run runs ONLY
    # that digest). This is the belt-and-suspenders tripwire: confirm the Job we are
    # running under is still pinned to the digest we were built expecting.
    if not EXPECT:
        log("FATAL: EXPECTED_IMAGE_DIGEST unset"); sys.exit(2)
    r = subprocess.run(
        ["gcloud","run","jobs","describe",JOB,"--region",REGION,"--project",PROJECT,
         "--format=value(spec.template.template.containers[0].image)"],
        capture_output=True, text=True)
    img = (r.stdout or "").strip()
    if EXPECT not in img:
        log(f"FATAL: image-digest mismatch. job image={img!r} expected~={EXPECT!r}")
        sys.exit(3)
    log("image-digest OK:", img)

def finish(db, ref, status, code, out, err):
    ref.update({
        "runner_status": status, "exit_code": code,
        "stdout_tail": (out or "")[-6000:], "stderr_tail": (err or "")[-6000:],
        "ran_at": firestore.SERVER_TIMESTAMP,
    })
    db.collection("journal").add({
        "agent_id": "deploy-runner", "action": f"runner_{status}",
        "message": f"deploy job {ref.id} {status} (exit {code}).",
        "timestamp": firestore.SERVER_TIMESTAMP,
        "expireAt": _ttl_expire_at(120)})
    log("finished:", status, "exit", code)

def main():
    selfcheck()
    db = firestore.Client(project=PROJECT)
    # Confirmed-only: status==confirmed AND command_type==deploy AND not yet run.
    pick = None
    for d in (db.collection("pending_confirms")
                .where("status","==","confirmed")
                .where("command_type","==","deploy").limit(20).stream()):
        x = d.to_dict()
        if x.get("runner_status"): continue
        args = x.get("arguments") or {}
        if not args.get("command") or not args.get("targetNode"): continue
        pick = (d.reference, args["command"], args["targetNode"]); break
    if not pick:
        log("no confirmed deploy pending; no-op."); return
    ref, script_path, approved_sha = pick
    log("processing", ref.id, "script:", script_path)

    # Pull the approved artifact (gzip+base64 blob = byte-stable), decode, sha-pin.
    raw = storage.Client(project=PROJECT).bucket(BUCKET).blob(script_path).download_as_text()
    try:
        script = gzip.decompress(base64.b64decode("".join(raw.split())))
    except Exception as e:
        finish(db, ref, "failed", 126, "", f"artifact decode error: {e}"); return
    got = hashlib.sha256(script).hexdigest()
    if got != approved_sha:
        finish(db, ref, "failed", 125, "", f"SHA MISMATCH got={got} approved={approved_sha} -- refusing to run.")
        return
    log("sha256 pin OK:", got)

    with open("/tmp/deploy.sh","wb") as f: f.write(script)
    try:
        r = subprocess.run(["bash","/tmp/deploy.sh"], capture_output=True, text=True, timeout=TIMEOUT)
        finish(db, ref, "succeeded" if r.returncode == 0 else "failed", r.returncode, r.stdout, r.stderr)
    except subprocess.TimeoutExpired as e:
        finish(db, ref, "failed", 124, (e.stdout or ""), f"TIMEOUT after {TIMEOUT}s")

if __name__ == "__main__":
    main()
