set -euo pipefail
SRC=$(printf '%s' "$JOB_PARAMS" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("src",""))')
DST=$(printf '%s' "$JOB_PARAMS" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("dst",""))')
[ -n "$SRC" ] && [ -n "$DST" ] || { echo "src and dst required"; exit 2; }
case "$SRC$DST" in *..*) echo "no .. allowed"; exit 2;; esac
echo "$SRC" | grep -qE '^(/opt/paracoding-mcp/work/|/var/www/[a-z0-9.-]+/html/)' || { echo "src not allowed: $SRC"; exit 2; }
echo "$DST" | grep -qE '^(/opt/paracoding-mcp/work/|/var/www/[a-z0-9.-]+/html/)' || { echo "dst not allowed: $DST"; exit 2; }
mkdir -p "$DST"
rsync -a --no-perms --omit-dir-times "$SRC"/ "$DST"/
chown -R mcpsvc:mcpsvc "$DST"
echo "synced $SRC -> $DST"; ls -la "$DST"
