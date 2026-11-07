#!/usr/bin/env bash
# Paracoding v21 installer. Run from the repository root in Cloud Shell, as an Owner of the project:
#   ./install/install.sh --project MY_PROJECT --admin me@example.com [--region us-east1] [--zone us-east1-b] [--no-wait]
# It creates: APIs, an IAP-only SSH rule, Cloud NAT, a fixed internal IP, four service accounts, three
# generated secrets, a source bucket and a backups bucket, one VM (GitLab CE + Postgres + control plane,
# no public IP), and two Cloud Run routers (vmcp-ui behind IAP, vmcp-mcp as the MCP edge). Re-runnable.
set -euo pipefail
REGION=us-east1; ZONE=""; PROJECT=""; ADMIN=""; WAIT=1; MACHINE=e2-standard-4; DISK=100; GITLAB_VERSION=19.5.3
while [ $# -gt 0 ]; do case "$1" in
  --project) PROJECT=$2; shift 2;; --admin) ADMIN=$2; shift 2;; --region) REGION=$2; shift 2;; --zone) ZONE=$2; shift 2;;
  --machine) MACHINE=$2; shift 2;; --disk) DISK=$2; shift 2;; --gitlab-version) GITLAB_VERSION=$2; shift 2;; --no-wait) WAIT=0; shift;;
  -h|--help) sed -n 2,6p "$0"; exit 0;; *) echo "unknown argument: $1" >&2; exit 2;; esac; done
[ -n "$PROJECT" ] && [ -n "$ADMIN" ] || { echo "usage: ./install/install.sh --project ID --admin EMAIL" >&2; exit 2; }
ZONE=${ZONE:-$REGION-b}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
g(){ gcloud --project="$PROJECT" --quiet "$@"; }
step(){ echo; echo "== $*"; }
retry(){ for i in 1 2 3 4 5 6 7 8; do "$@" && return 0; sleep 8; done; return 1; }
PN=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
CON=https://vmcp-ui-$PN.$REGION.run.app; MCP=https://vmcp-mcp-$PN.$REGION.run.app
VM=paracoding-vm; SRC_BUCKET=$PROJECT-paracoding-src; BK_BUCKET=$PROJECT-paracoding-backups
SA(){ echo "$1@$PROJECT.iam.gserviceaccount.com"; }

step "APIs"
g services enable compute.googleapis.com run.googleapis.com iap.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com iam.googleapis.com logging.googleapis.com storage.googleapis.com aiplatform.googleapis.com

step "network"
g compute firewall-rules describe paracoding-allow-iap-ssh >/dev/null 2>&1 || g compute firewall-rules create paracoding-allow-iap-ssh \
  --network=default --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=paracoding-vm --format=none
g compute routers describe paracoding-router --region=$REGION >/dev/null 2>&1 || g compute routers create paracoding-router --network=default --region=$REGION --format=none
g compute routers nats describe paracoding-nat --router=paracoding-router --region=$REGION >/dev/null 2>&1 || \
  g compute routers nats create paracoding-nat --router=paracoding-router --region=$REGION --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges --format=none \
  || echo "   (a NAT already covers this network; using it)"
g compute addresses describe paracoding-vm-ip --region=$REGION >/dev/null 2>&1 || g compute addresses create paracoding-vm-ip --region=$REGION --subnet=default --format=none
VMIP=$(g compute addresses describe paracoding-vm-ip --region=$REGION --format='value(address)')
echo "   VM internal IP $VMIP"

step "service accounts"
mksa(){ g iam service-accounts describe $(SA $1) >/dev/null 2>&1 || g iam service-accounts create $1 --display-name="$2" --format=none; }
mksa paracoding-vm "Paracoding VM (control plane, GitLab)"; mksa paracoding-ui "Paracoding console router"
mksa paracoding-edge "Paracoding MCP edge (no roles)"; mksa paracoding-build "Paracoding Cloud Build"
bind(){ retry g projects add-iam-policy-binding $PROJECT --member=serviceAccount:$(SA $1) --role=$2 --condition=None --format=none >/dev/null; }
for r in roles/editor roles/secretmanager.secretAccessor roles/run.admin roles/iam.serviceAccountUser; do bind paracoding-vm $r; done
bind paracoding-ui roles/compute.instanceAdmin.v1
for r in roles/cloudbuild.builds.builder roles/run.builder; do bind paracoding-build $r; done

step "secrets"
sec(){ g secrets describe $1 >/dev/null 2>&1 && return 0; printf '%s' "$2" | g secrets create $1 --replication-policy=automatic --data-file=- --format=none; }
sec wa-session-secret "$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-64)"
sec agent-tokens-b64 "$(printf '{}' | base64)"
sec approval-mac-key "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

step "storage"
g artifacts repositories describe cloud-run-source-deploy --location=$REGION >/dev/null 2>&1 || \
  g artifacts repositories create cloud-run-source-deploy --repository-format=docker --location=$REGION --format=none
for b in $SRC_BUCKET $BK_BUCKET; do gcloud storage buckets describe gs://$b >/dev/null 2>&1 || \
  gcloud storage buckets create gs://$b --project=$PROJECT --location=$REGION --uniform-bucket-level-access --format=none; done

step "source"
TMP=$(mktemp -d); tar -C "$ROOT" --exclude=.git -czf $TMP/src.tgz .; gcloud storage cp $TMP/src.tgz gs://$SRC_BUCKET/paracoding-src.tgz --quiet; rm -rf $TMP

step "VM"
if g compute instances describe $VM --zone=$ZONE >/dev/null 2>&1; then echo "   $VM exists; leaving it as is"; else
  g compute instances create $VM --zone=$ZONE --machine-type=$MACHINE --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
    --boot-disk-size=${DISK}GB --boot-disk-type=pd-balanced --private-network-ip=$VMIP --no-address \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --service-account=$(SA paracoding-vm) --scopes=cloud-platform --tags=paracoding-vm \
    --metadata=admin-email=$ADMIN,console-url=$CON,mcp-url=$MCP,source-uri=gs://$SRC_BUCKET/paracoding-src.tgz,backup-bucket=$BK_BUCKET,gitlab-version=$GITLAB_VERSION \
    --metadata-from-file=startup-script=$ROOT/install/vm-firstboot.sh --format=none
fi

step "routers (Cloud Run)"
g beta services identity create --service=iap.googleapis.com --format=none >/dev/null 2>&1 || true
COMMON=(--region=$REGION --build-service-account=projects/$PROJECT/serviceAccounts/$(SA paracoding-build) --min-instances=0 --max-instances=2
        --memory=256Mi --timeout=3600 --ingress=all --network=default --subnet=default --vpc-egress=private-ranges-only)
retry g run deploy vmcp-ui --source="$ROOT/deploy/ui/vmcp-ui" "${COMMON[@]}" --service-account=$(SA paracoding-ui) --iap \
  --set-env-vars=GCP_PROJECT=$PROJECT,VM_ZONE=$ZONE,VM_NAME=$VM,PICKET_MODE=detect,HARNESS_UPSTREAM=http://$VMIP:8090,GITLAB_UPSTREAM=http://$VMIP:80 --format=none
retry g run deploy vmcp-mcp --source="$ROOT/deploy/mcp/vmcp-mcp" "${COMMON[@]}" --service-account=$(SA paracoding-edge) --no-invoker-iam-check \
  --set-env-vars=MCP_UPSTREAM=http://$VMIP:8090,PICKET_MODE=detect --format=none
retry g run services add-iam-policy-binding vmcp-ui --region=$REGION --member=serviceAccount:service-$PN@gcp-sa-iap.iam.gserviceaccount.com --role=roles/run.invoker --format=none
retry g iap web add-iam-policy-binding --region=$REGION --resource-type=cloud-run --service=vmcp-ui --member=user:$ADMIN --role=roles/iap.httpsResourceAccessor --condition=None --format=none

if [ "$WAIT" = 1 ]; then
  step "waiting for the VM's first boot (GitLab + control plane, about 15 minutes)"
  last=""; for i in $(seq 1 100); do
    out=$(g compute instances get-serial-port-output $VM --zone=$ZONE 2>/dev/null | grep -o 'PARACODING-[A-Z]*.*' | tail -1 || true)
    [ "$out" != "$last" ] && [ -n "$out" ] && echo "   $out" && last=$out
    case "$out" in *PARACODING-READY*) break;; *PARACODING-FAILED*) echo "FIRST BOOT FAILED: $out" >&2; exit 1;; esac
    sleep 15; done
  case "$last" in *PARACODING-READY*) ;; *) echo "timed out waiting; check: gcloud compute instances get-serial-port-output $VM --zone=$ZONE" >&2; exit 1;; esac
fi
cat <<DONE

Paracoding v21 is installed in $PROJECT.
  Flow Hood (console):  $CON/          (IAP: $ADMIN)
  GitLab:               $CON/gitlab/   (sign in with "Paracoding IAP")
  MCP server:           $MCP/mcp       (add to claude.ai as a custom connector)
New connectors land on the read-only fleet-onboarder strain; bind yours to fleet-advisor in the Flow Hood.
Backups: daily to gs://$BK_BUCKET (newest 7 kept). The VM stops itself after 2 idle hours; the console wakes it.
DONE
