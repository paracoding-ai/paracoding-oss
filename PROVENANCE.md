# Paracoding — provenance & how to make it yours

**Paracoding** is a clean-room reference implementation of an autonomous multi-agent infrastructure
fleet: an MCP control plane, a typed root job-runner with a human-confirm gate, agent workspaces, and
the nginx/systemd/DR scaffolding around them. It ships as config-as-code and runnable scripts with
**no secret values**, so you can stand it up in your own GCP project.

## v0.1 scope
The proven core only — the MCP board/server, the job-runner + typed jobs, systemd units, the nginx
front door (secret-path auth), the agent permission model, and the rebuild / disaster-recovery scripts.

## Make it yours — substitute these placeholders
| Placeholder | Replace with |
|---|---|
| `YOUR_ORG` | your GitHub org (e.g. `github.com/YOUR_ORG/...`) |
| `YOUR_GCP_PROJECT` | your GCP project id |
| `example.com` / `mcp.example.com` / `infra.example.com` | your domain(s) |
| `you@example.com` | your ops/admin contact |
| `paracoding-*` (service + agent names) | keep the reference names, or rename to your own scheme |

## Secrets
No secret values live in this repo — only structure and pointers. Supply your own at deploy time via
host-side root-only files or GCP Secret Manager. See `docs/SECRETS-pointers.txt`.

## Attribution
Released as the Paracoding reference model. See `LICENSE`.
