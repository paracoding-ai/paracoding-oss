#!/usr/bin/env python3
# confirm_runner.py — HUMAN-GATED privileged executor (F1 completion, #11).
# Runs ONLY work_items a HUMAN approved via confirm_work_item. The server enforces that
# confirm/deny are human-only (#159: agent connectors are rejected before the token check),
# so NO agent can move an item to confirm_state='confirmed'. The human is therefore in the
# loop for every root execution — this is the OPPOSITE of the removed auto-jobrunner, which
# ran any agent-enqueued job unattended (F1). Typed-allowlist + trust-check retained.
import json, os, sqlite3, subprocess, time, re, datetime
DB="/opt/paracoding-mcp/fleet.db"
JOBS_DIR="/opt/paracoding-mcp/jobrunner/jobs"
POLL=5; TIMEOUT=900
NAME_RE=re.compile(r'^[a-z][a-z0-9_]{1,40}$')
def now(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def db():
    c=sqlite3.connect(DB, timeout=30); c.execute("PRAGMA busy_timeout=30000"); c.row_factory=sqlite3.Row; return c
def run_script(jtype, params):
    if not NAME_RE.match(jtype or ""): return (None, "invalid job_type %r"%jtype)
    script=os.path.join(JOBS_DIR, jtype+".sh")
    if not (os.path.isfile(script) and os.access(script, os.X_OK)): return (None, "no such job type: %s"%jtype)
    st=os.stat(script)
    if st.st_uid!=0 or (st.st_mode & 0o022):
        return (None, "trust check failed: job script must be root-owned and not group/other-writable")
    env={"PATH":"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","JOB_PARAMS":json.dumps(params)}
    try:
        p=subprocess.run(["/bin/bash", script], env=env, capture_output=True, text=True, timeout=TIMEOUT)
        return (p.returncode, (p.stdout+p.stderr)[-8000:])
    except subprocess.TimeoutExpired:
        return (None, "timeout")
def tick():
    c=db()
    try:
        c.isolation_level=None
        for r in c.execute("SELECT id,payload FROM work_items WHERE status='open'").fetchall():
            try: p=json.loads(r["payload"] or "{}")
            except Exception: continue
            if not isinstance(p, dict): continue
            if p.get("confirm_state")!="confirmed" or p.get("exec_state"): continue
            # atomic claim so a job never double-runs
            c.execute("BEGIN IMMEDIATE")
            cur=c.execute("SELECT payload FROM work_items WHERE id=?", (r["id"],)).fetchone()
            p2=json.loads(cur["payload"] or "{}")
            if p2.get("confirm_state")!="confirmed" or p2.get("exec_state"):
                c.execute("COMMIT"); continue
            p2["exec_state"]="running"; p2["exec_started_ts"]=now()
            c.execute("UPDATE work_items SET payload=? WHERE id=?", (json.dumps(p2), r["id"])); c.execute("COMMIT")
            pj=p2.get("privileged_job") or {}
            code, out = run_script(pj.get("job_type"), pj.get("params", {}) or {})
            p2["exec_state"]="ran"; p2["exit_code"]=code; p2["exec_done_ts"]=now()
            c.execute("UPDATE work_items SET payload=?, status='done', done_ts=?, result=? WHERE id=?",
                      (json.dumps(p2), now(), "CONFIRMED-RUN %s exit=%s: %s"%(pj.get("job_type"), code, (out or "")[:400]), r["id"]))
            c.execute("INSERT INTO journal(agent_id,ts,entry) VALUES('confirm-runner',?,?)",
                      (now(), "RAN human-confirmed privileged item #%d (%s) exit=%s"%(r["id"], pj.get("job_type"), code)))
            c.commit()
    finally:
        c.close()
if __name__=="__main__":
    print("confirm-runner started (human-confirmed jobs only; agents cannot confirm)", flush=True)
    while True:
        try: tick()
        except Exception as e:
            try:
                c=db(); c.execute("INSERT INTO journal(agent_id,ts,entry) VALUES('confirm-runner',?,?)",(now(),"tick error: %r"%e)); c.commit(); c.close()
            except Exception: pass
        time.sleep(POLL)