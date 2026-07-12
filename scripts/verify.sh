#!/usr/bin/env bash
# Prove a paracoding base deploy came up correctly. Run on the VM after rebuild.sh --fresh.
set -uo pipefail
B=/opt/paracoding-mcp
echo "== services =="
for s in paracoding-mcp paracoding-mcp-infra paracoding-confirm-runner nginx; do
  printf "  %-28s %s\n" "$s" "$(systemctl is-active "$s" 2>/dev/null)"
done
echo "== MCP control plane live (direct to 127.0.0.1:8200) =="
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST http://127.0.0.1:8200/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}}' 2>/dev/null)
echo "  MCP initialize -> HTTP $code   (200 = control plane live)"
echo "== human-confirm gate + NO unattended path to root =="
echo "  confirm gate in server.py:      confirm_work_item=$(grep -c 'def confirm_work_item' "$B/server.py") human-only=$(grep -c _is_human_caller "$B/server.py")"
echo "  human-confirmed executor:       paracoding-confirm-runner=$(systemctl is-active paracoding-confirm-runner 2>/dev/null)"
echo "  auto-jobrunner (must be gone):  $(systemctl list-unit-files 2>/dev/null | grep -c 'paracoding-jobrunner')  (0 = no unattended agent->root path)"
echo "  your confirm token is at /opt/paracoding-mcp/human_confirm.secret (root-only): $([ -s /opt/paracoding-mcp/human_confirm.secret ] && echo present || echo MISSING)"
echo "== per-agent identity (F3) =="
echo "  X-Agent-Id injections in vhost: $(sudo grep -c 'X-Agent-Id' /etc/nginx/sites-available/mcp.example.com 2>/dev/null)"
echo "== armed guards (idle-off cost control + board backup) =="
systemctl list-timers --all --no-legend 2>/dev/null | grep -E 'paracoding|ws-' | awk '{print "  "$NF"  next="$1" "$2}' || echo "  (none)"
echo "== Shielded / Secure Boot =="
echo "  SecureBoot: $(mokutil --sb-state 2>/dev/null | head -1 || echo 'use: gcloud compute instances describe <vm> --format=value\(shieldedInstanceConfig.enableSecureBoot\)')"
echo "== board (fresh install = empty tables, schema present) =="
echo "  $(sudo sqlite3 "$B/fleet.db" 'select count(*)||" work_items / "||(select count(*) from journal)||" journal / "||(select count(*) from infra_jobs)||" infra_jobs" from work_items' 2>/dev/null)"
echo "== your MCP connector secret-path(s) (add these to your MCP client) =="
sudo grep -oE 'location /[0-9a-f]{20,}/' /etc/nginx/sites-available/mcp.example.com 2>/dev/null | sed 's/location /  https:\/\/<your-host>/;s/ $//' | head