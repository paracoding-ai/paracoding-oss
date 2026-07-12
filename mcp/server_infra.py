import json, os, sqlite3, datetime, glob
from mcp.server.fastmcp import FastMCP
DB="/opt/paracoding-mcp/fleet.db"
JOBS_DIR="/opt/paracoding-mcp/jobrunner/jobs"
CAP_FILE="/opt/paracoding-mcp/infra_cap.secret"
try:
    CAP=open(CAP_FILE).read().strip()
except Exception:
    CAP=""
mcp=FastMCP("paracoding-infra-priv", host="127.0.0.1", port=8201)
def now(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def db():
    c=sqlite3.connect(DB,timeout=30); c.execute("PRAGMA busy_timeout=30000"); return c
def _auth(cap):
    return bool(CAP) and cap==CAP

@mcp.tool()
def list_job_types(cap: str = "") -> str:
    """List privileged job types. Requires the paracoding-infra capability token (cap)."""
    if not _auth(cap): return json.dumps({"error":"unauthorized: valid capability token (cap) required"})
    return json.dumps(sorted(os.path.basename(p)[:-3] for p in glob.glob(JOBS_DIR+"/*.sh")))

@mcp.tool()
def enqueue_infra_job(job_type: str, params_json: str = "{}", cap: str = "") -> str:
    """Enqueue a privileged infra job for the root job-runner. Requires the paracoding-infra
    capability token (cap). job_type must be one of list_job_types(); params_json is a JSON object."""
    if not _auth(cap): return json.dumps({"error":"unauthorized: valid capability token (cap) required"})
    if not os.path.isfile(os.path.join(JOBS_DIR, job_type+".sh")):
        return json.dumps({"error": f"unknown job_type {job_type!r}; see list_job_types()"})
    try:
        p=json.loads(params_json or "{}"); assert isinstance(p, dict)
    except Exception as e:
        return json.dumps({"error": f"params_json must be a JSON object: {e}"})
    c=db()
    c.execute("INSERT INTO infra_jobs(job_type,params,requested_by,requested_ts,status) VALUES(?,?,?,?,'queued')",
              (job_type, json.dumps(p), "paracoding-infra", now())); c.commit()
    jid=c.execute("select last_insert_rowid()").fetchone()[0]; c.close()
    return json.dumps({"job_id": jid, "status": "queued"})

@mcp.tool()
def get_job_result(job_id: int, cap: str = "") -> str:
    """Get status/exit_code/output for an infra job. Requires the paracoding-infra capability token (cap)."""
    if not _auth(cap): return json.dumps({"error":"unauthorized: valid capability token (cap) required"})
    c=db()
    r=c.execute("select id,job_type,status,exit_code,output,requested_ts,done_ts from infra_jobs where id=?",(job_id,)).fetchone()
    c.close()
    if not r: return json.dumps({"error":"no such job"})
    return json.dumps(dict(zip(["job_id","job_type","status","exit_code","output","requested_ts","done_ts"], r)))

if __name__=="__main__":
    mcp.run(transport="streamable-http")
