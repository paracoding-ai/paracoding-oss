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
- **Backups** are plain archives that include GitLab's `gitlab-secrets.json`; restrict the bucket.

Report vulnerabilities privately through GitHub Security Advisories on this repository.
