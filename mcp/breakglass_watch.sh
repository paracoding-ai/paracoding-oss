#!/usr/bin/env bash
# Hourly breakglass DETECTOR (box-resident). Surfaces board items that need interactive
# breakglass (SSH/root) into pending.txt + journals newly-appeared ones. NO auto-execution:
# the auto_job auto-root path was REMOVED (#161/#B2) - privileged work now goes through the
# human-confirm gate: stage_privileged_job -> confirm_work_item (human-only) -> confirm-runner.
set -uo pipefail
/usr/bin/python3 <<'PY'
import sqlite3, json, datetime
DB="/opt/paracoding-mcp/fleet.db"
PEND="/opt/paracoding-mcp/breakglass-pending.txt"; STATE="/opt/paracoding-mcp/.breakglass-seen"; LOG="/opt/paracoding-mcp/breakglass-watch.log"
now=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
c=sqlite3.connect(DB); c.row_factory=sqlite3.Row
rows=[dict(r) for r in c.execute("""select id,role,title from work_items where status='open' and (
   (role='infra' and upper(title) not like '%BACKLOG%') or upper(title) like '%BREAKGLASS%') order by id""")]
with open(PEND,"w") as f:
    f.write(f"# breakglass-actionable open items (needs interactive breakglass) as of {now}\n")
    f.write("(none)\n" if not rows else "")
    for r in rows: f.write(f"#{r['id']} [{r['role']}] {r['title']}\n")
try: seen=set(json.load(open(STATE)))
except Exception: seen=set()
new=[r for r in rows if r["id"] not in seen]
json.dump([r["id"] for r in rows], open(STATE,"w"))
with open(LOG,"a") as f: f.write(f"{now} pending_interactive={[r['id'] for r in rows]} new={[r['id'] for r in new]}\n")
if new:
    c.execute("INSERT INTO journal(agent_id,ts,entry) VALUES('paracoding-breakglass-auto',?,?)",
              (now, "NEW interactive breakglass items: "+"; ".join(f"#{r['id']} {r['title'][:55]}" for r in new)))
    c.commit()
print("  detect-only: pending_interactive=%d new=%d (NO auto-exec)"%(len(rows), len(new)))
PY