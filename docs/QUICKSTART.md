# Quickstart

Stand up your own Paracoding environment — an always‑on MCP control server plus an idle‑off Linux
desktop you remote into — in your own Google Cloud project. **AI proposes; you commit.**

## Prerequisites

- A **Google Cloud project** with billing enabled, and the [`gcloud` CLI](https://cloud.google.com/sdk/docs/install) authenticated (`gcloud auth login`).
- Permission to create Compute Engine VMs, firewall rules, and (optionally) a load balancer in that project.
- A **Claude plan** to sign in with on the desktop — a Claude Max subscription, *or* the keyless path that bills Claude through your own Google Cloud via Vertex.
- *(Optional)* a domain you control, if you want the control plane on your own hostname behind TLS.

Everything below deploys from this repository. Nothing runs a privileged action without your explicit approval.

## 1. Provision the control server

The control server is the fleet's brain — the board, the journal, and the human‑apply gate. It's a small, always‑on, hardened Shielded VM.

```bash
git clone https://github.com/paracoding-ai/paracoding-oss.git
cd paracoding-oss
sudo scripts/rebuild.sh          # turnkey host bootstrap (see docs/REBUILD.md for the exact invocation)
```

`rebuild.sh` installs the MCP server + the **human‑confirmed** job executor, its systemd units (there is **no** always‑on auto‑job runner), and the nginx secret‑path front end. It prints the server's internal IP and your first agent connector path. Full walkthrough: **[docs/REBUILD.md](REBUILD.md)**. Optional hardening (Cloud Armor, source‑IP allowlist, load balancer): **[docs/OPTIONAL-GCP-HARDENING.md](OPTIONAL-GCP-HARDENING.md)**.

## 2. Provision the operator desktop

The desktop is where you work — a full Linux GCE workstation that **idle‑stops when unused**.

```bash
scripts/provision-desktop.sh <PROJECT> <MCP_INTERNAL_IP>
```

Details and options: **[docs/DESKTOP.md](DESKTOP.md)**.

## 3. Remote in and sign in to Claude

1. On the workstation, set up **Chrome Remote Desktop** and connect to it from anything — even a locked‑down work Chromebook.
2. Sign in to **Claude with your own plan** (Claude Max, or configure the keyless Vertex path).

You now have a real Linux desktop with Claude already there, pointed at a supervised agent fleet.

## 4. Run your first proposed‑then‑approved job

This is the whole point — see the gate work:

1. Ask an agent to do something privileged. It **stages** the action on the board (`stage → pending‑confirm`); it does **not** run.
2. **You** approve it (`confirm_work_item` with your out‑of‑band human token). No agent connector can perform this step.
3. The confirm‑runner — the only executor — runs the approved job and writes the result to the append‑only journal.

Try to approve it *as an agent* and the server refuses: confirmation is a human‑only action, by construction.

## Next steps

- **[Security Whitepaper (PDF)](Paracoding-Security-Whitepaper.pdf)** — the full design, threat model, findings, and verified remediation.
- **[docs/REBUILD.md](REBUILD.md)** — the complete rebuild runbook.
- **[docs/OPTIONAL-GCP-HARDENING.md](OPTIONAL-GCP-HARDENING.md)** — edge and platform hardening.
