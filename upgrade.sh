#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Paracoding -- bring a LIVE install up to the release in this directory.
#
#   bash upgrade.sh
#   bash upgrade.sh --project P --region R
#
# WHAT THIS IS, AND WHY IT IS NOT A SECOND INSTALLER. install.sh HAS BEEN THE UPGRADE PATH
# since 9.0: it adopts by default, every resource step is describe-first, secrets are
# create-if-absent and never rotated, and the version marker carries "<version> <commit>" so
# the run already decides UPGRADE / same-build / DOWNGRADE-REFUSED for itself. Re-implementing
# any of that here would be a second copy of the provisioning rules, and two copies of a rule
# is how they drift. So this script OWNS NOTHING install.sh owns -- it delegates, and it adds
# the three things install.sh cannot do because it does not know it is upgrading anything:
#
#   1. IT REFUSES WHEN THERE IS NOTHING TO UPGRADE. install.sh on a project with no marker
#      builds a NEW install, which is correct for install.sh and wrong for a command called
#      upgrade. Somebody who types this at the wrong project should get a refusal, not a
#      surprise deployment and a bill.
#   2. IT WRITES DOWN THE WAY BACK BEFORE IT MOVES. The revisions currently serving are read
#      and printed FIRST, as named rollback targets. A live environment that goes wrong at
#      02:00 needs those names, and after the deploy they are harder to find.
#   3. IT VERIFIES THE RESULT OFF THE SERVICES. install.sh reports what it intended. This
#      reads the traffic status back and checks the serving revisions actually carry this
#      release, because a deploy message is not evidence.
#
# WHAT IT DELIBERATELY DOES NOT DO: decide whether your version ordering permits the upgrade.
# install.sh refuses a downgrade with the two versions named, and that refusal lives in one
# place. If this script also judged it, one of the two would eventually be wrong.
set -u

PROJECT="${PC_PROJECT:-}"
REGION="${PC_REGION:-}"
pc_usage() {
  echo "usage: bash upgrade.sh [--project PROJECT_ID] [--region REGION]"
  echo "  Upgrades an EXISTING install to the release in this directory. Refuses if there"
  echo "  is none -- use install.sh for a first install."
}
while [ $# -gt 0 ]; do
  case "$1" in
    --project)   [ $# -ge 2 ] || { pc_usage >&2; exit 2; }; PROJECT="$2"; shift 2 ;;
    --project=*) PROJECT="${1#--project=}"; shift ;;
    --region)    [ $# -ge 2 ] || { pc_usage >&2; exit 2; }; REGION="$2"; shift 2 ;;
    --region=*)  REGION="${1#--region=}"; shift ;;
    -h|--help)   pc_usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; pc_usage >&2; exit 2 ;;
  esac
done
HERE="$(cd "$(dirname "$0")" && pwd)"
PC_RELEASE="034a591d9ab265b8098cb9a11af68dac803ca72b"
PC_VERSION="12.0"

die() { echo; echo "UPGRADE REFUSED: $*" >&2; exit 30; }
command -v gcloud >/dev/null || die "gcloud not found. This script only talks to Google Cloud."
[ -f "$HERE/install.sh" ] || die "install.sh is not beside this script. An upgrade IS install.sh
run over an existing project, so without it there is nothing here to run."

if [ -z "$PROJECT" ]; then
  PROJECT=$(gcloud config get-value project 2>/dev/null | sed -n '1p' | tr -d '[:space:]')
  case "$PROJECT" in ""|"(unset)"|None|none) PROJECT="" ;; esac
fi
[ -n "$PROJECT" ] || die "no project. Pass --project PROJECT_ID or set one with gcloud config."
echo "  project: $PROJECT"
echo "  this release: $PC_VERSION ($PC_RELEASE)"

# ---------------------------------------------------------------- is there anything here?
# THE MARKER IS DISCOVERED, NOT COMPOSED. Composing it would mean reproducing the lane prefix
# and the install token, which is exactly the duplication this script exists to avoid. A
# listing answers the question directly and also catches the case a composed name would hide:
# more than one install in the project.
PC_MARKERS=$(gcloud secrets list --project "$PROJECT" \
  --filter="name~install-marker" --format='value(name)' 2>/dev/null | sed '/^$/d')
PC_NMARK=$(printf '%s\n' "$PC_MARKERS" | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$PC_NMARK" = 0 ]; then
  die "THIS PROJECT HAS NO PARACODING INSTALL TO UPGRADE.
No secret matching *install-marker* exists in $PROJECT, which is what every install writes at
1b/10. Nothing has been changed and nothing was created.
If you meant to install here for the first time:   bash install.sh --project $PROJECT"
fi
if [ "$PC_NMARK" != 1 ]; then
  echo "  markers found:"; printf '    %s\n' $PC_MARKERS
  die "THIS PROJECT HOLDS MORE THAN ONE INSTALL ($PC_NMARK markers, listed above).
Upgrading the wrong lane would redeploy somebody else's services. This script will not guess
which one you meant. Run install.sh directly with the PC_LANE you intend to upgrade."
fi
PC_MARK_SEC="$PC_MARKERS"
PC_MARK=$(gcloud secrets versions access latest --secret="$PC_MARK_SEC" --project "$PROJECT" 2>/dev/null | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
[ -n "$PC_MARK" ] || die "the marker secret $PC_MARK_SEC exists but has no readable version.
Refusing rather than guessing at what is installed. Inspect it with:
    gcloud secrets versions access latest --secret=$PC_MARK_SEC --project $PROJECT"
echo "  installed:    $PC_MARK   (from $PC_MARK_SEC)"

# ---------------------------------------------------------------- which region is it IN?
# THE REGION IS DISCOVERED FROM THE RUNNING SERVICES, AND THERE IS NO DEFAULT. A default here
# would not be a convenience, it would be a way to build a SECOND install and bill for it:
# Cloud Run is regional but the marker secret is not, so a project installed in one region and
# upgraded with a guessed region passes every check above -- marker present, exactly one,
# readable -- and then provisions a whole new fleet somewhere else. The gcloud config region is
# no better; it is the operator's habit, not a fact about this install. So the only region this
# script will use unprompted is the one the services are ACTUALLY in, read off an all-regions
# listing, and it refuses rather than guessing when that is not a single answer.
PC_LOC=$(gcloud run services list --project "$PROJECT" \
  --format='value(metadata.name,metadata.labels."cloud.googleapis.com/location")' 2>/dev/null \
  | grep -E 'control-plane|mcp|gate-exec' | awk '{print $NF}' | sed '/^$/d' | sort -u)
PC_NLOC=$(printf '%s\n' "$PC_LOC" | sed '/^$/d' | wc -l | tr -d ' ')
if [ -n "$REGION" ]; then
  # AN EXPLICIT --region THAT DISAGREES WITH THE INSTALL IS A TYPO, NOT AN INSTRUCTION. Honouring
  # it would deploy beside the install rather than over it, which is the failure this whole
  # script exists to prevent, so it is refused with both names rather than warned about.
  if [ "$PC_NLOC" = 1 ] && [ "$REGION" != "$PC_LOC" ]; then
    die "YOU ASKED FOR --region $REGION BUT THIS INSTALL RUNS IN $PC_LOC.
Upgrading in $REGION would not touch the running install at all -- it would build a SECOND one
there and bill for it. Nothing has been changed and nothing was created.
Re-run with no --region at all to use $PC_LOC, which is what this project actually has."
  fi
elif [ "$PC_NLOC" = 1 ]; then
  REGION="$PC_LOC"
elif [ "$PC_NLOC" = 0 ]; then
  die "THIS PROJECT HAS AN INSTALL MARKER BUT NO SERVICES THIS SCRIPT CAN SEE.
Nothing matching control-plane, mcp or gate-exec is running anywhere in $PROJECT, so there is
no region to read and nothing to upgrade over. Either the install did not finish, or its
services were removed. Nothing has been changed.
If you know the region and mean to run the installer over it:
    bash install.sh --project $PROJECT --region YOUR_REGION"
else
  echo "  regions found:"; printf '    %s\n' $PC_LOC
  die "THIS PROJECT RUNS PARACODING SERVICES IN MORE THAN ONE REGION (listed above).
This script will not guess which one you meant, because picking wrong redeploys the other.
Say it explicitly:   bash upgrade.sh --project $PROJECT --region ONE_OF_THE_ABOVE"
fi
echo "  region:       $REGION"

# ---------------------------------------------------------------- the way back, written down first
# READ BEFORE ANYTHING MOVES. After install.sh redeploys, the previous revision is still there
# but it is no longer the obvious one, and an operator looking for it mid-incident is looking
# under time pressure. Both surfaces are captured; a lane's services carry its prefix, so they
# are discovered the same way the marker was.
PC_SVCS=$(gcloud run services list --project "$PROJECT" --region "$REGION" \
  --format='value(metadata.name)' 2>/dev/null | grep -E 'control-plane|mcp|gate-exec' || true)

# [SEC-UPGRADE-TRAFFIC0-V1] status.traffic[0] IS NOT THE SERVING REVISION AND THIS SCRIPT USED
# TO READ IT. MEASURED on a real long-lived install, all three services, the same run:
#   status.traffic[0].revisionName -> -00195-hef / -mcp-00003-dop / gate-exec-00009-gav
#   the percent-filtered form      -> -00344-jac / -mcp-00055-mey / gate-exec-00047-haw
# status.traffic is an ARRAY OF EVERY TAGGED ROUTE, oldest first, and the one route carrying
# traffic sits wherever it happens to sit -- near the END on any install that has ever tagged a
# zero-traffic revision, which is every install that follows the documented deploy. Element [0]
# is therefore a revision from months ago that happens to still have a tag.
# BOTH USES WERE WRONG IN THE WAY THAT COSTS MOST. The rollback line would have handed the
# operator a command routing 100% of traffic to an ancient revision -- worse than printing no
# rollback line at all, because it looks authoritative at 02:00. And the verification would
# have read BUILD_COMMIT off that same ancient revision and exited 31 on a perfectly good
# upgrade. The filter below is what deploy-cp.py has always done.
pc_serving() {
  gcloud run services describe "$1" --project "$PROJECT" --region "$REGION" \
    --flatten='status.traffic[]' \
    --format='value(status.traffic.revisionName,status.traffic.percent)' 2>/dev/null \
    | awk -F'\t' '$2+0>0 {print $1" "$2}'
}

echo
echo "  ROLLBACK TARGETS -- the revisions serving RIGHT NOW, before this upgrade:"
PC_ROLLBACK=""
for _s in $PC_SVCS; do
  _rs=$(pc_serving "$_s")
  if [ -z "$_rs" ]; then echo "    $_s: no revision is carrying traffic"; continue; fi
  # A SPLIT IS PRESERVED RATHER THAN FLATTENED. If traffic is shared between revisions, a
  # rollback command naming only one of them silently changes the split as well as the version.
  _spec=$(printf '%s\n' "$_rs" | awk '{printf "%s%s=%s", (NR>1?",":""), $1, $2}')
  echo "    $_s  ->  $_spec"
  echo "      roll back with: gcloud run services update-traffic $_s --region $REGION --project $PROJECT --to-revisions $_spec"
  PC_ROLLBACK="$PC_ROLLBACK$_s=$_spec "
done
[ -n "$PC_ROLLBACK" ] || echo "    (none readable -- the upgrade continues, but write down nothing you cannot read)"

echo
echo "  Handing over to install.sh. IT owns every verdict from here: it decides upgrade,"
echo "  same-build or downgrade, and it refuses a downgrade itself with both versions named."
echo
PC_URC=0
bash "$HERE/install.sh" --project "$PROJECT" --region "$REGION" || PC_URC=$?
if [ "$PC_URC" != 0 ]; then
  echo
  echo "  install.sh exited $PC_URC. NOTHING BELOW IS ASSERTED -- read its output above for the"
  echo "  reason. Your rollback targets are printed at the top of this run."
  exit "$PC_URC"
fi

# ---------------------------------------------------------------- did it actually land?
# THE DEPLOY MESSAGE IS NOT EVIDENCE. This reads the serving revision out of each service and
# then looks for this release's commit in THAT REVISION's environment -- not the template's,
# which is what the service intends to serve next rather than what it is serving now.
#
# [SEC-UPGRADE-VERIFY-SUBSTR-V1] THE TEST IS "DOES THE RENDERED ENV CONTAIN THIS COMMIT", NOT
# "DOES A FIELD I PARSED OUT EQUAL IT", and the difference is the whole reliability of the
# check. Parsing means agreeing with gcloud about how it renders a repeated message field, and
# that rendering is not a documented contract -- it has been a bare list, a dict repr and a
# semicolon-joined string. A parser that guesses wrong reads EMPTY on a perfectly good upgrade
# and tells the operator to roll back a healthy deploy at 02:00, which is worse than not
# checking. A substring test is rendering-independent and still cannot pass wrongly: a
# revision built from a DIFFERENT commit does not contain this 40-hex string, and an
# unreadable or empty env does not contain it either. Both real failures still fail.
echo
echo "  VERIFYING -- reading the serving revisions back, not trusting the deploy output:"
PC_UOK=1
for _s in $PC_SVCS; do
  _rs=$(pc_serving "$_s")
  if [ -z "$_rs" ]; then echo "    $_s: could not read a serving revision"; PC_UOK=0; continue; fi
  # EVERY revision carrying traffic is checked, not just the first. A partial rollout that left
  # 10% on the old build is exactly the state this check exists to catch, and looking at one
  # revision would report the 90% and call it done.
  # A `while read` over a PIPE runs in a subshell, so PC_UOK=0 set inside it would be lost and
  # the script would report success on a failed upgrade. The `for` loop below runs in THIS
  # shell, which is why the revision list is re-scanned with awk rather than piped.
  for _r in $(printf '%s\n' "$_rs" | awk '{print $1}'); do
    _pct=$(printf '%s\n' "$_rs" | awk -v r="$_r" '$1==r{print $2}')
    case "$_s" in
      *gate-exec*) echo "    $_s: $_r ($_pct%)  (gate executor -- BUILD_COMMIT not asserted here)"; continue ;;
    esac
    _e=$(gcloud run revisions describe "$_r" --project "$PROJECT" --region "$REGION" \
         --format='value(spec.containers[0].env)' 2>/dev/null)
    case "$_e" in
      *"$PC_RELEASE"*) echo "    $_s: $_r ($_pct%)  carries $PC_RELEASE  OK" ;;
      "") echo "    $_s: $_r ($_pct%)  its environment could not be read at all"; PC_UOK=0 ;;
      *)  echo "    $_s: $_r ($_pct%)  does NOT carry $PC_RELEASE"
          echo "        its BUILD_COMMIT reads: $(printf '%s' "$_e" | tr ',;' '\n' | grep -i BUILD_COMMIT | head -1)"
          PC_UOK=0 ;;
    esac
  done
done
echo
if [ "$PC_UOK" = 1 ]; then
  echo "  UPGRADED to $PC_VERSION ($PC_RELEASE), verified off the services."
  echo "  The marker now reads: $(gcloud secrets versions access latest --secret=$PC_MARK_SEC --project $PROJECT 2>/dev/null | tr -d '\r')"
else
  echo "  !! THE UPGRADE DID NOT VERIFY. install.sh exited 0, but at least one surface is not"
  echo "  !! serving this release. That is the case where a deploy message would have lied to"
  echo "  !! you, which is why this check exists. Do not assume it is fine because it exited 0."
  echo "  !! Your rollback targets were printed at the top of this run."
  exit 31
fi
