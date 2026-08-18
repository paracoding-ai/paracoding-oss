#!/usr/bin/env bash
# bootstrap-sweep-runner.sh -- stand up fleet-sweep-runner (the stall sweeper).
# NO LLM key (pure Firestore). Least-privilege SA (datastore.user only). Digest-pinned image.
# ~5min Cloud Scheduler trigger (OIDC). Idempotent: describe-or-create throughout, safe to re-run.
#
# CONFIGURE WITH ENVIRONMENT VARIABLES OR ARGUMENT 1. PROJECT is REQUIRED and has no default:
#   PROJECT=my-project bash bootstrap-sweep-runner.sh
# Optional: REGION BUCKET REPO SVC SA SCHED_SA SCHED_JOB PC_LANE.
set -euo pipefail
PROJECT="${PROJECT:-${1:-}}"
[ -n "$PROJECT" ] || {
  echo "PROJECT is not set. Refusing to deploy: this script has no default project and will not" >&2
  echo "guess one -- a guessed project deploys a runner into somebody else's account." >&2
  echo "usage: PROJECT=<your-gcp-project> bash bootstrap-sweep-runner.sh   (or argument 1)" >&2
  exit 2; }
REGION="${REGION:-us-east1}"
PC_LANE="${PC_LANE:-}"
case "$PC_LANE" in
  "") PC_LP="" ;;
  -*|*-) echo "PC_LANE may not start or end with a hyphen: $PC_LANE" >&2; exit 2 ;;
  *[!a-z0-9-]*) echo "PC_LANE must be lowercase letters, digits and hyphens: $PC_LANE" >&2; exit 2 ;;
  *) PC_LP="${PC_LANE}-" ;;
esac
# Derived HERE, at bootstrap time, from the project you just named -- never guessed at runtime.
BUCKET="${BUCKET:-${PROJECT}-${PC_LP}datalake}"
REPO="${REPO:-${PC_LP}fleet-runners}"
SVC="${SVC:-${PC_LP}fleet-sweep-runner}"
SA="${SA:-${PC_LP}fleet-sweep-runner-sa}"
SCHED_SA="${SCHED_SA:-${PC_LP}fleet-sweep-sched-sa}"
SCHED_JOB="${SCHED_JOB:-${PC_LP}fleet-sweep-tick}"
gcloud config set project "$PROJECT" -q
SA_EMAIL="$SA@$PROJECT.iam.gserviceaccount.com"
SCHED_EMAIL="$SCHED_SA@$PROJECT.iam.gserviceaccount.com"

# 1. Artifact Registry repo (shared for fleet runner images)
gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --repository-format=docker --location "$REGION" -q

# 2. Pull sweeper source from the lake + build/push
WORK=$(mktemp -d); cd "$WORK"
gcloud storage cat "gs://$BUCKET/shared/runner/sweep_runner.py"  > sweep_runner.py
gcloud storage cat "gs://$BUCKET/shared/runner/Dockerfile.sweep" > Dockerfile
# fleet_mode.py is the ONE implementation of the mode switch that sweep_runner.py imports.
# Without it the service does not start, which is the correct direction: a runner that cannot read
# its own spend switch must not run.
gcloud storage cat "gs://$BUCKET/shared/runner/fleet_mode.py"    > fleet_mode.py
grep -q "FLEET_MODES" fleet_mode.py || { echo "STOP: fleet_mode.py missing"; exit 1; }
IMG="$REGION-docker.pkg.dev/$PROJECT/$REPO/$SVC"
gcloud builds submit --tag "$IMG:v1" -q
DIGEST=$(gcloud artifacts docker images describe "$IMG:v1" --format='value(image_summary.digest)')
echo "SWEEP-RUNNER IMAGE DIGEST: $DIGEST"
IMG_PINNED="$IMG@$DIGEST"

# 3. Least-privilege runtime SA (datastore only; NO LLM key, NOT owner, NOT deploy)
gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA" --display-name "fleet-sweep-runner (least-privilege, no LLM key)" -q
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA_EMAIL" --role roles/datastore.user -q >/dev/null

# 4. Deploy the Cloud Run service (digest-pinned, private, no secrets)
gcloud run deploy "$SVC" --image "$IMG_PINNED" --region "$REGION" \
  --service-account "$SA_EMAIL" --no-allow-unauthenticated \
  --set-env-vars "PROJECT=$PROJECT" \
  --cpu 1 --memory 512Mi --min-instances 0 --max-instances 1 --timeout 120 -q
URL=$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.url)')
echo "SERVICE URL: $URL"

# 5. Scheduler SA (invoke-only) + ~5min trigger (OIDC)
gcloud iam service-accounts describe "$SCHED_EMAIL" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SCHED_SA" --display-name "fleet-sweep scheduler (invoke only)" -q

# F18: PIN THE IN-PROCESS AUTH CONFIG. sweep_runner.py refuses EVERY request with 503 until
# SWEEP_AUDIENCE holds this service's URL, and its own comment says this script must set it --
# which it did not, so the deployed sweeper was dead on arrival. Both values are known only after
# the first deploy, hence this second update. SWEEP_INVOKERS is set explicitly rather than left to
# the runner's PROJECT-derived default, so renaming SCHED_SA above cannot silently empty the
# allowlist and lock the scheduler out.
gcloud run services update "$SVC" --region "$REGION" \
  --update-env-vars "SWEEP_AUDIENCE=$URL,SWEEP_INVOKERS=$SCHED_EMAIL" -q >/dev/null
gcloud run services add-iam-policy-binding "$SVC" --region "$REGION" \
  --member "serviceAccount:$SCHED_EMAIL" --role roles/run.invoker -q >/dev/null
gcloud scheduler jobs describe "$SCHED_JOB" --location "$REGION" >/dev/null 2>&1 \
  && gcloud scheduler jobs delete "$SCHED_JOB" --location "$REGION" -q || true
gcloud scheduler jobs create http "$SCHED_JOB" --location "$REGION" \
  --schedule "*/5 * * * *" --uri "$URL/" --http-method POST \
  --oidc-service-account-email "$SCHED_EMAIL" --oidc-token-audience "$URL" -q

echo "==== SWEEPER DEPLOYED ===="
echo "IMAGE DIGEST: $DIGEST"
echo "RUNTIME SA: $SA_EMAIL  ROLE: roles/datastore.user ONLY (no LLM key, no owner, no deploy)"
echo "SCHEDULER: $SCHED_JOB every 5 min (GCP Cloud Scheduler, invoke-only SA) — NOT a Max-plan task"
echo "AUTH PINNED: SWEEP_AUDIENCE=$URL  SWEEP_INVOKERS=$SCHED_EMAIL"
echo "SPEND IS OFF UNTIL YOU TURN IT ON: config/models.fleet_mode defaults to 'home', in which the"
echo "sweeper writes nothing -- every branch it takes manufactures paid work on some other bus."
