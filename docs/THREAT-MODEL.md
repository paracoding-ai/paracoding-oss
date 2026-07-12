# Paracoding — Security Posture & Threat Model (release)

**Scope:** the Paracoding reference implementation — an MCP control plane, a typed root job-runner
with a human-confirm gate, per-agent workspaces, and the nginx/systemd/GCP scaffolding around them.
**Method:** STRIDE + attack-tree findings (F1-F13), each carried here with its current control and
residual. Every "remediated" row was proven by re-running the attack and showing it now fails.

## Posture at a glance
A single-operator autonomous fleet, hardened defense-in-depth: the root-execution path is human-gated,
the MCP endpoint sits behind Google's edge (LB + Cloud Armor), agents carry an unforgeable identity,
and privileged actions require an out-of-band human approval. Remaining items are either adopter
responsibilities (single-operator blast radius) or documented staged hardening - none are silent gaps.

## Findings
| # | Finding | Status | Control (evidence) | Residual |
|---|---|---|---|---|
| F1 | auto job -> root, no human gate | Remediated + proven (closed by construction) | The unattended auto-executor was REMOVED entirely - no agent-enqueued job can reach root. Privileged actions now flow: stage (pending-confirm) -> a token-gated HUMAN-ONLY confirm (agent connectors rejected before the token check) -> a confirm-runner executes only human-approved items (typed allowlist + root-owned/not-writable trust-check). Proven: agent-connector confirm -> rejected; only a human-path confirm triggers a run; sim `sync_path /root/...` -> "src not allowed". | none - no unattended path to root |
| F2 | sync_path could copy /root secrets to an agent-readable dir | Remediated + proven | `/root` removed from src allow-list; sim `src=/root/...` -> "src not allowed", no exfil dir. | - |
| F3 | agent identity self-asserted | Remediated + proven | nginx injects an unforgeable X-Agent-Id per secret-path; the server reads it as the trusted identity AND enforces it as the actor on mutating tools (a mismatched claimed agent_id is ignored). Proven: a client claiming another agent -> trusted identity wins (impersonation blocked); a mutating call with a forged agent_id records under the trusted id, not the claim. | per-connector identity binding must be verified at setup |
| F4 | prompt-injection -> privileged action | Mitigated | Compute-use worker isolated + deny-default allowed_domains; privileged actions require the human-confirm gate (injected agent can stage, cannot approve). | keep privileged tools out of injectable agents (design rule) |
| F5 | cloud-account single point of failure | Accepted / adopter | Hardware-key 2FA + Advanced Protection; audit-log alerting recommended. | single-operator blast radius - adopter adds break-glass recovery + least-priv SAs |
| F6 | operator workstation holds an SSH key -> root | Mitigated / adopter | CRD-gated; auto-stops when no human is present. | passphrase + scope the key - adopter responsibility |
| F7 | public MCP endpoint | Remediated + proven | External HTTPS LB + Cloud Armor (allow only the AI provider egress range, default-deny) + VM firewall lock; real client proven through the LB, direct-VM -> 403. | edge allow-list is a shared provider range (defense-in-depth, not authN) |
| F8 | coordination state mirrored to git | Documented / accepted | Private repo (git authZ is the control); secrets + connector URLs excluded from the snapshot. | keep confidential prose out of journals; classify/encrypt = staged |
| F9 | capability bypassed by the auto path | Remediated | Closed with F1 (auto path narrowed; privileged path human-gated). | - |
| F10 | run_box_deploy ran an unchecked script | Remediated + proven | Root-owned + non-writable trust-check; sim with a planted non-root script -> "refusing: not root-owned". | - |
| F11 | website deface via write jobs | Remediated | Write jobs off the auto path (human-apply only). | - |
| F12 | supply chain (dependency integrity) | Remediated | Version + sha256 hash-pinned from PyPI digests (432 hashes / 29 pkgs; pip --require-hashes verified) - a compromised index cannot substitute an artifact. | - |
| F13 | data at rest | Accepted | Provider disk encryption; Shielded VM (Secure Boot + vTPM + integrity) in the provisioner. | app-level field encryption / CMEK = optional adopter hardening |

## The one structural guarantee
Root integrity reduces to: (1) the job allow-list can't be extended by an agent - enforced; and
(2) every auto-run job is safe against hostile params - enforced (unsafe jobs are off the auto path,
privileged ones are human-gated). Both hold, each proven by a re-run attack.

## Adopter responsibilities (single-operator posture)
- Break-glass recovery account + least-privilege per-service accounts (F5).
- Passphrase + scope the operator SSH key; treat the workstation as production (F6).
- Enable Cloud Audit Logs + billing alerts; apply the optional org policies in `docs/OPTIONAL-GCP-HARDENING.md`.
- Keep secrets and confidential content out of agent journals (F8).

## Staged hardening (documented, not silent)
- F3 strict per-tool enforcement + confirm-via-approver-path (removes the token-in-call).
- Confirm-gate execution wiring behind a supervised PRIVILEGED_ALLOWLIST (secure-default empty).
- F8 sensitive-field classification/encryption.

*No finding is undisclosed. Remediated rows were proven by attack re-run; accepted rows carry an
explicit rationale + an adopter action.*
