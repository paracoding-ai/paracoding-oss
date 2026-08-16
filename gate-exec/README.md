# gate-exec — the gated execution engine

A private Cloud Run service. It runs a job only after a human approved that exact job in the
console, and it verifies that approval itself rather than trusting the caller.

    POST /run {job_id, access_token, script_b64}
    GET  /healthz -> ok

What `/run` does, in order:

1. Load `pending_confirms/{job_id}`. Refuse unless the status is `confirmed` or `executing`.
2. Read the approved command as `arguments.command || arguments.cmd` — identical precedence to
   `waJobCommand()` in the control plane, so the two cannot disagree about what was approved.
3. **Verify the approval signature.** The control plane signs the approval with a Cloud KMS
   asymmetric key over a length-prefixed canonical message (`PC-APPROVAL-CANON-V2`, nine
   fields: algorithm, job id, command digest, command type, argument digest, key version,
   approver, issued-at, expiry). This service holds only the public half — it can verify a
   signature without being able to produce one. `approved_sha256` remains on the document and
   is checked, but with a signature present it is a duplicate of a value the signature already
   pins, so a writer with database access can no longer move both sides together.
4. If `script_b64` was presented, SHA-256 compare it to the approved command and refuse on
   mismatch.
5. **PATH jail.** The child runs with `PATH` restricted to a directory of symlinks to an
   enumerated binary set, so an unlisted binary does not resolve. Shell builtins and keywords
   do not consult `PATH`, so `set -uo pipefail` and friends are unaffected — the earlier
   first-token text scan survives as telemetry only and its enforcement switch is deleted. The
   jail narrows what an approved script can reach for; what authorises the script in the first
   place is step 3. Set `EXEC_BIN_JAIL=0` if an install needs a binary that is not on the list.
6. Bound the age of the approval (`EXEC_APPROVAL_MAX_AGE_SECONDS`, default 3600), read from the
   signed `approval_sig_iat` rather than from an unsigned timestamp.
7. Consume the approval atomically (`exec_claim_id`) **before** running anything: one approval
   is one run, and a crash mid-run cannot leave it spendable.
8. Run as the approver via `CLOUDSDK_AUTH_ACCESS_TOKEN`, keep the last 8KB of stdout and
   stderr, write the result back, and journal completion.

An approve that arrives with no Google access token cannot execute, and the control plane
refuses it with `412 google_not_connected` **before** touching the job — nothing written,
nothing consumed, the queue unchanged. Reconnect Google and approve once.

Deploy:

    gcloud run deploy fleet-gate-exec --source gate-exec --region us-east1 --no-allow-unauthenticated
