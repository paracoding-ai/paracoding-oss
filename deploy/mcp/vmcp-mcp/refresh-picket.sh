#!/usr/bin/env bash
# Refresh the pinned Picket edge files from root/paracoding-security at a given ref.
# Run on the box (reaches the internal GitLab). Updates the pin header's SHA by hand after.
set -euo pipefail
REF="${1:?usage: refresh-picket.sh <sha-or-ref>}"
TOKEN="$(gcloud secrets versions access latest --secret=gitlab-api-token)"
GL=http://127.0.0.1/gitlab/api/v4/projects/7/repository/files
cd "$(dirname "$0")"
for f in prompt-guard%2Fheuristics.py; do
  out="$(basename "${f//%2F//}")"
  curl -fsS -H "PRIVATE-TOKEN: ${TOKEN}" "${GL}/${f}/raw?ref=${REF}" -o ".picket.$out"
  echo "fetched $out @ $REF -> .picket.$out (review, prepend the pin header, mv into place)"
done
