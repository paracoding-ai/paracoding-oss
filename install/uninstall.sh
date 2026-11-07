#!/usr/bin/env bash
# Paracoding v21 uninstaller. Removes what install/install.sh created, by exact name:
#   ./install/uninstall.sh --project MY_PROJECT              dry run: lists what would be deleted
#   ./install/uninstall.sh --project MY_PROJECT --yes        deletes it
# Options: --region (default us-east1), --zone (default: where paracoding-vm is, else REGION-b),
#   --admin EMAIL (whose IAP access to remove; default: the VM's admin-email metadata),
#   --kms-location LOC (default: try REGION, then global), --delete-backups (also delete the backups
#   bucket, the only copy of your data; kept by default). Safe to re-run: what is gone is reported.
set -euo pipefail
REGION=us-east1; ZONE=""; PROJECT=""; ADMIN=""; YES=0; DELETE_BACKUPS=0; KMS_LOC=""
while [ $# -gt 0 ]; do case "$1" in
  --project) PROJECT=$2; shift 2;; --region) REGION=$2; shift 2;; --zone) ZONE=$2; shift 2;;
  --admin) ADMIN=$2; shift 2;; --kms-location) KMS_LOC=$2; shift 2;;
  --yes) YES=1; shift;; --delete-backups) DELETE_BACKUPS=1; shift;;
  -h|--help) sed -n 2,8p "$0"; exit 0;; *) echo "unknown argument: $1" >&2; exit 2;; esac; done
[ -n "$PROJECT" ] || { echo "usage: ./install/uninstall.sh --project ID [--yes] [--delete-backups]" >&2; exit 2; }

# ================================================================== WHAT THE INSTALLER CREATES
# Exact names only. Keep in step with install/install.sh and install/vm-firstboot.sh.
VM=paracoding-vm
SERVICE_ACCOUNTS=(paracoding-vm paracoding-ui paracoding-edge paracoding-build)
PROJECT_BINDINGS=(            # "<service account> <role>" granted on the project
  "paracoding-vm roles/editor"
  "paracoding-vm roles/secretmanager.secretAccessor"
  "paracoding-vm roles/run.admin"
  "paracoding-vm roles/iam.serviceAccountUser"
  "paracoding-ui roles/compute.instanceAdmin.v1"
  "paracoding-build roles/cloudbuild.builds.builder"
  "paracoding-build roles/run.builder"
)
SECRETS=(wa-session-secret agent-tokens-b64 approval-mac-key backup-passphrase)
RUN_SERVICES=(vmcp-ui vmcp-mcp)
AR_REPO=cloud-run-source-deploy      # deleted only if it holds nothing but the images below
AR_OURS=(vmcp-ui vmcp-mcp)
SRC_BUCKET=$PROJECT-paracoding-src
EXEC_BUCKET=$PROJECT-paracoding-exec   # must match install.sh
BK_BUCKET=$PROJECT-paracoding-backups
BUCKETS=("$SRC_BUCKET" "$EXEC_BUCKET")   # the backups bucket is handled on its own below
KMS_KEYRING=paracoding-approvals; KMS_KEY=approval-signing
FIREWALL=paracoding-allow-iap-ssh; ROUTER=paracoding-router; NAT=paracoding-nat; ADDRESS=paracoding-vm-ip
# ============================================================================================

g(){ gcloud --project="$PROJECT" --quiet "$@"; }
SA(){ echo "$1@$PROJECT.iam.gserviceaccount.com"; }
retry(){ local _; for _ in 1 2 3 4 5; do "$@" && return 0; sleep 6; done; return 1; }
step(){ echo; echo "== $*"; }
PLAN=0; DONE=0; GONE=0; FAIL=0; PROBE_ERR=""

# probe CMD...: 0 = exists, 1 = gone (not found, or its API is off), 2 = could not tell.
probe(){
  local out
  if out=$("$@" 2>&1); then return 0; fi
  PROBE_ERR=$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -1 | cut -c1-200)
  [ -z "$out" ] && return 1
  printf '%s' "$out" | grep -qiE 'SERVICE_DISABLED|has not been used in project|it is disabled' && return 1
  printf '%s' "$out" | grep -qiE 'PERMISSION_DENIED|permission .* denied|forbidden|HTTPError 403' && return 2
  printf '%s' "$out" | grep -qiE 'not.?found|does not exist|HTTPError 404|code=404|"code": 404' && return 1
  return 2
}
del(){ local label=$1 out; shift
  if [ "$YES" = 0 ]; then echo "  would delete   $label"; PLAN=$((PLAN+1)); return 0; fi
  if out=$("$@" 2>&1); then echo "  deleted        $label"; DONE=$((DONE+1))
  else echo "  FAILED         $label: $(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -1 | cut -c1-200)"; FAIL=$((FAIL+1)); fi; }
gone(){ echo "  already gone   $1"; GONE=$((GONE+1)); }
cant(){ echo "  CANNOT CHECK   $1: $PROBE_ERR"; FAIL=$((FAIL+1)); }
# res LABEL PROBE-CMD... -- DELETE-CMD...
res(){ local label=$1 rc=0; shift; local p=(); while [ "$1" != -- ]; do p+=("$1"); shift; done; shift
  probe "${p[@]}" || rc=$?
  case $rc in 0) del "$label" "$@";; 1) gone "$label";; *) cant "$label";; esac; }

PN=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)') || { echo "cannot read project $PROJECT" >&2; exit 1; }
if [ -z "$ZONE" ]; then
  ZONE=$(g compute instances list --filter="name=$VM" --format='value(zone.basename())' 2>/dev/null | head -1 || true)
  ZONE=${ZONE:-$REGION-b}
fi
if [ -z "$ADMIN" ]; then
  ADMIN=$(g compute instances describe "$VM" --zone="$ZONE" --format=json 2>/dev/null | python3 -c \
    'import json,sys; print(next((i["value"] for i in json.load(sys.stdin).get("metadata",{}).get("items",[]) if i.get("key")=="admin-email"),""))' \
    2>/dev/null || true)
fi
if [ "$YES" = 1 ]; then echo "Uninstalling Paracoding from $PROJECT ($REGION, VM zone $ZONE). This deletes resources."
else echo "DRY RUN for $PROJECT ($REGION, VM zone $ZONE): nothing is deleted. Add --yes to delete."; fi

step "Cloud Run routers and their IAM"
IAP_SA=serviceAccount:service-$PN@gcp-sa-iap.iam.gserviceaccount.com
run_member(){ g run services get-iam-policy "$1" --region="$REGION" --flatten='bindings[].members' \
  --filter="bindings.role=$2" --format='value(bindings.members)' | grep -qxF "$3"; }
iap_member(){ g iap web get-iam-policy --resource-type=cloud-run --service="$1" --region="$REGION" \
  --flatten='bindings[].members' --filter="bindings.role=$2" --format='value(bindings.members)' | grep -qxF "$3"; }
if [ -n "$ADMIN" ]; then
  res "IAP access roles/iap.httpsResourceAccessor for user:$ADMIN on vmcp-ui" \
    iap_member vmcp-ui roles/iap.httpsResourceAccessor "user:$ADMIN" -- \
    retry g iap web remove-iam-policy-binding --resource-type=cloud-run --service=vmcp-ui --region="$REGION" \
      --member="user:$ADMIN" --role=roles/iap.httpsResourceAccessor --condition=None
else echo "  (admin unknown: vmcp-ui's IAP access list is removed together with the service)"; fi
res "roles/run.invoker for the IAP service agent on vmcp-ui" run_member vmcp-ui roles/run.invoker "$IAP_SA" -- \
  retry g run services remove-iam-policy-binding vmcp-ui --region="$REGION" --member="$IAP_SA" --role=roles/run.invoker
for s in "${RUN_SERVICES[@]}"; do
  res "Cloud Run service $s ($REGION)" g run services describe "$s" --region="$REGION" -- \
    g run services delete "$s" --region="$REGION"
done

step "VM (gate-exec, ops-exec, GitLab, Postgres and the control plane all live on it)"
res "VM $VM ($ZONE) and its boot disk" g compute instances describe "$VM" --zone="$ZONE" -- \
  g compute instances delete "$VM" --zone="$ZONE" --delete-disks=boot
if [ "$YES" = 1 ]; then  # a boot disk left behind (auto-delete turned off) carries the VM's name
  res "disk $VM ($ZONE)" g compute disks describe "$VM" --zone="$ZONE" -- g compute disks delete "$VM" --zone="$ZONE"
fi

step "network"
res "internal address $ADDRESS ($REGION)" g compute addresses describe "$ADDRESS" --region="$REGION" -- \
  g compute addresses delete "$ADDRESS" --region="$REGION"
res "Cloud NAT $NAT on $ROUTER" g compute routers nats describe "$NAT" --router="$ROUTER" --region="$REGION" -- \
  g compute routers nats delete "$NAT" --router="$ROUTER" --region="$REGION"
res "router $ROUTER ($REGION)" g compute routers describe "$ROUTER" --region="$REGION" -- \
  g compute routers delete "$ROUTER" --region="$REGION"
res "firewall rule $FIREWALL" g compute firewall-rules describe "$FIREWALL" -- g compute firewall-rules delete "$FIREWALL"

step "Artifact Registry"
rc=0; probe g artifacts repositories describe "$AR_REPO" --location="$REGION" || rc=$?
case $rc in
  0) pk=$(g artifacts packages list --repository="$AR_REPO" --location="$REGION" --format='value(name.basename())' 2>/dev/null || echo '?')
     other=""; for p in $pk; do case " ${AR_OURS[*]} " in *" $p "*) ;; *) other="$other $p";; esac; done
     if [ -z "$other" ]; then
       held=$(printf '%s\n' "$pk" | tr '\n' ' '); del "Artifact Registry repo $AR_REPO ($REGION), holding: ${held:-nothing}" \
         g artifacts repositories delete "$AR_REPO" --location="$REGION"
     else
       echo "  keeping        repo $AR_REPO: it also holds images we did not build:$other"
       for p in "${AR_OURS[@]}"; do
         res "image $p in $AR_REPO" g artifacts packages describe "$p" --repository="$AR_REPO" --location="$REGION" -- \
           g artifacts packages delete "$p" --repository="$AR_REPO" --location="$REGION"
       done
     fi;;
  1) gone "Artifact Registry repo $AR_REPO ($REGION)";;
  *) cant "Artifact Registry repo $AR_REPO ($REGION)";;
esac

step "buckets"
for b in "${BUCKETS[@]}"; do
  res "bucket gs://$b and every object in it" gcloud storage buckets describe "gs://$b" --project="$PROJECT" -- \
    gcloud storage rm --recursive --all-versions "gs://$b" --project="$PROJECT" --quiet
done
if [ "$DELETE_BACKUPS" = 1 ]; then
  res "bucket gs://$BK_BUCKET (BACKUPS: the only copy of your data)" \
    gcloud storage buckets describe "gs://$BK_BUCKET" --project="$PROJECT" -- \
    gcloud storage rm --recursive --all-versions "gs://$BK_BUCKET" --project="$PROJECT" --quiet
else
  rc=0; probe gcloud storage buckets describe "gs://$BK_BUCKET" --project="$PROJECT" || rc=$?
  case $rc in
    0) echo "  keeping        bucket gs://$BK_BUCKET (backups; pass --delete-backups to delete it)";;
    1) gone "bucket gs://$BK_BUCKET";; *) cant "bucket gs://$BK_BUCKET";; esac
fi

step "secrets"
for s in "${SECRETS[@]}"; do
  # [V21.1-KEEP-BACKUP-KEY] backups are encrypted with backup-passphrase: deleting the key while
  # keeping the backups would make every kept archive undecryptable. It goes only with the backups.
  if [ "$s" = backup-passphrase ] && [ "$DELETE_BACKUPS" != 1 ]; then
    echo "  keeping        secret $s (decrypts the kept backups; pass --delete-backups to delete it)"; continue
  fi
  res "secret $s" g secrets describe "$s" -- g secrets delete "$s"
done

step "KMS signing key (keys cannot be deleted; their versions are scheduled for destruction)"
locs=("$REGION" global); [ -n "$KMS_LOC" ] && locs=("$KMS_LOC")
found=0
for l in "${locs[@]}"; do
  rc=0; probe g kms keys describe "$KMS_KEY" --keyring="$KMS_KEYRING" --location="$l" || rc=$?
  [ $rc = 1 ] && continue
  [ $rc = 2 ] && { cant "KMS key $KMS_KEYRING/$KMS_KEY ($l)"; continue; }
  found=1
  vs=$(g kms keys versions list --key="$KMS_KEY" --keyring="$KMS_KEYRING" --location="$l" \
    --filter='state=ENABLED OR state=DISABLED' --format='value(name.basename())')
  [ -z "$vs" ] && echo "  already gone   every version of KMS key $KMS_KEYRING/$KMS_KEY ($l) is destroyed or scheduled"
  for v in $vs; do
    del "KMS key version $KMS_KEYRING/$KMS_KEY/$v ($l): scheduled for destruction" \
      g kms keys versions destroy "$v" --key="$KMS_KEY" --keyring="$KMS_KEYRING" --location="$l"
  done
  echo "  stays          KMS key ring $KMS_KEYRING and key $KMS_KEY ($l): Cloud KMS never deletes key rings or keys;"
  echo "                 destruction happens after the key's scheduled-destruction period (30 days by default)"
done
[ $found = 0 ] && gone "KMS key $KMS_KEYRING/$KMS_KEY (${locs[*]})"

step "project IAM bindings and service accounts"
if POLICY=$(gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' --format='value(bindings.role,bindings.members)' 2>&1); then
  for e in "${PROJECT_BINDINGS[@]}"; do
    sa=$(SA "${e%% *}"); role=${e#* }; hit=0
    while IFS=$'\t' read -r r m <&3; do
      [ "$r" = "$role" ] || continue
      case "$m" in "serviceAccount:$sa"|"deleted:serviceAccount:$sa?uid="*) ;; *) continue;; esac
      hit=1
      del "project role $role for $m" \
        retry g projects remove-iam-policy-binding "$PROJECT" --member="$m" --role="$role" --condition=None --format=none
    done 3<<< "$POLICY"
    [ $hit = 0 ] && gone "project role $role for serviceAccount:$sa"
  done
else PROBE_ERR=$(printf '%s\n' "$POLICY" | tail -1); cant "project IAM policy"; fi
for s in "${SERVICE_ACCOUNTS[@]}"; do
  res "service account $(SA "$s")" g iam service-accounts describe "$(SA "$s")" -- g iam service-accounts delete "$(SA "$s")"
done

echo
echo "Left in place on purpose: enabled APIs, the IAP service agent, Cloud Build's and Cloud Run's own"
echo "staging buckets, the KMS key ring and key (versions destroyed), and anything not named above."
if [ "$YES" = 0 ]; then
  echo "DRY RUN: $PLAN to delete, $GONE already gone, $FAIL could not be checked. Re-run with --yes to delete."
  exit 0
fi
echo "Done: $DONE deleted, $GONE already gone, $FAIL failed."
[ "$FAIL" = 0 ]
