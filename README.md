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

## Uninstall

From the same checkout in Cloud Shell:

```bash
./install/uninstall.sh --project YOUR_PROJECT_ID          # dry run: lists what it would delete
./install/uninstall.sh --project YOUR_PROJECT_ID --yes    # deletes it
```

It removes, by exact name, what the installer created: the two Cloud Run routers and their IAM and
IAP bindings, the VM and its boot disk, the internal address, the NAT and router, the IAP SSH firewall
rule, the Artifact Registry repo (only if it holds nothing but the two router images), the source and
exec-records buckets, the generated secrets, the four service accounts and their project roles. Anything
already gone is reported and skipped, so it is safe to re-run. Pass `--region`/`--zone` if you
installed outside `us-east1`.

- **The backups bucket is kept** (`gs://PROJECT-paracoding-backups`, the only copy of your data)
  unless you also pass `--delete-backups`.
- **The KMS signing key stays.** Cloud KMS never deletes key rings or keys; the uninstaller schedules
  every key version for destruction (after 30 days by default), so the key can no longer sign anything.
- Enabled APIs and Google-managed service agents are left as they are. To remove everything at once,
  delete the project instead.

## Cost

Measured on the reference install: about **$6 a day** with the VM running all day, about **$4 a
day** when idle-off keeps it stopped most of the time (disk and snapshots still bill). Cloud Run
routers scale to zero. Model usage is billed by whichever provider you connect.

## Layout

| Path | What it is |
| --- | --- |
| `install/` | `install.sh` and `uninstall.sh` (Cloud Shell), `vm-firstboot.sh` (VM startup script) |
| `control-plane/` | Flow Hood console, MCP server, OAuth, strains, tools (TypeScript, Node 24) |
| `deploy/ui/vmcp-ui`, `deploy/mcp/vmcp-mcp` | the two Cloud Run routers, with Picket |
| `deploy/vmcp-install/files/` | patching, idle-off and backup systemd units |
| `ops/backup/` | `fleet-backup.sh` and `fleet-restore.sh` |
| `ops/db/schema.sql` | the fleet database schema |
| `gate-exec/` | the KMS-signed command executor |

## What's new in v21.1

- **Signed execution and the root ops daemon now install with everything else.** `run_command` runs
  through `gate-exec`, which verifies a Cloud KMS signature (`paracoding-approvals/approval-signing`,
  EC P-256) on every approval and records each run in an exec bucket. `vmcp_sudo` talks to a
  loopback-only root daemon that now handles requests in parallel, so one long command no longer
  blocks the rest.
- **Backups are encrypted.** Each archive is OpenPGP (AES-256) encrypted with a passphrase kept in
  Secret Manager (`backup-passphrase`); restore decrypts automatically. **Export that secret and
  keep it somewhere safe: without it no backup can be restored.**
- **`install/uninstall.sh`** removes everything the installer created (see Uninstall).
- Flow Hood's backup **Download** and **Verify** now use your install's backup bucket.

## Known limits

- Anything running as the `fleet` user on the VM (the control plane, approved `run_command` jobs)
  can reach the root ops daemon. Treat strain access as root on the VM.
- `gate-exec` listens on port 8091 on all VM interfaces; every job still needs a KMS-signed approval.
- Installs made with v21.0 do not pick up v21.1's first-boot changes; reinstall into a new project.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
