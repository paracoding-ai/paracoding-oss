#!/bin/bash
# vmcp-idle-off.sh - scale-to-zero: stop this VM after IDLE_MIN of no real activity.
#
# The box is BUSY (do NOT stop) if ANY of these hold:
#   1. /run/fleet/last-activity mtime is within IDLE_MIN. The control-plane writes it on every
#      non-health request, so live agent chat + MCP tool calls keep the box awake.
#   2. GitLab has running / pending / created CI jobs (fleet project id GL_PROJECT_ID). CI runs
#      on THIS box's shell runner and never touches the control-plane HTTP, so it needs its own
#      signal or a long build would be killed mid-flight.
#
# Self-stops via the Compute REST API using the instance metadata SA token. A minimum-uptime
# guard avoids stop-loops right after boot. ENABLE only once the wake path is live (Cloud Run
# waker + LB error-page splash), or a stopped VM strands with no way back up.
#
# KNOWN FOLLOW-UP: a single in-flight request that runs longer than IDLE_MIN (e.g. one very long
# roll) refreshes last-activity only at request start. If that becomes real, have the control
# plane heartbeat /run/fleet/last-activity while a roll is in flight. Not needed for the common
# 'go'-loop workload, where each turn is a fresh request that refreshes the timestamp.
#
# The metadata SA token must carry the cloud-platform scope (it does today: the box SA reads
# Secret Manager and drives Compute). Env overrides: IDLE_MIN, MIN_UPTIME_MIN, GL_PROJECT_ID.
set -uo pipefail
IDLE_MIN="${IDLE_MIN:-120}"
MIN_UPTIME_MIN="${MIN_UPTIME_MIN:-20}"
GL_PROJECT_ID="${GL_PROJECT_ID:-1}"
ACT=/run/fleet/last-activity
PROJECT=$(curl -s -H "Metadata-Flavor: Google" http://metadata/computeMetadata/v1/project/project-id)  # [V21-PARAM]
GL=http://127.0.0.1/gitlab/api/v4
now=$(date +%s)
up=$(awk '{print int($1)}' /proc/uptime)

md() { curl -s -H "Metadata-Flavor: Google" "http://metadata/computeMetadata/v1/$1"; }

# --- min-uptime guard: never stop a just-booted box (avoids stop/start loops) ---
if [ "$up" -lt $((MIN_UPTIME_MIN*60)) ]; then echo "uptime ${up}s under guard; skip"; exit 0; fi

# --- signal 1: recent real activity (interactive + agent sessions) ---
if [ -f "$ACT" ]; then last=$(stat -c %Y "$ACT"); else last=$((now - up)); fi
idle=$(( (now - last) / 60 ))
echo "idle=${idle}m threshold=${IDLE_MIN}m"
if [ "$idle" -lt "$IDLE_MIN" ]; then echo "recent activity; stay up"; exit 0; fi

# --- signal 2: running / pending / created CI jobs on the fleet project ---
# Fail-open: if the token or GitLab is unreachable we do NOT treat it as busy (a truly
# unreachable local GitLab has no jobs running anyway), so idle-off still works. We fetch the
# GitLab token from Secret Manager via REST using the same metadata SA token used for the stop.
AT=$(md "instance/service-accounts/default/token" | sed 's/.*"access_token":"//;s/".*//')
GLTOK=$(curl -s -H "Authorization: Bearer $AT" \
  "https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/gitlab-api-token/versions/latest:access" \
  | sed 's/.*"data":"//;s/".*//' | base64 -d 2>/dev/null)
if [ -n "$GLTOK" ]; then
  jobs=$(curl -s -H "PRIVATE-TOKEN: $GLTOK" \
    "${GL}/projects/${GL_PROJECT_ID}/jobs?scope[]=running&scope[]=pending&scope[]=created&per_page=1")
  case "$jobs" in
    *'"id"'*) echo "CI jobs running/pending; stay up"; exit 0;;
  esac
else
  echo "WARN: could not read gitlab-api-token; skipping CI busy-check"
fi

# --- all idle: stop the VM ---
echo "IDLE and no CI jobs -> stopping VM"
Z=$(md "instance/zone" | sed 's#.*/##')
N=$(md "instance/name")
curl -s -o /dev/null -w "stop HTTP %{http_code}\n" -X POST -H "Authorization: Bearer $AT" \
  "https://compute.googleapis.com/compute/v1/projects/${PROJECT}/zones/$Z/instances/$N/stop"
