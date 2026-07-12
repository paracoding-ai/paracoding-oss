#!/bin/bash
# Provision the fleet VM (pragmatic IaC; terraform formalization TODO). Needs gcloud auth + billed project.
set -euo pipefail
PROJ="${1:?project}"; ZONE="${2:-us-central1-a}"; VM="${3:-paracoding-mirror}"
gcloud services enable compute.googleapis.com --project="$PROJ"
gcloud compute firewall-rules create paracoding-allow-web --project="$PROJ" \
  --direction=INGRESS --action=ALLOW --rules=tcp:22,tcp:80,tcp:443 --source-ranges=0.0.0.0/0 || true
gcloud compute instances create "$VM" --project="$PROJ" --zone="$ZONE" \
  --machine-type=e2-small --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --boot-disk-size=20GB \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring
gcloud compute instances list --project="$PROJ" --filter="name=$VM" --format='value(name,status,EXTERNAL_IP)'
