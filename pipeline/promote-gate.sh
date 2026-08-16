#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# promote-gate.sh -- THE PROMOTION GATE. Traffic moves on a green judgement and on
# nothing else.
#
# WHY THIS IS A SEPARATE FILE AND NOT THREE LINES IN THE YAML. "Reaching this step
# at all is the proof" was the old plan and it is wrong twice over. It trusts Cloud
# Build's step ordering to carry a security decision, and it makes the gate
# unrunnable outside a build -- so it can never be tested, and a gate that cannot be
# tested is a gate that has never been shown to refuse. This file is driven entirely
# by files on disk, so every path through it is exercisable on a laptop, and every
# path through it HAS been.
#
# THE FLEET HAS SHIPPED "A GATE THAT CANNOT REFUSE" REPEATEDLY. So the refusal is
# built out of SEVEN INDEPENDENT CONDITIONS, numbered 0-6, all of which must hold to
# promote. No single mistake, stale file or missing artifact can open it:
#
#   0. THE EVIDENCE IS EVIDENCE -- the collector was not refused, proven on TWO
#      independent sinks. Read FIRST, ahead of the smoke verdict, because a verdict
#      computed over a bundle nobody could read is not a verdict whatever colour it
#      is. [SEC-CI-COLLECTRC-V1]
#   1. smoke.rc exists and is EXACTLY "0"
#   2. smoke-report.txt exists and is non-empty
#   3. the report's own verdict line reads VERDICT 0
#   4. the report's census reads FAIL 0, the selftest reads N/N with N>0, the
#      skip-proof reads M/M, and none of the three "this run is NOT a pass"
#      markers appear
#   5. the report was produced for THIS build's commit -- a stale green from an
#      earlier revision cannot promote a new one
#   6. THE COUPLING HOLDS. Every literal this gate scrapes out of the report is
#      still present in the judge that emits it. See THE COUPLING CHECK below.
#
# Condition 4 exists because the exit code and the report are two witnesses to the
# same fact, and this gate believes neither one alone. smoke.py already refuses to
# report 0 over a dead check or an unreviewed skip; condition 4 means a smoke.py
# that had been quietly weakened still cannot promote anything.
#
# ---------------------------------------------------------------------------
# THE COUPLING CHECK -- CONDITION 6, AND WHY IT EXISTS
# ---------------------------------------------------------------------------
# [SEC-DEVGATE-GATEPARSE-V1] THIS GATE ONCE REFUSED A PERFECTLY GREEN BUILD ON ITS
# OWN REGEX. It scraped the selftest census with
#     sed -n 's/^   \([0-9]*\)\/\([0-9]*\) checks proved.*/\1 \2/p'
# while devgate/smoke.py has only ever emitted
#     "   61/61 proved they can fail -- 35 assertion seed(s), 26 extra control(s)."
# The substring "checks proved" occurs ZERO times in smoke.py and always has. The
# gate had one commit, every prior cycle died at condition 1, and condition 4 was
# reached for the first time on the day the pipeline first went green -- so the
# defect sat undetected because nothing had ever exercised it.
#
# THE INSTANCE IS A TYPO. THE CLASS IS A STRING COUPLING BETWEEN TWO FILES THAT
# NOTHING VERIFIED, and it has two failure directions, only one of which is safe:
#
#   FALSE REFUSAL  a scrape finds nothing, and the gate refuses a green build.
#                  Annoying, visible, and SAFE. This is what happened.
#   SILENT PASS    a marker grep finds nothing because the marker was RENAMED, so
#                  "CHECK(S) DID NOT BITE" never matches, the gate concludes the
#                  report is clean, and A DEAD CHECK PROMOTES ITSELF. This is the
#                  dangerous direction and NOTHING WAS WATCHING IT.
#
# So the gate now VERIFIES ITS OWN COUPLING before it promotes anything. The judge
# source travels in the same bundle as this file -- they are always the same tree --
# so the gate can simply read it and require that every literal it depends on is
# actually there. A rename in smoke.py now fails HERE, LOUDLY, with exit 61 naming
# the exact missing string, instead of silently degrading a grep into a no-op.
#
# COULD THE COUPLING BE REMOVED ENTIRELY? Yes, and it should be: smoke.py should
# emit a machine-readable census (one `SELFTEST_PROVED <n> <total>` line, or a JSON
# sidecar) and this gate should read fields instead of prose. That is the right
# end state and it is NOT done here, because devgate/smoke.py is out of this
# change's ownership. Until it lands, condition 6 is the thing that makes the
# remaining prose coupling FAIL LOUDLY rather than rot. When the machine-readable
# field exists, delete the scrapes and the COUPLED_LITERALS list together.
#
# WHY CONDITION 6 IS EVALUATED LAST. It can only turn a PROMOTE into a REFUSE. It
# deliberately does NOT pre-empt conditions 1-5, so a gate whose coupling is broken
# still returns the SAME exit code for an already-bad build -- which keeps the
# yaml's negative control (a red fixture must produce EXACTLY 51) meaningful.
#
# FAIL CLOSED IS THE DEFAULT AND IT IS THE FIRST THING SET. Every exit path that is
# not the single explicit ALLOW path leaves DECISION=REFUSE. A missing file, an
# unreadable file, an unset variable and an unhandled case all land there.
#
# EXIT CODES -- distinct on purpose, because "why did it refuse" is the question a
# reader has at 2am. 58/59/60/66 are the YAML STEP's codes and 62 is the collector
# selftest's; this file must never reuse them:
#   0   PROMOTED         traffic moved, and the move was CONFIRMED BY RE-READING
#   50  REFUSED-NO-RC    the smoke step produced no exit code (it died, or never ran)
#   51  REFUSED-NOT-ZERO smoke exited non-zero (10 failed / 11 coverage lost / 12 evidence)
#   52  REFUSED-NO-REPORT no report, or an empty one
#   53  REFUSED-VERDICT  the report does not say VERDICT 0
#   54  REFUSED-CENSUS   the report CONTRADICTS ITSELF: FAIL>0, a dead check, a skip
#                        that could read green, or a coverage regression
#   55  REFUSED-STALE    the report is for a different commit than this build
#   56  PROMOTE-FAILED   the gate said yes and the traffic move itself failed
#   57  PROMOTE-UNCONFIRMED the move reported success but the re-read disagrees
#   61  REFUSED-COUPLING THE GATE COULD NOT READ ITS OWN INPUTS. Either a line shape
#                        this gate depends on is ABSENT from the report, or a literal
#                        it scrapes is absent from the judge that emits it. This is
#                        NOT "the report is bad" -- it is "the gate has stopped being
#                        able to judge", and it is kept distinct from 54 for exactly
#                        that reason.
#   63  REFUSED-NO-TARGET the gate said yes and could not identify WHICH revision it
#                        had just judged. It refuses rather than promoting whatever
#                        happens to be newest.
#   64  REFUSED-COLLECT   pipeline/collect-evidence.py recorded a non-zero exit.
#                        rc 2 = it RAN AND WAS REFUSED: one or more Cloud Run reads
#                        did not answer 200, so the sections built from them are
#                        empty shells rather than measurements, and "the variable is
#                        unset" is indistinguishable from "nobody could look".
#                        rc 1 = it DIED before it finished. Also 64 when the rc file
#                        exists and holds no number, because unreadable is not absent.
#   65  REFUSED-COLLECT-BUNDLE  the rc did not say so -- absent, or 0 -- and THE
#                        BUNDLE ITSELF carries "_collect_refused". Kept distinct from
#                        64 because the diagnosis is different: 64 sends you to the
#                        collector log, 65 says the two sinks DISAGREE, which means
#                        either the yaml that ran is older than this bundle or step
#                        5a lost the code. The bundle is believed over the rc.
#
# THE MOVE IS NEVER JUDGED BY THE EXIT CODE OF update-traffic. It is judged by
# reading the service back and finding the new revision alone at 100 percent, for
# the same reason the IAP restore is judged by re-reading: an exit code is a claim.
#
# ---------------------------------------------------------------------------
# THE MOVE GOES TO THE REVISION THAT WAS JUDGED, NEVER TO "LATEST"
# ---------------------------------------------------------------------------
# This gate used to promote with `--to-latest`, and that quietly threw away
# everything conditions 1-5 had just established. Condition 5 proves the REPORT
# describes THIS BUILD'S COMMIT; --to-latest then moves traffic to whatever revision
# is newest AT THAT MOMENT, which is not necessarily the revision that was deployed,
# probed and judged. Any concurrent deploy -- a second build, a console click, a
# rollback -- lands a newer revision, and the gate would have promoted it on the
# strength of a report about a DIFFERENT one. That is the same stale-artifact class
# condition 5 exists to prevent, arriving from the other end.
#
# The deploy step deploys `--no-traffic --tag c<short>` and writes that tag to
# $WORK/TAG. The tag is bound to the commit by construction, so the gate can close
# the loop end to end:
#
#   report BUILD_COMMIT == $WORK/BUILD_COMMIT   (condition 5)
#   $WORK/TAG           == "c" + first 8 of that commit
#   TARGET revision     == the revision carrying that tag, read off the service
#   traffic after       == TARGET alone at 100 percent, CONFIRMED BY RE-READ
#
# If the target cannot be resolved the gate REFUSES with 63. It does not fall back
# to --to-latest, because a fallback that promotes an unjudged revision is worse
# than not promoting at all.

set -uo pipefail

WORK="${WORK:-/workspace}"
SVC="${SVC:?SVC (service name) is required}"
REGION="${REGION:?REGION is required}"
PROJECT="${PROJECT:?PROJECT is required}"
RC_FILE="${RC_FILE:-$WORK/smoke.rc}"
REPORT="${REPORT:-$WORK/smoke-report.txt}"
COLLECT_RC_FILE="${COLLECT_RC_FILE:-$WORK/collect.rc}"
EVIDENCE="${EVIDENCE:-$WORK/evidence.json}"
COMMIT_FILE="${COMMIT_FILE:-$WORK/BUILD_COMMIT}"
TAG_FILE="${TAG_FILE:-$WORK/TAG}"
# THE JUDGE THIS GATE IS COUPLED TO. Derived from THIS FILE'S OWN LOCATION, not from
# an environment variable and not from $WORK, because the gate and the judge travel
# in the same bundle and are therefore always the same tree: <tree>/pipeline/ and
# <tree>/devgate/. Override JUDGE_SRC only to test this file against a judge that
# lives somewhere else.
GATE_DIR="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
JUDGE_SRC="${JUDGE_SRC:-$GATE_DIR/../devgate/smoke.py}"
# THE COLLECTOR THIS GATE'S SECOND SINK IS COUPLED TO. Same tree, same reasoning as
# JUDGE_SRC: the collector travels in the bundle beside this file.
COLLECTOR_SRC="${COLLECTOR_SRC:-$GATE_DIR/collect-evidence.py}"
# DRYRUN affects ONLY the allow branch. It can never turn a REFUSE into a PROMOTE:
# every refusal exits before the line that reads it.
DRYRUN="${PROMOTE_DRYRUN:-0}"

DECISION="REFUSE"
CODE=50
WHY="no decision was reached (this default is the bug-catcher: reaching it means a
     path through this script forgot to decide, and it refuses)"

say() { printf '%s\n' "$*"; }

say "=============================================================================="
say "PROMOTION GATE"
say "=============================================================================="
say "  service   $SVC"
say "  region    $REGION"
say "  project   $PROJECT"
say "  rc file   $RC_FILE"
say "  report    $REPORT"
say "  judge     $JUDGE_SRC"
say ""

# ---- THE COUPLING CHECK (condition 6, MEASURED HERE, ACTED ON AT THE END) -----
# Every literal below is scraped out of the report by this gate AND emitted by a
# format string in the judge. grep -F, because the report greps are -F too: the
# check must use the SAME matcher as the thing it is vouching for, or it vouches
# for nothing. Keep this list and the scrapes below in lockstep -- a scrape with no
# entry here is exactly the unguarded coupling that caused this.
COUPLING="UNCHECKED"
COUPLING_MISSING=""
if [ -f "$JUDGE_SRC" ]; then
  COUPLING="OK"
  while IFS= read -r COUPLED_LIT; do
    if [ -n "$COUPLED_LIT" ] && ! grep -Fq -- "$COUPLED_LIT" "$JUDGE_SRC"; then
      COUPLING="BROKEN"
      COUPLING_MISSING="$COUPLING_MISSING [$COUPLED_LIT]"
    fi
  done <<'COUPLED_LITERALS'
proved they can fail
skipped assertion
CHECK(S) DID NOT BITE
COULD BE READ AS GREEN
COVERAGE REGRESSION
VERDICT %d
   FAIL           %d
BUILD_COMMIT:
COUPLED_LITERALS
fi
say "  coupling to the judge: $COUPLING${COUPLING_MISSING:+ -- MISSING:$COUPLING_MISSING}"
say ""

# ---- condition 0: THE EVIDENCE IS EVIDENCE (TWO SINKS) -----------------------
# [SEC-CI-COLLECTRC-V1] READ BEFORE THE SMOKE VERDICT, AND THAT ORDER IS THE POINT.
#
# On 2026-08-12 a dev lane that was provably configured correctly produced 21
# confident FAIL findings. The cause was not the lane. gate-exec/exec_server.py puts
# the approving human's token in CLOUDSDK_AUTH_ACCESS_TOKEN; gcloud honours that
# variable and urllib does not, so collect-evidence.py's reads ran as the EXECUTOR
# service account, which holds datastore.user and logging.logWriter and cannot read
# Cloud Run. Every service read was refused, a refused GET degraded to {}, and the
# judge was handed empty environment maps and reported them as unset variables.
#
# BOTH HALVES ARE FIXED AND NEITHER OF THEM IS THIS FILE. The collector now records
# every read status, marks the bundle and returns 2; the judge now renders a starved
# input NOT-EXERCISED and exits 12 rather than 11. A gate that still read smoke.rc
# first would nonetheless promote a green verdict computed over nothing, which is why
# this condition is numbered 0 and not 7.
#
# TWO SINKS, BECAUSE THEY ARE COUPLED TO DIFFERENT FILES AND DIE SEPARATELY.
#   SINK 1  $WORK/collect.rc, written by cloudbuild-dev.yaml step 5a. The yaml is the
#           TRIGGER's copy and is NOT guaranteed to be the same tree as this file.
#   SINK 2  "_collect_refused" in the evidence bundle, written by the collector, which
#           travels in the SAME bundle as this gate and therefore always IS the same
#           tree. This is the sink that covers an older yaml writing no rc at all.
# Same two-sink discipline gittools.ts uses for ci_emit, for the same reason: a sink
# that has quietly died is not detectable from itself.
#
# AN ABSENT collect.rc IS NOT A REFUSAL, DELIBERATELY. A bundle cut before step 5a
# learned to persist the code has no rc, and refusing there would brick every
# historical commit over a capability that tree never had -- the same reasoning
# cloudbuild-dev.yaml already applies to --emit-table and to --selftest. ABSENT is
# REPORTED, never passed off as OK, and sink 2 still covers it. An rc file that EXISTS
# and holds no number is a different thing and IS refused.
#
# SINK 2'S OWN COUPLING IS REPORTED RATHER THAN ASSUMED. A grep for a literal that has
# been renamed does not fail, it silently matches nothing -- the [SEC-DEVGATE-GATEPARSE-V1]
# lesson. So the collector source is checked for the literal and the sink's state is
# printed. A tree whose collector never writes the marker is ABSENT, not OK, and it is
# not refused for it: that tree predates the marker.
COLLECT_RC=""
if [ -f "$COLLECT_RC_FILE" ]; then
  COLLECT_RC="$(tr -dc '0-9' < "$COLLECT_RC_FILE" | head -c 8)"
fi
COLLECT_MARK="absent"
if [ -f "$EVIDENCE" ] && grep -Fq '"_collect_refused"' "$EVIDENCE"; then
  COLLECT_MARK="PRESENT"
fi
COLLECT_SINK2="live"
if [ ! -f "$COLLECTOR_SRC" ]; then
  COLLECT_SINK2="UNKNOWN -- no collector source at $COLLECTOR_SRC, so the bundle sink cannot be vouched for"
elif ! grep -Fq '_collect_refused' "$COLLECTOR_SRC"; then
  COLLECT_SINK2="ABSENT -- this tree's collect-evidence.py never writes _collect_refused, so sink 2 cannot fire and the rc is the only witness"
fi
say "  collect exit code: '${COLLECT_RC:-<none recorded>}'"
say "  bundle refusal marker: $COLLECT_MARK"
say "  bundle sink: $COLLECT_SINK2"
say ""

COLLECT_CODE=""
COLLECT_WHY=""
if [ -f "$COLLECT_RC_FILE" ] && [ -z "$COLLECT_RC" ]; then
  COLLECT_CODE=64
  COLLECT_WHY="$COLLECT_RC_FILE exists and holds no number. The collector's verdict is
     unreadable, and an unreadable verdict is refused rather than guessed -- the same
     rule condition 1 applies to smoke.rc."
elif [ -n "$COLLECT_RC" ] && [ "$COLLECT_RC" != "0" ]; then
  COLLECT_CODE=64
  case "$COLLECT_RC" in
    1) COLLECT_WHY="collect-evidence.py exited 1: it DIED. The bundle carries whatever it
     had reached plus _collect_aborted, and the smoke verdict over it -- green or red --
     describes a partial read of the deployment, not the deployment." ;;
    2) COLLECT_WHY="collect-evidence.py exited 2: IT RAN AND WAS REFUSED. One or more Cloud
     Run reads did not answer 200, so the sections built from them are empty shells and
     not measurements. THE SMOKE VERDICT OVER THIS BUNDLE IS NOT A VERDICT. Read the
     starved sections in the collector log and ev.service_reads; check first whether the
     job's python got the approver's token -- CLOUDSDK_AUTH_ACCESS_TOKEN binds gcloud and
     NOT urllib, which is how this failed the first time." ;;
    *) COLLECT_WHY="collect-evidence.py exited $COLLECT_RC, which is not 0. This gate knows
     0 (collected), 1 (died) and 2 (refused); anything else is an interface it does not
     understand, and it refuses rather than assuming the bundle is sound." ;;
  esac
elif [ "$COLLECT_MARK" = "PRESENT" ]; then
  COLLECT_CODE=65
  COLLECT_WHY="THE TWO SINKS DISAGREE, AND THE BUNDLE WINS. collect.rc says
     '${COLLECT_RC:-<none recorded>}' while the bundle at $EVIDENCE carries
     _collect_refused, which the collector writes only when a read was refused. Either
     the cloudbuild yaml that ran is older than this bundle and never persisted the code,
     or step 5a lost it. Either way the collector says it had nothing to hand over, and
     that is the witness closest to the failure."
fi

# ---- condition 1: the smoke step's exit code ---------------------------------
if [ -n "$COLLECT_CODE" ]; then
  CODE="$COLLECT_CODE"
  WHY="$COLLECT_WHY"
elif [ ! -f "$RC_FILE" ]; then
  CODE=50
  WHY="no $RC_FILE. The smoke step did not run, or it died before recording an exit
     code. NOTHING IS KNOWN about the revision, and 'nothing is known' is not green."
else
  SMOKE_RC="$(tr -dc '0-9' < "$RC_FILE" | head -c 8)"
  say "  smoke exit code: '${SMOKE_RC:-<empty>}'"
  if [ -z "$SMOKE_RC" ]; then
    CODE=50
    WHY="$RC_FILE holds no number. An unreadable verdict is refused, never guessed."
  elif [ "$SMOKE_RC" != "0" ]; then
    CODE=51
    case "$SMOKE_RC" in
      10) WHY="smoke exited 10 FUNCTIONAL-FAILED: the install reached the boundary but
     the installed system does not do its job." ;;
      11) WHY="smoke exited 11 FUNCTIONAL-COVERAGE-LOST: an assertion did not run and is
     not on the reviewed list, or a check could not be made to fail, or a skip
     could render as green. A harness that stopped being able to fail may not
     promote anything." ;;
      12) WHY="smoke exited 12 FUNCTIONAL-EVIDENCE-MISSING: collect() could not gather an
     input. That is missing evidence -- not a pass, not a failure of the product,
     and certainly not a reason to move traffic." ;;
      *)  WHY="smoke exited $SMOKE_RC, which is not 0." ;;
    esac
  # ---- condition 2: the report exists and is not empty ------------------------
  elif [ ! -s "$REPORT" ]; then
    CODE=52
    WHY="smoke exited 0 but $REPORT is missing or empty. A verdict with no report
     behind it is an assertion, and this gate does not promote on assertions."
  else
    # ---- condition 3: the report's own verdict line ---------------------------
    if ! grep -qE '^VERDICT 0[[:space:]]' "$REPORT"; then
      CODE=53
      WHY="the report does not carry a 'VERDICT 0' line. The exit code and the report
     disagree, and when two witnesses disagree this gate believes neither."
      say "  report verdict line: $(grep -E '^VERDICT ' "$REPORT" | head -1)"
    else
      # ---- condition 4: the report must not contradict itself ----------------
      # THREE SCRAPES, AND EACH ONE IS COUPLED TO A FORMAT STRING IN THE JUDGE:
      #   census FAIL   W("   FAIL           %d" % nfail)
      #   selftest      W("   %d/%d proved they can fail -- ...")
      #   skip-proof    W("   %d/%d skipped assertion(s) proved they cannot ...")
      # The selftest scrape read "checks proved" until [SEC-DEVGATE-GATEPARSE-V1];
      # the judge has never emitted that phrase. See THE COUPLING CHECK above.
      NFAIL="$(sed -n 's/^   FAIL  *\([0-9][0-9]*\).*/\1/p' "$REPORT" | head -1)"
      PROVED="$(sed -n 's/^   \([0-9][0-9]*\)\/\([0-9][0-9]*\) proved they can fail.*/\1 \2/p' "$REPORT" | head -1)"
      SKIPPRF="$(sed -n 's/^   \([0-9][0-9]*\)\/\([0-9][0-9]*\) skipped assertion.*/\1 \2/p' "$REPORT" | head -1)"
      say "  census FAIL      : ${NFAIL:-<unparsed>}"
      say "  selftest         : ${PROVED:-<unparsed>}"
      say "  skip-proof       : ${SKIPPRF:-<unparsed>}"
      # TWO ACCUMULATORS, KEPT APART ON PURPOSE.
      #   UNPARSED -> 61: the gate could not READ a line it depends on.
      #   BAD      -> 54: the gate read it fine and the report contradicts itself.
      # Collapsing them, as this file used to, reports a broken gate as a broken
      # build and sends the reader to the wrong file.
      UNPARSED=""
      BAD=""
      [ -z "$NFAIL" ] && UNPARSED="the census FAIL line is absent or does not have the
     shape '   FAIL           <n>' that this gate reads"
      [ -z "$PROVED" ] && UNPARSED="${UNPARSED:+$UNPARSED; }the selftest line is absent or
     does not have the shape '   <n>/<m> proved they can fail ...' that this gate
     reads, so it is unknown whether these checks can fail at all"
      [ -z "$SKIPPRF" ] && UNPARSED="${UNPARSED:+$UNPARSED; }the skip-proof line is absent
     or does not have the shape '   <n>/<m> skipped assertion(s) ...' that this gate
     reads, so it is unknown whether a skip could be read as green"
      if [ -z "$UNPARSED" ]; then
        [ "$NFAIL" != "0" ] && BAD="the census reports $NFAIL FAIL finding(s) under a VERDICT 0 line"
        grep -Fq 'CHECK(S) DID NOT BITE' "$REPORT" && BAD="the selftest found a check that cannot fail"
        grep -Fq 'COULD BE READ AS GREEN' "$REPORT" && BAD="a skipped assertion could be read as green"
        grep -Fq 'COVERAGE REGRESSION' "$REPORT" && BAD="an assertion did not run and is not on the reviewed list"
        # N/N, and N>0. A selftest that ran zero checks proved nothing.
        PROVED_N="${PROVED%% *}"
        PROVED_M="${PROVED##* }"
        [ -z "$BAD" ] && [ "$PROVED_N" != "$PROVED_M" ] && BAD="the selftest proved only $PROVED_N of $PROVED_M checks can fail"
        [ -z "$BAD" ] && [ "$PROVED_M" = "0" ] && BAD="the selftest ran zero checks"
        # M/M. ZERO IS LEGITIMATE HERE and is not the same as above: 0/0 means this
        # run produced no NOT-EXERCISED findings at all, which is a clean report,
        # not an empty check. Only an INEQUALITY is a contradiction.
        SKIP_N="${SKIPPRF%% *}"
        SKIP_M="${SKIPPRF##* }"
        [ -z "$BAD" ] && [ "$SKIP_N" != "$SKIP_M" ] && BAD="the skip-proof cleared only $SKIP_N of $SKIP_M skipped assertion(s)"
      fi
      if [ -n "$UNPARSED" ]; then
        CODE=61
        WHY="$UNPARSED.
     THIS IS A DEFECT IN THE GATE OR IN THE JUDGE, NOT NECESSARILY IN THE BUILD.
     The report may be perfectly green; this gate cannot tell, so it refuses."
      elif [ -n "$BAD" ]; then
        CODE=54
        WHY="$BAD. A report that contradicts its own verdict is refused."
      else
        # ---- condition 5: the report is for THIS commit ---------------------
        WANT="$(cat "$COMMIT_FILE" 2>/dev/null | tr -dc '0-9a-f' | head -c 40)"
        GOT="$(sed -n 's/.*BUILD_COMMIT: *\([0-9a-f]\{7,40\}\).*/\1/p' "$REPORT" | head -1)"
        say "  build commit     : want=${WANT:-<none>} report=${GOT:-<none>}"
        if [ -z "$WANT" ] || [ -z "$GOT" ] || [ "$WANT" != "$GOT" ]; then
          CODE=55
          WHY="the report names commit '${GOT:-<none>}' but this build verified
     '${WANT:-<none>}'. A green report from an earlier revision cannot promote this
     one -- that is how a stale artifact promotes code nobody judged."
        # ---- condition 6: the gate can still read what it is reading ---------
        elif [ "$COUPLING" != "OK" ]; then
          CODE=61
          if [ "$COUPLING" = "BROKEN" ]; then
            WHY="THE GATE'S COUPLING TO THE JUDGE IS BROKEN. These literals are scraped
     from the report by this gate and are NO LONGER PRESENT in $JUDGE_SRC:$COUPLING_MISSING
     A scrape whose literal was renamed does not fail -- it silently matches nothing,
     and a marker grep that matches nothing reads as 'clean'. That is how a dead
     check promotes itself, so this gate refuses until the two files agree. FIX BOTH
     SIDES TOGETHER, or delete the scrape in favour of a machine-readable field."
          else
            WHY="THE GATE COULD NOT FIND THE JUDGE IT IS COUPLED TO. $JUDGE_SRC does not
     exist, so the literals this gate scrapes out of the report cannot be checked
     against the format strings that emit them. A check that cannot run has stopped
     checking, it has not passed. Point JUDGE_SRC at devgate/smoke.py."
          fi
        else
          # ---- THE TARGET. Which revision did we actually judge? -------------
          TAG="$(tr -dc 'a-zA-Z0-9-' < "$TAG_FILE" 2>/dev/null | head -c 64)"
          WANT_TAG="c$(printf '%s' "$WANT" | head -c 8)"
          say "  deploy tag       : want=$WANT_TAG file=${TAG:-<none>}"
          if [ -z "$TAG" ]; then
            CODE=63
            WHY="every condition holds and this gate STILL cannot promote, because
     $TAG_FILE does not name the tag the deploy step attached to the revision it
     built. Without it the gate cannot say WHICH revision it just judged, and it
     will not move traffic to whatever happens to be newest."
          elif [ "$TAG" != "$WANT_TAG" ]; then
            CODE=63
            WHY="the deploy tag '$TAG' is not the tag this commit should have produced
     ('$WANT_TAG'). The report, the build commit and the deployed revision must be
     three views of ONE thing; they are not, so nothing is promoted."
          else
            DECISION="PROMOTE"
          fi
        fi
      fi
    fi
  fi
fi

if [ "$DECISION" != "PROMOTE" ]; then
  say ""
  say "------------------------------------------------------------------------------"
  say "REFUSED -- TRAFFIC WAS NOT MOVED"
  say "------------------------------------------------------------------------------"
  say "$WHY"
  say ""
  say "The revision that was deployed is still at ZERO traffic and the previously"
  say "serving revision is untouched. A revision at zero traffic has changed nothing."
  say "GATE EXIT $CODE"
  exit $CODE
fi

# ============================ THE ALLOW PATH =================================
say ""
say "------------------------------------------------------------------------------"
say "GREEN -- all seven conditions hold. Promoting."
say "------------------------------------------------------------------------------"

gcloud run services describe "$SVC" --region "$REGION" --project "$PROJECT" \
  --format=json > "$WORK/before.json" 2>/dev/null
BEFORE="$(python3 - "$WORK/before.json" <<'PYBEFORE'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(""); raise SystemExit(0)
st = d.get("status", {})
print(",".join("%s=%s" % (t.get("revisionName"), t.get("percent"))
               for t in st.get("traffic", []) if t.get("percent")))
PYBEFORE
)"
say "  traffic before : $BEFORE"

# RESOLVE THE TARGET BY TAG, AND REFUSE RATHER THAN GUESS. Exactly one revision may
# carry the tag; zero means the deploy's tag is gone, and more than one is a state
# this gate has no business interpreting.
TARGET="$(python3 - "$WORK/before.json" "$TAG" <<'PYTARGET'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(""); raise SystemExit(0)
tag = sys.argv[2]
st = d.get("status", {})
hits = sorted({t.get("revisionName") for t in st.get("traffic", [])
               if t.get("tag") == tag and t.get("revisionName")})
print(hits[0] if len(hits) == 1 else "")
PYTARGET
)"
say "  target tag     : $TAG"
say "  target revision: ${TARGET:-<unresolved>}"
if [ -z "$TARGET" ]; then
  say ""
  say "------------------------------------------------------------------------------"
  say "REFUSED -- TRAFFIC WAS NOT MOVED"
  say "------------------------------------------------------------------------------"
  say "the tag '$TAG' does not resolve to exactly one revision on $SVC, so this gate"
  say "cannot name the revision it just judged. It will NOT fall back to --to-latest:"
  say "promoting whatever is newest would discard everything condition 5 established."
  say "GATE EXIT 63"
  exit 63
fi

if [ "$DRYRUN" = "1" ]; then
  say ""
  say "  PROMOTE_DRYRUN=1 -- the gate said YES and is printing the move instead of"
  say "  running it. This flag is read ONLY here, on the allow path. It cannot turn"
  say "  a refusal into a promotion; every refusal above exits before this line."
  say "  WOULD RUN: gcloud run services update-traffic $SVC --region $REGION --project $PROJECT --to-revisions $TARGET=100"
  say "GATE EXIT 0 (dry run)"
  exit 0
fi

gcloud run services update-traffic "$SVC" --region "$REGION" --project "$PROJECT" \
  --to-revisions "$TARGET=100" --quiet
MOVE_RC=$?
say "  update-traffic rc: $MOVE_RC"
if [ "$MOVE_RC" != "0" ]; then
  say "GATE EXIT 56  the gate allowed the promotion and the move itself failed."
  exit 56
fi

# CONFIRMED BY RE-READING, NEVER BY THE EXIT CODE ABOVE, and confirmed against the
# TARGET rather than against latestReadyRevisionName -- "the newest revision is at
# 100%" is not the claim this gate is making.
gcloud run services describe "$SVC" --region "$REGION" --project "$PROJECT" \
  --format=json > "$WORK/after.json" 2>/dev/null
READBACK="$(python3 - "$WORK/after.json" "$TARGET" <<'PYGATE'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("||NO"); raise SystemExit(0)
target = sys.argv[2]
st = d.get("status", {})
latest = st.get("latestReadyRevisionName", "")
serving = [t for t in st.get("traffic", []) if t.get("percent")]
at100 = [t.get("revisionName") for t in serving if t.get("percent") == 100]
print("%s|%s|%s" % (latest,
                    ",".join("%s=%s" % (t.get("revisionName"), t.get("percent"))
                             for t in serving),
                    "YES" if at100 == [target] else "NO"))
PYGATE
)"
LATEST="${READBACK%%|*}"
REST="${READBACK#*|}"
TRAFFIC="${REST%%|*}"
CONFIRMED="${REST##*|}"
say "  latest ready   : $LATEST"
say "  traffic after  : $TRAFFIC"
if [ "$LATEST" != "$TARGET" ]; then
  say "  NOTE: latestReadyRevision ($LATEST) is NOT the revision this build judged"
  say "        ($TARGET). Traffic was moved to the JUDGED one. A --to-latest gate"
  say "        would have promoted an unjudged revision here."
fi
if [ "$CONFIRMED" = "YES" ]; then
  say "GATE EXIT 0  PROMOTED and CONFIRMED BY RE-READ: $TARGET serves 100%."
  exit 0
fi
say "GATE EXIT 57  update-traffic reported success but the re-read does NOT show"
say "              $TARGET alone at 100%. The claim and the observation disagree,"
say "              and this gate believes the observation."
exit 57
