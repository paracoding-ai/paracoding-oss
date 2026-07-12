# Operator Desktop (a SEPARATE VM)

Paracoding runs as **two VMs** — the same pattern as production, and on purpose:

| VM | Machine | Runs | Cost |
|----|---------|------|------|
| **MCP server** (`paracoding-mirror`) | e2-small, **always-on**, hardened | the fleet control plane (confirm-gate, per-agent identity) | ~$12/mo |
| **Operator desktop** (`paracoding-desktop`) | e2-standard-4, **idle-stops** | XFCE + Chrome + Claude Desktop + Chrome Remote Desktop | **~$0 when unused** |

**Why separate (not one big box):** a desktop needs ~16 GB — the always-on e2-small can't run one,
and up-sizing an always-on box means a big always-on bill. Bolting a browser onto the hardened MCP
server would also blow up its attack surface. Separate is **cheaper AND more secure**. The desktop
talks to the MCP server over the **internal VPC IP** — no public domain, no public TLS.

## Stand up the desktop (in the same project as the MCP server)
```bash
MCP_IP=$(gcloud compute instances describe paracoding-mirror --zone=us-central1-a \
          --format='value(networkInterfaces[0].networkIP)')
bash scripts/provision-desktop.sh <PROJECT_ID> "$MCP_IP"
```
Then do the **two one-time human steps** the script prints:
1. **Register with Chrome Remote Desktop** — `remotedesktop.google.com/headless` → copy the Linux
   auth command → run it on the desktop VM → set a 6-digit PIN. The desktop then shows up in your CRD list.
2. **Sign in to Claude** once (Claude Desktop + the Chrome extension) — the datacenter-IP check is one-time.

## Idle-off (cost)
The desktop **self-stops after 30 min of no input** — compute billing stops. To use it again, start it
(`gcloud compute instances start paracoding-desktop --zone=us-central1-a`) and reconnect via CRD.

## Access model
Remote screen only (Chrome Remote Desktop), PIN-gated, scoped to your lab — ideal from a locked-down
work Chromebook. The desktop has no public ingress; it reaches the fleet privately.
