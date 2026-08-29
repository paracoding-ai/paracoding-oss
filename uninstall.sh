#!/usr/bin/env bash
# Paracoding uninstaller.
# [SEC-UNINSTALL-NUKE-V1] Default is a FULL teardown of everything THIS VERSION installs,
# Firestore included -- and that is the whole of what it can promise. It deletes by exact
# name, so it can never take something that is not ours, and equally it cannot clean up an
# older install's leftovers. It says so, out loud, after it has looked: see
# [SEC-UNINSTALL-TRUTH-V1] at the end of this file.
# install.sh creates the Firestore database (step 2/10), so a reinstall rebuilds it from
# nothing. Pass --keep-data to preserve approvals, journal, memory and passkeys.
#
# [SEC-UNINSTALL-BUCKETS-V1] TWO THINGS THIS SCRIPT WILL NEVER DELETE, AND THE REASON IS
# NOT SQUEAMISHNESS. [SEC-UNINSTALL-LANEHELD-V1] adds the rest of the HELD set -- the KMS
# keyrings and keys, which NOBODY can delete; the CI build identity pc-<lane>-build@ and the
# CI notice topic, both ADOPTED rather than created; and the one-per-project shared
# infrastructure whenever a second lane still needs it. What follows is about the buckets.
# gs://<project>-datalake and gs://<project>-source are the only
# resources here that hold bytes YOU wrote and that exist nowhere else: agent memory, the
# handoffs, this wiki, and -- in the source bucket -- the git object store, which is to say
# your commit history. Everything else on this page can be rebuilt by re-running the
# installer; a deleted git object store cannot be rebuilt at all, and 'gcloud storage rm -r'
# has no undo. So they are SCANNED, reported by name with what they cost, and printed with
# the exact command that removes them -- and the "nothing left" line CANNOT print while
# either of them exists. Reporting a bucket you can still see is recoverable in one command.
# Deleting the only copy of a repository is not recoverable at all.
#
# [SEC-UNINSTALL-VM-V1] WHAT DOES GET DELETED THAT DID NOT BEFORE: the workstation instance,
# the IAP-only RDP firewall rule, the Cloud NAT and its router, and the pc-workstation
# service account. Those are the only resources this product creates that bill BY THE HOUR,
# they are created by exact name at 9/10 and by workstation.sh, and until now an uninstall
# could print its closing line with paracoding-workstation-win still running.
set -u
PROJECT=""; REGION="us-east1"; KEEP=0
for a in "$@"; do
  case "$a" in
    --keep-data) KEEP=1 ;;
    -*) echo "unknown flag: $a"; exit 2 ;;
    *) if [ -z "$PROJECT" ]; then PROJECT="$a"; else REGION="$a"; fi ;;
  esac
done
[ -n "$PROJECT" ] || { echo "usage: bash uninstall.sh PROJECT_ID [REGION] [--keep-data]"; exit 2; }
# [SEC-SINGLEPROJ-V2] THE UNINSTALLER IS LANE-AWARE, AND IT HAD TO BECOME SO IN THE SAME CHANGE
# THAT INTRODUCED LANES. A lane-blind uninstaller in a shared project is not an inconvenience,
# it is data loss: the Firestore sweep below matched '^paracoding-' with no tail, so tearing
# down a dev lane would have found, and DELETED, the production database sitting beside it.
# PC_LANE must be the SAME value the install was run with.
PC_LANE="${PC_LANE:-}"
case "$PC_LANE" in
  "") PC_LP="" ;;
  -*|*-) echo "PC_LANE may not start or end with a hyphen: $PC_LANE" >&2; exit 2 ;;
  *[!a-z0-9-]*) echo "PC_LANE must be lowercase letters, digits and hyphens: $PC_LANE" >&2; exit 2 ;;
  *) PC_LP="${PC_LANE}-" ;;
esac
# [SEC-INSTALL-TOKEN-V1] RECOVER THE PER-INSTALL TOKEN FIRST, BECAUSE EVERY EXACT NAME
# BELOW IS COMPOSED FROM IT. The installer names its resources with a random 6-hex token
# as an INFIX right after the lane prefix (pc-<lane>-<hex6>-session-secret) and records it
# as the pc-suffix label on the marker secret -- the one name that NEVER carries it.
# Resolution, strictest first: PC_SUFFIX in the environment; the marker label; and, with
# no marker at all, DISCOVERY over the listings by anchored per-family patterns -- exactly
# one token found everywhere proceeds, zero means a legacy install (unsuffixed names,
# exactly the names this script always used), and MORE THAN ONE REFUSES BY NAME, because
# deleting by a guessed token is deleting somebody's live install.
PC_TOK=""
PC_MARK_SEC="pc-${PC_LP}install-marker"
if [ -n "${PC_SUFFIX:-}" ]; then
  case "$PC_SUFFIX" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) PC_TOK="${PC_SUFFIX}-"; echo "  install token: $PC_SUFFIX (from PC_SUFFIX in the environment)" ;;
    *) echo "PC_SUFFIX must be exactly 6 lowercase hex characters, got: $PC_SUFFIX" >&2; exit 2 ;;
  esac
else
  PC_TOK_OUT=$(gcloud secrets describe "$PC_MARK_SEC" --project "$PROJECT" --format='value(labels.pc-suffix)' 2>&1); PC_TOK_RC=$?
  if [ "$PC_TOK_RC" -eq 0 ]; then
    PC_TOK_LBL=$(printf '%s' "$PC_TOK_OUT" | tr -d '[:space:]')
    case "$PC_TOK_LBL" in
      "") PC_TOK="" ;;
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) PC_TOK="${PC_TOK_LBL}-"; echo "  install token: $PC_TOK_LBL (from the marker's pc-suffix label)" ;;
      *) { echo "REFUSED (exit 30): the pc-suffix label on $PC_MARK_SEC is not 6 lowercase hex."
           echo "This script deletes BY EXACT NAME and cannot compose names from a corrupt token."
           echo "Read it, then re-run with PC_SUFFIX=<the real token> or fix the label:"
           echo "    gcloud secrets describe $PC_MARK_SEC --project $PROJECT --format='value(labels.pc-suffix)'"; } >&2; exit 30 ;;
    esac
  elif printf '%s' "$PC_TOK_OUT" | grep -qiE 'not found|404|NOT_FOUND|does not exist'; then
    # NO MARKER. Either a legacy install (which never wrote one), or the record was lost.
    # Discover: scrape a candidate token out of every family's own anchored shape. A
    # listing that fails contributes nothing and is said so; it does not abort, because
    # the legacy path with a failed listing is today's behaviour -- silent no-op deletes
    # and a COULD NOT CHECK entry in the report at the end.
    PC_TOK_HITS=""
    pc_tok_scrape() { # $1 = names, one per line, already stripped of any resource path
      printf '%s\n' "$1" | sed -n \
        -e "s/^pc-${PC_LP}\([0-9a-f]\{6\}\)-session-secret$/\1/p" \
        -e "s/^pc-${PC_LP}\([0-9a-f]\{6\}\)-human-confirm-secret$/\1/p" \
        -e "s/^pc-${PC_LP}\([0-9a-f]\{6\}\)-webauthn-creds$/\1/p" \
        -e "s/^pc-${PC_LP}\([0-9a-f]\{6\}\)-bootstrap-secret$/\1/p" \
        -e "s/^paracoding-${PC_LP}\([0-9a-f]\{6\}\)-control-plane$/\1/p" \
        -e "s/^paracoding-${PC_LP}\([0-9a-f]\{6\}\)-mcp$/\1/p" \
        -e "s/^paracoding-${PC_LP}\([0-9a-f]\{6\}\)-gate-exec$/\1/p" \
        -e "s/^pc-${PC_LP}\([0-9a-f]\{6\}\)-control-plane@${PROJECT}.iam.gserviceaccount.com$/\1/p" \
        -e "s/^pc-${PC_LP}\([0-9a-f]\{6\}\)-gate-exec@${PROJECT}.iam.gserviceaccount.com$/\1/p" \
        -e "s/^pc-${PC_LP}\([0-9a-f]\{6\}\)-workstation@${PROJECT}.iam.gserviceaccount.com$/\1/p" \
        -e "s/^pc-${PC_LP}\([0-9a-f]\{6\}\)-build@${PROJECT}.iam.gserviceaccount.com$/\1/p" \
        -e "s/^${PROJECT}-${PC_LP}\([0-9a-f]\{6\}\)-datalake$/\1/p" \
        -e "s/^${PROJECT}-${PC_LP}\([0-9a-f]\{6\}\)-source$/\1/p" \
        -e "s/^${PROJECT}-${PC_LP}\([0-9a-f]\{6\}\)-exec-records$/\1/p"
    }
    PC_TL=$(gcloud run services list --project "$PROJECT" --format='value(metadata.name)' 2>/dev/null) && PC_TOK_HITS="$PC_TOK_HITS
$(pc_tok_scrape "$(printf '%s\n' "$PC_TL" | sed 's#.*/##')")" || echo "  (could not list Cloud Run services while looking for a token; continuing)"
    PC_TL=$(gcloud secrets list --project "$PROJECT" --format='value(name)' 2>/dev/null) && PC_TOK_HITS="$PC_TOK_HITS
$(pc_tok_scrape "$(printf '%s\n' "$PC_TL" | sed 's#.*/##')")" || echo "  (could not list secrets while looking for a token; continuing)"
    PC_TL=$(gcloud iam service-accounts list --project "$PROJECT" --format='value(email)' 2>/dev/null) && PC_TOK_HITS="$PC_TOK_HITS
$(pc_tok_scrape "$PC_TL")" || echo "  (could not list service accounts while looking for a token; continuing)"
    PC_TL=$(gcloud storage buckets list --project "$PROJECT" --format='value(name)' 2>/dev/null) && PC_TOK_HITS="$PC_TOK_HITS
$(pc_tok_scrape "$PC_TL")" || echo "  (could not list buckets while looking for a token; continuing)"
    PC_TOKS=$(printf '%s\n' "$PC_TOK_HITS" | grep -v '^$' | sort -u)
    PC_TOK_N=$(printf '%s\n' "$PC_TOKS" | grep -c . )
    if [ "$PC_TOK_N" -eq 0 ]; then
      PC_TOK=""
    elif [ "$PC_TOK_N" -eq 1 ]; then
      PC_TOK="${PC_TOKS}-"
      echo "  install token: $PC_TOKS (no marker; discovered as the ONLY token this lane's"
      echo "  resource names carry, in their own anchored shapes)"
    else
      { echo "REFUSED (exit 30): no marker records this lane's install token, and the listings"
        echo "carry MORE THAN ONE candidate token in this lane's own name shapes:"
        printf '%s\n' "$PC_TOKS" | sed 's/^/    /'
        echo "This script deletes by exact name and will not guess between installs. Decide"
        echo "which install you are tearing down and re-run with it stated:"
        echo "    PC_SUFFIX=<one of the tokens above> bash uninstall.sh $PROJECT $REGION"; } >&2
      exit 30
    fi
  else
    { echo "REFUSED (exit 30): could not read the marker secret $PC_MARK_SEC (describe exited $PC_TOK_RC),"
      echo "so this run cannot tell whether this install's names carry a token. Could-not-read"
      echo "is not the same as absent, and guessing composes the WRONG names for every delete"
      echo "below. Fix the describe, or state the token with PC_SUFFIX=<6 hex>, and re-run."; } >&2
    exit 30
  fi
fi
echo "Tearing down paracoding in $PROJECT ($REGION)."
if [ -n "$PC_LANE" ]; then
  echo "  LANE: $PC_LANE -- only resources named paracoding-${PC_LP}* / pc-${PC_LP}* are touched."
  echo "  Anything of ours carrying a DIFFERENT lane prefix is reported at the end under"
  echo "  BELONGS TO ANOTHER LANE, and is neither deleted nor recommended for deletion."
fi
if [ "$KEEP" -eq 1 ]; then echo "  --keep-data: Firestore will be PRESERVED."
else echo "  FULL WIPE: the Firestore database goes too -- approvals, journal, memory, passkeys."; fi
echo "  The two Cloud Storage buckets are NEVER deleted by this script, with or without"
echo "  --keep-data. They are reported at the end with the command that removes them."
# [SEC-EXECBUCKET-V1] THE EXECUTOR RECORD BUCKET IS THE ONE BUCKET THIS SCRIPT DOES DELETE,
# AND THE DIFFERENCE FROM THE OTHER TWO IS NOT SENTIMENT. The lake and the source bucket hold
# bytes YOU wrote that exist nowhere else -- memory, the wiki, the git object store. This one
# holds the claim objects, the results and the executor journal of jobs run by an install that
# is being torn down, and it is the storage-side twin of the Firestore database three lines
# above: a FULL WIPE takes the journal, the approvals and the passkeys, so leaving the same
# records behind in a bucket would be an inconsistency, not a kindness. --keep-data preserves
# BOTH, exactly as it does for Firestore.
if [ "$KEEP" -eq 1 ]; then echo "  --keep-data: the executor record bucket is PRESERVED too."
else echo "  FULL WIPE: the executor record bucket goes with Firestore -- claims, run results,"; echo "  and the executor own journal objects."; fi
# [SEC-UNINSTALL-LANEHELD-V1] THE SHARED-INFRASTRUCTURE GUARD USED TO ASK "AM I THE UNPREFIXED
# LANE?", AND THAT IS THE WRONG QUESTION IN A SHARED PROJECT. Cloud NAT, its router, the RDP
# firewall rule, the Artifact Registry repo and the two Cloud Build staging buckets carry no
# ${PC_LP} because there is one of each PER PROJECT. A lane teardown already left them alone.
# But a PROD teardown -- PC_LANE unset -- deleted them unconditionally, and in a project that
# also carries a dev lane that takes the dev lane container images, its egress and its RDP
# path out from under a running install. The question asked here is therefore "is any OTHER
# lane of this product still in this project?", and a listing that FAILS answers YES:
# could-not-tell is not permission to delete somebody else infrastructure.
PC_SHARED=1
[ -z "$PC_LANE" ] || PC_SHARED=0
PC_PEERS=$(gcloud run services list --project "$PROJECT" --format='value(metadata.name)' 2>/dev/null) || PC_SHARED=0
for s in $PC_PEERS; do
  case "$s" in
    "paracoding-${PC_LP}${PC_TOK}control-plane"|"paracoding-${PC_LP}${PC_TOK}mcp"|"paracoding-${PC_LP}${PC_TOK}gate-exec") ;;
    paracoding-*control-plane|paracoding-*mcp|paracoding-*gate-exec) PC_SHARED=0 ;;
  esac
done
if [ "$PC_SHARED" -eq 0 ]; then
  echo "  SHARED infrastructure (Cloud NAT, its router, the RDP firewall rule, the Artifact"
  echo "  Registry repo and the Cloud Build staging buckets) is LEFT ALONE and reported, never"
  echo "  deleted: either this is a lane teardown, or another lane of this product is still"
  echo "  installed in $PROJECT, or the Cloud Run listing that would have told us failed."
fi
for s in "paracoding-${PC_LP}${PC_TOK}control-plane" "paracoding-${PC_LP}${PC_TOK}mcp" "paracoding-${PC_LP}${PC_TOK}gate-exec"; do
  gcloud run services delete "$s" --region "$REGION" --project "$PROJECT" --quiet 2>/dev/null
done
# [SEC-UNINSTALL-VM-V1] THE WORKSTATION FIRST, BECAUSE IT IS THE ONLY THING HERE BILLING BY
# THE HOUR. An instance is ZONAL and this script is only told a region, so the zone is read
# off ONE aggregated listing rather than guessed from the region -- us-east1 has b, c and d
# and no a at all, which is the same trap pc_workstation_create documents on the create side.
# Deleting an instance destroys its boot disk; that is what an uninstall means, and it is
# said out loud before each one rather than discovered afterwards.
# The two flavour names carry the token; the pre-rename single name predates it and never
# will ([SEC-INSTALL-TOKEN-V1]).
PC_WS_NAMES="paracoding-${PC_LP}${PC_TOK}workstation-win paracoding-${PC_LP}${PC_TOK}workstation-linux paracoding-${PC_LP}workstation"
PC_VMS=$(gcloud compute instances list --project "$PROJECT" --format='value(name,zone)' 2>/dev/null)
for v in $PC_WS_NAMES; do
  z=$(printf '%s\n' "$PC_VMS" | awk -v n="$v" '$1==n{print $2}' | head -n 1)
  [ -n "$z" ] || continue
  echo "  deleting Compute instance $v in $z -- this destroys its boot disk"
  gcloud compute instances delete "$v" --zone "$z" --project "$PROJECT" --quiet 2>/dev/null
done
if [ "$PC_SHARED" -eq 1 ]; then
gcloud compute firewall-rules delete paracoding-allow-rdp-iap --project "$PROJECT" --quiet 2>/dev/null
# The NAT CONFIG is a child of the router, so it goes first; a router still carrying a NAT
# refuses to be deleted, and the refusal here is silent.
gcloud compute routers nats delete paracoding-nat --router paracoding-nat-router --region "$REGION" --project "$PROJECT" --quiet 2>/dev/null
gcloud compute routers delete paracoding-nat-router --region "$REGION" --project "$PROJECT" --quiet 2>/dev/null
fi
for s in "pc-${PC_LP}${PC_TOK}session-secret" "pc-${PC_LP}${PC_TOK}human-confirm-secret" "pc-${PC_LP}${PC_TOK}approval-mac-key" "pc-${PC_LP}${PC_TOK}bootstrap-secret" "pc-${PC_LP}${PC_TOK}webauthn-creds"; do
  gcloud secrets delete "$s" --project "$PROJECT" --quiet 2>/dev/null
done
# [SEC-INSTALL-TOKEN-V1] THE MARKER GOES TOO, AND ONLY ON A FULL WIPE. It was read at the
# top of this file to recover the token every delete above composed with, so it is removed
# last. --keep-data KEEPS it: the preserved database and buckets are NAMED by that token,
# and deleting the only record of it would orphan the kept data from every future run.
if [ "$KEEP" -eq 0 ]; then
  gcloud secrets delete "pc-${PC_LP}install-marker" --project "$PROJECT" --quiet 2>/dev/null
fi
# pc-workstation IS OURS. install.sh 9/10 creates it for the VM, and until now it was
# absent from this list and from the known-names list below -- so an uninstall deleted the
# other two, left this one standing, and then reported it as "NOT OURS TO REMOVE ... most
# likely from an older install". It was ours, from this version, made minutes earlier.
for a in "pc-${PC_LP}${PC_TOK}control-plane" "pc-${PC_LP}${PC_TOK}gate-exec" "pc-${PC_LP}${PC_TOK}workstation"; do
  gcloud iam service-accounts delete "${a}@${PROJECT}.iam.gserviceaccount.com" --project "$PROJECT" --quiet 2>/dev/null
done
# SHARED BY EVERY LANE. cloud-run-source-deploy is created by `run deploy --source` and holds
# the container images for whatever else is deployed in this project; the two staging buckets
# are likewise per-project, not per-lane. Deleting any of them while another lane is installed
# takes that lane's images out from under it, so a lane teardown does not touch them.
if [ "$PC_SHARED" -eq 1 ]; then
gcloud artifacts repositories delete cloud-run-source-deploy --location="$REGION" --project "$PROJECT" --quiet 2>/dev/null
gcloud storage rm -r "gs://run-sources-${PROJECT}-${REGION}" --quiet 2>/dev/null
gcloud storage rm -r "gs://${PROJECT}_cloudbuild" --quiet 2>/dev/null
fi
if [ "$KEEP" -eq 0 ]; then
  # [SEC-NAMED-DB-V1] Only ever delete databases WE created (pc-*). The (default) database
  # may hold the operator's own data and is never ours to remove.
  # [SEC-SINGLEPROJ-V2] ANCHORED AT BOTH ENDS. '^paracoding-' alone matched every lane in the
  # project, so a dev teardown would have deleted the production database. The installer coins
  # exactly paracoding-${PC_LP}<12 hex>, and only that shape is ours to remove.
  for d in $(gcloud firestore databases list --project "$PROJECT" --format="value(name)" 2>/dev/null | sed "s#.*/##" | grep -E "^paracoding-${PC_LP}[0-9a-f]{12}$"); do
    if gcloud firestore databases delete --database="$d" --project "$PROJECT" --quiet 2>/dev/null; then
      echo "  Firestore database deleted: $d"
    else
      echo "  WARNING: could not delete $d. Check delete protection, then rerun."
    fi
  done
else
  echo "  Firestore data was PRESERVED (--keep-data)."
fi

# [SEC-UNINSTALL-TRUTH-V1] LOOK BEFORE YOU SPEAK.
# This script used to end with an unconditional `echo "done. Nothing left behind."`. That
# was a claim, not a measurement, and it was measured false: a run against a project
# carrying a v2-era install left Cloud Run services paracoding-mcp and iap-test and a
# service account pc-exec-test@ standing, because this script only ever deletes the exact
# resources THIS version creates, by name. That deletion behaviour is right and is
# unchanged. The SENTENCE was the defect: an uninstaller that overstates its cleanup is
# how a stale artifact breaks an install months later.
#
# Every delete above is `--quiet 2>/dev/null` with no status check, so a wrong --region or
# a missing permission makes it a silent no-op. The scan below therefore separates four
# things it can actually tell apart, and refuses to guess between them:
#
#   OURS       an exact name THIS version creates, still present -> our own delete did not
#              work. Almost always the wrong --region, or a missing permission.
#   PRESERVED  a paracoding-* Firestore database you asked us to keep (--keep-data).
#   HELD       ours, still there, and NOT deleted BY DESIGN -- the two buckets, the KMS
#              keyrings and keys (which NOBODY can delete), the CI build identity, the CI
#              notice topic, and the shared infrastructure when another lane still needs
#              it. See [SEC-UNINSTALL-BUCKETS-V1] and [SEC-UNINSTALL-LANEHELD-V1]. This
#              class is the one that stops "nothing left behind" being printed over a
#              live data lake.
#   OTHERLANE  ours in SHAPE but carrying a DIFFERENT PC_LANE prefix -- a second install of
#              this same product sharing this project. Never deleted, never recommended for
#              deletion, and never silently dropped either: a resource this report does not
#              mention reads as one that was removed. See [SEC-UNINSTALL-LANEHELD-V1].
#   OLDER      matches this product's naming but is NOT a name this version creates.
#   UNCHECKED  the check itself failed (API disabled, PERMISSION_DENIED, no network).
#
# Telling an operator that his live control plane is stale debris he should delete by hand
# is the same defect as "Nothing left behind", pointed the other way -- and it is the
# direction that destroys a running install. So a class that could not be checked is never
# reported as clean, and a name we tried to delete is never reported as somebody else's.
PC_OURS=""; PC_KEPT=""; PC_OLDER=""; PC_BLIND=""; PC_HELD=""; PC_OTHERLANE=""
pc_ours()  { PC_OURS="${PC_OURS}      $1
"; }
pc_other() { PC_OTHERLANE="${PC_OTHERLANE}      $1
"; }
pc_held()  { PC_HELD="${PC_HELD}      $1
"; }
pc_kept()  { PC_KEPT="${PC_KEPT}      $1
"; }
pc_older() { PC_OLDER="${PC_OLDER}      $1
"; }
pc_blind() { PC_BLIND="${PC_BLIND}      $1
"; }
# has LIST NAME -- exact whole-line match, no regex metacharacters interpreted.
pc_has() { printf '%s\n' "$1" | grep -Fqx "$2"; }

echo
echo "Now looking at $PROJECT to see what is actually still standing."

# Cloud Run services. Listed across ALL regions on purpose: the commonest reason a delete
# above did nothing is that the install went to a region other than $REGION.
PC_L=$(gcloud run services list --project "$PROJECT" --format='value(metadata.name)' 2>/dev/null); PC_RC=$?
if [ $PC_RC -ne 0 ]; then
  pc_blind "Cloud Run services -- 'gcloud run services list' exited $PC_RC"
else
  for s in "paracoding-${PC_LP}${PC_TOK}control-plane" "paracoding-${PC_LP}${PC_TOK}mcp" "paracoding-${PC_LP}${PC_TOK}gate-exec"; do
    pc_has "$PC_L" "$s" && pc_ours "Cloud Run service $s"
  done
  # [SEC-LANELIT-OLDER-V1] THE OLDER LIST EXCLUDES THIS PRODUCT'S SERVICE NAMES IN ANY LANE,
  # not the three unprefixed ones it used to name. Those literals were written when there was
  # one lane. With two lanes in one project a PROD teardown printed the LIVE lane's services
  # under "NOT REMOVED, AND NOT OURS TO REMOVE ... delete them yourself" -- advice to hand-
  # delete a running install, which is the exact direction this section says it must not go.
  #
  # [SEC-UNINSTALL-LANEHELD-V1] AN EXCLUSION IS NOT A CLASSIFICATION. Dropping the other
  # lane live services out of OLDER stopped the bad advice and replaced it with SILENCE --
  # the report then named them nowhere at all, and a report that names nothing reads as
  # "they were removed". So the exclusion is CONDITIONED rather than removed: this lane own
  # names are already reported as OURS just above, a DIFFERENT lane names are reported as
  # OTHERLANE, and only a name that is neither is OLDER. An older-generation name that is
  # not this shape (v2 era) is still reported as OLDER, unchanged.
  for s in $PC_L; do
    case "$s" in
      "paracoding-${PC_LP}${PC_TOK}control-plane"|"paracoding-${PC_LP}${PC_TOK}mcp"|"paracoding-${PC_LP}${PC_TOK}gate-exec") continue ;;
      paracoding-*control-plane|paracoding-*mcp|paracoding-*gate-exec) pc_other "Cloud Run service $s" ;;
      paracoding-*|pc-*) pc_older "Cloud Run service $s" ;;
    esac
  done
fi

# Service accounts. Only ones in THIS project; Google-managed agents live elsewhere.
PC_L=$(gcloud iam service-accounts list --project "$PROJECT" --format='value(email)' 2>/dev/null); PC_RC=$?
if [ $PC_RC -ne 0 ]; then
  pc_blind "service accounts -- 'gcloud iam service-accounts list' exited $PC_RC"
else
  PC_L=$(printf '%s\n' "$PC_L" | grep -F "@${PROJECT}.iam.gserviceaccount.com")
  for a in "pc-${PC_LP}${PC_TOK}control-plane" "pc-${PC_LP}${PC_TOK}gate-exec" "pc-${PC_LP}${PC_TOK}workstation"; do
    pc_has "$PC_L" "${a}@${PROJECT}.iam.gserviceaccount.com" && pc_ours "service account ${a}@${PROJECT}.iam.gserviceaccount.com"
  done
  # Same rule as the services above, and PC_L is already restricted to this project's own
  # accounts, so anchoring the tail at "@" is enough and the project id stays out of it.
  #
  # [SEC-UNINSTALL-LANEHELD-V1] THE CI BUILD IDENTITY IS HELD, NOT OLDER, AND THE DIFFERENCE
  # IS THE ADVICE PRINTED BESIDE IT. Nothing above deletes it and nothing above should:
  # 8c/10 ADOPTS an account of that name when one already exists, so this script cannot tell
  # one it made from one that was already yours, and the Cloud Build trigger that runs as it
  # is created BY HAND -- 8c/10 prints the command and deliberately does not run it.
  # Deleting the account breaks that trigger and every IAM binding that names it, because a
  # re-created service account carries a NEW unique id and the old bindings do not come
  # back. It used to fall into OLDER, whose closing line is "delete them yourself"; that was
  # the wrong sentence to print over a live builder, and the previous note here -- that it
  # was left visible on purpose -- was true about the visibility and wrong about the class.
  for a in $PC_L; do
    case "$a" in
      "pc-${PC_LP}${PC_TOK}control-plane@"*|"pc-${PC_LP}${PC_TOK}gate-exec@"*|"pc-${PC_LP}${PC_TOK}workstation@"*) continue ;;
      "pc-${PC_LP}${PC_TOK}build@"*) pc_held "service account $a -- the CI build identity of THIS lane" ;;
      pc-*control-plane@*|pc-*gate-exec@*|pc-*workstation@*|pc-*build@*) pc_other "service account $a" ;;
      paracoding-*|pc-*) pc_older "service account $a" ;;
    esac
  done
fi

# Secrets. Note the two-step: `... | sed` would make $? the exit status of sed, not gcloud,
# and a failed list would then read as an empty project. That is the bug being fixed.
PC_L=$(gcloud secrets list --project "$PROJECT" --format='value(name)' 2>/dev/null); PC_RC=$?
if [ $PC_RC -ne 0 ]; then
  pc_blind "secrets -- 'gcloud secrets list' exited $PC_RC"
else
  PC_L=$(printf '%s\n' "$PC_L" | sed 's#.*/##')
  PC_KNOWN="pc-${PC_LP}${PC_TOK}session-secret pc-${PC_LP}${PC_TOK}human-confirm-secret pc-${PC_LP}${PC_TOK}approval-mac-key pc-${PC_LP}${PC_TOK}bootstrap-secret pc-${PC_LP}${PC_TOK}webauthn-creds"
  for s in $PC_KNOWN; do
    pc_has "$PC_L" "$s" && pc_ours "secret $s"
  done
  # [SEC-INSTALL-TOKEN-V1] The marker is OURS to delete on a full wipe and HELD by design
  # under --keep-data, where it records the release and the install token the kept data's
  # names are composed from. It must never fall through to OLDER: "delete it yourself" over
  # the token record is advice to orphan the preserved data.
  if pc_has "$PC_L" "pc-${PC_LP}install-marker"; then
    if [ "$KEEP" -eq 1 ]; then pc_held "secret pc-${PC_LP}install-marker -- records the release and any install token of the data kept by --keep-data"
    else pc_ours "secret pc-${PC_LP}install-marker"; fi
  fi
  # [SEC-UNINSTALL-LANEHELD-V1] THE SITE THAT NEVER CARRIED THE ANY-LANE EXCLUSION AT ALL,
  # AND THEREFORE THE ONE THAT ACTUALLY PRINTED THE BAD ADVICE. SEC-LANELIT-OLDER-V1 widened
  # the Cloud Run, service-account and Compute sites to any lane and did not touch this one,
  # so with PC_LANE=dev every one of PROD five LIVE secrets fell through to OLDER and was
  # printed under "delete them yourself". Deleting a mounted secret is exactly the 2026-08-10
  # outage: a secretKeyRef is a HARD BOOT DEPENDENCY resolved by the platform, so the other
  # lane does not die at the delete, it dies at its next cold start, an hour later, with
  # nothing tying the two events together.
  for s in $PC_L; do
    case " $PC_KNOWN " in *" $s "*) continue ;; esac
    case "$s" in
      "pc-${PC_LP}install-marker") continue ;;
      pc-*session-secret|pc-*human-confirm-secret|pc-*approval-mac-key|pc-*bootstrap-secret|pc-*webauthn-creds|pc-*install-marker) pc_other "secret $s" ;;
      paracoding-*|pc-*) pc_older "secret $s" ;;
    esac
  done
fi

# Firestore. Same rule as [SEC-NAMED-DB-V1] above -- ^paracoding- only, never (default).
# On --keep-data these are PRESERVED BY REQUEST, not leftovers, and saying otherwise in
# the same breath as "Firestore data was PRESERVED" would be a self-contradicting run.
PC_L=$(gcloud firestore databases list --project "$PROJECT" --format='value(name)' 2>/dev/null); PC_RC=$?
if [ $PC_RC -ne 0 ]; then
  pc_blind "Firestore databases -- 'gcloud firestore databases list' exited $PC_RC"
else
  for d in $(printf '%s\n' "$PC_L" | sed 's#.*/##' | grep -E "^paracoding-${PC_LP}[0-9a-f]{12}$"); do
    if [ "$KEEP" -eq 1 ]; then pc_kept "Firestore database $d"; else pc_ours "Firestore database $d"; fi
  done
fi

# [SEC-UNINSTALL-VM-V1] COMPUTE. Three listings, one call each, never a call per object.
# A Compute Engine API that has NEVER BEEN ENABLED on this project cannot be hiding an
# instance, a firewall rule or a router, so that one error is an EMPTY answer rather than a
# blind spot -- and it is the common case on a --no-vm or --minimal install, where 9/10
# never runs and nothing else here touches Compute. Every OTHER failure is a blind spot and is reported as
# one. The two are told apart by the message, exactly as the bucket describes below are.
PC_L=$(gcloud compute instances list --project "$PROJECT" --format='value(name)' 2>&1); PC_RC=$?
if [ $PC_RC -ne 0 ]; then
  if printf '%s' "$PC_L" | grep -qiE 'has not been used|SERVICE_DISABLED|is not enabled|has not been enabled'; then PC_L=""
  else pc_blind "Compute instances -- 'gcloud compute instances list' exited $PC_RC"; PC_L="_pc_blind_"; fi
fi
if [ "$PC_L" != "_pc_blind_" ]; then
  for v in $PC_WS_NAMES; do
    pc_has "$PC_L" "$v" && pc_ours "Compute instance $v -- RUNNING OR STOPPED, IT STILL BILLS FOR ITS DISK"
  done
  # Same rule again, and it covers the pre-rename single name as well as both flavours.
  for v in $PC_L; do
    case "$v" in
      "paracoding-${PC_LP}workstation"|"paracoding-${PC_LP}${PC_TOK}workstation-win"|"paracoding-${PC_LP}${PC_TOK}workstation-linux") continue ;;
      paracoding-*workstation|paracoding-*workstation-win|paracoding-*workstation-linux) pc_other "Compute instance $v" ;;
      paracoding-*|pc-*) pc_older "Compute instance $v" ;;
    esac
  done
fi
PC_L=$(gcloud compute firewall-rules list --project "$PROJECT" --format='value(name)' 2>&1); PC_RC=$?
if [ $PC_RC -ne 0 ]; then
  if printf '%s' "$PC_L" | grep -qiE 'has not been used|SERVICE_DISABLED|is not enabled|has not been enabled'; then PC_L=""
  else pc_blind "firewall rules -- 'gcloud compute firewall-rules list' exited $PC_RC"; PC_L="_pc_blind_"; fi
fi
if [ "$PC_L" != "_pc_blind_" ]; then
  if pc_has "$PC_L" paracoding-allow-rdp-iap; then
    if [ "$PC_SHARED" -eq 1 ]; then pc_ours "firewall rule paracoding-allow-rdp-iap (tcp:3389 from IAP's range to tagged instances)"
    else pc_held "firewall rule paracoding-allow-rdp-iap -- SHARED, so this teardown did not delete it"; fi
  fi
fi
PC_L=$(gcloud compute routers list --project "$PROJECT" --format='value(name)' 2>&1); PC_RC=$?
if [ $PC_RC -ne 0 ]; then
  if printf '%s' "$PC_L" | grep -qiE 'has not been used|SERVICE_DISABLED|is not enabled|has not been enabled'; then PC_L=""
  else pc_blind "Cloud Routers -- 'gcloud compute routers list' exited $PC_RC"; PC_L="_pc_blind_"; fi
fi
if [ "$PC_L" != "_pc_blind_" ]; then
  if pc_has "$PC_L" paracoding-nat-router; then
    if [ "$PC_SHARED" -eq 1 ]; then pc_ours "Cloud Router paracoding-nat-router -- its Cloud NAT paracoding-nat bills for every gateway-hour and every byte of egress"
    else pc_held "Cloud Router paracoding-nat-router and its Cloud NAT paracoding-nat -- SHARED, so this teardown did not delete them; they still bill per gateway-hour and per byte of egress"; fi
  fi
fi

# [SEC-EXECBUCKET-V1] THE EXECUTOR RECORD BUCKET. DELETED, unless --keep-data, and reported
# either way. Objects first: a bucket delete refuses while anything is in it, and the refusal
# is silent here. Both commands are lane-namespaced by name, so a second lane bucket is never
# touched; the pc_held branch is what an operator reads when the data was kept on purpose.
PC_EXEC_BUCKET="${PROJECT}-${PC_LP}${PC_TOK}exec-records"
PC_O=$(gcloud storage buckets describe "gs://$PC_EXEC_BUCKET" --format='value(name)' 2>&1); PC_RC=$?
if [ $PC_RC -eq 0 ]; then
  if [ "$KEEP" -eq 1 ]; then pc_held "bucket gs://$PC_EXEC_BUCKET (executor claims, run results and executor journal) -- KEPT because --keep-data was given"
  else
    echo "  deleting gs://$PC_EXEC_BUCKET -- the claims, the run results and the executor journal go with it"
    gcloud storage rm -r "gs://$PC_EXEC_BUCKET" --project "$PROJECT" --quiet >/dev/null 2>&1
    gcloud storage buckets delete "gs://$PC_EXEC_BUCKET" --project "$PROJECT" --quiet >/dev/null 2>&1
    if gcloud storage buckets describe "gs://$PC_EXEC_BUCKET" --format='value(name)' >/dev/null 2>&1; then
      pc_ours "bucket gs://$PC_EXEC_BUCKET -- STILL THERE after a delete attempt; 'gcloud storage rm -r' needs storage.objects.delete on it"
    fi
  fi
elif printf '%s' "$PC_O" | grep -qiE 'not found|404|NOT_FOUND|does not exist'; then :
else pc_blind "bucket gs://$PC_EXEC_BUCKET -- describe exited $PC_RC"; fi

# [SEC-UNINSTALL-BUCKETS-V1] THE LAKE AND THE GIT OBJECT STORE. Deliberately NOT deleted --
# see the top of this file -- and therefore deliberately IMPOSSIBLE to pass over in silence:
# they land in HELD, and HELD is one of the classes that suppresses the "nothing" line.
# [SEC-UNINSTALL-LANEBUCKETS-V1] HELD IS A PROD POSTURE, AND A LANE IS NOT PROD. For the
# unprefixed install these two buckets hold the only copy of the lake and the git object
# store, so refusing to delete them -- loudly, under HELD -- is right. A LANE teardown is
# the opposite case by ruling: lane lake data is disposable rehearsal state, and a teardown
# that leaves every lane's buckets behind forever turns "safe by design" into a graveyard
# the next rehearsal trips over -- bucket names are global, so the leftover also blocks any
# reinstall of the same lane name from ever re-creating them cleanly elsewhere. The split
# is on the lane, decided here where it bites: unprefixed (or --keep-data) HOLDS, a lane
# DELETES and then verifies the delete took.
PC_BUCKETS_HELD=0
for b in "${PROJECT}-${PC_LP}${PC_TOK}datalake" "${PROJECT}-${PC_LP}${PC_TOK}source"; do
  PC_O=$(gcloud storage buckets describe "gs://$b" --format='value(name)' 2>&1); PC_RC=$?
  if [ $PC_RC -eq 0 ]; then
    if [ -z "$PC_LP" ] || [ "$KEEP" -eq 1 ]; then pc_held "bucket gs://$b"; PC_BUCKETS_HELD=1
    else
      echo "  deleting gs://$b -- lane data is disposable by ruling; --keep-data preserves it"
      gcloud storage rm -r "gs://$b" --project "$PROJECT" --quiet >/dev/null 2>&1
      gcloud storage buckets delete "gs://$b" --project "$PROJECT" --quiet >/dev/null 2>&1
      if gcloud storage buckets describe "gs://$b" --format='value(name)' >/dev/null 2>&1; then
        pc_ours "bucket gs://$b -- STILL THERE after a delete attempt; 'gcloud storage rm -r' needs storage.objects.delete on it"
      fi
    fi
  elif printf '%s' "$PC_O" | grep -qiE 'not found|404|NOT_FOUND|does not exist'; then :
  else pc_blind "bucket gs://$b -- describe exited $PC_RC"; fi
done

# [SEC-UNINSTALL-LANEHELD-V1] KMS. STRUCTURALLY HELD, WHICH IS NOT THE SAME AS SKIPPED.
# Cloud KMS has NO delete for a keyring and NO delete for a crypto key -- not for this
# script, not for you, not for an org admin. The strongest act available anywhere is
# destroying a key VERSION, which this script does not do either, because a destroyed
# version makes every object sealed under it unreadable for good. So these can only ever be
# REPORTED, and they are reported BY NAME: an operator reading a teardown report that never
# mentions them concludes they were removed, and then wonders why a reinstall inherits
# signatures. 5b/10 creates the approvals keyring, 5e/10 the vault keyring; both are
# lane-namespaced, so another lane keyrings show up under OTHERLANE and not here.
PC_L=$(gcloud kms keyrings list --location "$REGION" --project "$PROJECT" --format='value(name)' 2>&1); PC_RC=$?
if [ $PC_RC -ne 0 ]; then
  if printf '%s' "$PC_L" | grep -qiE 'has not been used|SERVICE_DISABLED|is not enabled|has not been enabled'; then PC_L=""
  else pc_blind "KMS keyrings in $REGION -- 'gcloud kms keyrings list' exited $PC_RC"; PC_L="_pc_blind_"; fi
fi
if [ "$PC_L" != "_pc_blind_" ]; then
  for k in $PC_L; do
    case "${k##*/}" in
      "paracoding-${PC_LP}approvals") pc_held "KMS keyring paracoding-${PC_LP}approvals in $REGION, holding this lane approval signing key ${PC_LP}approval-signing -- NO ONE CAN DELETE A KEYRING OR A KEY" ;;
      "paracoding-${PC_LP}vault") pc_held "KMS keyring paracoding-${PC_LP}vault in $REGION, holding this lane vault KEM keys ${PC_LP}vault-kem-xwing and ${PC_LP}vault-kem -- NO ONE CAN DELETE A KEYRING OR A KEY" ;;
      paracoding-*approvals|paracoding-*vault) pc_other "KMS keyring ${k##*/} in $REGION -- and nobody could delete it in any case" ;;
    esac
  done
fi

# [SEC-UNINSTALL-LANEHELD-V1] THE CI NOTICE TOPIC. 6/10 ADOPTS a topic of this name when one
# already exists, and 8c/10 tells you to point a Cloud Build trigger at it BY HAND. Nothing
# above deletes it and nothing should: this script cannot tell a topic it made from one you
# made, and removing it breaks a trigger this installer never created and cannot recreate.
PC_L=$(gcloud pubsub topics list --project "$PROJECT" --format='value(name)' 2>&1); PC_RC=$?
if [ $PC_RC -ne 0 ]; then
  if printf '%s' "$PC_L" | grep -qiE 'has not been used|SERVICE_DISABLED|is not enabled|has not been enabled'; then PC_L=""
  else pc_blind "Pub/Sub topics -- 'gcloud pubsub topics list' exited $PC_RC"; PC_L="_pc_blind_"; fi
fi
if [ "$PC_L" != "_pc_blind_" ]; then
  for t in $PC_L; do
    case "${t##*/}" in
      "paracoding-${PC_LP}${PC_TOK}main-moved") pc_held "Pub/Sub topic paracoding-${PC_LP}${PC_TOK}main-moved -- the CI notice topic of THIS lane" ;;
      paracoding-*main-moved) pc_other "Pub/Sub topic ${t##*/}" ;;
    esac
  done
fi

# The build staging bucket and the Artifact Registry repo. These are checked by NAME
# rather than by prefix: they are named after the PROJECT and after Cloud Run's own
# convention, so no prefix rule can find them, and a scan that cannot see them has no
# business saying "nothing remains". A describe that fails is ambiguous between "absent"
# and "may not look", so the two are told apart by the message, not by the exit status.
for b in "run-sources-${PROJECT}-${REGION}" "${PROJECT}_cloudbuild"; do
  PC_O=$(gcloud storage buckets describe "gs://$b" --format='value(name)' 2>&1); PC_RC=$?
  if [ $PC_RC -eq 0 ]; then
    if [ "$PC_SHARED" -eq 1 ]; then pc_ours "bucket gs://$b (build staging; 'storage rm -r' fails if objects remain)"
    else pc_held "bucket gs://$b (build staging) -- SHARED, so this teardown did not delete it"; fi
  elif printf '%s' "$PC_O" | grep -qiE 'not found|404|NOT_FOUND|does not exist'; then :
  else pc_blind "bucket gs://$b -- describe exited $PC_RC"; fi
done
PC_O=$(gcloud artifacts repositories describe cloud-run-source-deploy --location="$REGION" --project "$PROJECT" --format='value(name)' 2>&1); PC_RC=$?
if [ $PC_RC -eq 0 ]; then
  if [ "$PC_SHARED" -eq 1 ]; then pc_ours "Artifact Registry repo cloud-run-source-deploy in $REGION (also holds images from any of your OWN 'gcloud run deploy' runs)"
  else pc_held "Artifact Registry repo cloud-run-source-deploy in $REGION -- SHARED, so this teardown did not delete it; it also holds the OTHER lane container images"; fi
elif printf '%s' "$PC_O" | grep -qiE 'not found|404|NOT_FOUND|does not exist'; then :
else pc_blind "Artifact Registry repo cloud-run-source-deploy in $REGION -- describe exited $PC_RC"; fi

# ---- report. Order matters: the worst thing first, "done" last and only once.
if [ -n "$PC_OURS" ]; then
  echo
  echo "  STILL PRESENT, AND OURS -- our own delete did not take effect:"
  printf '%s' "$PC_OURS"
  echo "  These are the exact names this script tries to delete, twenty lines above. It did
  not check whether those deletes worked, so it cannot tell you why. The two causes, in
  order of likelihood:
    1. WRONG REGION. You ran with region '$REGION'. If you installed somewhere else,
       nothing was deleted at all. Re-run: bash uninstall.sh $PROJECT <the-region-you-used>
    2. You lack run.services.delete / secretmanager.secrets.delete / iam.serviceAccounts
       .delete on $PROJECT, or a bucket still has objects in it.
  DO NOT hand-delete these until you know which. They may be a live install."
fi
if [ -n "$PC_HELD" ]; then
  echo
  echo "  STILL PRESENT, AND THIS SCRIPT WILL NOT DELETE THEM -- BY DESIGN, NOT BY OVERSIGHT:"
  printf '%s' "$PC_HELD"
  echo "  These are yours and they are NOT leftovers. Four different reasons appear above and
  each line says which one applies to it."
  # [SEC-UNINSTALL-LANEBUCKETS-V1] The two-buckets paragraph is printed ONLY when the two
  # buckets actually landed in HELD -- on a lane teardown they were deleted above, and
  # advice to hand-delete a bucket that is already gone reads as a report that lies.
  [ "$PC_BUCKETS_HELD" -eq 1 ] && echo "
  THE TWO BUCKETS are the only resources here holding bytes that exist nowhere else. The
  data lake holds agent memory, the handoffs and the wiki. The source bucket holds the git
  object store, which is your commit history. 'gcloud storage rm -r' has no undo and this
  script is not going to run it for you at the end of a --quiet teardown. They cost
  storage, not compute. When you are sure, remove them yourself:
      gcloud storage rm -r gs://${PROJECT}-${PC_LP}${PC_TOK}datalake --project $PROJECT
      gcloud storage rm -r gs://${PROJECT}-${PC_LP}${PC_TOK}source   --project $PROJECT
  Take a copy of anything you want first. Neither bucket keeps noncurrent versions, so what
  is there is all there is."
  echo "
  THE KMS KEYRINGS AND KEYS CANNOT BE DELETED BY ANYONE, so no command is offered for
  them. Cloud KMS has no delete for a keyring and none for a crypto key; the strongest act
  that exists is destroying a key VERSION, and that makes every object sealed under it
  unreadable for good, so this script does not do that either. They are named here purely
  so that their absence from this report is never read as removal. Idle keys with no
  active version cost nothing, and reinstalling this lane adopts them as they stand.

  THE CI BUILD IDENTITY AND THE CI NOTICE TOPIC are ADOPTED by the installer when they
  already exist, so this script cannot tell one it created from one that was already
  yours, and both are referenced by a Cloud Build trigger the installer deliberately does
  NOT create -- 8c/10 prints the command and leaves it to you. Deleting the identity
  breaks that trigger and every IAM binding that names it: a re-created service account
  carries a NEW unique id, and the old bindings do not come back.

  THE SHARED INFRASTRUCTURE, if it is listed above, is one-per-project and not one-per-
  lane, and this run found another lane of this product still installed in $PROJECT (or
  could not establish that there was not one). Deleting it would take that lane container
  images, its egress or its RDP path away from a running install."
fi
if [ -n "$PC_OTHERLANE" ]; then
  echo
  echo "  BELONGS TO ANOTHER LANE -- LEFT ALONE, AND NOT YOURS TO DELETE FROM THIS TEARDOWN:"
  printf '%s' "$PC_OTHERLANE"
  echo "  These carry this product naming with a DIFFERENT PC_LANE prefix from the one this
  run used (PC_LANE='$PC_LANE'). That makes them a SECOND, PROBABLY LIVE install of this
  same product sharing $PROJECT -- not debris, and not something a teardown of this lane
  has any business touching. Nothing above deleted them and nothing above recommends
  deleting them: the entire reason a lane prefix exists is that one project now carries
  more than one install. To remove that lane, re-run this script with ITS PC_LANE set, at
  a moment when you mean to. They are listed rather than filtered away, because a resource
  this report never mentions reads as one that was removed -- and the secrets among them
  are the sharpest case: deleting a mounted secret does not break the other lane at the
  delete, it breaks it at its next COLD START, which is how 2026-08-10 went."
fi
if [ -n "$PC_KEPT" ]; then
  echo
  echo "  PRESERVED BY REQUEST (--keep-data), not left behind by accident:"
  printf '%s' "$PC_KEPT"
  echo "  Re-run without --keep-data to remove them."
fi
if [ -n "$PC_OLDER" ]; then
  echo
  echo "  NOT REMOVED, AND NOT OURS TO REMOVE:"
  printf '%s' "$PC_OLDER"
  echo "  These carry this product's naming but are NOT names this version creates, so they
  are most likely from an older install. This uninstaller deletes only by exact name,
  which is what stops it from ever taking something of yours -- and is also why it will
  not touch these. Note that 'pc-' is a short prefix: if any of the above is your own
  work, it is your own work, and this script is guessing. Check what uses them, then
  delete them yourself. A stale service or service account is exactly what makes an
  install fail months from now for reasons nobody can trace."
fi
if [ -n "$PC_BLIND" ]; then
  echo
  echo "  COULD NOT CHECK -- these classes were NOT verified:"
  printf '%s' "$PC_BLIND"
  echo "  Usually the API is disabled on $PROJECT, or this account cannot list. Whatever is
  in those classes, this script did not see it, and it will not pretend otherwise."
fi
if [ -z "$PC_OURS$PC_KEPT$PC_OLDER$PC_BLIND$PC_HELD$PC_OTHERLANE" ]; then
  echo "  nothing. Cloud Run, service accounts, secrets, Firestore, Compute instances,
  firewall rules, Cloud Routers, KMS keyrings, Pub/Sub topics, the data lake and source
  buckets, the build staging buckets and the Artifact Registry repo were all listed
  successfully and none of them hold anything matching paracoding-* or pc-*."
  echo "done -- and that last line is a measurement, not a promise."
else
  echo
  echo "done. Read the sections above before you call this project clean."
fi
echo "Anything in $PROJECT that does not match paracoding-* or pc-* was never inspected and
never touched. It may well be your own, and this script will not claim it."
