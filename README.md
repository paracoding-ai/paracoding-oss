# Paracoding — v3

An agent platform that deploys entirely into **your own** Google Cloud project. Agents
propose; you commit. No privileged action reaches your infrastructure until you approve it
with a passkey.

    ./install.sh YOUR_PROJECT_ID

One command, one argument, a brand-new GCP project with billing enabled. The installer
enables APIs, creates Firestore, mints three service accounts, generates every secret into
Secret Manager, deploys the console, the MCP service and the gated executor, walks you
through registering your first passkey, and then **tests itself**. If the self-test fails it
says so and exits non-zero — a green run means it works, not that nothing errored.

## What you get

- **The Autoclave** — a WebAuthn gate. An agent can stage anything; nothing runs until you
  approve it with Face ID, Touch ID or a security key. It fails closed: with no strong
  session secret and no approver, it refuses to run at all.
- **A gated executor** — private, never publicly invokable, which runs approved jobs using
  *your* OAuth token, not a standing robot credential.
- **Signed approvals** — the digest of the command you approved is signed at approval time
  with a Cloud KMS asymmetric key. The private half is usable only by the control plane;
  the executor that runs the job holds the public half and can verify a signature without
  being able to produce one. Firestore IAM has no per-collection granularity, so something
  with database access can corrupt an approval — it cannot forge one.
- **Spends nothing by default** — model buses ship OFF (`fleet_mode=home`).

## Honest limits

Read `SECURITY.md`, which ships in this release. It documents what is not done — including
that a rebuild produces a working, equivalent deployment but not a bit-identical container
image, and that this release has been installed from zero a small number of times, not a
large one. If you find something wrong, the gate is designed so that finding it costs you a
refusal rather than an incident.

## Two services

The installer deploys one built image as two Cloud Run services, and the separation between
them is a security boundary rather than a packaging detail.

`paracoding-control-plane` is the console: the browser pages, and the gate where you register
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
passkey, IAP is how you reach the gate at all, and the passkey session is the upgrade from
there. The console keeps its service name deliberately -- the WebAuthn RP ID is that host,
and renaming the service would invalidate every passkey already registered against it.

The two URLs are not interchangeable, and the installer prints both when it finishes:

- the console URL, at `/gate`, is the one you open in a browser
- the MCP URL, at `/mcp`, is the one you give an MCP client

Underneath IAP the console is still guarded by the application's own passkey session, and
step 8 asserts that guard against your live deployment in the moment before IAP goes in front
of it: `/harness` must send an anonymous caller to `/gate`. It stops rather than putting IAP
in front of a console that would be readable by anyone the moment IAP came off. If it cannot
enable IAP it says so and prints the command to enable it yourself, rather than reporting a
clean install. `uninstall.sh` removes both services.

## Where the installer stops for you

Twice. Step 5d asks whether to create a workstation VM and defaults to no. Step 9 stops to
register your passkey; that moment cannot be automated and should not be, because it is the
whole point of the gate.

Open Cloud Shell and point the installer at a project that has billing linked -- Cloud Shell
already provides `gcloud`, `python3`, `openssl`, `curl` and an interactive terminal. Step 0
checks everything it needs and stops with the exact missing permission rather than the
symptom.

## Using this from another agent client

`agent-plugin/` is an [Agent Plugins](https://agent-plugins.org) package — the vendor-neutral
format for wrapping an MCP server into a portable directory. Point any client that reads the
format at that directory. `agent-plugin/mcp.json` ships with a placeholder URL because your
control plane's address does not exist until you install; the installer prints the exact
value to substitute, and writes a resolved copy next to it that is not part of the manifest.

Apache-2.0. Keep the copyright headers and the NOTICE file.
