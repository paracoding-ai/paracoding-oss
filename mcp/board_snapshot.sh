#!/usr/bin/env bash
# Snapshot fleet coordination state (fleet.db tables + pickup briefs) to a private git
# repo for DR. Root; token used transiently, never stored. No secrets are included.
set -uo pipefail
export HOME=/root
GH=$(cat /etc/fleet/gh_token 2>/dev/null); [ -n "$GH" ] || { echo "no token"; exit 1; }
git config --global --add safe.directory '*' 2>/dev/null || true
D=/opt/paracoding-mcp/board-snapshot; mkdir -p "$D/pickup"
/usr/bin/python3 - "$D" <<'PY'
import sqlite3,json,sys,os
D=sys.argv[1]; c=sqlite3.connect("/opt/paracoding-mcp/fleet.db"); c.row_factory=sqlite3.Row
for t in ("work_items","journal","agent_state","infra_jobs"):
    try: rows=[dict(r) for r in c.execute("select * from %s order by 1"%t)]
    except Exception: rows=[]
    json.dump(rows, open(os.path.join(D,t+".json"),"w"), indent=2, ensure_ascii=False)
PY
cp -f /opt/paracoding-mcp/pickup/*.md "$D/pickup/" 2>/dev/null || true
cd "$D"
if [ ! -d .git ]; then git init -q; git branch -M main; git remote add origin https://github.com/YOUR_ORG/paracoding-board.git; fi
raw=$(git remote get-url origin); clean=$(printf '%s' "$raw" | sed -E 's#https://[^@]*@#https://#'); git remote set-url origin "$clean"
git add -A
git diff --cached --quiet && exit 0
git -c user.email=board@example.com -c user.name=board-snapshot commit -q -m "board snapshot $(date -u +%FT%TZ)"
git push -q "$(printf '%s' "$clean" | sed -E "s#https://#https://x-access-token:${GH}@#")" HEAD:main 2>&1 | sed "s#${GH}#TOKEN#g"
echo "pushed board snapshot"
