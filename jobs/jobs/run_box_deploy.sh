set -euo pipefail
export PATH="/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
J(){ printf '%s' "$JOB_PARAMS" | python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))"; }
DELIV=$(J deliverable); DFP=$(J df_project_id); DFL=$(J df_location); DFA=$(J df_agent_id)
echo "$DELIV" | grep -qE '^[a-z0-9-]+$' || { echo "bad deliverable name: $DELIV"; exit 2; }
DIR=/root/ops/deliverables/$DELIV
[ -x "$DIR/box_deploy.sh" ] || { echo "no box_deploy.sh in $DIR"; exit 2; }
export CLOUDSDK_CONFIG=/home/paracoding-infra/.config/gcloud
export PROJECT="${DFP:-YOUR_GCP_PROJECT}" DF_PROJECT_ID="${DFP:-YOUR_GCP_PROJECT}" DF_LOCATION="${DFL:-us-central1}" DF_AGENT_ID="$DFA"
export SIMULATE=0   # Operator's rule: demo is always real; jobs may NOT flip this
[ "$(stat -c %U "$DIR/box_deploy.sh")" = root ] || { echo "refusing: box_deploy.sh not root-owned"; exit 2; }
[ -z "$(find "$DIR/box_deploy.sh" -perm /022)" ] || { echo "refusing: box_deploy.sh group/world-writable"; exit 2; }
cd "$DIR"
echo "run_box_deploy: deliverable=$DELIV df_agent=${DFA:-none} SIMULATE=0"
bash box_deploy.sh
