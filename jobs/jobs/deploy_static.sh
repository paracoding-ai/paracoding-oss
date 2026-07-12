set -euo pipefail
J(){ printf '%s' "$JOB_PARAMS" | python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))"; }
SITE=$(J site); SRC=$(J src); DEST_REL=$(J dest_rel)
echo "$SITE" | grep -qE '^(example\.com|fleet\.com|example\.com)$' || { echo "site not allowed: $SITE"; exit 2; }
case "$SRC$DEST_REL" in *..*) echo "no .. in paths"; exit 2;; esac
echo "$SRC" | grep -qE '^/opt/paracoding-mcp/work/' || { echo "src must be staged under /opt/paracoding-mcp/work/: $SRC"; exit 2; }
[ -f "$SRC" ] || { echo "src file missing: $SRC"; exit 2; }
echo "$DEST_REL" | grep -qE '^[A-Za-z0-9._/-]+$' || { echo "bad dest_rel: $DEST_REL"; exit 2; }
ROOT=/var/www/$SITE/html
DEST=$ROOT/$DEST_REL
mkdir -p "$(dirname "$DEST")"
if [ -f "$DEST" ]; then cp -a "$DEST" "$DEST.bak.$(date +%s)"; echo "backed up existing $DEST"; fi
install -m 644 -o root -g root "$SRC" "$DEST"
echo "deployed $SRC -> $DEST"; ls -l "$DEST"
