# shared/runner/deploy-work-runner.sh (owner: fleet-advisor / fleet-infra)

#!/usr/bin/env bash
# deploy-work-runner.sh — stand up THE RUNWAY: fleet-work-runner (Cloud Run) + 5-min Cloud Scheduler tick.
# Consumes work_items(status==pending) and does the work via a tool-using agent loop. Idle = free.
# DUAL-SUBSTRATE: Claude (keyless Vertex OR personal key) OR Gemini (keyless Vertex), driven by
# Firestore config/models (work_provider='gemini' -> gemini-3.1-pro on Vertex = billed to GCP, no key).
#
# CONFIGURE WITH ENVIRONMENT VARIABLES OR ARGUMENT 1. PROJECT is REQUIRED and has no default:
#   PROJECT=my-project bash deploy-work-runner.sh          # or: bash deploy-work-runner.sh my-project
# Optional: REGION BUCKET SVC SECRET PC_LANE SCHED_JOB WORK_MODEL VERTEX_LOCATION.
set -euo pipefail
PROJECT="${PROJECT:-${1:-}}"
[ -n "$PROJECT" ] || {
  echo "PROJECT is not set. Refusing to deploy: this script has no default project and will not" >&2
  echo "guess one -- a guessed project deploys a paid runner into somebody else's account." >&2
  echo "usage: PROJECT=<your-gcp-project> bash deploy-work-runner.sh   (or pass it as argument 1)" >&2
  exit 2; }
REGION="${REGION:-us-east1}"
# PC_LANE namespaces every resource so two lanes can share one project; empty (the default) makes
# every name below expand to exactly what it expanded to before this variable existed.
PC_LANE="${PC_LANE:-}"
case "$PC_LANE" in
  "") PC_LP="" ;;
  -*|*-) echo "PC_LANE may not start or end with a hyphen: $PC_LANE" >&2; exit 2 ;;
  *[!a-z0-9-]*) echo "PC_LANE must be lowercase letters, digits and hyphens: $PC_LANE" >&2; exit 2 ;;
  *) PC_LP="${PC_LANE}-" ;;
esac
# The lake name is derived HERE, at deploy time, from the project you just named -- which is a
# different thing from deriving it at RUNTIME. A re-run adopts the same bucket instead of making
# a second lake, and the value is written onto the service explicitly, so the runner itself never
# has to guess (work_item_runner.py refuses to start without BUCKET). Same rule as install.sh.
BUCKET="${BUCKET:-${PROJECT}-${PC_LP}datalake}"
SVC="${SVC:-${PC_LP}fleet-work-runner}"
SECRET="${SECRET:-chat-key-claude}"
SCHED_JOB="${SCHED_JOB:-${PC_LP}fleet-work-runner-tick}"
WORK_MODEL="${WORK_MODEL:-claude-opus-5}"
VERTEX_LOCATION="${VERTEX_LOCATION:-us-east5}"
gcloud config set project "$PROJECT" -q 2>/dev/null || true
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com firestore.googleapis.com aiplatform.googleapis.com --project "$PROJECT" -q

BUILD=/tmp/work-runner; rm -rf "$BUILD"; mkdir -p "$BUILD"
gcloud storage cat "gs://$BUCKET/shared/runner/work_item_runner.py" > "$BUILD/main.py"
grep -q "fleet-work-runner" "$BUILD/main.py" || { echo "STOP: runner source missing"; exit 1; }
# fleet_mode.py is the ONE implementation of the mode switch that main.py imports. Without it the
# service does not start, which is the correct direction: a runner that cannot read its own spend
# switch must not run.
gcloud storage cat "gs://$BUCKET/shared/runner/fleet_mode.py" > "$BUILD/fleet_mode.py"
grep -q "FLEET_MODES" "$BUILD/fleet_mode.py" || { echo "STOP: fleet_mode.py missing"; exit 1; }
cat > "$BUILD/requirements.txt" <<'REQ'
flask
gunicorn
google-cloud-firestore
google-cloud-storage
anthropic[vertex]
google-genai
REQ
cat > "$BUILD/Procfile" <<'PROC'
web: gunicorn -b :$PORT --workers 1 --threads 1 --timeout 900 --graceful-timeout 60 main:app
PROC

PN=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA="${PN}-compute@developer.gserviceaccount.com"

# keyless Vertex needs the runtime SA to call the Anthropic AND Gemini publisher models
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role=roles/aiplatform.user -q >/dev/null 2>&1 || true

# Claude key secret is OPTIONAL. Mount it only if it exists (personal-key mode); Vertex modes ignore it.
SECRET_FLAG=()
if gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  SECRET_FLAG=(--set-secrets "ANTHROPIC_API_KEY=$SECRET:latest")
  echo "$SECRET present -> mounting (key mode available in fleet_mode 'dual' ONLY; 'work' refuses it)."
else
  echo "$SECRET absent -> deploying keyless (Vertex modes only)."
fi

gcloud run deploy "$SVC" --source "$BUILD" --region "$REGION" --project "$PROJECT" \
  --no-allow-unauthenticated \
  --set-env-vars "PROJECT=$PROJECT,BUCKET=$BUCKET,WORK_MODEL=$WORK_MODEL,VERTEX_LOCATION=$VERTEX_LOCATION,MAX_TURNS=24,MAX_TOKENS=4096,WORK_BATCH=4,WORK_BUDGET_SEC=240" \
  "${SECRET_FLAG[@]}" \
  --memory 1Gi --cpu 1 --timeout 900 --max-instances 2 --concurrency 1 --quiet

URL=$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.url)')
gcloud run services add-iam-policy-binding "$SVC" --region "$REGION" --member="serviceAccount:$SA" --role=roles/run.invoker -q >/dev/null 2>&1 || true

if gcloud scheduler jobs describe "$SCHED_JOB" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$SCHED_JOB" --location "$REGION" --project "$PROJECT" \
    --schedule="*/5 * * * *" --uri="$URL" --http-method=POST --oidc-service-account-email="$SA" --oidc-token-audience="$URL" -q
else
  gcloud scheduler jobs create http "$SCHED_JOB" --location "$REGION" --project "$PROJECT" \
    --schedule="*/5 * * * *" --uri="$URL" --http-method=POST --oidc-service-account-email="$SA" --oidc-token-audience="$URL" -q
fi
echo "DONE. RUNWAY LIVE: $SVC = $URL  (scheduler $SCHED_JOB every 5 min). Dual-substrate: flip config/models.work_provider to switch Claude<->Gemini."
echo "SPEND IS OFF UNTIL YOU TURN IT ON: config/models.fleet_mode defaults to 'home' (no bus)."
