# Security model (v21)

- **No public IP on the VM.** Traffic reaches it only through the two Cloud Run routers over Direct
  VPC egress. SSH is allowed only from Google's IAP TCP-forwarding range (`35.235.240.0/20`).
- **IAP at the console.** `vmcp-ui` uses Cloud Run's built-in IAP; only principals you grant
  `roles/iap.httpsResourceAccessor` reach it. The control plane verifies the IAP assertion
  (`PC_IAP_AUD`) and uses that identity for console sessions, OAuth consent and the GitLab login.
- **MCP edge.** `vmcp-mcp` passes requests to the VM, which does the real authentication (OAuth 2.1
  with PKCE and dynamic client registration). Picket bans clients that keep probing and being
  rejected; authenticated traffic is never banned.
- **Least-privilege strains.** Unbound connectors land on `fleet-onboarder`, which can only answer
  `whoami`. You bind a connector to a strain in the Flow Hood.
- **Secrets** are generated at install time into Secret Manager and loaded at service start into a
  root-written runtime file; no service-account key files are created.
- **GitLab** sign-ups are disabled; users arrive only through the IAP-backed SSO button.
- **Patching.** Security and update packages install on every boot and daily; third-party packages are
  pinned to their current series. GitLab upgrades within its pinned series.
- **Backups** are encrypted (OpenPGP, AES-256) with a passphrase generated into Secret Manager
  (`backup-passphrase`); the passphrase never enters the archive, a log or a command line. The archive
  still contains GitLab's `gitlab-secrets.json` once decrypted, so guard both the bucket and the secret.
- **Signed execution.** `run_command` jobs run only with an approval signed by a Cloud KMS key the
  control plane holds; `gate-exec` verifies the signature and writes create-only run records.
- **Root ops daemon.** `vmcp_sudo` uses a root daemon bound to 127.0.0.1:8022 with a random token
  (`/opt/pc-ops-token`, root-only). The control plane holds that token, so a strain that can run
  commands as `fleet` can reach root: grant strains accordingly.

Report vulnerabilities privately through GitHub Security Advisories on this repository.
- **Browser tools.** Agents drive the desktop's Chrome through `cdp-bridge`, which binds only the VM's
  internal address, demands its own random token (`/opt/cdp-token`), allows a fixed list of DevTools
  methods, and is firewalled from the network (`paracoding-deny-cdp`); Chrome's DevTools port listens
  on 127.0.0.1 only. The default site policy allows every website, because it is your browser and
  your sessions: a strain with browser tools can act as you on any site you are signed into. Narrow
  it in `/opt/cdp-policy.json` (allow list, deny list, input on/off).
