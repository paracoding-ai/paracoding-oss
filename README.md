# Paracoding — v3

An agent platform that deploys entirely into **your own** Google Cloud project. Agents
propose; you commit. No privileged action reaches your infrastructure until you approve it
with a passkey.

    ./install.sh YOUR_PROJECT_ID

One command, one argument, a brand-new GCP project with billing enabled. The installer
enables APIs, creates Firestore, mints three service accounts, generates every secret into
Secret Manager, deploys the control plane and the gated executor, walks you through
registering your first passkey, and then **tests itself**. If the self-test fails it says so
and exits non-zero — a green run means it works, not that nothing errored.

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

## Installing stops once for you

The installer is one command and it stops exactly once, to register your passkey. That
moment cannot be automated and should not be: it is the whole point of the gate.

Earlier releases stopped a second time to have you create a Google OAuth client before any
approval could execute. That step is gone. The console now sits behind Identity-Aware Proxy,
which uses a Google-managed OAuth client, so there is no consent screen to configure and no
client ID to paste. If your project is not in a Google Cloud Organization the installer may
be unable to switch IAP on for you; it says so plainly, tells you the one link to click, and
carries on rather than pretending.

## Before you run it

The installer now checks each of these and stops with the fix rather than the symptom, but
they are listed here so you can have them ready:

| Prerequisite | Who provides it | Checked? |
|---|---|---|
| A Google Cloud project **with billing linked** | you | yes, step 0 |
| `roles/owner` on that project (or the equivalent set) | you | yes, step 0 — the exact missing permission is named |
| `gcloud`, `python3`, `openssl`, `curl` on your PATH | you | yes, step 0 |
| The gcloud **`beta`** component | you | yes, step 0 — without it the console cannot be put behind IAP |
| An **interactive terminal** | you | yes, step 0 — step 9 waits for you to register a passkey |
| A region that is **both** a Cloud Run region and a Firestore location | you | yes, step 0 — warns, and names four that are |
| Every required API | the installer | enabled in step 1 |
| The Firestore database | the installer | created in step 2, randomly named, never `(default)` |
| Composite indexes | the installer | four, in step 2b |
| Service accounts, IAM, secrets | the installer | steps 3 and 4 |
| An OAuth client and a consent screen | **nobody — not needed** | IAP uses a Google-managed client |
| A domain name or TLS certificate | **nobody — not needed** | the `run.app` URL is the deployment |

Two things the installer cannot check for you, because the answer lives above the project:

- **Organization policy.** If your organization enforces
  `constraints/iam.allowedPolicyMemberDomains`, the `--allow-unauthenticated` binding in
  steps 5 and 6 is rejected. The control plane is meant to be reachable and is defended by
  IAP in front and by its own auth behind; if your org forbids that binding you will need an
  exception, or a load balancer in front, and neither is scripted here.
- **Whether your project is in an Organization at all.** IAP for Cloud Run generally needs
  one. If it is not, step 8 says so plainly, gives you the single link to click, and
  continues — it does not pretend the console is protected when it is not.

## Not included

This release provisions a control plane, a gated executor, a Firestore database, service
accounts and secrets. That is all it provisions. Some tools that the control plane registers
talk to infrastructure **you do not get from `install.sh`**, and they will register cleanly
and then fail when called:

- **The data lake.** `read_file`, `write_file`, `list_files` and `put_file` read and write a
  Cloud Storage bucket. The code looks for `DATA_LAKE_BUCKET` / `LAKE_BUCKET`; the installer
  sets neither and creates no bucket. Create one, grant the control-plane service account
  `roles/storage.objectAdmin` on it, and set the variable on the service.
- **The virtual machine tools.** `vm_status` and `ssh_executor` act on a Compute Engine
  instance named by `WS_VM` and `WS_ZONE`. This installer creates no instance and sets
  neither variable.
- **The browser tools.** `browser_open`, `browser_navigate`, `browser_eval` and `browser_tabs`
  need a Chrome DevTools Protocol endpoint (`WS_CDP_PORT`) running somewhere reachable.
  Nothing here starts one.
- **Any model bus.** Deliberate: buses ship OFF (`fleet_mode=home`), so a fresh install
  spends nothing until you turn one on and supply your own key.

None of these is a broken install. They are the boundary of what one command can honestly
set up in a project it has never seen. `SECURITY-WHITEPAPER.md` §2a records them as known
defects rather than hiding them, and fixing them means provisioning the backing service
yourself or not using those tools.

## Using this from another agent client

`agent-plugin/` is an [Agent Plugins](https://agent-plugins.org) package — the vendor-neutral
format for wrapping an MCP server into a portable directory. Point any client that reads the
format at that directory. `agent-plugin/mcp.json` ships with a placeholder URL because your
control plane's address does not exist until you install; the installer prints the exact
value to substitute, and writes a resolved copy next to it that is not part of the manifest.

Apache-2.0. Keep the copyright headers and the NOTICE file.
