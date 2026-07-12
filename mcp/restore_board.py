#!/usr/bin/env python3
"""Rebuild /opt/paracoding-mcp/fleet.db from paracoding-board.git JSON snapshots + schema.
Env: BOARD_DIR (dir with agent_state/journal/work_items/infra_jobs .json), default /tmp/board."""
import sqlite3, json, os
DB="/opt/paracoding-mcp/fleet.db"; BOARD=os.environ.get("BOARD_DIR","/tmp/board")
SCHEMA="/opt/paracoding-mcp/paracoding-db-schema.sql"
if os.path.exists(DB): os.remove(DB)
c=sqlite3.connect(DB)
c.executescript(open(SCHEMA).read())
for tbl,fn in [("agent_state","agent_state.json"),("journal","journal.json"),("work_items","work_items.json"),("infra_jobs","infra_jobs.json")]:
    p=os.path.join(BOARD,fn)
    if not os.path.exists(p): print("skip",tbl); continue
    rows=json.load(open(p))
    if not isinstance(rows,list) or not rows: print("empty",tbl); continue
    cols=[r[1] for r in c.execute("PRAGMA table_info(%s)"%tbl)]
    n=0
    for row in rows:
        keys=[k for k in row if k in cols]
        if not keys: continue
        c.execute("INSERT OR IGNORE INTO %s (%s) VALUES (%s)"%(tbl,",".join(keys),",".join("?"*len(keys))),[row[k] for k in keys]); n+=1
    print("restored %s: %d"%(tbl,n))
c.commit()
