# paracoding-iac ??? fleet infrastructure-as-code + DR capture

Reproducible-from-repo definition of the agent fleet (IDEA-005). This repo is the DR source
of truth and the seed of a turnkey product. Populated by breakglass via board #96 (capture)
and #98 (GCE mirror). **No secret VALUES live here** ??? only structure, config-as-code, and
pointers; secrets stay host-side (root-only) / GCP Secret Manager.

## Layout
- `nginx/`     vhosts + TLS/certbot state (fleet/example/example + mcp secret-path auth)
- `systemd/`   units + timers (paracoding-mcp, paracoding-mcp-infra, autosync, board-snapshot, breakglass-watch) — NOTE: no auto-job runner; privileged actions go through the human-confirm gate
- `jobs/`      job-runner + all installed job types (deploy_static, sync_path, run_box_deploy, stitch_parts, workspace_patch, gcloud_enable_api, browser_job)
- `mcp/`       MCP fleet server code + state layout (agents/board/journal schema)
- `agents/`    unix users/groups (agents gid 1000) + workspace permission model
- `web/`       web roots x3 (or pointers where repo-canonical)
- `terraform/` (TODO ??? VM provisioning; use `scripts/provision-vm.sh` today)
- `docs/`      capture manifest, package list, cron, firewall + **`docs/REBUILD.md` runbook**
- `scripts/`   `rebuild.sh` (turnkey host rebuild, verified by drill #100), `provision-vm.sh`, `mint_mcp_vhost.py`
- `requirements.txt` pinned venv deps; `mcp/restore_board.py` board-state restore

## Two-VM architecture (MCP server + operator desktop)
Paracoding runs an always-on **MCP server** (e2-small, hardened) and a SEPARATE **operator desktop**
(e2-standard-4, idle-stops when unused) — cheaper and more secure than one big always-on box.
- Server: `scripts/rebuild.sh --fresh` (quickstart).
- Desktop: `scripts/provision-desktop.sh <PROJECT> <MCP_INTERNAL_IP>` — see `docs/DESKTOP.md`.
