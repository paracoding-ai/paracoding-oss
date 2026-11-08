#!/usr/bin/env bash
# Paracoding v21 installer. Run from the repository root in Cloud Shell, as an Owner of the project:
#   ./install/install.sh --project MY_PROJECT --admin me@example.com [--region us-east1] [--zone us-east1-b] [--no-wait]
# It creates: APIs, an IAP-only SSH rule, Cloud NAT, a fixed internal IP, four service accounts, four
# generated secrets (one is the backup passphrase), a source bucket and a backups bucket, a Cloud KMS
# approval-signing key and an exec-records bucket (run_command executor), one VM (GitLab CE + Postgres +
# control plane + executor,
# no public IP), and two Cloud Run routers (vmcp-ui behind IAP, vmcp-mcp as the MCP edge). Re-runnable.
set -euo pipefail
REGION=us-east1; ZONE=""; PROJECT=""; ADMIN=""; WAIT=1; DESKTOP=on; MACHINE=e2-standard-4; DISK=100; GITLAB_VERSION=19.5.3
while [ $# -gt 0 ]; do case "$1" in
  --project) PROJECT=$2; shift 2;; --admin) ADMIN=$2; shift 2;; --region) REGION=$2; shift 2;; --zone) ZONE=$2; shift 2;;
  --machine) MACHINE=$2; shift 2;; --disk) DISK=$2; shift 2;; --gitlab-version) GITLAB_VERSION=$2; shift 2;; --no-wait) WAIT=0; shift;; --no-desktop) DESKTOP=off; shift;;
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
EXEC_BUCKET=$PROJECT-paracoding-exec; KEYRING=paracoding-approvals; SIGKEY=approval-signing
SA(){ echo "$1@$PROJECT.iam.gserviceaccount.com"; }

step "APIs"
g services enable compute.googleapis.com run.googleapis.com iap.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com iam.googleapis.com logging.googleapis.com storage.googleapis.com aiplatform.googleapis.com cloudkms.googleapis.com

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

g compute firewall-rules describe paracoding-deny-cdp >/dev/null 2>&1 || g compute firewall-rules create paracoding-deny-cdp \
  --network=default --direction=INGRESS --priority=900 --action=DENY --rules=tcp:8025,tcp:9222 --source-ranges=0.0.0.0/0 \
  --target-tags=paracoding-vm --format=none   # [V21.2-DESKTOP] the CDP bridge is for the control plane on the same VM only

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
# [BACKUP-CRYPT-V1] backups are encrypted with this passphrase (gpg AES256). Created ONCE and never rotated by a
# re-run: replacing it would make every existing backup unrecoverable.
BK_SECRET=backup-passphrase
sec $BK_SECRET "$(head -c 48 /dev/urandom | base64 | tr -d '\n')"

step "storage"
g artifacts repositories describe cloud-run-source-deploy --location=$REGION >/dev/null 2>&1 || \
  g artifacts repositories create cloud-run-source-deploy --repository-format=docker --location=$REGION --format=none
for b in $SRC_BUCKET $BK_BUCKET; do gcloud storage buckets describe gs://$b >/dev/null 2>&1 || \
  gcloud storage buckets create gs://$b --project=$PROJECT --location=$REGION --uniform-bucket-level-access --format=none; done

step "executor (approval-signing key, exec-records bucket)"
# [V21-EXEC-INSTALL-V1] The control plane signs every run_command approval with this key (Cloud KMS
# asymmetricSign) and gate-exec verifies it with the public key; gate-exec only accepts
# EC_SIGN_P256_SHA256 (PC_SIG_ALG in gate-exec/exec_server.py). Both run on the VM as paracoding-vm@.
g kms keyrings describe $KEYRING --location=$REGION >/dev/null 2>&1 || g kms keyrings create $KEYRING --location=$REGION --format=none
g kms keys describe $SIGKEY --keyring=$KEYRING --location=$REGION >/dev/null 2>&1 || g kms keys create $SIGKEY --keyring=$KEYRING \
  --location=$REGION --purpose=asymmetric-signing --default-algorithm=ec-sign-p256-sha256 --protection-level=software --format=none
# A key left by an earlier uninstall has only versions scheduled for destruction (keys themselves can't
# be deleted): give it a fresh version so a reinstall into the same project works. [V21.1-KMS-REINSTALL]
if [ -z "$(g kms keys versions list --key=$SIGKEY --keyring=$KEYRING --location=$REGION --filter='state=ENABLED OR state=PENDING_GENERATION' --format='value(name)' 2>/dev/null)" ]; then
  echo "   no usable version of $KEYRING/$SIGKEY: creating one"
  g kms keys versions create --key=$SIGKEY --keyring=$KEYRING --location=$REGION --format=none
fi
KEYVER=""; for i in $(seq 1 30); do
  KEYVER=$(g kms keys versions list --key=$SIGKEY --keyring=$KEYRING --location=$REGION --filter='state=ENABLED AND algorithm=EC_SIGN_P256_SHA256' \
    --sort-by=~createTime --format='value(name)' 2>/dev/null | head -1 || true)   # [V21.2-KMS-LIMIT] --limit=1 cut the list BEFORE the filter
  [ -n "$KEYVER" ] && break; sleep 4; done
[ -n "$KEYVER" ] || { echo "no ENABLED EC_SIGN_P256_SHA256 version of KMS key $KEYRING/$SIGKEY in $REGION" >&2; exit 1; }
echo "   approval-signing key $KEYVER"
kbind(){ retry g kms keys add-iam-policy-binding $SIGKEY --keyring=$KEYRING --location=$REGION --member=serviceAccount:$(SA paracoding-vm) --role=$1 --format=none >/dev/null; }
kbind roles/cloudkms.signer; kbind roles/cloudkms.publicKeyViewer
# gate-exec writes the single-use claim, result and journal objects (create-only); the control plane reads them back.
gcloud storage buckets describe gs://$EXEC_BUCKET >/dev/null 2>&1 || gcloud storage buckets create gs://$EXEC_BUCKET --project=$PROJECT \
  --location=$REGION --uniform-bucket-level-access --public-access-prevention --format=none
for r in roles/storage.objectCreator roles/storage.objectViewer; do
  retry gcloud storage buckets add-iam-policy-binding gs://$EXEC_BUCKET --member=serviceAccount:$(SA paracoding-vm) --role=$r --format=none >/dev/null; done

step "source"
TMP=$(mktemp -d); tar -C "$ROOT" --exclude=.git -czf $TMP/src.tgz .; gcloud storage cp $TMP/src.tgz gs://$SRC_BUCKET/paracoding-src.tgz --quiet; rm -rf $TMP

step "VM"
if g compute instances describe $VM --zone=$ZONE >/dev/null 2>&1; then echo "   $VM exists; leaving it as is (executor metadata refreshed)"
  g compute instances add-metadata $VM --zone=$ZONE --metadata=approval-sig-key-version=$KEYVER,exec-bucket=$EXEC_BUCKET --format=none
else
  g compute instances create $VM --zone=$ZONE --machine-type=$MACHINE --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
    --boot-disk-size=${DISK}GB --boot-disk-type=pd-balanced --private-network-ip=$VMIP --no-address \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --service-account=$(SA paracoding-vm) --scopes=cloud-platform --tags=paracoding-vm \
    --metadata=admin-email=$ADMIN,console-url=$CON,mcp-url=$MCP,source-uri=gs://$SRC_BUCKET/paracoding-src.tgz,backup-bucket=$BK_BUCKET,backup-encrypt-secret=$BK_SECRET,gitlab-version=$GITLAB_VERSION,desktop=$DESKTOP,approval-sig-key-version=$KEYVER,exec-bucket=$EXEC_BUCKET \
    --metadata-from-file=startup-script=$ROOT/install/vm-firstboot.sh --format=none
fi

step "routers (Cloud Run)"
echo "   (a first \"does not have storage.objects.get access\" error is new-account IAM propagation; the build is retried)"
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
Backups: daily to gs://$BK_BUCKET (newest 7 kept), ENCRYPTED (gpg AES256, *.tar.gz.gpg) with the
  passphrase in Secret Manager secret "$BK_SECRET". The VM stops itself after 2 idle hours; the console wakes it.

  !! If that secret is lost or deleted, EVERY backup is unrecoverable -- nobody can decrypt them. !!
  Export it now and keep it somewhere outside this project (a password manager, an offline safe):
    gcloud secrets versions access latest --secret=$BK_SECRET --project=$PROJECT > $BK_SECRET.txt
  Decrypt a downloaded backup by hand:  gpg --decrypt fleet-backup-....tar.gz.gpg > fleet-backup-....tar.gz
  Restore into a different project:     ops/backup/fleet-restore.sh --archive FILE.tar.gz.gpg --passphrase-file $BK_SECRET.txt ...
DONE
if [ "$DESKTOP" = on ]; then cat <<DESK

Browser tools (browser_* over MCP) drive the Chrome on the VM's desktop. Turn them on ONCE by pairing
Chrome Remote Desktop (it needs your Google account, so the installer cannot do it):
  1. Open https://remotedesktop.google.com/headless, click Begin, Next, Authorize, and copy the
     "Debian Linux" command.
  2. Run it on the VM as the desktop user (paste your command where shown, keep the quotes):
       gcloud compute ssh $VM --zone=$ZONE --project=$PROJECT --tunnel-through-iap -- \
         'sudo -u paracoding -i <PASTE THE COMMAND HERE>'
  3. Connect at https://remotedesktop.google.com/access. Chrome opens on the desktop; sign into the sites
     you want agents to use. Every site is drivable by default; lock that down in /opt/cdp-policy.json.
DESK
fi
