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
# [SEC-SURFACE-SPLIT-V1] TWO CLOUD RUN SERVICES FROM ONE IMAGE, BECAUSE IAP IS ONE SWITCH
# PER SERVICE. The console (gate, dash, harness, flow, wiki) is the bootstrap path into a
# brand-new install -- it is how you reach the gate BEFORE any passkey exists -- so it sits
# BEHIND IAP. The MCP surface must NOT: IAP consumes the Authorization header and an MCP
# client has no Google identity to present, so with IAP on, POST /mcp is refused at the edge
# and no connector can ever reach the app. One service cannot be both. Two were shipped
# wrong before this: one service with IAP ON (MCP unreachable), then IAP OFF entirely
# (bootstrap destroyed). This is the third option and the only correct one.
#
# THE CONSOLE KEEPS THE OLD SERVICE NAME AND THAT IS NOT COSMETIC. WA_RP_ID is the WebAuthn
# Relying Party ID and a registered passkey is bound to it. Moving the console to a new
# service would change its *.run.app host, change WA_RP_ID, and INVALIDATE EVERY PASSKEY
# ALREADY REGISTERED on an upgrade -- locking the operator out of their own gate with no way
# back in. PC_IAP_AUD names this service too. So the console is $CP_SVC, unchanged, and the
# NEW service is the MCP one: re-pointing a connector URL is a copy and paste, and that is
# the cost this direction pays instead.
CP_SVC=paracoding-control-plane
MC_SVC=paracoding-mcp
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
#   iap                  -- step 8/10 puts the CONSOLE behind Identity-Aware Proxy. Enabled
#                           here for the same reason cloudresourcemanager is: one wait, and
#                           a failure that names the API before anything has been deployed.
#                           Without it 'gcloud beta run services update --iap' fails with a
#                           bare SERVICE_DISABLED at the step that protects your console.
#   serviceusage         -- this very command needs it on projects where it is not on by
#                           default. A chicken-and-egg the retry loop cannot solve.
#
# [SEC-MINTER-REMOVE-V1] iamcredentials.googleapis.com IS NO LONGER ENABLED, AND ITS ABSENCE
# IS THE FIX RATHER THAN AN OVERSIGHT. It was here for ONE caller: gate-exec/pcmint.py's
# :generateAccessToken, the last rung of a KMS -> JWT -> STS -> impersonate chain that also
# needed a Workload Identity pool, PC_KMS_KEY and PC_EXEC_SA. This installer created none of
# those three and never referenced them, no execution path ever called the chain -- approved
# jobs run on the APPROVER's OAuth token -- and the executor's /selftest therefore reported
# mint:{ok:false} on every install that has ever shipped. The chain is deleted from
# pcmint.py, so this API was left enabled for nothing, which is the unused-credential
# pattern the approval-MAC key already cost this fleet once.
# NOTHING ELSE IN THE EMITTED TREE NEEDS IT. index.ts's only :generateAccessToken call is
# inside dev_api, which this generator strips from the emitted tree; the one remaining match
# is a substring in the danger-classifier regex, which tests a URL and calls nothing.
retry gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com logging.googleapis.com \
  compute.googleapis.com cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
  cloudkms.googleapis.com iap.googleapis.com \
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
say "2b/10 Firestore indexes for the memory, history and queue tools"
PC_IDX_FAIL=0
PC_IDX_N=0
# [SEC-TOOLINFRA-V3-M5] THE THIRD FIELD-CONFIG, AND WHY ITS ABSENCE HID AN INDEX.
# This helper took EXACTLY TWO field-configs. The index POST /api/queue/claim needs --
# work_items(assigned_role, status, created_at), an orderBy on a THIRD field -- could
# therefore not be written here at all. It was not judged unnecessary and dropped; the
# helper had no way to say it, so nobody said it. "${5:-}" is what keeps every existing
# two-field call byte-identical in behaviour under set -u.
#
# ALREADY-EXISTS IS NOT REFUSED, AND PRINTING ONE LINE FOR BOTH IS THE N16 CLASS.
# The old branch printed NOT MADE for a re-run and for a genuine permission failure alike
# and counted both, so the only honest thing the counter could say was "expected on a
# re-run" -- which trains the reader to ignore it. They are now discriminated on
# Firestore's own error text: only a REFUSAL counts, and the refusal is reprinted verbatim.
pc_index() { # collection-group query-scope field1,order field2,order [field3,order]
  PC_IDX_N=$((PC_IDX_N+1))
  _pc_f3=""
  _pc_lbl="${3%%,*}+${4%%,*}"
  if [ -n "${5:-}" ]; then
    _pc_f3="--field-config=field-path=${5%%,*},order=${5#*,}"
    _pc_lbl="$_pc_lbl+${5%%,*}"
  fi
  _pc_out=$(gcloud firestore indexes composite create \
    --collection-group="$1" --query-scope="$2" \
    --field-config=field-path="${3%%,*}",order="${3#*,}" \
    --field-config=field-path="${4%%,*}",order="${4#*,}" \
    $_pc_f3 \
    --database="$FSDB" --project "$PROJECT" --async 2>&1)
  _pc_rc=$?
  if [ "$_pc_rc" -eq 0 ]; then
    printf '  requested  %-17s %s\n' "$1" "$_pc_lbl"
    return 0
  fi
  case "$_pc_out" in
    *ALREADY_EXISTS*|*"already exists"*)
      printf '  exists     %-17s %s\n' "$1" "$_pc_lbl" ;;
    *)
      printf '  REFUSED    %-17s %s\n' "$1" "$_pc_lbl"
      printf '%s\n' "$_pc_out" | sed 's/^/             /'
      PC_IDX_FAIL=$((PC_IDX_FAIL+1)) ;;
  esac
}
# SIX INVOCATIONS. Count the CALLS, never a grep. The gcloud line lives once, inside the
# helper, so grepping for it reports 1 whatever the real number of indexes is. That is how
# two of these stayed missing through an audit that read the file carefully.
#   memory_relations scope+to  is the literal sibling of scope+from one line above it.
#   index.ts open_nodes queries scope+from AND THEN scope+to; only the first was indexed,
#   so open_nodes threw FAILED_PRECONDITION on its second query -- the same defect the
#   memory work already paid to fix, one line below where it was fixed.
#   work_items is the three-field one described above.
pc_index observations     COLLECTION_GROUP status,ascending    createdAt,descending
pc_index memory_entities  COLLECTION       scope,ascending     entityType,ascending
pc_index memory_relations COLLECTION       scope,ascending     from,ascending
pc_index memory_relations COLLECTION       scope,ascending     to,ascending
pc_index chat_history     COLLECTION       agent_id,ascending  timestamp,descending
pc_index work_items       COLLECTION       assigned_role,ascending status,ascending created_at,ascending
if [ "$PC_IDX_FAIL" -eq 0 ]; then
  echo "  $PC_IDX_N requested or already present; they build in the background"
else
  echo "  NOTE: $PC_IDX_FAIL of $PC_IDX_N index requests were REFUSED. The text above is"
  echo "        Firestore's own. An index that ALREADY EXISTS is reported as 'exists' and is"
  echo "        NOT counted here, so this line means a real failure and not a re-run."
fi
echo "  ACCEPTANCE IS NOT EXISTENCE. Step 8b/10 re-reads the live index list off the"
echo "  database and fails the install if one of the $PC_IDX_N is missing."

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
# [SEC-CREDSTORE-V1] pc-webauthn-creds HAS TO EXIST AND THE EXECUTOR HAS TO BE ABLE TO READ IT.
# Step 7/10 has always set PC_CREDS_SECRET=projects/$PROJECT/secrets/pc-webauthn-creds on the
# executor, and NOTHING EVER CREATED THAT SECRET OR GRANTED ACCESS TO IT. gate-exec/pcmint.py
# load_creds() wraps the Secret Manager read in a bare `except Exception: return {}`, and
# exec_server.py reads {} as "no enrolled credentials to verify against" and answers 403. So the
# variable pointed at nothing and the failure would have read as an empty credential store
# rather than as a secret that was never made.
# IT IS INERT TODAY ONLY BECAUSE THE SAME STEP SHIPS PC_REQUIRE_ASSERTION=0. The moment anyone
# arms the assertion check, every approval 403s -- including the one that would disarm it.
# THE PAYLOAD IS THE EMPTY JSON OBJECT, NOT A RANDOM STRING, so mk() above is deliberately not
# reused: load_creds() json.loads() this value, and 32 bytes of base64 noise raises instead of
# parsing. Enrolment adds a VERSION; this only has to be valid JSON that means "nobody yet".
if gcloud secrets describe pc-webauthn-creds --project "$PROJECT" >/dev/null 2>&1; then
  echo "  pc-webauthn-creds exists, left alone"
else
  printf '{}' > "$HERE/.c.tmp"
  PC_CS_RC=0
  retry gcloud secrets create pc-webauthn-creds --replication-policy=automatic \
    --data-file="$HERE/.c.tmp" --project "$PROJECT" >/dev/null || PC_CS_RC=$?
  python3 -c "import os;os.remove('$HERE/.c.tmp')"
  [ "$PC_CS_RC" -eq 0 ] || die "could not create the secret pc-webauthn-creds (exit $PC_CS_RC).
Step 7/10 names it in PC_CREDS_SECRET on the executor, so leaving it absent ships a deployment
whose independent approval check can never be armed."
  echo "  pc-webauthn-creds created (empty enrolment, {})"
fi
retry gcloud secrets add-iam-policy-binding pc-webauthn-creds --member="serviceAccount:$GX_SA" \
  --role=roles/secretmanager.secretAccessor --project "$PROJECT" >/dev/null \
  || die "could not grant $GX_SA secretAccessor on pc-webauthn-creds. The executor is the ONLY
service that may read it -- deliberately not the control plane, which could otherwise enrol its
own key and then forge assertions against itself."
echo "  pc-webauthn-creds -> $GX_SA (secretAccessor, THAT SECRET ONLY; the control plane is"
echo "  not granted it, which is what makes verification in the executor mean anything)"
echo "  It starts EMPTY. That is why 7/10 still ships PC_REQUIRE_ASSERTION=0: arming the"
echo "  assertion check before a credential is enrolled refuses every approval."
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

say "5/10 reserving the URLs (deploy twice, build once)"
# WebAuthn RP ID must equal the host that serves the gate, and the origin allowlist is a
# SEPARATE exact match. Neither is knowable until the service exists. Getting it wrong locks
# you out of your own gate, so: ship a stock image first purely to learn the URL.
#
# [SEC-SURFACE-SPLIT-V1] BOTH URLs ARE RESERVED HERE, NOT ONE. The MCP service's URL is not a
# convenience: oaPubBase() in index.ts resolves MCP_PUBLIC_URL first and only falls back to
# req.get('host'), so whatever is set there is what OAuth discovery hands to every connector.
# It MUST be the MCP service's own address. Reserving it now means step 6/10 can set the
# right value on the first deploy instead of correcting it afterwards.
gcloud run services describe "$CP_SVC" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
retry gcloud run deploy "$CP_SVC" --image us-docker.pkg.dev/cloudrun/container/hello \
  --region "$REGION" --project "$PROJECT" --service-account "$CP_SA" \
  --allow-unauthenticated --quiet >/dev/null || die "could not reserve the console URL"
CP_URL=$(gcloud run services describe "$CP_SVC" --region "$REGION" --project "$PROJECT" --format='value(status.url)')
[ -n "$CP_URL" ] || die "no console URL"
CP_HOST="${CP_URL#https://}"
gcloud run services describe "$MC_SVC" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
retry gcloud run deploy "$MC_SVC" --image us-docker.pkg.dev/cloudrun/container/hello \
  --region "$REGION" --project "$PROJECT" --service-account "$CP_SA" \
  --allow-unauthenticated --quiet >/dev/null || die "could not reserve the MCP URL"
MC_URL=$(gcloud run services describe "$MC_SVC" --region "$REGION" --project "$PROJECT" --format='value(status.url)')
[ -n "$MC_URL" ] || die "no MCP URL. Refusing to continue: step 6/10 writes this value into
both services as MCP_PUBLIC_URL, and writing it EMPTY makes oaPubBase() fall back to whatever
Host header a caller sends -- which is an open redirect in your OAuth discovery document.
Check the service, then re-run:
    gcloud run services describe $MC_SVC --region $REGION --project $PROJECT"
MC_HOST="${MC_URL#https://}"
echo "  console $CP_URL"
echo "  mcp     $MC_URL"
echo "  WA_RP_ID=$CP_HOST  (the gate is served by the console, so the RP ID is its host)"

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
say "5c/10 the data lake bucket"
# [SEC-LAKE-BUCKET-V1] THE DEFECT THAT PULLED v3 BACK. control-plane/src/index.ts registers
# read_file, write_file, put_file and list_files against ONE bucket and this installer created
# no bucket and set no variable, so all four tools registered and then answered
# "data lake not configured (DATA_LAKE_BUCKET unset)". The PCV1 encryption-at-rest stack sat on
# top of that, pointed at nothing.
#
# DATA_LAKE_BUCKET IS THE VARIABLE THE CODE ACTUALLY READS, AND THAT IS MEASURED, NOT ASSUMED.
# index.ts:64  const DATA_LAKE_BUCKET = process.env.DATA_LAKE_BUCKET || ''
# index.ts:1190 const lake = DATA_LAKE_BUCKET ? getStorage().bucket(DATA_LAKE_BUCKET) : null
# LAKE_BUCKET EXISTS TOO AND THE FOUR TOOLS NEVER READ IT. It only feeds PC_LAKE at index.ts:84,
# which appears solely as the SECOND rung of `process.env.DATA_LAKE_BUCKET || PC_LAKE` on the
# vault and git-object paths. Precedence is therefore DATA_LAKE_BUCKET, then LAKE_BUCKET, then
# "<project>-datalake" -- and setting LAKE_BUCKET alone would leave every lake tool dead while
# looking configured. This step sets the FIRST rung.
#
# THE NAME IS DERIVED FROM THE PROJECT so a re-run ADOPTS rather than making a second lake, and
# it is deliberately the same string PC_LAKE would have fallen back to, so the two rungs of that
# precedence can never disagree with each other.
PC_LAKE_BUCKET="${PROJECT}-datalake"
if gcloud storage buckets describe "gs://$PC_LAKE_BUCKET" --project "$PROJECT" >/dev/null 2>&1; then
  echo "  adopting gs://$PC_LAKE_BUCKET"
else
  PC_LB_RC=0
  retry gcloud storage buckets create "gs://$PC_LAKE_BUCKET" --project "$PROJECT" \
    --location="$REGION" --uniform-bucket-level-access --public-access-prevention >/dev/null \
    || PC_LB_RC=$?
  gcloud storage buckets describe "gs://$PC_LAKE_BUCKET" --project "$PROJECT" >/dev/null 2>&1 \
    || die "the data lake bucket gs://$PC_LAKE_BUCKET is still absent after a create attempt
(exit $PC_LB_RC). BUCKET NAMES ARE GLOBALLY UNIQUE, so the likeliest cause is that this exact
name already belongs to somebody else's project -- in which case create returns 409 and describe
returns 403, and no re-run of this installer will ever fix it. Create a bucket of your own in
$REGION with uniform bucket-level access and public access prevented, grant
roles/storage.objectAdmin on it to
$CP_SA, and set its name on the control plane yourself:
    gcloud run services update $CP_SVC --region $REGION --project $PROJECT \
      --update-env-vars DATA_LAKE_BUCKET=<your-bucket>
    gcloud run services update $MC_SVC --region $REGION --project $PROJECT \
      --update-env-vars DATA_LAKE_BUCKET=<your-bucket>
BOTH services need it: the console renders the lake and the MCP service serves the lake tools.
DATA_LAKE_BUCKET is the variable the lake tools read; LAKE_BUCKET is NOT a substitute.
Refusing to coin a second name here: a lake whose name is not derivable from the project id
is a lake the next run of this installer cannot find, and it would quietly create another."
  echo "  created gs://$PC_LAKE_BUCKET in $REGION"
fi
# The create rc is deliberately NOT trusted, exactly as at 5b/10: a concurrent run makes it a
# 409, which is success for our purposes. The DESCRIBE above is the authority, and the name is a
# pure function of the project, so adopting can never produce a duplicate.
#
# THE SETTINGS ARE RE-ASSERTED ON EVERY RUN, INCLUDING AN ADOPTED BUCKET. A bucket this
# installer made earlier is already right; a bucket an operator made by hand may not be, and a
# lake with per-object ACLs or public access is not something to discover later.
retry gcloud storage buckets update "gs://$PC_LAKE_BUCKET" --project "$PROJECT" \
  --uniform-bucket-level-access --public-access-prevention >/dev/null \
  || die "could not enforce uniform bucket-level access and public access prevention on
gs://$PC_LAKE_BUCKET. Refusing to point the control plane at a lake whose access model is
unknown."
# roles/storage.objectAdmin ON THIS BUCKET ONLY -- never the project-wide role. The control
# plane reads, writes and deletes lake objects and does nothing else with Cloud Storage.
# --condition=None is not decoration: against a policy that already CONTAINS a condition,
# gcloud refuses an unconditioned binding non-interactively, and an adopted bucket may well
# carry one.
retry gcloud storage buckets add-iam-policy-binding "gs://$PC_LAKE_BUCKET" --project "$PROJECT" \
  --member="serviceAccount:$CP_SA" --role=roles/storage.objectAdmin --condition=None >/dev/null \
  || die "could not grant roles/storage.objectAdmin on gs://$PC_LAKE_BUCKET to $CP_SA."
echo "  uniform bucket-level access ON, public access PREVENTED, location $REGION"
echo "  $CP_SA -> roles/storage.objectAdmin on THAT BUCKET ONLY (no project-wide storage role)"
echo
echo "  AT REST, STATED EXACTLY, BECAUSE A LAKE THAT LOOKS ENCRYPTED AND IS NOT IS WORSE THAN"
echo "  ONE THAT SAYS SO. This step provisions the BUCKET. The PCV1 vault is a separate thing"
echo "  and it is provisioned at 5e/10, which reports its own outcome:"
echo "    - the control plane seals a lake object with a master key derived by Cloud KMS"
echo "      KEM_XWING decapsulation over the object shared/vault/master.kem. 5e/10 creates the"
echo "      keyring and the KEM key ALWAYS, and MINTS master.kem when this machine can do a"
echo "      client-side X-Wing encapsulation -- verified against KMS before it is published."
echo "    - THE MINT IS CONDITIONAL AND THE CONDITION IS A LIBRARY: it needs a Python"
echo "      cryptography carrying ML-KEM-768. A bare python3 has none, and openssl 3.5.6 does"
echo "      not implement X-Wing, so on such a machine 5e/10 prints exactly what is missing"
echo "      and skips the mint. It is never forged."
echo "    - WITH master.kem PRESENT the lake is SEALED. WITHOUT it the lake is FAIL-CLOSED, NOT"
echo "      PLAINTEXT: harWriteLake calls vaultMaster() before file.save(), so every write"
echo "      outside the five cleartext prefixes THROWS. There is no plaintext fallback branch,"
echo "      and a write that appears to succeed and is unsealed is not a state this code reaches."
echo "    - the five prefixes shared/deploy/ shared/harness/ shared/passkey/ shared/mcp-oauth/"
echo "      shared/vault/ are stored PLAINTEXT BY DESIGN -- the control plane loads and"
echo "      executes them at boot. That list is an invariant across three peers; it is not a"
echo "      setting and it must never be widened."
echo "    - a sealed object is exactly 34 bytes longer than its plaintext (4 magic + 1 epoch"
echo "      + 1 flags + 12 nonce + 16 GCM tag). Equal size means PLAINTEXT. That is how to"
echo "      check, and it needs no key."
echo

say "5d/10 workstation VM (optional, default no)"
# [SEC-WSVM-OPTIN-V1] vm_status, vm_start, vm_stop and vm_resize act on a Compute
# Engine instance named by WS_VM in zone WS_ZONE -- index.ts:2910-2911 and :1493-1494, which
# carry a built-in default name and zone. No instance was ever created and neither variable was
# ever set, so four tools registered and then failed against a machine nobody made.
# [SEC-SSHKEY-PREFLIGHT-V1] ssh_executor IS NOT ONE OF THEM AND SAYING IT WAS SENT ADOPTERS
# THE WRONG WAY. It reads NEITHER WS_VM NOR WS_ZONE -- it takes its target as a tool argument
# and needs a PRIVATE KEY, from the Secret Manager secret named by EXEC_SSH_KEY_SECRET on the
# executor. This installer creates no such secret, so ssh jobs are REFUSED, and gate-exec now
# refuses them ABOVE the approval claim so a refusal costs no approval. Creating the VM below
# does not make ssh_executor work: this instance is created with --no-address and OS Login
# enforced, and the executor has no VPC route to it.
# It is opt-in and it defaults to NO, because a running VM bills by the hour and most adopters
# do not want one.
# --rehearse MUST NOT PROMPT. An unattended rehearsal has to reach the 9/10 boundary with no
# human, and this script has exactly ONE prompt in it -- the ENTER after the passkey, below the
# boundary, which a rehearsal never reaches. Keep it that way: the answer is taken from
# PC_WANT_VM when it is set, and under --rehearse an unset PC_WANT_VM answers NO without asking.
# Setting PC_WANT_VM=y is also how CI rehearses the create path.
PC_WANT_VM="${PC_WANT_VM-}"
if [ -z "$PC_WANT_VM" ]; then
  if [ "$PC_REHEARSE" = 1 ]; then
    PC_WANT_VM=n
    echo "  --rehearse: answering NO without asking, so this run needs no human."
    echo "  Set PC_WANT_VM=y to rehearse the create path instead."
  else
    printf '  Create a workstation VM so the vm_* tools work? [y/N]: '
    read PC_WANT_VM || PC_WANT_VM=n
  fi
fi
case "$PC_WANT_VM" in
  y|Y|yes|YES|Yes) PC_WANT_VM=y ;;
  *)               PC_WANT_VM=n ;;
esac
PC_VM_ENV=""
if [ "$PC_WANT_VM" = n ]; then
  echo "  no VM. WS_VM and WS_ZONE are left UNSET, and unset is not the same as harmless:"
  echo "  vm_status, vm_start, vm_stop and vm_resize STILL REGISTER and will fail against"
  echo "  the built-in default name in us-central1-a. Those four tools will not work."
  echo "  Re-run with PC_WANT_VM=y to add one later; nothing else in this install depends"
  echo "  on it. ssh_executor is a SEPARATE case and a VM does not fix it -- see above."
else
  WS_VM_NAME=paracoding-workstation
  # A FIXED NAME, AND DELIBERATELY NOT A ROLE NAME. WS_VM and WS_ZONE are both written onto the
  # control plane at 6/10 below, so nothing here depends on this matching any built-in default
  # in the code, and a re-run still adopts the instance by name. A FAILED LIST IS FATAL: this is
  # the N16 class, and the consequence of misreading a failed query as "no instance" is a SECOND
  # billed workstation that no later run adopts.
  PC_VMLIST_RC=0
  PC_VMLIST=$(gcloud compute instances list --project "$PROJECT" \
    --filter="name=($WS_VM_NAME)" --format='value(zone)' 2>/dev/null) || PC_VMLIST_RC=$?
  [ "$PC_VMLIST_RC" -eq 0 ] || die "could not list the Compute Engine instances in $PROJECT
(exit $PC_VMLIST_RC). Refusing to continue: this installer cannot tell a project with no
workstation from a query that failed, and guessing wrong CREATES A SECOND billed VM instead of
adopting the one you already have."
  WS_VM_ZONE=$(printf '%s\n' "$PC_VMLIST" | sed -n '1p' | sed 's#.*/##')
  if [ -n "$WS_VM_ZONE" ]; then
    echo "  adopting the existing instance $WS_VM_NAME in $WS_VM_ZONE"
  else
    # EMPTY FROM A SUCCESSFUL LIST IS THE NORMAL FRESH-PROJECT STATE and is not fatal -- it is
    # the create case. Only a non-zero status changed meaning, exactly as at 2/10.
    # The ZONE is LISTED, never composed. "$REGION-a" is a trap: us-east1 has b, c and d and no
    # a at all, so a composed zone would fail the create in the commonest region this installer
    # is run in.
    PC_ZONES_RC=0
    PC_ZONES=$(gcloud compute zones list --project "$PROJECT" \
      --filter="name~^${REGION}- AND status=UP" --format='value(name)' 2>/dev/null) || PC_ZONES_RC=$?
    [ "$PC_ZONES_RC" -eq 0 ] || die "could not list the Compute Engine zones in $REGION (exit
$PC_ZONES_RC). Refusing to compose a zone name from the region: $REGION-a does not exist in
every region, and writing an unusable zone into WS_ZONE leaves the VM tools polling forever for
a machine that was never created."
    WS_VM_ZONE=$(printf '%s\n' "$PC_ZONES" | sed -n '1p')
    [ -n "$WS_VM_ZONE" ] || die "$REGION reports no Compute Engine zone that is UP. Pick another
region, or create the workstation yourself and set WS_VM and WS_ZONE on $CP_SVC."
    PC_VMC_RC=0
    retry gcloud compute instances create "$WS_VM_NAME" --project "$PROJECT" \
      --zone "$WS_VM_ZONE" --machine-type e2-standard-2 \
      --image-family debian-12 --image-project debian-cloud \
      --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
      --metadata enable-oslogin=TRUE --no-address --no-service-account --no-scopes \
      --quiet >/dev/null || PC_VMC_RC=$?
    gcloud compute instances describe "$WS_VM_NAME" --zone "$WS_VM_ZONE" --project "$PROJECT" \
      >/dev/null 2>&1 \
      || die "the workstation VM $WS_VM_NAME is still absent in $WS_VM_ZONE after a create
attempt (exit $PC_VMC_RC). The describe is the authority here, not the create status, because a
concurrent run makes create a 409 and that is success for our purposes."
    echo "  created $WS_VM_NAME in $WS_VM_ZONE (e2-standard-2, Debian 12, Shielded VM)"
    echo "  It has NO EXTERNAL IP, NO ATTACHED SERVICE ACCOUNT and OS Login enforced. That is"
    echo "  deliberate: a workstation with the default compute service account is a project-wide"
    echo "  credential anyone on the box can use, and an external IP puts port 22 on the"
    echo "  internet. The cost is that it has no egress and no GCP identity until you choose to"
    echo "  give it them:"
    echo "    reach it     gcloud compute ssh $WS_VM_NAME --zone $WS_VM_ZONE --tunnel-through-iap"
    echo "    egress       add a Cloud NAT on the subnet in $REGION"
    echo "    identity     gcloud compute instances set-service-account $WS_VM_NAME ..."
  fi
  PC_VM_ENV=",WS_VM=$WS_VM_NAME,WS_ZONE=$WS_VM_ZONE"
  echo "  WS_VM=$WS_VM_NAME WS_ZONE=$WS_VM_ZONE will be set on $CP_SVC at 6/10"
fi

say "5e/10 the PCV1 vault key (Cloud KMS, KEM_XWING)"
# [SEC-VAULT-KMS-V1] 5c/10 CREATED THE BUCKET. A BUCKET IS NOT A VAULT, AND THE DIFFERENCE IS A
# TOOL THAT WORKS VERSUS A TOOL THAT THROWS. index.ts harWriteLake calls vaultMaster() BEFORE
# file.save(), so with no vault EVERY write outside the five cleartext prefixes throws. The
# shipped README used to say the remediation was "create a bucket, grant objectAdmin, set the
# variable" -- follow that exactly and write_file and put_file still die. This step is the half
# that was missing.
#
# THREE THINGS, AND THE THIRD IS THE ONE THAT CANNOT ALWAYS BE DONE FROM HERE:
#   1. keyring paracoding-vault in $REGION                       -- pure gcloud, always
#   2. key vault-kem-xwing (KEY_ENCAPSULATION / KEM_XWING) with roles/cloudkms.decapsulator
#      granted to $CP_SA KEY-SCOPED, never project-wide          -- pure gcloud, always
#   3. the lake object shared/vault/master.kem                   -- needs a CLIENT-SIDE X-Wing
#      encapsulation. MEASURED, not assumed: openssl 3.5.6 does NOT implement X-Wing --
#      `openssl list -kem-algorithms` offers ML-KEM-512/768/1024 and the TLS hybrid groups, and
#      X25519MLKEM768 is NOT a substitute because the TLS group concatenates where X-Wing runs a
#      SHA3-256 combiner. Python cryptography DOES carry ML-KEM-768 and X25519, which is enough
#      to build X-Wing, but cryptography is NOT a prerequisite of this script and a bare python3
#      has no ML-KEM at all. So step 3 is ATTEMPTED, VERIFIED AGAINST KMS BEFORE IT IS
#      PUBLISHED, and when it cannot be done it is SAID OUT LOUD and skipped. It is never forged.
#
# shared/vault/ IS ONE OF THE FIVE CLEARTEXT PREFIXES AND MUST STAY THAT WAY. master.kem is the
# bootstrap; it cannot be encrypted by the thing it bootstraps. That list is one invariant across
# three peers -- index.ts, shared/vault/envelope.py, shared/runner/vault_runtime.py. Never widen it.
PC_VKR=paracoding-vault
PC_VKEY=vault-kem-xwing
PC_VAULT_OK=1
pc_vault_fail() {
  PC_VAULT_OK=0
  if [ "$PC_REHEARSE" = 1 ]; then
    echo "  VAULT KEY NOT PROVISIONED: $1"
    echo "  Permitted under --rehearse ONLY. The lake stays FAIL-CLOSED -- a non-cleartext write"
    echo "  throws rather than landing in plaintext -- so nothing is left half-armed."
  else
    die "could not provision the PCV1 vault key.
  $1
Refusing to continue. The control plane would come up with lake tools that register cleanly and
throw on the first write, which is the exact defect class this release exists to close."
  fi
}
# THE SUBCOMMAND IS VERIFIED BEFORE ITS OUTPUT IS TRUSTED. `gcloud projects test-iam-permissions`
# did not exist in SDK 578 and silently skipped a preflight for its entire life; a KEM purpose is
# newer than that. If this gcloud cannot express the purpose, stop here rather than create a key
# of the wrong kind that a later run would adopt.
gcloud kms keys create --help 2>/dev/null | grep -q 'key-encapsulation' \
  || pc_vault_fail "this gcloud ($(gcloud version 2>/dev/null | head -1)) has no
--purpose=key-encapsulation, so it cannot create a KEM key. Upgrade the SDK and re-run."
if [ "$PC_VAULT_OK" = 1 ]; then
  if gcloud kms keyrings describe "$PC_VKR" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
    echo "  adopting keyring $PC_VKR in $REGION"
  else
    retry gcloud kms keyrings create "$PC_VKR" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1
    gcloud kms keyrings describe "$PC_VKR" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 \
      || pc_vault_fail "keyring $PC_VKR is still absent in $REGION after a create attempt."
  fi
fi
# The create rc is deliberately NOT trusted, exactly as at 5b/10: a concurrent run makes it
# ALREADY_EXISTS, which is success for our purposes. The DESCRIBE is the authority, and a keyring
# name is unique within a location, so adopting can never produce a duplicate.
if [ "$PC_VAULT_OK" = 1 ]; then
  if gcloud kms keys describe "$PC_VKEY" --keyring "$PC_VKR" --location "$REGION" \
    --project "$PROJECT" >/dev/null 2>&1; then
    echo "  adopting key $PC_VKEY"
  else
    retry gcloud kms keys create "$PC_VKEY" --keyring "$PC_VKR" --location "$REGION" \
      --purpose key-encapsulation --default-algorithm kem-xwing \
      --project "$PROJECT" >/dev/null 2>&1
    gcloud kms keys describe "$PC_VKEY" --keyring "$PC_VKR" --location "$REGION" \
      --project "$PROJECT" >/dev/null 2>&1 \
      || pc_vault_fail "key $PC_VKEY is still absent on keyring $PC_VKR after a create attempt."
  fi
fi
# THE ALGORITHM IS RE-ASSERTED ON EVERY RUN, INCLUDING AN ADOPTED KEY. index.ts pins epoch 2 to
# KEM_XWING with a 1120-byte ciphertext; a key adopted from an earlier hand-built attempt could
# be ML-KEM-768 or ML-KEM-1024, whose ciphertexts are 1088 and 1568 bytes. Those decapsulate
# happily and derive a DIFFERENT master, which encrypts fine and decrypts nothing.
if [ "$PC_VAULT_OK" = 1 ]; then
  PC_VALG=$(gcloud kms keys describe "$PC_VKEY" --keyring "$PC_VKR" --location "$REGION" \
    --project "$PROJECT" --format='value(versionTemplate.algorithm)' 2>/dev/null); PC_VALG_RC=$?
  [ "$PC_VALG_RC" -eq 0 ] \
    || pc_vault_fail "could not read the algorithm of $PC_VKEY (exit $PC_VALG_RC). A failed
describe is not an answer, and adopting a key whose algorithm is unknown is how a vault ends up
deriving a master nobody can decrypt with."
  if [ "$PC_VAULT_OK" = 1 ] && [ "$PC_VALG" != "KEM_XWING" ]; then
    pc_vault_fail "key $PC_VKEY exists on keyring $PC_VKR but its algorithm is '$PC_VALG', not
KEM_XWING. This installer will NOT create a second key beside it and will NOT rewrite yours.
Either destroy that key, or point this install at a keyring of its own."
  fi
fi
# roles/cloudkms.decapsulator ON THIS KEY ONLY. Measured with `gcloud iam roles describe`: it
# carries cloudkms.cryptoKeyVersions.useToDecapsulate and viewPublicKey and nothing that can
# encrypt, sign or administer. The broad roles/cloudkms.cryptoOperator would also work and is
# what an earlier hand-built vault used; it is far too much.
if [ "$PC_VAULT_OK" = 1 ]; then
  retry gcloud kms keys add-iam-policy-binding "$PC_VKEY" --keyring "$PC_VKR" \
    --location "$REGION" --project "$PROJECT" --member="serviceAccount:$CP_SA" \
    --role=roles/cloudkms.decapsulator --condition=None >/dev/null \
    || pc_vault_fail "could not grant roles/cloudkms.decapsulator on $PC_VKEY to $CP_SA."
fi
if [ "$PC_VAULT_OK" = 1 ]; then
  echo "  $PC_VKEY ready in $REGION (KEY_ENCAPSULATION / KEM_XWING, one version)"
  echo "  $CP_SA -> roles/cloudkms.decapsulator on THAT KEY ONLY (no project-wide KMS role)"
fi
# ---- master.kem: minted here when this machine can, refused loudly when it cannot ----
# THE CAPABILITY IS TESTED, NOT ASSUMED, AND THE TEST IS THE IMPORT ITSELF.
PC_KEM_LIB=0
if [ "$PC_VAULT_OK" = 1 ]; then
  python3 -c "from cryptography.hazmat.primitives.asymmetric import mlkem, x25519
mlkem.MLKEM768PublicKey" >/dev/null 2>&1 && PC_KEM_LIB=1
fi
if [ "$PC_VAULT_OK" = 1 ] && [ "$PC_KEM_LIB" != 1 ]; then
  echo
  echo "  THE VAULT KEY EXISTS AND shared/vault/master.kem DOES NOT. STATED PLAINLY, BECAUSE A"
  echo "  LAKE THAT LOOKS ENCRYPTED AND IS NOT IS WORSE THAN ONE THAT SAYS SO:"
  echo "    - minting master.kem needs a CLIENT-SIDE X-Wing encapsulation (ML-KEM-768 + X25519)."
  echo "      This python3 has no ML-KEM. openssl does not implement X-Wing either, so there is"
  echo "      no way to do it with the prerequisites this script checked at 0/10, and it will"
  echo "      not be forged."
  echo "    - UNTIL IT EXISTS THE LAKE IS FAIL-CLOSED, NOT PLAINTEXT: every write outside the"
  echo "      five cleartext prefixes THROWS. read_file and list_files work; write_file and"
  echo "      put_file do not. That is a refusal, not a leak."
  echo "    - TO FINISH IT, on any machine with the library, re-run this installer:"
  echo "        python3 -m pip install 'cryptography>=46'   (or a distro python3-cryptography)"
  echo "        ./install.sh $PROJECT $REGION"
  echo "      Provisioning is idempotent: the keyring and key above are ADOPTED, not remade, and"
  echo "      the mint below is skipped if master.kem is already there."
  echo
fi
if [ "$PC_VAULT_OK" = 1 ] && [ "$PC_KEM_LIB" = 1 ]; then
  if gcloud storage objects describe "gs://$PC_LAKE_BUCKET/shared/vault/master.kem" \
    --project "$PROJECT" >/dev/null 2>&1; then
    echo "  shared/vault/master.kem already exists -- ADOPTED, never overwritten."
    echo "  Rewriting it would derive a new master and orphan every object sealed under the old"
    echo "  one, and this installer has no way to re-seal a lake it did not write."
  else
    # THE MINT IS VERIFIED BEFORE IT IS PUBLISHED, AND THAT IS THE WHOLE DIFFERENCE BETWEEN THIS
    # AND FORGING IT. X-Wing's combiner is SHA3-256 over ss_M|ss_X|ct_X|pk_X with the 6-byte
    # X-Wing label LAST -- measured against Cloud KMS, and the label-FIRST ordering that some
    # drafts specify produces a different shared secret. Getting it wrong yields a master that
    # encrypts happily and decrypts nothing, so the ciphertext is handed BACK to KMS and the
    # returned shared secret must equal the one computed locally. If it does not, nothing is
    # written. Verifying needs decapsulate, which the installing account does not hold, so the
    # grant is taken for the length of the check and revoked immediately afterwards.
    case "$ACCT" in
      *.gserviceaccount.com) PC_VMEM="serviceAccount:$ACCT" ;;
      *)                     PC_VMEM="user:$ACCT" ;;
    esac
    PC_VTMP_RC=0
    retry gcloud kms keys add-iam-policy-binding "$PC_VKEY" --keyring "$PC_VKR" \
      --location "$REGION" --project "$PROJECT" --member="$PC_VMEM" \
      --role=roles/cloudkms.decapsulator --condition=None >/dev/null || PC_VTMP_RC=$?
    if [ "$PC_VTMP_RC" -ne 0 ]; then
      pc_vault_fail "could not grant yourself ($PC_VMEM) temporary decapsulate on $PC_VKEY to
verify the mint (exit $PC_VTMP_RC). Refusing to publish a master.kem that was never checked."
    fi
    PC_MINT_RC=0
    if [ "$PC_VAULT_OK" = 1 ]; then
      PC_KEMTOK=$(gcloud auth print-access-token 2>/dev/null); PC_KEMTOK_RC=$?
      [ "$PC_KEMTOK_RC" -eq 0 ] || PC_MINT_RC=91
    fi
    if [ "$PC_VAULT_OK" = 1 ] && [ "$PC_MINT_RC" -eq 0 ]; then
      PC_KEMKV="projects/$PROJECT/locations/$REGION/keyRings/$PC_VKR/cryptoKeys/$PC_VKEY/cryptoKeyVersions/1"
      PC_KEM_KV="$PC_KEMKV" PC_KEM_TOK="$PC_KEMTOK" PC_KEM_OUT="$HERE/.master.kem.tmp" python3 - <<'PCVMINT'
import base64, datetime, hashlib, json, os, sys, urllib.request
from cryptography.hazmat.primitives.asymmetric import mlkem, x25519
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

KV  = os.environ["PC_KEM_KV"]
TOK = os.environ["PC_KEM_TOK"]
OUT = os.environ["PC_KEM_OUT"]
BASE = "https://cloudkms.googleapis.com/v1/"

def call(url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=("POST" if data else "GET"))
    req.add_header("Authorization", "Bearer " + TOK)
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())

def fail(msg):
    sys.stderr.write("MINT-REFUSED: " + msg + "\n")
    sys.exit(1)

try:
    pk = call(BASE + KV + "/publicKey?publicKeyFormat=XWING_RAW_BYTES")
except Exception as e:
    fail("could not read the X-Wing public key: %s" % e)
ek = base64.b64decode((pk.get("publicKey") or {}).get("data") or "")
if len(ek) != 1216:
    fail("public key is %d bytes, want 1216 (ML-KEM-768 ek 1184 + X25519 pk 32)" % len(ek))
pk_M, pk_X = ek[:1184], ek[1184:]

ss_M, ct_M = mlkem.MLKEM768PublicKey.from_public_bytes(pk_M).encapsulate()
esk_X = x25519.X25519PrivateKey.generate()
ct_X  = esk_X.public_key().public_bytes_raw()
ss_X  = esk_X.exchange(x25519.X25519PublicKey.from_public_bytes(pk_X))
ct = ct_M + ct_X
if len(ct) != 1120:
    fail("X-Wing ciphertext is %d bytes, want 1120" % len(ct))

XWING_LABEL = bytes([0x5c, 0x2e, 0x2f, 0x2f, 0x5e, 0x5c])
ss_local = hashlib.sha3_256(ss_M + ss_X + ct_X + pk_X + XWING_LABEL).digest()

try:
    dec = call(BASE + KV + ":decapsulate", {"ciphertext": base64.b64encode(ct).decode()})
except Exception as e:
    fail("KMS refused to decapsulate the freshly minted ciphertext: %s" % e)
ss_kms = base64.b64decode(dec.get("sharedSecret") or dec.get("shared_secret") or "")
if ss_kms != ss_local:
    fail("the shared secret KMS derived does not match the one computed here. The X-Wing "
         "combiner in this build disagrees with the key. NOTHING WAS WRITTEN -- a master.kem "
         "published now would encrypt happily and decrypt nothing.")

master = HKDF(algorithm=hashes.SHA256(), length=32, salt=bytes(32),
              info=b"paracoding-vault master v1").derive(ss_kms)
created = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
env = ('{"v":1,"epoch":2,"kem_alg":"KEM_XWING","kem_version":1,"kdf":"HKDF-SHA256"'
       ',"kdf_info":"paracoding-vault master v1","kem_ct_b64":"'
       + base64.b64encode(ct).decode() + '","created":"' + created + '"}')
if len(env) != 1660:
    fail("envelope is %d bytes, want 1660" % len(env))
json.loads(env)
with open(OUT, "w") as f:
    f.write(env)
print("  verified against KMS: local and decapsulated shared secrets agree")
print("  master key fingerprint sha256 %s (the key itself is never written or printed)"
      % hashlib.sha256(master).hexdigest()[:32])
print("  envelope %d bytes, epoch 2, KEM_XWING ciphertext %d bytes" % (len(env), len(ct)))
PCVMINT
      PC_MINT_RC=$?
    fi
    # THE REVOKE IS NOT OPTIONAL AND IT IS JUDGED BY RE-READING THE POLICY, NOT BY ITS EXIT CODE.
    # --condition=None on the remove is load-bearing for the same reason it is on the add: against
    # a policy that already contains a condition, gcloud refuses an unflagged remove
    # non-interactively, and a half-fixed job opens a privilege window it cannot close.
    PC_VREV_RC=0
    gcloud kms keys remove-iam-policy-binding "$PC_VKEY" --keyring "$PC_VKR" \
      --location "$REGION" --project "$PROJECT" --member="$PC_VMEM" \
      --role=roles/cloudkms.decapsulator --condition=None >/dev/null 2>&1 || PC_VREV_RC=$?
    PC_VLEFT=$(gcloud kms keys get-iam-policy "$PC_VKEY" --keyring "$PC_VKR" --location "$REGION" \
      --project "$PROJECT" --format=json 2>/dev/null | python3 -c 'import sys,json
try: p = json.load(sys.stdin)
except Exception: print("UNREADABLE"); raise SystemExit
m = sys.argv[1]
print("PRESENT" if any(m in (b.get("members") or []) for b in (p.get("bindings") or [])) else "GONE")' "$PC_VMEM")
    if [ "$PC_VLEFT" != "GONE" ]; then
      die "TEMPORARY DECAPSULATE GRANT WAS NOT REVOKED. $PC_VMEM still appears on the IAM policy
of $PC_VKEY (remove exit $PC_VREV_RC, policy re-read said '$PC_VLEFT'). A leaked privilege is not
the same outcome as a failed mint and is never reported as one. Revoke it by hand:
  gcloud kms keys remove-iam-policy-binding $PC_VKEY --keyring $PC_VKR --location $REGION \\
    --project $PROJECT --member=$PC_VMEM --role=roles/cloudkms.decapsulator --condition=None"
    fi
    echo "  temporary decapsulate grant revoked, confirmed by re-reading the key's IAM policy"
    if [ "$PC_VAULT_OK" = 1 ] && [ "$PC_MINT_RC" -ne 0 ]; then
      rm -f "$HERE/.master.kem.tmp"
      pc_vault_fail "minting shared/vault/master.kem failed (exit $PC_MINT_RC) and NOTHING was
published. The refusal above says which check stopped it. The lake stays fail-closed."
    fi
    if [ "$PC_VAULT_OK" = 1 ]; then
      PC_VUP_RC=0
      gcloud storage cp "$HERE/.master.kem.tmp" \
        "gs://$PC_LAKE_BUCKET/shared/vault/master.kem" --project "$PROJECT" >/dev/null 2>&1 \
        || PC_VUP_RC=$?
      rm -f "$HERE/.master.kem.tmp"
      [ "$PC_VUP_RC" -eq 0 ] \
        || pc_vault_fail "could not upload shared/vault/master.kem (exit $PC_VUP_RC)."
    fi
    if [ "$PC_VAULT_OK" = 1 ]; then
      PC_VSZ=$(gcloud storage objects describe "gs://$PC_LAKE_BUCKET/shared/vault/master.kem" \
        --project "$PROJECT" --format='value(size)' 2>/dev/null); PC_VSZ_RC=$?
      [ "$PC_VSZ_RC" -eq 0 ] \
        || pc_vault_fail "wrote shared/vault/master.kem and could not read it back (exit $PC_VSZ_RC)."
      [ "$PC_VSZ" = "1660" ] \
        || pc_vault_fail "shared/vault/master.kem reads back at $PC_VSZ bytes, want 1660."
      echo "  shared/vault/master.kem published and read back at 1660 bytes"
      echo "  It is stored PLAINTEXT ON PURPOSE: shared/vault/ is one of the five cleartext"
      echo "  prefixes, and the bootstrap cannot be sealed by the thing it bootstraps. The"
      echo "  object holds only a PUBLIC KEM ciphertext -- the master key is never in it, and"
      echo "  only $CP_SA can turn it back into one."
    fi
  fi
fi
if [ "$PC_VAULT_OK" = 1 ]; then
  echo
  echo "  HOW TO CHECK ENCRYPTION AT REST, AND IT NEEDS NO KEY: a sealed object is exactly 34"
  echo "  bytes longer than its plaintext (4 magic + 1 epoch + 1 flags + 12 nonce + 16 GCM tag)"
  echo "  and begins with the ASCII bytes PCV1. EQUAL SIZE MEANS PLAINTEXT."
fi

say "6/10 building and deploying the control plane"
# [SEC-SURFACE-SPLIT-V1] ONE BUILD, TWO SERVICES. The console is deployed --source, which
# builds the image; the MCP service is then deployed from THE IMAGE THAT BUILD PRODUCED, read
# off the console's ready revision. Deploying both --source would build the same tree twice
# and could, on a re-run, put two DIFFERENT images behind one URL pair -- a split-brain that
# is invisible until a route behaves differently on one surface.
#
# PC_SURFACE IS THE ONLY THING THAT DIFFERS IN KIND. index.ts registers every route when
# PC_SURFACE is unset (today's single service, byte for byte); console keeps the 63 browser
# routes, mcp keeps the 25 machine-client routes. A path in neither table THROWS at boot, so
# a route added without a surface fails the deploy instead of vanishing from one service.
#
# THE TWO ENV DIFFERENCES, EACH DELIBERATE:
#   MCP_PUBLIC_URL   $MC_URL on BOTH. It is the address of the MCP resource, and that resource
#                    lives on the MCP service. oaPubBase() builds every discovery document
#                    from it, so the console's URL must never appear there.
#   PC_IAP_AUD       CONSOLE ONLY. It is the audience of the IAP JWT and IAP is enabled on the
#                    console alone. Setting it on the MCP service would name an audience no
#                    request there can ever carry.
# WA_RP_ID/WA_RP_ORIGIN are the CONSOLE host on both: the gate is served by the console, and a
# passkey is bound to that host. Everything else is identical by construction.
retry gcloud run deploy "$CP_SVC" --source "$HERE/control-plane" --region "$REGION" --project "$PROJECT" \
  --service-account "$CP_SA" --allow-unauthenticated --clear-base-image --quiet \
  --set-env-vars "PC_SURFACE=console,WA_RP_ID=$CP_HOST,WA_RP_ORIGIN=https://$CP_HOST,MCP_PUBLIC_URL=$MC_URL,OAUTH_DEFAULT_ROLE=fleet-onboarder,PC_FIRESTORE_DB=$FSDB,PC_IAP_AUD=/projects/$PROJNUM/locations/$REGION/services/$CP_SVC,PC_REQUIRE_PASSKEY=1,PC_SESSION_ENFORCE=1,PC_KEY_TTL_DAYS=7,PC_TOOLS_ENFORCE=1,WA_APPROVER_EMAILS=$ACCT,WA_SESSION_MIN=240,DATA_LAKE_BUCKET=$PC_LAKE_BUCKET,GCP_PROJECT=$PROJECT,GCP_REGION=$REGION$PC_VM_ENV" \
  --update-secrets "WA_SESSION_SECRET=pc-session-secret:latest,HUMAN_CONFIRM_SECRET=pc-human-confirm-secret:latest" \
  >/dev/null || die "console deploy failed"
echo "  console deployed"
# READ THE IMAGE OFF THE REVISION, NEVER OFF THE BUILD LOG. There is no set -e, so an empty
# result here would otherwise walk straight into a deploy with no --image argument.
PC_CP_REV0=$(gcloud run services describe "$CP_SVC" --region "$REGION" --project "$PROJECT" \
  --format='value(status.latestReadyRevisionName)' 2>/dev/null); PC_REV0_RC=$?
[ "$PC_REV0_RC" -eq 0 ] || die "could not read the console revision name (exit $PC_REV0_RC)."
[ -n "$PC_CP_REV0" ] || die "the console reports no ready revision after a successful deploy."
PC_IMAGE=$(gcloud run revisions describe "$PC_CP_REV0" --region "$REGION" --project "$PROJECT" \
  --format='value(spec.containers[0].image)' 2>/dev/null); PC_IMG_RC=$?
[ "$PC_IMG_RC" -eq 0 ] || die "could not read the image off revision $PC_CP_REV0 (exit $PC_IMG_RC)."
[ -n "$PC_IMAGE" ] || die "revision $PC_CP_REV0 names no container image. Refusing to deploy the
MCP service, because without this value it would be deployed from whatever it happens to be
running now -- which on a fresh install is the placeholder 'hello' image from step 5/10, and
that image serves no /mcp at all."
echo "  image $PC_IMAGE"
retry gcloud run deploy "$MC_SVC" --image "$PC_IMAGE" --region "$REGION" --project "$PROJECT" \
  --service-account "$CP_SA" --allow-unauthenticated --quiet \
  --set-env-vars "PC_SURFACE=mcp,WA_RP_ID=$CP_HOST,WA_RP_ORIGIN=https://$CP_HOST,MCP_PUBLIC_URL=$MC_URL,OAUTH_DEFAULT_ROLE=fleet-onboarder,PC_FIRESTORE_DB=$FSDB,PC_REQUIRE_PASSKEY=1,PC_SESSION_ENFORCE=1,PC_KEY_TTL_DAYS=7,PC_TOOLS_ENFORCE=1,WA_APPROVER_EMAILS=$ACCT,WA_SESSION_MIN=240,DATA_LAKE_BUCKET=$PC_LAKE_BUCKET,GCP_PROJECT=$PROJECT,GCP_REGION=$REGION$PC_VM_ENV" \
  --update-secrets "WA_SESSION_SECRET=pc-session-secret:latest,HUMAN_CONFIRM_SECRET=pc-human-confirm-secret:latest" \
  >/dev/null || die "MCP service deploy failed"
echo "  mcp deployed from the same image"
# GET / IS A CONSOLE ROUTE, SO THE MCP SERVICE ANSWERS 404 AT ITS ROOT. That is correct and it
# is why no HTTP startup probe is configured on either deploy above: Cloud Run's DEFAULT probe
# is a TCP connect to $PORT, which the MCP service satisfies. Adding --startup-probe on / here
# would make every MCP revision fail to go ready, on a 404 that is the design.
# [SEC-LAKE-BUCKET-V1] GCP_PROJECT IS SET ABOVE AND IT WAS NEVER SET BEFORE, WHICH IS ITS OWN
# DEFECT. index.ts:83 resolves PC_PROJECT from GCP_PROJECT or GOOGLE_CLOUD_PROJECT with NO
# fallback, and Cloud Run sets neither. So PC_PROJECT was the empty string on every install, and
# every REST URL built from it -- the VM tools at :1495/:2912, run_status at :1536, and the vault
# KMS key version at :4068-4069, which came out as "projects//locations/..." -- was malformed.
# The Storage and Firestore clients autodetect the project from the metadata server, which is why
# this stayed invisible.
#
# READ IT BACK OFF THE REVISION THAT IS ACTUALLY SERVING, NEVER OFF THE COMMAND WE JUST RAN. A
# deploy that reports success and a revision that carries the value are two different facts, and
# only the second one is worth anything.
PC_CP_REV=$(gcloud run services describe "$CP_SVC" --region "$REGION" --project "$PROJECT" \
  --format='value(status.latestReadyRevisionName)' 2>/dev/null); PC_REV_RC=$?
[ "$PC_REV_RC" -eq 0 ] || die "could not read the control-plane revision name (exit $PC_REV_RC)."
[ -n "$PC_CP_REV" ] || die "the control plane reports no ready revision after a successful
deploy. Refusing to verify anything against a service that is not serving."
PC_REVJSON=$(gcloud run revisions describe "$PC_CP_REV" --region "$REGION" --project "$PROJECT" \
  --format=json 2>/dev/null); PC_RJ_RC=$?
[ "$PC_RJ_RC" -eq 0 ] || die "could not describe revision $PC_CP_REV (exit $PC_RJ_RC)."
PC_SEEN_LAKE=$(printf '%s' "$PC_REVJSON" | python3 -c 'import sys,json
d = json.load(sys.stdin)
cs = ((d.get("spec") or {}).get("containers")) or []
v = [e.get("value","") for c in cs for e in (c.get("env") or []) if e.get("name") == "DATA_LAKE_BUCKET"]
print(v[0] if v else "")' 2>/dev/null)
[ "$PC_SEEN_LAKE" = "$PC_LAKE_BUCKET" ] || die "revision $PC_CP_REV is serving
DATA_LAKE_BUCKET='$PC_SEEN_LAKE', not '$PC_LAKE_BUCKET'. The deploy reported success and the
variable did not arrive, so read_file, write_file, put_file and list_files would have failed with
'data lake not configured' on a install that called itself complete."
echo "  $PC_CP_REV serves DATA_LAKE_BUCKET=$PC_SEEN_LAKE (read off the revision, not asserted)"
# THE SAME QUESTION, ASKED OF THE OTHER SERVICE, BECAUSE THE LAKE TOOLS LIVE THERE. read_file,
# write_file, put_file and list_files are MCP tools, so they run on $MC_SVC and not on the
# console. A console that serves DATA_LAKE_BUCKET proves nothing about them. This also reads
# back PC_SURFACE, which is the one variable whose absence would silently give you two
# identical services instead of a split -- and every route would still answer, so nothing
# downstream would notice.
PC_MC_REV=$(gcloud run services describe "$MC_SVC" --region "$REGION" --project "$PROJECT" \
  --format='value(status.latestReadyRevisionName)' 2>/dev/null); PC_MREV_RC=$?
[ "$PC_MREV_RC" -eq 0 ] || die "could not read the MCP revision name (exit $PC_MREV_RC)."
[ -n "$PC_MC_REV" ] || die "the MCP service reports no ready revision after a successful deploy."
PC_MREVJSON=$(gcloud run revisions describe "$PC_MC_REV" --region "$REGION" --project "$PROJECT" \
  --format=json 2>/dev/null); PC_MRJ_RC=$?
[ "$PC_MRJ_RC" -eq 0 ] || die "could not describe revision $PC_MC_REV (exit $PC_MRJ_RC)."
PC_SEEN_MC=$(printf '%s' "$PC_MREVJSON" | python3 -c 'import sys,json
d = json.load(sys.stdin)
cs = ((d.get("spec") or {}).get("containers")) or []
e = dict((x.get("name",""), x.get("value","")) for c in cs for x in (c.get("env") or []))
print((e.get("PC_SURFACE","") or "UNSET") + " " + (e.get("DATA_LAKE_BUCKET","") or "UNSET")
      + " " + (e.get("MCP_PUBLIC_URL","") or "UNSET"))' 2>/dev/null)
[ "$PC_SEEN_MC" = "mcp $PC_LAKE_BUCKET $MC_URL" ] || die "revision $PC_MC_REV is serving
'$PC_SEEN_MC' for PC_SURFACE / DATA_LAKE_BUCKET / MCP_PUBLIC_URL, and it must serve
'mcp $PC_LAKE_BUCKET $MC_URL'. A wrong PC_SURFACE gives you two consoles or two MCP servers
rather than one of each; a wrong MCP_PUBLIC_URL makes OAuth discovery advertise the console's
address to every connector, which is the defect this split exists to fix."
echo "  $PC_MC_REV serves PC_SURFACE=mcp and MCP_PUBLIC_URL=$MC_URL (read off the revision)"
# ONE PROBE OBJECT, WRITTEN AND READ AND DELETED. This proves the BUCKET answers -- the name
# resolves, the location is right and the credentials work. It is NOT an encryption proof: it
# goes to Cloud Storage directly, not through the control plane's vault, and 5c/10 says plainly
# why nothing here can seal an object yet.
PC_PROBE="install-probe/$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n').txt"
printf 'paracoding install probe' > "$HERE/.p.tmp"
PC_PW_RC=0
gcloud storage cp "$HERE/.p.tmp" "gs://$PC_LAKE_BUCKET/$PC_PROBE" --project "$PROJECT" \
  >/dev/null 2>&1 || PC_PW_RC=$?
PC_PR_RC=0
PC_PBACK=$(gcloud storage cat "gs://$PC_LAKE_BUCKET/$PC_PROBE" --project "$PROJECT" 2>/dev/null) \
  || PC_PR_RC=$?
gcloud storage rm "gs://$PC_LAKE_BUCKET/$PC_PROBE" --project "$PROJECT" >/dev/null 2>&1
python3 -c "import os;os.remove('$HERE/.p.tmp')"
[ "$PC_PW_RC" -eq 0 ] || die "could not WRITE a probe object to gs://$PC_LAKE_BUCKET (exit
$PC_PW_RC). The bucket exists but is not writable, so the lake tools would fail on first use."
[ "$PC_PR_RC" -eq 0 ] || die "wrote a probe object to gs://$PC_LAKE_BUCKET and could not READ it
back (exit $PC_PR_RC)."
[ "$PC_PBACK" = "paracoding install probe" ] || die "the probe object read back from
gs://$PC_LAKE_BUCKET did not match what was written."
echo "  probe object written, read back byte-for-byte and deleted on gs://$PC_LAKE_BUCKET"

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
# [SEC-SURFACE-SPLIT-V1] BOTH SERVICES GET GATE_EXEC_URL, BECAUSE BOTH DISPATCH TO THE
# EXECUTOR. The console fires an approved job from the gate (POST /api/webauthn/confirm/verify);
# the MCP service fires one from the legacy agent API (POST /api/jobs/fire) and stages from the
# tool surface. Setting it on the console alone would leave every machine-side dispatch
# reaching for an empty URL -- and the failure would look like the executor's IAM.
#
# THE TRAFFIC IS ONE-WAY AND THAT WAS CHECKED, NOT ASSUMED. gate-exec is handed NO control-plane
# URL by this installer and needs none: exec_server.py writes its results straight back into
# Firestore (job_ref.update) and journals there too. Its whole environment is PC_FIRESTORE_DB,
# PC_REQUIRE_ASSERTION, PC_RP_ID, the APPROVAL_SIG_* / EXEC_* settings, PC_KMS_HOST and
# PC_METADATA_HOST. So splitting the control plane in two gives the executor nothing to
# re-point, and there is deliberately no third URL written anywhere below.
retry gcloud run services update "$CP_SVC" --region "$REGION" --project "$PROJECT" \
  --update-env-vars "GATE_EXEC_URL=$GX_URL" >/dev/null
retry gcloud run services update "$MC_SVC" --region "$REGION" --project "$PROJECT" \
  --update-env-vars "GATE_EXEC_URL=$GX_URL" >/dev/null
echo "  $GX_URL  (private; only the console and the MCP service may call it)"
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
  retry gcloud run services update "$MC_SVC" --region "$REGION" --project "$PROJECT" \
    --update-env-vars "^@^APPROVAL_SIG_KEY_VERSION=$PC_SIG_KV" >/dev/null \
    || die "could not set APPROVAL_SIG_KEY_VERSION on $MC_SVC"
  echo "  approval signing: allowlist set on $GX_SVC, then key version pinned on both surfaces"
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

say "8/10 two surfaces: the console behind IAP, the MCP service in front of it"
# [SEC-IAP-MCP-CARVEOUT-V1] [SEC-SURFACE-SPLIT-V1] THE DEFECT THIS STEP EXISTS NOT TO
# REINTRODUCE, IN EITHER DIRECTION. Both previous shapes were wrong:
#   ONE SERVICE, IAP ON   IAP protects the WHOLE service, /mcp included. It answered 401 at
#                         the edge and the app was never reached, while the installer handed
#                         out $CP_URL/mcp as a connector endpoint. No MCP client could ever
#                         connect. A bearer token is not a workaround: IAP CONSUMES the
#                         Authorization header, so a token that satisfies IAP cannot also
#                         carry MCP session identity. Measured: POST /mcp with a bearer still
#                         answered 401 with x-goog-iap-generated-response: true.
#   ONE SERVICE, IAP OFF  /mcp works and the console is exposed to anyone who learns the URL,
#                         with the app's own passkey session as the only layer. That also
#                         destroys the bootstrap path this install depends on -- IAP is how
#                         you reach the gate on a brand-new install, BEFORE a passkey exists.
#
# A PATH-LEVEL CARVE-OUT DOES NOT EXIST ON CLOUD RUN, PROVEN AGAINST THE REAL APIS:
#   1. IapSettings (iap.googleapis.com v1, discovery revision 20260803) carries accessSettings
#      and applicationSettings and NO path, matcher or exclusion field anywhere in the schema.
#      IAP on Cloud Run is a per-SERVICE boolean; there is nothing finer to set.
#   2. Granting roles/iap.httpsResourceAccessor to allUsers under the condition
#      request.path.startsWith("/mcp") returns INVALID_ARGUMENT 'Conditions are not allowed on
#      public resources.' Conditions are legal only for named principals, and an MCP client
#      has no Google identity to name.
# One switch per service, therefore two services. That is what step 6/10 deployed.
#
# THE HALF THAT IS INVISIBLE UNTIL YOU CURL IT, AND IT BITES ON BOTH SERVICES.
# Enabling IAP on Cloud Run REVOKES the allUsers -> roles/run.invoker binding that
# --allow-unauthenticated created, and hands invocation to the IAP service agent alone.
# So --no-iap ALONE leaves a service answering a bare Google Frontend 403 to everyone --
# a THIRD unreachable signature, with no x-goog-iap-generated-response and no
# www-authenticate. Both halves are therefore handled EXPLICITLY on each service below:
# the MCP service gets IAP off AND the public invoker binding restored; the console gets
# IAP on AND the public invoker binding removed, because step 6/10 re-adds it on every run.
# --condition=None is not decoration: against a policy that already contains any conditional
# binding, gcloud refuses an unconditioned add or remove non-interactively.

# ---- the app's own guard, asserted BEFORE IAP goes in front of it ----
# This runs first ON PURPOSE. Once IAP is on, an anonymous request never reaches the app, so
# this is the last moment the compensating control can be observed at all. It is not made
# redundant by IAP: IAP is defence in depth in front of the passkey session, and if IAP ever
# comes off -- or fails to go on, three paragraphs down -- the session guard is what is left.
PC_HARNESS_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$CP_URL/harness" 2>/dev/null)
case "$PC_HARNESS_CODE" in
  302|303)
    echo "  console: /harness sends an anonymous caller to /gate -- the app's own guard answers."
    ;;
  ""|000)
    echo "  WARNING: could not reach $CP_URL/harness to confirm the app's own guard answers."
    echo "           IAP is still applied below; 8b/10 re-checks the live surfaces."
    ;;
  403)
    echo "  WARNING: $CP_URL answered 403 to an anonymous caller. That is the Google Frontend"
    echo "  refusing the request, NOT your console leaking and NOT the app: the service has no"
    echo "  allUsers -> roles/run.invoker binding. The usual cause is an organization policy on"
    echo "  constraints/iam.allowedPolicyMemberDomains. IAP is applied below regardless."
    ;;
  *)
    die "the console at $CP_URL/harness answered $PC_HARNESS_CODE to an ANONYMOUS caller.
Underneath IAP the app's own passkey session is what protects the console, and that guard is
not answering. Refusing to continue rather than put IAP in front of a console that would be
readable by anyone the moment IAP came off."
    ;;
esac

# ---- the MCP service: IAP OFF, and publicly invokable ----
# Set NEGATIVELY and unconditionally, so an upgrade over a service that already has IAP on is
# corrected rather than left broken. A non-zero exit here is harmless where IAP was never on.
PC_IAP_OFF_RC=0
gcloud beta run services update "$MC_SVC" --region "$REGION" --project "$PROJECT" --no-iap --quiet >/dev/null 2>&1 || PC_IAP_OFF_RC=$?
if [ "$PC_IAP_OFF_RC" != "0" ]; then
  echo "  NOTE: 'gcloud beta run services update --no-iap' on $MC_SVC exited $PC_IAP_OFF_RC."
  echo "  If this service never had IAP on, nothing was needed and this is harmless."
  echo "  If it DID, no MCP client can connect. Turn it off:"
  echo "    gcloud beta run services update $MC_SVC --region $REGION --project $PROJECT --no-iap"
fi
PC_MC_INV_RC=0
retry gcloud run services add-iam-policy-binding "$MC_SVC" --region "$REGION" --project "$PROJECT" --member=allUsers --role=roles/run.invoker --condition=None >/dev/null 2>&1 || PC_MC_INV_RC=$?
if [ "$PC_MC_INV_RC" = "0" ]; then
  echo "  $MC_SVC accepts unauthenticated connections; the app does its own bearer auth."
else
  echo "  WARNING: could not grant allUsers roles/run.invoker on $MC_SVC (exit $PC_MC_INV_RC)."
  echo "  Every MCP client will get a Google 403 before a byte reaches the app. Grant it:"
  echo "    gcloud run services add-iam-policy-binding $MC_SVC --region $REGION --project $PROJECT --member=allUsers --role=roles/run.invoker --condition=None"
  echo "  An organization policy on constraints/iam.allowedPolicyMemberDomains blocks this."
fi

# ---- the console: IAP ON, and NOT publicly invokable ----
# PC_IAP_ON is the single fact steps 8b/10 and 10/10 read. It is set on EVERY path below,
# including the ones that fail, because an unset variable under `set -u` would abort the run
# at a line that is only reached when something else has already gone wrong.
PC_IAP_ON=0
# VERIFY THE SUBCOMMAND EXISTS BEFORE DEPENDING ON IT. --help is answered by the local SDK and
# does not touch the network. Without this, an SDK lacking `gcloud iap web` would enable IAP
# successfully and then fail the access grant -- which is the lockout path, not a warning.
PC_IAPIAM_RC=0
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud iap web add-iam-policy-binding --help >/dev/null 2>&1 </dev/null || PC_IAPIAM_RC=$?
if [ "$PC_IAPIAM_RC" != "0" ]; then
  echo "  IAP NOT ENABLED: this SDK has no 'gcloud iap web add-iam-policy-binding' (exit"
  echo "  $PC_IAPIAM_RC), so IAP could be switched on and nobody granted access -- which locks"
  echo "  you out of your own console. Refusing to do half of it. Run 'gcloud components"
  echo "  update', then re-run this installer. Until then the console rests on the app's own"
  echo "  passkey session and is reachable by anyone who learns its URL."
else
  PC_IAP_RC=0
  gcloud beta run services update "$CP_SVC" --region "$REGION" --project "$PROJECT" --iap --quiet >/dev/null 2>&1 || PC_IAP_RC=$?
  if [ "$PC_IAP_RC" != "0" ]; then
    echo "  COULD NOT ENABLE IAP ON $CP_SVC (exit $PC_IAP_RC)."
    echo "  This usually means this project is not in a Google Cloud Organization."
    echo "  The install continues and everything works, but your console is reachable by anyone"
    echo "  who has the URL until you enable IAP yourself:"
    echo "    https://console.cloud.google.com/run/detail/$REGION/$CP_SVC/security?project=$PROJECT"
  else
    # The access grant goes on the IAP resource, NOT on the Run service; granting
    # roles/iap.httpsResourceAccessor via `run services add-iam-policy-binding` is rejected.
    # The principal TYPE must match the identity. An IAM member is TYPE:EMAIL and Google
    # refuses a mismatched pair outright rather than ignoring it.
    case "$ACCT" in
      *gserviceaccount.com) PC_IAP_MEMBER="serviceAccount:$ACCT" ;;
      *)                    PC_IAP_MEMBER="user:$ACCT" ;;
    esac
    PC_GRANT_RC=0
    retry gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service="$CP_SVC" \
      --region="$REGION" --project="$PROJECT" --member="$PC_IAP_MEMBER" \
      --role=roles/iap.httpsResourceAccessor >/dev/null 2>&1 || PC_GRANT_RC=$?
    if [ "$PC_GRANT_RC" != "0" ]; then
      # ROLL BACK RATHER THAN DIE. Dying here leaves IAP ON with nobody granted -- a console
      # nobody can open, including the person who would fix it, and including the gate that
      # every repair has to be approved at. Undoing both halves returns the install to the
      # state the paragraph above describes: guarded by the passkey session, and reachable.
      echo "  IAP WAS ENABLED AND $ACCT COULD NOT BE GRANTED ACCESS (exit $PC_GRANT_RC)."
      echo "  Rolling IAP back rather than leaving you locked out of your own gate."
      gcloud beta run services update "$CP_SVC" --region "$REGION" --project "$PROJECT" --no-iap --quiet >/dev/null 2>&1
      PC_UNDO_RC=0
      retry gcloud run services add-iam-policy-binding "$CP_SVC" --region "$REGION" --project "$PROJECT" --member=allUsers --role=roles/run.invoker --condition=None >/dev/null 2>&1 || PC_UNDO_RC=$?
      if [ "$PC_UNDO_RC" != "0" ]; then
        echo "  AND THE ROLLBACK'S INVOKER BINDING ALSO FAILED (exit $PC_UNDO_RC). $CP_SVC may now"
        echo "  answer 403 to everyone. Restore it by hand before anything else:"
        echo "    gcloud run services add-iam-policy-binding $CP_SVC --region $REGION --project $PROJECT --member=allUsers --role=roles/run.invoker --condition=None"
      fi
      echo "  To finish this properly: grant yourself access, then re-run the installer."
      echo "    gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=$CP_SVC --region=$REGION --project=$PROJECT --member=$PC_IAP_MEMBER --role=roles/iap.httpsResourceAccessor"
    else
      # THE OTHER HALF, AND IT IS BELT AND BRACES RATHER THAN A DISCOVERY. Step 6/10 deploys
      # the console with --allow-unauthenticated, which asks for the allUsers binding on EVERY
      # run, and enabling IAP revokes it. Measured 2026-08-09 in the dev harness on two real
      # services: after --iap the console's run IAM policy held exactly ONE member,
      # serviceAccount:service-<num>@gcp-sa-iap, and this remove then exited 1 with "Policy
      # binding with the specified principal, role, and condition not found!".
      # SO A NON-ZERO EXIT HERE IS THE NORMAL CASE AND IS NOT FATAL. The command stays because
      # "IAP revokes it" is Google behaviour we do not control, and a console that IAP fronts
      # for browsers while allUsers can still invoke it directly is worth one idempotent line
      # to make impossible. What is NOT claimed: this run never observed that state.
      PC_RMINV_RC=0
      gcloud run services remove-iam-policy-binding "$CP_SVC" --region "$REGION" --project "$PROJECT" --member=allUsers --role=roles/run.invoker --condition=None >/dev/null 2>&1 || PC_RMINV_RC=$?
      PC_IAP_ON=1
      echo "  the console is behind IAP. only $ACCT can reach it."
      if [ "$PC_RMINV_RC" = "0" ]; then
        echo "  and its allUsers invoker binding is removed, so IAP is the only way in."
      else
        echo "  its allUsers invoker binding was already absent (enabling IAP revokes it)."
      fi
    fi
  fi
fi

# ---- say which URL is which, once, in one place ----
echo
echo "  console  $CP_URL      behind IAP, and where you register your passkey"
echo "  mcp      $MC_URL      NOT behind IAP, and where an MCP client connects"
echo "  These are not interchangeable. Handing a connector the console URL is the defect this"
echo "  step exists to prevent; handing a browser the MCP URL gets you a 404 at the root,"
echo "  because GET / is a console route and the MCP service deliberately does not serve it."
if [ "$PC_IAP_ON" != "1" ]; then
  echo "  IAP IS NOT ON. The console is guarded by the app's passkey session alone. That guard"
  echo "  was asserted against your live deployment above, but it is one layer, not two."
fi

say "8b/10 functional self-test -- does the installed system actually ANSWER?"
# [SEC-SELFTEST-FUNCTIONAL-V1] THE CONTROL WHOSE ABSENCE LET NINETEEN BROKEN TOOLS SHIP.
# The self-test at 10/10 invoked ZERO MCP tools. It checked that /gate redirects, that
# POST /mcp is 401 and that the executor is private -- and every one of the nineteen tools
# with no backing infrastructure passed it. A self-test that cannot fail is worse than no
# self-test, because it is the sentence "ready, no defects" with nothing behind it.
#
# THIS STEP SITS ABOVE THE 9/10 BOUNDARY ON PURPOSE, AND THE BOUNDARY DID NOT MOVE.
# `exit 20` and the pc-bootstrap-secret mint are exactly where they were. What changed is
# that the functional phase now runs BEFORE either -- so an unattended --rehearse gets the
# same coverage a full install does, and a real install learns its tool surface is broken
# BEFORE it spends the operator's Face ID rather than after.
#
# TWO DESIGN RULES, BOTH LEARNED FROM A GREEN RUN THAT MEANT NOTHING:
#  1. ASSERT ON CONTENT, NEVER ON THE ABSENCE OF AN ERROR. index.ts returns a NORMAL,
#     SUCCESSFUL MCP result whose text reads "data lake not configured" for all four lake
#     tools. There is no throw and no non-2xx. Anything testing exceptions or status codes
#     goes green against a completely unconfigured lake.
#  2. NOT-EXERCISED IS NOT A PASS. A tool that genuinely cannot run unattended is reported
#     as NOT-EXERCISED with its reason, and its backing resource is asserted instead. The
#     census at the foot of the report names both sets, because blurring them is what
#     happened.
PC_FUNC_FAIL=0
PC_FUNC_AT=$(gcloud auth print-access-token --project "$PROJECT" 2>/dev/null)
if [ -z "$PC_FUNC_AT" ]; then
  echo "  FAIL  could not obtain an access token, so the functional phase cannot mint the"
  echo "        throwaway identity it needs. The tool surface was NOT proven."
  PC_FUNC_FAIL=1
else
  PC_FUNC_URL="$MC_URL" PC_FUNC_CONSOLE="$CP_URL" PC_FUNC_IAP="$PC_IAP_ON" \
  PC_FUNC_PROJECT="$PROJECT" PC_FUNC_DB="$FSDB" \
  PC_FUNC_LAKE="$PC_LAKE_BUCKET" PC_FUNC_ROLE="fleet-onboarder" PC_FUNC_AT="$PC_FUNC_AT" \
  python3 - <<'PCFUNC'
import hashlib, json, os, secrets, sys, time, urllib.error, urllib.request

# PC_FUNC_URL IS THE MCP SERVICE, NOT THE CONSOLE. Every tool call below goes to /mcp, which
# only the MCP service serves. Pointing this at the console would 404 every call and the
# census would report the whole tool surface as unreachable.
MC = os.environ["PC_FUNC_URL"].rstrip("/")
CONSOLE = os.environ.get("PC_FUNC_CONSOLE", "").rstrip("/")
IAP_ON = os.environ.get("PC_FUNC_IAP", "0") == "1"
AT = os.environ["PC_FUNC_AT"]
PROJ = os.environ["PC_FUNC_PROJECT"]
DB = os.environ["PC_FUNC_DB"]
LAKE = os.environ["PC_FUNC_LAKE"]
ROLE = os.environ["PC_FUNC_ROLE"]

FS = "https://firestore.googleapis.com/v1/projects/" + PROJ + "/databases/" + DB
GAUTH = {"Authorization": "Bearer " + AT}
FINDINGS = []
EXERCISED = []
ASSERTED = []

# The reviewed, written-down list of things that genuinely cannot run unattended. A finding
# that drops out of "exercised" and is NOT named here is a coverage regression, not a pass.
UNEXERCISABLE = {
    "FN.LAKE_WRITE": "harWriteLake seals through the PCV1 vault, so a write here would test "
                     "the VAULT rather than the lake tools. 5e/10 creates the keyring and the "
                     "KEM key always and MINTS shared/vault/master.kem only where this machine "
                     "has an ML-KEM capability; where it could not, it says what is missing and "
                     "the lake is FAIL-CLOSED, not plaintext -- every write outside the five "
                     "cleartext prefixes THROWS, with no plaintext fallback. Either way 5e/10 "
                     "reports it. The bucket and the grant are asserted instead.",
    "FN.STAGE_TOOLS": "stage_privileged_job, run_command and ssh_executor each need a human "
                      "passkey with user presence. No approval is produced or verified here.",
    "FN.VM_TOOLS": "vm_status/vm_start/vm_stop/vm_resize need a workstation instance. 5d/10 "
                   "says whether one was made; vm_start/stop/resize also spend an approval.",
    "FN.BROWSER_TOOLS": "browser_open/navigate/tabs need a live CDP endpoint on a running box. "
                        "This installer provisions no such endpoint, so there is nothing to drive.",
}

KNOWN = ("whoami read_graph search_nodes open_nodes list_work_items read_journal "
         "list_pending_confirm read_file list_files read_history search_history get_time "
         "read_job_log run_status vm_status list_my_messages check_answer browser_tabs "
         "create_entities create_relations add_observations delete_entities "
         "delete_observations delete_relations append_journal post_work_item "
         "complete_work_item cancel_work_item log_history write_file put_file "
         "answer_message ask_agent refresh dev_api stage_privileged_job run_command "
         "ssh_executor gcp_api run_roll vm_start vm_stop vm_resize browser_open "
         "browser_navigate browser_eval").split()
GIT_TOOLS = "git_read git_list git_log git_diff git_propose git_propose_patch git_push".split()

# collection-group, query-scope, ordered field list. ONE ROW PER pc_index() INVOCATION at
# 2b/10, counted as invocations. The naive grep for the gcloud line reports 1, because the
# string occurs once inside the helper -- which is how two of these stayed missing.
WANT_INDEXES = [
    ("observations", "COLLECTION_GROUP", ["status", "createdAt"]),
    ("memory_entities", "COLLECTION", ["scope", "entityType"]),
    ("memory_relations", "COLLECTION", ["scope", "from"]),
    ("memory_relations", "COLLECTION", ["scope", "to"]),
    ("chat_history", "COLLECTION", ["agent_id", "timestamp"]),
    ("work_items", "COLLECTION", ["assigned_role", "status", "created_at"]),
]


def rec(status, ident, how, msg):
    FINDINGS.append((status, ident, how, msg))
    if status != "NOT-EXERCISED":
        (EXERCISED if how == "EXERCISED" else ASSERTED).append(ident)


def http(url, method="GET", body=None, hdrs=None, timeout=90):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (hdrs or {}).items():
        req.add_header(k, v)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, dict((k.lower(), v) for k, v in r.getheaders()), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict((k.lower(), v) for k, v in e.headers.items()), e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, {}, "TRANSPORT: " + str(e)


def frames(text):
    if text[:1] in ("{", "["):
        try:
            return [json.loads(text)]
        except Exception:
            return []
    out = []
    for line in text.splitlines():
        if line.startswith("data:"):
            try:
                out.append(json.loads(line[5:].strip()))
            except Exception:
                pass
    return out


TOK = secrets.token_hex(32)
KEY = "pcs_" + secrets.token_hex(18)
EXP = int(time.time() * 1000) + 300000
MAUTH = {"Authorization": "Bearer " + TOK, "Accept": "application/json, text/event-stream"}


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def fsput(col, docid, fields):
    st, _h, _b = http(FS + "/documents/" + col + "?documentId=" + docid, "POST", {"fields": fields}, GAUTH, 60)
    return st == 200


def fsdel(col, docid):
    http(FS + "/documents/" + col + "/" + docid, "DELETE", None, GAUTH, 60)


def rpc(msg):
    st, _h, b = http(MC + "/mcp", "POST", msg, MAUTH)
    fr = frames(b)
    for f in fr:
        if isinstance(f, dict) and ("result" in f or "error" in f):
            return st, f
    return st, {"error": {"message": "no JSON-RPC frame in a " + str(st) + " response: " + b[:200]}}


def call(name, args):
    a = dict(args)
    a["agent"] = KEY
    msg = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": a}}
    st, f = rpc(msg)
    if "error" in f and "initializ" in json.dumps(f).lower():
        st, f = rpc([{"jsonrpc": "2.0", "id": 0, "method": "initialize",
                      "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                                 "clientInfo": {"name": "install-selftest", "version": "1"}}},
                     {"jsonrpc": "2.0", "method": "notifications/initialized"}, msg])
    return st, f


def text_of(f):
    r = f.get("result") or {}
    return "\n".join(str(x.get("text", "")) for x in (r.get("content") or []) if isinstance(x, dict))


# ---- FN.MCP_REACHABLE -------------------------------------------------------------
# The old 10/10 line asserted POST /mcp returns 401 and called that "MCP requires a token".
# It is green when IAP answers 401 at the edge -- in which case the app was never reached
# and NO MCP CLIENT CAN CONNECT TO THIS INSTALL AT ALL. The two 401s are told apart by who
# generated them, which is the only thing that distinguishes a working surface here.
st, h, b = http(MC + "/mcp", "POST", {}, {"Accept": "application/json, text/event-stream"}, 45)
iap = "x-goog-iap-generated-response" in h
chal = "resource_metadata=" in (h.get("www-authenticate") or "")
if chal and not iap:
    rec("PASS", "FN.MCP_REACHABLE", "EXERCISED",
        "the app on " + MC + " answered " + str(st) + " with its own OAuth challenge")
elif iap:
    rec("FAIL", "FN.MCP_REACHABLE", "EXERCISED",
        "IAP answered " + str(st) + " at the edge of " + MC + " and the app was never reached. "
        "Every MCP client -- not just this test -- is refused before a byte arrives. IAP "
        "protects the WHOLE service, /mcp included, and this is the service that must NOT have "
        "it. Turn it off and restore the public invoker binding: gcloud beta run services "
        "update <mcp-svc> --no-iap, then gcloud run services add-iam-policy-binding <mcp-svc> "
        "--member=allUsers --role=roles/run.invoker --condition=None")
elif st == 403 and not chal:
    rec("FAIL", "FN.MCP_REACHABLE", "EXERCISED",
        "POST /mcp answered 403 from the Google Frontend, with no IAP header and no OAuth "
        "challenge. This is the Cloud Run INVOKER refusal, not IAP and not the app: the "
        "allUsers -> roles/run.invoker binding is missing, which is what enabling IAP "
        "revokes, and which an org policy on iam.allowedPolicyMemberDomains can forbid "
        "restoring. Fix: gcloud run services add-iam-policy-binding <svc> --region <region> "
        "--member=allUsers --role=roles/run.invoker --condition=None")
else:
    rec("FAIL", "FN.MCP_REACHABLE", "EXERCISED",
        "POST /mcp answered " + str(st) + " with neither an app OAuth challenge nor an IAP "
        "response: " + b[:160])

# ---- FN.CONSOLE_IAP: the OTHER half of the split, and the only reliable discriminator -----
# Both surfaces answer 401/302 to an anonymous caller, so a status code cannot tell them
# apart. WHO generated the response can. x-goog-iap-generated-response is set by IAP and by
# nothing else, so its presence on the console and its ABSENCE on /mcp above is the pair of
# facts that proves the split is the right way round. Asserting only one of them would pass
# on a deployment with both services configured identically.
if not CONSOLE:
    rec("NOT-EXERCISED", "FN.CONSOLE_IAP", "EXERCISED", "no console URL was passed to this phase")
    UNEXERCISABLE["FN.CONSOLE_IAP"] = "no console URL was passed to this phase"
elif not IAP_ON:
    rec("NOT-EXERCISED", "FN.CONSOLE_IAP", "EXERCISED",
        "step 8/10 reported that it could not enable IAP on the console")
    UNEXERCISABLE["FN.CONSOLE_IAP"] = (
        "step 8/10 could not enable IAP on the console -- most often because the project is "
        "not in a Google Cloud Organization -- and said so at the time. The console is "
        "running on the app's own passkey session alone, which 8/10 asserted against the live "
        "deployment. That is one layer where the design calls for two, and it is reported "
        "here as NOT-EXERCISED rather than as a pass.")
else:
    cst, ch, _cb = http(CONSOLE + "/harness", "GET", None, {}, 45)
    if "x-goog-iap-generated-response" in ch:
        rec("PASS", "FN.CONSOLE_IAP", "EXERCISED",
            "IAP answered " + str(cst) + " for an anonymous caller at the console edge")
    elif cst in (401, 302, 303):
        rec("FAIL", "FN.CONSOLE_IAP", "EXERCISED",
            "the console answered " + str(cst) + " but WITHOUT x-goog-iap-generated-response, so "
            "that refusal came from the app, not from IAP. The status code alone would have "
            "passed this check, which is exactly why it is not the assertion. The console is "
            "not behind IAP and there is no bootstrap path protected at the edge.")
    else:
        rec("FAIL", "FN.CONSOLE_IAP", "EXERCISED",
            "the console answered " + str(cst) + " to an anonymous caller with no IAP header. "
            "Anything other than an IAP refusal here means the edge is not guarding it.")

MINTED = False
if any(f[0] == "FAIL" and f[1] == "FN.MCP_REACHABLE" for f in FINDINGS):
    for i in ("FN.WHOAMI", "FN.TOOL_CENSUS", "FN.MEMORY_GRAPH", "FN.LAKE_LIST"):
        rec("NOT-EXERCISED", i, "EXERCISED", "the MCP surface is unreachable -- see FN.MCP_REACHABLE")
        UNEXERCISABLE[i] = "blocked by FN.MCP_REACHABLE, which is itself FAIL"
else:
    # A THROWAWAY IDENTITY, AND WHY IT IS SAFE. Two Firestore documents whose IDs are
    # sha256 of a random secret, holding a 300-second exp. The secrets exist only in this
    # process's memory, are never printed and never written to disk; both documents are
    # deleted below. If this process is killed between the two, the records are inert the
    # moment the exp passes -- oaBearerRole and pcSessionLookup BOTH fail closed on it.
    MINTED = (fsput("oauth_tokens", sha(TOK),
                    {"role": {"stringValue": ROLE}, "revoked": {"booleanValue": False},
                     "exp": {"integerValue": str(EXP)}})
              and fsput("session_keys", sha(KEY),
                        {"role": {"stringValue": ROLE}, "revoked": {"booleanValue": False},
                         "label": {"stringValue": "installer 8b/10 self-test"},
                         "exp": {"integerValue": str(EXP)}}))

try:
    if MINTED:
        # ---- FN.WHOAMI: the one call every agent is told to make first ----------------
        st, f = call("whoami", {})
        t = text_of(f)
        if t.startswith("ROLE: " + ROLE):
            rec("PASS", "FN.WHOAMI", "EXERCISED", "resolved " + ROLE + " through the real MCP surface")
        else:
            rec("FAIL", "FN.WHOAMI", "EXERCISED", "whoami did not resolve: " + (t or json.dumps(f))[:200])

        # ---- FN.TOOL_CENSUS: an unclassified tool FAILS the run ----------------------
        st, f = rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        names = [str(x.get("name")) for x in ((f.get("result") or {}).get("tools") or [])]
        unknown = [n for n in names if n not in KNOWN and n not in GIT_TOOLS]
        gitseen = [n for n in names if n in GIT_TOOLS]
        if not names:
            rec("FAIL", "FN.TOOL_CENSUS", "EXERCISED", "tools/list returned nothing: " + json.dumps(f)[:200])
        elif unknown:
            rec("FAIL", "FN.TOOL_CENSUS", "EXERCISED",
                "tool(s) this self-test has no class for, so nothing here backs them: " + " ".join(unknown)
                + ". Add them to KNOWN and give them a check, or stop registering them.")
        elif gitseen:
            rec("FAIL", "FN.TOOL_CENSUS", "EXERCISED",
                "the git tools are registered but this installer provisions no repository, so "
                "they fail on first call: " + " ".join(gitseen))
        else:
            rec("PASS", "FN.TOOL_CENSUS", "EXERCISED",
                str(len(names)) + " tools, all classified, git tools correctly absent")

        # ---- FN.MEMORY_GRAPH: exercises the 2b/10 indexes, open_nodes included --------
        # open_nodes queries memory_relations scope+from AND scope+to. Only the first was
        # indexed until [SEC-TOOLINFRA-V3-M5], so this call threw FAILED_PRECONDITION.
        ent = "install-selftest-" + secrets.token_hex(4)
        st, f = call("create_entities", {"entities": [{"name": ent, "entityType": "selftest"}], "scope": "own"})
        c1 = text_of(f)
        st, f = call("open_nodes", {"names": [ent], "scope": "own"})
        c2 = text_of(f)
        st, f = call("delete_entities", {"entityNames": [ent], "scope": "own"})
        low = (c1 + c2).lower()
        if "failed_precondition" in low or "requires an index" in low:
            rec("FAIL", "FN.MEMORY_GRAPH", "EXERCISED",
                "a memory query wants a composite index that does not exist: " + (c1 + c2)[:300])
        elif ent in c2 and "OPEN_NODES_FAILED" not in c2:
            rec("PASS", "FN.MEMORY_GRAPH", "EXERCISED",
                "create_entities then open_nodes round-tripped, both relation queries served")
        else:
            rec("FAIL", "FN.MEMORY_GRAPH", "EXERCISED", "open_nodes did not return the entity: " + c2[:300])

        # ---- FN.LAKE_LIST: CONTENT, NOT STATUS ---------------------------------------
        # index.ts returns a normal successful result reading "data lake not configured".
        # No throw, no non-2xx. This is the assertion the last proof did not have.
        st, f = call("list_files", {"prefix": "shared/"})
        t = text_of(f)
        if "not configured" in t:
            rec("FAIL", "FN.LAKE_LIST", "EXERCISED",
                "list_files SUCCEEDED and did nothing: " + t[:160] + " -- DATA_LAKE_BUCKET is "
                "not reaching the serving revision. All four lake tools are no-ops.")
        elif "denied" in t.lower():
            rec("FAIL", "FN.LAKE_LIST", "EXERCISED", "list_files was denied: " + t[:160])
        else:
            rec("PASS", "FN.LAKE_LIST", "EXERCISED", "list_files read the configured lake")
    elif not any(f[1] == "FN.WHOAMI" for f in FINDINGS):
        for i in ("FN.WHOAMI", "FN.TOOL_CENSUS", "FN.MEMORY_GRAPH", "FN.LAKE_LIST"):
            rec("FAIL", i, "EXERCISED",
                "the throwaway self-test identity could not be written to Firestore, so no "
                "tool was called. Coverage was lost, which is a failure and not a pass.")
finally:
    if MINTED:
        fsdel("oauth_tokens", sha(TOK))
        fsdel("session_keys", sha(KEY))

# ---- FN.INDEXES_EXIST: existence off the database, never acceptance off the installer --
st, _h, b = http(FS + "/collectionGroups/-/indexes", "GET", None, GAUTH, 60)
try:
    live = json.loads(b).get("indexes") or []
except Exception:
    live = []
have = set()
for ix in live:
    fl = [x.get("fieldPath") for x in (ix.get("fields") or []) if x.get("fieldPath") != "__name__"]
    have.add((ix.get("name", "").split("/collectionGroups/")[-1].split("/")[0],
              ix.get("queryScope"), tuple(fl), ix.get("state")))
missing = []
for cg, scope, fields in WANT_INDEXES:
    if not any(k[0] == cg and k[1] == scope and k[2] == tuple(fields) and k[3] in ("READY", "CREATING")
               for k in have):
        missing.append(cg + "(" + ",".join(fields) + ")")
if st != 200:
    rec("FAIL", "FN.INDEXES_EXIST", "ASSERTED", "could not read the index list: " + str(st) + " " + b[:160])
elif missing:
    rec("FAIL", "FN.INDEXES_EXIST", "ASSERTED",
        str(len(missing)) + " of " + str(len(WANT_INDEXES)) + " composite indexes are MISSING: "
        + " ".join(missing) + ". 2b/10 reporting acceptance is not evidence they exist.")
else:
    rec("PASS", "FN.INDEXES_EXIST", "ASSERTED",
        "all " + str(len(WANT_INDEXES)) + " composite indexes are live (READY or CREATING)")

# ---- FN.LAKE_WRITE backing: the bucket and the grant, since the write cannot run -------
st, _h, b = http("https://storage.googleapis.com/storage/v1/b/" + LAKE, "GET", None, GAUTH, 60)
if st == 200:
    rec("PASS", "FN.LAKE_BUCKET", "ASSERTED", "gs://" + LAKE + " exists")
else:
    rec("FAIL", "FN.LAKE_BUCKET", "ASSERTED", "gs://" + LAKE + " is not readable: " + str(st) + " " + b[:120])
for i in ("FN.LAKE_WRITE", "FN.STAGE_TOOLS", "FN.VM_TOOLS", "FN.BROWSER_TOOLS"):
    rec("NOT-EXERCISED", i, "ASSERTED", UNEXERCISABLE[i])

fails = 0
for status, ident, how, msg in FINDINGS:
    if status == "FAIL":
        fails += 1
    print("  %-14s %-20s %s" % (status, ident, msg))
print("")
print("  CENSUS -- read this before the verdict.")
print("    EXERCISED (a real call was made against the installed system): "
      + (" ".join(sorted(set(EXERCISED))) or "NONE"))
print("    ASSERTED  (the backing resource was proven to exist, no call made): "
      + (" ".join(sorted(set(ASSERTED))) or "NONE"))
ne = [f for f in FINDINGS if f[0] == "NOT-EXERCISED"]
print("    NOT-EXERCISED (did NOT run -- this is not a pass):")
for _s, ident, _h2, _m in ne:
    print("      " + ident + ": " + UNEXERCISABLE.get(ident, "NO REVIEWED REASON -- coverage regression"))
rot = [f[1] for f in ne if f[1] not in UNEXERCISABLE]
if rot:
    print("  COVERAGE REGRESSION: " + " ".join(rot) + " stopped running and is on no reviewed list.")
    fails += len(rot)
print("")
print("  %d FAIL, %d of %d findings exercised against the running system."
      % (fails, len(set(EXERCISED)), len(FINDINGS)))
sys.exit(min(fails, 99))
PCFUNC
  PC_FUNC_FAIL=$?
fi
if [ "$PC_FUNC_FAIL" -eq 0 ]; then
  echo "  the tool surface answered. Carried into 10/10; it is not re-run there."
else
  echo "  $PC_FUNC_FAIL FUNCTIONAL CHECK(S) FAILED. The installer ran; the installed system"
  echo "  does not do its job. 10/10 will refuse to print INSTALL COMPLETE over this."
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
FAIL=$PC_FUNC_FAIL
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
# [SEC-SURFACE-SPLIT-V1] WHICH CONSOLE ASSERTION IS CORRECT DEPENDS ON WHETHER IAP WENT ON,
# AND BOTH BRANCHES ASSERT SOMETHING REAL. With IAP on, an anonymous caller never reaches the
# app, so asserting the app's redirect would FAIL every healthy install -- and asserting the
# STATUS CODE alone would pass on a console with no IAP at all, because the app answers 302
# too. The header is the discriminator; it is generated by IAP and by nothing else. The app's
# own guard is not left unproven: 8/10 asserted it against the live deployment in the moment
# before IAP was put in front of it, which is the only moment it is observable.
if [ "$PC_IAP_ON" = "1" ]; then
  chk_has "console is behind IAP" "x-goog-iap-generated-response" "$(curl -s -D - -o /dev/null --max-time 30 "$CP_URL/harness" 2>/dev/null)"
  printf '  --   %-38s %s\n' "console passkey guard" "asserted at 8/10, before IAP went in front"
else
  chk_in  "console requires a session" "302 303" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$CP_URL/harness")"
  chk_has "console sends you to the gate" "/gate" "$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 30 "$CP_URL/harness")"
  chk     "dashboard data refuses anonymous" 401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$CP_URL/api/dash/summary")"
fi
# [SEC-SELFTEST-FUNCTIONAL-V1] THE OLD LINE HERE WAS `chk "MCP requires a token" 401`, and it
# was green for the WRONG REASON. IAP fronts the whole service, so IAP answers 401 at the edge
# and the app is never reached -- which is also the state in which no MCP client can connect at
# all. Both outcomes printed "ok". 8b/10 now asks WHO generated the 401 instead, which is the
# only thing that tells a working surface from an unreachable one, so the check is not repeated
# here. This line reports what 8b/10 found, and never invents a second verdict.
printf '  --   %-38s %s\n' "MCP surface" "judged at 8b/10, not re-tested here"
chk_in "executor is private" "403 404" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$GX_URL/healthz")"
chk_in "MCP root is console-only" "404 405" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$MC_URL/")"
# Security headers come from OUR app, set by a middleware mounted immediately after the app is
# created and therefore before every route. READ OFF THE MCP SERVICE, NOT THE CONSOLE: the
# console is behind IAP, where an anonymous fetch never reaches the app and this could only
# ever report on Google's edge. The MCP service is public by design and runs the SAME IMAGE,
# so the same middleware answers -- and the discovery document is a real, anonymous, 200 route.
chk_has "app security headers" "nosniff" "$(curl -s -D - -o /dev/null --max-time 30 "$MC_URL/.well-known/oauth-protected-resource" 2>/dev/null)"

# [SEC-PKG-STRANGER-V1] Resolve the Agent Plugins manifest against the URL we only now know. Written to
# agent-plugin.local/, NOT over agent-plugin/: the shipped copy is in MANIFEST.txt and
# editing a manifested file in place is exactly the drift this release refuses to allow.
if [ -d "$HERE/agent-plugin" ]; then
  mkdir -p "$HERE/agent-plugin.local"
  cp "$HERE/agent-plugin/plugin.json" "$HERE/agent-plugin.local/plugin.json" 2>/dev/null
  cp "$HERE/agent-plugin/README.md" "$HERE/agent-plugin.local/README.md" 2>/dev/null
  sed "s#https://REPLACE-WITH-YOUR-CONTROL-PLANE-HOST#${MC_URL}#" \
    "$HERE/agent-plugin/mcp.json" > "$HERE/agent-plugin.local/mcp.json" 2>/dev/null \
    && printf '  --   %-38s %s\n' "agent plugin resolved" "agent-plugin.local/mcp.json" \
    || printf '  --   %-38s %s\n' "agent plugin" "could not be resolved; edit mcp.json by hand"
fi
echo
if [ "$FAIL" -eq 0 ]; then
cat <<EOF
  INSTALL COMPLETE.

    console   ${CP_URL}/gate     (behind IAP -- sign in with $ACCT)
    MCP URL   ${MC_URL}/mcp      (NOT behind IAP -- this is the connector endpoint)

  TWO SERVICES, ONE IMAGE, AND THE URLS ARE NOT INTERCHANGEABLE. IAP on Cloud Run is one
  switch per service: the console needs it (it is how you reach the gate before a passkey
  exists) and the MCP surface cannot have it (IAP consumes the Authorization header, so an
  MCP client would be refused at the edge). Giving a connector the console URL is the one
  mistake this arrangement exists to prevent.

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

  The data lake bucket IS provisioned now (5c/10) and the control plane was verified to be
  serving its name off the running revision. Two things are reported at the step that would
  have made them rather than restated here:

    the PCV1 vault    5e/10 created keyring ${PC_VKR} and key ${PC_VKEY}, and MINTED
                      shared/vault/master.kem if this machine had an ML-KEM capability. That
                      step said which way it went. Where master.kem was NOT minted the lake is
                      FAIL-CLOSED, not plaintext: every write outside the five cleartext
                      prefixes throws, and 5e/10 printed what is missing and how to finish it.
    the browser tools they need a live CDP endpoint on a running box, and this installer
                      provisions none.

  Two tool families are DELIBERATELY ABSENT rather than broken, which is a different thing
  from the line above and is why they are listed separately:

    the 7 git tools   git_read, git_list, git_log, git_diff, git_propose, git_propose_patch
                      and git_push are NOT REGISTERED on this install. They serve exactly one
                      repository, they need GIT_REPO_ID and GIT_BUCKET, and this installer
                      provisions no git repository -- so you get no tool rather than a tool
                      that fails on its first call. To enable them: create a bucket for the
                      objects, grant $CP_SA objectAdmin on it, and set GIT_REPO_ID and
                      GIT_BUCKET on $MC_SVC -- they are MCP tools, so they are served by the
                      MCP service and setting them on the console does nothing. Leave
                      FIRESTORE_DATABASE UNSET and they follow
                      PC_FIRESTORE_DB to the database everything else already uses; setting
                      it to something different is refused at startup rather than serving you
                      an empty repository.
    ssh_executor      it stages, and the gated executor REFUSES it, because no SSH key is
                      configured. The refusal happens BEFORE the approval is consumed, so it
                      costs you nothing but the tap. To enable it: put the private key in a
                      Secret Manager secret, grant $GX_SA secretAccessor on THAT SECRET ONLY,
                      and set EXEC_SSH_KEY_SECRET to its name on $GX_SVC.

  The VM tools depend on the answer you gave at 5d/10; that step said which way it went.
EOF
else
  echo "  $FAIL CHECK(S) FAILED. The install is NOT good. Nothing above lies to you about that."
  exit 1
fi
