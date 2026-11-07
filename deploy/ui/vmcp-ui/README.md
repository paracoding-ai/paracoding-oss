# vmcp-ui — UI front (IAP router + status/start page)

The second of the two small Cloud Run routers. Protected by **IAP** (Google sign-in); no `allUsers`,
no public IP. It routes human traffic to the VM and shows a start page while the VM is off.

- **VM up:** reverse-proxies every request to the harness on the VM (`:8090`), `/gitlab*` to GitLab
  (`:80`). SSE-safe. The box serves everything; the UI front is just the pipe + the Picket edge
  (detection-only, pinned from `root/paracoding-security`).
- **VM down:** serves a small status/start page. Click **Start** → the VM boots → the page polls
  `/_ui/status` and reloads → the harness opens. `/_ui/stop` stops it (end of day = cheap + safe).
- **Auth:** IAP authenticates the human before Cloud Run is reached; the box also verifies the IAP
  assertion (`PC_IAP_AUD`). The UI front forwards the `x-goog-*` IAP headers to the box.
- **Own routes** (never proxied): `/healthz`, `/_ui/status`, `/_ui/start`, `/_ui/stop`.

Deploy: pipeline only (`deploy:ui`, reusable `.deploy-cloud-run`). Currently TEST mode
(`--no-invoker-iam-check`) to verify on run.app; cutover flips to `--iap` (RUN_IAP=on).

Replaces `vmcp-waker` (which gets torn down at cutover).
