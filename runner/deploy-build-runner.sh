#!/usr/bin/env bash
# deploy-build-runner.sh — stand up THE BUILD WINDOW runner: fleet-build-runner (Cloud Run) + 1-min tick.
# While build_window/current is open, it auto-runs fleet-infra's staged build jobs via the gate-exec
# as-you path (using the operator's live ops token). One-time infra; after this, iteration is
# one-tap-per-session.
#
# CONFIGURE WITH ENVIRONMENT VARIABLES OR ARGUMENT 1. PROJECT is REQUIRED and has no default:
#   PROJECT=my-project bash deploy-build-runner.sh
# Optional: REGION BUCKET SVC GATE_EXEC_SVC SCHED_JOB PC_LANE.
# ALLOW_TARGETS is optional too, but it is NOT a tuning knob: it is the unattended-execution grant.
# Leaving it unset is the safe, working default -- see [SEC-UNATTENDED-ALLOWLIST-V1] below.
set -euo pipefail
PROJECT="${PROJECT:-${1:-}}"
[ -n "$PROJECT" ] || {
  echo "PROJECT is not set. Refusing to deploy: this script has no default project and will not" >&2
  echo "guess one -- a guessed project deploys an UNATTENDED job executor into somebody else's" >&2
  echo "account. usage: PROJECT=<your-gcp-project> bash deploy-build-runner.sh   (or argument 1)" >&2
  exit 2; }
REGION="${REGION:-us-east1}"
PC_LANE="${PC_LANE:-}"
case "$PC_LANE" in
  "") PC_LP="" ;;
  -*|*-) echo "PC_LANE may not start or end with a hyphen: $PC_LANE" >&2; exit 2 ;;
  *[!a-z0-9-]*) echo "PC_LANE must be lowercase letters, digits and hyphens: $PC_LANE" >&2; exit 2 ;;
  *) PC_LP="${PC_LANE}-" ;;
esac
# Derived HERE, at deploy time, from the project you just named -- never guessed at runtime.
BUCKET="${BUCKET:-${PROJECT}-${PC_LP}datalake}"
SVC="${SVC:-${PC_LP}fleet-build-runner}"
GATE_EXEC_SVC="${GATE_EXEC_SVC:-${PC_LP}fleet-gate-exec}"
SCHED_JOB="${SCHED_JOB:-${PC_LP}fleet-build-runner-tick}"
# The targets an unattended build-window job may address. deploy_runner.py has NO default for
# this: an allowlist that ships pre-populated with one deployment's node names is both useless to
# an adopter and, if their names happen to collide, an unattended execution grant they never gave.
#
# [SEC-UNATTENDED-ALLOWLIST-V1] AND UNTIL THIS COMMIT THE NEXT LINE SUPPLIED ONE ANYWAY. The three
# lines above are the runner's contract, quoted correctly, and the assignment beneath them defaulted
# ALLOW_TARGETS to five node names and passed them into --set-env-vars. deploy_runner.py reads
# os.environ.get("ALLOW_TARGETS", "") precisely so that UNSET means the empty set and the empty set
# runs nothing -- fail closed -- and that fail-closed default could never engage, because this
# script always set the variable. The fix was made in the runner and undone one file over, which is
# worse than never making it: the runner now documents a guarantee that its own deployer removes.
#
# NO DEFAULT. Unset is a LEGAL and USEFUL state here -- unlike PROJECT above, which refuses --
# because deploy_runner.py treats the empty set as "untargeted deploys only" and says so on boot.
# Someone who wants the wider grant states it, and stating it is the point: this service runs the
# named job with NO human approval and writes human_approved: False on the record afterwards. A
# grant that arrives by default is not a grant anybody made.
ALLOW_TARGETS="${ALLOW_TARGETS:-}"
gcloud config set project "$PROJECT" -q
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com firestore.googleapis.com --project "$PROJECT" -q
GATE_EXEC_URL=$(gcloud run services describe "$GATE_EXEC_SVC" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)
[ -z "$GATE_EXEC_URL" ] && { echo "STOP: $GATE_EXEC_SVC not found (build window needs the executor)"; exit 1; }

BUILD=/tmp/build-runner; rm -rf "$BUILD"; mkdir -p "$BUILD"
gcloud storage cat "gs://$BUCKET/shared/runner/deploy_runner.py" > "$BUILD/main.py"
grep -q "THE BUILD WINDOW" "$BUILD/main.py" || { echo "STOP: runner source missing"; exit 1; }
cat > "$BUILD/requirements.txt" <<'REQ'
flask
gunicorn
google-cloud-firestore
REQ
cat > "$BUILD/Procfile" <<'PROC'
web: gunicorn -b :$PORT --timeout 900 --workers 1 main:app
PROC

PN=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA="${PN}-compute@developer.gserviceaccount.com"
# AN ABSENT GRANT IS AN ABSENT VARIABLE, not a variable set to nothing. Two reasons, and the
# second is the load-bearing one:
#   - deploy_runner.py reads os.environ.get("ALLOW_TARGETS", ""), so absent and empty are the
#     same to it. Omitting is exactly equivalent and says what is meant.
#   - --set-env-vars REPLACES the whole env, so omitting the key here is also how a previously
#     granted allowlist is WITHDRAWN by re-running with ALLOW_TARGETS unset. Leaving a trailing
#     "ALLOW_TARGETS=" in the ^;^ list to mean the same thing depends on gcloud accepting an
#     empty value in a delimited dict argument, and that is exactly the kind of assumption that
#     fails on one gcloud version and takes the safe default down with it -- the empty case is
#     now the DEFAULT case, so it is the one that must not be fragile.
# Written as an `if` and not as `[ -n "$X" ] && ENVS=...`. Under `set -e` an AND-OR list whose
# test fails has a non-zero status, and whether that ends the script is a question about the
# shell rather than about this program. The empty branch is the DEFAULT branch now, so it is the
# one that must not depend on the answer.
ENVS="PROJECT=$PROJECT;GATE_EXEC_URL=$GATE_EXEC_URL"
if [ -n "$ALLOW_TARGETS" ]; then ENVS="$ENVS;ALLOW_TARGETS=$ALLOW_TARGETS"; fi
gcloud run deploy "$SVC" --source "$BUILD" --region "$REGION" --no-allow-unauthenticated \
  --set-env-vars "^;^$ENVS" \
  --memory 512Mi --cpu 1 --timeout 900 --max-instances 1 --concurrency 1 --quiet

URL=$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.url)')
# runner SA must invoke gate-exec (runs jobs AS the operator via forwarded token) and itself (scheduler)
gcloud run services add-iam-policy-binding "$GATE_EXEC_SVC" --region "$REGION" --member="serviceAccount:$SA" --role=roles/run.invoker -q >/dev/null 2>&1 || true
gcloud run services add-iam-policy-binding "$SVC" --region "$REGION" --member="serviceAccount:$SA" --role=roles/run.invoker -q >/dev/null 2>&1 || true

if gcloud scheduler jobs describe "$SCHED_JOB" --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$SCHED_JOB" --location "$REGION" --schedule="* * * * *" --uri="$URL" --http-method=POST --oidc-service-account-email="$SA" --oidc-token-audience="$URL" -q
else
  gcloud scheduler jobs create http "$SCHED_JOB" --location "$REGION" --schedule="* * * * *" --uri="$URL" --http-method=POST --oidc-service-account-email="$SA" --oidc-token-audience="$URL" -q
fi
echo "DONE. BUILD RUNNER live: $SVC = $URL  (ticks every 1 min; acts ONLY while build_window is open)"
# Print what was actually granted, and print the EMPTY case as a sentence rather than as a blank
# line after a colon. "UNATTENDED TARGET ALLOWLIST: " with nothing after it reads as output that
# got cut off; it is in fact the safest possible outcome and should read that way.
if [ -n "$ALLOW_TARGETS" ]; then
  echo "UNATTENDED TARGET ALLOWLIST: $ALLOW_TARGETS"
  echo "  Jobs staged by fleet-infra against those targets will run with NO human approval while"
  echo "  the build window is open. Re-run with ALLOW_TARGETS= to withdraw the grant."
else
  echo "UNATTENDED TARGET ALLOWLIST: EMPTY -- only UNTARGETED deploys can auto-run."
  echo "  Nothing with an explicit targetNode will run unattended. To widen it deliberately:"
  echo "  ALLOW_TARGETS=node-a,node-b PROJECT=$PROJECT bash deploy-build-runner.sh"
fi
