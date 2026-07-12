#!/bin/bash
# Turnkey host rebuild, verified by DR drill #100 (2026-07-11).
# Usage: sudo scripts/rebuild.sh <gh_token_file> [--drill]
#   --drill = self-signed cert + placeholder secrets (isolated test). Omit for PROD (certbot + real secret injection).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ "${1:-}" = "--fresh" ]; then MODE="--fresh"; GH=""; else GH=$(cat "$1"); MODE="${2:-}"; fi   # --fresh = greenfield (no token/board)
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null; apt-get install -yq nginx python3-venv python3-pip certbot git sqlite3 jq openssl >/dev/null
groupadd -f agents
getent group mcpsvc  >/dev/null || groupadd -g 988 mcpsvc
id mcpsvc  >/dev/null 2>&1 || useradd -u 999 -g 988 -M -d /opt/paracoding-mcp -s /usr/sbin/nologin mcpsvc
getent group cuworker>/dev/null || groupadd -g 987 cuworker
id cuworker>/dev/null 2>&1 || useradd -u 997 -g 987 -M -d /opt/hands/home -s /usr/sbin/nologin cuworker
mkdir -p /opt/paracoding-mcp/jobrunner/jobs
install -m644 "$ROOT"/mcp/server.py "$ROOT"/mcp/server_infra.py "$ROOT"/mcp/paracoding-db-schema.sql "$ROOT"/mcp/restore_board.py /opt/paracoding-mcp/
install -m755 "$ROOT"/mcp/*.sh /opt/paracoding-mcp/ 2>/dev/null
install -m755 "$ROOT"/jobs/jobs/*.sh /opt/paracoding-mcp/jobrunner/jobs/ 2>/dev/null
install -m755 "$ROOT"/jobs/confirm_runner.py /opt/paracoding-mcp/jobrunner/confirm_runner.py   # #11 human-confirmed executor
python3 -m venv /opt/paracoding-mcp/venv
/opt/paracoding-mcp/venv/bin/pip install -q -r "$ROOT"/requirements.txt
if [ "$MODE" = "--fresh" ]; then
  echo "FRESH: empty board (schema init; no board.git restore)"
  /opt/paracoding-mcp/venv/bin/python -c "import sqlite3;sqlite3.connect('/opt/paracoding-mcp/fleet.db').executescript(open('$ROOT/mcp/paracoding-db-schema.sql').read())"
else
  AUTH=$(printf 'x-access-token:%s' "$GH" | base64 -w0)
  rm -rf /tmp/board; git -c http.extraheader="AUTHORIZATION: basic $AUTH" clone -q https://github.com/YOUR_ORG/paracoding-board.git /tmp/board
  BOARD_DIR=/tmp/board /opt/paracoding-mcp/venv/bin/python /opt/paracoding-mcp/restore_board.py
fi
chown -R 999:988 /opt/paracoding-mcp
mkdir -p /etc/fleet
if [ "$MODE" = "--drill" ] || [ "$MODE" = "--fresh" ]; then echo "DRILL-PLACEHOLDER" >/etc/fleet/gh_token; head -c24 /dev/urandom|base64 >/etc/fleet/infra_cap.secret; head -c24 /dev/urandom | base64 > /opt/paracoding-mcp/human_confirm.secret; chown 999:988 /opt/paracoding-mcp/human_confirm.secret; chmod 600 /opt/paracoding-mcp/human_confirm.secret; echo "FRESH: your human-confirm token (approve privileged jobs with this): $(cat /opt/paracoding-mcp/human_confirm.secret)"
else echo "PROD: inject real secrets into /etc/fleet/{gh_token,infra_cap.secret} before start"; fi
chgrp mcpsvc /etc/fleet/* 2>/dev/null||true; chmod 640 /etc/fleet/* 2>/dev/null||true
SP=$(python3 "$ROOT"/scripts/mint_mcp_vhost.py "$ROOT" /etc/nginx/sites-available/mcp.example.com | head -1)
ln -sf /etc/nginx/sites-available/mcp.example.com /etc/nginx/sites-enabled/mcp.example.com; rm -f /etc/nginx/sites-enabled/default
if [ "$MODE" = "--drill" ] || [ "$MODE" = "--fresh" ]; then mkdir -p /etc/letsencrypt/live/mcp.example.com
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=mcp.example.com" \
    -keyout /etc/letsencrypt/live/mcp.example.com/privkey.pem -out /etc/letsencrypt/live/mcp.example.com/fullchain.pem >/dev/null 2>&1
else echo "PROD: run 'certbot --nginx -d mcp.example.com ...' once DNS points here"; fi
nginx -t && systemctl reload nginx
install -m644 "$ROOT"/systemd/*.service /etc/systemd/system/  # #161: no paracoding-jobrunner (unattended agent->root executor removed; confirm-gate is the only path)
install -m644 "$ROOT"/systemd/*.timer /etc/systemd/system/ 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now paracoding-mcp paracoding-mcp-infra paracoding-confirm-runner
systemctl enable --now paracoding-breakglass-watch.timer 2>/dev/null || true   # local detector; board-snapshot/autosync timers need your own board repo+token (docs)   # #11 confirm-runner (human-confirmed jobs only)
echo "rebuild done; mcp secret path (first agent) = $SP"
