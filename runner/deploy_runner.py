# shared/runner/deploy_runner.py (owner: fleet-infra)
#!/usr/bin/env python3
# deploy_runner.py — THE BUILD WINDOW. While the operator has an open build window, auto-runs
# fleet-infra's staged build jobs so iteration is one-approval-per-SESSION, not one-tap-per-change.
# HARD GUARDRAILS (all must hold or it does nothing):
#   1. build_window/current must be {active:true, expiry_ms>now}  (opened explicitly, 30 min).
#   2. Only jobs staged_by == 'fleet-infra', command_type in {deploy,run_cmd,ssh}, target in allowlist.
#   3. Runs via the SAME gate-exec as-you path using ops_session.token (the operator's live token) — no
#      standing powerful SA; if that token isn't live (tab closed), it SKIPS (job stays pending for
#      manual approval).
#   4. One job per tick, marked 'running' before exec, so concurrent ticks never double-run.
# Every run is journaled (build_window_executed) exactly like a manual god-mode approval — fully audited.
import os, json, time, base64, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone
from flask import Flask
from google.cloud import firestore

PROJECT = os.environ["PROJECT"]
GATE_EXEC_URL = os.environ["GATE_EXEC_URL"].rstrip("/")
# THE UNATTENDED-EXECUTION ALLOWLIST, AND IT HAS NO DEFAULT ON PURPOSE. It used to ship
# pre-populated with one deployment's node names. That is not merely useless to an adopter: this
# service runs the named job with NO human approval, so a shipped allowlist is an unattended
# execution grant nobody in the adopting deployment ever gave, on any node whose name happens to
# collide. Unset means the empty set, and the empty set runs nothing -- fail closed.
# "" is always a member: it is "a deploy with no explicit target", not a wildcard.
ALLOW_TARGETS = set(t.strip() for t in os.environ.get("ALLOW_TARGETS", "").split(",") if t.strip())
ALLOW_TARGETS.add("")
if len(ALLOW_TARGETS) == 1:
    print("build-window: ALLOW_TARGETS is unset, so only untargeted deploys are runnable. "
          "Set ALLOW_TARGETS to a comma-separated node list to widen it.", flush=True)
ALLOW_TYPES = {"deploy", "run_cmd", "ssh"}
db = firestore.Client(project=PROJECT)
app = Flask(__name__)

# [SEC-TTL-STAMP-V1] Firestore TTL is FAIL-OPEN: a document missing the expireAt field is
# NEVER deleted, and the console does not say which documents are covered. The control plane
# stamps its own writes at one chokepoint (control-plane/src/index.ts, [SEC-TTL-CHOKEPOINT-V1]);
# this process writes Firestore with its OWN client, out of that chokepoint's reach, so it
# stamps here. Retention is the operator's parameter: journal 120 days (the pending_confirms .update() calls below touch
# documents the control plane created and stamped at creation, so only the journal add needs
# a stamp).
# Rows written here reach the forever-archive only via the seed/re-seed step in
# deploy/TTL-BIGQUERY-INFRA.md (this process has no archive path of its own).
def _ttl_expire_at(days):
    return datetime.now(timezone.utc) + timedelta(days=days)

def window_open():
    d = db.collection("build_window").document("current").get()
    if not d.exists: return False
    x = d.to_dict() or {}
    return bool(x.get("active")) and int(x.get("expiry_ms", 0)) > int(time.time() * 1000)

def ops_token():
    d = db.collection("ops_session").document("current").get()
    if not d.exists: return ""
    x = d.to_dict() or {}
    if int(x.get("token_expiry", 0)) < int(time.time() * 1000): return ""
    return x.get("token", "")

def id_token(aud):
    r = urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=" + aud,
        headers={"Metadata-Flavor": "Google"})
    return urllib.request.urlopen(r, timeout=10).read().decode().strip()

def run_job(job):
    jid = job["job_id"]; args = job.get("arguments", {}) or {}
    cmd = args.get("command") or args.get("cmd") or ""
    if not cmd:
        db.collection("pending_confirms").document(jid).update({"status": "error", "error": "no command"})
        return {"job": jid, "skipped": "no command"}
    tok = ops_token()
    if not tok:
        return {"job": jid, "skipped": "no live token (open your gate tab)"}
    body = json.dumps({"script_b64": base64.b64encode(cmd.encode()).decode(), "access_token": tok, "job_id": jid}).encode()
    idt = id_token(GATE_EXEC_URL)
    try:
        req = urllib.request.Request(GATE_EXEC_URL + "/run", data=body,
                                     headers={"Authorization": "Bearer " + idt, "Content-Type": "application/json"})
        resp = json.load(urllib.request.urlopen(req, timeout=850))
    except urllib.error.HTTPError as e:
        resp = {"exit_code": -1, "stderr": e.read(600).decode()[:600]}
    except Exception as e:
        resp = {"exit_code": -1, "stderr": str(e)[:600]}
    exit_code = resp.get("exit_code", -1)
    db.collection("pending_confirms").document(jid).update({
        "status": "executed", "ran_as": "build-window(unattended)", "exit_code": exit_code,
        "stdout_tail": str(resp.get("stdout", ""))[-4000:], "stderr_tail": str(resp.get("stderr", resp.get("raw", "")))[-4000:],
        "confirmed_by": "UNATTENDED:NO-HUMAN-APPROVAL", "human_approved": False, "approval_source": "build-window-runner", "confirmed_at": firestore.SERVER_TIMESTAMP, "ran_at": firestore.SERVER_TIMESTAMP})
    db.collection("journal").add({"agent_id": "build-runner", "action": "build_window_executed",
        "message": "Build-window auto-ran " + jid + " (exit " + str(exit_code) + "): " + cmd[:150],
        "timestamp": firestore.SERVER_TIMESTAMP,
        "expireAt": _ttl_expire_at(120)})
    return {"job": jid, "exit": exit_code}

@app.route("/", methods=["GET", "POST"])
def tick():
    if not window_open():
        return ("idle: build window closed", 200)
    # find ONE runnable fleet-infra build job; mark running before exec so ticks never overlap
    for d in db.collection("pending_confirms").where("status", "==", "pending").limit(20).stream():
        j = d.to_dict()
        if j.get("staged_by") != "fleet-infra": continue
        if j.get("command_type") not in ALLOW_TYPES: continue
        tgt = (j.get("arguments", {}) or {}).get("targetNode", "")
        if tgt not in ALLOW_TARGETS: continue
        # claim it
        d.reference.update({"status": "running", "claimed_by": "build-window-runner", "claimed_at": firestore.SERVER_TIMESTAMP})
        j["job_id"] = j.get("job_id") or d.id
        return (json.dumps(run_job(j)), 200)
    return ("idle: no runnable fleet-infra build jobs", 200)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
