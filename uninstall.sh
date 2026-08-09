#!/usr/bin/env bash
# Paracoding uninstaller.
# [SEC-UNINSTALL-NUKE-V1] Default is a FULL teardown of everything THIS VERSION installs,
# Firestore included -- and that is the whole of what it can promise. It deletes by exact
# name, so it can never take something that is not ours, and equally it cannot clean up an
# older install's leftovers. It says so, out loud, after it has looked: see
# [SEC-UNINSTALL-TRUTH-V1] at the end of this file.
# install.sh creates the Firestore database (step 2/10), so a reinstall rebuilds it from
# nothing. Pass --keep-data to preserve approvals, journal, memory and passkeys.
set -u
PROJECT=""; REGION="us-east1"; KEEP=0
for a in "$@"; do
  case "$a" in
    --keep-data) KEEP=1 ;;
    -*) echo "unknown flag: $a"; exit 2 ;;
    *) if [ -z "$PROJECT" ]; then PROJECT="$a"; else REGION="$a"; fi ;;
  esac
done
[ -n "$PROJECT" ] || { echo "usage: ./uninstall.sh PROJECT_ID [REGION] [--keep-data]"; exit 2; }
echo "Tearing down paracoding in $PROJECT ($REGION)."
if [ "$KEEP" -eq 1 ]; then echo "  --keep-data: Firestore will be PRESERVED."
else echo "  FULL WIPE: the Firestore database goes too -- approvals, journal, memory, passkeys."; fi
for s in paracoding-control-plane paracoding-gate-exec; do
  gcloud run services delete "$s" --region "$REGION" --project "$PROJECT" --quiet 2>/dev/null
done
for s in pc-session-secret pc-human-confirm-secret pc-approval-mac-key pc-bootstrap-secret pc-webauthn-creds; do
  gcloud secrets delete "$s" --project "$PROJECT" --quiet 2>/dev/null
done
for a in pc-control-plane pc-gate-exec; do
  gcloud iam service-accounts delete "${a}@${PROJECT}.iam.gserviceaccount.com" --project "$PROJECT" --quiet 2>/dev/null
done
gcloud artifacts repositories delete cloud-run-source-deploy --location="$REGION" --project "$PROJECT" --quiet 2>/dev/null
gcloud storage rm -r "gs://run-sources-${PROJECT}-${REGION}" --quiet 2>/dev/null
gcloud storage rm -r "gs://${PROJECT}_cloudbuild" --quiet 2>/dev/null
if [ "$KEEP" -eq 0 ]; then
  # [SEC-NAMED-DB-V1] Only ever delete databases WE created (pc-*). The (default) database
  # may hold the operator's own data and is never ours to remove.
  for d in $(gcloud firestore databases list --project "$PROJECT" --format="value(name)" 2>/dev/null | sed "s#.*/##" | grep "^paracoding-"); do
    if gcloud firestore databases delete --database="$d" --project "$PROJECT" --quiet 2>/dev/null; then
      echo "  Firestore database deleted: $d"
    else
      echo "  WARNING: could not delete $d. Check delete protection, then rerun."
    fi
  done
else
  echo "  Firestore data was PRESERVED (--keep-data)."
fi

# [SEC-UNINSTALL-TRUTH-V1] LOOK BEFORE YOU SPEAK.
# This script used to end with an unconditional `echo "done. Nothing left behind."`. That
# was a claim, not a measurement, and it was measured false: a run against a project
# carrying a v2-era install left Cloud Run services paracoding-mcp and iap-test and a
# service account pc-exec-test@ standing, because this script only ever deletes the exact
# resources THIS version creates, by name. That deletion behaviour is right and is
# unchanged. The SENTENCE was the defect: an uninstaller that overstates its cleanup is
# how a stale artifact breaks an install months later.
#
# Every delete above is `--quiet 2>/dev/null` with no status check, so a wrong --region or
# a missing permission makes it a silent no-op. The scan below therefore separates four
# things it can actually tell apart, and refuses to guess between them:
#
#   OURS       an exact name THIS version creates, still present -> our own delete did not
#              work. Almost always the wrong --region, or a missing permission.
#   PRESERVED  a paracoding-* Firestore database you asked us to keep (--keep-data).
#   OLDER      matches this product's naming but is NOT a name this version creates.
#   UNCHECKED  the check itself failed (API disabled, PERMISSION_DENIED, no network).
#
# Telling an operator that his live control plane is stale debris he should delete by hand
# is the same defect as "Nothing left behind", pointed the other way -- and it is the
# direction that destroys a running install. So a class that could not be checked is never
# reported as clean, and a name we tried to delete is never reported as somebody else's.
PC_OURS=""; PC_KEPT=""; PC_OLDER=""; PC_BLIND=""
pc_ours()  { PC_OURS="${PC_OURS}      $1
"; }
pc_kept()  { PC_KEPT="${PC_KEPT}      $1
"; }
pc_older() { PC_OLDER="${PC_OLDER}      $1
"; }
pc_blind() { PC_BLIND="${PC_BLIND}      $1
"; }
# has LIST NAME -- exact whole-line match, no regex metacharacters interpreted.
pc_has() { printf '%s\n' "$1" | grep -Fqx "$2"; }

echo
echo "Now looking at $PROJECT to see what is actually still standing."

# Cloud Run services. Listed across ALL regions on purpose: the commonest reason a delete
# above did nothing is that the install went to a region other than $REGION.
PC_L=$(gcloud run services list --project "$PROJECT" --format='value(metadata.name)' 2>/dev/null); PC_RC=$?
if [ $PC_RC -ne 0 ]; then
  pc_blind "Cloud Run services -- 'gcloud run services list' exited $PC_RC"
else
  for s in paracoding-control-plane paracoding-gate-exec; do
    pc_has "$PC_L" "$s" && pc_ours "Cloud Run service $s"
  done
  for s in $(printf '%s\n' "$PC_L" | grep -E '^(paracoding|pc)-' | grep -Fvx paracoding-control-plane | grep -Fvx paracoding-gate-exec); do
    pc_older "Cloud Run service $s"
  done
fi

# Service accounts. Only ones in THIS project; Google-managed agents live elsewhere.
PC_L=$(gcloud iam service-accounts list --project "$PROJECT" --format='value(email)' 2>/dev/null); PC_RC=$?
if [ $PC_RC -ne 0 ]; then
  pc_blind "service accounts -- 'gcloud iam service-accounts list' exited $PC_RC"
else
  PC_L=$(printf '%s\n' "$PC_L" | grep -F "@${PROJECT}.iam.gserviceaccount.com")
  for a in pc-control-plane pc-gate-exec; do
    pc_has "$PC_L" "${a}@${PROJECT}.iam.gserviceaccount.com" && pc_ours "service account ${a}@${PROJECT}.iam.gserviceaccount.com"
  done
  for a in $(printf '%s\n' "$PC_L" | grep -E '^(paracoding|pc)-' | grep -Fvx "pc-control-plane@${PROJECT}.iam.gserviceaccount.com" | grep -Fvx "pc-gate-exec@${PROJECT}.iam.gserviceaccount.com"); do
    pc_older "service account $a"
  done
fi

# Secrets. Note the two-step: `... | sed` would make $? the exit status of sed, not gcloud,
# and a failed list would then read as an empty project. That is the bug being fixed.
PC_L=$(gcloud secrets list --project "$PROJECT" --format='value(name)' 2>/dev/null); PC_RC=$?
if [ $PC_RC -ne 0 ]; then
  pc_blind "secrets -- 'gcloud secrets list' exited $PC_RC"
else
  PC_L=$(printf '%s\n' "$PC_L" | sed 's#.*/##')
  PC_KNOWN="pc-session-secret pc-human-confirm-secret pc-approval-mac-key pc-bootstrap-secret pc-webauthn-creds"
  for s in $PC_KNOWN; do
    pc_has "$PC_L" "$s" && pc_ours "secret $s"
  done
  for s in $(printf '%s\n' "$PC_L" | grep -E '^(paracoding|pc)-'); do
    case " $PC_KNOWN " in *" $s "*) : ;; *) pc_older "secret $s" ;; esac
  done
fi

# Firestore. Same rule as [SEC-NAMED-DB-V1] above -- ^paracoding- only, never (default).
# On --keep-data these are PRESERVED BY REQUEST, not leftovers, and saying otherwise in
# the same breath as "Firestore data was PRESERVED" would be a self-contradicting run.
PC_L=$(gcloud firestore databases list --project "$PROJECT" --format='value(name)' 2>/dev/null); PC_RC=$?
if [ $PC_RC -ne 0 ]; then
  pc_blind "Firestore databases -- 'gcloud firestore databases list' exited $PC_RC"
else
  for d in $(printf '%s\n' "$PC_L" | sed 's#.*/##' | grep '^paracoding-'); do
    if [ "$KEEP" -eq 1 ]; then pc_kept "Firestore database $d"; else pc_ours "Firestore database $d"; fi
  done
fi

# The build staging bucket and the Artifact Registry repo. These are checked by NAME
# rather than by prefix: they are named after the PROJECT and after Cloud Run's own
# convention, so no prefix rule can find them, and a scan that cannot see them has no
# business saying "nothing remains". A describe that fails is ambiguous between "absent"
# and "may not look", so the two are told apart by the message, not by the exit status.
for b in "run-sources-${PROJECT}-${REGION}" "${PROJECT}_cloudbuild"; do
  PC_O=$(gcloud storage buckets describe "gs://$b" --format='value(name)' 2>&1); PC_RC=$?
  if [ $PC_RC -eq 0 ]; then pc_ours "bucket gs://$b (build staging; 'storage rm -r' fails if objects remain)"
  elif printf '%s' "$PC_O" | grep -qiE 'not found|404|NOT_FOUND|does not exist'; then :
  else pc_blind "bucket gs://$b -- describe exited $PC_RC"; fi
done
PC_O=$(gcloud artifacts repositories describe cloud-run-source-deploy --location="$REGION" --project "$PROJECT" --format='value(name)' 2>&1); PC_RC=$?
if [ $PC_RC -eq 0 ]; then pc_ours "Artifact Registry repo cloud-run-source-deploy in $REGION (also holds images from any of your OWN 'gcloud run deploy' runs)"
elif printf '%s' "$PC_O" | grep -qiE 'not found|404|NOT_FOUND|does not exist'; then :
else pc_blind "Artifact Registry repo cloud-run-source-deploy in $REGION -- describe exited $PC_RC"; fi

# ---- report. Order matters: the worst thing first, "done" last and only once.
if [ -n "$PC_OURS" ]; then
  echo
  echo "  STILL PRESENT, AND OURS -- our own delete did not take effect:"
  printf '%s' "$PC_OURS"
  echo "  These are the exact names this script tries to delete, twenty lines above. It did
  not check whether those deletes worked, so it cannot tell you why. The two causes, in
  order of likelihood:
    1. WRONG REGION. You ran with region '$REGION'. If you installed somewhere else,
       nothing was deleted at all. Re-run: ./uninstall.sh $PROJECT <the-region-you-used>
    2. You lack run.services.delete / secretmanager.secrets.delete / iam.serviceAccounts
       .delete on $PROJECT, or a bucket still has objects in it.
  DO NOT hand-delete these until you know which. They may be a live install."
fi
if [ -n "$PC_KEPT" ]; then
  echo
  echo "  PRESERVED BY REQUEST (--keep-data), not left behind by accident:"
  printf '%s' "$PC_KEPT"
  echo "  Re-run without --keep-data to remove them."
fi
if [ -n "$PC_OLDER" ]; then
  echo
  echo "  NOT REMOVED, AND NOT OURS TO REMOVE:"
  printf '%s' "$PC_OLDER"
  echo "  These carry this product's naming but are NOT names this version creates, so they
  are most likely from an older install. This uninstaller deletes only by exact name,
  which is what stops it from ever taking something of yours -- and is also why it will
  not touch these. Note that 'pc-' is a short prefix: if any of the above is your own
  work, it is your own work, and this script is guessing. Check what uses them, then
  delete them yourself. A stale service or service account is exactly what makes an
  install fail months from now for reasons nobody can trace."
fi
if [ -n "$PC_BLIND" ]; then
  echo
  echo "  COULD NOT CHECK -- these classes were NOT verified:"
  printf '%s' "$PC_BLIND"
  echo "  Usually the API is disabled on $PROJECT, or this account cannot list. Whatever is
  in those classes, this script did not see it, and it will not pretend otherwise."
fi
if [ -z "$PC_OURS$PC_KEPT$PC_OLDER$PC_BLIND" ]; then
  echo "  nothing. Cloud Run, service accounts, secrets, Firestore, the build staging
  buckets and the Artifact Registry repo were all listed successfully and none of them
  hold anything matching paracoding-* or pc-*."
  echo "done -- and that last line is a measurement, not a promise."
else
  echo
  echo "done. Read the sections above before you call this project clean."
fi
echo "Anything in $PROJECT that does not match paracoding-* or pc-* was never inspected and
never touched. It may well be your own, and this script will not claim it."
