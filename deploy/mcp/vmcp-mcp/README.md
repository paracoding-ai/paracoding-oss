# vmcp-mcp — MCP edge front

Streaming reverse proxy in front of the MCP server on the VM (control-plane `:8090`), with the
**Picket edge sensor** inline. One of the two "small Cloud Run fronts" (the other is the UI front,
`vmcp-waker`). Replaces the LB + Cloud Armor path for `mcp.example.com`.

- **Transparent:** forwards every request to `MCP_UPSTREAM` and streams the response (SSE-safe).
  The MCP server keeps doing its own auth (the front is `allow-unauthenticated`; the MCP path has
  no IAP).
- **Picket edge:** `heuristics.py` is a **pinned mirror** of `root/paracoding-security`
  (`prompt-guard/heuristics.py` @ 2d4ff3db) — do not edit here; use `refresh-picket.sh`.
  **Detection-only by default** (`PICKET_MODE=detect`): senses, logs, counts (`/__picket/stats`)
  and tracks recidivism, but never blocks — per Picket's alert-only doctrine, so it cannot break
  the live connector. The security lane promotes rules to `enforce` later.
- **Reaches the private VM** via Direct VPC egress (`default` subnet); no firewall rule needed.

Deploy: pipeline only (`deploy:mcp`, reusable `.deploy-cloud-run`). Never `gcloud run deploy` by hand.

Pre-cutover TODO: dedicated zero-role `vmcp-mcp@` SA (terraform); shared ban state in VM Postgres
(in-memory bans are per-instance); then domain-map `mcp.example.com` and retire the LB path.
