#!/usr/bin/env bash
# bootstrap-answer-runner.sh -- stand up fleet-answer-runner.
# LAST old-way action for this worker: owner-gcloud builds + deploys it ONCE; after
# that it wakes itself on the schedule. Least-privilege SA (Firestore + secret only,
# NOT owner, NOT deploy). Digest-pinned image. ~2min Cloud Scheduler trigger (OIDC).
#
# CONFIGURE WITH ENVIRONMENT VARIABLES OR ARGUMENT 1. PROJECT is REQUIRED and has no default:
#   PROJECT=my-project bash bootstrap-answer-runner.sh
# Run from the lake once your lake exists (substitute YOUR bucket, in both places):
#   PROJECT=my-project; gcloud storage cat "gs://${PROJECT}-datalake/shared/runner/bootstrap-answer-runner.sh" | tr -d '\r' | PROJECT="$PROJECT" BUCKET="<your-datalake-bucket>" bash
# REQUIRED: PROJECT and BUCKET. Optional: REGION REPO SVC SA SCHED_SA SECRET SCHED_JOB PC_LANE DEFAULT_MODEL HARD_MODEL.
set -euo pipefail
PROJECT="${PROJECT:-${1:-}}"
[ -n "$PROJECT" ] || {
  echo "PROJECT is not set. Refusing to deploy: this script has no default project and will not" >&2
  echo "guess one -- a guessed project deploys a paid runner into somebody else's account." >&2
  echo "usage: PROJECT=<your-gcp-project> bash bootstrap-answer-runner.sh   (or argument 1)" >&2
  exit 2; }
REGION="${REGION:-us-east1}"
PC_LANE="${PC_LANE:-}"
case "$PC_LANE" in
  "") PC_LP="" ;;
  -*|*-) echo "PC_LANE may not start or end with a hyphen: $PC_LANE" >&2; exit 2 ;;
  *[!a-z0-9-]*) echo "PC_LANE must be lowercase letters, digits and hyphens: $PC_LANE" >&2; exit 2 ;;
  *) PC_LP="${PC_LANE}-" ;;
esac
# [SEC-INSTALL-TOKEN-V1] BUCKET is REQUIRED and is no longer defaulted from the project
# name. The installer names lane buckets with a per-install random token as an INFIX
# (<project>-<lane>-<hex6>-datalake), so a convention-derived default composes a name a
# tokenized install does not own -- and in a shared project the convention name can belong
# to a DIFFERENT install, which is worse than failing. The installer records the token as
# the pc-suffix label on its marker secret; read it there, or copy the bucket name off the
# install output, and STATE it.
BUCKET="${BUCKET:-}"
[ -n "$BUCKET" ] || {
  echo "BUCKET is not set. Refusing to guess: lane bucket names carry a per-install random" >&2
  echo "token, and a guessed convention name in a shared project can read ANOTHER install's" >&2
  echo "lake. Name the data lake bucket your installer actually created:" >&2
  echo "usage: PROJECT=<project> BUCKET=<your-datalake-bucket> bash bootstrap-answer-runner.sh" >&2
  exit 2; }
REPO="${REPO:-${PC_LP}fleet-runners}"
SVC="${SVC:-${PC_LP}fleet-answer-runner}"
SA="${SA:-${PC_LP}fleet-answer-runner-sa}"
SCHED_SA="${SCHED_SA:-${PC_LP}fleet-answer-sched-sa}"
SECRET="${SECRET:-anthropic-api-key}"
SCHED_JOB="${SCHED_JOB:-${PC_LP}fleet-answer-tick}"
DEFAULT_MODEL="${DEFAULT_MODEL:-claude-haiku-4-5-20251001}"
HARD_MODEL="${HARD_MODEL:-claude-opus-5}"
gcloud config set project "$PROJECT" -q
PNUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA_EMAIL="$SA@$PROJECT.iam.gserviceaccount.com"
SCHED_EMAIL="$SCHED_SA@$PROJECT.iam.gserviceaccount.com"

# 1. Artifact Registry repo (shared for fleet runner images)
gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --repository-format=docker --location "$REGION" -q

# 2. Pull runner source from the lake + build/push
WORK=$(mktemp -d); cd "$WORK"
gcloud storage cat "gs://$BUCKET/shared/runner/answer_runner.py"    > answer_runner.py
gcloud storage cat "gs://$BUCKET/shared/runner/Dockerfile.answer"   > Dockerfile
# fleet_mode.py is the ONE implementation of the mode switch that answer_runner.py imports.
# Without it the service does not start, which is the correct direction: a runner that cannot read
# its own spend switch must not run.
gcloud storage cat "gs://$BUCKET/shared/runner/fleet_mode.py"       > fleet_mode.py
grep -q "FLEET_MODES" fleet_mode.py || { echo "STOP: fleet_mode.py missing"; exit 1; }
IMG="$REGION-docker.pkg.dev/$PROJECT/$REPO/$SVC"
gcloud builds submit --tag "$IMG:v1" -q
DIGEST=$(gcloud artifacts docker images describe "$IMG:v1" --format='value(image_summary.digest)')
echo "ANSWER-RUNNER IMAGE DIGEST: $DIGEST"
IMG_PINNED="$IMG@$DIGEST"

# 3. Least-privilege runtime SA (NOT owner, NOT deploy perms)
gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA" --display-name "fleet-answer-runner (least-privilege)" -q
#   datastore.user = read/write agent_messages + read brain collections + write journal
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA_EMAIL" --role roles/datastore.user -q >/dev/null
#   secretAccessor scoped to ONLY the model key
gcloud secrets add-iam-policy-binding "$SECRET" --member "serviceAccount:$SA_EMAIL" --role roles/secretmanager.secretAccessor -q >/dev/null

# 4. Deploy the Cloud Run service (digest-pinned, private, model key via Secret Manager)
gcloud run deploy "$SVC" --image "$IMG_PINNED" --region "$REGION" \
  --service-account "$SA_EMAIL" --no-allow-unauthenticated \
  --set-env-vars "PROJECT=$PROJECT,DEFAULT_MODEL=$DEFAULT_MODEL,HARD_MODEL=$HARD_MODEL,MAX_PER_RUN=5" \
  --set-secrets "ANTHROPIC_API_KEY=$SECRET:latest" \
  --cpu 1 --memory 512Mi --min-instances 0 --max-instances 2 --timeout 300 -q
URL=$(gcloud run services describe "$SVC" --region "$REGION" --format='value(status.url)')
echo "SERVICE URL: $URL"

# 5. Scheduler SA (invoke-only) + ~2min trigger (OIDC)
gcloud iam service-accounts describe "$SCHED_EMAIL" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SCHED_SA" --display-name "fleet-answer scheduler (invoke only)" -q
gcloud run services add-iam-policy-binding "$SVC" --region "$REGION" \
  --member "serviceAccount:$SCHED_EMAIL" --role roles/run.invoker -q >/dev/null
gcloud scheduler jobs describe "$SCHED_JOB" --location "$REGION" >/dev/null 2>&1 \
  && gcloud scheduler jobs delete "$SCHED_JOB" --location "$REGION" -q || true
gcloud scheduler jobs create http "$SCHED_JOB" --location "$REGION" \
  --schedule "*/2 * * * *" --uri "$URL/" --http-method POST \
  --oidc-service-account-email "$SCHED_EMAIL" --oidc-token-audience "$URL" -q

echo "==== DONE ===="
echo "ANSWER-RUNNER IMAGE DIGEST: $DIGEST"
echo "RUNTIME SA: $SA_EMAIL"
echo "RUNTIME SA ROLES: roles/datastore.user (project) + roles/secretmanager.secretAccessor (secret:$SECRET). NOT owner, NOT deploy."
echo "SCHEDULER SA: $SCHED_EMAIL  ROLE: roles/run.invoker (on $SVC only)"
echo "SCHEDULER JOB: $SCHED_JOB (every 2 min)"
echo "SPEND IS OFF UNTIL YOU TURN IT ON: config/models.fleet_mode defaults to 'home', in which"
echo "this service answers nothing and calls no model. It needs 'dual' -- its only transport is"
echo "the keyed one, and 'work' is keyless by definition and refuses it."
