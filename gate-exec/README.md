# gate-exec -- the gated execution engine

Runs jobs a human approved at the Autoclave. NEVER committed until 2026-08-01; it lived only
in the data lake at shared/gate-exec/. That is how CRIT-2 (deferred RCE via a writable exec
prefix) and the cmd-shaped-job 403 brick both reached production bytes no diff ever showed.

POST /run {job_id, access_token, script_b64}
 1 load pending_confirms/{job_id}; refuse unless status is confirmed or executing
 2 read the approved command as arguments.command || arguments.cmd -- IDENTICAL precedence to
   waJobCommand() in the control plane. They drifted once and every cmd-shaped job 403d.
 3 if script_b64 was presented, sha256-compare it to the approved command; refuse on mismatch
 4 [EXEC-BIN-JAIL-V82] PATH JAIL: the child runs with PATH restricted to symlinks of an
   enumerated binary set, so an unlisted binary does not resolve. Builtins/keywords do not
   use PATH, so `set -uo pipefail` -- which broke production when the old first-token text
   scan was armed -- cannot be affected. That scan survives as telemetry only and its
   EXEC_BINARY_ALLOWLIST_ENFORCE switch is DELETED. Gap: absolute paths still run.
   Disable with EXEC_BIN_JAIL=0.
 5 bound the AGE of a confirmed approval (EXEC_APPROVAL_MAX_AGE_SECONDS, default 3600)
 6 consume the approval atomically (exec_claim_id) BEFORE running anything: one approval =
   one run, and a crash mid-run cannot leave it spendable
 7 run as the approver via CLOUDSDK_AUTH_ACCESS_TOKEN, keep the last 8KB of stdout/stderr,
   write the result back, journal completion
GET /healthz -> ok

OPEN DEFECT, recorded next to the code instead of in a lake note nobody reads: the sha-pin in
step 3 compares arguments.command RE-READ FROM FIRESTORE AT EXECUTION TIME, not a digest taken
when the human approved. fleet-gate-exec-sa holds project-level roles/datastore.user, so
anything able to write the job document moves BOTH sides together and the pin still passes.
Fix = approval-time approved_sha256 with a fallback for older documents. WRITER (control
plane) FIRST, ENFORCEMENT SECOND, and the enforcement MUST fall back: an enforcement-only
landing 403s every gated job forever, including its own undo.

A SECOND PATH REACHES THIS SERVICE AND MUST NOT: waLegacyApply and the legacy REST
/api/confirm/verify write status confirmed and then either execute nothing or POST /run with
no Authorization header, which our own edge drops. A human tap spent there is marked refused
and the job never runs. See the gate-loop work item.

DEPLOY: gcloud run deploy fleet-gate-exec --source gate-exec --region us-east1 --no-allow-unauthenticated
