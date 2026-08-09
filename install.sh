#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Paracoding / Agentic Fungi -- one-command install into YOUR OWN Google Cloud project.
#   ./install.sh PROJECT_ID [REGION]
# Apache-2.0. Nothing phones home. Every secret is generated here and stored in Secret
# Manager; none ship in this tree.
#
# Written POSIX-safe on purpose: macOS still ships bash 3.2, so no mapfile, no declare -A.
set -u

# [SEC-REHEARSE-V1] UNATTENDED REHEARSAL. Runs 0/10..8/10 with no human and stops
# deliberately at the 9/10 boundary, exit 20. It does NOT relax the -t 0 guard below:
# the harness gives this script a real pty, so the guard is satisfied honestly, and the
# script stops on its own BEFORE the step that needs a person. Default off.
PC_REHEARSE="${PC_REHEARSE:-0}"
case "${1:-}" in
  --rehearse|--stop-before-passkey) PC_REHEARSE=1; shift ;;
esac
PROJECT="${1:-}"
REGION="${2:-us-east1}"
[ -n "$PROJECT" ] || { echo "usage: ./install.sh [--rehearse] PROJECT_ID [REGION]"; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
CP_SVC=paracoding-control-plane
GX_SVC=paracoding-gate-exec
CP_SA="pc-control-plane@${PROJECT}.iam.gserviceaccount.com"
GX_SA="pc-gate-exec@${PROJECT}.iam.gserviceaccount.com"

# [SEC-REHEARSE-V1] PC_STEP carries the step label that is currently OPEN. A step that
# began and was followed by the NEXT step beginning is a step that finished: die() exits
# immediately, so no failed step is ever followed by another one. Per-step pass/fail
# therefore needs no per-step instrumentation and cannot drift as steps are renumbered.
PC_STEP=""
say() {
  if [ -n "$PC_STEP" ]; then printf '##PCSTEP OK %s\n' "$PC_STEP"; fi
  PC_STEP="${1%% *}"
  printf '##PCSTEP BEGIN %s\n' "$PC_STEP"
  printf '\n\033[1m== %s\033[0m\n' "$*"
}
die() {
  if [ -n "$PC_STEP" ]; then printf '##PCSTEP FAIL %s\n' "$PC_STEP"; fi
  printf '\n!! %s\n' "$*" >&2
  exit 1
}

# A 403 that says the API is not enabled yet is worth retrying. Any OTHER 403 is a real
# permission problem, and retrying it only hides the message you needed to read.
retry() {
  n=0
  while :; do
    out=$("$@" 2>&1); rc=$?
    [ $rc -eq 0 ] && { printf '%s' "$out"; return 0; }
    case "$out" in
      # [SEC-INSTALL-DEV-V1] SA creation returns before IAM can see it; that race is retryable.
      *SERVICE_DISABLED*|*"has not been used in project"*|*"is disabled"*|*"not ready"*|*RESOURCE_EXHAUSTED*|*"does not exist"*|*"not found"*|*NOT_FOUND*|*"could not resolve source"*|*"storage.objects.get"*) : ;;
      *) printf '%s\n' "$out" >&2; return $rc ;;
    esac
    n=$((n+1)); [ $n -ge 9 ] && { printf '%s\n' "$out" >&2; return $rc; }
    sleep $((n*5))
  done
}

say "0/10 preflight"
command -v gcloud >/dev/null || die "gcloud not found."
command -v openssl >/dev/null || die "openssl not found."
command -v python3 >/dev/null || die "python3 not found."
# [SEC-PKG-STRANGER-V1] EVERY EXTERNAL ASSUMPTION, MADE LOUD AND EARLY. A prerequisite discovered at
# minute twenty is what makes an install fail. Each check below fires in the first ten
# seconds instead, and names the fix rather than the symptom.
command -v curl >/dev/null || die "curl not found. The 10/10 self-test is written in curl,
so without it a good install would report itself as a broken one."
[ -t 0 ] || die "install.sh needs an interactive terminal. Step 9/10 stops to have you
register a passkey and then waits on ENTER; with stdin closed it sails past that prompt and
you finish with a deployment nobody can approve anything on. Run it from a real shell."
# [SEC-IAP-PROBE-V1] Probe the EXACT surface step 8/10 uses, not merely that "beta" resolves.
# WHAT WAS WRONG: this line used to run `gcloud beta version`, which is not a gcloud
# command at all -- it exits 2 with "ERROR: (gcloud.beta) Invalid choice: 'version'".
# The probe therefore failed on every machine, with or without the beta component, and
# every install died at 0/10 being told to install something it already had.
#
# TWO CHECKS AT TWO SEVERITIES, on purpose:
#   FATAL  `gcloud beta run services update --help` must EXIT 0. That is an exit status,
#          not a string match, so no rewording of Google's help text can break it. If it
#          fails, the beta command group cannot run and step 8/10 has nothing to call.
#   WARN   the help must advertise --iap. This one IS a match against text Google formats
#          as it pleases, so it must never be able to stop an install: a future SDK
#          rendering the flag as --[no-]iap, or wrapping the line, would otherwise
#          reinstate the exact 0/10 blocker this comment exists to explain. Step 8/10
#          does not die when its --iap call fails either -- it warns and continues -- and
#          a preflight must not be stricter than the step it guards.
# CLOUDSDK_CORE_DISABLE_PROMPTS and </dev/null are not decoration. On a components-managed
# SDK, naming an uninstalled command group makes gcloud print "You do not currently have
# this command group installed ... Do you want to continue (Y/n)?" on stderr and then READ
# stdin. stdin is a real terminal here -- it was required three lines up -- so without
# these the probe would block forever with its prompt sent to /dev/null, and the install
# would look hung at 0/10 instead of printing the message below.
# `--help` is answered by the locally installed SDK; it does not go to the network.
PC_IAP_HELP=$(CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud beta run services update --help 2>/dev/null </dev/null) || die "this gcloud cannot run the step that protects your console.
Step 8/10 runs 'gcloud beta run services update --iap' to put the console behind
Identity-Aware Proxy. Without it the console is reachable by anyone who learns the URL,
and finding that out at step 8 means finding it out after the deploy.
Checked: 'gcloud beta run services update --help' must exit 0. It did not.
  - if 'gcloud beta --help' ALSO fails, the beta component is missing:
        gcloud components install beta
    (on a package-managed gcloud, install the google-cloud-cli-beta package instead)
  - if 'gcloud beta --help' SUCCEEDS, beta is present and this SDK is too old to know
    'run services update':
        gcloud components update"
printf '%s' "$PC_IAP_HELP" | grep -qE -- '(^|[^-[:alnum:]])--(\[no-\])?iap([^-[:alnum:]]|$)' || {
  echo "  WARNING: this SDK's 'gcloud beta run services update --help' does not advertise"
  echo "           --iap. Step 8/10 will still try it, and if it fails it prints the"
  echo "           console URL for turning IAP on by hand -- but until you do, your console"
  echo "           is reachable by anyone who learns its URL. Try: gcloud components update"
}
ACCT=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)
[ -n "$ACCT" ] || die "no active gcloud account. Run: gcloud auth login"
# [SEC-REHEARSE-SA-V1] IDENTITY CLASS, NOT PERMISSIONS. A service account can never satisfy
# the gate: approved jobs execute using the approver's own OAuth token, so no amount of IAM
# makes one acceptable. Outside rehearsal that is fatal and the wording below is unchanged.
# Under --rehearse it is a WARNING instead, because this run halts at the 9/10 boundary
# further down: no consent is solicited, no passkey is registered, and pc-bootstrap-secret
# is never minted -- so there is nothing here for a human identity to mean. Without this,
# --rehearse and step 0/10 are mutually exclusive by construction and no CI can ever
# rehearse. This does NOT relax the -t 0 guard and does NOT move the boundary.
case "$ACCT" in
  *gserviceaccount.com)
    if [ "$PC_REHEARSE" = 1 ]; then
      echo "  WARNING: authenticated as a SERVICE ACCOUNT ($ACCT)."
      echo "           Permitted under --rehearse ONLY, which stops before step 9/10."
      echo "           A real install needs a human identity: gcloud auth login"
    else
      die "You are authenticated as a SERVICE ACCOUNT ($ACCT).
Approved jobs execute using the approver's own OAuth token, so the gate needs a human
identity to consent. Run: gcloud auth login"
    fi ;;
esac
gcloud projects describe "$PROJECT" >/dev/null 2>&1 || die "cannot see project $PROJECT"
echo "  project=$PROJECT region=$REGION as=$ACCT"

# [SEC-PKG-STRANGER-V1] BILLING. Nothing after step 1 works without it, and the error you get instead
# names an API rather than the cause. Not fatal when the CHECK itself cannot run:
# billing.projects.get is a separate permission from resourcemanager.projects.get.
# [SEC-BILLPROBE-PTY-V1] CLOUDSDK_CORE_DISABLE_PROMPTS and </dev/null are required here for
# the same reason they are on the IAP probe above, and this probe never got them. When
# cloudbilling.googleapis.com is disabled, gcloud does not fail -- it asks: "API
# [cloudbilling.googleapis.com] not enabled on project [N]. Would you like to enable and
# retry (this will take a few minutes)? (y/N)?" -- then READS stdin. stdin is a real
# terminal, because the [ -t 0 ] guard above requires one, so the prompt goes to /dev/null
# and the installer hangs at 0/10 with nothing on screen explaining why.
# NOTE ON THE EMPTY CASE, so it is not mistaken for the preflight defect below: empty is
# DELIBERATELY not fatal here, and that is sound because billing.projects.get is a separate
# permission from resourcemanager.projects.get and step 1/10 fails loudly anyway. That is
# not true of the authority preflight, where empty had to become fatal.
PC_BILL=$(CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud beta billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null </dev/null)
case "$PC_BILL" in
  True|true)   echo "  billing: enabled" ;;
  False|false) die "billing is NOT enabled on $PROJECT. No API can be enabled, no service
deployed, no database created. Link a billing account and re-run:
    https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT" ;;
  *)           echo "  billing: not readable from this account (billing.projects.get). If"
               echo "           step 1/10 dies naming an API, unlinked billing is why." ;;
esac

# [SEC-PKG-STRANGER-V1] THE CALLER'S OWN AUTHORITY. Being able to DESCRIBE a project says nothing about
# being able to CHANGE one. Ask Google which of these it will actually let you do, rather
# than assuming Owner and discovering the truth at step 3 or step 6 as a bare 403.
PC_NEED="resourcemanager.projects.setIamPolicy serviceusage.services.enable iam.serviceAccounts.create run.services.create secretmanager.secrets.create"
# [SEC-PREFLIGHT-EMPTY-V1] ASK GOOGLE OVER REST, AND TREAT SILENCE AS A FAILURE.
# TWO defects lived here and the first one hid the second.
#   1. THERE IS NO `gcloud projects test-iam-permissions` VERB. It does not exist in any
#      release channel of the SDK -- measured on 578.0.0, which answers
#      "ERROR: (gcloud.projects) Invalid choice: 'test-iam-permissions'". The call was
#      made with 2>/dev/null, so the probe has returned EMPTY for every caller on every
#      machine since the day it was written.
#   2. The empty result was then treated as "could not test" and CONTINUED, so the check
#      skipped itself 100% of the time. It has never once run.
# Together those made this block decoration: it printed reassurance it had not earned.
# The REST endpoint is the real interface, and curl and python3 are both hard
# prerequisites checked at the top of this script, so this costs no new dependency.
# An empty or unparseable answer is now FATAL rather than excused, because every case
# that produces one ends as a bare 403 twenty minutes deep -- which is the whole reason
# this check exists.
PC_TOK=$(gcloud auth print-access-token 2>/dev/null)
PC_BODY=$(printf '%s' "$PC_NEED" | python3 -c 'import sys,json;print(json.dumps({"permissions":sys.stdin.read().split()}))' 2>/dev/null)
PC_HAVE=""
if [ -n "$PC_TOK" ] && [ -n "$PC_BODY" ]; then
  PC_HAVE=$(curl -sS -m 30 -X POST -H "Authorization: Bearer $PC_TOK" -H "Content-Type: application/json" -d "$PC_BODY" "https://cloudresourcemanager.googleapis.com/v1/projects/$PROJECT:testIamPermissions" 2>/dev/null | python3 -c 'import sys,json;print(" ".join(json.load(sys.stdin).get("permissions",[])))' 2>/dev/null)
fi
if [ -n "$PC_HAVE" ]; then
  PC_MISS=""
  for _p in $PC_NEED; do
    case " $(echo $PC_HAVE) " in *" $_p "*) : ;; *) PC_MISS="$PC_MISS $_p" ;; esac
  done
  [ -z "$PC_MISS" ] || die "$ACCT cannot complete this install on $PROJECT.
Missing permission(s):$PC_MISS
Grant yourself roles/owner on the project, or the individual roles carrying these, and
re-run. Stopping now is cheaper than stopping half-deployed at step 6."
  echo "  authority: every required project permission is present"
else
  die "cannot establish that $ACCT may install on $PROJECT.
The permission probe returned nothing for: $PC_NEED
Three things produce that and all three end the same way: no access token could be
minted, cloudresourcemanager.googleapis.com is not enabled on $PROJECT, or this account
holds NONE of the five. Each becomes a bare 403 at step 3/10 or 6/10 after twenty
minutes of work, so it stops here instead of pretending it checked.
Enable cloudresourcemanager.googleapis.com and grant yourself roles/owner on $PROJECT
(or the individual roles carrying those permissions), then re-run."
fi

# [SEC-PKG-STRANGER-V1] REGION. Cloud Run regions and Firestore locations are DIFFERENT sets. Several
# valid Run regions are not Firestore locations at all, and the failure surfaces forty
# retries deep inside pc_fs_create in step 2/10, twenty minutes from here.
if gcloud firestore locations list --project "$PROJECT" \
     --format='value(locationId)' 2>/dev/null | grep -qx "$REGION"; then
  echo "  region: $REGION is a Firestore location as well as a Cloud Run region"
else
  echo "  WARNING: $REGION is not in this project's Firestore location list (or the list"
  echo "           could not be read). If step 2/10 cannot create the database, choose a"
  echo "           region in BOTH sets: us-east1, us-central1, europe-west1, asia-northeast1."
fi

say "1/10 enabling APIs (this is the slow one)"
# [SEC-PKG-STRANGER-V1] THREE APIS ADDED, none of them cosmetic.
#   compute              -- Cloud Build runs as the COMPUTE DEFAULT service account, and
#                           Google only creates that account once this API is enabled. On a
#                           genuinely fresh project it does not exist, the binding in step
#                           3/10 fails "does not exist", retry() reads that as retryable,
#                           and the installer burns 225 seconds of backoff before dying
#                           with a message that never says what was actually wrong.
#   cloudresourcemanager -- needed by the IAP access binding in step 8/10, which used to
#                           enable it there; enabling it here means one propagation wait
#                           instead of two.
#   serviceusage         -- this very command needs it on projects where it is not on by
#                           default. A chicken-and-egg the retry loop cannot solve.
retry gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com logging.googleapis.com \
  compute.googleapis.com cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
  cloudkms.googleapis.com \
  --project "$PROJECT" >/dev/null || die "could not enable APIs"
echo "  enabled (propagation is absorbed by retry below, not by a fixed sleep)"

say "2/10 Firestore"
# [SEC-NAMED-DB-V1] We never use (default): it may already hold the operator's own data, it
# may be in DATASTORE mode, and its name is guessable. We create our own randomly-named
# database and adopt it on re-runs. A fresh name also means an uninstall followed by a
# reinstall never collides with the ID reservation that follows a delete.
# [SEC-FSLIST-EXITCODE-V1] N16. THE EXIT CODE IS CHECKED NOW. EMPTY IS STILL NOT FATAL.
# This was one pipeline with 2>/dev/null and no status check, so a list that FAILED --
# API still propagating, a transient 403, a wrong project -- was indistinguishable from
# "this project has no database yet", and the else branch below CREATES ONE. Of every
# discarded-stderr probe in this installer this is the only one whose misreading MUTATES
# anything: it leaves a second, orphaned, randomly-named Firestore database that no later
# run adopts and that the uninstaller reports as a stranger.
#
# $? CANNOT BE TAKEN FROM THE PIPELINE. It reports the LAST stage, and grep exits 1
# whenever there is simply no match -- which is the normal fresh-project case. So gcloud
# runs on its own, its status is captured immediately, and the text is filtered after.
#
# EMPTY STAYS NON-FATAL ON PURPOSE, and that is the N12 distinction rather than a
# softening of it. N12 was a probe that returned empty ALWAYS because the verb did not
# exist, so making empty fatal there would have bricked install.sh for every user. Here
# the verb exists and works, and that was established by EXECUTION rather than by reading:
# in two consecutive end-to-end installs the first CREATED a randomly-named database and
# the second ADOPTED THAT SAME NAME. The name comes from /dev/urandom, so two runs
# cannot coin it twice -- adoption is only reachable through this list returning it with
# status 0. An empty list from a SUCCESSFUL call is therefore a real and expected state, a
# fresh project, and it still creates. Only a NON-ZERO STATUS changed meaning.
PC_FSLIST=$(gcloud firestore databases list --project "$PROJECT" --format='value(name)' 2>/dev/null); PC_FSRC=$?
[ "$PC_FSRC" -eq 0 ] || die "could not list the Firestore databases in $PROJECT ('gcloud firestore
databases list' exited $PC_FSRC). Refusing to continue, because this installer cannot tell an
empty project from a failed query, and guessing wrong CREATES A SECOND Firestore database
instead of adopting the one you already have. Check the API is enabled and readable, then
re-run this installer:
    gcloud services enable firestore.googleapis.com --project $PROJECT
    gcloud firestore databases list --project $PROJECT"
FSDB=$(printf '%s\n' "$PC_FSLIST" | sed 's#.*/##' | grep '^paracoding-' | head -1)
if [ -n "$FSDB" ]; then
  echo "  adopting the database this installer made earlier: $FSDB"
else
  FSDB="paracoding-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  pc_fs_create() {
    local i=0 out
    while [ "$i" -lt 40 ]; do
      out=$(gcloud firestore databases create --database="$FSDB" --location="$REGION" --type=firestore-native --project "$PROJECT" 2>&1) && return 0
      case "$out" in
        *"is not available"*|*FAILED_PRECONDITION*)
          echo "  database ID unavailable; waiting 30s ($((i+1))/40)" ;;
        *) echo "$out" >&2; return 1 ;;
      esac
      sleep 30; i=$((i+1))
    done
    return 1
  }
  pc_fs_create || die "could not create Firestore"
  echo "  created (native mode): $FSDB"
fi

# [SEC-MEMORY-INDEX-V1] The knowledge-graph memory tools ship inside index.ts, so every
# adopter gets them. Without a composite index the first call fails FAILED_PRECONDITION --
# which reads as a broken install rather than as a missing index.
# --async is REQUIRED: a composite index build blocks for minutes, and serial waits blow
# any sane install budget. Non-fatal on purpose; Firestore's own error names what it wants.
#
# [SEC-PKG-STRANGER-V1] FOUR INDEXES, NOT ONE. This step created exactly one, and the other three were
# created BY HAND on the operator's own deployment and never captured here. So the working
# deployment had four and every stranger's install had one, and read_graph filtered by
# entityType, open_nodes, and chat history all failed FAILED_PRECONDITION on first use --
# a defect invisible to anyone who only ever looked at the deployment that worked.
#
# The observations index KEEPS COLLECTION_GROUP scope. A code reading argued it should be
# COLLECTION; live evidence contradicted that reading -- the running deployment serves
# memory queries at COLLECTION_GROUP and they work. Do not "fix" it from the source alone.
say "2b/10 Firestore indexes for the memory and history tools"
PC_IDX_FAIL=0
pc_index() { # collection-group query-scope field1,order field2,order
  if gcloud firestore indexes composite create \
    --collection-group="$1" --query-scope="$2" \
    --field-config=field-path="${3%%,*}",order="${3#*,}" \
    --field-config=field-path="${4%%,*}",order="${4#*,}" \
    --database="$FSDB" --project "$PROJECT" --async >/dev/null 2>&1; then
    printf '  requested  %-17s %s+%s\n' "$1" "${3%%,*}" "${4%%,*}"
  else
    printf '  NOT MADE   %-17s %s+%s\n' "$1" "${3%%,*}" "${4%%,*}"
    PC_IDX_FAIL=$((PC_IDX_FAIL+1))
  fi
}
pc_index observations     COLLECTION_GROUP status,ascending    createdAt,descending
pc_index memory_entities  COLLECTION       scope,ascending     entityType,ascending
pc_index memory_relations COLLECTION       scope,ascending     from,ascending
pc_index chat_history     COLLECTION       agent_id,ascending  timestamp,descending
if [ "$PC_IDX_FAIL" -eq 0 ]; then
  echo "  all four requested; they build in the background"
else
  echo "  NOTE: $PC_IDX_FAIL of 4 index requests were not accepted. An index that ALREADY"
  echo "        exists reports the same way, so on a re-run this line is expected."
  echo "        If a memory or history call later fails FAILED_PRECONDITION, Firestore's"
  echo "        own error names the exact index and gives you a one-click link for it."
fi

say "3/10 service accounts (three, least privilege)"
for pair in "pc-control-plane:control plane" "pc-gate-exec:gated executor"; do
  id="${pair%%:*}"; desc="${pair#*:}"
  gcloud iam service-accounts describe "${id}@${PROJECT}.iam.gserviceaccount.com" --project "$PROJECT" >/dev/null 2>&1 \
    || retry gcloud iam service-accounts create "$id" --display-name "$desc" --project "$PROJECT" >/dev/null
done
# Firestore IAM has NO per-collection granularity, so this grant is project-wide whether we
# like it or not. That is precisely why approvals are signed ASYMMETRICALLY: see the Cloud
# KMS approval-signing key provisioned in step 5b/10 below. The signature is what bounds
# what this grant would otherwise let a compromised executor claim.
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$CP_SA" \
  --role=roles/datastore.user --condition=None >/dev/null
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$CP_SA" \
  --role=roles/logging.logWriter --condition=None >/dev/null
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$GX_SA" \
  --role=roles/logging.logWriter --condition=None >/dev/null
# [SEC-GENV21-V1-V6-V7] The executor READS the approval it is about to run and WRITES back
# the claim, the journal entry and the result. All three need datastore.user, and Firestore
# IAM cannot scope a grant to a collection. An earlier revision withheld this grant and
# printed that it had done so deliberately; the effect was that the first approved job in
# every fresh install failed, and the self-test could not see it because it never reaches
# the container. Withholding it is still the right destination -- see the note below.
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$GX_SA" \
  --role=roles/datastore.user --condition=None >/dev/null || die "could not grant datastore.user to $GX_SA"

# [SEC-INSTALL-DEV-V1] THE BUILD IDENTITY. `run deploy --source` builds via Cloud Build, which runs as the
# COMPUTE DEFAULT service account. Google no longer auto-grants Editor to it on new projects, so
# it cannot read the source zip Cloud Run just uploaded and step 6 dies with a bare 403. Measured
# on a clean project 2026-08-03.
PROJNUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null)
[ -n "$PROJNUM" ] || die "could not read the project number"
BUILD_SA="serviceAccount:${PROJNUM}-compute@developer.gserviceaccount.com"
# [SEC-PKG-STRANGER-V1] THE BUILD IDENTITY MAY NOT EXIST YET. Google creates the compute default service
# account only after compute.googleapis.com is enabled -- step 1/10 now enables it -- and
# creation lags the enable by up to a minute. Bind to an account that is not there yet and
# the failure text is "does not exist", which retry() classifies as retryable, so you get
# nine backoffs totalling 225 seconds and then a death message about the build identity
# that never mentions the Compute Engine API. Wait for it explicitly instead.
_i=0
while [ "$_i" -lt 12 ]; do
  gcloud iam service-accounts describe "${PROJNUM}-compute@developer.gserviceaccount.com" \
    --project "$PROJECT" >/dev/null 2>&1 && break
  [ "$_i" -eq 0 ] && echo "  waiting for the compute default service account to appear..."
  sleep 10; _i=$((_i+1))
done
[ "$_i" -lt 12 ] || die "the compute default service account
  ${PROJNUM}-compute@developer.gserviceaccount.com
does not exist after two minutes. Cloud Build runs as it, so 'run deploy --source' cannot
build anything without it. Enable the Compute Engine API and re-run this installer:
    gcloud services enable compute.googleapis.com --project $PROJECT"
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="$BUILD_SA" \
  --role=roles/cloudbuild.builds.builder --condition=None >/dev/null || die "could not grant the build identity"
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="$BUILD_SA" \
  --role=roles/storage.objectViewer --condition=None >/dev/null || die "could not grant the build identity storage read"
echo "  build=${PROJNUM}-compute@developer.gserviceaccount.com"
echo "  cp=$CP_SA"
echo "  gx=$GX_SA"
# [SEC-KMSSIGN-INSTALL-V1] THIS BANNER HAS BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS, AND
# THE CODE HAS NOW MOVED UNDER IT AGAIN. The first version claimed the approval signature
# used "a secret this grant does not confer" while step 4/10 was granting the executor
# exactly that secret -- it was false the day it shipped. The correction that followed was
# true then: the MAC is symmetric, the executor held the key it verified with, so it could
# forge its own approvals. BOTH ARE FALSE NOW. Step 5b/10 provisions a Cloud KMS asymmetric
# key; roles/cloudkms.signer goes to the CONTROL PLANE ONLY; the executor gets
# roles/cloudkms.publicKeyViewer, which is a PUBLIC key and cannot sign. The step 4/10
# secretAccessor grant of pc-approval-mac-key to $GX_SA is GONE, and as of
# [SEC-MACFREE-INSTALL-V1] a fresh install does not create that secret at all: neither
# service is handed APPROVAL_MAC_KEY, and gate-exec does not read a symmetric key anywhere.
#
# roles/datastore.user IS STILL GENUINELY REQUIRED and that line below is true as written.
# The executor runs a @firestore.transactional single-use claim, writes a journal entry on
# every path including refusals, and writes executed_at. Firestore IAM has no
# per-collection granularity, so the grant is project-wide. That is a real limitation and
# it is printed as one rather than dressed up as containment.
echo "     Holds roles/datastore.user. Firestore IAM cannot scope a grant to one"
echo "     collection, so this is project-wide. The executor reads the approval it runs"
echo "     and writes back the claim, the journal and the result."
echo "     It holds NO approval-signing secret. Approvals are signed by the control plane"
echo "     with a Cloud KMS PRIVATE key the executor has no permission to use; the executor"
echo "     is given roles/cloudkms.publicKeyViewer only, so it can VERIFY and cannot FORGE."
echo "     What a compromised executor can still do: refuse a job you approved, or corrupt"
echo "     the database record of one. What it cannot do: manufacture an approval you"
echo "     never gave. That is the boundary, stated exactly."

say "4/10 secrets (generated here, create-if-absent, never rotated by a re-run)"
mk() {
  gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1 && { echo "  $1 exists, left alone"; return; }
  openssl rand -base64 32 | tr -d '\n' > "$HERE/.s.tmp"
  retry gcloud secrets create "$1" --replication-policy=automatic --data-file="$HERE/.s.tmp" --project "$PROJECT" >/dev/null
  python3 -c "import os;os.remove('$HERE/.s.tmp')"
  echo "  $1 created"
}
mk pc-session-secret
mk pc-human-confirm-secret
for S in pc-session-secret pc-human-confirm-secret; do
  retry gcloud secrets add-iam-policy-binding "$S" --member="serviceAccount:$CP_SA" \
    --role=roles/secretmanager.secretAccessor --project "$PROJECT" >/dev/null
done
# [SEC-MACFREE-INSTALL-V1] pc-approval-mac-key IS NOT CREATED AND NOT GRANTED HERE AT ALL.
# It used to be created and handed to both services, and the grant to $GX_SA is precisely
# what made the executor a signing oracle for its own approvals. gate-exec has read no
# APPROVAL_MAC_KEY since Stage C, so on a fresh install that secret verified nothing on
# either side -- an unused credential carrying rotation burden and no purpose. A fresh
# install therefore provisions no symmetric approval key at all, and approval integrity
# rests entirely on the Cloud KMS asymmetric signature provisioned in step 5b/10.
#
# THIS IS A FRESH-INSTALL PROPERTY ONLY, AND THE DISTINCTION IS LOAD-BEARING. An EXISTING
# deployment keeps its pc-approval-mac-key and keeps receiving APPROVAL_MAC_KEY: index.ts
# still dual-emits the legacy HMAC beside the KMS signature, re-running this installer never
# deletes a secret, and step 6/10 uses --update-secrets, which adds and updates the keys it
# names without removing a binding it does not name.
#
# WHY LEAVING IT OUT IS SAFE: the emit in index.ts is CONDITIONAL on the variable being
# present -- `const _macKey = process.env.APPROVAL_MAC_KEY || ''` followed by `if (_macKey)`.
# With no key the HMAC is simply not written, the KMS signature is written alone, and the
# approval verifies normally. Nothing throws and nothing downstream reads approval_mac.
# Removing the dual-emit from index.ts is a separate change with a deploy behind it.
#
# Do NOT re-add a $GX_SA binding to "make verification work": verification is asymmetric and
# needs the PUBLIC key, which step 5b/10 grants instead.

say "5/10 reserving the URL (deploy twice, build once)"
# WebAuthn RP ID must equal the host that serves the gate, and the origin allowlist is a
# SEPARATE exact match. Neither is knowable until the service exists. Getting it wrong locks
# you out of your own gate, so: ship a stock image first purely to learn the URL.
gcloud run services describe "$CP_SVC" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
retry gcloud run deploy "$CP_SVC" --image us-docker.pkg.dev/cloudrun/container/hello \
  --region "$REGION" --project "$PROJECT" --service-account "$CP_SA" \
  --allow-unauthenticated --quiet >/dev/null || die "could not reserve the control-plane URL"
CP_URL=$(gcloud run services describe "$CP_SVC" --region "$REGION" --project "$PROJECT" --format='value(status.url)')
[ -n "$CP_URL" ] || die "no control-plane URL"
CP_HOST="${CP_URL#https://}"
echo "  $CP_URL"
echo "  WA_RP_ID=$CP_HOST"

say "5b/10 approval signing key (Cloud KMS, asymmetric -- Stage C)"
# [SEC-KMSSIGN-INSTALL-V1] A FRESH INSTALL SHIPS AT STAGE C. There is nothing to soak: a
# new project has an empty pending_confirms collection, so there is no backlog of
# MAC-only approvals that turning verification on would 403. The staged rollout exists for
# the fleet that is already running; an install that starts today should start finished.
#
# WHAT IS PROVISIONED. One keyring, one key, purpose ASYMMETRIC_SIGN, algorithm
# EC_SIGN_P256_SHA256 -- the algorithm the control plane's pcApprovalCanonV1 signer and
# gate-exec's verifier both hardcode. roles/cloudkms.signer to the CONTROL PLANE, scoped to
# the KEY and not to the project. roles/cloudkms.publicKeyViewer to the EXECUTOR, also
# key-scoped. The executor never receives a capability to sign, which is the entire point.
#
# IDEMPOTENT, AND THE FAILURE MODE THAT MATTERS IS DUPLICATION, NOT ABSENCE. Every lookup
# below captures its return code, because "the query failed" and "the answer is empty" are
# different facts and treating them as one is how a re-run creates a SECOND key while the
# allowlist still names the first. A lookup that FAILS is fatal. A lookup that SUCCEEDS and
# returns nothing is reported and never invented around.
#
# --rehearse SURVIVES WITH NO KMS AT ALL. An unattended rehearsal may run where the KMS API
# is off or the identity cannot administer keys. Under --rehearse a provisioning failure is
# a WARNING: signing is left UNPROVISIONED, both variables stay empty, APPROVAL_REQUIRE_SIGNED
# is never written, and the run continues to the 9/10 boundary. Outside --rehearse it dies.
PC_KMS_KR=paracoding-approvals
PC_KMS_KEY=approval-signing
PC_KMS_OK=1
pc_kms_fail() {
  PC_KMS_OK=0
  if [ "$PC_REHEARSE" = 1 ]; then
    echo "  KMS NOT PROVISIONED: $1"
    echo "  Permitted under --rehearse ONLY. Approval signing is left unprovisioned and"
    echo "  APPROVAL_REQUIRE_SIGNED is never written, so nothing is armed that cannot be met."
  else
    die "could not provision the approval signing key.
  $1
This installer will not continue with approval signing half-built: the control plane would
sign with a key the executor cannot name, or the executor would require a signature nobody
can produce, and either one 403s every gated job including the one that would undo it."
  fi
}
# THE VARIABLES ARE READ FIRST. If the operator supplied either one, that is an explicit
# pin -- a rotation or a migration -- and this installer adopts it and provisions nothing.
# Deriving the allowlist from the singular would make the membership check below
# unfalsifiable, and a check that cannot fail is worse than no check.
PC_SIG_KV="${PC_APPROVAL_SIG_KEY_VERSION-}"
PC_SIG_KVS="${PC_APPROVAL_SIG_KEY_VERSIONS-}"
PC_SIG_REQUIRE=0
if [ -n "$PC_SIG_KV" ] || [ -n "$PC_SIG_KVS" ]; then
  echo "  PC_APPROVAL_SIG_KEY_VERSION/VERSIONS supplied; adopting them, provisioning nothing."
  echo "  APPROVAL_REQUIRE_SIGNED is left to you: set PC_APPROVAL_REQUIRE_SIGNED=1 to arm it."
else
  if ! gcloud kms keyrings describe "$PC_KMS_KR" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
    retry gcloud kms keyrings create "$PC_KMS_KR" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1
    gcloud kms keyrings describe "$PC_KMS_KR" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 \
      || pc_kms_fail "keyring $PC_KMS_KR is still absent in $REGION after a create attempt."
  fi
  # The create rc is deliberately NOT trusted: a concurrent run makes it ALREADY_EXISTS,
  # which is success for our purposes. The DESCRIBE is the authority, and a keyring name is
  # unique within a location, so adopting can never produce a duplicate.
  if [ "$PC_KMS_OK" = 1 ]; then
    if ! gcloud kms keys describe "$PC_KMS_KEY" --keyring "$PC_KMS_KR" --location "$REGION" \
      --project "$PROJECT" >/dev/null 2>&1; then
      retry gcloud kms keys create "$PC_KMS_KEY" --keyring "$PC_KMS_KR" --location "$REGION" \
        --purpose asymmetric-signing --default-algorithm ec-sign-p256-sha256 \
        --project "$PROJECT" >/dev/null 2>&1
      gcloud kms keys describe "$PC_KMS_KEY" --keyring "$PC_KMS_KR" --location "$REGION" \
        --project "$PROJECT" >/dev/null 2>&1 \
        || pc_kms_fail "key $PC_KMS_KEY is still absent on keyring $PC_KMS_KR after a create attempt."
    fi
  fi
  if [ "$PC_KMS_OK" = 1 ]; then
    retry gcloud kms keys add-iam-policy-binding "$PC_KMS_KEY" --keyring "$PC_KMS_KR" \
      --location "$REGION" --project "$PROJECT" --member="serviceAccount:$CP_SA" \
      --role=roles/cloudkms.signer >/dev/null \
      || pc_kms_fail "could not grant roles/cloudkms.signer on $PC_KMS_KEY to $CP_SA."
  fi
  if [ "$PC_KMS_OK" = 1 ]; then
    retry gcloud kms keys add-iam-policy-binding "$PC_KMS_KEY" --keyring "$PC_KMS_KR" \
      --location "$REGION" --project "$PROJECT" --member="serviceAccount:$GX_SA" \
      --role=roles/cloudkms.publicKeyViewer >/dev/null \
      || pc_kms_fail "could not grant roles/cloudkms.publicKeyViewer on $PC_KMS_KEY to $GX_SA."
  fi
  # THE N16 SITE. A key created above already carries version 1, so nothing here ever needs
  # to CREATE a version -- it only needs to FIND one. That asymmetry is the whole defence:
  # if the listing fails we stop, because a failed list is not an empty key, and creating a
  # version to "fix" a permission error is how one install ends up with two signing keys.
  if [ "$PC_KMS_OK" = 1 ]; then
    PC_KV_RC=0
    PC_KV_ALL=$(gcloud kms keys versions list --key "$PC_KMS_KEY" --keyring "$PC_KMS_KR" \
      --location "$REGION" --project "$PROJECT" --filter='state:ENABLED' \
      --format='value(name)' 2>/dev/null) || PC_KV_RC=$?
    if [ "$PC_KV_RC" -ne 0 ]; then
      pc_kms_fail "could not LIST the versions of $PC_KMS_KEY (exit $PC_KV_RC). Refusing to
  create one: a failed query is not an empty key."
    else
      PC_KV=$(printf '%s' "$PC_KV_ALL" | sed -n '1p')
      if [ -z "$PC_KV" ]; then
        PC_KMS_OK=0
        echo "  $PC_KMS_KEY exists but has NO ENABLED VERSION. The listing SUCCEEDED and came"
        echo "  back empty, so this is a state to report, not a resource to invent -- creating"
        echo "  a second version here is exactly the duplication this step refuses to do."
        echo "  Approval signing stays unprovisioned. Enable a version and re-run this installer."
      else
        PC_SIG_KV="$PC_KV"
        PC_SIG_KVS="$PC_KV"
        PC_SIG_REQUIRE=1
        echo "  key      $PC_KMS_KEY on $PC_KMS_KR ($REGION), EC_SIGN_P256_SHA256"
        echo "  signer   $CP_SA"
        echo "  verifier $GX_SA  (roles/cloudkms.publicKeyViewer -- public key only)"
        echo "  version  $PC_SIG_KV"
      fi
    fi
  fi
fi
# An explicit PC_APPROVAL_REQUIRE_SIGNED always wins, in both directions, so an operator can
# arm a hand-pinned key or disarm an auto-provisioned one without editing this script.
case "${PC_APPROVAL_REQUIRE_SIGNED-}" in
  1) PC_SIG_REQUIRE=1 ;;
  0) PC_SIG_REQUIRE=0 ;;
esac

# [SEC-APPROVAL-SIGKEY-PAIR-V1] THE TWO APPROVAL-SIGNING VARIABLES ARE NOT ONE VARIABLE,
# AND THIS CHECK IS THE ONLY THING THAT COMPARES THEM.
#
#   control plane   APPROVAL_SIG_KEY_VERSION    SINGULAR. Exactly one KMS cryptoKeyVersion
#                                               resource name. Read as
#                                               String(process.env... || '') and NOT
#                                               TRIMMED -- this exact string is signed into
#                                               the message and stored on the document.
#   gate executor   APPROVAL_SIG_KEY_VERSIONS   PLURAL. A comma-separated allowlist, and
#                                               every member IS trimmed on read.
#
# The names differ by one letter and they live on two different Cloud Run services. The
# singular must appear CHARACTER FOR CHARACTER as one member of the plural. When it does
# not, the executor answers "unverifiable" and EVERY gated job 403s -- including the job
# that would undo it. It fails closed, so nothing is forged, but the gate is dead.
#
# WHITESPACE IS THE ASYMMETRIC TRAP AND IT IS THE REASON THIS CHECK EXISTS. The signer does
# not trim and the verifier does, so ONE trailing space is SIGNED INTO the message while
# the allowlist entry is stripped. The two never compare equal, and the failure reads like
# an allowlist typo -- blaming the one thing that is not wrong. The check below reports
# whitespace as its own distinct outcome for exactly that reason.
#
# THE ALLOWLIST IS A SEPARATE INPUT, NOT DERIVED FROM THE SINGULAR. Deriving it would make
# the membership test unfalsifiable -- a check that cannot fail is worse than no check --
# and it would also forbid the documented rotation, which is: widen the PLURAL first,
# deploy, confirm, and only then move the singular.
#
# BOTH VALUES ARE ALREADY SET ABOVE -- either from the environment or from the key this
# installer just provisioned -- so this check now runs over the provisioned pair too. It is
# not decoration: the auto-provisioned path assigns the SAME string to both, and this is
# what proves that assignment was not silently reshaped between here and Cloud Run.
if [ -n "$PC_SIG_KV" ] || [ -n "$PC_SIG_KVS" ]; then
  [ -n "$PC_SIG_KV" ] || die "PC_APPROVAL_SIG_KEY_VERSIONS was supplied but
PC_APPROVAL_SIG_KEY_VERSION was not. The control plane signs with exactly ONE key version
and the executor accepts a LIST; set the singular as well, and make it one of the members."
  if [ -z "$PC_SIG_KVS" ]; then PC_SIG_KVS="$PC_SIG_KV"; fi
  PC_SIG_RC=0
  python3 -c 'import sys
kv, allow = sys.argv[1], sys.argv[2]
if kv != kv.strip(): sys.exit(2)
if "," in kv: sys.exit(3)
if "@" in kv or "@" in allow: sys.exit(4)
members = [k.strip() for k in allow.split(",") if k.strip()]
if not members: sys.exit(5)
sys.exit(0 if kv in members else 6)' "$PC_SIG_KV" "$PC_SIG_KVS" || PC_SIG_RC=$?
  case "$PC_SIG_RC" in
    0) : ;;
    2) die "PC_APPROVAL_SIG_KEY_VERSION has leading or trailing whitespace. Strip it. The
control plane signs the value WITHOUT trimming while the executor trims every allowlist
entry, so the padded string gets signed into the message, the stripped one sits in the
allowlist, and they never compare equal. The error you would get instead names the
allowlist, which would be the one thing that is not wrong." ;;
    3) die "PC_APPROVAL_SIG_KEY_VERSION contains a comma. It is a SINGLE key version; the
comma-separated list is PC_APPROVAL_SIG_KEY_VERSIONS." ;;
    4) die "PC_APPROVAL_SIG_KEY_VERSION or PC_APPROVAL_SIG_KEY_VERSIONS contains '@'. That
character is used as the delimiter when these are written to Cloud Run, because the
allowlist itself contains commas. A KMS cryptoKeyVersion resource name never contains '@'." ;;
    5) die "PC_APPROVAL_SIG_KEY_VERSIONS has no usable members." ;;
    *) die "PC_APPROVAL_SIG_KEY_VERSION is not a member of PC_APPROVAL_SIG_KEY_VERSIONS.
The control plane would sign with a key version the executor does not accept, and EVERY
gated job would 403 -- including the job that would undo it. Add it to the list.
    singular: $PC_SIG_KV
    allowlist: $PC_SIG_KVS" ;;
  esac
  echo "  approval signing key version checked: singular is a member of the allowlist"
fi
say "6/10 building and deploying the control plane"
retry gcloud run deploy "$CP_SVC" --source "$HERE/control-plane" --region "$REGION" --project "$PROJECT" \
  --service-account "$CP_SA" --allow-unauthenticated --clear-base-image --quiet \
  --set-env-vars "WA_RP_ID=$CP_HOST,WA_RP_ORIGIN=https://$CP_HOST,MCP_PUBLIC_URL=$CP_URL,OAUTH_DEFAULT_ROLE=fleet-onboarder,PC_FIRESTORE_DB=$FSDB,PC_IAP_AUD=/projects/$PROJNUM/locations/$REGION/services/$CP_SVC,PC_REQUIRE_PASSKEY=1,PC_SESSION_ENFORCE=1,PC_KEY_TTL_DAYS=7,PC_TOOLS_ENFORCE=1,WA_APPROVER_EMAILS=$ACCT,WA_SESSION_MIN=240" \
  --update-secrets "WA_SESSION_SECRET=pc-session-secret:latest,HUMAN_CONFIRM_SECRET=pc-human-confirm-secret:latest" \
  >/dev/null || die "control-plane deploy failed"
echo "  deployed"

say "7/10 gated executor (private) "
# [SEC-ASSERTION-NOT-YET-V1] Ships DISARMED on purpose. gate-exec demands a per-job
# WebAuthn assertion when PC_REQUIRE_ASSERTION is 1, and the control plane does not forward
# one yet, so arming it refuses EVERY approval with HTTP 428 -- a gate that can never run
# anything. Proven end-to-end 2026-08-05. Flip to 1 in the same commit that adds forwarding.
#
# [SEC-INSTALL-STEP7-V1] THIS COMMENT LIVES ABOVE THE COMMAND, NOT INSIDE IT. It used to sit
# between two backslash-continued argument lines. The continuation joined the comment line,
# the # swallowed the trailing backslash, the deploy ended early WITHOUT --set-env-vars, and
# the next line ran as its own command: "--set-env-vars: command not found" -> die -> exit 1.
# Step 7 failed on every single install. bash -n does not catch it. Never put a comment
# inside a continued command.
#
# [SEC-KMSSIGN-INSTALL-V1] NO --update-secrets LINE. gate-exec used to be handed
# APPROVAL_MAC_KEY=pc-approval-mac-key:latest here. exec_server.py no longer reads that
# variable at all -- it verifies with a KMS PUBLIC key -- and handing a verifier the
# minting key was the Stage A hole. As of [SEC-MACFREE-INSTALL-V1] a fresh install does not
# create that secret at all, so there is nothing to hand to either service; an existing
# deployment keeps the secret and the control plane's binding to it.
retry gcloud run deploy "$GX_SVC" --source "$HERE/gate-exec" --region "$REGION" --project "$PROJECT" \
  --service-account "$GX_SA" --no-allow-unauthenticated --quiet \
  --set-env-vars "PC_REQUIRE_ASSERTION=0,PC_FIRESTORE_DB=$FSDB,PC_CREDS_SECRET=projects/$PROJECT/secrets/pc-webauthn-creds" \
  >/dev/null || die "gate-exec deploy failed"
# [SEC-INSTALL-IAP-V1] PC_REQUIRE_ASSERTION is set HERE, at install, deliberately.
# It defaults to OFF in code, which means any redeploy that forgets it silently disables
# the executor's independent approval check. That is exactly what happened during
# testing on 2026-08-04: an uninstall/reinstall cycle dropped every PC_* variable and the
# control turned itself off without a word. A security control that is off unless someone
# remembers a flag is a control that will be off. The default should flip to ON in code
# once the control plane forwards assertions; until then the installer must set it.
retry gcloud run services add-iam-policy-binding "$GX_SVC" --region "$REGION" --project "$PROJECT" \
  --member="serviceAccount:$CP_SA" --role=roles/run.invoker >/dev/null
GX_URL=$(gcloud run services describe "$GX_SVC" --region "$REGION" --project "$PROJECT" --format='value(status.url)')
# [SEC-INSTALL-GXURL-V1] THE N16 SIBLING THAT ACTUALLY MUTATES. There is no set -e, so a
# failed describe leaves GX_URL EMPTY and execution walks straight into the update below --
# which WRITES that empty string into the live control plane as GATE_EXEC_URL. The result is
# a deployed control plane that cannot reach its executor: every gated job fails at dispatch,
# and 10/10 reports it as "executor is private" got 000, blaming the executor's IAM for a URL
# that was never read. Same class as the Firestore probe at 2/10 and the same answer.
# EMPTY IS FATAL HERE AND THAT IS NOT THE N12 MISTAKE. N12 was fatal-on-empty over a verb
# that DID NOT EXIST, so empty was always. This verb demonstrably works in this very script:
# the identical `run services describe` shape runs at 5/10 for $CP_SVC and its result is
# ALREADY asserted non-empty there -- had empty been the always-case, that line would have
# bricked every install long ago. And $GX_SVC was deployed at 7/10 and IAM-bound two lines
# up by this same caller, so empty here is a real failure, never the normal state.
[ -n "$GX_URL" ] || die "could not read the gate-exec URL ('gcloud run services describe
$GX_SVC' returned nothing). Refusing to continue, because the next command writes this value
into the control plane as GATE_EXEC_URL, and writing it EMPTY leaves you with a control plane
that cannot reach its executor -- no gated job can ever run. Check the service, then re-run:
    gcloud run services describe $GX_SVC --region $REGION --project $PROJECT"
retry gcloud run services update "$CP_SVC" --region "$REGION" --project "$PROJECT" \
  --update-env-vars "GATE_EXEC_URL=$GX_URL" >/dev/null
echo "  $GX_URL  (private; only the control plane may call it)"
# [SEC-APPROVAL-SIGKEY-PAIR-V1] Written HERE, after both services exist, and as their own
# update commands rather than folded into the --set-env-vars strings above. The allowlist
# legitimately CONTAINS COMMAS, and a comma inside a --set-env-vars value is a separator,
# so it would be silently split into junk keys. The ^@^ prefix is gcloud's alternate
# delimiter for exactly this, and '@' is rejected in the values above so the delimiter can
# never be part of the data.
#
# ORDER IS THE ROTATION ORDER: the executor's allowlist is widened FIRST and the control
# plane's single version is pinned SECOND. Doing it the other way round refuses every
# approval signed in the window between the two deploys.
if [ -n "$PC_SIG_KV" ]; then
  retry gcloud run services update "$GX_SVC" --region "$REGION" --project "$PROJECT" \
    --update-env-vars "^@^APPROVAL_SIG_KEY_VERSIONS=$PC_SIG_KVS" >/dev/null \
    || die "could not set APPROVAL_SIG_KEY_VERSIONS on $GX_SVC"
  retry gcloud run services update "$CP_SVC" --region "$REGION" --project "$PROJECT" \
    --update-env-vars "^@^APPROVAL_SIG_KEY_VERSION=$PC_SIG_KV" >/dev/null \
    || die "could not set APPROVAL_SIG_KEY_VERSION on $CP_SVC"
  echo "  approval signing: allowlist set on $GX_SVC, then key version pinned on $CP_SVC"
  echo "  READ BOTH BACK off the serving revisions before trusting them."
  # ARMED LAST, AND ONLY LAST. APPROVAL_REQUIRE_SIGNED turns the executor's "absent" rung
  # from allow into refuse. Writing it before the two updates above would refuse every
  # approval in the window where the requirement exists and the signature does not. It is
  # written only inside this branch, so a run that could not provision a key -- a rehearsal
  # with no KMS, say -- can never arm a requirement it has not made satisfiable.
  if [ "$PC_SIG_REQUIRE" = 1 ]; then
    retry gcloud run services update "$GX_SVC" --region "$REGION" --project "$PROJECT" \
      --update-env-vars "APPROVAL_REQUIRE_SIGNED=1" >/dev/null \
      || die "could not set APPROVAL_REQUIRE_SIGNED on $GX_SVC"
    echo "  APPROVAL_REQUIRE_SIGNED=1 -- an approval carrying NO signature is now REFUSED."
    echo "  A fresh install has no unsigned approvals to break, so this costs you nothing."
  else
    echo "  APPROVAL_REQUIRE_SIGNED left unset (permissive: an UNSIGNED approval is allowed,"
    echo "  a BAD or UNVERIFIABLE one is always refused). Arm it once you have seen a signed"
    echo "  approval execute:  --update-env-vars APPROVAL_REQUIRE_SIGNED=1  on $GX_SVC"
  fi
fi

say "8/10 putting the console behind Google (IAP)"
# [SEC-INSTALL-IAP-V1] IAP authenticates a real human at Google's edge before a single byte reaches
# this app -- and it uses a GOOGLE-MANAGED OAuth client, so there is no consent screen to
# configure and no client to create. That is what makes this install one command.
#
# TWO APIs ARE REQUIRED, and the second one is not obvious: without cloudresourcemanager the
# access binding fails with a bare SERVICE_DISABLED and no hint. Learned the hard way.
retry gcloud services enable iap.googleapis.com cloudresourcemanager.googleapis.com \
  --project "$PROJECT" >/dev/null || die "could not enable the IAP APIs"
if gcloud beta run services update "$CP_SVC" --region "$REGION" --project "$PROJECT" --iap --quiet >/dev/null 2>&1; then
  # The access grant goes on the IAP resource, NOT on the Run service. Granting
  # roles/iap.httpsResourceAccessor via `run services add-iam-policy-binding` is rejected.
  # [SEC-IAP-MEMBER-TYPE-V1] The principal type must MATCH the identity, and "user:" was
  # hardcoded. An IAM member is TYPE:EMAIL, and Google rejects the pair outright rather
  # than ignoring it: 'INVALID_ARGUMENT: Principal ... is of type "serviceAccount". The
  # principal should appear as "serviceAccount:..."'. Measured at step 8/10 in build
  # 692c3bdd, which is the first run in the installer's life to reach this line.
  # Outside rehearsal step 0/10 refuses a service account, so a real install always took
  # the "user:" branch and this was never wrong for a human -- which is exactly why it
  # survived. It is still a latent defect: the string was asserted, not derived.
  case "$ACCT" in
    *gserviceaccount.com) PC_IAP_MEMBER="serviceAccount:$ACCT" ;;
    *)                    PC_IAP_MEMBER="user:$ACCT" ;;
  esac
  retry gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service="$CP_SVC" \
    --region="$REGION" --project="$PROJECT" --member="$PC_IAP_MEMBER" \
    --role=roles/iap.httpsResourceAccessor >/dev/null \
    || die "IAP is on but $ACCT was not granted access -- you would be locked out. Grant it and re-run."
  echo "  the console is behind IAP. only $ACCT can reach it."
else
  # Projects outside an Organization may need IAP switched on once in the console first.
  echo "  COULD NOT ENABLE IAP AUTOMATICALLY."
  echo "  This usually means this project is not in a Google Cloud Organization."
  echo "  The install continues and everything works, but your console is reachable by anyone"
  echo "  who has the URL until you enable IAP yourself:"
  echo "    https://console.cloud.google.com/run/detail/$REGION/$CP_SVC/security?project=$PROJECT"
fi

# [SEC-REHEARSE-V1] THE BOUNDARY. This sits ABOVE `say "9/10 ..."` on purpose, so in
# rehearsal mode step 9 never begins and pc-bootstrap-secret is never minted -- no
# bootstrap window is left open by a run nobody is watching. Exit 20 is distinct from 1
# (a step genuinely failed) and from 0 (a human completed the install). Conflating those
# is what makes a rehearsal useless.
if [ "$PC_REHEARSE" = 1 ]; then
  printf '##PCSTEP OK %s\n' "$PC_STEP"
  printf '##PCREHEARSAL BOUNDARY 9/10 register-your-passkey NEEDS-A-HUMAN\n'
  printf '\n  REHEARSAL COMPLETE -- steps 0/10 through 8/10 ran with no human.\n'
  printf '  Stopping here. Step 9/10 opens a browser to register a passkey and there is\n'
  printf '  no way to do that without you. Re-run WITHOUT --rehearse to finish.\n\n'
  exit 20
fi
say "9/10 register your passkey"
BOOT=$(openssl rand -hex 24)
printf '%s' "$BOOT" > "$HERE/.b.tmp"
gcloud secrets describe pc-bootstrap-secret --project "$PROJECT" >/dev/null 2>&1 \
  && retry gcloud secrets versions add pc-bootstrap-secret --data-file="$HERE/.b.tmp" --project "$PROJECT" >/dev/null \
  || retry gcloud secrets create pc-bootstrap-secret --replication-policy=automatic --data-file="$HERE/.b.tmp" --project "$PROJECT" >/dev/null
python3 -c "import os;os.remove('$HERE/.b.tmp')"
retry gcloud secrets add-iam-policy-binding pc-bootstrap-secret --member="serviceAccount:$CP_SA" \
  --role=roles/secretmanager.secretAccessor --project "$PROJECT" >/dev/null
retry gcloud run services update "$CP_SVC" --region "$REGION" --project "$PROJECT" \
  --update-secrets "WA_BOOTSTRAP_SECRET=pc-bootstrap-secret:latest" >/dev/null
cat <<EOF

  Open this on a device with Face ID, Touch ID, or a security key:

      ${CP_URL}/gate?setup=${BOOT}

  Register your passkey. Until you do, nothing privileged can run -- including anything
  that would fix a bad install. When you are done, press ENTER here and this window closes.

EOF
printf '  waiting... press ENTER once you have registered: '
read _ignored || true
retry gcloud run services update "$CP_SVC" --region "$REGION" --project "$PROJECT" \
  --remove-secrets WA_BOOTSTRAP_SECRET >/dev/null 2>&1
echo "  bootstrap window closed"

say "10/10 self-test"
FAIL=0
chk() { # name expected actual
  if [ "$2" = "$3" ]; then printf '  ok   %-38s %s\n' "$1" "$3"
  else printf '  FAIL %-38s got %s want %s\n' "$1" "$3" "$2"; FAIL=$((FAIL+1)); fi
}
chk_in() {
  for _e in $2; do if [ "$_e" = "$3" ]; then printf '  ok   %-38s %s\n' "$1" "$3"; return; fi; done
  printf '  FAIL %-38s got %s want one of [%s]\n' "$1" "$3" "$2"; FAIL=$((FAIL+1))
}
chk_has() {
  case "$3" in *"$2"*) printf '  ok   %-38s %s\n' "$1" "$2" ;;
    *) printf '  FAIL %-38s %s not found\n' "$1" "$2"; FAIL=$((FAIL+1)) ;; esac
}
# [SEC-IAP-SELFTEST-V1] With IAP in front NOTHING unauthenticated reaches the app. The old
# checks asserted the app answered anonymously -- which IAP now correctly prevents -- so a
# healthy install reported as broken. These assert IAP is ENFORCING, which is stronger.
chk_in  "gate is behind IAP" "302 303" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$CP_URL/gate")"
chk_has "gate redirects to Google" "accounts.google.com" "$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 30 "$CP_URL/gate")"
chk_has "/ redirects to Google" "accounts.google.com" "$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 30 "$CP_URL/")"
chk "MCP requires a token"   401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H 'Content-Type: application/json' -d '{}' "$CP_URL/mcp")"
chk_in "executor is private" "403 404" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$GX_URL/healthz")"
# Security headers come from OUR app. Behind IAP an anonymous fetch returns IAPs redirect,
# not our response, so they cannot be read from here. Report honestly instead of failing.
printf '  --   %-38s %s\n' "app security headers" "not checkable anonymously behind IAP"

# [SEC-PKG-STRANGER-V1] Resolve the Agent Plugins manifest against the URL we only now know. Written to
# agent-plugin.local/, NOT over agent-plugin/: the shipped copy is in MANIFEST.txt and
# editing a manifested file in place is exactly the drift this release refuses to allow.
if [ -d "$HERE/agent-plugin" ]; then
  mkdir -p "$HERE/agent-plugin.local"
  cp "$HERE/agent-plugin/plugin.json" "$HERE/agent-plugin.local/plugin.json" 2>/dev/null
  cp "$HERE/agent-plugin/README.md" "$HERE/agent-plugin.local/README.md" 2>/dev/null
  sed "s#https://REPLACE-WITH-YOUR-CONTROL-PLANE-HOST#${CP_URL}#" \
    "$HERE/agent-plugin/mcp.json" > "$HERE/agent-plugin.local/mcp.json" 2>/dev/null \
    && printf '  --   %-38s %s\n' "agent plugin resolved" "agent-plugin.local/mcp.json" \
    || printf '  --   %-38s %s\n' "agent plugin" "could not be resolved; edit mcp.json by hand"
fi
echo
if [ "$FAIL" -eq 0 ]; then
cat <<EOF
  INSTALL COMPLETE.

    console   ${CP_URL}/gate
    MCP URL   ${CP_URL}/mcp

  Model buses are OFF by default (fleet_mode=home), so this spends nothing until you turn
  one on. Approvals are signed with a Cloud KMS asymmetric key (EC_SIGN_P256_SHA256). The
  PRIVATE key is usable only by the control plane; the gated executor is given the PUBLIC
  key and nothing else, so it can verify an approval and cannot manufacture one. A
  compromised executor can refuse work or corrupt the record of it -- it cannot forge your
  consent. See the gx= note above for what is still project-wide and why.

  IDENTITY ENFORCEMENT IS ON (PC_SESSION_ENFORCE=1). A chat that presents no session key
  gets NO fleet tools -- only whoami, which explains itself. That is deliberate: this
  MCP connector is account-level, so without a key every chat on your account resolves
  to the same identity.

  So your next step is:  open ${CP_URL}/pastes , mint a key for a strain, and paste the
  block it gives you into a new chat. The key is shown ONCE -- only its hash is stored.
  Keys expire after 7 days (PC_KEY_TTL_DAYS); when one lapses the chat is told so and
  you mint a fresh paste.

  To use this from an agent client that is not this console, point it at the Agent Plugins
  package written beside the release just now:

      ${HERE}/agent-plugin.local/

  Read README.md in this release for what install.sh does NOT provision -- the data lake
  bucket, the VM tools and the browser tools all register and then fail without backing
  infrastructure you supply yourself. That is a boundary, and it is written down.
EOF
else
  echo "  $FAIL CHECK(S) FAILED. The install is NOT good. Nothing above lies to you about that."
  exit 1
fi
