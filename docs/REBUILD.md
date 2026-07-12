# Fleet rebuild runbook (DR) ??? verified by drill #100, 2026-07-11

Full fleet restore needs THREE sources + two injections:
1. **paracoding-iac** (this repo) ??? code, config, systemd, nginx, scripts
2. **paracoding-board.git** ??? live board state (agent_state/journal/work_items/infra_jobs JSON), restored by `mcp/restore_board.py`
3. **secrets** ??? NOT in any repo; inject into `/etc/fleet/{gh_token,infra_cap.secret}` (Secret Manager / host)
4. **TLS** ??? re-issue via `certbot --nginx` once DNS points at the new host (drill uses self-signed)

## Steps
1. `scripts/provision-vm.sh <project> [zone] [vm]`  ??? create the VM + firewall
2. copy this repo to the VM, then `sudo scripts/rebuild.sh <gh_token_file>`  (add `--drill` for an isolated test with self-signed cert + placeholder secrets)
3. PROD only: inject real secrets, run certbot, point DNS (mcp/infra/web A records) at the VM
4. verify: `curl -k -X POST .../<secret>/mcp` with an MCP `initialize` ??? expect HTTP 200

## Drill #100 result
Rebuilt onto a fresh isolated VM in ~90s of machine time (post-provision); board fully restored (10 agents / 203 journal / 115 work_items / 35 infra_jobs); mcp initialize = 200. Gaps found & fixed: missing requirements.txt, missing restore_board.py, malformed schema (no `;`, had sqlite_sequence), redacted-vhost needed unique per-agent paths. terraform/ still a TODO (provision-vm.sh is the pragmatic stand-in).
