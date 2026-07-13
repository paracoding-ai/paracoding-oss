<div align="center">

# Paracoding

### Your own cloud AI‑operations environment — a hardened Linux desktop you remote into, signed in with your Claude plan, driving a supervised agent fleet. Deployed into *your* Google Cloud from one repo.

**AI proposes. A human commits.**

</div>

---

## What you actually get

Paracoding deploys — from this repository into a fresh Google Cloud project — a supervised AI‑operations setup you can stand up yourself:

- 🖥️ **An AI‑enabled Linux desktop in the cloud.** A GCE workstation you **remote into with Chrome Remote Desktop** from anything — even a locked‑down work Chromebook. It **idles off when you're not using it**, so you're not paying for a box that just sits there.
- 🔐 **Signed in with your own Claude plan.** Log in on that desktop with **your Claude Max subscription** and drive Claude directly — full desktop, real browser, real shell. *(Prefer no subscription? There's also a keyless path that bills Claude through your own Google Cloud via Vertex.)*
- 🤖 **A supervised agent fleet.** Behind the desktop runs a small, always‑on control server — the fleet's brain: a shared **board, journal, and human‑apply gate**. Role‑scoped agents (advisor, breakglass, publisher, …) propose work there; you approve what actually runs.
- 🛡️ **Hardware‑rooted and human‑gated.** Every machine is a Titan‑backed Shielded VM, and no agent can take a privileged action without you.

---

## Why it's safe to point AI agents at real infrastructure

Most "autonomous agent" projects ask you to trust that the agent won't do something catastrophic. Paracoding is built on the opposite premise:

> **An autonomous agent must never be able to take a consequential action on its own.**

Every privileged operation is *proposed by an agent and committed by a human.* The confirmation step is a **human‑only** action the server enforces — it rejects any agent connector and requires an out‑of‑band token no agent holds — so an agent that is confused, misled, or compromised still cannot change production. That property, plus the layers below, is what makes it responsible to hand an agent a cloud account:

- **Hardware root of trust (Google Titan).** Every machine is a Shielded VM — Titan‑rooted vTPM, Secure Boot, integrity monitoring. The root of trust lives *below* anything an attacker could change from inside the OS.
- **Per‑agent identity, least privilege.** Each agent has its own server‑enforced identity, bound at the connector — no agent can impersonate another. The fleet authenticates with keyless workload identity (ADC); there are no long‑lived keys to leak.
- **The human‑apply gate.** An agent can *stage* a privileged action; only a human can *run* it. A dedicated confirm‑runner is the only executor of privileged jobs, and it runs **only** what a human approved — there is no always‑on auto‑executor.
- **Defense in depth at the edge.** The control plane sits behind Google Cloud Armor (deny‑by‑default), a source‑IP allowlist, and an external HTTPS load balancer.
- **Audit‑trail‑first & reproducible.** Every action is written to an append‑only journal, and the entire hardened fleet rebuilds from this repository — deployed state matches reviewable code.

The gate isn't a promise in a slide — it's in the code you're reading: [`mcp/server.py`](mcp/server.py) enforces human‑only confirmation, and [`jobs/confirm_runner.py`](jobs/confirm_runner.py) executes **only** human‑confirmed jobs.

This project is deliberately precise about what it earns — a hardware root of trust, per‑agent identity, keyless least privilege, a human‑approval gate, an end‑to‑end audit trail, full reproducibility — and what it does **not** claim: it has not been independently audited and makes no compliance claims. A single‑operator deployment concentrates trust in one operator — a deliberate trade‑off, stated plainly rather than hidden.

---

## Architecture

Two VMs, split for cost and blast‑radius:

| | MCP control server | Operator desktop |
|---|---|---|
| **Role** | always‑on fleet brain — board · journal · confirm gate | where you work — a full Linux desktop |
| **Machine** | small, hardened, always up | larger; **idle‑stops when unused** |
| **Access** | behind load balancer + Cloud Armor + secret‑path auth | Chrome Remote Desktop |
| **Privilege** | runs only human‑confirmed jobs | proposes work; never self‑approves |

Every machine is a Titan‑backed Shielded VM, rebuilt from this repo.

---

## Quickstart

You'll need a Google Cloud project and the `gcloud` CLI.

1. **Provision the control server** — `scripts/rebuild.sh` (turnkey host bootstrap; DR‑drill verified).
2. **Provision the desktop** — `scripts/provision-desktop.sh <PROJECT> <MCP_INTERNAL_IP>` — see [`docs/DESKTOP.md`](docs/DESKTOP.md).
3. **Wire up Chrome Remote Desktop**, sign in with your Claude plan, and run your first *proposed‑then‑approved* job.

Full rebuild runbook: [`docs/REBUILD.md`](docs/REBUILD.md) · Optional hardening: [`docs/OPTIONAL-GCP-HARDENING.md`](docs/OPTIONAL-GCP-HARDENING.md).

---

## What's in this repo

| Path | What's there |
|---|---|
| [`mcp/`](mcp/) | MCP fleet server — board, journal, per‑agent identity binding, the human‑confirm gate |
| [`jobs/`](jobs/) | the human‑confirmed privileged executor + the typed job‑type allowlist |
| [`systemd/`](systemd/) | units + timers — **no always‑on auto‑job runner**; privileged actions go through the gate |
| [`scripts/`](scripts/) | `rebuild.sh`, `provision-desktop.sh`, `provision-vm.sh`, `verify.sh` |
| [`agents/`](agents/permission-model.txt) | per‑agent users/groups + workspace permission model |
| [`docs/`](docs/) | rebuild runbook, desktop setup, optional GCP hardening |

---

## Status

**MVP · v1.0 — early open‑source release.** It ships a real, hardware‑rooted, human‑gated security model that was threat‑modeled before release, but it has **not** been independently audited and makes no compliance claims. Read the code and the docs before pointing it at anything you can't afford to lose.

## License

See [LICENSE](LICENSE).

<div align="center">
<sub>Everything attested · identity‑scoped · human‑gated · logged · reproducible from source.</sub>
</div>
