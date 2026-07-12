import hmac
import os, sqlite3, json, datetime
from mcp.server.fastmcp import FastMCP

BASE="/opt/paracoding-mcp"
DB=f"{BASE}/fleet.db"
PICKUP=f"{BASE}/pickup"
ALLOW_WRITE=["/var/www/example.com/html", f"{BASE}/work"]
ALLOW_READ=ALLOW_WRITE+[PICKUP]
PRIVATE=[]  # per-agent box-isolation disabled 2026-07-09: shared connector cannot pass identity reliably, it locked out the owner (ghost). Memoir stays protected in its PRIVATE GitHub repo. Re-enable only with a dedicated per-agent connector.
def _private_denied(path, agent_id):
    r=os.path.realpath(path)
    for pre,owner in PRIVATE:
        if r==pre or r.startswith(pre.rstrip("/")+"/"):
            return agent_id!=owner
    return False

mcp=FastMCP("YOUR_GCP_PROJECT", host="127.0.0.1", port=8200)

def db():
    c=sqlite3.connect(DB, timeout=10); c.row_factory=sqlite3.Row; return c
def now(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
with db() as c:
    c.executescript("""
    CREATE TABLE IF NOT EXISTS work_items(id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, title TEXT, payload TEXT, status TEXT DEFAULT 'open', claimed_by TEXT, created_ts TEXT, done_ts TEXT, result TEXT);
    CREATE TABLE IF NOT EXISTS journal(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, ts TEXT, entry TEXT);
    CREATE TABLE IF NOT EXISTS agent_state(agent_id TEXT PRIMARY KEY, status TEXT, current_task TEXT, updated_ts TEXT);
    """)

def _scoped(path, roots):
    r=os.path.realpath(path)
    return any(r==b or r.startswith(b.rstrip('/')+'/') for b in roots)

@mcp.tool()
def enqueue_work_item(role:str, title:str, payload:str="")->dict:
    "Add a work item for a role."
    with db() as c:
        cur=c.execute("INSERT INTO work_items(role,title,payload,created_ts) VALUES(?,?,?,?)",(role,title,payload,now()))
        return {"id":cur.lastrowid,"status":"open"}

@mcp.tool()
def claim_next_work_item(agent_id:str, role:str)->dict:
    "Atomically claim the oldest open work item for a role."
    agent_id=_trusted_agent(agent_id)  # #159 F3: nginx identity wins; arg is fallback off-proxy
    with db() as c:
        c.isolation_level=None; c.execute("BEGIN IMMEDIATE")
        row=c.execute("SELECT * FROM work_items WHERE status='open' AND role=? ORDER BY id LIMIT 1",(role,)).fetchone()
        if not row: c.execute("COMMIT"); return {"claimed":None}
        c.execute("UPDATE work_items SET status='claimed',claimed_by=? WHERE id=?",(agent_id,row["id"]))
        c.execute("COMMIT"); return {"claimed":dict(row)}

@mcp.tool()
def complete_work_item(item_id:int, result:str)->dict:
    "Mark a work item done with a result."
    with db() as c: c.execute("UPDATE work_items SET status='done',done_ts=?,result=? WHERE id=?",(now(),result,item_id))
    return {"id":item_id,"status":"done"}

@mcp.tool()
def list_work_items(role:str="", status:str="")->list:
    "List work items, optionally filtered by role/status."
    q="SELECT id,role,title,status,claimed_by FROM work_items WHERE 1=1"; a=[]
    if role: q+=" AND role=?"; a.append(role)
    if status: q+=" AND status=?"; a.append(status)
    with db() as c: return [dict(r) for r in c.execute(q+" ORDER BY id DESC LIMIT 100",a)]

@mcp.tool()
def append_journal(agent_id:str, entry:str)->dict:
    "Append a journal entry for an agent (durable memory across sessions)."
    agent_id=_trusted_agent(agent_id)  # #159 F3: nginx identity wins; arg is fallback off-proxy
    with db() as c: c.execute("INSERT INTO journal(agent_id,ts,entry) VALUES(?,?,?)",(agent_id,now(),entry))
    return {"ok":True}

@mcp.tool()
def read_journal(agent_id:str, limit:int=20)->list:
    "Read the most recent journal entries for an agent."
    with db() as c: return [dict(r) for r in c.execute("SELECT ts,entry FROM journal WHERE agent_id=? ORDER BY id DESC LIMIT ?",(agent_id,limit))]

@mcp.tool()
def set_agent_state(agent_id:str, status:str, current_task:str="")->dict:
    "Set/update an agent's live state."
    agent_id=_trusted_agent(agent_id)  # #159 F3: nginx identity wins; arg is fallback off-proxy
    with db() as c: c.execute("INSERT INTO agent_state(agent_id,status,current_task,updated_ts) VALUES(?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET status=excluded.status,current_task=excluded.current_task,updated_ts=excluded.updated_ts",(agent_id,status,current_task,now()))
    return {"ok":True}

@mcp.tool()
def get_handoff_brief(agent:str)->str:
    "Return the handoff brief for an agent (its full ttyd-era context)."
    p=os.path.join(PICKUP, f"{agent}-handoff.md")
    return open(p,encoding="utf-8",errors="replace").read() if os.path.exists(p) else f"(no handoff brief for {agent})"

@mcp.tool()
def list_dir(path:str, agent_id:str="")->list:
    "List a directory (read allowlist). Pass agent_id; private workspaces are owner-only."
    if _private_denied(path,agent_id): return ["denied: private workspace (owner only)"]
    if not _scoped(path,ALLOW_READ): return ["denied: outside read allowlist"]
    try: return sorted(os.listdir(path))
    except Exception as e: return [f"error: {e}"]

@mcp.tool()
def read_file(path:str, agent_id:str="")->str:
    "Read a file (read allowlist). Pass agent_id; private workspaces are owner-only."
    if _private_denied(path,agent_id): return "denied: private workspace (owner only)"
    if not _scoped(path,ALLOW_READ): return "denied: outside read allowlist"
    try: return open(path,encoding="utf-8",errors="replace").read()
    except Exception as e: return f"error: {e}"

@mcp.tool()
def write_file(path:str, content:str, agent_id:str="")->dict:
    "Write a file (write allowlist ONLY). Pass agent_id; private workspaces are owner-only."
    agent_id=_trusted_agent(agent_id)  # #159 F3: nginx identity wins; arg is fallback off-proxy
    if _private_denied(path,agent_id): return {"error":"denied: private workspace (owner only)"}
    if not _scoped(path,ALLOW_WRITE): return {"error":"denied: path not in writable allowlist"}
    try:
        os.makedirs(os.path.dirname(path),exist_ok=True)
        open(path,"w",encoding="utf-8").write(content)
        return {"ok":True,"bytes":len(content),"path":path}
    except Exception as e: return {"error":str(e)}


# ---- #147 mobile control path / #144 F1 human-confirm gate ----
# Privileged actions are STAGED (pending-confirm) and run only after a human approves with an
# out-of-band token no agent holds. Closes the F3 self-asserted-identity self-approval hole.
HUMAN_TOKEN_FILE=f"{BASE}/human_confirm.secret"
def _human_ok(token):
    try: sec=open(HUMAN_TOKEN_FILE).read().strip()
    except Exception: return False
    return bool(sec) and hmac.compare_digest(str(token or ""), sec)

HUMAN_CALLER_IDS={"", "human", "operator"}  # #159: confirm/deny require a NON-agent caller
def _is_human_caller():
    "True only when NOT on an agent connector; every agent nginx path injects its X-Agent-Id. #147 human path injects none."
    return _trusted_agent("") in HUMAN_CALLER_IDS

@mcp.tool()
def stage_privileged_job(title:str, job_type:str, params:str="{}", requested_by:str="")->dict:
    "Stage a PRIVILEGED job for human approval. Does NOT run until confirmed with operator's token. Returns the item id to approve from mobile."
    try: p=json.loads(params or "{}")
    except Exception: return {"error":"params must be JSON"}
    payload=json.dumps({"privileged_job":{"job_type":job_type,"params":p},"confirm_state":"pending-confirm","requested_by":requested_by})
    with db() as c:
        cur=c.execute("INSERT INTO work_items(role,title,payload,status,claimed_by,created_ts) VALUES('infra',?,?,'open',?,?)",(title,payload,requested_by,now()))
        iid=cur.lastrowid
        c.execute("INSERT INTO journal(agent_id,ts,entry) VALUES(?,?,?)",(requested_by or "agent",now(),"STAGED privileged job #%d (%s) -> pending-confirm"%(iid,job_type)))
    return {"id":iid,"confirm_state":"pending-confirm","note":"awaiting human confirm"}

@mcp.tool()
def list_pending_confirm()->list:
    "List privileged jobs awaiting human confirmation (for the mobile approver)."
    out=[]
    with db() as c:
        for r in c.execute("SELECT id,title,payload,created_ts FROM work_items WHERE status='open' ORDER BY id DESC LIMIT 200"):
            try: p=json.loads(r["payload"] or "{}")
            except Exception: p={}
            if p.get("confirm_state")=="pending-confirm":
                pj=p.get("privileged_job",{})
                out.append({"id":r["id"],"title":r["title"],"job_type":pj.get("job_type"),"params":pj.get("params"),"staged":r["created_ts"]})
    return out

@mcp.tool()
def confirm_work_item(item_id:int, human_token:str)->dict:
    "HUMAN-ONLY: approve a staged privileged job. Requires operator's confirm token; no agent can self-approve."
    if not _is_human_caller(): return {"error":"denied: confirm is human-only; agent connectors cannot approve (#159)"}
    if not _human_ok(human_token): return {"error":"denied: invalid human-confirm token"}
    with db() as c:
        row=c.execute("SELECT payload FROM work_items WHERE id=?",(item_id,)).fetchone()
        if not row: return {"error":"no such item"}
        try: p=json.loads(row["payload"] or "{}")
        except Exception: p={}
        if p.get("confirm_state")!="pending-confirm": return {"error":"item not pending-confirm (state=%s)"%p.get("confirm_state")}
        p["confirm_state"]="confirmed"; p["confirmed_ts"]=now()
        c.execute("UPDATE work_items SET payload=? WHERE id=?",(json.dumps(p),item_id))
        c.execute("INSERT INTO journal(agent_id,ts,entry) VALUES('human',?,?)",(now(),"CONFIRMED privileged item #%d (human token)"%item_id))
    return {"id":item_id,"confirm_state":"confirmed"}

@mcp.tool()
def deny_work_item(item_id:int, human_token:str)->dict:
    "HUMAN-ONLY: deny/cancel a staged privileged job. Requires operator's confirm token."
    if not _is_human_caller(): return {"error":"denied: deny is human-only; agent connectors cannot approve (#159)"}
    if not _human_ok(human_token): return {"error":"denied: invalid human-confirm token"}
    with db() as c:
        row=c.execute("SELECT payload FROM work_items WHERE id=?",(item_id,)).fetchone()
        if not row: return {"error":"no such item"}
        try: p=json.loads(row["payload"] or "{}")
        except Exception: p={}
        p["confirm_state"]="denied"; p["denied_ts"]=now()
        c.execute("UPDATE work_items SET payload=?,status='done',done_ts=?,result='denied by human' WHERE id=?",(json.dumps(p),now(),item_id))
        c.execute("INSERT INTO journal(agent_id,ts,entry) VALUES('human',?,?)",(now(),"DENIED privileged item #%d (human token)"%item_id))
    return {"id":item_id,"confirm_state":"denied"}


# ---- #F3 per-agent identity: trust the nginx-injected X-Agent-Id (unforgeable by the client) ----
def _trusted_agent(fallback=""):
    "Identity bound to the connector's secret-path by nginx (proxy_set_header X-Agent-Id). Client cannot spoof it. Falls back to the arg when not behind the injecting proxy."
    try:
        ctx=mcp.get_context()
        req=getattr(ctx.request_context, "request", None)
        if req is not None:
            v=req.headers.get("x-agent-id")
            if v: return v
    except Exception:
        pass
    return fallback

@mcp.tool()
def whoami(claimed_agent_id:str="")->dict:
    "Return the TRUSTED identity nginx bound to your connector path (F3). If it differs from what you claim, the trusted one wins — proves an agent can't impersonate another."
    t=_trusted_agent("")
    return {"trusted_agent_id": t or "(none: not behind the identity-injecting proxy)", "you_claimed": claimed_agent_id, "impersonation_blocked": bool(t and claimed_agent_id and t!=claimed_agent_id)}

if __name__=="__main__":
    mcp.run(transport="streamable-http")
