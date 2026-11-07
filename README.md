# Paracoding.AI v21

An open agentic control plane you install into your own Google Cloud project with one command.
Your agents (strains) get a durable memory, a work queue, a journal, signed execution, and a real
source-control home: **their own GitLab**, with merge requests and CI pipelines. Connect any MCP
client, including claude.ai, and switch strains per request.

Apache-2.0. Nothing runs on our infrastructure; everything is in your project.

> **v21 is a new architecture.** v15.1 and earlier ran fully serverless (Cloud Run + Firestore +
> serverless git). v21 runs on **one private VM** with GitLab, Postgres and the control plane,
> behind two small Cloud Run routers. The last serverless release stays available as the
> [`v15.1` tag](https://github.com/paracoding-ai/paracoding-oss/tree/v15.1).

## What you get

```
            claude.ai / any MCP client                 you, in a browser
                       |                                       |
             Cloud Run: vmcp-mcp                   Cloud Run: vmcp-ui (+ IAP)
             MCP edge, Picket auto-ban             console router, start page
                       \                                     /
                        \----- private VPC (no public IP) --/
                                         |
                        VM (e2-standard-4, stops after 2 idle hours)
          control plane (Flow Hood console + MCP server, OAuth 2.1, strains)
          GitLab CE (repos, merge requests, CI runner)   Postgres (memory, journal, work items)
          daily one-file backups to your bucket   boot-time security patching
```

- **Flow Hood**: the console. Chat with strains, provision new ones, bind connectors, start/stop the VM.
- **MCP server** over OAuth 2.1: memory graph, journal, work items, agent-to-agent messaging, files,
  GitLab API, GCP API, gcloud, signed execution.
- **One strain to start**: `fleet-advisor`. Grow the rest from the Flow Hood ("Provision a new agent").
  New connectors land on the read-only `fleet-onboarder` strain until you bind them.
- **Sign-in through Google IAP**: no passwords, no Google OAuth client to create. The console, the
  GitLab login button and the MCP connector consent all use your IAP identity.
- **Picket**: behaviour-based auto-ban at the MCP edge (only requests the VM rejected count; an
  authenticated response never strikes), plus prompt-injection signatures in detect mode.
- **Backups**: a full one-file backup daily (fleet DB, config, lake, and a fresh GitLab backup with its
  secrets), newest 7 kept, plus a restore script that refuses on a GitLab version mismatch.

## Install

Requirements: a Google Cloud project with billing, and Owner on it. Run in Cloud Shell:

```bash
git clone https://github.com/paracoding-ai/paracoding-oss.git && cd paracoding-oss
./install/install.sh --project YOUR_PROJECT_ID --admin you@yourdomain.com
```

Options: `--region` (default `us-east1`), `--zone`, `--machine` (default `e2-standard-4`), `--disk`
(GB, default 100), `--no-wait`. It is safe to re-run. The VM's first boot takes about 15 minutes
(GitLab install plus the control-plane build); the installer waits and prints your URLs:

- Flow Hood: `https://vmcp-ui-PROJECT_NUMBER.REGION.run.app/`
- GitLab: `https://vmcp-ui-PROJECT_NUMBER.REGION.run.app/gitlab/` (sign in with **Paracoding IAP**)
- MCP: `https://vmcp-mcp-PROJECT_NUMBER.REGION.run.app/mcp`

No domain, DNS or certificate is needed. To use your own domain, put a Google HTTPS load balancer
(optionally with Cloud Armor) in front of the two routers.

## After install

1. Open the Flow Hood; IAP asks you to sign in with the `--admin` account.
2. In claude.ai, add a custom connector with the MCP URL and authorize it. It lands on
   `fleet-onboarder` (read-only).
3. In the Flow Hood, bind that connector to `fleet-advisor`. Run `whoami` to confirm.
4. Provision more strains from the Flow Hood when you need them.

## Cost

Measured on the reference install: about **$6 a day** with the VM running all day, about **$4 a
day** when idle-off keeps it stopped most of the time (disk and snapshots still bill). Cloud Run
routers scale to zero. Model usage is billed by whichever provider you connect.

## Layout

| Path | What it is |
| --- | --- |
| `install/` | `install.sh` (Cloud Shell) and `vm-firstboot.sh` (VM startup script) |
| `control-plane/` | Flow Hood console, MCP server, OAuth, strains, tools (TypeScript, Node 24) |
| `deploy/ui/vmcp-ui`, `deploy/mcp/vmcp-mcp` | the two Cloud Run routers, with Picket |
| `deploy/vmcp-install/files/` | patching, idle-off and backup systemd units |
| `ops/backup/` | `fleet-backup.sh` and `fleet-restore.sh` |
| `ops/db/schema.sql` | the fleet database schema |
| `gate-exec/` | the KMS-signed command executor |

## Known gaps in v21.0

- `gate-exec` (signed execution) and the root ops daemon are in the tree but **not yet installed** by
  `install.sh`; tools that need them (`run_command`, `vmcp_sudo`) return errors until they are.
- Browser-driving tools need headless Chrome on the VM, which the installer does not set up yet.
- Backups are not encrypted; keep the backup bucket private.
- `uninstall.sh` is not written yet: delete the project, or remove the resources named `paracoding-*`,
  `vmcp-ui` and `vmcp-mcp`.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
