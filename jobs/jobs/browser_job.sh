#!/usr/bin/env bash
# browser_job ??? dispatch a public-web browser task to the isolated Gemini computer-use worker.
# Params: {goal, start_url, allowed_domains:[...], max_steps(<=40), success_criteria}
# Keyless (ADC token minted per job); worker runs as non-root 'cuworker' isolated in /opt/hands;
# HARD RULES: allowed_domains is deny-by-default (required); worker refuses login/credential/
# financial/comms actions; ~10min wall-clock. Output -> /opt/paracoding-mcp/work/hands/<id>/ (mcpsvc);
# REQUESTING AGENT MUST VERIFY results before acting (verify-don't-claim).
set -uo pipefail
J(){ printf '%s' "$JOB_PARAMS" | python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))"; }
GOAL=$(J goal); START=$(J start_url); MAXS=$(J max_steps); SUCC=$(J success_criteria)
ALLOWED=$(printf '%s' "$JOB_PARAMS" | python3 -c "import json,sys;print(','.join(json.load(sys.stdin).get('allowed_domains',[])))")
[ -n "$GOAL" ] || { echo "goal required"; exit 2; }
[ -n "$ALLOWED" ] || { echo "allowed_domains required (deny-by-default)"; exit 2; }
case "$MAXS" in ''|*[!0-9]*) MAXS=25;; esac; [ "$MAXS" -gt 40 ] && MAXS=40
JID="$(date +%Y%m%d-%H%M%S)-$$"
OUT="/opt/hands/out/$JID"; mkdir -p "$OUT"; chown cuworker:cuworker "$OUT"
TOKEN=$(sudo -u paracoding-infra env HOME=/home/paracoding-infra CLOUDSDK_CONFIG=/home/paracoding-infra/.config/gcloud PATH=/snap/bin:/usr/bin:/bin gcloud auth application-default print-access-token 2>/dev/null)
[ -n "$TOKEN" ] || { echo "no ADC token ??? paracoding-infra application-default creds missing/expired"; exit 3; }
GOALX="$GOAL"; [ -n "$SUCC" ] && GOALX="$GOAL"$'\n'"Success criteria: $SUCC"
timeout 600 sudo -u cuworker env PLAYWRIGHT_BROWSERS_PATH=/opt/hands/browsers HOME=/opt/hands/home \
  CU_TOKEN="$TOKEN" GOAL="$GOALX" START_URL="${START:-about:blank}" ALLOWED_DOMAINS="$ALLOWED" MAX_STEPS="$MAXS" OUT_DIR="$OUT" \
  /opt/hands/venv/bin/python /opt/hands/cu_worker.py
RC=$?
DEST="/opt/paracoding-mcp/work/hands/$JID"; mkdir -p "$DEST"; cp -a "$OUT"/. "$DEST"/ 2>/dev/null || true
chown -R mcpsvc:mcpsvc /opt/paracoding-mcp/work/hands
echo "browser_job=$JID rc=$RC output=work/hands/$JID (AGENT MUST VERIFY)"
sed -n '1,12p' "$DEST/result.md" 2>/dev/null || true
