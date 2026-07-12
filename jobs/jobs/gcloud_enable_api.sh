#!/usr/bin/env bash
# Enable a GCP API on YOUR_GCP_PROJECT. Param: {"api":"<name>.googleapis.com"}. Allowlisted to the
# services the fleet uses; anything else exits non-zero -> stays for interactive breakglass.
# Runs the enable as the paracoding-infra gcloud identity (keyless). Enabling an API is low-risk
# (billing accrues only on USE), but we keep it typed/bounded on purpose.
set -euo pipefail
export PATH="/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
API=$(printf '%s' "$JOB_PARAMS" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("api",""))')
echo "$API" | grep -qE '^[a-z0-9-]+\.googleapis\.com$' || { echo "bad api name: $API"; exit 2; }
short=${API%.googleapis.com}
ALLOW="secretmanager run cloudbuild artifactregistry compute aiplatform dialogflow storage storage-component storage-api logging monitoring iam iamcredentials generativelanguage texttospeech speech eventarc pubsub"
case " $ALLOW " in *" $short "*) : ;; *) echo "api '$short' not in allowlist -> needs interactive breakglass"; exit 3;; esac
sudo -u paracoding-infra env CLOUDSDK_CONFIG=/home/paracoding-infra/.config/gcloud HOME=/home/paracoding-infra PATH="$PATH" \
  gcloud services enable "$API" --project YOUR_GCP_PROJECT
echo "enabled $API on YOUR_GCP_PROJECT"
