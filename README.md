# Paracoding — v8.4

Most agent demos end with "…and then it deployed to production."

This one ends with a refusal.

Paracoding is an agent platform that installs into **your own** Google Cloud project in one
command. Agents propose. You commit. Then it builds the next version of itself.

    bash install.sh YOUR_PROJECT_ID

One command, one argument, a brand-new GCP project with billing enabled. The installer
enables APIs, creates Firestore, mints three service accounts, generates every secret into
Secret Manager, deploys the console, the MCP service and the gated executor, walks you
through registering your first passkey, and then **tests itself**. If the self-test fails it
says so and exits non-zero — a green run means it works, not that nothing errored.

Apache-2.0. Your project, your bill, your key.

---

## What's actually in it

**Serverless MCP behind Google IAP — and the reason there are two services.**
IAP eats the `Authorization` header, so an MCP client can never live behind it. One image,
one 90-route table, deployed twice: IAP on for humans, off for machines. Scale-to-zero on
both. A route that maps to neither surface throws at boot rather than shipping broken.

**Two MCP protocol eras on one endpoint.**
The 2026 stateless revision and the 2025 handshake answer on the same `POST /mcp`, routed as
a pure function of one request's bytes — no connection state, no cache, no clock.

**A git server with no git binary and no disk.**
Isomorphic-git over Firestore and Cloud Storage — refs get real serializable
compare-and-swap in a transaction, objects get atomic whole-packfile writes. Serverless git
that scales to zero. No force push. Ever.

**X-Wing sealing everything at rest.**
The hybrid post-quantum KEM — ML-KEM-768 and X25519, 1120 bytes of ciphertext — so an
attacker has to break the lattice *and* the elliptic curve. The same envelope covers the git
objects and the data lake.

**Your work is not trapped in a chat session.**
Memory, journal, history, files and git all live in your project, encrypted. Hit a usage
limit, move to another Claude Max plan, paste the bootstrap, and the agent resumes with its
full history intact. Portable agent state is the whole payoff of putting the crypto
underneath it.

**Dual model buses with a billing boundary.**
Claude and Gemini, and a three-position switch: `home` spends nothing, `dual` runs on your
keys, `work` is keyless and employer-billed on Vertex. The keyed transport is refused
outright in `work` mode — enforced in code, not remembered by a human. Anything unset,
unreadable or unrecognised fails safe to `home`.

**Agent identity we built ourselves, then made interoperable.**
Every strain is a first-class identity with its own scope, journal lane and memory, and
cannot read another's — a leaked key leaks a role, not the system. Each one publishes an A2A
agent card at `/agents/{role}/.well-known/agent-card.json`, discoverable by anything that
speaks Agent2Agent.

**Your own MCP server, not a tenant on someone else's.**
~55 tools over full OAuth 2.1 — work items, a memory graph, a journal, file storage, git,
execution, infra, messaging — and the source ships with it. Change a tool, cut a release,
redeploy. It also ships as an [Agent Plugins](https://agent-plugins.org) package, so any
client that reads the format can connect.

**It ships the pipelines that rebuild it.**
Cloud Build configs, a release generator with leak gates, route audits and structural
checks, and the git and deploy tools an agent uses to modify the thing it is running inside.
The generator fails the build outright when it catches you — including twice in the week
this release was cut, correctly.

**A chat that can actually build.**
Claude and Gemini side by side, Gemini 3.7 Flash live out of the gate, wired straight into
GCP — ask a strain for a service and it builds the container and deploys it to Cloud Run.
Effectively a Claude-to-GCP connector with a passkey in front of it.

**Every privileged action needs that passkey.**
The Autoclave is a WebAuthn gate: an agent can stage anything, and nothing runs until you
approve it with Face ID, Touch ID or a security key. Approvals are signed with a Cloud KMS
asymmetric key and bound to one job id and one command digest — edit the command after
approval and it is refused. The control plane holds the private half; the executor that runs
the job holds only the public half, so it can verify a signature without being able to
produce one. It fails closed: with no strong session secret and no approver, it refuses to
run at all.

**Jobs run inside a binary jail.**
The approved script executes with `PATH` restricted to an enumerated set, so an unlisted
binary simply does not resolve. What authorises the work in the first place is that a human
approved that exact command, and the executor refuses any script whose hash does not match
the approval.

**Memory that survives the session.**
A knowledge graph where corrections supersede rather than overwrite, so you can always tell
a corrected claim from a current one.

Built the way it runs: Claude Max plans through Cowork, subagents fanned out across the
engineering work in parallel, moving between plans when one ran hot — and never losing the
thread, because the state was never in the chat.

A thing that builds the things.

---

## It builds and deploys, end to end

Ask a strain in the console chat for a service, and it builds the container and deploys it
to Cloud Run in your project — then verifies the result anonymously and reports the HTTP
code back.

![The console chat asking Fleet GCP to build and deploy a hello-world app to Cloud Run, with the build and deployment summary and a 200 OK verification](docs/screenshots/01-build-and-deploy.png)

Everything configurable lives on one panel: theme, the model substrate (Claude or Gemini,
3.7 Flash or 3.1 Pro), key rotation, the per-strain session pastes that give a chat its
identity, and the Google accounts allowed to authorise an MCP connector.

![The settings panel showing appearance, model substrate selection, API key rotation, per-strain session pastes and allowed Google accounts](docs/screenshots/02-strain-settings.png)

---

## Two services

The installer deploys one built image as two Cloud Run services, and the separation between
them is a security boundary rather than a packaging detail.

`paracoding-control-plane` is the console: the browser pages, and the place where you register
a passkey and approve work. Step 8 puts it behind Identity-Aware Proxy, grants the installing
account `roles/iap.httpsResourceAccessor`, and removes its public invoker binding, so an
anonymous request is refused at Google's edge before your container is reached.

`paracoding-mcp` is the machine-facing surface: the MCP transports, OAuth 2.1 and its
discovery documents, the agent cards, and the token-authenticated agent API. It is publicly
invokable and IAP is off in front of it. It has to be -- IAP consumes the `Authorization`
header and an MCP client has no Google identity to present, so with IAP on, `POST /mcp` is
refused at the edge and no client can connect at all. IAP on Cloud Run is one switch per
service with no path-level carve-out, which is why one service cannot serve both purposes.

Separating them means a compromise of the machine-facing surface does not reach the human
console. It is also the bootstrap path into a fresh install: before you have registered a
passkey, IAP is how you reach the console at all, and the passkey session is the upgrade from
there. The console keeps its service name deliberately -- the WebAuthn RP ID is that host,
and renaming the service would invalidate every passkey already registered against it.

The two URLs are not interchangeable, and the installer prints both when it finishes:

- the console URL, at `/harness`, is the one you open in a browser
- the MCP URL, at `/mcp`, is the one you give an MCP client

Underneath IAP the console is still guarded by the application's own passkey session, and
step 8 asserts that guard against your live deployment in the moment before IAP goes in front
of it: `/harness` must answer an anonymous caller `401` with the locked page. It stops rather
than putting IAP in front of a console that would be readable by anyone the moment IAP came
off. If it cannot enable IAP it says so and prints the command to enable it yourself, rather
than reporting a clean install. `uninstall.sh` removes both services.

## Where the installer stops for you

Twice. Step 5d asks whether to create a workstation VM and defaults to no. Step 9 stops to
register your passkey; that moment cannot be automated and should not be, because it is the
whole point of the gate.

Open Cloud Shell and point the installer at a project that has billing linked -- Cloud Shell
already provides `gcloud`, `python3`, `openssl`, `curl` and an interactive terminal. Step 0
checks everything it needs and stops with the exact missing permission rather than the
symptom.

## The workstation VM

Declining at step 5d is not a one-way door. `workstation.sh` ships in this release and
creates the VM later, on its own:

    bash workstation.sh              asks: none, linux or windows
    bash workstation.sh linux        non-interactive, scriptable
    bash workstation.sh windows

It is safe to re-run -- an existing VM is adopted rather than recreated -- and running it
twice with different flavours leaves you with both, side by side. The Windows box is given
no public IP and is reachable only over IAP TCP forwarding: the single firewall rule it
creates allows RDP from IAP's range and from nowhere else.

**The Claude desktop app is preinstalled, and the startup log says how.** Linux registers
Anthropic's apt repository (`downloads.claude.ai/claude-desktop/apt/stable`), pins its
signing key to a fingerprint, and installs `claude-desktop`, so later updates arrive with
`apt-get upgrade`. Windows downloads Anthropic's published setup redirect and refuses any
file whose Authenticode signature is not Anthropic's. Both are DEFAULTS written onto the
instance as metadata, so you can override or disable either without cutting a new release:
`PC_CLAUDE_APT_REPO`, `PC_CLAUDE_APT_KEY`, `PC_CLAUDE_APT_FPR`, `PC_CLAUDE_WIN_URL`, or the
per-instance keys `pc-claude-deb-url` and `pc-claude-win-url`. If a platform's install does
not succeed the script does not pretend it did: it logs that "Claude" on that box means the
Claude Code CLI plus a dedicated Chrome app window for claude.ai, and leaves you with those.

## Using this from another agent client

`agent-plugin/` is an [Agent Plugins](https://agent-plugins.org) package — the vendor-neutral
format for wrapping an MCP server into a portable directory. Point any client that reads the
format at that directory. `agent-plugin/mcp.json` ships with a placeholder URL because your
control plane's address does not exist until you install; the installer prints the exact
value to substitute, and writes a resolved copy next to it that is not part of the manifest.

## More

- `FEATURES.md` — the full feature inventory
- `wiki/` — architecture pages, including the five diagrams
- `SECURITY.md` — the security policy and how to report

Apache-2.0. Keep the copyright headers and the NOTICE file.
