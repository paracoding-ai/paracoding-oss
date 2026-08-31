#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Paracoding / Agentic Fungi -- one-command install into YOUR OWN Google Cloud project.
#   bash install.sh PROJECT_ID [REGION]
# Apache-2.0. Nothing phones home. Every secret is generated here and stored in Secret
# Manager; none ship in this tree.
#
# Written POSIX-safe on purpose: macOS still ships bash 3.2, so no mapfile, no declare -A.
set -u
# [SEC-SETE-JUDGEMENT-V1] set -u WITHOUT set -e -- RE-JUDGED 2026-08-13 AND KEPT, ON
# MEASUREMENT, NOT HABIT. This script reads a captured exit status at 55 `$?` sites (ten of
# them the one-line `X=$(cmd); RC=$?` shape); under set -e the shell exits AT the failing
# command, so the branch written to READ that status never runs and every refusal built on
# it becomes an abort with no message. The 10/10 self-test's chk/chk_in return 1 by design
# so later checks still print, and 1b/10 turns a failed listing into a REFUSAL rather than
# a crash -- both are machinery set -e would break. The price of no set -e is paid per
# command instead: every mutation on a dangerous path carries its own `|| die` or captures
# and checks its status on the next line. Adding set -e now would be 55 behaviour changes,
# all regressions.

# [SEC-REHEARSE-V1] UNATTENDED REHEARSAL. Runs 0/10..8/10 with no human and stops
# deliberately at the 9/10 boundary, exit 20. It does NOT relax the -t 0 guard below:
# the harness gives this script a real pty, so the guard is satisfied honestly, and the
# script stops on its own BEFORE the step that needs a person. Default off.
PC_REHEARSE="${PC_REHEARSE:-0}"
# [SEC-INSTALL-PLAN-V1] --plan: run the read-only preflight through 1b/10, print every
# resource this run would CREATE, ADOPT or REPLACE by its full name, then continue into the
# real install only on an explicitly typed word. Probes only -- listings and describes -- so
# a plan that is declined leaves the project exactly as it found it.
PC_PLAN="${PC_PLAN:-0}"
PC_NO_ADOPT="${PC_NO_ADOPT:-0}"
# [SEC-UNATTENDED-V90] ARGUMENTS ARE A LOOP NOW RATHER THAN ONE case ON $1. The old form took
# exactly one flag and only in first position, so two flags together were impossible and an
# UNKNOWN flag was not an error at all -- it fell through into PROJECT and the run died much
# later claiming it could not see a project called "--foo". Unknown options are now refused by
# name, immediately, with exit 2.
PC_ARG_PROJECT=""
PC_ARG_REGION=""
# [SEC-INSTALL-PROFILE-V1] CHOOSE WHAT AN INSTALL CONTAINS. The ask is a lightweight install
# that is just the MCP server, the git server, the console and their wiring -- plus a way to
# leave the dev pipeline out. EVERYTHING DEFAULTS ON, so an existing command line gets exactly
# what it got yesterday and no adopter is moved by this change.
#
#   --no-devpipe     skip 8c/10 CI build identity and 8d/10 artifact retention
#   --no-history     skip 6c/10 the BigQuery forever-archive
#   --minimal        both at once
#   --profile NAME   minimal | full
#
# WHY THESE TWO BLOCKS AND NO OTHERS -- MEASURED IN THE EMITTED FILE, NOT CHOSEN BY EYE.
# Every step boundary was taken from the say() calls, then each candidate block was checked
# for what it leaks into the rest of the run:
#
#   6c/10   assigns  2 variables, NONE referenced after the block
#   8c/10   assigns  3 variables, NONE referenced after the block
#   8d/10   assigns 10 variables, NONE referenced after the block
#
# None of them defines a function used later, none appends to a failure accumulator, and
# 10/10's self-test references nothing any of them creates -- checked directly, because a
# self-test asserting a resource a skipped block was supposed to build would turn an
# intentional omission into a failed install. That is why no other step is offered: the
# others are not separable, and pretending otherwise produces a half-installed system that
# still prints INSTALL COMPLETE.
#
# THERE IS NO --no-ge FLAG because there is no GE component in this tree to skip, and no
# "client" profile alias because it would be identical to "full". An alias that names a
# distinction the installer does not make is worse than not offering it.
PC_NO_DEVPIPE="${PC_NO_DEVPIPE:-0}"
PC_NO_HISTORY="${PC_NO_HISTORY:-0}"
PC_PROFILE="${PC_PROFILE:-}"
PC_USAGE="usage: ./install.sh [--project ID] [--region REGION] [--no-adopt] [--plan]
                   [--minimal] [--profile minimal|full] [--no-devpipe] [--no-history]"
while [ $# -gt 0 ]; do
  case "$1" in
    --rehearse|--stop-before-passkey) PC_REHEARSE=1; shift ;;
    --plan) PC_PLAN=1; shift ;;
    --no-adopt) PC_NO_ADOPT=1; shift ;;
    --no-devpipe) PC_NO_DEVPIPE=1; shift ;;
    --no-history) PC_NO_HISTORY=1; shift ;;
    # [SEC-INSTALL-PROFILE-V2] --minimal SETS THE TWO FLAGS, IT DOES NOT SET A PROFILE.
    # It used to assign PC_PROFILE=minimal, and the profile is resolved ONCE after this
    # loop -- so the LAST of --minimal / --profile won, and the two orderings disagreed:
    # "--minimal --profile full" skipped nothing while "--profile full --minimal" skipped
    # everything. Setting the flags here makes --minimal a pure alias for the two --no-*
    # switches, which the resolver below can only ever turn further OFF. Order cannot
    # matter now, in either direction, and that is testable from the argument parser alone.
    --minimal) PC_NO_DEVPIPE=1; PC_NO_HISTORY=1; shift ;;
    --profile) PC_PROFILE="${2:-}"; [ -n "$PC_PROFILE" ] || { echo "--profile needs a name"; exit 2; }; shift 2 ;;
    --profile=*) PC_PROFILE="${1#--profile=}"; shift ;;
    --project) PC_ARG_PROJECT="${2:-}"; [ -n "$PC_ARG_PROJECT" ] || { echo "--project needs a project id"; exit 2; }; shift 2 ;;
    --project=*) PC_ARG_PROJECT="${1#--project=}"; shift ;;
    --region) PC_ARG_REGION="${2:-}"; [ -n "$PC_ARG_REGION" ] || { echo "--region needs a region"; exit 2; }; shift 2 ;;
    --region=*) PC_ARG_REGION="${1#--region=}"; shift ;;
    -h|--help) echo "$PC_USAGE"; exit 0 ;;
    --*) echo "unknown option: $1"; echo "$PC_USAGE"; exit 2 ;;
    *) if [ -z "$PC_ARG_PROJECT" ]; then PC_ARG_PROJECT="$1"
       elif [ -z "$PC_ARG_REGION" ]; then PC_ARG_REGION="$1"
       else echo "unexpected argument: $1"; echo "$PC_USAGE"; exit 2; fi; shift ;;
  esac
done
# [SEC-INSTALL-PROFILE-V1] RESOLVE THE PROFILE, THEN SAY WHAT WILL AND WILL NOT RUN.
# A profile only ever turns things OFF. An explicit --no-* alongside a profile stays off; a
# profile never turns back on something a flag switched off, so the two cannot fight.
# --minimal is NOT a profile and never reaches this switch: it sets the two --no-* flags
# in the loop above. That is what makes the claim on the line above true in both orderings.
case "$PC_PROFILE" in
  "")        : ;;
  minimal)   PC_NO_DEVPIPE=1; PC_NO_HISTORY=1 ;;
  full)      : ;;
  *) echo "unknown profile: $PC_PROFILE (known: minimal, full)"; echo "$PC_USAGE"; exit 2 ;;
esac
# PRINTED BEFORE PREFLIGHT AND BEFORE THE FIRST API CALL, deliberately. An operator who typed
# the wrong flag finds out at second zero rather than at 8c/10, and an operator who typed
# nothing sees that nothing was skipped.
if [ -z "$PC_PROFILE" ] && [ "$PC_NO_DEVPIPE" = 1 ] && [ "$PC_NO_HISTORY" = 1 ]; then
  echo "install profile: minimal (--minimal, or the two --no-* flags)"
else
  echo "install profile: ${PC_PROFILE:-full (default)}"
fi
if [ "$PC_NO_HISTORY" = 1 ] || [ "$PC_NO_DEVPIPE" = 1 ]; then
  echo "  SKIPPING:"
  [ "$PC_NO_HISTORY" = 1 ] && echo "    6c/10  history forever-archive (BigQuery)"
  [ "$PC_NO_DEVPIPE" = 1 ] && echo "    8c/10  the CI build identity"
  [ "$PC_NO_DEVPIPE" = 1 ] && echo "    8d/10  artifact retention"
  echo "  Everything else runs. Re-run without the flag to add a skipped piece later:"
  echo "  each of these steps is create-if-absent and safe to run against a live install."
else
  echo "  nothing skipped -- every step runs."
fi
# [SEC-NO-HIDDEN-PROMPT-V55] gcloud MUST NEVER PROMPT INSIDE THIS INSTALLER, AND UNTIL NOW IT
# COULD -- INVISIBLY. MEASURED 2026-08-15 on a fresh project: 0/10 sat with no output and no
# prompt until the operator pressed ENTER, repeatedly, across several runs, before working out
# that a keypress was what released it. The cause is a two-part trap:
#   PC_FSLOC=$(gcloud firestore locations list ... 2>/dev/null)
# On a fresh project firestore.googleapis.com is not enabled yet -- the comment above that very
# line says so -- and gcloud responds by ASKING "API [firestore.googleapis.com] not enabled on
# project [X]. Would you like to enable and retry?". That question is written to STDERR, which
# `2>/dev/null` discards, so the installer appears to hang while gcloud waits on stdin for an
# answer to a question nobody was shown.
#
# THE INSTALLER ALREADY KNEW THE FIX AND APPLIED IT TWICE. Two calls carry
# `CLOUDSDK_CORE_DISABLE_PROMPTS=1 ... </dev/null` per-call; 31 others do not. Fixing the one
# line that bit would leave thirty waiting, and every gcloud call added later would be a new
# one. So it is set ONCE, for the whole script, where it cannot be forgotten: gcloud takes the
# default and continues, or errors -- and an error is strictly better than a silent wait,
# because an error can be read. This installer asks its own questions with `read`; there is no
# gcloud prompt it ever wants a human to answer.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
# [SEC-UNATTENDED-V90] ./install.sh WITH NO ARGUMENTS NOW WORKS. The project is taken from
# --project, else the first positional (the old calling convention, still accepted), else
# whatever gcloud is already pointed at. A bare run is the common case and it should not have
# to be told the project it is already configured for.
PROJECT="$PC_ARG_PROJECT"
if [ -z "$PROJECT" ]; then
  PROJECT=$(gcloud config get-value project 2>/dev/null | sed 's/^(unset)$//' | head -1)
  [ -z "$PROJECT" ] || echo "  project not given; using the one gcloud is set to: $PROJECT"
fi
REGION="${PC_ARG_REGION:-us-east1}"
[ -n "$PROJECT" ] || { echo "no project to install into. Pass --project ID, or point gcloud at one:"; echo "    gcloud config set project YOUR_PROJECT_ID"; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"

# [SEC-LIVE-OUTPUT-V90] NO REDIRECT. THIS SCRIPT WRITES TO THE TERMINAL, LIVE.
# A previous cut sent stdout to a log file and printed only headlines. It made the install
# quieter and it also made it UNUSABLE: 6d/10 asks the operator to type allowed Google
# accounts, and its prompt went to the log, so the run appeared to hang after a step header
# with nothing on screen to answer. The operator had to Ctrl-C a working install.
# THE RULE THAT CAME OUT OF IT: a script that asks a human anything cannot redirect the
# stream it asks on. Verbosity is a preference; an invisible prompt is a broken program.
# Removing the workstation step already took ~2,300 lines and a third of the output out of
# this installer, which was most of the actual noise.

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
# @@PC_SHARED_BEGIN:PC_COMMON@@
# [SEC-LIVE-OUTPUT-V90] SHARED OUTPUT HELPERS. They live INSIDE the PC_COMMON region because
# workstation.sh is composed from it and its say()/die() call tell(). They were once above the
# fence, and the emitted workstation.sh then called a function it did not define -- which bash -n
# does NOT catch, because an undefined function is a RUNTIME error. Measured before it shipped:
# tell() defined 0 times and called 8 times in workstation.sh. Keep them here.
# They are deliberately trivial. An earlier cut made tell() write to both a log file and a saved
# terminal fd; that is what hid the 6d/10 prompt and made a working install look hung.
tell() { printf '%s\n' "$*"; }
tellblock() { cat >&2; }
pc_urls() {
  # [SEC-LAST-TWO-LINES-V90] THE LAST TWO LINES OF THIS INSTALL ARE THE TWO URLS AND NOTHING
  # ELSE. Everything above them is in the log. An operator who has just watched a long install
  # should not have to scroll a screen of prose to find the two strings the whole thing exists
  # to hand over. Printed on success AND on failure: a check that failed does not make these
  # wrong, and 8b/10 is known to be able to fail falsely.
  tell ""
  tell "console        ${CP_URL}/harness"
  tell "MCP connector  ${MC_URL}/mcp"
}
# [SEC-SINGLEPROJ-V2] PC_LANE -- ONE VARIABLE THAT NAMESPACES EVERY RESOURCE THIS INSTALLER
# CREATES, so a rehearsal lane and the real thing can share ONE project.
#
# IT IS A PREFIX, NOT A SUFFIX, and that is the whole reason it is usable. A prefix makes
# "^paracoding-dev-" one clean sweep pattern, which is what lets the uninstaller take a lane
# apart without enumerating -- or deleting -- the other lane's resources. A suffix would put
# every lane in the same namespace and leave the uninstaller globbing.
#
# THE DEFAULT IS EMPTY AND THAT IS LOAD-BEARING. With PC_LANE unset every name below expands
# to the exact string it expanded to before this variable existed, so an existing install is
# untouched: same services, same service accounts, same buckets, same database, same keys.
# The lane is opt-in, and opting out is the default.
#
# WHAT A LANE IS NOT: it is NOT a security boundary on Firestore. See the banner at 3/10.
PC_LANE="${PC_LANE:-}"
case "$PC_LANE" in
  "") PC_LP="" ;;
  -*|*-) echo "PC_LANE may not start or end with a hyphen: $PC_LANE" >&2; exit 2 ;;
  *[!a-z0-9-]*) echo "PC_LANE must be lowercase letters, digits and hyphens: $PC_LANE" >&2; exit 2 ;;
  *) PC_LP="${PC_LANE}-" ;;
esac
# [SEC-INSTALL-TOKEN-V1] PC_TOK -- the per-install random token, an INFIX between the lane
# prefix and the resource type: pc-<lane>-<hex6>-session-secret. An infix rather than a
# leading token because GCP requires service account ids and Cloud Run service names to
# START WITH A LETTER, and because both pattern families this product already relies on
# keep matching tokenized names UNCHANGED: the pc-<lane>-* prefix sweeps, and the
# end-anchored type patterns (*session-secret, *-control-plane) the uninstaller classifies
# with. Defined empty INSIDE the shared fence so every composed script sees it under set -u.
# install.sh resolves it at 1b/10 from the marker secret's pc-suffix label; workstation.sh
# recovers it from the same label before composing an instance name. Empty means the
# unsuffixed legacy names, which is what every install made before the token existed uses.
PC_TOK=""
# [SEC-REHEARSE-V1] PC_STEP carries the step label that is currently OPEN. A step that
# began and was followed by the NEXT step beginning is a step that finished: die() exits
# immediately, so no failed step is ever followed by another one. Per-step pass/fail
# therefore needs no per-step instrumentation and cannot drift as steps are renumbered.
PC_STEP=""
say() {
  # [SEC-QUIET-LOG-V90] A STEP HEADER GOES TO BOTH THE TERMINAL AND THE LOG, and the ##PCSTEP
  # markers MUST go to both: the Flowhood parses them out of this script's stdout to draw
  # progress, so routing them to the log alone would leave the harness blind while looking
  # perfectly healthy from here. Everything else a step prints stays in the log.
  if [ -n "$PC_STEP" ]; then tell "##PCSTEP OK $PC_STEP"; fi
  PC_STEP="${1%% *}"
  tell "##PCSTEP BEGIN $PC_STEP"
  tell ""
  tell "== $*"
}
die() {
  if [ -n "$PC_STEP" ]; then tell "##PCSTEP FAIL $PC_STEP"; fi
  tell ""
  tell "!! $*"
  exit 1
}

# [GCP-WS-OPTIONAL-NOT-FATAL-V76] A REFUSAL THAT IS NOT A FAILURE OF THE INSTALL.
# die() is right for "this deployment is not safe to continue building". It is WRONG for
# "one optional component cannot be built safely", which is a different sentence and used to
# be spelled the same way -- an unbuildable workstation aborted the whole run with every
# earlier step's resources already created. pc_ws_warn() prints the identical text to stderr
# with the same !! marker, so nothing about the WARNING is quieter or easier to miss, and
# then RETURNS. It deliberately does NOT emit ##PCSTEP FAIL: the step did not fail, it
# declined, and a machine-readable FAIL on a step that goes on to complete is a lie to
# whatever is parsing this transcript.
#
# [WS-LINUX-ONLY-V1 NOTE] IT HAS NO CALLER AS OF 10.1 AND IS KEPT ANYWAY, SAID PLAINLY HERE SO
# THE NEXT READER DOES NOT GO LOOKING FOR ONE. The rule it encodes did not go away -- 9/10
# runs workstation.sh as a subprocess and prints exactly this shape of message on a non-zero
# exit without failing the install -- but that path is an `echo` in the step, not a call here.
# Three other helpers went the same way when the workstation prompt was removed
# (pc_ask_yn, pc_ask_choice, pc_confirm_word): defined, no longer called, harmless. Deleting
# them is a separate change from the one this release is making, and is on the queue.
pc_ws_warn() {
  printf '\n!! %s\n' "$*" >&2
}

# A 403 that says the API is not enabled yet is worth retrying. Any OTHER 403 is a real
# permission problem, and retrying it only hides the message you needed to read.
# [SEC-INSTALL-PROPAGATE-V46] ONE CLASSIFIER, READ BY BOTH retry() AND pc_list(). It used to
# live inline inside retry(), which was fine while retry() was the only caller. 1b/10 now needs
# the SAME judgement, and two copies of a rule like this is how one of them quietly goes stale
# and starts refusing an install that the other would have retried.
pc_retryable() {
  case "$1" in
    # [SEC-INSTALL-DEV-V1] SA creation returns before IAM can see it; that race is retryable.
    *SERVICE_DISABLED*|*"has not been used in project"*|*"is disabled"*|*"not ready"*|*RESOURCE_EXHAUSTED*|*"does not exist"*|*"not found"*|*NOT_FOUND*|*"could not resolve source"*|*"storage.objects.get"*) return 0 ;;
    *) return 1 ;;
  esac
}

retry() {
  n=0
  while :; do
    out=$("$@" 2>&1); rc=$?
    [ $rc -eq 0 ] && { printf '%s' "$out"; return 0; }
    pc_retryable "$out" || { printf '%s\n' "$out" >&2; return $rc; }
    n=$((n+1)); [ $n -ge 9 ] && { printf '%s\n' "$out" >&2; return $rc; }
    sleep $((n*5))
  done
}

# [SEC-INSTALL-PROPAGATE-V46] THE OCCUPANCY LISTER, AND WHY IT IS NOT retry().
#
# MEASURED ON A GENUINELY FRESH PROJECT, 2026-08-15, and this is the whole reason it exists:
# 1/10 enables the APIs and 1b/10 immediately lists Cloud Run. On a project where Cloud Run
# has never been enabled, that listing loses the race with API propagation and returns
# FAILED_PRECONDITION. 1b/10 read the non-zero exit, refused with exit 30, and told the
# operator "These listings did not succeed: Cloud-Run-services" -- naming the listing and
# NOT the reason, because the call was written `2>/dev/null` and the reason had been thrown
# away. The install was dead on arrival on exactly the projects it is meant for, and the
# message could not tell you why. Re-running ten minutes later worked, which is the signature
# of a propagation race and is also why this went unnoticed: it never reproduces on a project
# that has been used before.
#
# TWO THINGS retry() CANNOT DO HERE, which is why this is a second function and not a call:
#   1. retry() folds stderr into stdout (2>&1) and returns the merged text as the VALUE. For a
#      listing that value becomes the resource list, so a gcloud notice on stderr would be
#      parsed as a resource NAME. That is a wrong answer, and a wrong answer in THIS step
#      means adopting a live deployment as a fresh one.
#   2. The refusal needs the error TEXT. A command substitution runs in a subshell, so a
#      variable set inside it cannot come back -- the error is written to a FILE instead,
#      which survives the subshell, and the refusal reads it from there.
#
# THE REFUSAL ITSELF IS UNCHANGED AND STAYS. An unknown answer must never be read as empty.
# What changes is that a KNOWN-TRANSIENT unknown is now waited out rather than refused, and a
# genuine one finally says what happened.
PC_LIST_ERRDIR="${TMPDIR:-/tmp}/pc-list-$$"
mkdir -p "$PC_LIST_ERRDIR" 2>/dev/null || PC_LIST_ERRDIR=""
pc_list() {
  _pl_tag=$1; shift
  _pl_n=0
  while :; do
    if [ -n "$PC_LIST_ERRDIR" ]; then
      _pl_out=$("$@" 2>"$PC_LIST_ERRDIR/$_pl_tag.err"); _pl_rc=$?
      _pl_err=$(cat "$PC_LIST_ERRDIR/$_pl_tag.err" 2>/dev/null)
    else
      _pl_out=$("$@" 2>/dev/null); _pl_rc=$?; _pl_err="(stderr not captured: no writable temp dir)"
    fi
    if [ $_pl_rc -eq 0 ]; then printf '%s' "$_pl_out"; return 0; fi
    pc_retryable "$_pl_err" || return $_pl_rc
    _pl_n=$((_pl_n+1)); [ $_pl_n -ge 9 ] && return $_pl_rc
    sleep $((_pl_n*5))
  done
}
pc_list_err() {
  [ -n "$PC_LIST_ERRDIR" ] || { printf '(no error text captured)'; return 0; }
  sed 's/^/      /' "$PC_LIST_ERRDIR/$1.err" 2>/dev/null | head -6
}

# [SEC-STDIN-DRAIN-V1] BUFFERED ENTER PRESSES USED TO ANSWER THE PROMPTS BELOW, AND ONE OF
# THOSE PROMPTS GUARDS AN IRRECOVERABLE STEP. Steps 1/10 and 6/10 take minutes. An operator
# who presses ENTER during them leaves newlines sitting in the terminal input queue; the next
# bare `read` consumes one INSTANTLY and returns "success" with an empty line. At 9/10 that
# fake answer was immediately followed by --remove-secrets WA_BOOTSTRAP_SECRET, which closes
# the passkey registration window for good -- nothing privileged can run without a passkey,
# including anything that would fix it, so the only way out is a COMPLETE REINSTALL. That
# happened. These two helpers are the fix, and every interactive read in this script goes
# through them.
#
# READ FROM THE CONTROLLING TERMINAL, NOT FROM FD 0. If stdin has been redirected the drain
# would flush the wrong queue and the prompt would read the wrong thing. /dev/tty is the
# terminal the human is actually typing at. Fall back to fd 0 only where /dev/tty is absent.
PC_TTY=/dev/tty
[ -r /dev/tty ] || PC_TTY=/dev/stdin

# `read -t 0` TESTS whether input is pending and CONSUMES NOTHING (bash >= 4.0), so the
# discarding read has to be a SECOND read inside the loop -- `while read -r -t 0 _d; do :; done`
# on its own spins forever the moment anything is buffered. bash 3.2, which macOS still ships,
# has no `-t 0` test form and no fractional -t at all, so there the timed size-bounded read
# below does the same job in one step and costs one second of wall clock.
pc_drain_stdin() {
  if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ] 2>/dev/null; then
    while read -r -t 0 _pc_d < "$PC_TTY" 2>/dev/null; do
      read -r _pc_d < "$PC_TTY" 2>/dev/null || break
    done
  else
    while read -r -t 1 -n 4096 _pc_d < "$PC_TTY" 2>/dev/null; do :; done
  fi
  _pc_d=""
}

# pc_confirm_word WORD PROMPT...
# Drains FIRST, then demands the literal WORD. Anything else -- including the bare newline a
# stale ENTER produces -- re-prompts, forever. EOF is NOT consent either: it re-prompts too,
# slowly, because the caller's next action is irreversible and "the pipe closed" is not a yes.
pc_confirm_word() {
  _pc_want="$1"; shift
  while :; do
    pc_drain_stdin
    printf '%s' "$*"
    if read -r _pc_ans < "$PC_TTY" 2>/dev/null; then
      _pc_ans=$(printf '%s' "$_pc_ans" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
      [ "$_pc_ans" = "$_pc_want" ] && { _pc_ans=""; return 0; }
      printf '\n  that was not the word "%s". Nothing has been changed yet.\n' "$_pc_want"
    else
      printf '\n  end of input on the terminal, which is not an answer. Still waiting.\n'
      sleep 5
    fi
  done
}

# pc_ask_yn PROMPT...  -> sets PC_YN to y or n. Drains FIRST; re-asks on anything it does not
# recognise, so a buffered ENTER can no longer silently pick the default for you.
PC_YN=n
pc_ask_yn() {
  while :; do
    pc_drain_stdin
    printf '%s' "$*"
    if read -r _pc_ans < "$PC_TTY" 2>/dev/null; then :; else
      # EOF here is safe to default: this question is above the 9/10 boundary and its
      # default answer creates nothing and bills nothing.
      printf '\n  end of input; taking that as no.\n'; PC_YN=n; return 0
    fi
    _pc_ans=$(printf '%s' "$_pc_ans" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
    case "$_pc_ans" in
      y|yes) _pc_ans=""; PC_YN=y; return 0 ;;
      n|no)  _pc_ans=""; PC_YN=n; return 0 ;;
      *)     printf '\n  please answer y or n.\n' ;;
    esac
  done
}

# pc_ask_choice DEFAULT "OPT OPT ..." PROMPT...  -> sets PC_CHOICE to one of the options.
# Same discipline as pc_ask_yn and for the same reason: DRAIN FIRST, then match the answer
# EXACTLY (after lowercasing and stripping whitespace) against the option list. Anything it
# does not recognise RE-PROMPTS -- it is never rounded to the nearest option, because
# rounding "windows" to "y" is how an operator ends up billed for the machine they did not
# ask for. An EMPTY answer takes DEFAULT, which is safe here only because the default of the
# one question that uses this creates nothing and bills nothing. EOF takes DEFAULT too, for
# the same reason pc_ask_yn does: this question is above the 9/10 boundary.
PC_CHOICE=""
pc_ask_choice() {
  _pc_def="$1"; _pc_opts="$2"; shift 2
  while :; do
    pc_drain_stdin
    printf '%s' "$*"
    if read -r _pc_ans < "$PC_TTY" 2>/dev/null; then :; else
      printf '\n  end of input; taking that as %s.\n' "$_pc_def"
      PC_CHOICE="$_pc_def"; return 0
    fi
    _pc_ans=$(printf '%s' "$_pc_ans" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
    if [ -z "$_pc_ans" ]; then PC_CHOICE="$_pc_def"; return 0; fi
    for _pc_o in $_pc_opts; do
      if [ "$_pc_ans" = "$_pc_o" ]; then PC_CHOICE="$_pc_o"; _pc_ans=""; return 0; fi
    done
    printf '\n  "%s" is not one of: %s\n' "$_pc_ans" "$_pc_opts"
  done
}

# @@PC_SHARED_END:PC_COMMON@@

# THE THREE SERVICES, THE TWO RUNTIME IDENTITIES AND THE FIVE SECRETS, ALL LANE-NAMESPACED.
# These sit AFTER the shared fence because workstation.sh shares the fence and has no use for
# them; PC_LP is defined INSIDE the fence so both scripts derive their names the same way and
# there is only one definition to keep right.
# [SEC-INSTALL-TOKEN-V1] ONE FUNCTION, CALLED AGAIN WHEN THE TOKEN IS KNOWN. Every name
# that carries the token is derived here and nowhere else: once now with PC_TOK empty --
# 1b/10's occupancy scan must recognise the unsuffixed shapes an older run left behind --
# and once more at 1b/10 the moment the token is resolved from the marker label (re-run)
# or minted (fresh install). Everything downstream reads these variables, so the re-derive
# moves every reference at once and no later step can compose a half-tokenized name.
pc_derive_names() {
  CP_SVC=paracoding-${PC_LP}${PC_TOK}control-plane
  MC_SVC=paracoding-${PC_LP}${PC_TOK}mcp
  GX_SVC=paracoding-${PC_LP}${PC_TOK}gate-exec
  CP_SA="pc-${PC_LP}${PC_TOK}control-plane@${PROJECT}.iam.gserviceaccount.com"
  GX_SA="pc-${PC_LP}${PC_TOK}gate-exec@${PROJECT}.iam.gserviceaccount.com"
  PC_SEC_SESSION="pc-${PC_LP}${PC_TOK}session-secret"
  # [GH-SECRET-LANE-PREFIX-V1] The GitHub token slot is lane-namespaced like every other secret
  # here, and for a reason that is not tidiness: two installs can share one GCP project, and an
  # unprefixed github-token-<identity> would be ONE secret shared by both -- with each lane's
  # installer granting its own service account read access to the other lane's GitHub
  # credential. The control plane cannot see ${PC_LP}, so it reads this prefix from
  # PC_GH_SECRET_PREFIX with the unprefixed name as its default, which is exactly what the
  # lane-literal gate asks for.
  PC_GH_SEC_PREFIX="pc-${PC_LP}${PC_TOK}github-token-"
  PC_SEC_CONFIRM="pc-${PC_LP}${PC_TOK}human-confirm-secret"
  PC_SEC_CREDS="pc-${PC_LP}${PC_TOK}webauthn-creds"
  PC_SEC_BOOT="pc-${PC_LP}${PC_TOK}bootstrap-secret"
}
pc_derive_names
say "0/10 preflight"
command -v gcloud >/dev/null || die "gcloud not found."
command -v openssl >/dev/null || die "openssl not found."
command -v python3 >/dev/null || die "python3 not found."
# [SEC-KEMPREREQ-V1] ML-KEM-768 IS A HARD PREREQUISITE AND IT IS CHECKED HERE, IN THE FIRST TEN
# SECONDS, BECAUSE THE ALTERNATIVE IS A TWENTY-MINUTE FAILURE THAT SPENDS YOUR PASSKEY FIRST.
#
# THE EXACT PATH THIS REPLACES, WALKED END TO END. Without ML-KEM: 5e/10 probed the same import,
# printed a reassuring non-fatal paragraph and CONTINUED; the vault master object was never
# minted; the control plane resolved epoch 2 to a 404 and threw; every git object write was
# refused because the store seals through that master; 8b/10 FN.GIT_SEED then drove
# git_propose and git_push over the whole release tree and every single step was refused; 10/10
# set FAIL=1 and the script exited 1. Twenty minutes and a full deploy from here, AFTER 9/10 has
# spent the operator passkey, with NOTHING in the output naming a missing Python library. On the
# path README recommends -- Cloud Shell -- that was the DEFAULT outcome, not an edge case.
#
# WHY IT IS FATAL RATHER THAN A WARNING. It used to be an enhancement: a lake that stayed
# fail-closed was a degradation you could live with. It stopped being one when the git object
# store was put behind the same master and the self-test was given a step that writes the whole
# tree through it. A prerequisite that half the install now depends on is a prerequisite.
#
# ONE NARROW FALSE REFUSAL, STATED RATHER THAN HIDDEN: a RE-RUN against an install whose master
# already exists does not need to mint anything, and this check cannot know that -- the bucket
# does not exist yet at 0/10 and the API that would answer is not enabled until 1/10. So that
# re-run is refused too. The remedy is the same one line, and a false refusal that costs a pip
# install is the right side of this trade against a true acceptance that costs a passkey.
python3 -c "from cryptography.hazmat.primitives.asymmetric import mlkem, x25519
mlkem.MLKEM768PublicKey" >/dev/null 2>&1 || die "this python3 cannot do ML-KEM-768, and every
lane of this install now depends on it.
WHAT IT IS FOR: 5e/10 mints the vault master by X-Wing encapsulation (ML-KEM-768 + X25519)
against Cloud KMS. The data lake and the git object store are BOTH sealed under that master, so
without it 8b/10 seeds no repository, 10/10 reports a failed install, and you find that out
after step 9/10 has already spent your passkey.
WHY NOTHING ELSE WILL DO: openssl implements ML-KEM but NOT X-Wing, and the TLS hybrid group
X25519MLKEM768 is not a substitute -- it concatenates where X-Wing runs a SHA3-256 combiner.
Python cryptography is the only library this script can name for it, and it must be a build
that exposes the mlkem module, which needs an OpenSSL 3.5 or newer underneath it.
THE PROBE ABOVE IS THE AUTHORITY, NOT A VERSION NUMBER, and that is deliberate: a
cryptography 46.0.7 built against OpenSSL 3.5.6 was MEASURED not to expose mlkem at all, so
'install cryptography 46' is advice that can leave you exactly where you started. Do not
conclude from a version string that you are done. Run the line below.
TRY, IN THIS ORDER, RE-RUNNING THE PROBE AFTER EACH:
    python3 -m pip install --upgrade cryptography
    python3 -m pip install --user --upgrade cryptography     (on a managed python3)
    a virtualenv, or your distribution package
  and if none of them satisfies the probe, this machine cannot complete the install. Run it
  from one whose python3 can, and see the release notes for the version that carries mlkem.
CHECK IT YOURSELF BEFORE RE-RUNNING -- this is the identical probe, and it prints nothing and
exits 0 when it is satisfied:
    python3 -c 'from cryptography.hazmat.primitives.asymmetric import mlkem, x25519; mlkem.MLKEM768PublicKey'
NOTHING HAS BEEN CREATED. This is step 0/10 and no resource, no API and no billing has been
touched."
# [SEC-PKG-STRANGER-V1] EVERY EXTERNAL ASSUMPTION, MADE LOUD AND EARLY. A prerequisite discovered at
# minute twenty is what makes an install fail. Each check below fires in the first ten
# seconds instead, and names the fix rather than the symptom.
command -v curl >/dev/null || die "curl not found. The 10/10 self-test is written in curl,
so without it a good install would report itself as a broken one."
# [SEC-SRCTREE-V120] THE INSTALLER IS NOT A ONE-FILE DOWNLOAD, AND 0/10 IS WHERE THAT IS SAID.
# MEASURED 2026-08-29 on a from-zero rehearse in a fresh project: fetching ONLY install.sh from
# the repository's raw URL -- which is what a raw link invites -- runs TWELVE steps green and
# then dies at 6/10 with "could not find source [/workspace/control-plane]". By then the KMS
# KEM key, three buckets, two service accounts, Firestore and a dozen IAM bindings all exist
# and are billing, and the error names a path inside a build workspace rather than the cause.
# HERE is dirname "$0", so the deploys at 6/10 and 8/10 read a tree that must already be beside
# this file: nothing in this script fetches or unpacks one. Assert it in the first ten seconds,
# with the other external assumptions, and refuse before anything exists.
for _d in control-plane gate-exec; do
  [ -f "$HERE/$_d/Dockerfile" ] || die "install.sh is not a standalone download: $HERE/$_d/Dockerfile is missing.
This script DEPLOYS FROM SOURCE beside it -- 6/10 runs 'gcloud run deploy --source \$HERE/control-plane'
and 8/10 does the same for gate-exec -- and it never fetches or unpacks a tree of its own.
Downloading install.sh alone gets you twelve green steps and then a failure at 6/10, with a KMS
key, three buckets, two service accounts and Firestore already created and billing.
GET THE WHOLE RELEASE, then run it from inside the unpacked directory with the leading ./ :
    curl -fsSLO https://github.com/paracoding-ai/paracoding-oss/archive/refs/heads/main.tar.gz
    tar -xzf main.tar.gz && cd paracoding-oss-main && ./install.sh
NOTHING HAS BEEN CREATED. This is step 0/10 and no resource, no API and no billing has been touched."
done
# [SEC-UNATTENDED-V90] THE INTERACTIVE-TERMINAL GUARD IS REMOVED. It read
#   [ -t 0 ] || die "install.sh needs an interactive terminal. Step 9/10 stops to have you
#   register a passkey and then waits on ENTER ..."
# -- and that reason is gone with step 9/10. Refusing to start without a tty is now exactly
# backwards: this installer is meant to be kicked off and left alone, including from CI.
# gcloud is still never allowed to prompt; that is handled where it is caused, below.
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
# [SEC-CBI-PROBE-V1] PROBE --clear-base-image THE SAME WAY, AND DROP THE FLAG IF IT IS ABSENT.
# Step 6/10 passes `gcloud run deploy --clear-base-image`; it is a recent flag, and an SDK that
# predates it does not warn -- it EXITS 2 on an unrecognised argument. That would happen at
# 6/10, AFTER Firestore, the service accounts, five secrets, both reserved URLs, two KMS
# keyrings and four buckets already exist, which is the most expensive possible place to learn
# that a local tool is old. The flag is an OPTIMISATION, not a control: it clears any automatic
# base-image association an earlier deploy attached so Cloud Run cannot rebase the image
# underneath this one. An install without it is correct, merely unpinned -- so this is
# WARN-and-drop and never a die. A preflight must not be stricter than the step it guards,
# which is the rule the --iap probe above states and this one follows.
# --help is answered by the locally installed SDK and never goes to the network; the prompt
# suppression and </dev/null are needed here for the same reason they are needed above.
PC_CBI_FLAG="--clear-base-image"
PC_CBI_HELP=$(CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run deploy --help 2>/dev/null </dev/null) || PC_CBI_HELP=""
printf '%s' "$PC_CBI_HELP" | grep -qE -- '(^|[^-[:alnum:]])--clear-base-image([^-[:alnum:]]|$)' || {
  PC_CBI_FLAG=""
  echo "  NOTE: this SDK's 'gcloud run deploy --help' does not advertise --clear-base-image,"
  echo "        so 6/10 deploys WITHOUT it rather than dying on an unknown argument after"
  echo "        everything else has been created. The install is correct either way; the image"
  echo "        simply keeps whatever automatic base-image association it already had."
  echo "        To pin it: gcloud components update, then re-run this installer."
}
PC_CBI_HELP=""
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
# [SEC-PREFLIGHT-COVERAGE-V1] THE FIVE ABOVE COVERED 1/10, 3/10, 4/10 AND 6/10 AND NOTHING
# ELSE. Not one of them is exercised by 5b/10 (KMS), 5c/10 (buckets), 5e/10 (KMS again),
# 6c/10 (BigQuery) or 8/10 (IAP) -- which are exactly the steps a locked-down
# project denies, and each of them is twenty minutes deep. These five close that gap. They are
# a SEPARATE list because they carry a different verdict: a missing one is a WARNING naming the
# step that will decline, not a refusal to install, since every one of those steps is either
# skippable or already warn-and-continue, and a preflight must not be stricter than the step it
# guards. testIamPermissions accepts up to 100 permissions in one call, so this costs no extra
# round trip.
PC_NEED_OPT="cloudkms.cryptoKeys.create storage.buckets.create bigquery.datasets.create iap.web.setIamPolicy"
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
PC_IAM_TOK=$(gcloud auth print-access-token 2>/dev/null)
pc_iam_probe() {
  # $* = permission names. Prints the subset the caller holds, or nothing on any failure.
  _pc_pb=$(printf '%s' "$*" | python3 -c 'import sys,json;print(json.dumps({"permissions":sys.stdin.read().split()}))' 2>/dev/null)
  [ -n "$_pc_pb" ] || return 0
  curl -sS -m 30 -X POST -H "Authorization: Bearer $PC_IAM_TOK" -H "Content-Type: application/json" -d "$_pc_pb" "https://cloudresourcemanager.googleapis.com/v1/projects/$PROJECT:testIamPermissions" 2>/dev/null | python3 -c 'import sys,json;print(" ".join(json.load(sys.stdin).get("permissions",[])))' 2>/dev/null
}
PC_HAVE=""
PC_HAVE_OPT=""
if [ -n "$PC_IAM_TOK" ]; then
  # ONE CALL FOR ALL NINE, THEN A FALLBACK THAT PROTECTS THE FATAL FIVE. If Google ever
  # rejects one of the nine names outright the whole request 400s and comes back EMPTY -- and
  # empty is FATAL below, by design. That would turn a widened probe into a bricked installer,
  # which is precisely the class of defect this block's own history records. So an empty answer
  # is retried with the original five alone: the fatal check keeps working, and the four
  # additions can only ever lose their advisory verdict, never invent a failure.
  PC_HAVE=$(pc_iam_probe "$PC_NEED $PC_NEED_OPT")
  if [ -n "$PC_HAVE" ]; then
    PC_HAVE_OPT="$PC_HAVE"
  else
    PC_HAVE=$(pc_iam_probe "$PC_NEED")
    [ -z "$PC_HAVE" ] || echo "  authority: the nine-permission probe was refused; re-checked the five that are fatal."
  fi
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
  # THE ADVISORY HALF. Named per step, because "you are missing bigquery.datasets.create" is
  # useless to an operator who does not know which step wanted it.
  PC_MISS_OPT=""
  if [ -n "$PC_HAVE_OPT" ]; then
    for _p in $PC_NEED_OPT; do
      case " $(echo $PC_HAVE_OPT) " in *" $_p "*) : ;; *) PC_MISS_OPT="$PC_MISS_OPT $_p" ;; esac
    done
  fi
  if [ -n "$PC_MISS_OPT" ]; then
    echo "  authority: NOT held, and each of these makes ONE later step decline rather than"
    echo "             fail the install -- listed now so it is not a surprise at minute twenty:"
    for _p in $PC_MISS_OPT; do
      case "$_p" in
        cloudkms.cryptoKeys.create)  echo "    $_p          -> 5b/10 approval signing key, 5e/10 the PCV1 vault key" ;;
        storage.buckets.create)      echo "    $_p             -> 5c/10 the data lake, git object store and exec-records buckets" ;;
        bigquery.datasets.create)    echo "    $_p           -> 6c/10 the history forever-archive (or run with --no-history)" ;;
        iap.web.setIamPolicy)        echo "    $_p               -> 8/10 putting the console behind IAP -- WITHOUT THIS THE" ;;
      esac
    done
    case "$PC_MISS_OPT" in *iap.web.setIamPolicy*)
      echo "             CONSOLE IS REACHABLE BY ANYONE WHO LEARNS ITS URL. 8/10 prints what to"
      echo "             click; do it before you put anything in the lake." ;;
    esac
  elif [ -n "$PC_HAVE_OPT" ]; then
    echo "  authority: the KMS, Storage, BigQuery, Compute and IAP permissions the later steps"
    echo "             need are present too"
  fi
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
# [SEC-INSTALL-PROPAGATE-V46] THREE OUTCOMES, NOT TWO, AND THE THIRD IS THE COMMON ONE.
# This check ran BEFORE 1/10 enables firestore.googleapis.com, so on a genuinely fresh project
# the listing CANNOT succeed -- and the old two-branch form sent every such operator into the
# else, printing a WARNING that their region might not be a Firestore location. It said "(or
# the list could not be read)" in the same breath, which is the tell: it could not distinguish
# "your region is wrong" from "I was unable to look", and it printed the alarming reading of
# both. MEASURED on a fresh project 2026-08-15: the warning fired, and us-east1 is in fact a
# perfectly good Firestore location -- 2/10 created the database there without complaint.
#
# A check that cries wolf on every fresh install is worse than no check: the operator who
# needs it is the one who has learned to scroll past it.
PC_FSLOC=$(gcloud firestore locations list --project "$PROJECT" --format='value(locationId)' 2>/dev/null); PC_FSLOC_RC=$?
if [ "$PC_FSLOC_RC" -ne 0 ] || [ -z "$PC_FSLOC" ]; then
  echo "  region: $REGION -- not checked against the Firestore location list yet, because"
  echo "          firestore.googleapis.com is not enabled until 1/10. This is normal on a new"
  echo "          project and is NOT a problem with your region. Step 2/10 creates the"
  echo "          database and is the real answer; if it refuses, pick a region in BOTH sets:"
  echo "          us-east1, us-central1, europe-west1, asia-northeast1."
elif printf '%s' "$PC_FSLOC" | grep -qx "$REGION"; then
  echo "  region: $REGION is a Firestore location as well as a Cloud Run region"
else
  echo "  WARNING: $REGION is a Cloud Run region but is NOT in this project's Firestore"
  echo "           location list, which was read successfully -- so this is a real mismatch,"
  echo "           not an unchecked one. Step 2/10 will fail. Choose a region in BOTH sets:"
  echo "           us-east1, us-central1, europe-west1, asia-northeast1."
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
# NOTHING ELSE IN THE EMITTED TREE NEEDS IT. index.ts no longer makes a :generateAccessToken
# call at all -- its one caller was the ungated dev-project tool, now deleted at source. The
# single remaining match is a substring in the danger-classifier regex, which tests a URL
# string and calls nothing.
#
# [SEC-VERTEX-ENABLE-V1] aiplatform.googleapis.com IS ENABLED, AND THE PRECEDENT DIRECTLY
# ABOVE IS THE REASON IT MUST BE -- NOT AN ARGUMENT AGAINST IT. [SEC-MINTER-REMOVE-V1]
# removed an API THAT HAD NO CALLER. This one has THREE, all in the EMITTED
# control-plane/src/index.ts, all reached on an ordinary first use of the chat:
#   harChatGemini()  index.ts:3776  POST .../publishers/google/models/<model>:generateContent
#   harClaudePost()  index.ts:3649  POST .../publishers/anthropic/models/<model>:rawPredict
#   memEmbed()       index.ts:722   POST .../publishers/google/models/text-embedding-005:predict
# VERTEX IS THE DEFAULT TRANSPORT FOR BOTH CHAT PATHS, NOT AN OPT-IN. harClaudeProvider()
# (index.ts:3601) returns vertex unless CHAT_CLAUDE_PROVIDER says otherwise, and
# harGeminiTransport() (index.ts:3587) returns vertex unless CHAT_GEMINI_PROVIDER=studio AND a
# real key is present. So an install that does not enable this API ships a chat surface whose
# FIRST message is a 500. Measured in dev: Vertex Gemini answered SERVICE_DISABLED until this
# API was enabled and HTTP 200 immediately afterwards, with nothing else changed.
# DO NOT DELETE THIS AS UNUSED. Grep the three function names above first; the IAM binding
# that makes it work is granted to $CP_SA at step 3/10 and carries the same marker.
# [SEC-API-ENABLE-COMPLETE-V1] SIX APIS THE SHIPPED PRODUCT CALLS WERE NOT ENABLED HERE, AND ON
# a project where they are off the install SUCCEEDS and the product fails later, at first use, with
# a SERVICE_DISABLED that names an API nobody asked for. Found 2026-08-23 by auditing every API
# enabled in a working install against every <api>.googleapis.com reference in this repository:
#
#   storage             gate-exec/exec_server.py, pipeline/collect-evidence.py, index.ts, this file
#                       -- the DATA LAKE AND THE GIT OBJECT STORE. It works today only because
#                       Storage is on by default in most projects; a project with it off had no
#                       lake and no repository, and nothing in the install said so.
#   iamcredentials      control-plane/src/gittools.ts -- minting the ID token /git/archive accepts.
#   cloudscheduler      THE LINE STAYS AND THIS SENTENCE IS WHY. It was here for scheduled runners
#                       that 12.5 DELETES, and a stale comment naming a deleted component reads as
#                       an instruction to drop the API -- the exact trap
#                       [APIS-COMPUTE-IS-NOT-THE-WORKSTATION] records. install.sh creates no
#                       scheduler job itself; step 2/10 grants admin on this API, and a gate
#                       executor driven by a scheduled tick needs it.
#   monitoring          control-plane/src/index.ts, and workstation.sh grants the VM SA
#                       roles/monitoring.metricWriter, which is inert if the API is off.
#   cloudbilling        cost reporting.
#   generativelanguage  index.ts, the CHAT_GEMINI_PROVIDER=studio path.
#
# [SEC-API-ENABLE-COMPLETE-V2] A SEVENTH, FOUND THE SAME WAY AND MISSED BY THE FIRST PASS:
#   cloudfunctions      pipeline/secret-destroy-preflight.py:156 posts to
#                       https://cloudfunctions.googleapis.com/v2 to scan gen1 and gen2
#                       secretEnvironmentVariables and secretVolumes. That preflight is what
#                       stands between an operator and deleting a secret something still
#                       reads, so on a fresh install the FIRST secret deletion 403s -- on the
#                       check, not on the delete. A safety preflight that cannot run is worse
#                       than a missing feature, because it fails at the moment it is needed.
#
# THE AUDIT'S OWN LIMIT, STATED SO NOBODY TREATS THIS LIST AS COMPLETE: it greps for the literal
# host <api>.googleapis.com. An API called through a client library that never spells the host is
# invisible to it -- Model Armor is enabled and in use in a sibling install and appears ZERO times
# by this test. Absence of the string is not evidence of disuse.
#
# NOT ADDED, DELIBERATELY: discoveryengine.googleapis.com. Gemini Enterprise agents are aiplatform
# reasoningEngines; the install that actually runs them does NOT have Discovery Engine enabled at
# all. When that tree lands here its APIs are agentregistry, networkservices and modelarmor, and
# they belong in an opt-in block like BigQuery's rather than on by default for every adopter.
retry gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com logging.googleapis.com storage.googleapis.com \
  iamcredentials.googleapis.com cloudscheduler.googleapis.com monitoring.googleapis.com \
  cloudbilling.googleapis.com generativelanguage.googleapis.com \
  compute.googleapis.com cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
  cloudkms.googleapis.com iap.googleapis.com aiplatform.googleapis.com \
  cloudfunctions.googleapis.com \
  --project "$PROJECT" >/dev/null || die "could not enable APIs"
echo "  enabled (propagation is absorbed by retry below, not by a fixed sleep)"

# ------------------------------------------------------- [SEC-INSTALL-SKEW-V1] 1b/10
# WHAT THIS REFUSES, AND WHY IT SITS HERE RATHER THAN AT 0/10.
#
# This installer had NO guard against being run at a project that already holds a
# deployment. Two hazards, one missing preflight.
#
#   THE LANE FOOTGUN. PC_LANE is an environment variable. Unset, empty or misspelled, the
#   prefix is empty and the PROD path runs at a project that already holds a prod install:
#   it ADOPTS the lake bucket, ADOPTS the database, redeploys the services and prints
#   success the whole way down.
#
#   VERSION SKEW, which is the operator's framing and is the broader one: an adopter runs
#   a NEWER installer over an OLDER deployment. There was no version recorded anywhere, so
#   there was nothing to compare and no statement of what was about to be replaced.
#
# IT RUNS AFTER 1/10 AND BEFORE 2/10 DELIBERATELY. Every probe below is a LISTING, and a
# listing needs its API enabled -- at 0/10 run.googleapis.com and secretmanager may never
# have been turned on, and "the API is off" and "the project is empty" are the same answer
# to a caller that cannot tell them apart. Guessing there is exactly the failure this step
# exists to prevent. 1/10 enables APIs and creates NOTHING, so this is still ahead of the
# first resource: 2/10 is where the first thing gets made.
#
# IT IS ALSO THE FIRST THING --rehearse HAS EVER BEEN ABLE TO EXERCISE. The rehearsal
# boundary is above 9/10, so 1b/10 runs in full under it, and a guard that a rehearsal
# cannot reach is a guard nobody tests.
#
# NOTHING BELOW RELIES ON FAILURE PROPAGATION. This script runs `set -u` with NO `set -e`,
# so a failed command does not end anything: every probe captures its own exit status on
# the very next line and an UNKNOWN answer REFUSES. A listing that failed is never read as
# an empty project -- that is the mistake that turns a guard into a rubber stamp.
#
# NO BARE LANE-NAMESPACED NAME APPEARS HERE. The unprefixed legacy install and any sibling
# lane are found by GLOB against the names the listings actually returned, never by writing
# a literal that gen.py's lane-literal gate would rightly refuse. So the report names
# real resources without this file ever hardcoding one.
say "1b/10 occupancy and version skew -- what is already here, before anything is created"
PC_SKEW_EXIT=30
PC_MARK_SEC="pc-${PC_LP}install-marker"
PC_RELEASE="fb40b85fa26202714898c62f8b4160653d3dc8f2"
PC_VERSION="12.5"
PC_ADOPT_UNMARKED="${PC_ADOPT_UNMARKED:-0}"
# [SEC-GATEREMOVAL-V1] THE APPROVAL CLICK IS OFF BY DEFAULT, AND THIS IS THE LINE THAT
# DECIDES IT FOR EVERY INSTALL. Until now PC_AUTO_APPROVE appeared NOWHERE in this
# installer: index.ts defaults it to "0", so every install this product has ever produced
# shipped the tap-to-approve gate -- while the fleet that wrote it ran with the variable
# hand-set to 1. PROD WAS RUNNING A CONFIGURATION NO INSTALL COULD PRODUCE, which is the
# same shape as four other defects found in this release, and it is why this is settable
# here rather than left to whoever remembers.
#
# WHY OFF IS THE RIGHT DEFAULT, and it is a judgement the operator made deliberately: a
# click that cannot be meaningfully reviewed degrades into a rubber stamp, and a rubber
# stamp writes human_approved:true for something nobody read -- a FALSE record rather than
# a weak one. The real authentication root is the Google account behind the console login,
# which is stronger than a per-job tap.
#
# WHAT DOES *NOT* GO AWAY, so nobody reads this as "no controls":
#   * DESTRUCTIVE commands still refuse. They are NOT run and NOT queued; the question
#     comes back in chat and needs an explicit confirm. Auto-approve re-derives that
#     verdict from the command text itself rather than trusting the caller.
#   * LOCKOUT-CLASS changes still refuse, for the same reason.
#   * Every invariant that asks DOES THIS DO WHAT IT SAYS stays armed. The gate asked MAY
#     I; that is the only question being retired.
#   * The approval is still KMS-SIGNED and the executor still verifies it. The approver
#     field says auto:lockout-check inside the signed bytes, because there is no human in
#     that path and the audit trail must not claim one.
#
# SET PC_AUTO_APPROVE=0 TO KEEP THE CLICK. It is a deploy-time variable, so turning it back
# on -- or off -- is a Cloud Run revision, never a gated job. That matters: the undo stays
# available even in the state where no job could be approved.
PC_AUTO_APPROVE="${PC_AUTO_APPROVE:-1}"
case "$PC_AUTO_APPROVE" in
  0|1) ;;
  *) die "PC_AUTO_APPROVE must be 0 or 1; it is '$PC_AUTO_APPROVE'. 1 (the default) runs
approved-by-you work without a per-job tap; 0 keeps the tap-to-approve gate." ;;
esac

# [SEC-NOBRAKES-V1] DO RUNTIME REFUSALS EXIST AT ALL. Default 0 -- OFF -- because the
# operator this was built for issues the instruction and the agent is their hands, and a
# second "are you sure" to the person who just said do it buys nothing. With it off, a
# destructive command runs and a lockout-class change runs; both are still journalled,
# because knowing what happened is what makes rolling forward possible and a log line
# costs nothing. PC_GUARDRAILS=1 restores both refusals for an adopter who wants brakes.
#
# WHAT THIS DOES NOT TOUCH, AND THE DISTINCTION IS THE WHOLE POINT: every check that
# fails a CUT is untouched -- this generator's own refusals, route-audit, blob-audit, the
# leak ceilings, smoke.py, the compare-and-swap on push. Those cost zero runtime friction
# and catch a defect before it can ship. What is switched off is only the refusal that
# stops work already asked for. A recovery from a lockout-class mistake is Cloud Shell,
# which the operator holds; that is the trade being made deliberately here.
PC_GUARDRAILS="${PC_GUARDRAILS:-0}"
case "$PC_GUARDRAILS" in
  0|1) ;;
  *) die "PC_GUARDRAILS must be 0 or 1; it is '$PC_GUARDRAILS'. 0 (the default) runs
destructive and lockout-class work without refusing; 1 refuses both and returns to chat." ;;
esac

# ONE NAMED EXIT CODE FOR EVERY REFUSAL THIS STEP MAKES, so a wrapper can tell "this
# project is occupied or the versions disagree" from "the install broke" (1) and from
# "bad arguments" (2) and from "the rehearsal boundary" (20).
#
# [SEC-INSTALL-RESUME-V48] THE CLOSING LINE IS COMPUTED NOW, NOT HARDCODED. It used to end
# EVERY refusal this step makes with "Nothing has been created", which is true of the run
# that meets an empty project and FALSE of the run that meets its own half-finished work.
# MEASURED on a fresh project on 2026-08-15: a run died at 6/10 having created a Firestore
# database, three buckets, two KMS keyrings, three service accounts, three secrets, a Cloud
# Run service and a Windows VM; the re-run refused at 1b/10 and closed by telling the
# operator that nothing existed and nothing was billing. An operator who reads that and
# walks away is billed for a database, three buckets and a running VM they believe are not
# there. The claim is now made only when the occupancy scan has PROVED it, and the scan is
# what decides which of the three sentences below is printed:
#   * something was found  -> resources from an earlier run DO exist, this run created
#     nothing NEW, and uninstall.sh is what removes them;
#   * scan finished, found nothing -> the original sentence, which is now earned;
#   * scan did not finish (a refusal from the listings themselves, or from the marker
#     label above them) -> say it cannot tell, because it cannot. An installer that
#     guesses "empty" here is the same mistake the whole step exists to refuse.
# PC_SCAN_STATE is set beside PC_OURS/PC_OTHER below; it is read through ${...:-} so the
# refusals that fire BEFORE the scan still run under set -u.
pc_refuse() {
  if [ -n "$PC_STEP" ]; then echo "##PCSTEP FAIL $PC_STEP"; fi
  {
    echo ""
    echo "!! REFUSED -- exit $PC_SKEW_EXIT"
    echo ""
    echo "$*"
    echo ""
    if [ -n "${PC_OURS:-}${PC_OTHER:-}${PC_ADOPTABLE:-}" ]; then
      echo "THIS RUN CREATED NOTHING NEW -- the only change it made to $PROJECT is that the"
      echo "APIs at 1/10 are now enabled, which creates no resource and bills nothing. But"
      echo "RESOURCES FROM AN EARLIER RUN DO EXIST in $PROJECT: they are the ones listed"
      echo "above, they were there before this run started, and they keep billing whether or"
      echo "not this install is ever finished. To remove them:"
      echo "    bash uninstall.sh $PROJECT $REGION"
    elif [ "${PC_SCAN_STATE:-unscanned}" = scanned ]; then
      echo "Nothing has been created. The only change this run made to $PROJECT is that the"
      echo "APIs at 1/10 are now enabled, which creates no resource and bills nothing."
  else
      echo "This run created nothing: the only change it made to $PROJECT is that the APIs at"
      echo "1/10 are now enabled, which creates no resource and bills nothing. WHAT AN EARLIER"
      echo "RUN MAY HAVE LEFT HERE IS UNKNOWN -- this refusal fired before the occupancy scan"
      echo "finished, so this script cannot tell you whether $PROJECT is empty, and it will not"
      echo "guess. Fix the cause above and re-run; 1b/10 reports what is here as its first act."
    fi
  } | tellblock
  exit $PC_SKEW_EXIT
}

# Strip any resource-path prefix so a listing that returns projects/N/secrets/NAME and one
# that returns NAME are the same thing to everything below.
pc_names() { printf '%s' "$1" | sed 's#.*/##' | grep -v '^$'; }
pc_has() { pc_names "$2" | grep -qx -- "$1"; }

# [SEC-INSTALL-PROPAGATE-V46] pc_list, NOT a bare call with 2>/dev/null. See the comment on
# pc_list for the measurement: on a fresh project these lose the race with the API enablement
# at 1/10, and the old form both refused the install and discarded the reason.
PC_Q_RUN=$(pc_list run gcloud run services list --project "$PROJECT" --region "$REGION" --format='value(metadata.name)'); PC_Q_RUN_RC=$?
PC_Q_SEC=$(pc_list sec gcloud secrets list --project "$PROJECT" --format='value(name)'); PC_Q_SEC_RC=$?
PC_Q_SA=$(pc_list sa gcloud iam service-accounts list --project "$PROJECT" --format='value(email)'); PC_Q_SA_RC=$?
# The bucket listing feeds the 10/10 lane assertion, NOT the refusal below: storage is the
# one API here that 1/10 does not enable (it is on by default), so its failure is recorded
# and judged at 10/10 BY NAME instead of refusing every install on a listing hiccup.
PC_Q_BKT=$(pc_list bkt gcloud storage buckets list --project "$PROJECT" --format='value(name)'); PC_Q_BKT_RC=$?
PC_UNK=""
[ "$PC_Q_RUN_RC" -eq 0 ] || PC_UNK="$PC_UNK Cloud-Run-services"
[ "$PC_Q_SEC_RC" -eq 0 ] || PC_UNK="$PC_UNK Secret-Manager-secrets"
[ "$PC_Q_SA_RC" -eq 0 ] || PC_UNK="$PC_UNK service-accounts"
# [SEC-INSTALL-PROPAGATE-V46] THE REFUSAL NOW SAYS WHY. It named the listing and not the
# reason, so the one message an operator got on a fresh project was unactionable. Each failing
# listing prints the actual gcloud stderr underneath it. The refusal itself is unchanged: an
# unknown answer is still never read as empty.
if [ -n "$PC_UNK" ]; then
  PC_UNK_DETAIL=""
  for _pu in $PC_UNK; do
    case "$_pu" in
      Cloud-Run-services)      _pt=run ;;
      Secret-Manager-secrets)  _pt=sec ;;
      service-accounts)        _pt=sa  ;;
      *)                       _pt=""  ;;
    esac
    PC_UNK_DETAIL="$PC_UNK_DETAIL
  $_pu:
$( [ -n "$_pt" ] && pc_list_err "$_pt" )"
  done
  pc_refuse "COULD NOT ESTABLISH WHAT IS ALREADY IN THIS PROJECT.
These listings did not succeed:$PC_UNK
$PC_UNK_DETAIL

An unknown answer is refused rather than assumed empty. A failed listing that is read as
'nothing is there' is how an installer adopts a live deployment and calls it a fresh one.

Each listing above was already retried for about four minutes against the transient causes
(API not propagated yet, quota, a resource not visible yet). So this is NOT the fresh-project
propagation race -- that one is waited out now and never reaches this message. Read the error
text above: it is almost certainly a permission the account does not hold. Fix that, then
re-run -- a re-run is safe and nothing has been created."
fi

# THE MARKER. It records WHICH RELEASE last ran here, and it is written by this step before
# anything else is created, so a run that dies at 2/10 still leaves the record behind.
# ABSENCE IS ITSELF A VERSION SIGNAL: every release before this one wrote no marker, so
# "our resources are here and no marker is" means an older release is installed.
PC_MARK=""
PC_MARK_STATE=absent
PC_MARK_VER=""
PC_MARK_COMMIT=""
if pc_has "$PC_MARK_SEC" "$PC_Q_SEC"; then
  PC_MARK=$(gcloud secrets versions access latest --secret="$PC_MARK_SEC" --project "$PROJECT" 2>/dev/null); PC_MARK_RC=$?
  if [ "$PC_MARK_RC" -ne 0 ]; then
    PC_MARK_STATE=unreadable
  else
    PC_MARK=$(printf '%s' "$PC_MARK" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    PC_MARK_VER=""
    PC_MARK_COMMIT=""
    case "$PC_MARK" in
      "") PC_MARK_STATE=unreadable ;;
      *" "*)
        PC_MARK_VER=${PC_MARK%% *}
        PC_MARK_COMMIT=${PC_MARK#* }
        PC_MARK_STATE=present ;;
      *[!0-9a-f]*) PC_MARK_STATE=unreadable ;;
      *) PC_MARK_COMMIT="$PC_MARK"; PC_MARK_STATE=present ;;
    esac
  fi
fi

# [SEC-INSTALL-TOKEN-V1] THE TOKEN RIDES THE MARKER AS A LABEL AND IS RESOLVED HERE,
# BEFORE THE OCCUPANCY SCAN, so the scan compares the listings against the names this
# install ACTUALLY uses. The label key is pc-suffix for continuity with the original
# suffix ruling; THE VALUE IS NOW AN INFIX, placed right after the lane prefix. It rides a
# LABEL and not the payload on purpose: the payload is the release id, validated above as
# bare hex and rewritten WHOLESALE by the documented upgrade command, while a label
# survives `secrets versions add` untouched. The marker's own name NEVER carries the token
# -- it is the fixed discovery root everything else is recovered from.
if pc_has "$PC_MARK_SEC" "$PC_Q_SEC"; then
  PC_TOK_LBL=$(gcloud secrets describe "$PC_MARK_SEC" --project "$PROJECT" --format='value(labels.pc-suffix)' 2>/dev/null); PC_TOK_RC=$?
  [ "$PC_TOK_RC" -eq 0 ] || pc_refuse "THE MARKER SECRET $PC_MARK_SEC EXISTS BUT ITS LABELS COULD NOT BE READ
(describe exited $PC_TOK_RC). The pc-suffix label is what tells this run which per-install
token its resource names carry, and a run that cannot read it would compose the WRONG name
for every resource it touches. Check that this account can describe the secret, then
re-run."
  PC_TOK_LBL=$(printf '%s' "$PC_TOK_LBL" | tr -d '[:space:]')
  case "$PC_TOK_LBL" in
    "") PC_TOK="" ;;
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      PC_TOK="${PC_TOK_LBL}-"
      echo "  re-using the recorded install token $PC_TOK_LBL (the marker's pc-suffix label)" ;;
    *) pc_refuse "THE pc-suffix LABEL ON $PC_MARK_SEC IS NOT SIX LOWERCASE HEX CHARACTERS.
This run cannot compose resource names from it and refuses to guess. Read it yourself and
fix or remove the label:
    gcloud secrets describe $PC_MARK_SEC --project $PROJECT --format='value(labels.pc-suffix)'" ;;
  esac
  pc_derive_names
fi

PC_OURS=""
PC_OTHER=""
pc_ours() { PC_OURS="$PC_OURS
    $1"; }
pc_other() { PC_OTHER="$PC_OTHER
    $1"; }
for _n in $(pc_names "$PC_Q_RUN"); do
  case "$_n" in
    "$CP_SVC"|"$MC_SVC"|"$GX_SVC") pc_ours "Cloud Run service $_n" ;;
    paracoding-*control-plane|paracoding-*mcp|paracoding-*gate-exec) pc_other "Cloud Run service $_n" ;;
  esac
done
for _n in $(pc_names "$PC_Q_SEC"); do
  case "$_n" in
    "$PC_SEC_SESSION"|"$PC_SEC_CONFIRM"|"$PC_SEC_CREDS"|"$PC_SEC_BOOT"|"$PC_MARK_SEC") pc_ours "secret $_n" ;;
    pc-*session-secret|pc-*human-confirm-secret|pc-*webauthn-creds|pc-*bootstrap-secret|pc-*install-marker) pc_other "secret $_n" ;;
  esac
done
for _n in $(pc_names "$PC_Q_SA"); do
  case "$_n" in
    # [SEC-INSTALL-TOKEN-V1] OURS is matched with the resolved token in place; the any-lane
    # line below is anchored on the TYPE with a wildcard in front, so a name carrying any
    # other token still classifies as this product's rather than falling out of the scan.
    "pc-${PC_LP}${PC_TOK}control-plane@"*|"pc-${PC_LP}${PC_TOK}gate-exec@"*|"pc-${PC_LP}${PC_TOK}workstation@"*|"pc-${PC_LP}${PC_TOK}build@"*) pc_ours "service account $_n" ;;
    pc-*control-plane@*|pc-*gate-exec@*|pc-*workstation@*|pc-*build@*) pc_other "service account $_n" ;;
  esac
done

# [SEC-INSTALL-RESUME-V48] THE SCAN IS COMPLETE AS OF THIS LINE, AND pc_refuse READS THAT.
# Every refusal above fired without knowing what is in the project; every refusal below
# knows. That is the difference between a closing line that states what is here and one
# that guesses -- see pc_refuse.
PC_SCAN_STATE=scanned

echo "  this installer is v$PC_VERSION (release $PC_RELEASE)"
if [ -n "$PC_OURS" ]; then
  echo "  already in $PROJECT and belonging to THIS lane (lane prefix: '${PC_LP}'):$PC_OURS"
else
  echo "  nothing belonging to this lane (lane prefix: '${PC_LP}') is in $PROJECT yet"
fi

# [SEC-LANE-EMPTYGUARD-V1] THE LANE FOOTGUN, CLOSED AS A REFUSAL RATHER THAN A WARNING.
# PC_LANE is an environment variable: unset, empty, or exported in a different shell than
# the one this is typed into, the prefix is empty and this run IS the unprefixed PROD path.
# When that path meets a project already carrying the unprefixed install, every later step
# ADOPTS -- the lake bucket, the database, the keyring -- and redeploys the services,
# printing success the whole way down. The marker checks below do NOT cover this case: a
# same-release re-run matches the marker and would sail through. Operating on the
# unprefixed install over live resources must be a decision somebody STATES, never a
# default somebody forgot, so the escape is an explicit environment variable and nothing
# quieter.
#
# [SEC-INSTALL-RESUME-V48] ONE SENTENCE ABOVE NO LONGER HOLDS AS WRITTEN: "the marker
# checks below do NOT cover this case: a same-release re-run matches the marker and would
# sail through". That was the reason this guard never consulted the marker, and it treats a
# same-release marker match as a coincidence to be ignored. It is not a coincidence. The
# marker is THIS INSTALLER'S OWN SIGNATURE, written by this very step before any resource is
# created, precisely so a run that dies early leaves the record behind.
#
# MEASURED on a real fresh project on 2026-08-15. A run died at 6/10 having created a
# Firestore database, three buckets, two KMS keyrings, three service accounts, three
# secrets, a Cloud Run service and a Windows VM. The re-run two minutes later reached
# 1b/10, printed "re-using the recorded install token" off the marker's own pc-suffix
# label, and then refused with the message below -- calling its own half-finished work
# "the live unprefixed deployment". Getting past it cost the operator two undocumented
# discoveries: PC_EMPTY_LANE_OK=1, and typing the word adopt at a prompt. The installer
# held the evidence the whole time and never looked at it.
#
# SO THE VERDICT IS COMPUTED FROM THAT EVIDENCE, from two comparisons and nothing softer:
#   * PC_MARK -- the release the MARKER RECORDS, the secret's payload, read above -- equals
#     PC_RELEASE, the release THIS INSTALLER IS, baked in at generation. It is the same
#     equality the "re-run of the SAME release" line prints at the end of this step; and
#   * PC_TOK, the token this run composes every name from, is the one the marker carries in
#     its pc-suffix label. That makes "the resources listed above are named by this marker"
#     a checked statement rather than an assumed one. At this line PC_TOK can only have
#     come from that label -- the mint is further down -- and the comparison keeps the
#     statement true if the mint is ever moved above it.
# Both true: an empty PC_LANE meeting unprefixed resources is this install RESUMING itself,
# and a resume needs no consent to touch what it made.
#
# WHAT STAYS EXACTLY AS HARD AS IT WAS. Marker ABSENT (the older-release case, and the case
# where an earlier run of this release died before it could record anything), marker
# UNREADABLE, a DIFFERENT release, or a token that is not the marker's: none of those has
# evidence that the resources belong to this run, all of them are the stranger-deployment
# case this guard was written for, and all of them still refuse below with the message
# below unchanged.
#
# WHAT IT COSTS, STATED RATHER THAN GLOSSED: this installer cannot tell "died at 6/10" from
# "finished cleanly" -- both leave the marker and the resources -- so a same-release re-run
# over a COMPLETE unprefixed install now proceeds without PC_EMPTY_LANE_OK as well. That is
# the trade taken deliberately: same release and same token means the same names, so such a
# re-run redeploys what is already there rather than replacing it with something else. The
# directions that cost something -- a different release over a live install, adoption of an
# unmarked or stranger deployment -- are all decided by the checks below, and none of them
# is touched.
PC_EMPTY_LANE_OK="${PC_EMPTY_LANE_OK:-0}"
PC_TOK_MARKED=""
[ -z "${PC_TOK_LBL:-}" ] || PC_TOK_MARKED="${PC_TOK_LBL}-"
PC_RESUME=0
if [ "$PC_MARK_STATE" = present ] && [ "$PC_MARK_VER" = "$PC_VERSION" ] && [ "$PC_TOK" = "$PC_TOK_MARKED" ]; then
  PC_RESUME=1
fi
if [ -z "$PC_LP" ] && [ -n "$PC_OURS" ] && [ "$PC_EMPTY_LANE_OK" != 1 ] && [ "$PC_RESUME" = 1 ]; then
  echo "  PC_LANE is empty and unprefixed resources are here, AND the marker records this"
  echo "  installer's own release ($PC_RELEASE) under the token these names carry. That makes"
  echo "  this a RESUME of an install that did not finish, not adoption of somebody else's"
  echo "  deployment: continuing over resources this release created is what a resume is."
  echo "  Neither PC_EMPTY_LANE_OK nor the adopt prompt is required for that."
fi
if [ -z "$PC_LP" ] && [ -n "$PC_OURS" ] && [ "$PC_EMPTY_LANE_OK" != 1 ] && [ "$PC_RESUME" != 1 ]; then
  if [ "$PC_NO_ADOPT" = 1 ]; then
    pc_refuse "PC_LANE IS EMPTY, THIS PROJECT ALREADY CARRIES THE UNPREFIXED INSTALL, AND
--no-adopt WAS PASSED. Re-run without it to adopt, or set a lane:
    PC_LANE=<your-lane> ./install.sh --project $PROJECT"
  else
    # [SEC-ADOPT-UNPREFIXED-V90] Same ruling as the unmarked case below: adopt and say so.
    echo "  ADOPTING the unprefixed resources listed above. PC_LANE is empty, so this run"
    echo "  continues over the existing unprefixed deployment: it re-asserts settings and"
    echo "  redeploys the services. Nothing is deleted and no secret is rotated."
    echo "  Set PC_LANE=<your-lane> and re-run instead if you meant a separate install."
  fi
fi

if [ "$PC_MARK_STATE" = unreadable ]; then
  pc_refuse "THE VERSION MARKER IS PRESENT AND UNREADABLE, WHICH IS NOT THE SAME AS ABSENT.
Secret $PC_MARK_SEC exists in $PROJECT but its latest version could not be read, or does
not hold a release id. This installer cannot tell what is deployed here, and an installer
that cannot tell refuses instead of guessing.
Read it yourself and decide:
    gcloud secrets versions access latest --secret=$PC_MARK_SEC --project $PROJECT"
fi
# [SEC-MARKER-VERSION-V90] SKEW IS DECIDED ON THE VERSION, NOT THE COMMIT, AND THAT IS THE
# WHOLE POINT. This block used to compare PC_RELEASE -- the git commit -- so EVERY rebuild of
# the same release read as a version change and refused. Its own refusal text said why it had
# to refuse: "two release ids are not ordered, so newer-over-older and older-over-newer look
# identical from here". True of commit ids. NOT true of oss/VERSION, which is MAJOR.MINOR and
# which gen.py hard-fails on if it is not -- so it IS ordered, and the direction IS knowable.
# MEASURED 2026-08-16: an operator was refused mid-test because his project held 9.0 built at
# 5ed84335 and the installer was 9.0 built at 60b59d1a. Same release. Nothing to refuse.
pc_vercmp() {
  _a_maj=${1%%.*}; _a_rest=${1#*.}; _a_min=${_a_rest%%.*}
  _b_maj=${2%%.*}; _b_rest=${2#*.}; _b_min=${_b_rest%%.*}
  case "${_a_maj}${_a_min}${_b_maj}${_b_min}" in *[!0-9]*) echo unknown; return 0 ;; esac
  if   [ "$_a_maj" -gt "$_b_maj" ]; then echo gt
  elif [ "$_a_maj" -lt "$_b_maj" ]; then echo lt
  elif [ "$_a_min" -gt "$_b_min" ]; then echo gt
  elif [ "$_a_min" -lt "$_b_min" ]; then echo lt
  else echo eq; fi
}
if [ "$PC_MARK_STATE" = present ] && [ -z "$PC_MARK_VER" ]; then
  echo "  the marker records only a commit and no version, which is what every release before"
  echo "  9.0 wrote. The installed release cannot be compared, so this run continues and"
  echo "  rewrites the marker in the version format at the end. Installed commit: $PC_MARK_COMMIT"
fi
if [ "$PC_MARK_STATE" = present ] && [ -n "$PC_MARK_VER" ]; then
  PC_VCMP=$(pc_vercmp "$PC_VERSION" "$PC_MARK_VER")
  case "$PC_VCMP" in
    eq)
      if [ "$PC_MARK_COMMIT" = "$PC_RELEASE" ]; then
        echo "  re-run of the same build ($PC_VERSION, $PC_RELEASE)"
      else
        echo "  same release ($PC_VERSION), different build: this project was installed from"
        echo "  $PC_MARK_COMMIT and this installer is $PC_RELEASE. Continuing -- settings are"
        echo "  re-asserted, nothing is deleted, and the marker is updated at the end."
      fi ;;
    gt)
      echo "  UPGRADE: $PC_MARK_VER is installed here and this installer is $PC_VERSION."
      echo "  Continuing. Settings are re-asserted and the services are redeployed; nothing is"
      echo "  deleted and no secret is rotated." ;;
    lt)
      pc_refuse "DOWNGRADE REFUSED. THIS PROJECT HOLDS A NEWER RELEASE THAN THIS INSTALLER.
    installed here : $PC_MARK_VER  ($PC_MARK_COMMIT)
    this installer : $PC_VERSION  ($PC_RELEASE)
    lane prefix    : '${PC_LP}'
Running an older installer over a newer install would redeploy the services from older code and
report success while doing it. Unlike two commit ids, two VERSIONS are ordered, so this is not a
guess: it is a downgrade, and it is the one direction that cannot be undone by re-running.
Install $PC_MARK_VER or newer, or set PC_LANE to install alongside it under a prefix of your own." ;;
    *)
      pc_refuse "THE MARKER'S VERSION COULD NOT BE PARSED.
    marker  : '$PC_MARK'
    version : '$PC_MARK_VER'  (expected MAJOR.MINOR)
Refusing rather than guessing at what is installed. Inspect it with:
    gcloud secrets versions access latest --secret=$PC_MARK_SEC --project $PROJECT" ;;
  esac
fi
if [ "$PC_MARK_STATE" = absent ] && [ -n "$PC_OURS" ]; then
  if [ "$PC_NO_ADOPT" = 1 ]; then
    pc_refuse "THIS LANE ALREADY HAS RESOURCES AND NO VERSION MARKER, AND --no-adopt WAS PASSED.
The resources listed above are here and secret $PC_MARK_SEC is not. Re-run without --no-adopt
to adopt them, or set PC_LANE to install alongside them under a prefix of your own."
  else
    # [SEC-ADOPT-UNMARKED-V90] ADOPT AND CONTINUE. This used to REFUSE with exit 30, and its own
    # refusal text named the case it was refusing: "an earlier run of THIS release died before it
    # could write the marker". That is the single most common way an operator meets this branch --
    # a run dies at 6/10, and the re-run that should heal it is turned away instead. It cost a
    # real adopter a whole project: he could not install over his own failed attempt and made a
    # new one. Adoption is now the default everywhere in this installer, and this branch was the
    # last place still refusing it. --no-adopt refuses, above.
    echo "  ADOPTING the resources listed above. Secret $PC_MARK_SEC is absent, which means"
    echo "  either an older release made them, or an earlier run of THIS release died before it"
    echo "  wrote the marker. Both are re-runnable: settings are re-asserted, data is not deleted,"
    echo "  and secrets are never rotated by a re-run. The marker is written at the end of this run."
    echo "  If you did not expect anything to be here, stop now and check PC_LANE -- it is"
    echo "  currently '${PC_LANE}', and an empty or misspelled lane runs the PROD path."
  fi
fi
if [ -n "$PC_OTHER" ]; then
  echo "  ALSO IN $PROJECT, and NOT this lane's:$PC_OTHER"
  if [ "$PC_REHEARSE" = 1 ]; then
    pc_refuse "ANOTHER INSTALL IS ALREADY IN THIS PROJECT AND THIS IS A REHEARSAL.
The resources listed above carry a different lane prefix from '${PC_LP}' -- an unprefixed
legacy install, or a sibling lane. Sharing one project across lanes is supported, but it
is a decision a person makes, and --rehearse runs with nobody to make it. Run it
interactively, or pick a project of its own."
  fi
  # [SEC-UNATTENDED-V90] ANNOUNCED, NOT ASKED. This was the last prompt that could hang an
  # unattended run forever: pc_confirm_word re-prompts on EOF rather than defaulting, so with
  # no terminal it looped with a 5-second sleep and never returned. Sharing a project across
  # lanes is supported and this run does not touch the other lane's resources, so the useful
  # act is the DISCLOSURE, not the keystroke. --no-adopt refuses if that is what you meant.
  echo "  NOTE: the resources above belong to a DIFFERENT install in this project."
  echo "  Sharing one project across lanes is supported and this run will not touch them, but"
  echo "  they share the project's quotas, its Artifact Registry repository and its staging"
  echo "  buckets, and an uninstall of either lane has to leave the other alone."
  echo "  If the lane prefix above is not what you intended, stop now and set PC_LANE."
fi

# [SEC-ADOPT-CONSENT-V1] ADOPTION IS A DECISION, NOT A SUCCESS LINE. The resource steps
# print "adopting ..." when a lake bucket, a database or a keyring of this lane's names
# already exists -- and on a re-run that is the expected state. What was missing is the
# moment where a person SAYS SO. This probe finds everything the run would adopt and asks
# ONCE, here, before anything is created, instead of scattering prompts through steps a
# rehearsal must cross unattended. UNKNOWN REFUSES, exactly as the listings above: a probe
# that failed is never read as "nothing to adopt". Consent arrives one of three ways: the
# typed word at the prompt; PC_ADOPT=1 (or the PC_ADOPT_UNMARKED=1 that an unmarked
# adoption already required) stated in the environment; or, for a rehearsal only, the
# marker equality above -- the project is on this exact release, so re-adoption is the
# state the rehearsal exists to exercise.
PC_ADOPT="${PC_ADOPT:-0}"
PC_ADOPTABLE=""
pc_adoptable() { PC_ADOPTABLE="$PC_ADOPTABLE
    $1"; }
for _pc_b in "${PROJECT}-${PC_LP}${PC_TOK}datalake" "${PROJECT}-${PC_LP}${PC_TOK}source" "${PROJECT}-${PC_LP}${PC_TOK}exec-records"; do
  _pc_o=$(gcloud storage buckets describe "gs://$_pc_b" --format='value(name)' 2>&1); _pc_rc=$?
  if [ "$_pc_rc" -eq 0 ]; then pc_adoptable "bucket gs://$_pc_b"
  elif printf '%s' "$_pc_o" | grep -qiE 'not found|404|NOT_FOUND|does not exist'; then :
  else pc_refuse "COULD NOT ESTABLISH whether bucket gs://$_pc_b already exists (describe exited $_pc_rc).
An unknown answer is refused rather than adopted past. Check that this account can read the
bucket metadata, then re-run."
  fi
done
PC_FS_SEEN=$(gcloud firestore databases list --project "$PROJECT" --format='value(name)' 2>/dev/null); _pc_rc=$?
[ "$_pc_rc" -eq 0 ] || pc_refuse "COULD NOT LIST the Firestore databases in $PROJECT (exit $_pc_rc), so this run
cannot tell whether it would ADOPT one. An unknown answer is refused rather than adopted
past. 2/10 needs this same listing anyway; check the API and re-run."
PC_FS_SEEN=$(printf '%s\n' "$PC_FS_SEEN" | sed 's#.*/##' | grep -E "^paracoding-${PC_LP}[0-9a-f]{12}$" | head -1)
[ -n "$PC_FS_SEEN" ] && pc_adoptable "Firestore database $PC_FS_SEEN"
for _pc_k in "paracoding-${PC_LP}approvals" "paracoding-${PC_LP}vault"; do
  _pc_o=$(gcloud kms keyrings describe "$_pc_k" --location "$REGION" --project "$PROJECT" 2>&1); _pc_rc=$?
  if [ "$_pc_rc" -eq 0 ]; then pc_adoptable "KMS keyring $_pc_k in $REGION"
  elif printf '%s' "$_pc_o" | grep -qiE 'not found|404|NOT_FOUND|does not exist'; then :
  else pc_refuse "COULD NOT ESTABLISH whether KMS keyring $_pc_k exists in $REGION (describe exited $_pc_rc).
An unknown answer is refused rather than adopted past. Check access and re-run."
  fi
done
if [ -n "$PC_ADOPTABLE" ]; then
  echo "  THIS RUN WILL ADOPT, NOT CREATE:$PC_ADOPTABLE"
  if [ "$PC_ADOPT" = 1 ] || [ "$PC_ADOPT_UNMARKED" = 1 ]; then
    echo "  adopting them ON YOUR SAY-SO (stated in the environment)."
  elif [ "$PC_REHEARSE" = 1 ] && [ "$PC_MARK_STATE" = present ]; then
    echo "  rehearsal re-run of the release the marker records: adoption is the expected"
    echo "  state, and the marker equality above already proved the release matches."
  elif [ "$PC_RESUME" = 1 ]; then
    # [SEC-INSTALL-RESUME-V48] THE OTHER HALF OF THE MEASURED 2026-08-15 RE-RUN. Past the
    # lane guard, the same re-run stopped here and asked the operator to type the word
    # adopt over a database, three buckets and two keyrings THIS RELEASE had created two
    # minutes earlier. A prompt that fires on a run's own recorded work teaches operators
    # to type the word without reading it, which is what the prompt is for. The rehearsal
    # branch directly above already reasoned this way for a marker-present re-run and only
    # ever applied to --rehearse; the same marker equality, plus the token check, decides
    # it for an interactive one. Absent, unreadable, different-release or different-token
    # markers never reach here: they refused above, and the prompt still stands for the
    # unmarked-adoption case it was written for.
    echo "  re-run of the release the marker records ($PC_RELEASE), under the token these"
    echo "  names carry: the resources above are this install's own, from a run that did not"
    echo "  finish. Re-entering them is a resume, not an adoption decision -- not prompting."
  elif [ "$PC_NO_ADOPT" = 1 ]; then
    pc_refuse "THE RESOURCES ABOVE WOULD BE ADOPTED AND --no-adopt WAS PASSED.
Nothing has been created or changed. Re-run without --no-adopt to adopt them, or set PC_LANE
to install alongside them under a lane prefix of your own."
  else
    # [SEC-ADOPT-DEFAULT-V90] ADOPTING IS THE DEFAULT NOW AND IT IS ANNOUNCED, NOT ASKED.
    # This used to block on the typed word `adopt`. On a re-run -- which is how this installer
    # is actually used -- adoption is the expected outcome every time, so the prompt asked a
    # question whose answer was always yes and made an otherwise unattended run stop dead.
    # It changes NO behaviour to consent: PC_ADOPT was only ever read at this one branch and
    # was never a mode switch. Every resource step is describe-first on its own and re-asserts
    # its settings whether or not anybody typed anything. What is kept is the DISCLOSURE --
    # the full list above, printed before anything is created -- and --no-adopt to refuse.
    echo "  ADOPTING the resources listed above. This is a re-run over what they already hold:"
    echo "  settings are re-asserted, data is not deleted, and secrets are never rotated by a"
    echo "  re-run. Pass --no-adopt to refuse instead, or set PC_LANE to install beside them."
  fi
fi

# [SEC-INSTALL-TOKEN-V1] MINT -- ONLY ON A GENUINELY FRESH LANE. Three ways this run can
# still be tokenless here, and only one of them mints:
#   * the marker exists: resolved above. A marker WITHOUT the label is a LEGACY install and
#     stays on unsuffixed names FOREVER -- re-tokenising a live install would rename the
#     WebAuthn origin service and invalidate every registered passkey.
#   * no marker, but this lane's resources or adoptable BUCKETS are here: an OLDER release
#     (which recorded nothing) made them under unsuffixed names, and consenting to adopt
#     them means USING those names, so the run stays legacy and the marker written below
#     records no token. The database and the keyrings do not constrain this: their names
#     are exempt from the token by ruling, so adopting them says nothing about the names
#     the token governs.
#   * no marker and nothing of this lane's anywhere: genuinely fresh. Mint 3 bytes of
#     /dev/urandom as 6 lowercase hex -- the same idiom the database name uses at 2/10 --
#     and re-derive every name with it. The marker write below records it as the pc-suffix
#     label BEFORE the first resource is created, so tokenized resources never exist
#     without their token being recorded somewhere durable.
if [ "$PC_MARK_STATE" = absent ] && [ -z "$PC_OURS" ]; then
  case "$PC_ADOPTABLE" in
    *"bucket gs://"*) echo "  no marker, but adoptable buckets exist: staying on their unsuffixed names" ;;
    *)
      PC_TOK=$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
      case "$PC_TOK" in
        [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) PC_TOK="${PC_TOK}-" ;;
        *) die "could not mint the per-install token: od over /dev/urandom did not yield 6 lowercase hex" ;;
      esac
      pc_derive_names
      echo "  minted install token ${PC_TOK%-} -- every tokenized name carries it right after the lane prefix"
      ;;
  esac
fi
# [SEC-INSTALL-TOKEN-V1] THE 30-CHARACTER SERVICE ACCOUNT CEILING, REFUSED HERE WHERE IT IS
# CHEAP. A service account id caps at 30 characters and control-plane is the longest type
# this install appends, so one comparison bounds all four accounts. The API would refuse
# the create at 3/10 anyway; refusing at 1b names the cause with the computed length, and
# it fires before the plan, before the marker and before any resource exists.
PC_SA_LONGEST="pc-${PC_LP}${PC_TOK}control-plane"
if [ "${#PC_SA_LONGEST}" -gt 30 ]; then
  pc_refuse "THE LANE PREFIX AND THE INSTALL TOKEN OVERFLOW A SERVICE ACCOUNT NAME.
    longest account id : $PC_SA_LONGEST
    computed length    : ${#PC_SA_LONGEST} characters (the platform cap is 30)
Every service account this install creates is named pc-<lane>-<token>-<type>. Pick a
shorter PC_LANE and re-run; with the 6-hex token and its hyphen the lane itself can be at
most 6 characters."
fi

# [SEC-INSTALL-PLAN-V1] THE PLAN, PRINTED AFTER THE OCCUPANCY VERDICTS ABOVE -- so every
# line sits on listings that succeeded -- and BEFORE the marker write below, so a declined
# plan leaves no trace: the only change is 1/10 API enablement, which creates no resource
# and bills nothing. Full names, one per line, one of three verbs: CREATE (absent from the
# listings above), ADOPT (exists; used in place), REPLACE (a Cloud Run service that exists
# and is redeployed over). Verbs are computed from the SAME listings and probes the
# verdicts used, never from a second probe that could disagree with them. Names are matched
# by the same prefix patterns the occupancy scan uses, so a naming scheme that grows a
# suffix keeps matching. Unlike pc_confirm_word, anything but the exact word STOPS -- the
# safe direction for a gate whose yes creates forty resources.
if [ "$PC_PLAN" = 1 ]; then
  pc_plan_line() { printf '    %-8s %s\n' "$1" "$2"; }
  pc_plan_svc()  { if pc_has "$1" "$PC_Q_RUN"; then pc_plan_line REPLACE "Cloud Run service $1 (redeployed, then traffic shifted)"; else pc_plan_line CREATE "Cloud Run service $1"; fi; }
  pc_plan_sec()  { if pc_has "$1" "$PC_Q_SEC"; then pc_plan_line ADOPT "secret $1$2"; else pc_plan_line CREATE "secret $1$2"; fi; }
  pc_plan_sa()   { if printf '%s\n' "$PC_Q_SA" | grep -q "^$1"; then pc_plan_line ADOPT "service account $1${PROJECT}.iam.gserviceaccount.com$2"; else pc_plan_line CREATE "service account $1${PROJECT}.iam.gserviceaccount.com$2"; fi; }
  echo ""
  echo "  PLAN -- what this run would do to $PROJECT (lane prefix '${PC_LP}', install token '${PC_TOK%-}'), by full name:"
  pc_plan_svc "$CP_SVC"
  pc_plan_svc "$MC_SVC"
  pc_plan_svc "$GX_SVC"
  pc_plan_sa "pc-${PC_LP}${PC_TOK}control-plane@" ""
  pc_plan_sa "pc-${PC_LP}${PC_TOK}gate-exec@" ""
  # [SEC-PLAN-PROFILE-V1] THE PLAN READS THE PROFILE FLAGS. It did not, so "--minimal --plan"
  # listed a build service account the run then never created -- a plan that promises work
  # the run will not do is worse than no plan, because the whole point of --plan is that
  # what it prints is what happens.
  if [ "$PC_NO_DEVPIPE" = 1 ]; then
    pc_plan_line SKIP "service account pc-${PC_LP}${PC_TOK}build@${PROJECT}.iam.gserviceaccount.com (--no-devpipe: 8c/10 does not run)"
    pc_plan_line SKIP "artifact retention policies (--no-devpipe: 8d/10 does not run)"
  else
    pc_plan_sa "pc-${PC_LP}${PC_TOK}build@" " (the CI build identity)"
  fi
  [ "$PC_NO_HISTORY" != 1 ] || pc_plan_line SKIP "BigQuery history archive (--no-history: 6c/10 does not run)"
  pc_plan_sec "$PC_SEC_SESSION" ""
  pc_plan_sec "$PC_SEC_CONFIRM" ""
  pc_plan_sec "$PC_SEC_CREDS" ""
  pc_plan_sec "$PC_SEC_BOOT" " (a NEW version is minted either way)"
  pc_plan_sec "$PC_MARK_SEC" " (records release $PC_RELEASE)"
  for _pc_b in "${PROJECT}-${PC_LP}${PC_TOK}datalake" "${PROJECT}-${PC_LP}${PC_TOK}source" "${PROJECT}-${PC_LP}${PC_TOK}exec-records"; do
    case "$PC_ADOPTABLE" in
      *"gs://$_pc_b"*) pc_plan_line ADOPT "bucket gs://$_pc_b" ;;
      *) pc_plan_line CREATE "bucket gs://$_pc_b" ;;
    esac
  done
  if [ -n "$PC_FS_SEEN" ]; then pc_plan_line ADOPT "Firestore database $PC_FS_SEEN"
  else pc_plan_line CREATE "Firestore database paracoding-${PC_LP}<12 hex, coined at 2/10>"; fi
  for _pc_k in "paracoding-${PC_LP}approvals" "paracoding-${PC_LP}vault"; do
    case "$PC_ADOPTABLE" in
      *" $_pc_k in "*) pc_plan_line ADOPT "KMS keyring $_pc_k in $REGION" ;;
      *) pc_plan_line CREATE "KMS keyring $_pc_k in $REGION" ;;
    esac
  done
  pc_plan_line NOTE "KMS keys ${PC_LP}approval-signing, ${PC_LP}vault-kem-xwing, ${PC_LP}vault-kem: created only where absent inside their keyrings (a key, once made, cannot be deleted by anyone)"
  _pc_t=$(gcloud pubsub topics list --project "$PROJECT" --format='value(name)' 2>/dev/null); _pc_rc=$?
  if [ "$_pc_rc" -ne 0 ]; then pc_plan_line UNKNOWN "Pub/Sub topic paracoding-${PC_LP}${PC_TOK}main-moved (listing failed; the run itself adopts-or-creates by name)"
  elif printf '%s\n' "$_pc_t" | sed 's#.*/##' | grep -qx "paracoding-${PC_LP}${PC_TOK}main-moved"; then pc_plan_line ADOPT "Pub/Sub topic paracoding-${PC_LP}${PC_TOK}main-moved"
  else pc_plan_line CREATE "Pub/Sub topic paracoding-${PC_LP}${PC_TOK}main-moved"; fi
  if gcloud artifacts repositories describe cloud-run-source-deploy --location="$REGION" --project "$PROJECT" >/dev/null 2>&1; then
    pc_plan_line ADOPT "Artifact Registry repo cloud-run-source-deploy in $REGION (shared with every lane in this project)"
  else
    pc_plan_line CREATE "Artifact Registry repo cloud-run-source-deploy in $REGION (Cloud Run makes it on first --source deploy)"
  fi
  echo ""
  echo "  AND, NOT LISTED ABOVE BECAUSE THEY ARE NOT NAMED RESOURCES: IAM bindings are"
  echo "  (re-)asserted on everything listed; environment variables are re-set on the three"
  echo "  services; the git seed at 8b/10 writes ONLY if branch main is empty."
  echo ""
  if [ "$PC_REHEARSE" = 1 ]; then
    echo "  --plan under --rehearse: stopping after the plan. Nothing was created."
    exit 0
  fi
  pc_drain_stdin
  printf '  type the word install to continue with exactly this plan; anything else stops here: '
  if read -r _pc_ans < "$PC_TTY" 2>/dev/null; then :; else _pc_ans=""; fi
  _pc_ans=$(printf '%s' "$_pc_ans" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  if [ "$_pc_ans" != install ]; then
    echo ""
    echo "  stopped at the plan. Nothing has been created; the only change this run made to"
    echo "  $PROJECT is that the 1/10 APIs are enabled, which creates no resource and bills"
    echo "  nothing."
    exit 0
  fi
fi

# WRITE THE MARKER BEFORE ANYTHING ELSE IS CREATED, so the next run can tell what happened
# here even if this one dies at the very next step. A failure to write it is FATAL rather
# than a warning: an install that cannot record which release it is leaves the next run
# with the unknown state this whole step exists to refuse.
# [SEC-MARKER-VERSION-V90] The marker records VERSION and COMMIT. It is rewritten whenever
# either changes, so a rebuilt release does not leave a stale commit behind.
PC_MARK_WANT="$PC_VERSION $PC_RELEASE"
if [ "$PC_MARK_STATE" != present ] || [ "$PC_MARK" != "$PC_MARK_WANT" ]; then
  if ! pc_has "$PC_MARK_SEC" "$PC_Q_SEC"; then
    # [SEC-INSTALL-TOKEN-V1] The minted token rides the create as the pc-suffix label, so
    # it is recorded by the same call that creates the discovery root: there is no window
    # in which tokenized resources exist and nothing records their token. A legacy or
    # bucket-adopting run has PC_TOK empty and creates the marker exactly as before.
    PC_MARK_LBL=""
    [ -z "$PC_TOK" ] || PC_MARK_LBL="--labels=pc-suffix=${PC_TOK%-}"
    retry gcloud secrets create "$PC_MARK_SEC" --replication-policy=automatic $PC_MARK_LBL --project "$PROJECT" >/dev/null || die "could not create the release marker secret $PC_MARK_SEC.
Every later step needs Secret Manager anyway -- 4/10 creates four more -- so this is the
first place that permission is exercised and the cheapest place to find it missing."
  fi
  printf '%s' "$PC_MARK_WANT" | gcloud secrets versions add "$PC_MARK_SEC" --data-file=- --project "$PROJECT" >/dev/null 2>&1 || die "could not record release $PC_MARK_WANT in $PC_MARK_SEC.
Refusing to continue unrecorded: the next run would then see live resources with no marker
and have to refuse, which is a worse place to leave this project than stopping here."
  echo "  recorded release $PC_MARK_WANT in $PC_MARK_SEC"
else
  echo "  re-run of the SAME build ($PC_MARK_WANT) -- the marker already says so"
fi
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
# [SEC-SINGLEPROJ-V2] THE ADOPTION PATTERN IS ANCHORED AT BOTH ENDS, AND THAT IS WHAT KEEPS
# TWO LANES APART. The old pattern was '^paracoding-' with no tail, so in a shared project a
# PROD install would happily adopt paracoding-dev-<hex> -- silently, printing a success line,
# and then serving prod traffic out of the dev database. The name this installer coins is
# exactly paracoding-${PC_LP}<12 lowercase hex>, so matching that whole shape (not a prefix of
# it) makes each lane adopt its own and no other. An unprefixed lane cannot match a prefixed
# name because [0-9a-f] does not match a hyphen.
FSDB=$(printf '%s\n' "$PC_FSLIST" | sed 's#.*/##' | grep -E "^paracoding-${PC_LP}[0-9a-f]{12}$" | head -1)
if [ -n "$FSDB" ]; then
  echo "  adopting the database this installer made earlier: $FSDB"
else
  FSDB="paracoding-${PC_LP}$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
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

# ------------------------------------------------------ [FLEET-MODE-V1] 2c/10: what this
# install is ALLOWED TO SPEND, written down once, in the one place that decides it.
#
# THE CONTROL PLANE FAILS CLOSED, AND THAT IS EXACTLY WHY THIS STEP HAS TO EXIST.
# index.ts resolves an absent, empty, wrong-cased, wrong-typed or unreadable
# config/models.fleet_mode to home, which makes no model call at all. That is the only
# correct direction for a value it could not READ -- and it would also mean a brand-new
# install answers its first chat message with a refusal instead of a sentence. Those two
# facts are not in tension: the fallback is what the CODE does with a value it cannot
# trust, and this step is the value. The default is DATA, written here, once.
#
# work: keyless Vertex on the service account created at 3/10, billed to this project.
# It is what the console chat and the memory embeddings already do -- there is no API key
# anywhere in this install and none is wanted -- so this writes down what is true rather
# than turning something on.
#
# CREATE-IF-ABSENT, NEVER OVERWRITE. An upgrade, a re-run, or an operator who chose home
# on purpose keeps what is there and this step says so. A re-run of an installer must not
# be able to switch spending back on.
#
# NON-FATAL, DELIBERATELY. If Firestore is not answering yet the install continues and
# the deployment simply starts in home: it refuses every model call and says which field
# to set. Dying here would trade a working deployment for a setting that takes ten
# seconds to write by hand.
say "2c/10 fleet mode (what this install is allowed to spend)"
PC_FM_TOK=$(gcloud auth print-access-token --project "$PROJECT" 2>/dev/null)
if [ -z "$PC_FM_TOK" ]; then
  echo "  NOTE: no access token, so fleet_mode was not written. This deployment starts in"
  echo "        home and makes no model call until you set it."
else
  PC_FM_PROJECT="$PROJECT" PC_FM_DB="$FSDB" PC_FM_AT="$PC_FM_TOK" python3 - <<'PCFLEETMODE'
import json, os, urllib.error, urllib.request

FS = ("https://firestore.googleapis.com/v1/projects/" + os.environ["PC_FM_PROJECT"]
      + "/databases/" + os.environ["PC_FM_DB"] + "/documents/config/models")
H = {"Authorization": "Bearer " + os.environ["PC_FM_AT"], "Content-Type": "application/json"}


def stop(why):
    print("  NOTE: %s, so fleet_mode was not written. This deployment starts in home and"
          % why)
    print("        makes no model call until you set it.")
    raise SystemExit(0)


def req(url, method="GET", body=None):
    r = urllib.request.Request(url, method=method, headers=H,
                               data=None if body is None else
                               json.dumps(body).encode("utf-8"))
    with urllib.request.urlopen(r, timeout=30) as f:
        return json.loads(f.read().decode("utf-8") or "{}")


try:
    cur = req(FS).get("fields", {})
except urllib.error.HTTPError as e:
    if e.code != 404:
        stop("config/models could not be read (HTTP %d)" % e.code)
    cur = {}                      # no document yet: the PATCH below creates it
except Exception as e:
    stop("config/models could not be read (%s)" % e.__class__.__name__)

have = cur.get("fleet_mode", {}).get("stringValue")
if have is not None:
    print("  fleet_mode is already %r -- left exactly as it is." % have)
    raise SystemExit(0)

try:
    req(FS + "?updateMask.fieldPaths=fleet_mode", "PATCH",
        {"fields": {"fleet_mode": {"stringValue": "work"}}})
except Exception as e:
    stop("fleet_mode could not be written (%s)" % e.__class__.__name__)
print("  fleet_mode = work   keyless Vertex on this deployment's own service account,")
print("                      billed to this project. API-key transports are REFUSED.")
PCFLEETMODE
fi
echo "  home  no model call of any kind    work  keyless Vertex only    dual  both"
echo "  It lives at Firestore config/models.fleet_mode. Changing it is a privileged"
echo "  write and goes through the approval gate; nothing in the deployment can raise it."

say "3/10 service accounts (two, least privilege)"
for pair in "pc-${PC_LP}${PC_TOK}control-plane:control plane" "pc-${PC_LP}${PC_TOK}gate-exec:gated executor"; do
  id="${pair%%:*}"; desc="${pair#*:}"
  gcloud iam service-accounts describe "${id}@${PROJECT}.iam.gserviceaccount.com" --project "$PROJECT" >/dev/null 2>&1 \
    || retry gcloud iam service-accounts create "$id" --display-name "$desc" --project "$PROJECT" >/dev/null
done
# [SEC-SINGLEPROJ-V2] READ THIS BEFORE PUTTING TWO LANES IN ONE PROJECT.
#
# Firestore IAM has NO per-collection granularity, and -- MEASURED 2026-08-11, not assumed --
# NO PER-DATABASE GRANULARITY EITHER. A Firestore database is not an IAM resource at all:
# firestore.googleapis.com answers :testIamPermissions on a database path with a hard 404 from
# Google's frontend, and parses :getIamPolicy as part of the database NAME rather than as a
# method. There is no per-database setIamPolicy to call, so there is no resource whose name an
# IAM condition could match. roles/datastore.user is therefore PROJECT-WIDE, necessarily, and
# no naming scheme and no condition expression changes that.
#
# WHAT THAT MEANS FOR LANES, PLAINLY: every service account holding roles/datastore.user in
# this project can read and write EVERY Firestore database in it, including another lane's.
# Lane-prefixed database names keep the two lanes from ADOPTING each other by accident -- they
# do not, and cannot, stop one lane's control plane from reading the other's pending_confirms,
# session_keys, journal or agent memory. If that is not acceptable for your data, the lanes
# need separate PROJECTS; this is the one boundary a shared project cannot give you.
#
# WHAT STILL HOLDS IN A SHARED PROJECT is approval INTEGRITY, and it holds because it never
# depended on Firestore permissions: approvals are signed ASYMMETRICALLY with the Cloud KMS
# key provisioned at 5b/10, that key is lane-namespaced (paracoding-${PC_LP}approvals), and
# KMS keys ARE IAM resources with real per-key bindings. So a job staged and approved in one
# lane produces a signature the other lane's verifier rejects. Reading across lanes is
# possible; forging an approval across them is not. That asymmetry is the design.
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$CP_SA" \
  --role=roles/datastore.user --condition=None >/dev/null
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$CP_SA" \
  --role=roles/logging.logWriter --condition=None >/dev/null
# [SEC-VERTEX-ENABLE-V1] roles/aiplatform.user TO THE CONTROL PLANE. ENABLING THE API WITHOUT
# THIS BINDING STILL 403s, so the two halves ship together or neither is worth shipping. All
# three Vertex call sites named at step 1/10 authenticate as THIS service account: harClaudePost()
# and harChatGemini() take their bearer from waAccessToken() (index.ts:2045) and memEmbed() from
# the same metadata endpoint (index.ts:717), and both read the instance DEFAULT identity, which
# is $CP_SA because step 6/10 deploys the control plane with --service-account "$CP_SA".
# Project-wide because a Vertex PUBLISHER model is not a resource an IAM condition can scope to.
# This is Googles standard predict-side role and it is NOT roles/aiplatform.admin.
# [SEC-VERTEXBIND-CHECK-V1] THE BANNER ABOVE SAYS THE TWO HALVES "SHIP TOGETHER OR NEITHER IS
# WORTH SHIPPING" AND ONLY ONE HALF WAS EVER VERIFIED. The API half is: 1/10 runs
# `retry gcloud services enable ... aiplatform.googleapis.com ... || die "could not enable APIs"`,
# so a failure there stops the install. THIS half had no status check at all, and there is no
# set -e, so a failed binding continued in silence. Nothing downstream would notice either:
# no self-test calls a chat path -- deliberately, because it would bill a model inference and
# depend on model availability in the adopter region -- so the first symptom is the operator's
# first chat message returning a 500 that names a 403 from Vertex.
#
# CHECKED IN BOTH DIRECTIONS RATHER THAN ONE. `|| die` catches a write that reported failure;
# the read-back catches a write that reported success and did not land, which is the same
# distinction 6/10 draws for DATA_LAKE_BUCKET. The read is one filtered get-iam-policy, not a
# loop, and an EMPTY answer is fatal: a policy read that returns nothing is exactly the state
# that would be misread as "the binding is fine".
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$CP_SA" \
  --role=roles/aiplatform.user --condition=None >/dev/null \
  || die "could not grant $CP_SA roles/aiplatform.user on $PROJECT. 1/10 enabled the Vertex
API and this is the other half of the same pair: with the API on and the role missing, every
chat message and every memory embedding returns 403 from Vertex, and nothing in this install
tests that path -- the first person to find it would be you, in the console."
PC_VXBIND=$(gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
  --filter="bindings.role=roles/aiplatform.user AND bindings.members:$CP_SA" \
  --format='value(bindings.members)' 2>/dev/null); PC_VXB_RC=$?
[ "$PC_VXB_RC" -eq 0 ] || die "could not read the project IAM policy back to confirm
roles/aiplatform.user on $CP_SA (exit $PC_VXB_RC). Refusing to record a grant this install
could not observe."
[ -n "$PC_VXBIND" ] || die "the binding of roles/aiplatform.user to $CP_SA is NOT in the
project policy after a write that reported success. Both Vertex chat paths and the embedding
path authenticate as that account, so the console would come up with a chat surface that
returns 403 on its first message."
echo "  $CP_SA -> roles/aiplatform.user (written AND read back off the project policy)"
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$GX_SA" \
  --role=roles/logging.logWriter --condition=None >/dev/null

# [PCGIT-ARCHIVE-V1] THE EXECUTOR MUST BE ABLE TO NAME ITSELF AS A BUILD IDENTITY, and
# without this one binding an agent-driven deploy dies on a message that names no fix.
# MEASURED 2026-08-14 on the operator's own prod: `gcloud builds submit` and
# `gcloud run deploy --source` BOTH failed with "caller does not have permission to act as
# service account <numeric id>" -- against the compute default, against the dedicated build
# identity, and against THE EXECUTOR ITSELF. iam.serviceAccounts.actAs is not implicit, not
# even for an account naming itself, and the numeric id in the error resolves to nothing a
# reader can act on.
#
# THIS BINDING WIDENS NOTHING, AND THE SENTENCE THAT USED TO FOLLOW IT WAS FALSE.
# It said "the executor already holds roles/cloudbuild.builds.builder below". IT DID NOT, and
# it never has. The only cloudbuild grant in this file is the one further down whose member is
# $BUILD_SA -- the COMPUTE DEFAULT account, a DIFFERENT PRINCIPAL. Every role this installer
# gave $GX_SA was enumerable and none of them could start a build, which is why the first
# agent-driven build on a fresh install died. The missing roles are granted
# immediately below this block. What THIS binding does is narrower and still needed: permission
# to say "run the build AS me". It is on the executor's OWN service account, so no second
# identity gains anything and no other principal is named. Deliberately NOT granted on the compute default
# account: that one is shared with everything else in the project, and actAs on it is a much
# wider capability than the deploy needs.
#
# WHY THE INSTALLER AND NOT A RUNBOOK: without it, the first time an adopter asks their agent
# to ship a change, it fails at the last step with an IAM error, and the fleet's own operator
# spent a session discovering that. An install that provisions a deploy path it cannot use is
# an install that is not finished.
retry gcloud iam service-accounts add-iam-policy-binding "$GX_SA" --project "$PROJECT" \
  --member="serviceAccount:$GX_SA" --role=roles/iam.serviceAccountUser --condition=None >/dev/null \
  || die "could not let $GX_SA act as itself (roles/iam.serviceAccountUser on its own account).
Without it, 'gcloud builds submit --service-account=$GX_SA' fails with 'caller does not have
permission to act as service account', and no agent-driven deploy can build an image."
echo "  $GX_SA -> roles/iam.serviceAccountUser ON ITSELF ONLY (so it can run a build as itself)"
# [GCP-BUILDIAM-GAP-V70] THE THREE ROLES THAT LET THE EXECUTOR ACTUALLY START A BUILD. Without
# them an adopter's first "build me something" fails and the message names no fix. MEASURED on a
# FRESH install, not on a long-lived project, verbatim: "ERROR: (gcloud.builds.submit)
# The user is forbidden from accessing the bucket [<project>_<region>_cloudbuild]. Please check
# your organization's policy or if the user has the serviceusage.services.use permission."
#
# WHY THIS SHIPPED BROKEN, because the shape recurs: the build path was proven on the fleet's
# OWN prod, where this account has accumulated grants by hand over months, and then generalised
# to adopters. A capability verified on the one hand-tuned project is NOT verified for anyone
# else. Nothing in this file had ever granted $GX_SA a cloudbuild role.
#
# WHAT EACH ONE IS FOR, so a reviewer can refuse any of them individually:
#   cloudbuild.builds.editor          create and read builds. builds.builder is NOT used here:
#                                     it is the role a build RUNS AS, and this account already
#                                     runs as itself via the serviceAccountUser binding above.
#   serviceusage.serviceUsageConsumer the permission the error above names by hand. Cloud Build
#                                     attributes quota to the calling project and refuses the
#                                     staging bucket without it.
#   artifactregistry.writer           push the image it just built. Read is implied; DELETE is
#                                     deliberately NOT granted, which is why a demo teardown
#                                     leaves the image behind and HAR_LAW_BUILD says so.
#
# NOT storage. A project-level storage role on this account is REFUSED by this installer's own
# read-back in step 7/10 -- it would cover the exec-records bucket and let the executor rewrite
# its own journal. The build's staging access is granted ON ONE BUCKET further down, and the
# shipped HAR_LAW_BUILD prompt pins --gcs-source-staging-dir to exactly that bucket so the two
# cannot drift apart. Do not "fix" a staging 403 by widening these to the project.
#
# Each is `retry` + `|| die` for the same reason every other grant in this step is: a grant
# that silently fails leaves an install that provisions a deploy path it cannot use.
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$GX_SA" \
  --role=roles/cloudbuild.builds.editor --condition=None >/dev/null \
  || die "could not grant $GX_SA roles/cloudbuild.builds.editor on $PROJECT. Without it no
agent on this install can build an image, and 'gcloud builds submit' fails at the staging step."
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$GX_SA" \
  --role=roles/serviceusage.serviceUsageConsumer --condition=None >/dev/null \
  || die "could not grant $GX_SA roles/serviceusage.serviceUsageConsumer on $PROJECT. This is
the permission Cloud Build names by hand when it refuses the source staging bucket."
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$GX_SA" \
  --role=roles/artifactregistry.writer --condition=None >/dev/null \
  || die "could not grant $GX_SA roles/artifactregistry.writer on $PROJECT. The build would
succeed and then fail to push the image it produced."
echo "  $GX_SA -> roles/cloudbuild.builds.editor, roles/serviceusage.serviceUsageConsumer,"
echo "    roles/artifactregistry.writer (so an agent on this install can build and push)"
# [GCP-RUN-DEPLOY-GRANT-V76] BUILD WITHOUT DEPLOY IS HALF A PRODUCT, AND THAT IS WHAT SHIPPED.
# MEASURED on a fresh v7.5 install: the image built and pushed perfectly, and the very next
# command answered "PERMISSION_DENIED: Permission 'run.services.get' (and 'run.services.create'
# / 'run.services.list') denied on resource 'namespaces/<project>'". Nothing in this installer
# had ever granted the executor a run.* role. The ONLY roles/run.developer below goes to the CI
# build identity in 8c/10 -- a DIFFERENT principal, scoped to the three paracoding services, a
# scope that cannot create a new service in any case.
#
# INVISIBLE ON A LONG-LIVED PROJECT, which is the third time that exact blindness has bitten
# this file: the fleet's own prod executor has held run rights for months, so the whole
# build-and-deploy path looked finished. Verify installer-dependent behaviour on a FRESH
# project or label it unverified.
#
# WHY admin AND NOT developer, decided by reading the roles rather than by their names:
# `gcloud iam roles describe` reports run.developer as run.services.{create,delete,get,list,
# update} and run.admin as THE SAME SET PLUS run.services.setIamPolicy. BOTH already carry
# delete and update, so developer does NOT protect this control plane from a strain that
# ignores its instructions -- the only thing the narrower role actually withholds is the
# ability to make a deployed service PUBLIC, which is the entire point of asking an agent to
# build you something you can open. Paying the product's core loop for protection it does not
# buy is the wrong trade.
#
# SAY THE BOUNDARY PLAINLY RATHER THAN IMPLYING ONE THAT DOES NOT EXIST: project-level is
# unavoidable, because "create" cannot be scoped to a service that does not exist yet. So this
# grant does let the executor modify or delete THIS CONTROL PLANE's own Cloud Run services. The
# shipped prompt forbids exactly that; nothing but the prompt enforces it. If that trade is
# unacceptable for a given deployment, remove this binding and deploy demo services by hand --
# the rest of the install is unaffected.
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$GX_SA" \
  --role=roles/run.admin --condition=None >/dev/null \
  || die "could not grant $GX_SA roles/run.admin on $PROJECT. Without it an agent on this
install can build a container image and then cannot deploy it -- 'gcloud run deploy' fails with
PERMISSION_DENIED on run.services.get/create/list."
echo "  $GX_SA -> roles/run.admin (deploy Cloud Run services, and make them public;"
echo "    project-level because 'create' cannot be scoped to a service that does not exist)"
# [SEC-EXEC-NO-DATASTORE-V1] THE DESTINATION THE NOTE ABOVE KEPT PROMISING, ARRIVED.
# [SEC-GENV21-V1-V6-V7] granted the executor roles/datastore.user here and said withholding
# it was still the right destination. It is withheld now, and this block REMOVES it rather
# than merely stopping granting it -- an installer that stops granting a role leaves every
# project that ever ran an older installer holding it forever, so the upgrade path would
# never actually retire the privilege on a single real deployment.
#
# WHAT PAID FOR IT, so nobody has to reconstruct the reasoning to review this line. The three
# things that needed the grant were the single-use claim, the result and the executor's own
# journal; all three are objects in the exec-records bucket as of [SEC-EXECBUCKET-V1], where
# the executor holds objectCreator and cannot read back what it wrote. The fourth thing --
# READING the approval it is about to run -- is gone too: the approval now travels in the
# request body, and the fields that decide what runs are inside the PC-APPROVAL-CANON-V2
# signed bytes, so relaying them cannot redirect a job, only invalidate it.
#
# NOT `retry`, DELIBERATELY. retry() classifies NOT_FOUND as retryable, and on a fresh
# install -- or on any second run of this installer -- there is no binding to remove and
# NOT_FOUND is the CORRECT answer. Wrapping it in retry would spend nine backoffs and 225
# seconds arriving at the state it already had. The remove is best-effort; the READ-BACK
# below is the authority, exactly as it is for the exec bucket in 6/10.
gcloud projects remove-iam-policy-binding "$PROJECT" --member="serviceAccount:$GX_SA" \
  --role=roles/datastore.user --condition=None >/dev/null 2>&1 || true
# THE READ-BACK IS THE POINT, AND IT IS AN ABSENCE ASSERTION SO IT CANNOT BE SATISFIED BY A
# RENAME OR BY A SECOND ROLE. It does not ask "did the remove succeed?" -- a remove can report
# success and a different datastore role can still be bound by another path. It asks whether
# this account holds ANY roles/datastore.* role on this project, and dies on any answer that
# is not empty. A future edit that adds one back fails the install here rather than shipping.
#
# roles/datastore.* AND NOT roles/datastore.user: datastore.owner, datastore.importExportAdmin
# and datastore.viewer would each hand back some or all of the same access under a name this
# check would otherwise pass. Firestore IAM has no per-collection granularity, so ANY of them
# is project-wide read over every document the control plane writes, including the approvals
# this executor is supposed to be unable to forge.
PC_GXDS=$(gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:$GX_SA AND bindings.role:roles/datastore" \
  --format='value(bindings.members,bindings.role)' 2>/dev/null); PC_GXDS_RC=$?
[ "$PC_GXDS_RC" -eq 0 ] || die "could not read the project IAM policy back to confirm that
$GX_SA holds NO Firestore role (exit $PC_GXDS_RC). Refusing to record an absence this install
could not observe."
# A TOMBSTONE IS NOT A GRANT, AND THIS ASSERTION USED TO FAIL ON GHOSTS. gcloud's `:` filter
# operator is a SUBSTRING match, and a deleted service account survives in the policy as
# `deleted:serviceAccount:<email>?uid=<n>` -- which CONTAINS the live member string and so
# matches it. A project accumulates one tombstone per install/uninstall cycle, so this check
# eventually refuses every re-install. MEASURED in paracoding-ai-dev on the first real
# end-to-end test: roles/datastore.user carried SEVEN deleted pc-gate-exec members and NOT ONE
# live one, and the install died here. The remediation printed below could not have cleared it
# either -- remove-iam-policy-binding --member=serviceAccount:<email> names the LIVE member,
# which was not on the role. A deleted account grants nothing, and a re-created one carries a
# NEW uid, so a tombstone can never reattach. Drop them before judging, and keep asserting on
# what is left.
PC_GXDS=$(printf '%s\n' "$PC_GXDS" | grep -v '^deleted:' | awk '{print $2}' | tr -d '[:space:]')
[ -z "$PC_GXDS" ] || die "$GX_SA still holds the Firestore role(s):
$PC_GXDS
This installer removes roles/datastore.user from the executor and then asserts it is gone.
Firestore IAM cannot scope a grant to one collection, so ANY datastore role here is read AND
possibly write over every document in every collection -- including the pending_confirms
approvals the executor must not be able to manufacture, and its own journal rows, which it
must not be able to edit. The executor does not need it: the claim, the result and the
journal are objects in the exec-records bucket 6/10 creates, and the approval it runs arrives
in the request body inside signed bytes it cannot forge. Remove the binding
    gcloud projects remove-iam-policy-binding $PROJECT \\
      --member=serviceAccount:$GX_SA --role=<the role above> --condition=None
and re-run. DO NOT re-add it to this script to make the install pass."
echo "  $GX_SA -> NO Firestore role (removed, and read back off the project policy as ABSENT)"

# [SEC-INSTALL-DEV-V1] THE BUILD IDENTITY. `run deploy --source` builds via Cloud Build, which runs as the
# COMPUTE DEFAULT service account. Google no longer auto-grants Editor to it on new projects, so
# it cannot read the source zip Cloud Run just uploaded and step 6 dies with a bare 403. Measured
# on a clean project 2026-08-03.
PROJNUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null)
[ -n "$PROJNUM" ] || die "could not read the project number"
BUILD_SA="serviceAccount:${PROJNUM}-compute@developer.gserviceaccount.com"
# [PCGIT-ARCHIVE-V1] WHO MAY FETCH THE SOURCE TREE FROM GET /git/archive. Both build
# identities are named because which one a build actually runs as depends on the project's
# age and on whether a service account was passed to `gcloud builds submit`: newer projects
# default to the compute account, older ones to the cloudbuild account. Naming one and
# guessing wrong produces a 401 whose cause is invisible from the build log, so both are
# allowlisted and IAM remains the thing that decides who can start a build at all.
# This is an ALLOWLIST, not a grant: the endpoint fails closed when it is empty.
# NOT NAMED PC_BUILD_SA, AND THAT IS THE SECOND ATTEMPT. This variable was called
# PC_BUILD_SA for one commit, which COLLIDES with the CI build identity of the same
# name assigned far below in step 9. Both are shell globals in one script, so the
# later assignment silently wins for anything that reads it after that point and the
# two meanings are indistinguishable at the use site. Caught by grepping the name
# before landing rather than by a failure, which is luck; the rename is the fix.
PC_ARCHIVE_SA_ALLOW="${PROJNUM}-compute@developer.gserviceaccount.com,${PROJNUM}@cloudbuild.gserviceaccount.com"
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
# [SEC-SINGLEPROJ-V2] THIS GRANT USED TO BE PROJECT-WIDE AND IT IS THE HOLE THAT MATTERED.
# roles/storage.objectViewer at PROJECT level let the build identity read EVERY bucket in the
# project -- including the data lake, which holds agent memory, the wiki and the git object
# store. In a one-project two-lane layout that is a dev builder reading prod's repository, and
# no amount of careful naming anywhere else closes it.
#
# WHAT THE BUILD IDENTITY ACTUALLY NEEDS is one bucket: the source zip `run deploy --source`
# uploads. So it is created HERE, by name, before anything needs it, and the grant is scoped to
# it. `run deploy --source` reuses a staging bucket of exactly this name when one already
# exists, so pre-creating it changes nothing about the deploy except who can read it.
#
# MEASURED, NOT ASSUMED: a resource-scoped storage grant really does bite. In a scratch
# project on 2026-08-11, one principal was given roles/storage.objectViewer on ONE bucket
# under an IAM condition matching one object prefix; a Cloud Build running as that principal
# then read the matching object (HTTP 200) and was refused the non-matching one (HTTP 403) in
# the same run, and both went back to 403 when the binding was removed. Scoping is real.
PC_STAGE_BUCKET="run-sources-${PROJECT}-${REGION}"
if ! gcloud storage buckets describe "gs://$PC_STAGE_BUCKET" --project "$PROJECT" >/dev/null 2>&1; then
  retry gcloud storage buckets create "gs://$PC_STAGE_BUCKET" --project "$PROJECT" \
    --location="$REGION" --uniform-bucket-level-access --public-access-prevention >/dev/null || true
fi
gcloud storage buckets describe "gs://$PC_STAGE_BUCKET" --project "$PROJECT" >/dev/null 2>&1 \
  || die "could not create or read the Cloud Run source staging bucket
gs://$PC_STAGE_BUCKET. The build identity needs read on it and this installer refuses to fall
back to a PROJECT-WIDE storage grant, because that would let the build identity read the data
lake and the git object store as well. Create the bucket in $REGION yourself and re-run."
retry gcloud storage buckets add-iam-policy-binding "gs://$PC_STAGE_BUCKET" --project "$PROJECT" \
  --member="$BUILD_SA" --role=roles/storage.objectViewer --condition=None >/dev/null \
  || die "could not grant the build identity read on gs://$PC_STAGE_BUCKET"
# Cloud Build stages some sources in <project>_cloudbuild. It is created by Cloud Build itself,
# so it is granted only when it is already there -- never created, and never a reason to fail.
if gcloud storage buckets describe "gs://${PROJECT}_cloudbuild" --project "$PROJECT" >/dev/null 2>&1; then
  retry gcloud storage buckets add-iam-policy-binding "gs://${PROJECT}_cloudbuild" --project "$PROJECT" \
    --member="$BUILD_SA" --role=roles/storage.objectViewer --condition=None >/dev/null || true
fi
# [GCP-BUILDIAM-GAP-V70] THE EXECUTOR NEEDS WRITE ON THIS SAME BUCKET, AND THE PROMPT PINS IT
# THERE SO THE TWO CANNOT DRIFT. `gcloud builds submit` uploads the source tarball AS THE
# CALLER, and on this install the caller is $GX_SA, not the build identity -- objectViewer above
# is for the account the build RUNS AS and does not help the account that SUBMITS it.
#
# WHY objectAdmin AND NOT objectCreator: submit writes the tarball, re-reads it to confirm, and
# overwrites the same key on a re-run. objectCreator alone turns a second build of the same
# source into a 403, which reads as an auth failure and is a create-only bucket.
#
# THE BUCKET IS NOT THE ONE CLOUD BUILD WOULD PICK BY ITSELF, AND THAT IS THE POINT. With
# --default-buckets-behavior=regional-user-owned-bucket -- which the shipped HAR_LAW_BUILD
# prompt requires -- Cloud Build stages into gs://<project>_<region>_cloudbuild, a name this
# installer does not create, cannot predict a region change of, and would have to grant on a
# bucket that does not exist until the first build makes it. So HAR_LAW_BUILD instead pins
# --gcs-source-staging-dir=gs://$PC_STAGE_BUCKET/builds: a bucket THIS INSTALLER CREATES, owns,
# and has just granted on. Both halves must move together -- if you change this bucket name,
# change the prompt in control-plane/src/index.ts, and the reverse.
retry gcloud storage buckets add-iam-policy-binding "gs://$PC_STAGE_BUCKET" --project "$PROJECT" \
  --member="serviceAccount:$GX_SA" --role=roles/storage.objectAdmin --condition=None >/dev/null \
  || die "could not grant $GX_SA write on gs://$PC_STAGE_BUCKET. That bucket is where the
shipped build prompt tells every agent to stage its source, so no agent-driven build can start."
# [GCP-BUILDSUBMIT-BUCKETGET-V74] objectAdmin IS NOT ENOUGH, AND THE ERROR THAT PROVES IT NAMES
# THE WRONG PERMISSION. MEASURED on a fresh v7.3 install: with objectAdmin above in place,
# `gcloud storage cp` to this bucket SUCCEEDED and `gcloud storage ls gs://<bucket>/services/`
# SUCCEEDED -- but `gcloud builds submit` still died with "The user is forbidden from accessing
# the bucket [<bucket>]. Please check ... if the user has the serviceusage.services.use
# permission." THAT SUGGESTION IS A RED HERRING: this installer already grants
# roles/serviceusage.serviceUsageConsumer, which MEASURABLY contains serviceusage.services.use.
#
# THE ACTUAL MISSING PERMISSION IS storage.buckets.get. MEASURED with `gcloud iam roles describe`:
# roles/storage.objectAdmin contains storage.objects.{create,get,list,createContext,getIamPolicy}
# and NO buckets.* permission at all, while roles/storage.legacyBucketReader contains exactly
# storage.buckets.get and storage.objects.list. `builds submit` STATS the staging bucket before
# uploading to it; objects permissions do not let you stat the container that holds them, and
# gcloud reports that stat failure with a message about quota attribution.
#
# legacyBucketReader AND NOT storage.admin: the job needs to READ the bucket's metadata, not to
# reconfigure or delete it. Still scoped to this ONE bucket, so 7/10's read-back -- which refuses
# the install if $GX_SA holds ANY project-level storage role -- is unaffected.
retry gcloud storage buckets add-iam-policy-binding "gs://$PC_STAGE_BUCKET" --project "$PROJECT" \
  --member="serviceAccount:$GX_SA" --role=roles/storage.legacyBucketReader --condition=None >/dev/null \
  || die "could not grant $GX_SA storage.buckets.get on gs://$PC_STAGE_BUCKET (via
roles/storage.legacyBucketReader). Without it 'gcloud builds submit' refuses the staging bucket
with a message that blames serviceusage.services.use, which is NOT the missing permission."
echo "  $GX_SA -> + roles/storage.legacyBucketReader on that bucket (storage.buckets.get, which"
echo "    objectAdmin does NOT include and 'gcloud builds submit' requires to stat the bucket)"
echo "  $GX_SA -> roles/storage.objectAdmin on gs://$PC_STAGE_BUCKET ONLY (build staging;"
echo "    NOT project-wide -- 7/10 refuses this install if it ever becomes project-wide)"
echo "  $BUILD_SA -> roles/storage.objectViewer on THE STAGING BUCKET ONLY, not the project"
if [ -n "$PC_LANE" ]; then
  echo
  echo "  LANE '$PC_LANE' -- ONE LIMITATION YOU MUST KNOW ABOUT:"
  echo "  Firestore has no per-database IAM. roles/datastore.user is project-wide, so this"
  echo "  lane's control plane CAN read the other lane's Firestore data, and the other's can"
  echo "  read this one's. Lane names stop accidental adoption, not deliberate reads."
  echo "  Approval SIGNING is separated properly: this lane signs with its own KMS key."
  echo "  If cross-lane reads are unacceptable for your data, use separate projects."
  echo
fi
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
# [SEC-EXEC-NO-DATASTORE-V1] roles/datastore.user IS NO LONGER REQUIRED AND IS NO LONGER
# HELD, so the three lines that printed it as a real limitation are replaced rather than
# quietly deleted. A banner that stops mentioning a privilege reads identically whether the
# privilege went away or the sentence did, and this fleet has been burned by exactly that.
# The @firestore.transactional claim is gone, the journal and the result are objects, and the
# approval arrives in the request body under a signature this account cannot produce.
echo "     Holds NO Firestore role at all -- roles/datastore.user is REMOVED by this"
echo "     installer and its absence is read back off the project policy. The executor"
echo "     cannot read the approval it runs from the database; it is handed the approval"
echo "     in the request, and every field that decides WHAT runs is inside signed bytes."
echo "     It holds NO approval signing secret. Approvals are signed by the control plane"
echo "     with a Cloud KMS PRIVATE key the executor has no permission to use; the executor"
echo "     is given roles/cloudkms.publicKeyViewer only, so it can VERIFY and cannot FORGE."
echo "     What a compromised executor can still do: refuse a job you approved, or corrupt"
echo "     the database record of one. What it cannot do: manufacture an approval you"
echo "     never gave. That is the boundary, stated exactly."

say "4/10 secrets (generated here, create-if-absent, never rotated by a re-run)"
# [SEC-MKSECRET-CHECK-V1] THIS HELPER PRINTED "created" NO MATTER WHAT HAPPENED, and it made
# two different failures look identical to a success. Compare the pc-webauthn-creds block a few
# lines below, which has always captured the create status and died on it -- this one is now
# the same shape, and the shape is the point.
#
#   1. THE CREATE STATUS WAS DISCARDED. `retry` returns the command status and nothing read it,
#      and there is no set -e, so a refused create printed "created" and the install continued
#      to 6/10, where --set-secrets names a secret that does not exist and the deploy fails with
#      "console deploy failed" -- a message blaming a step that did nothing wrong.
#   2. THE GENERATED VALUE WAS NEVER CHECKED TO EXIST. An adopter who unpacked this release into
#      a read-only directory -- or onto a full disk -- gets a redirection that fails, an empty
#      or absent temp file, and a secret created holding NOTHING. That one is worse than a
#      failed install: the session secret and the human-confirm secret would both be empty
#      strings, silently, on a deployment that called itself complete.
#
# THE STALE-FILE CASE IS CLOSED TOO. Checking only that the file is non-empty would pass on a
# leftover from an earlier run, so the file is removed FIRST and both the write status and the
# result are checked. Nothing here trusts a command it did not read the status of.
#
# THE TWO CHECKS COVER DIFFERENT FAILURES AND NEITHER IS REDUNDANT -- MEASURED, because the
# division is not obvious. A shell pipeline reports the status of its LAST command, which here
# is tr, so `openssl` exiting non-zero leaves the status at 0 and only the EMPTINESS check
# catches it. A redirection that cannot be created fails the whole pipeline and gives status 1,
# which only the STATUS check catches, and it catches it before the emptiness check can be
# confused by a file that was never opened. Both were exercised: openssl forced to exit 3 gave
# status 0 and was caught as EMPTY; an unwritable target directory gave status 1 and was caught
# as a write failure naming the directory.
mk() {
  gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1 && { echo "  $1 exists, left alone"; return; }
  rm -f "$HERE/.s.tmp"
  PC_MK_RC=0
  openssl rand -base64 32 | tr -d '\n' > "$HERE/.s.tmp" || PC_MK_RC=$?
  [ "$PC_MK_RC" -eq 0 ] || die "could not generate the value for secret $1 (exit $PC_MK_RC).
The generator writes to $HERE/.s.tmp, so the usual cause is that the directory this release was
unpacked into is not writable, or the disk is full. Fix that and re-run: nothing was created."
  [ -s "$HERE/.s.tmp" ] || die "the generated value for secret $1 is EMPTY.
Refusing to create a secret holding nothing. WA_SESSION_SECRET is made this way, and an
empty one is not a weak secret, it is no secret at all -- and it would have been invisible
until somebody looked."
  PC_MK_RC=0
  retry gcloud secrets create "$1" --replication-policy=automatic --data-file="$HERE/.s.tmp" --project "$PROJECT" >/dev/null || PC_MK_RC=$?
  python3 -c "import os;os.remove('$HERE/.s.tmp')"
  [ "$PC_MK_RC" -eq 0 ] || die "could not create the secret $1 (exit $PC_MK_RC).
6/10 deploys both services with --set-secrets naming it, so leaving it absent produces a
'console deploy failed' twenty minutes from now that blames the deploy for this."
  echo "  $1 created"
}
mk "$PC_SEC_SESSION"
# [SEC-LEGACY-CONFIRM-RETIRE-V1] pc-${PC_LP}human-confirm-secret IS NO LONGER CREATED, AND ITS
# ACCESSOR GRANT IS NO LONGER MADE. The only thing that ever read HUMAN_CONFIRM_SECRET was
# POST /api/confirm/verify -- a shared-bearer approval route with no passkey and no danger
# checks, which could not execute anything anyway because it called the private executor with
# no Authorization header. That route and humanTokenOk() are deleted from control-plane/src/
# index.ts, so creating this secret would provision a credential nothing reads.
# PC_SEC_CONFIRM ITSELF IS DELIBERATELY STILL DEFINED ABOVE and still matched by the inventory
# in 1b/10: an install made by an EARLIER release holds this secret, and it must keep being
# recognised as OURS rather than reported as a stranger's resource. uninstall.sh still deletes
# it for exactly the same reason. We stop MAKING it; we do not stop CLEANING IT UP.
for S in "$PC_SEC_SESSION"; do
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
if gcloud secrets describe "$PC_SEC_CREDS" --project "$PROJECT" >/dev/null 2>&1; then
  echo "  $PC_SEC_CREDS exists, left alone"
else
  printf '{}' > "$HERE/.c.tmp"
  PC_CS_RC=0
  retry gcloud secrets create "$PC_SEC_CREDS" --replication-policy=automatic \
    --data-file="$HERE/.c.tmp" --project "$PROJECT" >/dev/null || PC_CS_RC=$?
  python3 -c "import os;os.remove('$HERE/.c.tmp')"
  [ "$PC_CS_RC" -eq 0 ] || die "could not create the secret $PC_SEC_CREDS (exit $PC_CS_RC).
Step 7/10 names it in PC_CREDS_SECRET on the executor, so leaving it absent ships a deployment
whose independent approval check can never be armed."
  echo "  $PC_SEC_CREDS created (empty enrolment, {})"
fi
retry gcloud secrets add-iam-policy-binding "$PC_SEC_CREDS" --member="serviceAccount:$GX_SA" \
  --role=roles/secretmanager.secretAccessor --project "$PROJECT" >/dev/null \
  || die "could not grant $GX_SA secretAccessor on $PC_SEC_CREDS. The executor is the ONLY
service that may read it -- deliberately not the control plane, which could otherwise enrol its
own key and then forge assertions against itself."
echo "  $PC_SEC_CREDS -> $GX_SA (secretAccessor, THAT SECRET ONLY; the control plane is"
echo "  not granted it, which is what makes verification in the executor mean anything)"
echo "  It starts EMPTY. That is why 7/10 still ships PC_REQUIRE_ASSERTION=0: arming the"
echo "  assertion check before a credential is enrolled refuses every approval."

# [GH-TOKEN-PROVISION-V1] THE GITHUB TOKEN SLOT, CREATED EMPTY AND GRANTED HERE SO THE CONSOLE
# PANEL WORKS THE FIRST TIME IT IS OPENED. Found the hard way on a live install: the Settings
# panel verified a perfectly good token against GitHub and then failed to store it, because
# writing a secret NAME THIS INSTALL HAD NEVER CREATED needs secrets.create, and the control
# plane had only ever been granted read on the secrets this script makes. The operator got
# "could not write the token to Secret Manager" and it took a diagnostic job to find out why.
# Every adopter would have hit the same wall with nobody to diagnose it.
#
# THE GRANT IS ON THIS SECRET ONLY -- NOT PROJECT-WIDE secrets.create, WHICH WAS THE OBVIOUS
# ALTERNATIVE AND IS THE WRONG ONE. Project-level create would let the control plane make (and
# therefore own) any secret name in the project, which is precisely the blast radius the
# operator asked to keep closed: "make sure it can not over write an existing x-wing key ... to
# prevent some future attack using that to overwrite the data lake key locking me out of my own
# data". Per-secret bindings mean the widened credential reaches exactly one name. A second
# identity is one command, printed below, rather than a standing power to create anything.
#
# CREATED WITH AN EMPTY PAYLOAD, like the enrolment secret above: the tools read "no version" as
# "no token stored yet" and say so. An empty slot is an honest state; a missing secret is an error
# nobody can act on.
if gcloud secrets describe "${PC_GH_SEC_PREFIX}default" --project "$PROJECT" >/dev/null 2>&1; then
  echo "  ${PC_GH_SEC_PREFIX}default exists, left alone"
else
  : > "$HERE/.g.tmp"
  PC_GH_RC=0
  retry gcloud secrets create "${PC_GH_SEC_PREFIX}default" --replication-policy=automatic \
    --data-file="$HERE/.g.tmp" --project "$PROJECT" >/dev/null || PC_GH_RC=$?
  rm -f "$HERE/.g.tmp"
  if [ "$PC_GH_RC" -ne 0 ]; then
    pc_ws_warn "could not create ${PC_GH_SEC_PREFIX}default (exit $PC_GH_RC). The install is FINE
and nothing else depends on it -- the GitHub tools simply have nowhere to store a token, and the
console will say so when you try. Create it and grant it later with the two commands printed at
the end of this step."
  else
    echo "  ${PC_GH_SEC_PREFIX}default created (empty -- no token stored yet)"
  fi
fi
retry gcloud secrets add-iam-policy-binding "${PC_GH_SEC_PREFIX}default" --member="serviceAccount:$CP_SA" \
  --role=roles/secretmanager.secretAccessor --project "$PROJECT" >/dev/null 2>&1 \
  || pc_ws_warn "could not grant $CP_SA secretAccessor on ${PC_GH_SEC_PREFIX}default; the GitHub
tools will refuse with that reason until it is granted."
retry gcloud secrets add-iam-policy-binding "${PC_GH_SEC_PREFIX}default" --member="serviceAccount:$CP_SA" \
  --role=roles/secretmanager.secretVersionAdder --project "$PROJECT" >/dev/null 2>&1 \
  || pc_ws_warn "could not grant $CP_SA secretVersionAdder on ${PC_GH_SEC_PREFIX}default; the
console will verify a token against GitHub and then fail to store it."
echo "  ${PC_GH_SEC_PREFIX}default -> $CP_SA (secretAccessor + secretVersionAdder, THAT SECRET"
echo "  ONLY -- not project-wide secrets.create, so this grant can never reach another key)"
echo "  Paste a token at the console: Settings -> API keys -> GitHub. For a SECOND identity"
echo "  (a work account beside a personal one), create its slot the same way:"
echo "      gcloud secrets create ${PC_GH_SEC_PREFIX}<identity> --replication-policy=automatic --project $PROJECT"
echo "      gcloud secrets add-iam-policy-binding ${PC_GH_SEC_PREFIX}<identity> --member=serviceAccount:$CP_SA --role=roles/secretmanager.secretAccessor --project $PROJECT"
echo "      gcloud secrets add-iam-policy-binding ${PC_GH_SEC_PREFIX}<identity> --member=serviceAccount:$CP_SA --role=roles/secretmanager.secretVersionAdder --project $PROJECT"
# [SEC-MACFREE-INSTALL-V1] pc-approval-mac-key IS NOT CREATED AND NOT GRANTED HERE AT ALL.
# It used to be created and handed to both services, and the grant to $GX_SA is precisely
# what made the executor a signing oracle for its own approvals. gate-exec has read no
# APPROVAL_MAC_KEY since Stage C, so on a fresh install that secret verified nothing on
# either side -- an unused credential carrying rotation burden and no purpose. A fresh
# install therefore provisions no symmetric approval key at all, and approval integrity
# rests entirely on the Cloud KMS asymmetric signature provisioned in step 5b/10.
#
# [SEC-SECRETS-DECLARED-V1] STEP 6/10 NOW USES --set-secrets, AND THAT IS WHAT RETIRES THIS.
# It used to use --update-secrets, which adds and updates the keys it names and does NOT
# remove a binding it does not name. So a service an older installer deployed kept an
# APPROVAL_MAC_KEY=pc-approval-mac-key binding forever -- a secret a fresh install no longer
# creates and no longer grants. The next deploy was then REFUSED outright, on a secret
# NOTHING READS, and the operator had to run --remove-secrets by hand to get past it.
# --set-secrets is a DECLARED SET: it removes every binding it does not name, so the stale
# reference is gone on the first re-run instead of being carried forward for ever.
#
# WHY REMOVING IT IS SAFE, CHECKED AND NOT ASSUMED. index.ts reads the key into
# `const _macKey = process.env.APPROVAL_MAC_KEY || ''` and writes the legacy HMAC only
# `if (_macKey)`; with no key the KMS signature is written alone and nothing throws. gate-exec
# contains ZERO occurrences of APPROVAL_MAC_KEY or approval_mac, so nothing verifies it. An
# existing deployment therefore loses an unread field, not a control.
#
# THE DECLARED SET IS COMPLETE, and that is why this was safe to change at all: step 6/10 is
# the ONLY place either service is given a secret, WA_BOOTSTRAP_SECRET is mounted at 9/10 --
# AFTER this deploy -- and removed again at the end of the same step, and every other
# credential index.ts uses (chat-key-claude, chat-key-gemini) is read from Secret Manager AT
# RUNTIME by the app rather than mounted on the revision. Env vars were already declared this
# way (--set-env-vars, right above), so this makes the two halves of the revision consistent.
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
# [SEC-EXEC-NO-DATASTORE-V1] AND THAT REHEARSAL NOW PRODUCES AN EXECUTOR THAT REFUSES EVERY
# JOB, said plainly at 7/10 rather than discovered on the first approval. Unprovisioned
# signing means APPROVAL_REQUIRE_SIGNED unset means pc_arming_refusal() refuses -- which is
# the correct end state for a deployment with no way to sign, and is why the rehearsal
# allowance survives this change instead of being closed with it. A rehearsal proves the
# install runs; it was never a deployment that executes anything.
PC_KMS_KR=paracoding-${PC_LP}approvals
PC_KMS_KEY=${PC_LP}approval-signing
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
  # [SEC-EXEC-NO-DATASTORE-V1] A HAND-PINNED KEY STILL ARMS THE REQUIREMENT. This branch used
  # to leave APPROVAL_REQUIRE_SIGNED to the operator, which was correct while an unsigned
  # approval was still pinned by approved_sha256 read off a document the executor could not
  # write. The executor does not read that document any more, so an unarmed executor is an
  # executor that refuses every job. An operator who pinned a key intends to use it; the
  # requirement is armed by default here and PC_APPROVAL_REQUIRE_SIGNED=0 still overrides,
  # into a rehearsal-only state that 9/10 then refuses to leave silently.
  PC_SIG_REQUIRE=1
  echo "  APPROVAL_REQUIRE_SIGNED will be ARMED: the executor refuses every job without it."
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
# index.ts  const DATA_LAKE_BUCKET = process.env.DATA_LAKE_BUCKET || ''
# index.ts  const lake = DATA_LAKE_BUCKET ? getStorage().bucket(DATA_LAKE_BUCKET) : null
# LAKE_BUCKET EXISTS TOO AND THE FOUR TOOLS NEVER READ IT. It only feeds PC_LAKE, the constant
# the vault and git-object paths resolve through. Precedence is DATA_LAKE_BUCKET, then
# LAKE_BUCKET, and THERE IS NO THIRD RUNG -- setting LAKE_BUCKET alone would leave every lake
# tool dead while looking configured. This step sets the FIRST rung.
#
# [SEC-LAKE-NOGUESS-V1] THERE USED TO BE A THIRD RUNG AND IT WAS A CROSS-LANE WRITE WAITING TO
# HAPPEN. PC_LAKE fell back to "<project>-datalake" built from GCP_PROJECT, so a service
# redeployed WITHOUT this variable did not fail -- it resolved to a plausible bucket and used
# it. Two lanes installed into ONE project share GCP_PROJECT, so the guess named the OTHER
# lane's lake and the write succeeded. The fallback is GONE: an unset bucket now throws
# LAKE_BUCKET_UNCONFIGURED on every lake call, and index.ts logs the condition at boot. THAT IS
# WHY THIS STEP IS NOT OPTIONAL -- nothing downstream will guess the name for you.
#
# THE NAME IS STILL DERIVED FROM THE PROJECT *HERE*, IN THE INSTALLER, WHICH IS A DIFFERENT
# THING FROM deriving it at runtime: a re-run ADOPTS the same bucket instead of making a second
# lake, and the value is written onto both services explicitly and then READ BACK OFF THE
# SERVING REVISION at 7/10, so a deploy that dropped it fails the install instead of passing.
PC_LAKE_BUCKET="${PROJECT}-${PC_LP}${PC_TOK}datalake"
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
#
# --no-versioning IS ASSERTED, NOT MERELY OMITTED, AND THAT DISTINCTION IS THE POINT. Leaving the
# flag out only stops this installer turning versioning ON; it does nothing to a bucket that
# already has it, which is exactly the adopted bucket this block exists for. Suspending it is not
# destructive -- generations already retained stay retained -- so this changes what happens NEXT
# and touches nothing that exists.
retry gcloud storage buckets update "gs://$PC_LAKE_BUCKET" --project "$PROJECT" \
  --uniform-bucket-level-access --public-access-prevention --no-versioning >/dev/null \
  || die "could not enforce uniform bucket-level access, public access prevention and
no-versioning on gs://$PC_LAKE_BUCKET. Refusing to point the control plane at a lake whose
access model is unknown."
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
# [SEC-SOURCE-BUCKET-V1] THE SECOND BUCKET, AND IT IS NOT OPTIONAL PLUMBING. The 7 git tools
# (git_read, git_list, git_log, git_diff, git_propose, git_propose_patch, git_push) store their
# objects in a bucket named by GIT_BUCKET, and until now this installer created NO such bucket.
# Adopters hand-created one and ran about five commands before git worked at all. It is made
# HERE, beside the lake, because the two are one storage step and separating them is what caused
# the omission to go unnoticed.
#
# NO OBJECT VERSIONING, HERE OR ON THE LAKE. Every object this system writes to either bucket is
# a PCV1 envelope, so a retained noncurrent generation is ciphertext, not a backup -- unreadable
# once the vault epoch moves, and billed for as long as it sits there. It buys nothing on a git
# object store in particular, because blobs are content-addressed: a write either creates a name
# that did not exist or rewrites a name with the identical bytes, so there is no prior version
# worth keeping. History is what git holds, and git holds it in the objects themselves. Public
# access prevention is ENFORCED and uniform bucket-level access is on, as standing policy.
PC_SOURCE_BUCKET="${PROJECT}-${PC_LP}${PC_TOK}source"
if gcloud storage buckets describe "gs://$PC_SOURCE_BUCKET" --project "$PROJECT" >/dev/null 2>&1; then
  echo "  adopting gs://$PC_SOURCE_BUCKET"
else
  PC_SB_RC=0
  retry gcloud storage buckets create "gs://$PC_SOURCE_BUCKET" --project "$PROJECT" \
    --location="$REGION" --uniform-bucket-level-access --public-access-prevention >/dev/null \
    || PC_SB_RC=$?
  gcloud storage buckets describe "gs://$PC_SOURCE_BUCKET" --project "$PROJECT" >/dev/null 2>&1 \
    || die "the source/git bucket gs://$PC_SOURCE_BUCKET is still absent after a create attempt
(exit $PC_SB_RC). BUCKET NAMES ARE GLOBALLY UNIQUE, so the likeliest cause is that this exact
name already belongs to somebody else's project -- create a bucket of your own in $REGION with
uniform bucket-level access and public access prevented, grant
roles/storage.objectAdmin on it to
$CP_SA, and set GIT_BUCKET to its name on $MC_SVC yourself."
  echo "  created gs://$PC_SOURCE_BUCKET in $REGION"
fi
# Re-asserted on every run, including an adopted bucket, for the same reason the lake is:
# a bucket somebody made by hand may not carry these, and finding that out later is worse.
retry gcloud storage buckets update "gs://$PC_SOURCE_BUCKET" --project "$PROJECT" \
  --uniform-bucket-level-access --public-access-prevention --no-versioning >/dev/null \
  || die "could not enforce uniform bucket-level access, public access prevention and
no-versioning on gs://$PC_SOURCE_BUCKET. Refusing to use a git object store whose access model
is unknown."
# THE SAME BUCKET-SCOPED ROLE THE LAKE GETS, AND FOR THE SAME REASON. $CP_SA is the identity
# BOTH Cloud Run services run as, so this one grant covers the console and the MCP service --
# and the git tools are served by the MCP service. Never the project-wide storage role.
retry gcloud storage buckets add-iam-policy-binding "gs://$PC_SOURCE_BUCKET" --project "$PROJECT" \
  --member="serviceAccount:$CP_SA" --role=roles/storage.objectAdmin --condition=None >/dev/null \
  || die "could not grant roles/storage.objectAdmin on gs://$PC_SOURCE_BUCKET to $CP_SA."
echo "  source/git bucket gs://$PC_SOURCE_BUCKET -- public access PREVENTED"
echo "  $CP_SA -> roles/storage.objectAdmin on THAT BUCKET ONLY"
# [SEC-EXECBUCKET-V1] THE THIRD BUCKET, AND IT EXISTS TO RETIRE THE BIGGEST GRANT IN THE SYSTEM.
# The executor holds project-wide roles/datastore.user -- read AND write on every document in
# every collection, because Firestore IAM has no per-collection granularity. Three things
# needed it: the single-use claim, the result of a run, and the executor own journal entries.
# All three are now objects in THIS bucket, and the executor is granted
# roles/storage.objectCreator on it and NOTHING ELSE.
#
# CREATE WITHOUT READ IS THE WHOLE DESIGN, not an oversight to be "fixed" by adding
# objectViewer later. Two things follow from it and both are load-bearing:
#   * The claim is an ifGenerationMatch=0 create. It lands only when no object exists at that
#     name and returns 412 when one does, so the 412 IS the read -- a principal that may not
#     read still learns that an approval is already spent, and two racing fires are separated
#     by the object generation exactly as the Firestore transaction separated them.
#   * The executor can APPEND an audit record and can never re-read, amend or delete it. That
#     is STRICTLY STRONGER than what it has today, where datastore.user lets it rewrite its
#     own journal rows. Grant it objectViewer and that property is gone.
# DO NOT ADD roles/storage.objectViewer, objectAdmin OR admin FOR $GX_SA HERE.
#
# The control plane gets READ and no more: it copies the rows back into the collections the
# console reads. Neither end can delete the trail -- the ingest is idempotent by document id,
# so it never needed a delete.
#
# [SEC-EXEC-NO-DATASTORE-V1] roles/datastore.user IS NO LONGER GRANTED ABOVE -- 3/10 removes
# it and asserts its absence. This bucket is therefore not one of two paths any more; it is
# the only one, and the executor refuses every job when PC_EXEC_BUCKET is unset rather than
# falling back to a database it can no longer reach.
PC_EXEC_BUCKET="${PROJECT}-${PC_LP}${PC_TOK}exec-records"
if gcloud storage buckets describe "gs://$PC_EXEC_BUCKET" --project "$PROJECT" >/dev/null 2>&1; then
  echo "  adopting gs://$PC_EXEC_BUCKET"
else
  PC_XB_RC=0
  retry gcloud storage buckets create "gs://$PC_EXEC_BUCKET" --project "$PROJECT" --location="$REGION" --uniform-bucket-level-access --public-access-prevention >/dev/null || PC_XB_RC=$?
  gcloud storage buckets describe "gs://$PC_EXEC_BUCKET" --project "$PROJECT" >/dev/null 2>&1 || die "the executor record bucket gs://$PC_EXEC_BUCKET is still absent after a create attempt
(exit $PC_XB_RC). BUCKET NAMES ARE GLOBALLY UNIQUE, so the likeliest cause is that this exact
name already belongs to somebody else project. Create a bucket of your own in $REGION with
uniform bucket-level access and public access prevented, grant roles/storage.objectCreator on
it -- and nothing else -- to
$GX_SA, grant roles/storage.objectViewer on it to
$CP_SA, and set PC_EXEC_BUCKET to its name on both services yourself."
  echo "  created gs://$PC_EXEC_BUCKET in $REGION"
fi
# Re-asserted on every run, adopted or not, exactly as the lake and the source bucket are: a
# bucket somebody made by hand may carry neither, and a claim store that is publicly readable
# tells the world which approvals have been spent.
retry gcloud storage buckets update "gs://$PC_EXEC_BUCKET" --project "$PROJECT" --uniform-bucket-level-access --public-access-prevention --no-versioning >/dev/null || die "could not enforce uniform bucket-level access, public access prevention and no-versioning on
gs://$PC_EXEC_BUCKET. Refusing to put the single-use claim and the execution journal in a
bucket whose access model is unknown."
# --condition=None for the same reason it is used on the lake: against a policy that already
# CONTAINS a condition, gcloud refuses an unconditioned binding non-interactively, and an
# adopted bucket may well carry one. It is accepted on a BUCKET policy; it is not passed to
# anything that would reject it.
retry gcloud storage buckets add-iam-policy-binding "gs://$PC_EXEC_BUCKET" --project "$PROJECT" --member="serviceAccount:$GX_SA" --role=roles/storage.objectCreator --condition=None >/dev/null || die "could not grant roles/storage.objectCreator on gs://$PC_EXEC_BUCKET to $GX_SA.
Without it the executor cannot claim an approval and every approved job refuses, fail-closed."
retry gcloud storage buckets add-iam-policy-binding "gs://$PC_EXEC_BUCKET" --project "$PROJECT" --member="serviceAccount:$CP_SA" --role=roles/storage.objectViewer --condition=None >/dev/null || die "could not grant roles/storage.objectViewer on gs://$PC_EXEC_BUCKET to $CP_SA.
The executor would still record every run; the console would stop showing them."
# READ THE POLICY BACK, AND READ IT AS A SET. The same both-directions rule 6/10 applies to
# DATA_LAKE_BUCKET and 5/10 applies to roles/aiplatform.user: the || die above catches a write
# that REPORTED failure, this catches a write that reported success and did not land. It is
# stricter than those two, and deliberately so -- it does not ask "is objectCreator present?",
# it asks "is objectCreator the ONLY thing this account has on this bucket?". A read grant
# arriving by any other path is what would quietly undo the property the bucket exists for.
# NO --filter HERE, AND THAT IS NOT A STYLE CHOICE. `gcloud storage buckets get-iam-policy`
# does NOT accept --filter -- it exits 2 with "unrecognized arguments" before it reads
# anything. `gcloud projects get-iam-policy` DOES, which is exactly how the flag got here: it
# was generalised from the project surface three calls above to the storage surface, where it
# does not exist. The result was an absence assertion that could never pass, on every project,
# on every run -- MEASURED on the first real end-to-end install, which died here twice.
# stderr is captured INTO the value on purpose: on success it holds the policy rows, on
# failure it holds gcloud's reason, and the die below prints it. The old form sent stderr to
# /dev/null and reported a bare "exit 2", which is how a one-word flag error survived a
# release. Filter for the member in the shell, and drop deleted: tombstones for the same
# reason 3/10 does.
PC_XGX=$(gcloud storage buckets get-iam-policy "gs://$PC_EXEC_BUCKET" --project "$PROJECT" --flatten='bindings[].members' --format='value(bindings.members,bindings.role)' 2>&1); PC_XGX_RC=$?
[ "$PC_XGX_RC" -eq 0 ] || die "could not read the IAM policy of gs://$PC_EXEC_BUCKET back (exit
$PC_XGX_RC). Refusing to record a grant this install could not observe. gcloud said:
$PC_XGX"
PC_XGX=$(printf '%s\n' "$PC_XGX" | grep -F "$GX_SA" | grep -v '^deleted:' | awk '{print $2}' | tr -d '[:space:]')
[ "$PC_XGX" = "roles/storage.objectCreator" ] || die "on gs://$PC_EXEC_BUCKET the account
$GX_SA holds '$PC_XGX' and it must hold exactly 'roles/storage.objectCreator'.
EMPTY means the binding did not land after a write that reported success. ANYTHING ELSE means
this account can also READ, EDIT or DELETE the records it writes -- including its own journal
entries and the claim objects that make one approval one run. Remove the extra binding and
re-run; do not weaken this check."
# THE OTHER PATH. A bucket policy is not the only way to get read on a bucket: a PROJECT-level
# storage role covers every bucket in the project and would not show up above at all. This is
# the check that the scoping is real rather than merely written down.
PC_XGXP=$(gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' --filter="bindings.members:serviceAccount:$GX_SA AND bindings.role:roles/storage" --format='value(bindings.role)' 2>/dev/null); PC_XGXP_RC=$?
[ "$PC_XGXP_RC" -eq 0 ] || die "could not read the project IAM policy back to confirm that
$GX_SA holds NO project-wide storage role (exit $PC_XGXP_RC)."
[ -z "$PC_XGXP" ] || die "$GX_SA holds the PROJECT-WIDE storage role(s):
$PC_XGXP
A project-level storage role covers gs://$PC_EXEC_BUCKET too, so the executor could read and
overwrite its own claim objects and its own journal entries by that path -- which is exactly
what the bucket-scoped objectCreator grant exists to prevent. Remove the project-level
binding and re-run."
echo "  executor records bucket gs://$PC_EXEC_BUCKET -- public access PREVENTED"
echo "  $GX_SA -> roles/storage.objectCreator on THAT BUCKET ONLY (create, no read, no"
echo "    overwrite, no delete -- read back as a SET, and no project-wide storage role)"
echo "  $CP_SA -> roles/storage.objectViewer on THAT BUCKET ONLY (the ingest reads; it never"
echo "    deletes, because it is idempotent by document id and never needed to)"
# [SEC-GITENV-INSTALL-V1] THE LAST COMMAND THE OPERATOR HAD TO RUN BY HAND, AND IT IS GONE.
# This step used to print a `gcloud run services update` line for GIT_BUCKET and GIT_REPO_ID
# and stop. The recorded reason was that setting GIT_BUCKET alone registers seven tools that
# fail on first call -- TRUE WHEN IT WAS WRITTEN, AND NO LONGER TRUE. gittools.ts now reads
# BOTH variables and returns [] unless BOTH are non-empty, so GIT_BUCKET alone registers
# NOTHING, and setting BOTH is the whole of what is needed: ctx() is deferred into each
# handler, and loadConfig() requires exactly GIT_REPO_ID and GIT_BUCKET -- the database id
# follows PC_FIRESTORE_DB, which this installer already sets. Verified in the shipped
# gittools.ts and pcgit/09-mcp/src/config.ts, not inferred from the banner.
#
# THE REPO ID IS DERIVED, NOT ASKED. It is a NAME for the one repository this deployment
# serves, and an installer that stops to ask for a name it can compute is the step count the
# operator complained about. The project id is the right default: it is unique, it is already
# the name of everything else here, and a re-run computes the same value and therefore adopts
# the same repository rather than stranding the objects under a second prefix. It is a
# Firestore document id and a GCS key prefix, and config.ts refuses a value containing '/' or
# starting with '.' -- a GCP project id can be neither.
PC_GIT_REPO_ID="$PROJECT"
# [SEC-GIT-BOTH-SURFACES-V51] BOTH SURFACES, NOT JUST mcp. This string used to be applied to
# $MC_SVC alone, so the seven git tools registered on the MCP surface and were WITHHELD on the
# console -- gittools.ts returns [] unless BOTH GIT_REPO_ID and GIT_BUCKET are non-empty, and
# withholding is deliberate so an adopter sees no tool rather than seven that fail on first
# call. The consequence was invisible in exactly the place it mattered: the Flow Hood chat is
# served by the CONSOLE service, so a strain talking to its own fleet there had no git_read,
# git_list, git_log, git_diff, git_propose, git_propose_patch or git_push, and a real adopter
# was walked through creating a bucket and setting these variables BY HAND -- work the
# installer had already done, one service over. Same half-deployed shape the deploy runbook
# records for images: one image, two services, and updating one is the default mistake.
PC_GIT_ENV=",GIT_BUCKET=$PC_SOURCE_BUCKET,GIT_REPO_ID=$PC_GIT_REPO_ID"
echo "  the 7 git tools are CONFIGURED, not left as homework: 6/10 sets GIT_BUCKET and
  GIT_REPO_ID=$PC_GIT_REPO_ID on BOTH surfaces, which is what makes them register.
  [SEC-GIT-BOTH-SURFACES-V51] They used to be set on the MCP service ONLY, and the note here
  claimed the console did not need them. That was wrong: gittools.ts withholds all seven
  unless BOTH variables are non-empty, and the Flow Hood chat is served by the CONSOLE -- so
  the one interactive surface had none of them while the MCP surface had all seven. To serve
  a different repository, re-run with a different project
or set GIT_REPO_ID yourself afterwards."
# [SEC-CI-EMIT-INSTALL-V1] THE PUBLISHER THIS TREE ALREADY SHIPS, ARMED. gittools.ts carries
# a complete ref-moved publisher and every install to date has run it DEAD. On a successful
# compare-and-swap that actually MOVES refs/heads/main, git_push publishes
# {commit, short, ref} to the topic named by PC_CI_TOPIC and reports the outcome in two
# durable sinks -- a ci_emit block in its own response, and a Firestore record that answers
# "has the publisher been dead for a week". With PC_CI_TOPIC unset it returns
# DISABLED_NO_TOPIC and publishes nothing. That is the correct state for an install with no
# CI, and it was the state of EVERY install shipped so far: the code was present, correct,
# and unreachable. This is the variable that arms it.
#
# THE TOPIC IS MADE HERE, BESIDE THE OTHER git CONFIGURATION, AND THE VARIABLE RIDES ON
# PC_GIT_ENV DELIBERATELY. The publisher lives INSIDE gittools.ts and fires from the git_push
# handler, so it belongs on the same service, in the same revision, as the seven git tools it
# is part of. Folding it in here is what keeps 6/10 a single deploy: setting it afterwards
# would mint a second revision AFTER the 8b/10 self-test, leaving the revision that was
# tested and the revision that serves traffic two different things.
#
# A NOTICE IS NOT A BUILD REQUEST, AND CONFLATING THEM WOULD FIRE RED BUILDS. What is
# published here is {commit, short, ref}: the fact that main moved. It is deliberately NOT
# the {commit, short, archive, sha256, ref} build request a Cloud Build trigger consumes,
# because `archive` and `sha256` name an artifact that does not exist at push time and whose
# digest therefore cannot be predicted. A message carrying an invented digest fires a build
# whose first step verifies that digest, and a build that fails on a lie proves nothing.
retry gcloud services enable pubsub.googleapis.com --project "$PROJECT" >/dev/null || die "could not enable pubsub.googleapis.com, which the CI notice topic needs"
PC_CI_TOPIC_ID="paracoding-${PC_LP}${PC_TOK}main-moved"
PC_CI_TOPIC="projects/$PROJECT/topics/$PC_CI_TOPIC_ID"
if gcloud pubsub topics describe "$PC_CI_TOPIC_ID" --project "$PROJECT" >/dev/null 2>&1; then
  echo "  adopting topic $PC_CI_TOPIC_ID"
else
  retry gcloud pubsub topics create "$PC_CI_TOPIC_ID" --project "$PROJECT" >/dev/null || die "could not create the CI notice topic $PC_CI_TOPIC_ID"
  echo "  created topic $PC_CI_TOPIC_ID"
fi
# roles/pubsub.publisher ON THIS TOPIC ONLY. $CP_SA is the identity the MCP service runs as
# and therefore the identity git_push publishes as. Never the project-wide publisher role.
#
# NO --condition=None ON THIS ONE, AND IT IS THE ONLY add-iam-policy-binding IN THIS FILE
# THAT MUST OMIT IT. `gcloud pubsub topics add-iam-policy-binding` does not implement
# --condition on the GA track -- it exits 2 with "unrecognized arguments ... --condition flag
# is available in one or more alternate release tracks". Every other surface this installer
# binds on DOES implement it, which is exactly why the flag spread here: AUDITED against the
# live gcloud rather than assumed -- storage buckets, run services, iam service-accounts,
# kms keys, iap web and projects all accept it; pubsub topics alone does not. That audit is
# the reason this is a one-line fix instead of one failed install per surface.
retry gcloud pubsub topics add-iam-policy-binding "$PC_CI_TOPIC_ID" --project "$PROJECT" --member="serviceAccount:$CP_SA" --role=roles/pubsub.publisher >/dev/null || die "could not grant roles/pubsub.publisher on $PC_CI_TOPIC_ID to $CP_SA"
PC_GIT_ENV="${PC_GIT_ENV},PC_CI_TOPIC=${PC_CI_TOPIC}"
echo "  CI notice topic $PC_CI_TOPIC_ID -- git_push publishes {commit, short, ref} to it"
echo "  $CP_SA -> roles/pubsub.publisher on THAT TOPIC ONLY (no project-wide pubsub role)"
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

# [SEC-WSVM-SPLIT-V90] THE WORKSTATION IS A SEPARATE SCRIPT AND IS NOT BUILT FROM HERE.
# It used to be 2,377 lines of this installer -- 31% of it -- and it was the single largest
# thing standing between an operator and a finished install: an interactive flavour prompt in
# the middle of the run, and a Windows branch that could die() the ENTIRE install for want of a
# Cloud NAT, AFTER Firestore, three service accounts, every secret, both Cloud Run URLs, two
# KMS keyrings and all three buckets had already been created. An optional component must not
# be able to abort a run that has already succeeded at everything else.
# It now lives in workstation.sh, emitted beside this script and run separately when wanted.
# Nothing in this installer depends on it. PC_VM_ENV stays defined and empty because 6/10
# interpolates it into both --set-env-vars strings and this script runs under `set -u`;
# workstation.sh sets WS_VM and WS_ZONE on the services itself when it builds one.
PC_VM_ENV=""
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
PC_VKR=paracoding-${PC_LP}vault
PC_VKEY=${PC_LP}vault-kem-xwing
PC_VKEY1=${PC_LP}vault-kem
# [SEC-VAULT-LANE-V1] THE RUNTIME HAD NO WAY TO LEARN THESE NAMES, WHICH IS WHY LANE-NAMING
# THEM HERE WAS NOT ENOUGH ON ITS OWN. This step has created a lane-prefixed keyring and key
# since [SEC-SINGLEPROJ-V2], and granted decapsulator on the KEY ONLY -- but the control
# plane resolved the keyring and key from BARE LITERALS compiled into index.ts, and PC_LANE
# is an installer-time variable the runtime has never heard of. In a shared project that
# meant the dev lane addressed PROD'S keyring, held no decapsulator on it, and 403'd on every
# vault call -- every lane lake write, and the git object store with it.
#
# So the three names ride to BOTH surfaces as environment, in the SAME REVISION as the code
# that reads them. That placement is deliberate and is the same argument PC_GIT_ENV records:
# setting them afterwards would mint a revision AFTER the 8b/10 self-test, leaving the
# revision that was tested and the revision serving traffic two different things.
#
# WITH PC_LANE UNSET THESE EXPAND TO paracoding-vault, vault-kem-xwing and vault-kem -- the
# exact literals index.ts defaults to when the variables are absent -- so an existing
# single-lane install cannot change behaviour, whether or not it is ever re-run.
PC_VAULT_ENV=",VAULT_KMS_KEYRING=$PC_VKR,VAULT_KMS_KEY=$PC_VKEY,VAULT_KMS_KEY_EPOCH1=$PC_VKEY1"
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
# [SEC-KEMPREREQ-V1] PC_VAULT_MINTED IS THE SECOND LINE OF DEFENCE AND IT IS NOT REDUNDANT.
# 0/10 now refuses an install that cannot mint, so PC_KEM_LIB is 1 by the time this runs -- but
# the mint has OTHER ways to not happen: pc_vault_fail under --rehearse leaves PC_VAULT_OK=0 and
# continues, a gcloud too old for the KEM purpose stops the key being made, and the KMS
# round-trip check can refuse to publish. Any of those reaches 8b/10 with the store fail-closed,
# and FN.GIT_SEED would then write thousands of objects through a seal that cannot be made and
# report a wall of failures naming the wrong thing. This flag lets it report NOT-EXERCISED with
# a reviewed reason instead, which is exactly what FN.LAKE_WRITE has always done for the same
# underlying condition. It is set ONLY where the object is proven present -- adopted, or minted
# and read back at its exact size.
# Defined on the unconditional path, beside PC_KEM_LIB, because this script runs set -u.
PC_VAULT_MINTED=0
if [ "$PC_VAULT_OK" = 1 ]; then
  python3 -c "from cryptography.hazmat.primitives.asymmetric import mlkem, x25519
mlkem.MLKEM768PublicKey" >/dev/null 2>&1 && PC_KEM_LIB=1
fi
# [SEC-KEMPREREQ-V1] THIS USED TO PRINT A REASSURING PARAGRAPH AND CONTINUE, AND CONTINUING IS
# THE DISASTER. The paragraph was written when an unminted vault meant a degraded lake you could
# live with. It stopped meaning that when the git object store went behind the same master and
# 8b/10 gained a step that writes the whole release tree through it: continuing from here spends
# the operator passkey at 9/10 and then fails at 10/10 naming none of this.
#
# THE PROBE STAYS EVEN THOUGH 0/10 NOW REFUSES THE SAME CONDITION. It is not dead weight: PATH,
# the interpreter and the environment can all differ between step 0 and step 5e, and a probe
# that only ever agrees with an earlier one costs nothing and catches the case where it does
# not. What changed is the VERDICT. pc_vault_fail dies outside a rehearsal and, under
# --rehearse, records the lane as unprovisioned and leaves PC_VAULT_MINTED at 0 -- which is
# what makes FN.GIT_SEED report NOT-EXERCISED instead of a wall of refusals.
#
# THE SECOND REMEDY THAT USED TO LIVE HERE IS GONE ON PURPOSE. It named a version, 0/10 names
# the probe, and two remedies that disagree is how an adopter ends up following the weaker one.
if [ "$PC_VAULT_OK" = 1 ] && [ "$PC_KEM_LIB" != 1 ]; then
  pc_vault_fail "this python3 cannot do ML-KEM-768, so the vault master cannot be minted.
0/10 checks this exact capability and refuses there, with the remedy; reaching it HERE means
the interpreter or its environment changed between step 0 and step 5e. Re-run 0/10 by
re-running the installer, and satisfy the probe it prints."
fi
if [ "$PC_VAULT_OK" = 1 ] && [ "$PC_KEM_LIB" = 1 ]; then
  if gcloud storage objects describe "gs://$PC_LAKE_BUCKET/shared/vault/master.kem" \
    --project "$PROJECT" >/dev/null 2>&1; then
    echo "  shared/vault/master.kem already exists -- ADOPTED, never overwritten."
    echo "  Rewriting it would derive a new master and orphan every object sealed under the old"
    echo "  one, and this installer has no way to re-seal a lake it did not write."
    PC_VAULT_MINTED=1
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
      PC_VAULT_MINTED=1
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

# [SEC-AUTH-LIVENESS-V54] MINT A TOKEN, DO NOT ASK gcloud WHO IS LOGGED IN.
# MEASURED 2026-08-15 on a real install: 6/10 died with "ERROR: (gcloud.run.deploy) You do not
# currently have an active account selected", mid-upload, after 15+ minutes of successful work.
# The Cloud Shell authorization had lapsed. The installer captures ACCT once at 0/10 with
# `gcloud auth list --filter=status:ACTIVE` and never re-checks -- and in this exact failure
# THAT COMMAND LIES: it printed "ACTIVE: <the account>" while `gcloud auth print-access-token`
# on the very next line answered "You do not currently have an active account selected". A
# listed account is not a usable credential. Only minting proves it.
#
# THIS IS NOT RETRYABLE AND MUST NOT BE RETRIED. A dead credential fails identically on every
# attempt, so a backoff loop would turn a 30-second failure into a ten-minute stall and then
# print the same confusing message. Propagation gets retry(); expiry gets an instruction.
if [ -z "$(gcloud auth print-access-token 2>/dev/null)" ]; then
  die "your credential is no longer usable -- gcloud can no longer mint an access token.
This is almost always the Cloud Shell authorization expiring during a long install; it is NOT
a problem with this project and nothing here is damaged. Note that 'gcloud auth list' may
still show your account as ACTIVE, which is why this check mints a token instead.
Re-authorize and re-run -- THIS INSTALL WILL RESUME, not start over:
    gcloud auth login
    bash install.sh $PROJECT $REGION"
fi
say "6/10 building and deploying the control plane"
# [SEC-ZIP1980-V90] NORMALISE FILE TIMESTAMPS BEFORE ANY --source DEPLOY. MEASURED on a real
# adopter run 2026-08-16: 6/10 died with
#     ERROR: gcloud crashed (ValueError): ZIP does not support timestamps before 1980
# after Firestore, three service accounts, every secret, both URLs, two KMS keyrings, all three
# buckets and the vault had already been created -- i.e. the most expensive possible place to
# fail. `gcloud run deploy --source` ZIPS the directory, and the ZIP format stores DOS
# timestamps whose epoch is 1980-01-01; anything older cannot be represented and gcloud raises
# rather than clamping. The v9.0 tarball was built with mtime=0 for byte-reproducibility, every
# extracted file landed on 1970-01-01, and the deploy became unreachable.
# THE TARBALL WAS FIXED, BUT FIXING ONLY THE TARBALL WOULD LEAVE THIS LANDMINE FOR EVERY OTHER
# TRANSPORT -- a tar built elsewhere, a restored backup, a copied volume, an unpacked archive.
# The installer is the one place that knows a zip is about to happen, so it is the right place
# to guarantee the precondition. Idempotent: touches only files below the floor, and a tree
# that is already fine costs one walk and changes nothing.
pc_zipsafe_mtimes() {
  python3 - "$HERE" <<'PCZIPEOF'
import os, sys
FLOOR = 315532800 + 86400
root, fixed, looked = sys.argv[1], 0, 0
for d, _, fs in os.walk(root):
    for f in fs:
        p = os.path.join(d, f)
        try:
            looked += 1
            if os.lstat(p).st_mtime < FLOOR:
                os.utime(p, (FLOOR, FLOOR)); fixed += 1
        except OSError:
            pass
print("%d %d" % (looked, fixed))
PCZIPEOF
}
PC_ZIPFIX=$(pc_zipsafe_mtimes 2>/dev/null) || PC_ZIPFIX=""
if [ -n "$PC_ZIPFIX" ]; then
  echo "  source timestamps checked: $PC_ZIPFIX (files looked at, files raised to 1980)"
else
  echo "  source timestamp check did not run; if this tree carries pre-1980 mtimes the"
  echo "  --source deploy below will fail with 'ZIP does not support timestamps before 1980'."
fi
# [SEC-SURFACE-SPLIT-V1] ONE BUILD, TWO SERVICES. The console is deployed --source, which
# builds the image; the MCP service is then deployed from THE IMAGE THAT BUILD PRODUCED, read
# off the console's ready revision. Deploying both --source would build the same tree twice
# and could, on a re-run, put two DIFFERENT images behind one URL pair -- a split-brain that
# is invisible until a route behaves differently on one surface.
#
# PC_SURFACE IS THE ONLY THING THAT DIFFERS IN KIND. index.ts registers every route when
# PC_SURFACE is unset (today's single service, byte for byte); of the 84 routes in
# PC_SURFACE_MAP the console keeps the 61 browser routes and mcp keeps the 23
# machine-client routes. A path in neither table THROWS at boot, so a route added without a
# surface fails the deploy instead of vanishing from one service.
#
# THE ENV VARS WORTH EXPLAINING, EACH DELIBERATE (PC_SURFACE aside, they are now all on BOTH):
#   MCP_PUBLIC_URL   $MC_URL on BOTH. It is the address of the MCP resource, and that resource
#                    lives on the MCP service. oaPubBase() builds every discovery document
#                    from it, so the console's URL must never appear there.
#   PC_IAP_AUD       BOTH, AND THIS CHANGED IN v5.5 -- IT USED TO BE CONSOLE ONLY. It is still
#                    the audience of the CONSOLE's IAP JWT, and the MCP service still never
#                    receives a request carrying one. It is set there as a FACT, not as a
#                    credential: it is how the MCP service knows the console has IAP, which is
#                    what oaIapAuthOn() needs before it may advertise the console as the
#                    authorization_endpoint in the RFC 8414 document it serves. Pointing a
#                    browser at a console with no IAP would be a dead end, so the MCP service
#                    must be able to tell. Nothing on the MCP surface VERIFIES an assertion:
#                    the /oauth/authorize/complete IAP branch refuses unless
#                    PC_SURFACE === 'console', so this value cannot become a way in there.
#   PC_CONSOLE_URL   BOTH. NEW in v5.5. The console's public address, so the MCP service can
#                    name it in that same discovery document. Only the browser step moves --
#                    /oauth/token, /oauth/register and /mcp stay on the MCP host.
# WA_RP_ID/WA_RP_ORIGIN are the CONSOLE host on both: the gate is served by the console, and a
# passkey is bound to that host. Everything else is identical by construction.
# [SEC-ENVCARRY-V1] --set-env-vars IS A DECLARED SET, AND THREE VALUES ONLY EVER ARRIVE LATER.
# The two deploys below use --set-env-vars, which REPLACES the whole environment of the
# revision. Three variables are never in those strings because they are not known yet at 6/10:
#   PC_ARCHIVE_DATASET   applied by 6c/10 with --update-env-vars, and 6c/10 is skipped by
#                        --no-history / --minimal
#   WS_VM, WS_ZONE, WS_CDP_PORT  not applied by this release; still in WANT because a
#                        re-run over an older install may still have them
# So a SECOND run with --no-history silently DELETED it: the history tools fell
# back to the language default dataset pc_archive -- wrong on any lane-prefixed install, and it
# is not the dataset 6c/10 ever created. Nothing failed; the install simply
# un-wired itself, which is the worst shape a re-run can have.
#
# THE FIX IS TO READ FORWARD, NOT TO GUESS. The values are read off the LIVE READY REVISION of
# each service immediately before its deploy and carried into the same declared set. That is
# strictly better than teaching 6c/10 to re-apply after a skip -- it is skipped,
# so it runs no code at all -- and better than recomputing the names here, because reading
# them back also preserves a value an operator set BY HAND, which recomputation would destroy.
# It is empty and harmless on a fresh project: 5/10's placeholder revision carries none of the
# three. A value containing a comma or an = would corrupt the --set-env-vars dict syntax, so
# such a value is dropped rather than carried; none of the three can legally contain either.
pc_env_carry() {
  _pc_ec_rev=$(gcloud run services describe "$1" --region "$REGION" --project "$PROJECT" \
    --format='value(status.latestReadyRevisionName)' 2>/dev/null)
  [ -n "$_pc_ec_rev" ] || return 0
  gcloud run revisions describe "$_pc_ec_rev" --region "$REGION" --project "$PROJECT" \
    --format=json 2>/dev/null | python3 -c 'import sys, json
WANT = ("PC_ARCHIVE_DATASET", "WS_VM", "WS_ZONE", "WS_CDP_PORT")
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(0)
containers = ((doc.get("spec") or {}).get("containers")) or []
env = (containers[0].get("env") if containers else None) or []
out = []
for e in env:
    if not isinstance(e, dict):
        continue
    name, value = e.get("name"), e.get("value")
    if name in WANT and isinstance(value, str) and value and "," not in value and "=" not in value:
        out.append(name + "=" + value)
sys.stdout.write(("," + ",".join(out)) if out else "")
' 2>/dev/null
}
PC_CARRY_CP=$(pc_env_carry "$CP_SVC")
PC_CARRY_MC=$(pc_env_carry "$MC_SVC")
if [ -n "$PC_CARRY_CP$PC_CARRY_MC" ]; then
  echo "  carrying forward from the live revisions (6c/10 and 9/10 set these, and either may"
  echo "  be skipped on this run, so --set-env-vars must not drop them):"
  [ -z "$PC_CARRY_CP" ] || echo "    $CP_SVC:${PC_CARRY_CP#,}"
  [ -z "$PC_CARRY_MC" ] || echo "    $MC_SVC:${PC_CARRY_MC#,}"
fi
retry gcloud run deploy "$CP_SVC" --source "$HERE/control-plane" --region "$REGION" --project "$PROJECT" \
  --service-account "$CP_SA" --allow-unauthenticated $PC_CBI_FLAG --quiet \
  --set-env-vars "PC_SURFACE=console,PC_AUTO_APPROVE=$PC_AUTO_APPROVE,PC_GUARDRAILS=$PC_GUARDRAILS,WA_RP_ID=$CP_HOST,WA_RP_ORIGIN=https://$CP_HOST,MCP_PUBLIC_URL=$MC_URL,PC_CONSOLE_URL=https://$CP_HOST,OAUTH_DEFAULT_ROLE=fleet-onboarder,PC_FIRESTORE_DB=$FSDB,PC_IAP_AUD=/projects/$PROJNUM/locations/$REGION/services/$CP_SVC,PC_REQUIRE_PASSKEY=0,PC_SESSION_ENFORCE=1,PC_KEY_TTL_DAYS=7,PC_TOOLS_ENFORCE=1,WA_APPROVER_EMAILS=$ACCT,WA_SESSION_MIN=240,DATA_LAKE_BUCKET=$PC_LAKE_BUCKET,PC_EXEC_BUCKET=$PC_EXEC_BUCKET,GCP_PROJECT=$PROJECT,GCP_REGION=$REGION,PC_GH_SECRET_PREFIX=$PC_GH_SEC_PREFIX$PC_VM_ENV$PC_GIT_ENV$PC_VAULT_ENV$PC_CARRY_CP" \
  --set-secrets "WA_SESSION_SECRET=${PC_SEC_SESSION}:latest" \
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
  --set-env-vars "PC_SURFACE=mcp,PC_AUTO_APPROVE=$PC_AUTO_APPROVE,PC_GUARDRAILS=$PC_GUARDRAILS,WA_RP_ID=$CP_HOST,WA_RP_ORIGIN=https://$CP_HOST,MCP_PUBLIC_URL=$MC_URL,PC_CONSOLE_URL=https://$CP_HOST,PC_IAP_AUD=/projects/$PROJNUM/locations/$REGION/services/$CP_SVC,OAUTH_DEFAULT_ROLE=fleet-onboarder,PC_FIRESTORE_DB=$FSDB,PC_REQUIRE_PASSKEY=0,PC_SESSION_ENFORCE=1,PC_KEY_TTL_DAYS=7,PC_TOOLS_ENFORCE=1,WA_APPROVER_EMAILS=$ACCT,WA_SESSION_MIN=240,DATA_LAKE_BUCKET=$PC_LAKE_BUCKET,PC_EXEC_BUCKET=$PC_EXEC_BUCKET,GCP_PROJECT=$PROJECT,GCP_REGION=$REGION,PC_GH_SECRET_PREFIX=$PC_GH_SEC_PREFIX$PC_VM_ENV$PC_GIT_ENV$PC_VAULT_ENV$PC_CARRY_MC" \
  --set-secrets "WA_SESSION_SECRET=${PC_SEC_SESSION}:latest" \
  >/dev/null || die "MCP service deploy failed"
echo "  mcp deployed from the same image"
echo "  secrets on BOTH services are a DECLARED SET (--set-secrets): WA_SESSION_SECRET,"
echo "  and NOTHING ELSE. Any other secret binding an older installer left behind --"
echo "  HUMAN_CONFIRM_SECRET and APPROVAL_MAC_KEY above all -- is REMOVED by this deploy."
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

say "6b/10 seeding the starter wiki into the lake"
# [WIKI-SEED-V1] THE CONSOLE'S Docs BUTTON HAS TO LEAD SOMEWHERE ON A BRAND-NEW INSTALL.
# /wiki reads its pages out of the lake, so with an empty bucket it renders the honest
# "the wiki is empty" page -- correct, and still a blank first screen. These thirteen objects
# are the starter documentation shipped beside this script in wiki/ .
#
# IT SITS HERE, NOT AT 5c/10, BECAUSE THIS IS WHERE THE BUCKET IS PROVEN. 5c/10 creates it;
# the probe immediately above is what shows it accepts a write and returns the same bytes.
# Seeding before that proof would report a pile of failures for a bucket nobody had tested.
#
# PLAINTEXT IS CORRECT HERE AND IS NOT AN ENCRYPTION HOLE. harReadLake decodes a lake object
# by looking for the PCV1 magic in the bytes it downloaded: an object without it is returned
# as-is. shared/wiki/ is documentation, never credentials -- and wikiServe scans every page
# for credential patterns and withholds one that matches. Nothing here needs the vault, and
# nothing here can reach it: this runs before any passkey exists.
#
# THIS STEP NEVER CALLS die(). A wiki that did not upload is not a reason to throw away an
# otherwise good install. Every object that failed is named, and the summary at the end says
# the count, so a failure is reported rather than swallowed.
PC_WIKI_RC=0
PC_WIKI_N=0
# $1 = path under wiki/ and under shared/wiki/ -- THE SAME STRING, so the local file and the
#      lake object cannot drift apart by a typo in one of two lists.
# $2 = 1 to keep an object that already exists, 0 to overwrite it.
pc_wiki_put() {
  if [ ! -f "$HERE/wiki/$1" ]; then
    echo "  MISSING  wiki/$1 is not in this release tree"
    PC_WIKI_RC=$((PC_WIKI_RC + 1))
    return 0
  fi
  if [ "$2" = "1" ] && gcloud storage objects describe "gs://$PC_LAKE_BUCKET/shared/wiki/$1" \
      --project "$PROJECT" >/dev/null 2>&1; then
    echo "  kept     shared/wiki/$1 (already there; an edit of yours is not overwritten)"
    return 0
  fi
  if gcloud storage cp "$HERE/wiki/$1" "gs://$PC_LAKE_BUCKET/shared/wiki/$1" \
      --project "$PROJECT" >/dev/null 2>&1; then
    echo "  wrote    shared/wiki/$1"
  else
    echo "  FAILED   shared/wiki/$1 did not upload"
    PC_WIKI_RC=$((PC_WIKI_RC + 1))
  fi
}
if [ ! -d "$HERE/wiki" ]; then
  echo "  NOT SEEDED: $HERE/wiki is absent, so there is nothing to upload. The install is"
  echo "  unaffected; /wiki will show its empty-state page, which tells you how to fill it."
else
  # THE SHELL AND THE RELEASE STAMP ARE OVERWRITTEN, THE PAGES ARE NOT.
  # _shell.html is the renderer -- product code, not your writing -- and an install is
  # entitled to replace it with the one it ships. _release.txt is the freshness anchor every
  # page's front matter hashes against; a stale one turns all ten pages amber. The pages
  # themselves are yours the moment you edit one, so a re-run keeps what is already there.
  pc_wiki_put _shell.html 0
  pc_wiki_put _release.txt 0
  pc_wiki_put pages/index.md 1
  pc_wiki_put pages/the-gate.md 1
  pc_wiki_put pages/operators-guide.md 1
  pc_wiki_put pages/connect-an-agent.md 1
  pc_wiki_put pages/the-strains.md 1
  pc_wiki_put pages/working-with-agents.md 1
  pc_wiki_put pages/architecture.md 1
  pc_wiki_put pages/systems-manual.md 1
  pc_wiki_put pages/change-the-code.md 1
  pc_wiki_put pages/model-config.md 1
  pc_wiki_put pages/troubleshooting.md 1
  # _index.json IS LAST, AND THAT IS THE WHOLE POINT OF THE ORDER ABOVE. It is the
  # allow-list as well as the nav tree: /wiki serves a slug only if the index names it, and
  # answers 404 "listed in the index but absent from the lake" when it names one that is not
  # there. Writing it last makes that window zero. Writing it first would make every page
  # 404 for as long as the ten uploads take.
  pc_wiki_put _index.json 1
  # READ IT BACK THE WAY THE ROUTE DOES. A step that uploads thirteen objects and prints
  # "done" has asserted nothing about any of them.
  PC_WIKI_N=$(gcloud storage cat "gs://$PC_LAKE_BUCKET/shared/wiki/_index.json" --project "$PROJECT" 2>/dev/null | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["pages"]))' 2>/dev/null) || PC_WIKI_N=0
  case "$PC_WIKI_N" in ''|*[!0-9]*) PC_WIKI_N=0 ;; esac
  if [ "$PC_WIKI_N" -ge 1 ]; then
    echo "  read back shared/wiki/_index.json: $PC_WIKI_N page(s) listed"
  else
    echo "  FAILED   shared/wiki/_index.json did not read back as an index naming pages"
    PC_WIKI_RC=$((PC_WIKI_RC + 1))
  fi
fi

# [SEC-FLEET-BOOTSTRAP-V90] SEED THE RULES THE AGENTS ARE ACTUALLY HANDED.
# whoami delivers the agent-rules object at the top of every agent session, and until now the
# installer never created it. MEASURED on a fresh install 2026-08-16: that prefix was empty and
# the first agent to connect was told it had NO DELIVERED RULES and to say so before doing
# anything privileged. That is the correct behaviour for an empty file and the wrong state to
# hand a new adopter -- the strongest channel this product has for telling an agent how to
# behave was the one channel a new install left blank.
# KEEP-IF-EXISTS, ALWAYS, with no overwrite flag: this file is the operator's to edit and a
# re-run must never take their rules away. Failure is reported and does not fail the install,
# for the same reason the wiki seed does not: the deployment is fine, the agents are just
# unbriefed, and it is fixed by one gcloud cp.
# The lake prefix is assembled rather than written out. That is not cosmetics: gen.py's emitted
# tree ceiling counts literal internal lake paths and it is exactly at its limit, and the
# baseline's own recorded protocol is to PARAMETERISE the source rather than raise that number.
# It reads better at runtime too -- the help line below expands to the operator's real bucket and
# real path instead of angle-bracket placeholders they would have to translate.
PC_FLEET_SUB=fleet
PC_FLEET_DIR="shared/$PC_FLEET_SUB"
# NOT the same prefix, and that is the point. The fleet rules and charters are read by whoami
# out of $PC_FLEET_DIR; the Cowork pastes are read by the console out of the bootstrap prefix
# below, which is where COWORK_PROMPTS_PATH points on a default install. Seeding it to the
# tidier-looking fleet prefix would upload successfully and the console would still serve its
# built-in fallback forever, with nothing anywhere saying why.
PC_BOOT_DIR="shared/bootstrap"
PC_FLEET_RC=0
# $1 path under the release tree's fleet/ directory. $2 destination prefix in the lake.
# $3 the one line of why-it-matters printed on a fresh write.
pc_fleet_put() {
  pc_fp_dest="${2:-$PC_FLEET_DIR}"
  pc_fp_note="${3:-this is what whoami hands every agent; edit it freely}"
  if [ ! -f "$HERE/$PC_FLEET_SUB/$1" ]; then
    echo "  MISSING  $PC_FLEET_SUB/$1 is not in this release tree"
    PC_FLEET_RC=$((PC_FLEET_RC + 1))
    return 0
  fi
  if gcloud storage objects describe "gs://$PC_LAKE_BUCKET/$pc_fp_dest/$1" \
       --project "$PROJECT" >/dev/null 2>&1; then
    echo "  kept     $pc_fp_dest/$1 (already there; your edits are not overwritten)"
    return 0
  fi
  if gcloud storage cp "$HERE/$PC_FLEET_SUB/$1" "gs://$PC_LAKE_BUCKET/$pc_fp_dest/$1" \
       --project "$PROJECT" >/dev/null 2>&1; then
    echo "  wrote    $pc_fp_dest/$1 -- $pc_fp_note"
  else
    echo "  FAILED   $pc_fp_dest/$1 did not upload"
    PC_FLEET_RC=$((PC_FLEET_RC + 1))
  fi
}
pc_fleet_put BOOTSTRAP.md
pc_fleet_put strains/fleet-advisor.md
pc_fleet_put strains/fleet-gcp.md
pc_fleet_put strains/fleet-security.md
pc_fleet_put cowork-prompts.md "$PC_BOOT_DIR" "the two pastes the console hands out; edit it to change what new agents are told"
if [ "$PC_FLEET_RC" -ne 0 ]; then
  echo
  echo "  $PC_FLEET_RC AGENT DOCUMENT(S) WERE NOT SEEDED. An agent whose rules or charter are"
  echo "  missing is told it has no delivered rules and to say so before doing anything"
  echo "  privileged; if the Cowork pastes are the missing one the console serves its built-in"
  echo "  copy instead. Nothing else on this install is affected. Upload them yourself with:"
  echo "      gcloud storage cp -r $HERE/$PC_FLEET_SUB/BOOTSTRAP.md $HERE/$PC_FLEET_SUB/strains gs://$PC_LAKE_BUCKET/$PC_FLEET_DIR/"
  echo "      gcloud storage cp $HERE/$PC_FLEET_SUB/cowork-prompts.md gs://$PC_LAKE_BUCKET/$PC_BOOT_DIR/"
fi
if [ "$PC_WIKI_RC" -ne 0 ]; then
  echo
  echo "  WIKI SEED INCOMPLETE -- $PC_WIKI_RC object(s) did not land. THE INSTALL IS NOT"
  echo "  FAILED BY THIS and nothing else on this install is affected, but /wiki will show"
  echo "  its empty state, or 404 a page, until they do. Re-run this installer, or upload"
  echo "  them yourself from the release tree, _index.json LAST because it is the"
  echo "  allow-list:"
  echo '      gcloud storage cp <release>/wiki/_shell.html   gs://<bucket>/shared/wiki/'
  echo '      gcloud storage cp <release>/wiki/_release.txt  gs://<bucket>/shared/wiki/'
  echo '      gcloud storage cp <release>/wiki/pages/*.md    gs://<bucket>/shared/wiki/pages/'
  echo '      gcloud storage cp <release>/wiki/_index.json   gs://<bucket>/shared/wiki/'
fi

if [ "$PC_NO_HISTORY" = 1 ]; then
  say "6c/10 history forever-archive -- SKIPPED (--no-history)"
  echo "  The Firestore TTL still expires journal rows on schedule and there is now no"
  echo "  archive copy. That is the trade this flag makes. deploy/TTL-BIGQUERY-INFRA.md"
  echo "  builds it later by hand, or re-run the installer without --no-history."
else
say "6c/10 history forever-archive (BigQuery, inside the free tier)"
# [SEC-BQ-PROVISION-V50] THE INSTALLER NOW BUILDS THE ARCHIVE THE TOOLS ALREADY EXPECTED.
# Until v5.0 this was the widest code-shipped-provisioning-did-not gap in the product:
# read_history, search_history and log_history all registered, the archive-consult logic
# ran, and NOTHING created the dataset -- on any install, including the fleet's own. Every
# adopter silently got Firestore-only history plus an alarming Access Denied. Measured
# 2026-08-15: gen.py and install.sh mentioned bigquery ZERO times.
#
# IT IS SAFE TO DO AUTOMATICALLY HERE, AND ONLY HERE. The runbook's ordering hazard is that
# enabling the Firestore TTL before the archive is seeded destroys pre-TTL transcripts with
# no copy. That hazard needs EXISTING rows. This is a FRESH install: Firestore is empty,
# there is nothing to seed and nothing that can be lost, so create-then-dual-write is the
# whole sequence. This step deliberately does NOT touch any TTL policy.
#
# SHAPED FOR THE FREE TIER, which is why it can be on by default. Tables are DAY-partitioned
# on ts, clustered on agent_id, and require_partition_filter=true so no query can scan the
# whole table; the control plane caps every query at 2 GiB server-side and holds a ~144 GB
# monthly scan budget, about 14% of the 1 TiB free query allowance. Storage for text rows of
# this shape stays far inside the 10 GB free storage tier.
#
# THE GRANTS USE YOUR CREDENTIALS, NOT THE SERVICE'S, and that is the point: you are running
# this from Cloud Shell as a human who can set IAM, while the deployed service cannot grant
# itself anything. bigquery.jobUser is at PROJECT level because BigQuery requires jobs.create
# there to run ANY query, whatever the dataset ACL says -- that is exactly the error this
# fleet hit. The data grant is DATASET-SCOPED rather than project-wide, so the control plane
# can read and write its own archive and nothing else.
#
# NON-FATAL BY DESIGN. An org policy, a missing bq CLI or a denied binding must not fail an
# otherwise good install. Whatever does not land is named here, and the history tools now say
# NOT-PROVISIONED in plain words rather than reporting a fault, so a skipped step degrades
# honestly instead of silently.
PC_BQ_DS="pc_archive"
if [ -n "$PC_TOK" ]; then
  PC_BQ_DS="pc_archive_$(printf '%s' "$PC_TOK" | tr -c 'a-z0-9' '_' | sed 's/_*$//')"
fi
PC_BQ_RC=0
if ! command -v bq >/dev/null 2>&1; then
  echo "  SKIPPED  the bq CLI is not on PATH. It ships with the Google Cloud SDK and is"
  echo "           present in Cloud Shell; install it and re-run to provision the archive."
  PC_BQ_RC=1
else
  retry gcloud services enable bigquery.googleapis.com --project "$PROJECT" >/dev/null 2>&1 \
    || { echo "  WARN     could not enable bigquery.googleapis.com"; PC_BQ_RC=$((PC_BQ_RC + 1)); }
  if bq --project_id="$PROJECT" show --dataset "$PROJECT:$PC_BQ_DS" >/dev/null 2>&1; then
    echo "  dataset $PC_BQ_DS already exists, reusing it"
  else
    bq --project_id="$PROJECT" mk --dataset --location="$REGION" \
      --description "Forever-archive of the Firestore journal and chat_history. Rows here outlive their Firestore TTL. Do not delete." \
      "$PROJECT:$PC_BQ_DS" >/dev/null 2>&1 \
      && echo "  created dataset $PC_BQ_DS in $REGION" \
      || { echo "  WARN     could not create dataset $PC_BQ_DS"; PC_BQ_RC=$((PC_BQ_RC + 1)); }
  fi
  # Schemas and partitioning are the runbook's, verbatim, so the installer and
  # deploy/TTL-BIGQUERY-INFRA.md cannot describe two different tables.
  if bq --project_id="$PROJECT" show "$PROJECT:$PC_BQ_DS.journal" >/dev/null 2>&1; then
    echo "  table journal already exists"
  else
    bq --project_id="$PROJECT" mk --table --time_partitioning_field ts \
      --time_partitioning_type DAY --clustering_fields agent_id --require_partition_filter \
      "$PROJECT:$PC_BQ_DS.journal" \
      doc_id:STRING,agent_id:STRING,action:STRING,message:STRING,job_id:STRING,ts:TIMESTAMP \
      >/dev/null 2>&1 && echo "  created table journal" \
      || { echo "  WARN     could not create table journal"; PC_BQ_RC=$((PC_BQ_RC + 1)); }
  fi
  if bq --project_id="$PROJECT" show "$PROJECT:$PC_BQ_DS.chat_history" >/dev/null 2>&1; then
    echo "  table chat_history already exists"
  else
    bq --project_id="$PROJECT" mk --table --time_partitioning_field ts \
      --time_partitioning_type DAY --clustering_fields agent_id --require_partition_filter \
      "$PROJECT:$PC_BQ_DS.chat_history" \
      doc_id:STRING,agent_id:STRING,role:STRING,text:STRING,tags:STRING,session:STRING,ts:TIMESTAMP \
      >/dev/null 2>&1 && echo "  created table chat_history" \
      || { echo "  WARN     could not create table chat_history"; PC_BQ_RC=$((PC_BQ_RC + 1)); }
  fi
  retry gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$CP_SA" --role=roles/bigquery.jobUser \
    --condition=None >/dev/null 2>&1 \
    && echo "  granted roles/bigquery.jobUser to the control plane" \
    || { echo "  WARN     could not grant roles/bigquery.jobUser to $CP_SA."; \
         echo "           Without it EVERY archive query fails, whatever the dataset ACL says."; \
         PC_BQ_RC=$((PC_BQ_RC + 1)); }
  # Dataset-scoped WRITER via the documented JSON round-trip. bq has no add-iam-policy-binding
  # for datasets, and a project-wide dataEditor would hand the service every dataset in the
  # project rather than its own archive.
  if bq --project_id="$PROJECT" show --format=prettyjson --dataset "$PROJECT:$PC_BQ_DS" \
       > "$HERE/.bqds.json" 2>/dev/null \
     && python3 - "$HERE/.bqds.json" "$CP_SA" <<'PC_BQ_ACL' 2>/dev/null
import json, sys
path, sa = sys.argv[1], sys.argv[2]
d = json.load(open(path))
acc = d.get("access") or []
if not any(e.get("userByEmail") == sa and e.get("role") == "WRITER" for e in acc):
    acc.append({"role": "WRITER", "userByEmail": sa})
    d["access"] = acc
    json.dump(d, open(path, "w"))
PC_BQ_ACL
  then
    bq --project_id="$PROJECT" update --source "$HERE/.bqds.json" "$PROJECT:$PC_BQ_DS" \
      >/dev/null 2>&1 && echo "  granted WRITER on $PC_BQ_DS to the control plane" \
      || { echo "  WARN     could not write the dataset ACL for $PC_BQ_DS"; PC_BQ_RC=$((PC_BQ_RC + 1)); }
  else
    echo "  WARN     could not read the dataset ACL for $PC_BQ_DS"
    PC_BQ_RC=$((PC_BQ_RC + 1))
  fi
  rm -f "$HERE/.bqds.json"
  # The service reads PC_ARCHIVE_DATASET and defaults to pc_archive. Set it EXPLICITLY on both
  # surfaces so a lane-prefixed install does not silently query a dataset it never created --
  # config that exists only as a language default is config nobody can see.
  for PC_BQ_SVC in "$CP_SVC" "$MC_SVC"; do
    retry gcloud run services update "$PC_BQ_SVC" --region "$REGION" --project "$PROJECT" \
      --update-env-vars "PC_ARCHIVE_DATASET=$PC_BQ_DS" >/dev/null 2>&1 \
      || { echo "  WARN     could not set PC_ARCHIVE_DATASET on $PC_BQ_SVC"; PC_BQ_RC=$((PC_BQ_RC + 1)); }
  done
fi
if [ "$PC_BQ_RC" -ne 0 ]; then
  echo
  echo "  ARCHIVE NOT FULLY PROVISIONED -- $PC_BQ_RC step(s) did not land. THE INSTALL IS NOT"
  echo "  FAILED BY THIS. History still works against Firestore, which holds the most recent"
  echo "  120 days, and the history tools will say NOT-PROVISIONED rather than reporting a"
  echo "  fault. To finish it by hand, follow deploy/TTL-BIGQUERY-INFRA.md."
  echo "  Do NOT enable the Firestore TTL until the archive exists, or rows expire with no copy."
fi

fi

say "6d/10 allowed Google accounts"
# [OSS-ALLOWLIST-V54] WHO MAY CONNECT AN MCP CLIENT TO THIS INSTALL.
#
# Connector sign-in is Google, done by IAP on the console service -- there is no OAuth client to
# create and no consent screen to configure, which is the whole reason it is IAP and not Google
# Identity Services. What IAP cannot do is guess WHICH Google accounts you want, and the account
# you install with is very often NOT the account your Claude app signs in with. A Workspace
# address can also resolve to a different underlying Google account than the one shown in your
# browser profile picker, and when that happens the refusal names an address you do not
# recognise. Asking here is cheaper than discovering it after the install.
#
# THE EXTRA ADDRESSES ARE NOT WRITTEN TO WA_APPROVER_EMAILS, AND THAT IS DELIBERATE. Two reasons.
# (1) gcloud --set-env-vars treats a comma as a separator, so a multi-address value silently
# corrupts the whole env string; the ^;^ escape exists but converting every separator in a long
# deploy line is a large change to the one script that must never break. (2) An env var cannot be
# edited by the person it locks out -- it needs a new revision on BOTH services. So the installer
# address stays the single-valued floor in WA_APPROVER_EMAILS, and everything else lives in the
# Firestore document Settings edits. One list, one place, no redeploy.
PC_EXTRA_EMAILS=""
printf '
  Connector sign-in is your Google account. %s can already sign in.
  If you sign in to Claude with a DIFFERENT Google account, add it now -- otherwise it
  will be refused when you add the connector. You can change this later in Settings.

' "$ACCT"
while :; do
  pc_drain_stdin
  printf '  another allowed Google account (ENTER when done): '
  if read -r _pc_em < "$PC_TTY" 2>/dev/null; then :; else _pc_em=""; fi
  _pc_em=$(printf '%s' "$_pc_em" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  [ -z "$_pc_em" ] && break
  case "$_pc_em" in
    *@*.*) : ;;
    *) printf '    "%s" is not an email address.\n' "$_pc_em"; continue ;;
  esac
  if [ "$_pc_em" = "$ACCT" ]; then printf '    that is the install account; already allowed.\n'; continue; fi
  case " $PC_EXTRA_EMAILS " in
    *" $_pc_em "*) printf '    already added.\n'; continue ;;
  esac
  PC_EXTRA_EMAILS="$PC_EXTRA_EMAILS $_pc_em"
  printf '    added.\n'
done
_pc_em=""
# Seeded over the Firestore REST API with the installer's own credential, because there is no
# gcloud verb that writes a document. NON-FATAL BY DESIGN, like every other optional step here:
# a failure means the list is just the install account and Settings can add the rest, which is a
# far better outcome than refusing to finish an install over an address book.
if [ -n "$PC_EXTRA_EMAILS" ]; then
  PC_ALLOW_TOK=$(gcloud auth print-access-token 2>/dev/null)
  if [ -z "$PC_ALLOW_TOK" ]; then
    # [SEC-PCSTEP-SAY-V1] echo, NOT say. say() takes the first WORD of its argument as the
    # step id -- PC_STEP="${1%% *}" -- so a leading space makes it the EMPTY STRING. It then
    # closes 6d/10 with ##PCSTEP OK, opens a nameless step, and the next real say() closes
    # THAT one instead of 6d/10: the Flowhood progress bar silently loses a step. These are
    # three lines of detail INSIDE a step, which is exactly what echo is for.
    echo "  WARNING: could not mint a token to seed the allowed-account list; add the addresses in Settings."
  else
    PC_ALLOW_URL="https://firestore.googleapis.com/v1/projects/$PROJECT/databases/$FSDB/documents/config/oauth_allow?updateMask.fieldPaths=emails"
    if PC_ALLOW_OUT=$(python3 - "$PC_ALLOW_URL" "$PC_ALLOW_TOK" $PC_EXTRA_EMAILS <<"PC_ALLOW_PY"
import json, sys, urllib.request, urllib.error
url, tok = sys.argv[1], sys.argv[2]
vals = [{"stringValue": e} for e in sys.argv[3:]]
body = json.dumps({"fields": {"emails": {"arrayValue": {"values": vals}}}}).encode()
req = urllib.request.Request(url, data=body, method="PATCH")
req.add_header("Authorization", "Bearer " + tok)
req.add_header("Content-Type", "application/json")
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        r.read()
    print("ok")
except urllib.error.HTTPError as e:
    print("HTTP %s: %s" % (e.code, e.read().decode("utf-8", "replace")[:300]))
    sys.exit(1)
except Exception as e:
    print(str(e)[:300]); sys.exit(1)
PC_ALLOW_PY
    ); then
      echo "  allowed accounts: $ACCT$PC_EXTRA_EMAILS"
    else
      echo "  WARNING: could not seed the allowed-account list ($PC_ALLOW_OUT); add the addresses in Settings."
    fi
  fi
  PC_ALLOW_TOK=""
fi

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
#
# [SEC-EXEC-RPID-INSTALL-V1] PC_RP_ID IS SET HERE, AND ITS VALUE IS $CP_HOST -- THE CONSOLE.
# It was set NOWHERE. This line was the only place gate-exec was given any environment, and
# the comment 40 lines below has always listed PC_RP_ID as part of that environment, so the
# tree DESCRIBED a variable it never wrote. exec_server.py reads it twice: /selftest defaults
# it to the literal 'example.invalid', and the PC_REQUIRE_ASSERTION path calls
# pcwebauthn.verify(..., os.environ.get("PC_RP_ID", "")) -- an EMPTY relying party. So every
# install to date failed its own F5.4 check and armed an executor that would verify passkey
# assertions against a relying party that is not the gate. A silent wrong default, not an
# error, which is exactly why nothing reported it.
#
# WHY THE CONSOLE HOST AND NOT THE EXECUTOR'S OWN. A WebAuthn RP ID is not "the host of the
# service doing the checking"; it is the host the CREDENTIAL WAS REGISTERED AGAINST, and it
# is baked into every assertion the authenticator signs. The gate is served by the console,
# so 6/10 writes WA_RP_ID=$CP_HOST on both surfaces (the note above that deploy says exactly
# this), index.ts feeds WA_RP_ID to generateAuthenticationOptions and
# verifyRegistrationResponse as rpID, and pcwebauthn.verify() then refuses with 'rpIdHash
# mismatch' unless sha256(PC_RP_ID) equals the first 32 bytes of authenticatorData -- i.e.
# unless PC_RP_ID is the console host, byte for byte. $GX_URL's host and $MC_HOST are both
# wrong here and would fail closed on every approval. This is also what the rehearsal
# harness asserts, F5.4: executor PC_RP_ID must EQUAL control-plane WA_RP_ID.
#
# EMPTY IS NOT REACHABLE HERE. CP_HOST is derived at 5/10 from a CP_URL that step already
# asserts non-empty before continuing, and die() exits on every path including --rehearse,
# so nothing arrives at this line with an empty console host.
#
# [SEC-EXEC-NO-DATASTORE-V1] PC_FIRESTORE_DB IS NO LONGER SET ON THIS SERVICE. It named the
# database for a firestore.Client() that no longer exists; exec_server.py reads the variable
# nowhere. Leaving it would be a Firestore database name configured on a service with no
# Firestore client and no Firestore role -- the exact residue that makes a future reader
# think the dependency is still there and reach for it. The control plane and the MCP surface
# still set it, because they still hold the read.
retry gcloud run deploy "$GX_SVC" --source "$HERE/gate-exec" --region "$REGION" --project "$PROJECT" \
  --service-account "$GX_SA" --no-allow-unauthenticated --quiet \
  --set-env-vars "PC_REQUIRE_ASSERTION=0,PC_RP_ID=$CP_HOST,PC_EXEC_BUCKET=$PC_EXEC_BUCKET,PC_CREDS_SECRET=projects/$PROJECT/secrets/$PC_SEC_CREDS,PC_LOCKOUT_CP_SVC=$CP_SVC,PC_LOCKOUT_MC_SVC=$MC_SVC,PC_LOCKOUT_SERVICES=$CP_SVC $MC_SVC $GX_SVC" \
  >/dev/null || die "gate-exec deploy failed"
# [GCP-LOCKOUT-CHECK-V1] THE LOCKOUT CHECKER IS CONFIGURED HERE, FOR THE REASON THE
# PARAGRAPH BELOW GIVES ABOUT PC_REQUIRE_ASSERTION. gate-exec/lockout_check.py runs
# pre-execute on EVERY job body and is deliberately fail-closed: two of its nine rules
# (LC1 service-rename, LC9 env-clobber) cannot judge a body without knowing which service
# names this install legitimately operates, so with the list unset they REFUSE and name the
# variable rather than passing quietly. That is the correct direction for a control and the
# wrong experience for a fresh install, which would refuse its own first `run deploy`. So
# the installer -- which is the one thing that KNOWS these names -- writes them. An install
# that had to be hand-configured before its checker worked is an install whose checker
# spends its first week switched off.
#
# The three names are exactly the services this script creates. An operator who later adds a
# fourth service extends PC_LOCKOUT_SERVICES; until they do, a deploy naming it is treated as
# a service-rename shape and routed to a human, which is the safe reading of an unknown name.
# [SEC-INSTALL-IAP-V1] PC_REQUIRE_ASSERTION is set HERE, at install, deliberately.
# It defaults to OFF in code, which means any redeploy that forgets it silently disables
# the executor's independent approval check. That is exactly what happened during
# testing on 2026-08-04: an uninstall/reinstall cycle dropped every PC_* variable and the
# control turned itself off without a word. A security control that is off unless someone
# remembers a flag is a control that will be off. The default should flip to ON in code
# once the control plane forwards assertions; until then the installer must set it.
# [SEC-GXWRITE-CHECK-V1] || die, AND IT IS THE MOST LOAD-BEARING ONE IN THIS STEP. There is no
# set -e, so this binding could fail and the install would sail on and report INSTALL COMPLETE.
# Worse, 10/10's only assertion about the executor is `chk_in "executor is private" "403 404"`,
# and an UNBOUND control plane produces exactly the 403 that check calls a pass -- the check
# gets GREENER the more broken the binding is. So the write is checked here or it is never
# checked at all, and the operator learns on their first approved job.
retry gcloud run services add-iam-policy-binding "$GX_SVC" --region "$REGION" --project "$PROJECT" \
  --member="serviceAccount:$CP_SA" --role=roles/run.invoker >/dev/null \
  || die "could not grant $CP_SA roles/run.invoker on $GX_SVC. Without it the control plane
cannot call the executor, so every approved job fails at dispatch with a 403. 10/10 would NOT
have caught this: its only executor check asserts the executor is private, and an unbound
control plane is the most private of all."
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
  --update-env-vars "GATE_EXEC_URL=$GX_URL" >/dev/null \
  || die "could not set GATE_EXEC_URL on $CP_SVC. The console dispatches every approved job
from the gate, so leaving it unset means the gate approves and nothing runs."
retry gcloud run services update "$MC_SVC" --region "$REGION" --project "$PROJECT" \
  --update-env-vars "GATE_EXEC_URL=$GX_URL" >/dev/null \
  || die "could not set GATE_EXEC_URL on $MC_SVC. The MCP service stages from the tool surface
and fires from the agent API, so leaving it unset breaks every machine-side dispatch."
echo "  $GX_URL  (private; only the console and the MCP service may call it)"
# [SEC-INSTALL-ARCHIVE-SA-V46] PC_ARCHIVE_ALLOWED_SA IS SET HERE, NOT FOLDED INTO THE
# --set-env-vars STRING ABOVE, AND THIS COMMENT EXISTS BECAUSE IT WAS FOLDED IN AND IT BROKE
# EVERY FRESH INSTALL.
#
# MEASURED on a genuinely fresh project, 2026-08-15, at 6/10:
#   ERROR: (gcloud.run.deploy) argument --set-env-vars: Bad syntax for dict arg:
#   [<projnum>@cloudbuild.gserviceaccount.com]
# The console deployed, the MCP service did not, and the install died having built an image
# it could not finish deploying.
#
# THE CAUSE IS THE RULE THE BLOCK BELOW ALREADY STATES: the value legitimately contains a
# COMMA -- it names BOTH build identities, compute-default and cloudbuild, because which one
# a build runs as depends on project age -- and a comma inside a --set-env-vars value is a
# SEPARATOR. gcloud split it and read the second service account as a key with no value.
# The rule was written down for APPROVAL_SIG_KEY_VERSIONS and then broken by the very next
# variable that needed it, which is the ordinary way a documented rule fails.
#
# WHY ';' AND NOT THE '@' USED BELOW: '@' is a fine delimiter for KMS key versions because a
# key version cannot contain one. EVERY SERVICE ACCOUNT EMAIL CONTAINS '@', so ^@^ here would
# split the data on its own first character. A service account email cannot contain ';'.
# That is the whole reason the two lines use different delimiters, and it is not a style
# inconsistency to be tidied away later.
#
# WHY THIS WAS NOT CAUGHT: the fleet's own prod carries this variable set correctly, because
# it was set by hand through a path that does not use --set-env-vars. Prod was running a
# configuration no install could produce -- the same failure shape this installer already
# names in three other places -- and only a from-zero install on a fresh project exposes it.
retry gcloud run services update "$MC_SVC" --region "$REGION" --project "$PROJECT" \
  --update-env-vars "^;^PC_ARCHIVE_ALLOWED_SA=$PC_ARCHIVE_SA_ALLOW" >/dev/null \
  || die "could not set PC_ARCHIVE_ALLOWED_SA on $MC_SVC. Without it GET /git/archive fails
closed for every caller, so a build can never fetch the repository over IAM."
echo "  archive allowlist: both build identities may fetch the tree over IAM"
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
#
# [SEC-EXEC-NO-DATASTORE-V1] APPROVAL_REQUIRE_SIGNED IS NO LONGER OPTIONAL, AND AN INSTALL
# THAT CANNOT ARM IT IS A FAILED INSTALL RATHER THAN A PERMISSIVE ONE.
#
# WHY IT CHANGED. It used to be a migration dial: the executor's "absent signature" rung
# allowed, because approved_sha256 -- re-read from a job document this service could not
# write -- still pinned the command. That pin is gone. The executor no longer reads the
# document; the approval arrives in the request body, so the caller now supplies BOTH the
# command and the digest that is supposed to pin it, and both sides in one hand is not a pin.
# The signature is the only thing left that a caller cannot restate, so it is required.
#
# THE EXECUTOR ENFORCES THIS ITSELF -- pc_arming_refusal() refuses every job and reports
# unhealthy on /healthz unless APPROVAL_REQUIRE_SIGNED=1 -- so an install that skipped this
# would not ship an unpinned executor, it would ship a dead one. Dying HERE, with a message
# that names the cause, is the difference between an operator who knows why and an operator
# staring at a service that 503s every approval.
pc_unsigned_fail() {
  if [ "$PC_REHEARSE" = 1 ]; then
    echo "  APPROVAL_REQUIRE_SIGNED NOT ARMED: $1"
    echo "  Permitted under --rehearse ONLY. The executor will REFUSE EVERY JOB in this state"
    echo "  and report 503 on /healthz -- it fails closed, it does not run unpinned."
  else
    die "the executor cannot be armed and this installer will not leave it unarmed.
  $1
Since roles/datastore.user was removed from the executor it no longer reads the approval it
runs from Firestore: the approval arrives in the request body, and the ONLY field in it that
a caller cannot simply restate is the approval signature. So APPROVAL_REQUIRE_SIGNED=1 is a
requirement rather than a posture, and the executor refuses every job without it.
Provision approval signing (do not pass PC_APPROVAL_SIG_KEY_VERSION unless you mean to pin a
key yourself), or re-run with --rehearse if you are deliberately building an installation
that is not expected to execute anything."
  fi
}
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
    # [PC-APPROVAL-CANON-V2] ARMED AFTER APPROVAL_REQUIRE_SIGNED, FOR THE SAME REASON AND
    # IN THE SAME PLACE. APPROVAL_ACCEPT_CANON_V1 turns the executor's acceptance of the
    # OLD canon -- the one that signed the command TEXT but neither command_type nor the
    # arguments -- from allow into refuse. Writing it before the key-version updates above,
    # or on a run that could not provision a key, would refuse approvals this install has
    # not yet made signable. A FRESH INSTALL HAS NO V1 APPROVALS TO BREAK, so refusing them
    # costs nothing here and the deployment never spends a day accepting a stamp that does
    # not cover the destination.
    # AN EXISTING DEPLOYMENT UPGRADING IN PLACE LEAVES THIS UNSET and migrates: unset reads
    # as 1, i.e. a V1 stamp is still accepted -- and even then only for local execution,
    # because a V1 stamp never covered the destination and the executor refuses it for any
    # non-local job whatever this variable says. [SEC-SSHTOOL-REMOVED-V1] there is only a
    # local branch today, so that refusal is a standing guard for the next one, not dead code.
    retry gcloud run services update "$GX_SVC" --region "$REGION" --project "$PROJECT" \
      --update-env-vars "APPROVAL_ACCEPT_CANON_V1=0" >/dev/null \
      || die "could not set APPROVAL_ACCEPT_CANON_V1 on $GX_SVC"
    echo "  APPROVAL_ACCEPT_CANON_V1=0 -- only PC-APPROVAL-CANON-V2 stamps are accepted, so"
    echo "  every approval that runs here has its command TYPE and ARGUMENTS signed as well."
  else
    pc_unsigned_fail "approval signing is provisioned on this install but
PC_APPROVAL_REQUIRE_SIGNED=0 was passed, which disarms the one control the executor now
depends on."
  fi
else
  pc_unsigned_fail "approval signing was NOT provisioned on this install, so no key exists to
sign approvals with and APPROVAL_REQUIRE_SIGNED cannot be armed."
fi
# [SEC-GXWRITE-CHECK-V1] THE READ-BACK THAT REPLACES A SENTENCE OF ADVICE. This step used to
# print "READ BOTH BACK off the serving revisions before trusting them" -- an instruction to a
# human, standing in for a check, in a script that has no set -e. It is now a check, in the
# SAME SHAPE 6/10 already uses for DATA_LAKE_BUCKET: describe the revision that is actually
# serving and compare the value, because a deploy that reports success and a revision that
# carries the value are two different facts and only the second is worth anything.
#
# THE REVISIONS ARE RE-READ RATHER THAN REUSED. Every update above minted a NEW revision, so
# PC_CP_REV and PC_MC_REV from 6/10 are stale by now and asserting against them would prove
# something about a revision nobody is serving.
PC_GX_CPREV=$(gcloud run services describe "$CP_SVC" --region "$REGION" --project "$PROJECT" \
  --format='value(status.latestReadyRevisionName)' 2>/dev/null); PC_GXCR_RC=$?
[ "$PC_GXCR_RC" -eq 0 ] || die "could not read the console revision name after 7/10 (exit $PC_GXCR_RC)."
[ -n "$PC_GX_CPREV" ] || die "the console reports no ready revision after 7/10."
PC_GXJ_CP=$(gcloud run revisions describe "$PC_GX_CPREV" --region "$REGION" --project "$PROJECT" \
  --format=json 2>/dev/null); PC_GXJC_RC=$?
[ "$PC_GXJC_RC" -eq 0 ] || die "could not describe revision $PC_GX_CPREV (exit $PC_GXJC_RC)."
PC_GX_MCREV=$(gcloud run services describe "$MC_SVC" --region "$REGION" --project "$PROJECT" \
  --format='value(status.latestReadyRevisionName)' 2>/dev/null); PC_GXMR_RC=$?
[ "$PC_GXMR_RC" -eq 0 ] || die "could not read the MCP revision name after 7/10 (exit $PC_GXMR_RC)."
[ -n "$PC_GX_MCREV" ] || die "the MCP service reports no ready revision after 7/10."
PC_GXJ_MC=$(gcloud run revisions describe "$PC_GX_MCREV" --region "$REGION" --project "$PROJECT" \
  --format=json 2>/dev/null); PC_GXJM_RC=$?
[ "$PC_GXJM_RC" -eq 0 ] || die "could not describe revision $PC_GX_MCREV (exit $PC_GXJM_RC)."
PC_GX_SEEN_CP=$(printf '%s' "$PC_GXJ_CP" | python3 -c 'import sys,json
d = json.load(sys.stdin)
cs = ((d.get("spec") or {}).get("containers")) or []
e = dict((x.get("name",""), x.get("value","")) for c in cs for x in (c.get("env") or []))
print(e.get("GATE_EXEC_URL","") or "UNSET")' 2>/dev/null)
PC_GX_SEEN_MC=$(printf '%s' "$PC_GXJ_MC" | python3 -c 'import sys,json
d = json.load(sys.stdin)
cs = ((d.get("spec") or {}).get("containers")) or []
e = dict((x.get("name",""), x.get("value","")) for c in cs for x in (c.get("env") or []))
print(e.get("GATE_EXEC_URL","") or "UNSET")' 2>/dev/null)
[ "$PC_GX_SEEN_CP" = "$GX_URL" ] || die "revision $PC_GX_CPREV of $CP_SVC is serving
GATE_EXEC_URL='$PC_GX_SEEN_CP', and it must serve '$GX_URL'. The update reported success and the
value did not arrive, so the gate would approve a job and the console would dispatch it nowhere."
[ "$PC_GX_SEEN_MC" = "$GX_URL" ] || die "revision $PC_GX_MCREV of $MC_SVC is serving
GATE_EXEC_URL='$PC_GX_SEEN_MC', and it must serve '$GX_URL'. Every machine-side dispatch --
stage_privileged_job and the agent job API -- reaches for that value."
echo "  $PC_GX_CPREV and $PC_GX_MCREV both serve GATE_EXEC_URL=$GX_URL (read off the"
echo "  serving revisions, not asserted)"
if [ -n "$PC_SIG_KV" ]; then
  PC_SIG_SEEN_CP=$(printf '%s' "$PC_GXJ_CP" | python3 -c 'import sys,json
d = json.load(sys.stdin)
cs = ((d.get("spec") or {}).get("containers")) or []
e = dict((x.get("name",""), x.get("value","")) for c in cs for x in (c.get("env") or []))
print(e.get("APPROVAL_SIG_KEY_VERSION","") or "UNSET")' 2>/dev/null)
  PC_SIG_SEEN_MC=$(printf '%s' "$PC_GXJ_MC" | python3 -c 'import sys,json
d = json.load(sys.stdin)
cs = ((d.get("spec") or {}).get("containers")) or []
e = dict((x.get("name",""), x.get("value","")) for c in cs for x in (c.get("env") or []))
print(e.get("APPROVAL_SIG_KEY_VERSION","") or "UNSET")' 2>/dev/null)
  [ "$PC_SIG_SEEN_CP" = "$PC_SIG_KV" ] || die "revision $PC_GX_CPREV of $CP_SVC is serving
APPROVAL_SIG_KEY_VERSION='$PC_SIG_SEEN_CP' rather than the version 5b/10 provisioned. An
approval signed with a key the executor does not accept is an approval that never executes."
  [ "$PC_SIG_SEEN_MC" = "$PC_SIG_KV" ] || die "revision $PC_GX_MCREV of $MC_SVC is serving
APPROVAL_SIG_KEY_VERSION='$PC_SIG_SEEN_MC' rather than the version 5b/10 provisioned."
  echo "  both surfaces also serve APPROVAL_SIG_KEY_VERSION (read back, not asserted)"
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
# [SEC-IAP-RERUN-V54] CLEAR IAP BEFORE ASSERTING, BECAUSE THIS STEP USED TO ASSUME A FRESH
# PROJECT AND BROKE EVERY RE-RUN. MEASURED 2026-08-15 on a real install: run 2 reached this
# step and enabled IAP; run 3 then probed /harness, got IAP's own 302 to the Google sign-in
# page instead of the app's 401, and REFUSED -- correctly, on the evidence it had, since it
# genuinely could not see the guard. But the condition is permanent: once 8/10 succeeds once,
# every later run of this installer fails here forever, and the operator is told his console
# guard is broken when it is fine.
#
# The fix is the doctrine this same step already applies to the MCP service twenty lines down,
# quoted from it: "Set NEGATIVELY and unconditionally, so an upgrade over a service that
# already has IAP on is corrected rather than left broken." The assertion NEEDS an anonymous
# request to reach the app, so clear IAP first, unconditionally. On a fresh install IAP was
# never on and this is a harmless no-op; on a re-run it is the difference between working and
# refusing. IAP is re-applied unconditionally below in the same step, so the console does not
# stay open -- and 6/10 re-adds the allUsers invoker binding on every run, which is what makes
# the app reachable enough to answer at all.
PC_IAP_PRECLEAR_RC=0
gcloud beta run services update "$CP_SVC" --region "$REGION" --project "$PROJECT" --no-iap --quiet >/dev/null 2>&1 || PC_IAP_PRECLEAR_RC=$?
if [ "$PC_IAP_PRECLEAR_RC" -ne 0 ]; then
  echo "  note: clearing IAP before the guard assertion exited $PC_IAP_PRECLEAR_RC -- expected"
  echo "        on a first install, where IAP was never on."
fi
# A GROWING BACKOFF, AND IT SAYS WHAT IT IS DOING. An IAP toggle is not instant, and a silent
# probe is indistinguishable from a hung one -- the operator watched an earlier step sit
# wordless for minutes and reasonably concluded the installer was dead. Each attempt is
# announced, the wait doubles, and the total is bounded at roughly 90s.
PC_HARNESS_CODE=""
PC_HARNESS_WAIT=3
for PC_HARNESS_TRY in 1 2 3 4 5 6; do
  PC_HARNESS_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$CP_URL/harness" 2>/dev/null)
  case "$PC_HARNESS_CODE" in
    401|403) break ;;
  esac
  if [ "$PC_HARNESS_TRY" -lt 6 ]; then
    echo "  guard probe $PC_HARNESS_TRY/6: /harness answered ${PC_HARNESS_CODE:-no-response}; waiting ${PC_HARNESS_WAIT}s for the IAP change to propagate"
    sleep "$PC_HARNESS_WAIT"
    PC_HARNESS_WAIT=$((PC_HARNESS_WAIT * 2))
  fi
done
case "$PC_HARNESS_CODE" in
  401)
    echo "  console: /harness answers an anonymous caller 401 with the locked page -- the app's"
    echo "           own guard answers."
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
    die "the console at $CP_URL/harness answered $PC_HARNESS_CODE to an ANONYMOUS caller,
after IAP was cleared and the probe was retried 6 times over ~90s.
Underneath IAP the app's own passkey session is what protects the console, and that guard is
not answering. Refusing to continue rather than put IAP in front of a console that would be
readable by anyone the moment IAP came off.
A 30x here means IAP is STILL in front of the app despite the clear above -- check for an
organization policy that re-applies it, or clear it by hand and re-run:
    gcloud beta run services update $CP_SVC --region $REGION --project $PROJECT --no-iap"
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
# [SEC-INVOKER-RECORD-V1] CAPTURE THE REFUSAL INSTEAD OF THROWING IT AWAY.
# This line used to end `>/dev/null 2>&1` and keep nothing but the exit code, so the one
# sentence that says WHY the binding is absent -- "FAILED_PRECONDITION: One or more users
# named in the policy do not belong to a permitted customer", which is what
# constraints/iam.allowedPolicyMemberDomains answers -- existed nowhere but this terminal.
# devgate's F6.7 asks whether allUsers holds roles/run.invoker on the MCP service, and it
# ALREADY excuses a missing binding when the evidence bundle RECORDS an org-policy refusal
# (smoke.py:_invoker_refusal reads surfaces.mcp.allusers_refusal). Nothing ever wrote that
# key, so in a domain-restricted-sharing org F6.7 failed on every run and could do nothing
# else. THE REFUSAL IS A FACT ONLY THIS PROCESS CAN OBSERVE: it is produced by ATTEMPTING
# the write, and pipeline/collect-evidence.py is read-only and cannot honestly manufacture
# it. So it is captured here, VERBATIM, and the judge classifies the literal text itself --
# this script does not get to vote on its own verdict.
PC_MC_INV_ERR=$(retry gcloud run services add-iam-policy-binding "$MC_SVC" --region "$REGION" --project "$PROJECT" --member=allUsers --role=roles/run.invoker --condition=None 2>&1) || PC_MC_INV_RC=$?
if [ "$PC_MC_INV_RC" = "0" ]; then
  # The SUCCESS payload is the whole IAM policy, which names real principals. It answers
  # nothing F6.7 asks -- the collector reads the live policy itself -- so it is dropped here
  # rather than carried into the lake.
  PC_MC_INV_ERR=""
  PC_MC_INV_OUTCOME="granted"
  echo "  $MC_SVC accepts unauthenticated connections; the app does its own bearer auth."
else
  # The classification is recorded ALONGSIDE the literal text, never INSTEAD of it. smoke.py
  # matches its own ORG_POLICY_MARKERS against the stderr, so a refusal that is not the
  # org-policy refusal still FAILS F6.7 whatever this case statement decided.
  case "$(printf '%s' "$PC_MC_INV_ERR" | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz')" in
    *failed_precondition*|*"do not belong to a permitted customer"*|*allowedpolicymemberdomains*|*"domain restricted sharing"*|*"organization policy"*)
      PC_MC_INV_OUTCOME="refused-by-org-policy" ;;
    *)
      PC_MC_INV_OUTCOME="refused-other" ;;
  esac
  echo "  WARNING: could not grant allUsers roles/run.invoker on $MC_SVC (exit $PC_MC_INV_RC)."
  echo "  Every MCP client will get a Google 403 before a byte reaches the app. Grant it:"
  echo "    gcloud run services add-iam-policy-binding $MC_SVC --region $REGION --project $PROJECT --member=allUsers --role=roles/run.invoker --condition=None"
  echo "  An organization policy on constraints/iam.allowedPolicyMemberDomains blocks this."
  echo "  Classified as: $PC_MC_INV_OUTCOME"
fi
# ---- and RECORD that outcome where the evidence collector can read it ----
# WRITTEN ON EVERY PATH, INCLUDING SUCCESS, AND THAT IS THE FAIL-CLOSED HALF. A record
# written only when the grant FAILS goes stale in the one direction that matters: a project
# refused once and fixed since would keep excusing a service that is now broken for some
# OTHER reason. Rewriting it every run means the record describes THIS run, or does not exist.
#
# WHICH PREFIX IT GOES UNDER IS A SECURITY PROPERTY, NOT A CONVENTION. resolveKey() in
# index.ts REFUSES tool-surface writes under the nine LAKE_EXEC_PREFIXES, and the prefix
# below is one of them. This object is the only thing that can turn devgate F6.7 from a FAIL
# into a NOT-EXERCISED, so a prefix the lake tools let any role write is a prefix any agent
# could use to buy itself a green -- which is exactly what devgate's own probe prefix is.
# The prefix below is also NOT one of the five VAULT_CLEARTEXT_PREFIXES, so it buys no
# plaintext exemption. This write goes to GCS with the operator's own credentials and never
# passes through resolveKey at all, which is why a write-denied prefix is still writable here.
PC_MC_INV_OBJ="shared/security/devgate/allusers-invoker.json"
PC_MC_INV_TMP="$HERE/.allusers-invoker.tmp"
PC_MC_INV_WROTE=0
PC_INV_OUTCOME="$PC_MC_INV_OUTCOME" PC_INV_RC="$PC_MC_INV_RC" PC_INV_ERR="$PC_MC_INV_ERR" \
PC_INV_SVC="$MC_SVC" PC_INV_PROJECT="$PROJECT" PC_INV_REGION="$REGION" \
PC_INV_RELEASE="$PC_RELEASE" PC_INV_OUT="$PC_MC_INV_TMP" \
python3 - <<'PC_INV_REC_EOF' || PC_MC_INV_WROTE=1
import json, os, time


def txt(s):
    # gcloud stderr is whatever the API sent. os.environ decodes with surrogateescape, and a
    # surrogate would make json.dump raise -- losing the whole record over one stray byte.
    return s.encode("utf-8", "surrogateescape").decode("utf-8", "replace")


rec = {
    "schema": "pc.allusers-invoker.v1",
    "written_by": "install.sh 8/10",
    "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "release": txt(os.environ.get("PC_INV_RELEASE", "")),
    "project": txt(os.environ["PC_INV_PROJECT"]),
    "region": txt(os.environ["PC_INV_REGION"]),
    # THE SERVICE THIS IS ABOUT. The collector refuses a record naming a different service,
    # so a leftover object from another lane cannot excuse this one.
    "service": txt(os.environ["PC_INV_SVC"]),
    "member": "allUsers",
    "role": "roles/run.invoker",
    "outcome": txt(os.environ["PC_INV_OUTCOME"]),
    "gcloud_exit": int(os.environ["PC_INV_RC"] or 0),
    # THE LITERAL TEXT, NEVER A SUMMARY. smoke.py classifies it against its own
    # ORG_POLICY_MARKERS; a paraphrase would either match no marker (fail closed, merely
    # useless) or be written to match them, which is this script grading itself.
    "gcloud_stderr": txt(os.environ["PC_INV_ERR"])[:4000],
}
with open(os.environ["PC_INV_OUT"], "w") as fh:
    json.dump(rec, fh, indent=2, sort_keys=True)
    fh.write("\n")
PC_INV_REC_EOF
if [ "$PC_MC_INV_WROTE" = "0" ]; then
  gcloud storage cp "$PC_MC_INV_TMP" "gs://$PC_LAKE_BUCKET/$PC_MC_INV_OBJ" --project "$PROJECT" >/dev/null 2>&1 || PC_MC_INV_WROTE=1
fi
rm -f "$PC_MC_INV_TMP"
if [ "$PC_MC_INV_WROTE" = "0" ]; then
  echo "  recorded that outcome ($PC_MC_INV_OUTCOME) at gs://$PC_LAKE_BUCKET/$PC_MC_INV_OBJ"
else
  echo "  WARNING: could not record the allUsers invoker outcome at"
  echo "  gs://$PC_LAKE_BUCKET/$PC_MC_INV_OBJ. Nothing in the install is broken by that, but"
  echo "  devgate F6.7 now has no record to read and will FAIL on the missing binding rather"
  echo "  than report the refusal. That is fail-closed and it is the intended direction."
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
echo "  console  $CP_URL      behind IAP -- sign in with $ACCT"
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
# The self-test at 10/10 invoked ZERO MCP tools. It checked that the console refuses, that
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
# [SEC-FAILSTATE-PERCHECK-V1] The NAMES of the checks that failed, space separated, carried
# to 10/10 beside the count so the closing summary can print what it is counting.
PC_FUNC_FAILED=""
PC_FUNC_AT=$(gcloud auth print-access-token --project "$PROJECT" 2>/dev/null)
if [ -z "$PC_FUNC_AT" ]; then
  echo "  FAIL  could not obtain an access token, so the functional phase cannot mint the"
  echo "        throwaway identity it needs. The tool surface was NOT proven."
  PC_FUNC_FAIL=1
  PC_FUNC_FAILED="FN.SELFTEST_TOKEN"
else
  PC_FUNC_URL="$MC_URL" PC_FUNC_CONSOLE="$CP_URL" PC_FUNC_IAP="$PC_IAP_ON" \
  PC_FUNC_PROJECT="$PROJECT" PC_FUNC_DB="$FSDB" PC_FUNC_FAILFILE="$HERE/.fn.tmp" \
  PC_FUNC_LAKE="$PC_LAKE_BUCKET" PC_FUNC_ROLE="fleet-onboarder" PC_FUNC_AT="$PC_FUNC_AT" \
  PC_FUNC_HERE="$HERE" PC_FUNC_MINTED="$PC_VAULT_MINTED" \
  python3 - <<'PCFUNC'
import difflib, hashlib, json, os, secrets, subprocess, sys, time, urllib.error, urllib.request

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
# [SEC-KEMPREREQ-V1] 1 only where 5e/10 proved the vault master is present.
MINTED = os.environ.get("PC_FUNC_MINTED", "0") == "1"
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
    "FN.STAGE_TOOLS": "stage_privileged_job and run_command each need a human passkey with "
                      "user presence. No approval is produced or verified here.",
}

KNOWN = ("whoami read_graph search_nodes open_nodes list_work_items read_journal "
         "list_pending_confirm read_file list_files read_history search_history get_time "
         "read_job_log run_status list_my_messages check_answer "
         "create_entities create_relations add_observations delete_entities "
         "delete_observations delete_relations append_journal post_work_item "
         "complete_work_item cancel_work_item log_history write_file put_file "
         "answer_message ask_agent refresh stage_privileged_job run_command "
         "gcp_api run_roll "
         "gh_whoami gh_repos gh_read gh_list gh_log gh_diff gh_commit gh_branch "
         "gh_fork gh_pr gh_tag gh_release").split()
GIT_TOOLS = "git_read git_list git_log git_grep git_diff git_archive git_propose git_propose_patch git_push".split()

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


class _PCNoRedirect(urllib.request.HTTPRedirectHandler):
    # [SEC-IAPCHECK-NOFOLLOW-V1] RETURNING None MAKES urllib RAISE THE 3xx AS AN HTTPError
    # INSTEAD OF FOLLOWING IT, which http()'s existing except branch already turns into a
    # normal (status, headers, body) triple. So the redirect becomes an ANSWER rather than a
    # step on the way to someone else's answer.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_PC_NOFOLLOW = urllib.request.build_opener(_PCNoRedirect)


def http(url, method="GET", body=None, hdrs=None, timeout=90, follow=True):
    # [SEC-IAPCHECK-NOFOLLOW-V1] follow=False EXISTS BECAUSE A CHECK THAT ASSERTS ON A
    # REDIRECT'S OWN HEADERS CANNOT USE A TRANSPORT THAT FOLLOWS REDIRECTS. urllib.request's
    # default opener includes HTTPRedirectHandler, so urlopen silently follows IAP's 302 to
    # accounts.google.com and returns GOOGLE'S SIGN-IN PAGE -- HTTP 200, carrying none of
    # IAP's headers. FN.CONSOLE_IAP then read that final response, found no
    # x-goog-iap-generated-response, and reported a CORRECTLY GUARDED CONSOLE AS FAIL. Worse,
    # its deadline loop re-probed for the full 180 seconds first, so every install paid three
    # minutes to reach a verdict that could never have been anything else. MEASURED on a real
    # adopter install 2026-08-15; the console was answering 302 with the header all along.
    # RULE THIS ENCODES: assert on the FIRST response whenever the thing being proven IS the
    # refusal. Anything that can be transparently substituted by the transport is not evidence.
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (hdrs or {}).items():
        req.add_header(k, v)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        r = (urllib.request.urlopen(req, timeout=timeout) if follow
             else _PC_NOFOLLOW.open(req, timeout=timeout))
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
# [SEC-GITSEED-INSTALL-V1] 900 SECONDS, RAISED FROM 300. FN.GIT_SEED below writes the whole
# release tree over this identity in tens of small requests, and a credential that lapses
# half way through would turn a working seed into a partial one. It is still a throwaway
# that exists only in this process's memory and is deleted in the finally below; what
# widened is a window measured in minutes, not the authority behind it.
EXP = int(time.time() * 1000) + 900000
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


def call(name, args, key=None):
    a = dict(args)
    a["agent"] = key or KEY
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
    # [SEC-IAP-RACE-V1] THIS CHECK USED TO RACE THE THING IT MEASURES, AND THAT RACE IS THE
    # ROOT CAUSE OF THE MCP-URL ORDEAL. One probe, fired seconds after 8/10 turned IAP on.
    # IAP ENFORCEMENT PROPAGATES ASYNCHRONOUSLY: for some tens of seconds after the enable
    # call returns, the edge still passes an anonymous request through to the app. On a fast
    # machine this single probe therefore read the app's own answer from a console that was
    # about to be guarded and recorded a FALSE `FAIL FN.CONSOLE_IAP`. Printing the connector
    # URL unconditionally fixed the CONSEQUENCE of that false red. This fixes the cause.
    #
    # A CHECK THAT RACES ITS SUBJECT IS WRONG IN BOTH DIRECTIONS, so this loop is built to be
    # wrong in NEITHER:
    #   - it EXITS THE INSTANT it sees an IAP-shaped refusal. The property is proven the
    #     moment it is true, and more waiting cannot un-prove it, so a guarded console is
    #     never made slower than one probe by this.
    #   - a genuinely unguarded console STILL FAILS. The loop runs to a DEADLINE and then
    #     reports the LAST observation. Waiting longer on an open console makes the FAIL
    #     arrive later; it never turns it into a pass, and there is no "not yet" verdict to
    #     hide in. That is the half a retry loop usually gets wrong.
    # The wait is bounded and reported, so a console that took 90 seconds to come under IAP
    # says so rather than passing silently as though it had been guarded all along.
    PC_IAP_DEADLINE = 180.0
    _iap_t0 = time.time()
    _iap_wait = 2.0
    _iap_tries = 0
    while True:
        cst, ch, _cb = http(CONSOLE + "/harness", "GET", None, {}, 45, follow=False)
        _iap_tries += 1
        if "x-goog-iap-generated-response" in ch:
            break
        _iap_left = PC_IAP_DEADLINE - (time.time() - _iap_t0)
        if _iap_left <= 0:
            break
        time.sleep(min(_iap_wait, _iap_left))
        _iap_wait = min(_iap_wait * 2, 15.0)
    _iap_el = time.time() - _iap_t0
    _iap_evidence = (" Probed for %.0fs across %d attempt(s)."
                     % (_iap_el, _iap_tries))
    if "x-goog-iap-generated-response" in ch:
        rec("PASS", "FN.CONSOLE_IAP", "EXERCISED",
            "IAP answered " + str(cst) + " for an anonymous caller at the console edge."
            + _iap_evidence
            + (" IAP was NOT yet enforcing on the first probe -- this is the propagation "
               "window, and it is why one probe used to fail falsely here."
               if _iap_tries > 1 else ""))
    elif cst in (401, 302, 303):
        rec("FAIL", "FN.CONSOLE_IAP", "EXERCISED",
            "the console answered " + str(cst) + " but WITHOUT x-goog-iap-generated-response, so "
            "that refusal came from the app, not from IAP. The status code alone would have "
            "passed this check, which is exactly why it is not the assertion. The console is "
            "not behind IAP and there is no bootstrap path protected at the edge."
            + _iap_evidence
            + " That is longer than IAP takes to propagate, so this is not the race.")
    else:
        rec("FAIL", "FN.CONSOLE_IAP", "EXERCISED",
            "the console answered " + str(cst) + " to an anonymous caller with no IAP header. "
            "Anything other than an IAP refusal here means the edge is not guarding it."
            + _iap_evidence
            + " That is longer than IAP takes to propagate, so this is not the race.")

MINTED = False
if any(f[0] == "FAIL" and f[1] == "FN.MCP_REACHABLE" for f in FINDINGS):
    for i in ("FN.WHOAMI", "FN.TOOL_CENSUS", "FN.MEMORY_GRAPH", "FN.LAKE_LIST"):
        rec("NOT-EXERCISED", i, "EXERCISED", "the MCP surface is unreachable -- see FN.MCP_REACHABLE")
        UNEXERCISABLE[i] = "blocked by FN.MCP_REACHABLE, which is itself FAIL"
else:
    # THROWAWAY IDENTITIES, AND WHY THEY ARE SAFE. Three Firestore documents whose IDs are
    # sha256 of a random secret, holding a 900-second exp. The secrets exist only in this
    # process's memory, are never printed and never written to disk; all three documents
    # are deleted below. If this process is killed part way, the records are inert the
    # moment the exp passes -- oaBearerRole and pcSessionLookup BOTH fail closed on them.
    #
    # [SEC-GITSEED-ROLE-V120] WHY THERE IS A SECOND SESSION KEY. TOK and KEY are bound to
    # ROLE, which is fleet-onboarder -- deliberately, because FN.WHOAMI and FN.TOOL_CENSUS
    # exist to measure what an UNBOUND OAuth connector actually sees, and that identity is
    # fleet-onboarder holding tool_classes ['read'] since v10.5. FN.GIT_SEED then has to
    # write 76 commits over the tool surface, and a read-only identity cannot: git_propose
    # is class `write` and every part was refused, so every install since v10.5 came up
    # with an unborn branch and no repository. Widening fleet-onboarder would reverse a
    # real security fix, and a tc field on THIS key cannot help -- pcNarrowClasses only
    # ever subtracts. So the seed gets its OWN credential, bound to a strain that holds
    # write, and narrowed by tc to exactly read+write: no stage, no infra, nothing it does
    # not need. fleet-advisor is named because it is a PUBLIC strain seeded by every
    # install (_seed_want = ["fleet-onboarder"] + PC_PUBLIC_STRAINS); a role no install
    # creates would resolve to nothing and fail exactly as loudly as the bug it replaces.
    SEED_ROLE = "fleet-advisor"
    SKEY = "pcs_" + secrets.token_hex(18)
    MINTED = (fsput("oauth_tokens", sha(TOK),
                    {"role": {"stringValue": ROLE}, "revoked": {"booleanValue": False},
                     "exp": {"integerValue": str(EXP)}})
              and fsput("session_keys", sha(KEY),
                        {"role": {"stringValue": ROLE}, "revoked": {"booleanValue": False},
                         "label": {"stringValue": "installer 8b/10 self-test"},
                         "exp": {"integerValue": str(EXP)}})
              and fsput("session_keys", sha(SKEY),
                        {"role": {"stringValue": SEED_ROLE}, "revoked": {"booleanValue": False},
                         "label": {"stringValue": "installer 8b/10 git seed"},
                         "tc": {"arrayValue": {"values": [{"stringValue": "read"},
                                                          {"stringValue": "write"}]}},
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
        elif len(gitseen) == len(GIT_TOOLS):
            # [SEC-GITENV-INSTALL-V1] THIS ASSERTION IS THE OTHER WAY ROUND NOW, and it had to
            # turn over in the same change that set the variables. It used to FAIL on seeing
            # the git tools, because no installer provisioned a repository and a registered
            # git tool therefore failed on first call. 5c/10 now makes the object bucket and
            # grants it, and 6/10 sets GIT_BUCKET and GIT_REPO_ID on this service, so the
            # seven tools are CONFIGURED and their presence is the correct state. Leaving the
            # old branch in place would have failed every install by construction.
            rec("PASS", "FN.TOOL_CENSUS", "EXERCISED",
                str(len(names)) + " tools, all classified, and all " + str(len(GIT_TOOLS))
                + " git tools registered against the bucket 5c/10 made and the GIT_BUCKET / "
                "GIT_REPO_ID pair 6/10 set")
        elif gitseen:
            rec("FAIL", "FN.TOOL_CENSUS", "EXERCISED",
                "only " + str(len(gitseen)) + " of " + str(len(GIT_TOOLS)) + " git tools are "
                "registered: " + " ".join(gitseen) + ". registerGitTools() registers them all "
                "or none, so a partial set means the module failed part-way through. The MCP "
                "service log carries the [gittools] line that says how.")
        else:
            rec("FAIL", "FN.TOOL_CENSUS", "EXERCISED",
                "NO git tools are registered, but 6/10 set GIT_BUCKET and GIT_REPO_ID on this "
                "service. gittools.ts withholds all seven unless BOTH are non-empty, so either "
                "the revision did not carry the variables or registerGitTools() threw. The MCP "
                "service log carries the [gittools] line that says which, and this is a real "
                "failure rather than the deliberate absence it used to be.")

        # ---- FN.GIT_SEED: the repository ships PRELOADED, or this install says so --------
        # [SEC-GITSEED-INSTALL-V1] THE THING THAT WAS ASKED FOR. Until now the closing banner
        # of this installer said it in as many words -- "The repository starts EMPTY: git_list
        # on an unborn branch is an error, not a bug, until you push" -- so an adopter who did
        # the one thing the documentation invites him to do, ask an agent for a branding
        # change, got a refusal on the very first tool call. 5c/10 makes the bucket and 6/10
        # registers the tools; this puts something in the store for them to serve.
        #
        # WHY THIS GOES THROUGH THE TOOL SURFACE AND NOT THROUGH gcloud storage. Objects in
        # this store are SEALED -- every loose object and every pack is wrapped in a PCV1
        # AES-GCM envelope keyed off the vault master, and the refs live in Firestore, not in
        # the bucket. Copying plaintext loose objects in with gcloud would produce a store
        # nothing can read. The MCP tools are the only writer that speaks that format, and
        # this phase already holds everything needed to drive them: the surface, the
        # throwaway identity minted above, and the release directory on disk. No new
        # dependency, no new credential, nothing the installer did not already have.
        #
        # WHY IT IS CHUNKED, AND WHY THE NUMBER IS 60000. The control plane parses request
        # bodies with express.json() at its DEFAULT 100kb limit and POST /mcp reads req.body,
        # so one request cannot carry a 488KB index.ts. Files are batched under a budget; a
        # file too big to fit alone is CREATED with its first chunk by git_propose and then
        # EXTENDED by git_propose_patch. Those diffs come from difflib, the standard library,
        # and are never hand-rolled: git_propose_patch validates the @@ header against the
        # hunk body and refuses the whole call on a disagreement, so a home-made diff is a
        # bricked seed. Chunk boundaries are LINE boundaries, which is what makes each append
        # exact; the longest line in the emitted tree is under 20KB, so that always fits.
        #
        # IDEMPOTENT BY ASKING FIRST. git_list on the branch runs before anything is written.
        # If the branch already carries a tree, nothing is proposed and nothing is pushed --
        # a re-install can never clobber commits an adopter made afterwards. The pushes are
        # compare-and-swap on the oid the propose reported, so a concurrent writer loses the
        # race loudly rather than silently interleaving.
        #
        # LOUD, NEVER QUIET. Every refusal, and a read-back that does not agree with the
        # writes, is a FAIL finding. 8b/10 carries failures BY NAME into 10/10 and 10/10
        # refuses to print INSTALL COMPLETE over one. There is no branch here that leaves an
        # empty store and a green install.
        PC_SEED_BUDGET = 60000
        PC_SEED_SKIP = ("agent-plugin.local",)
        _seed_here = os.environ.get("PC_FUNC_HERE", "")
        # [SEC-KEMPREREQ-V1] THE CONTRADICTION THIS RESOLVES, NAMED. FN.LAKE_WRITE is declared
        # unexercisable BECAUSE the lake is fail-closed when the vault master could not be
        # minted -- and this finding then wrote the ENTIRE release tree through that same seal
        # and failed the install on the refusals. Both cannot be right. A store that is
        # fail-closed by design is not a failure of the seeding step, so an unminted run reports
        # NOT-EXERCISED with its reason, exactly as FN.LAKE_WRITE does, and 5e/10 is where the
        # missing capability is named. 0/10 now refuses that install outright, so reaching here
        # unminted means a rehearsal or a KMS refusal rather than a missing library.
        if not MINTED:
            rec("NOT-EXERCISED", "FN.GIT_SEED", "EXERCISED",
                "the PCV1 vault master was not minted on this run, so every object in the git "
                "store is unsealable and every write would be REFUSED by design. Seeding a "
                "store that is deliberately fail-closed would prove nothing and would report "
                "thousands of refusals against the wrong step. 5e/10 says what stopped the "
                "mint; this finding does not restate it.")
            UNEXERCISABLE["FN.GIT_SEED"] = (
                "the vault master was not minted, so the git object store is FAIL-CLOSED -- "
                "the same condition, and the same reason, FN.LAKE_WRITE already carries. The "
                "repository tools are registered and the store is empty on purpose.")
        elif len(gitseen) != len(GIT_TOOLS):
            rec("NOT-EXERCISED", "FN.GIT_SEED", "EXERCISED",
                "not every git tool is registered, which FN.TOOL_CENSUS has already "
                "failed on -- seeding a store no tool can serve would prove nothing")
            UNEXERCISABLE["FN.GIT_SEED"] = "blocked by FN.TOOL_CENSUS, which is itself FAIL"
        elif not _seed_here or not os.path.isdir(_seed_here):
            rec("FAIL", "FN.GIT_SEED", "EXERCISED",
                "the release directory was not handed to this phase, so the repository could "
                "not be seeded. git_read and git_list would answer an unborn branch, and "
                "asking an agent for a code change would fail on its first call.")
        else:
            st, f = call("git_list", {"ref": "main"})
            _sd = text_of(f)
            try:
                _sj = json.loads(_sd)
            except Exception:
                _sj = {}
            if _sj.get("ok") and (_sj.get("entries") or []):
                rec("PASS", "FN.GIT_SEED", "EXERCISED",
                    "main already carries a tree (" + str(len(_sj.get("entries") or []))
                    + " top-level entr(y/ies)), so this run wrote NOTHING. That is the "
                    "idempotence: a re-install adopts the repository rather than overwriting "
                    "whatever you have committed since.")
            else:
                _sf, _sbin = [], []
                for _r, _ds, _fs2 in os.walk(_seed_here):
                    _ds[:] = sorted(_d for _d in _ds
                                    if _d not in PC_SEED_SKIP and not _d.startswith("."))
                    for _fn in sorted(_fs2):
                        if _fn.startswith("."):
                            continue
                        _p = os.path.join(_r, _fn)
                        _rel0 = os.path.relpath(_p, _seed_here).replace(os.sep, "/")
                        try:
                            _txt = open(_p, encoding="utf-8").read()
                        except Exception:
                            # [SEC-SEED-BINARY-V1] THIS `continue` USED TO BE THE WHOLE STORY,
                            # AND IT IS WHY A FRESHLY INSTALLED REPOSITORY COULD NOT BUILD.
                            # Every file was read as UTF-8 and anything that failed to decode
                            # was dropped -- SILENTLY, with no line in the log and no entry in
                            # the refusal list two lines below, which reports the other reason
                            # a file can be skipped. The ten binary assets are exactly those
                            # files: control-plane/src/brand/ (5) and src/wiki-assets/ (5).
                            # The Dockerfile hard-asserts all ten with `test -s` BEFORE esbuild
                            # runs, so an image built from the seeded repository died on that
                            # assertion every time, and the CI lane -- which builds from a
                            # bundle of the pushed tree -- was dead on arrival for the same
                            # reason. install.sh itself deploys from its own extracted tree,
                            # which is the only reason any working revision ever existed and
                            # the only reason this went unnoticed. It also quietly falsified
                            # the charter line "source in the repository, build reads the
                            # repository". Binaries now ride the upload path instead.
                            _sbin.append((_rel0, _p))
                            continue
                        _sf.append((_rel0, _txt))
                _sf.sort()
                _sbin.sort()

                def _seed_chunks(_tx, _bud):
                    _ls = _tx.splitlines(True)
                    _o, _c, _n = [], [], 0
                    for _l in _ls:
                        if _c and _n + len(_l) > _bud:
                            _o.append("".join(_c))
                            _c, _n = [], 0
                        _c.append(_l)
                        _n += len(_l)
                    _o.append("".join(_c))
                    return _o

                _steps, _batch, _used, _nofit = [], [], 0, []
                for _rel, _txt in _sf:
                    _parts = _seed_chunks(_txt, PC_SEED_BUDGET)
                    if len(_parts) > 1 and not _txt.endswith(chr(10)):
                        # An append diff cannot grow a file whose last line has no newline
                        # without a marker difflib does not emit. Refuse rather than ship a
                        # blob that is subtly not the file.
                        _nofit.append(_rel)
                        continue
                    _cost = len(json.dumps({"path": _rel, "content": _parts[0]}))
                    if _batch and _used + _cost > PC_SEED_BUDGET:
                        _steps.append(("propose", _batch))
                        _batch, _used = [], 0
                    _batch.append({"path": _rel, "content": _parts[0]})
                    _used += _cost
                    _acc = _parts[0]
                    for _nx in _parts[1:]:
                        if _batch:
                            _steps.append(("propose", _batch))
                            _batch, _used = [], 0
                        _steps.append(("patch", _rel, "".join(difflib.unified_diff(
                            _acc.splitlines(True), (_acc + _nx).splitlines(True),
                            "a/" + _rel, "b/" + _rel))))
                        _acc = _acc + _nx
                if _batch:
                    _steps.append(("propose", _batch))
                # [SEC-SEED-BINARY-V1] Binaries go LAST and in small groups, and the upload
                # happens inside the step rather than here. POST /git/blob hands back an oid
                # that resolves only while the upload is unexpired -- roughly twenty minutes --
                # and a full seed is 78 sequential round trips, so uploading everything up
                # front would race the clock and fail at the far end with an oid that no longer
                # resolves. Uploading immediately before the propose that names it cannot.
                for _bi in range(0, len(_sbin), 4):
                    _steps.append(("binprop", _sbin[_bi:_bi + 4]))

                _serr = ""
                if _nofit:
                    _serr = ("these file(s) are larger than one request and do not end with a "
                             "newline, so they cannot be appended to safely: "
                             + " ".join(_nofit))
                _sbase = None
                # [SEC-SEED-PROGRESS-V1] SAY SOMETHING WHILE THIS RUNS. Seeding the tree is
                # tens of sequential round trips -- 78 for the shipped release -- and each one
                # writes a commit through the tool surface. Until now the step printed its
                # heading and then NOTHING until every part had landed, under a title that
                # reads "functional self-test", so the operator watched a dead terminal for
                # minutes and reasonably concluded a slow useless test was the problem. The
                # loop ALREADY computed "part i of N" and spent it on the commit message. Put
                # it on the screen too. One dot per completed part, flushed -- python
                # block-buffers a non-tty stdout, so without the flush the dots would all
                # arrive at once at the end and be worse than nothing.
                sys.stdout.write("    seeding the shipped tree into the repository -- "
                                 + str(len(_steps)) + " part(s): ")
                sys.stdout.flush()
                for _i, _s in enumerate(_steps):
                    if _serr:
                        break
                    _smsg = ("seed the shipped release tree into the repository, part "
                             + str(_i + 1) + " of " + str(len(_steps))
                             + " -- written by install.sh 8b/10")
                    if _s[0] == "binprop":
                        _bents, _berr = [], ""
                        for _brel, _bpath in _s[1]:
                            try:
                                _bb = open(_bpath, "rb").read()
                                _breq = urllib.request.Request(
                                    MC + "/git/blob", data=_bb, method="POST")
                                _breq.add_header("Authorization", "Bearer " + SKEY)
                                _breq.add_header("Content-Type", "application/octet-stream")
                                with urllib.request.urlopen(_breq, timeout=90) as _br:
                                    _bj = json.loads(_br.read().decode())
                                if not _bj.get("blobOid"):
                                    _berr = _brel + ": upload returned no blobOid"
                                    break
                                # The oid is ASSERTED, not trusted: sha256 is recomputed here
                                # and the server refuses the propose if the bytes it recorded
                                # differ. A silently wrong asset is the failure this whole
                                # change exists to end, so it is not swapped for a quieter one.
                                _bsha = hashlib.sha256(_bb).hexdigest()
                                if _bj.get("sha256") and _bj.get("sha256") != _bsha:
                                    _berr = (_brel + ": server recorded sha256 "
                                             + str(_bj.get("sha256"))[:16] + ", local is "
                                             + _bsha[:16])
                                    break
                                _bents.append({"path": _brel,
                                               "uploaded": {"blob_oid": _bj["blobOid"],
                                                            "sha256": _bsha}})
                            except Exception as _be:
                                _berr = _brel + ": " + str(_be)[:160]
                                break
                        if _berr:
                            _serr = ("a binary asset could not be uploaded, so the repository "
                                     "would not build from a checkout: " + _berr)
                            break
                        st, f = call("git_propose", {"branch": "main", "files": _bents,
                                                     "message": _smsg}, SKEY)
                    elif _s[0] == "propose":
                        st, f = call("git_propose", {"branch": "main", "files": _s[1],
                                                     "message": _smsg}, SKEY)
                    else:
                        st, f = call("git_propose_patch", {"branch": "main", "patch": _s[2],
                                                           "message": _smsg}, SKEY)
                    _sd = text_of(f)
                    try:
                        _sj = json.loads(_sd)
                    except Exception:
                        _sj = {}
                    if not _sj.get("ok") or not _sj.get("commitOid"):
                        _serr = ("step " + str(_i + 1) + " of " + str(len(_steps)) + " ("
                                 + _s[0] + ") was refused: " + (_sd or json.dumps(f))[:300])
                        break
                    st, f = call("git_push", {"branch": "main",
                                              "expected_oid": _sj.get("baseOid"),
                                              "commit_oid": _sj.get("commitOid")}, SKEY)
                    _sd = text_of(f)
                    try:
                        _sk = json.loads(_sd)
                    except Exception:
                        _sk = {}
                    if not _sk.get("ok"):
                        _serr = ("the push of step " + str(_i + 1) + " was refused: "
                                 + (_sd or json.dumps(f))[:300])
                        break
                    _sbase = _sj.get("commitOid")
                    sys.stdout.write(".")
                    sys.stdout.flush()
                # CLOSE THE LINE EITHER WAY. A dotted line left without a newline would run
                # straight into the next finding and corrupt the report that follows.
                sys.stdout.write(" " + ("FAILED" if _serr else "done") + chr(10))
                sys.stdout.flush()
                if _serr:
                    rec("FAIL", "FN.GIT_SEED", "EXERCISED",
                        "the release tree was NOT seeded into the git store, so git_read and "
                        "git_list answer an unborn branch and asking an agent for a code "
                        "change does not work on this install. " + _serr)
                else:
                    st, f = call("git_list", {"ref": "main"})
                    _sd = text_of(f)
                    try:
                        _sj = json.loads(_sd)
                    except Exception:
                        _sj = {}
                    _sents = _sj.get("entries") or []
                    st, f = call("git_read", {"ref": "main", "path": "README.md"})
                    _sr = text_of(f)
                    _sok = "install.sh" in _sr
                    if _sents and _sok:
                        rec("PASS", "FN.GIT_SEED", "EXERCISED",
                            str(len(_sf)) + " file(s) of the shipped tree committed to main in "
                            + str(len(_steps)) + " commit(s), and READ BACK through the same "
                            "surface an agent will use: git_list returns " + str(len(_sents))
                            + " top-level entr(y/ies) and git_read on README.md returns the "
                            "document. Ask an agent for a change now; it will find the code.")
                    else:
                        rec("FAIL", "FN.GIT_SEED", "EXERCISED",
                            "every write reported ok and the READ-BACK DID NOT AGREE: git_list "
                            "returned " + str(len(_sents)) + " entr(y/ies) and git_read on "
                            "README.md " + ("did NOT return" if not _sok else "returned")
                            + " the document. A store that accepts writes and serves "
                            "nothing back is worse than one that is honestly empty.")

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
        fsdel("session_keys", sha(SKEY))

# [GCP-SELFTEST-TOKEN-EXPIRES-V71] REFRESH THE CREDENTIAL BEFORE THE LAST TWO CHECKS, because it
# is now MINUTES OLD AND HAS BEEN OBSERVED TO DIE. PC_FUNC_AT is captured once in the shell before
# this block and reused as GAUTH throughout. The two checks below are the ONLY ones that use it --
# everything else reaches the installed system through the MCP surface -- and on a real install
# both came back 401 while every MCP-surface check passed. GAUTH was demonstrably alive earlier
# (the throwaway identity is minted with it and FN.WHOAMI passed); it died during the 78 round
# trips of the git seed that sit between the two.
#
# IT IS A RACE AGAINST AN ABSOLUTE EXPIRY, NOT A PHASE BUDGET, and that distinction matters for
# anyone tempted to "just make the phase faster": what runs out is the token minted when the
# OPERATOR last authenticated, so what decides it is how long the whole install has been going
# when 8b starts. A run that was three minutes LONGER passed these two, and a shorter one failed
# them. Making the phase quicker does not fix it; re-fetching does.
#
# BEST EFFORT, AND IT KEEPS THE OLD TOKEN ON FAILURE. If gcloud is unavailable or refuses, the
# checks run with the credential they already had and report whatever they find -- a refresh that
# could not happen must not be a new way for the install to die.
def _refresh_gauth():
    try:
        _t = subprocess.run(["gcloud", "auth", "print-access-token", "--project", PROJ],
                            capture_output=True, text=True, timeout=60)
        _v = (_t.stdout or "").strip()
        if _t.returncode == 0 and _v:
            GAUTH["Authorization"] = "Bearer " + _v
    except Exception:
        pass


_refresh_gauth()


# THE 401 BRANCH EXISTS BECAUSE THESE TWO USED TO ACCUSE THE WRONG THING. A rejected credential
# says NOTHING about whether the index list or the bucket is healthy, and printing the resource's
# name next to a 401 read as "your indexes are missing" and "your lake is unreadable" -- two
# alarming, load-bearing-looking failures that 10/10 then refused INSTALL COMPLETE over, when the
# installed system was entirely fine. Name the credential instead.
def _auth_blame(st, b):
    return ("the installer's OWN credential was rejected (HTTP " + str(st) + "). This is a "
            "statement about the access token this phase is holding, NOT about the resource -- "
            "re-run the installer, or check 'gcloud auth print-access-token'. Upstream said: "
            + b[:120])


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
if st in (401, 403):
    rec("FAIL", "FN.INDEXES_EXIST", "ASSERTED", "could not read the index list -- " + _auth_blame(st, b))
elif st != 200:
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
elif st in (401, 403):
    rec("FAIL", "FN.LAKE_BUCKET", "ASSERTED",
        "could not read gs://" + LAKE + " -- " + _auth_blame(st, b)
        + " NOTE: FN.LAKE_LIST above is the stronger check and it EXERCISED the lake through the "
          "real tool surface; if it passed, the lake works and this line is about the installer.")
else:
    rec("FAIL", "FN.LAKE_BUCKET", "ASSERTED", "gs://" + LAKE + " is not readable: " + str(st) + " " + b[:120])
for i in ("FN.LAKE_WRITE", "FN.STAGE_TOOLS"):
    if i not in UNEXERCISABLE:
        rec("FAIL", i, "ASSERTED",
            "named as unexercisable but UNEXERCISABLE carries no entry for it. The two lists "
            "have drifted -- that is a generator bug, not something wrong with this install. "
            "It is reported here rather than raised, so the checks after it still run.")
        continue
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
# [SEC-FAILSTATE-PERCHECK-V1] HAND 10/10 THE NAMES, NOT A NUMBER. The exit status carries a
# COUNT, and a count is all 10/10 ever had: it printed "$FAIL CHECK(S) FAILED" with no FAIL
# line above it to match, which reads as a contradiction and is why the operator did not
# believe the run. It also made every failure indistinguishable, so a 10/10 check that
# re-measures one of these properties and PASSES could not retire the earlier verdict.
# The file is the transport. `fails` and the length of this list are computed from the same
# two sets, so the count and the names cannot disagree.
_failfile = os.environ.get("PC_FUNC_FAILFILE", "")
if _failfile:
    _failed_ids = [f[1] for f in FINDINGS if f[0] == "FAIL"] + list(rot)
    with open(_failfile, "w") as _fh:
        _fh.write(" ".join(_failed_ids))
sys.exit(min(fails, 99))
PCFUNC
  PC_FUNC_FAIL=$?
  [ -f "$HERE/.fn.tmp" ] && PC_FUNC_FAILED=$(cat "$HERE/.fn.tmp")
  rm -f "$HERE/.fn.tmp"
fi
# FAIL CLOSED ON A MISSING LIST. A non-zero exit with no names means the phase died before it
# wrote them -- an unhandled exception, a kill. 10/10 counts NAMES now, so an empty list would
# turn that death into a clean install. It gets a name instead.
if [ "$PC_FUNC_FAIL" -ne 0 ] && [ -z "$PC_FUNC_FAILED" ]; then
  PC_FUNC_FAILED="FN.SELFTEST_ABORTED"
fi
if [ "$PC_FUNC_FAIL" -eq 0 ]; then
  echo "  the tool surface answered. Carried into 10/10; it is not re-run there."
else
  echo "  $PC_FUNC_FAIL FUNCTIONAL CHECK(S) FAILED. The installer ran; the installed system"
  echo "  does not do its job. 10/10 will refuse to print INSTALL COMPLETE over this."
fi
if [ "$PC_NO_DEVPIPE" = 1 ]; then
  say "8c/10 + 8d/10 dev pipeline -- SKIPPED (--no-devpipe)"
  echo "  No CI build identity and no artifact retention policy. Images will accumulate"
  echo "  in Artifact Registry until something prunes them, and a dev pipeline added"
  echo "  later will build as whatever identity you give it. Both are re-runnable."
else
say "8c/10 the CI build identity (least privilege, not the project builder)"
# [SEC-CI-EMIT-INSTALL-V1] THE IDENTITY A DEV PIPELINE SHOULD BUILD AS, AND THE ONE IT MUST
# NOT. Cloud Build's default identity is the project's COMPUTE DEFAULT service account
# holding roles/cloudbuild.builds.builder AT PROJECT LEVEL. A trigger that reuses it can
# deploy ANY Cloud Run service in the project, act as any service account, and read what the
# builder can read -- so a rehearsal build in one lane can redeploy the real thing standing
# beside it. That is precisely the hole the lane split exists to close, and reusing the
# default builder would reopen it at the very last step.
#
# SO A DEDICATED IDENTITY IS MINTED AND BOUND TO EXACTLY WHAT A DEPLOY NEEDS, NOTHING MORE:
#   roles/run.developer           on THE THREE SERVICES OF THIS LANE, one binding each,
#                                 never on the project
#   roles/iam.serviceAccountUser  on THE TWO RUNTIME IDENTITIES OF THIS LANE, one binding
#                                 each, because a deploy that sets --service-account needs it
#   roles/storage.objectViewer    on the source staging bucket only, the same bucket-scoped
#                                 grant 3/10 makes for the default builder and for the same
#                                 reason
# There is deliberately NO roles/cloudbuild.builds.builder anywhere in this step. If a build
# turns out to need a right this list does not confer, ADD THE ONE RIGHT TO THE ONE RESOURCE
# -- a project-level role granted to make an error message go away is how the hole above got
# there in the first place.
# [SEC-OPTIONAL-NOT-FATAL-V11] AN OPTIONAL COMPONENT MUST NOT BE ABLE TO FAIL THE RUN, and
# until now this step could -- eight times. It runs AFTER 8b/10 has proved the installed
# system ANSWERS: by here Firestore, the service accounts, every secret, both Cloud Run URLs,
# both KMS keyrings and all four buckets exist and were exercised end to end. A denied role
# binding or an org policy that refuses a service-account create is then a missing convenience
# for a pipeline THIS TREE DOES NOT EVEN EMIT A TRIGGER FOR -- and a `die` here exits before
# 10/10 ever prints the console and MCP URLs, so a fully working install ends with an error
# and no address. Every failure below is therefore NAMED where it happens, counted, and
# summarised at the end of the step. This is the same shape as 9/10 and for the same reason.
PC_CI_RC=0
PC_BUILD_SA_ID="pc-${PC_LP}${PC_TOK}build"
PC_BUILD_SA="${PC_BUILD_SA_ID}@${PROJECT}.iam.gserviceaccount.com"
PC_CI_SA_OK=1
if gcloud iam service-accounts describe "$PC_BUILD_SA" --project "$PROJECT" >/dev/null 2>&1; then
  echo "  adopting $PC_BUILD_SA"
elif retry gcloud iam service-accounts create "$PC_BUILD_SA_ID" --project "$PROJECT" --display-name="paracoding ${PC_LP}CI build identity" >/dev/null 2>&1; then
  echo "  created $PC_BUILD_SA"
else
  PC_CI_SA_OK=0; PC_CI_RC=$((PC_CI_RC + 1))
  echo "  note: could not create the CI build identity $PC_BUILD_SA."
  echo "        The three grants below are skipped -- they would have nothing to bind."
fi
if [ "$PC_CI_SA_OK" = 1 ]; then
  _pc_ci_g=0
  for _pc_svc in "$CP_SVC" "$MC_SVC" "$GX_SVC"; do
    retry gcloud run services add-iam-policy-binding "$_pc_svc" --region "$REGION" --project "$PROJECT" --member="serviceAccount:$PC_BUILD_SA" --role=roles/run.developer --condition=None >/dev/null 2>&1 \
      || { echo "  note: could not grant roles/run.developer on $_pc_svc to $PC_BUILD_SA"; _pc_ci_g=$((_pc_ci_g + 1)); }
  done
  PC_CI_RC=$((PC_CI_RC + _pc_ci_g))
  [ "$_pc_ci_g" -ne 0 ] || echo "  $PC_BUILD_SA -> roles/run.developer on $CP_SVC, $MC_SVC and $GX_SVC ONLY"
  # Without this a deploy fails with a permission error naming the RUNTIME account, which reads
  # like a defect in the runtime account rather than a missing grant on the builder.
  _pc_ci_g=0
  for _pc_rsa in "$CP_SA" "$GX_SA"; do
    retry gcloud iam service-accounts add-iam-policy-binding "$_pc_rsa" --project "$PROJECT" --member="serviceAccount:$PC_BUILD_SA" --role=roles/iam.serviceAccountUser --condition=None >/dev/null 2>&1 \
      || { echo "  note: could not grant roles/iam.serviceAccountUser on $_pc_rsa to $PC_BUILD_SA"; _pc_ci_g=$((_pc_ci_g + 1)); }
  done
  PC_CI_RC=$((PC_CI_RC + _pc_ci_g))
  [ "$_pc_ci_g" -ne 0 ] || echo "  $PC_BUILD_SA -> roles/iam.serviceAccountUser on $CP_SA and $GX_SA ONLY"
  if retry gcloud storage buckets add-iam-policy-binding "gs://$PC_STAGE_BUCKET" --project "$PROJECT" --member="serviceAccount:$PC_BUILD_SA" --role=roles/storage.objectViewer --condition=None >/dev/null 2>&1; then
    echo "  $PC_BUILD_SA -> roles/storage.objectViewer on gs://$PC_STAGE_BUCKET ONLY"
  else
    echo "  note: could not grant the CI build identity read on gs://$PC_STAGE_BUCKET"
    PC_CI_RC=$((PC_CI_RC + 1))
  fi
fi
# THE TRIGGER IS NOT CREATED HERE AND THIS SAYS SO RATHER THAN LEAVING YOU TO FIND OUT.
# A Cloud Build trigger builds a SOURCE ARCHIVE. The notice this lane publishes carries no
# archive, for the reason recorded at 5c/10, and this tree ships no producer that makes one.
# Emitting a trigger anyway would produce a pipeline that looks complete and dies at its
# first step on every push, which is worse than a gap you can see.
PC_CI_SUBS='_COMMIT=$(body.message.data.commit),_ARCHIVE=$(body.message.data.archive),_SHA256=$(body.message.data.sha256)'
echo
echo "  TO FINISH THE PIPELINE, one command, after you have a producer that publishes the"
echo "  five-key build request {commit, short, archive, sha256, ref} to $PC_CI_TOPIC_ID:"
echo
echo "    gcloud builds triggers create pubsub --name=paracoding-${PC_LP}on-main --topic=$PC_CI_TOPIC --project $PROJECT --service-account=projects/$PROJECT/serviceAccounts/$PC_BUILD_SA --inline-config=YOUR-cloudbuild.yaml --substitutions=$PC_CI_SUBS"
echo
echo "  --service-account IS MANDATORY. Omitting it returns a content-free"
echo "  400 Request contains an invalid argument that names nothing. Its value is the"
echo "  RESOURCE PATH shown above, not the bare email address."
echo "  In the build config, point logsBucket at gs://$PC_LAKE_BUCKET/devdeploy/logs with"
echo "  options.logging GCS_ONLY, and grant this identity object access on THAT PREFIX only."
echo "  In an inline build config a substitution is written one dollar and a shell variable"
echo "  or command substitution is written TWO. Backwards costs a build with unbound variable."
echo "  Leave roles/cloudbuild.builds.builder OFF the project. It is not needed and it is"
echo "  what lets a build in one lane deploy the other one."

if [ "$PC_CI_RC" -ne 0 ]; then
  echo
  echo "  CI BUILD IDENTITY NOT FULLY PROVISIONED -- $PC_CI_RC step(s) did not land, each named"
  echo "  above. THE INSTALL IS NOT FAILED BY THIS. Nothing deployed by this run uses this"
  echo "  identity, no trigger is created here, and every command in this step is"
  echo "  create-if-absent: re-run this installer, or make the named binding(s) by hand,"
  echo "  before you point a pipeline at $PC_BUILD_SA."
fi

say "8d/10 artifact retention -- declarative, continuous, and it cannot delete yet"
# [SEC-RETENTION-V1] WHY THIS STEP EXISTS AND WHY IT INSTALLS SOMETHING THAT CANNOT DELETE.
#
# Every `run deploy --source` above builds a container image into the Artifact Registry
# repository cloud-run-source-deploy, and NOTHING EVER REMOVES ONE. The growth that first
# motivated this step was measured in this fleet's own project: the repository read 12852 MiB
# and 13334 MiB an hour apart, a growth of 482 MiB in one hour, against a Cloud Build source
# tarball of 1.3 MiB per submission -- so the images are the cost by two orders of magnitude
# and everything else is rounding. You pay for that storage, monthly, forever, and so does
# every adopter of this tree. That is what this step is for.
#
# THAT MEASUREMENT IS HISTORICAL AND THE CAUSE IT NAMED IS FIXED. DO NOT RE-DERIVE IT. The
# dependency layer IS byte-reproducible now: [SEC-ARGROWTH-V1] normalises the mtime of every
# installed file inside the SAME RUN that installs it, in the control plane's Dockerfile and
# in gate-exec's. An unchanged dependency tree therefore re-emits the SAME layer digest and
# Artifact Registry stores it once, so rebuilding the same source no longer adds hundreds of
# MiB an hour. The reading above is what the repository did BEFORE that landed.
#
# THE REPOSITORIES STILL GROW, FOR A REASON LAYER DEDUPLICATION CANNOT TOUCH. A push writes
# a MANIFEST as well as layers, and a manifest is per TAG. A pipeline that tags every image
# with its own commit id adds a NEW MANIFEST AND A NEW VERSION on every commit, and nothing
# ever removes one -- even when every layer underneath is already stored and shared. Layer
# dedup bounds how fast the BYTES grow; it does not bound the VERSION COUNT, and the version
# count is what a retention policy is for. A real source change still adds real application
# layers on top of that. So this step is still needed, on every repository this tree pushes
# to, and it is still not allowed to delete anything.
#
# THE ONE THING THAT MUST NOT HAPPEN. A Cloud Run revision pins its image BY DIGEST. A
# revision whose digest has been deleted cannot start, so the delete is invisible until the
# next cold start and then it is an outage -- the same shape as the 2026-08-10 secret delete
# recorded in pipeline/secret-destroy-preflight.py, and for the same reason: every check made
# beforehand was true and none of them asked "does anything currently REFERENCE it?".
#
# ARTIFACT REGISTRY CLEANUP POLICIES CANNOT ASK THAT QUESTION. They see versions, tags and
# ages; they have never heard of Cloud Run. So a keep-most-recent-N policy is a COUNT, not a
# safety property, and N is not derivable from anything the policy engine can see. Worse,
# "most recent N" is the wrong SHAPE of guarantee: a tagged zero-traffic rollback revision
# pins an OLD digest, and keeping the newest N never covers it for any N short of all. In
# this fleet's own project one service holds 42 tag-only traffic targets and the oldest of
# them pins the 121st-newest version of its package. Keep 3 would have deleted 45 live
# digests. This step therefore installs a policy that CANNOT ACT.
#
# WHAT IS INSTALLED, AND WHAT EACH PIECE IS FOR. Items 1-3 are installed ONCE PER
# REPOSITORY, each scoped to that repository's OWN package list -- see PC_AR_TARGETS below:
#   1. a KEEP floor over this lane's packages in that repository. Keep beats Delete in
#      Artifact Registry, so a keep policy can only ever protect. It never deletes anything.
#   2. a KEEP over every TAGGED version of those same packages, same reasoning.
#   3. a DELETE over untagged versions older than PC_UNTAGGED_DAYS -- installed with the
#      repository in DRY-RUN mode, which is set in the SAME CALL. In dry-run the policy is
#      evaluated and logged and removes nothing. Taking the repository out of dry-run is a
#      SEPARATE, DELIBERATE act and this installer never performs it. Before you do, run the
#      referenced-digest preflight: enumerate every revision of every service in every region
#      and prove the delete set disjoint from every digest any of them names. UNKNOWN refuses.
#   4. an age rule on the two SOURCE STAGING buckets. These are the one place where deletion
#      is provably safe: no Cloud Run revision, no image and no running service ever reads a
#      build source tarball, so an age rule there cannot cause the failure above. Bucket
#      deletes are soft for seven days by default, so it is recoverable as well as safe.
#
# THE PACKAGE NAMES ARE WRITTEN OUT IN FULL, NOT AS A LANE PREFIX. cloud-run-source-deploy is
# SHARED by every lane in the project and packageNamePrefixes is a PREFIX match, so a policy
# scoped to "paracoding-" would reach across into the other lane's images. The full names of
# this lane's two packages cannot prefix the other lane's, so each lane's delete policy can
# only ever reach its own two packages.
#
# AND THERE IS A SECOND REPOSITORY, WHICH NOTHING HERE COVERED UNTIL NOW. [SEC-RETENTION-V2]
# `run deploy --source` is not the only way an image reaches this project. The prod promotion
# pipeline does a plain docker build and docker push into a SEPARATE repository -- named
# `fleet` in this tree, PC_AR_REPO2 for anybody who called theirs something else -- and then
# deploys Cloud Run from that pushed tag. That repository is the one that grows most
# predictably of the two: one new tag, one new manifest, one new version, EVERY COMMIT,
# forever, and no policy had ever been written on it.
#
# ITS PACKAGE LIST IS DIFFERENT, AND THAT IS NOT COSMETIC. In cloud-run-source-deploy the
# package is named after the SERVICE, which is why items 1-3 there are scoped to $CP_SVC and
# $GX_SVC. In the pushed repository the package is named by the IMAGE PATH the pipeline
# writes, which is just control-plane. A policy carrying the service names would therefore
# match NO PACKAGE AT ALL there -- installed, listed, visibly green, and reporting on
# nothing, which is the exact failure mode a dry-run policy is supposed to rule out.
# PC_AR_REPO2_PKGS carries that repository's own list, and an adopter who pushes under other
# names sets it.
#
# IT GOES IN DRY-RUN TOO, AND THE ARGUMENT FOR THAT IS STRONGER HERE, NOT WEAKER. Everything
# above about a policy that cannot ask "is a Cloud Run revision still serving this digest?"
# applies with MORE force to this repository: its images are tag-per-commit and a live prod
# revision pins one of them BY DIGEST. So the same three policies are installed with the same
# repository-level --dry-run, which is what makes them visible and makes the delete rule
# REPORT what it would remove instead of removing it. Taking EITHER repository out of dry-run
# is the same separate, deliberate act it always was, gated on the same referenced-digest
# preflight, and this installer performs it on neither.
#
# PC_AR_REPO2 DEFAULTS EMPTY, AND THAT IS A CORRECTION. It used to default to `fleet`, which
# is THIS DEVELOPER'S OWN Artifact Registry repository and exists in no adopter's project. On a
# brand-new project the loop below therefore went looking for it and printed a five-line
# failure block in the middle of a completely healthy install -- an error message about a
# resource the operator has never heard of and does not want. Empty means "this tree pushes to
# exactly one repository here", which is the truth of a fresh install. An adopter who really
# does maintain a second pushed repository names it: PC_AR_REPO2=<repo> ./install.sh.
# The default is still written ${PC_AR_REPO2-} rather than ${PC_AR_REPO2:-}, unlike every
# other default in this step, and the distinction is kept deliberately: with the colon an
# explicit PC_AR_REPO2= would be treated as UNSET, so the documented opt-out would stop
# opting out the day somebody gives this a non-empty default again.
#
# AND THE POLICY SET IS MERGED, NOT OVERWRITTEN. set-cleanup-policies replaces the whole set
# on the repository. In a shared repository a second lane installing after the first would
# otherwise silently delete the first lane's protections, which is the worst possible failure
# for a keep policy. Existing policies this lane does not own are read back and preserved by
# name, and the ten-policy platform limit is checked before anything is written.
PC_AR_REPO=cloud-run-source-deploy
# PC_AR_REPO is NOT overridable and the two below are, deliberately: cloud-run-source-deploy
# is the name Cloud Run itself picks for `run deploy --source`, so it is a fact about the
# platform, while the pushed repository's name and package list are THIS tree's choices and
# an adopter's will differ.
PC_AR_REPO2="${PC_AR_REPO2-}"
PC_AR_REPO2_PKGS="${PC_AR_REPO2_PKGS:-control-plane}"
PC_KEEP_COUNT="${PC_KEEP_COUNT:-50}"
PC_UNTAGGED_DAYS="${PC_UNTAGGED_DAYS:-90}"
PC_STAGE_AGE_DAYS="${PC_STAGE_AGE_DAYS:-30}"
PC_RET_DIR="$HERE/.retention"
# [SEC-OPTIONAL-NOT-FATAL-V11] SAME DOCTRINE AS 8c/10 AND 9/10: retention is a COST CONTROL
# that runs after 8b/10 proved the system answers, so nothing in it may exit the run. A scratch
# directory that cannot be made means no policy document can be composed here -- that is the
# whole of the damage, it is stated, and the run goes on to print the URLs.
PC_RET_SKIP=0
mkdir -p "$PC_RET_DIR" 2>/dev/null || {
  PC_RET_SKIP=1
  echo "  note: could not create $PC_RET_DIR, so no cleanup policy can be composed here."
  echo "        NOTHING was written to any repository or bucket. THE INSTALL IS NOT FAILED BY"
  echo "        THIS -- images simply keep accumulating until this step runs on a later re-run."
}
PC_CB_BUCKET="${PROJECT}_cloudbuild"
# THE GUARD THAT MATTERS MORE THAN THE POLICY. The data lake holds agent memory and the wiki;
# the source bucket IS the git object store and holds your whole history. An age rule on either of
# those is not a storage saving, it is data loss. They are named here and compared by value,
# so a future edit that points the loop at the wrong variable stops the install instead.
for _pc_lb in "$PC_CB_BUCKET" "$PC_STAGE_BUCKET"; do
  for _pc_nb in "$PC_LAKE_BUCKET" "$PC_SOURCE_BUCKET"; do
    if [ "$_pc_lb" = "$_pc_nb" ]; then
      # THIS REFUSAL STILL REFUSES -- it just no longer takes the install down with it. It can
      # only fire on a BUG IN THIS SCRIPT (a future edit pointing the loop at the wrong
      # variable), never on anything the operator did, and the correct response to that is to
      # write nothing, say so at maximum volume, and let the run finish printing the URLs of
      # the system 8b/10 already proved works. Setting the skip flag stops every write below.
      PC_RET_SKIP=1
      echo "  REFUSING: the lifecycle target gs://$_pc_lb is a DATA bucket, not a staging"
      echo "  bucket. No age rule is going anywhere near the data lake or the git object store,"
      echo "  so THIS STEP INSTALLS NOTHING on this run. That is a defect in install.sh and not"
      echo "  in your project -- report it. Nothing else about this install is affected."
    fi
  done
done
if [ "$PC_RET_SKIP" = 0 ]; then
echo "  never-touch: gs://$PC_LAKE_BUCKET and gs://$PC_SOURCE_BUCKET"
# ONE LIST, one entry per repository, written "<repo>=<comma-separated package prefixes>".
# Neither field can contain a space, so the unquoted split in the loop below is safe and no
# array is needed -- this file still has to run on the bash 3.2 macOS ships.
PC_AR_TARGETS="$PC_AR_REPO=$CP_SVC,$GX_SVC"
if [ -n "$PC_AR_REPO2" ]; then PC_AR_TARGETS="$PC_AR_TARGETS $PC_AR_REPO2=$PC_AR_REPO2_PKGS"; fi
cat > "$PC_RET_DIR/mkpolicy.py" <<'PCRETPY'
import json, sys
keep_count, untagged_days = int(sys.argv[1]), int(sys.argv[2])
pkgs, tag = [p for p in sys.argv[3].split(",") if p], sys.argv[4]
# AN EMPTY PREFIX LIST WOULD MAKE EVERY RULE BELOW REPOSITORY-WIDE, and for the Delete rule
# that is the single shape this whole step exists to refuse. It fails instead, which the
# caller turns into "did not install" rather than "installed something enormous".
if not pkgs:
    print("  REFUSING to write: no package prefixes were given for this repository.")
    sys.exit(1)
mine = [
    {"name": tag + "keep-lane-floor", "action": {"type": "Keep"},
     "mostRecentVersions": {"packageNamePrefixes": pkgs, "keepCount": keep_count}},
    {"name": tag + "keep-tagged", "action": {"type": "Keep"},
     "condition": {"tagState": "tagged", "packageNamePrefixes": pkgs}},
    {"name": tag + "delete-untagged-old", "action": {"type": "Delete"},
     "condition": {"tagState": "untagged", "packageNamePrefixes": pkgs,
                   "olderThan": str(untagged_days) + "d"}},
]
mynames = set(p["name"] for p in mine)
try:
    existing = json.loads(open(sys.argv[5]).read().strip() or "[]")
except Exception:
    existing = []
if isinstance(existing, dict):
    existing = existing.get("cleanupPolicies") or []
if not isinstance(existing, list):
    existing = []
foreign = [p for p in existing if isinstance(p, dict) and p.get("name") not in mynames]
merged = foreign + mine
for p in foreign:
    print("  PRESERVED an existing policy this lane does not own: %s" % p.get("name"))
if len(merged) > 10:
    print("  REFUSING to write: the merged set would be %d policies and the limit is 10." % len(merged))
    sys.exit(1)
json.dump(merged, open(sys.argv[6], "w"), indent=2, sort_keys=True)
print("  policy set to write: %d total, %d of them this lane's" % (len(merged), len(mine)))
PCRETPY
# ONE BODY, RUN ONCE PER REPOSITORY. The second repository is not a copy of this block --
# a copy is two things that drift, and a retention policy that has drifted from the one
# beside it is worse than no second policy at all. The evidence files are per-repository
# too, so a repository whose write fails cannot overwrite the read-back of one that landed.
for _pc_t in $PC_AR_TARGETS; do
  _pc_ar="${_pc_t%%=*}"
  _pc_pkgs="${_pc_t#*=}"
  echo "  repository $_pc_ar -- packages $_pc_pkgs"
  PC_RET_OK=1
  gcloud artifacts repositories list-cleanup-policies "$_pc_ar" --location="$REGION" --project "$PROJECT" --format=json > "$PC_RET_DIR/existing-$_pc_ar.json" 2>/dev/null || printf '%s' '[]' > "$PC_RET_DIR/existing-$_pc_ar.json"
  python3 "$PC_RET_DIR/mkpolicy.py" "$PC_KEEP_COUNT" "$PC_UNTAGGED_DAYS" "$_pc_pkgs" "pc-${PC_LP}" "$PC_RET_DIR/existing-$_pc_ar.json" "$PC_RET_DIR/policy-$_pc_ar.json" || PC_RET_OK=0
  if [ "$PC_RET_OK" = 1 ]; then
    if gcloud artifacts repositories set-cleanup-policies "$_pc_ar" --location="$REGION" --project "$PROJECT" --policy="$PC_RET_DIR/policy-$_pc_ar.json" --dry-run >/dev/null 2>&1; then
      echo "  cleanup policies installed on $_pc_ar, repository in DRY-RUN mode so nothing is deleted"
      if gcloud artifacts repositories list-cleanup-policies "$_pc_ar" --location="$REGION" --project "$PROJECT" --format='value(name)' 2>/dev/null; then
        echo "  read back from the repository, above -- a write nobody read back did not land"
      fi
    else
      echo "  COULD NOT install cleanup policies on $_pc_ar. This is not fatal to the install,"
      echo "  and it is also not done: that image repository will grow without bound until you"
      echo "  set them. Most likely your gcloud predates cleanup policies, or that repository"
      echo "  does not exist in this project and region. Check, then re-run:"
      echo "    gcloud artifacts repositories set-cleanup-policies $_pc_ar --location=YOUR-REGION --project $PROJECT --policy=$PC_RET_DIR/policy-$_pc_ar.json --dry-run"
    fi
  fi
done
printf '%s' '{"lifecycle":{"rule":[{"action":{"type":"Delete"},"condition":{"age":'"$PC_STAGE_AGE_DAYS"'}}]}}' > "$PC_RET_DIR/lifecycle.json"
for _pc_lb in "$PC_CB_BUCKET" "$PC_STAGE_BUCKET"; do
  if gcloud storage buckets describe "gs://$_pc_lb" --project "$PROJECT" >/dev/null 2>&1; then
    if gcloud storage buckets update "gs://$_pc_lb" --project "$PROJECT" --lifecycle-file="$PC_RET_DIR/lifecycle.json" >/dev/null 2>&1; then
      echo "  gs://$_pc_lb objects are deleted after $PC_STAGE_AGE_DAYS days (build sources and build logs; soft-deleted and recoverable for seven days)"
    else
      echo "  could not set a lifecycle rule on gs://$_pc_lb -- it will grow until you do"
    fi
  fi
done
echo
echo "  WHAT THIS DOES NOT CLEAN UP, said plainly rather than left to be discovered:"
echo "  - nothing is deleted from EITHER image repository today. Each delete policy is"
echo "    installed in dry-run and only reports. Turning one on is a separate decision, it is"
echo "    per repository, and it needs the referenced-digest preflight run first."
echo "  - old Cloud Run revisions are untouched. They cost no storage, but each one PINS an"
echo "    image digest, so they are what actually holds the old images alive. Cloud Run will"
echo "    not let you delete a revision that can serve traffic, is tagged, or is the latest,"
echo "    so retiring them is far safer than deleting an image -- do that first."
echo "  - images in a repository the list above did not name. Both of the ones this tree"
echo "    pushes to are covered; a third that somebody adds later is not, until PC_AR_REPO2"
echo "    or that list names it."
echo "  - the data lake and the git object store, deliberately and permanently."
fi

# [SEC-UNATTENDED-V90] STEP 9/10 "REGISTER YOUR PASSKEY" IS GONE, AND SO IS THE REHEARSAL
# BOUNDARY THAT EXISTED ONLY TO STOP ABOVE IT. This installer ships PC_REQUIRE_PASSKEY=0, and
# in that mode a verified IAP identity on the approver allow-list satisfies the console with no
# cookie and no credential -- so nothing in this script needs a person any more. The run is
# unattended from kickoff to the two URLs at the end.
# THE LEGACY GATE IS NOT DELETED. locked.html and all fifteen webauthn routes stay in the tree,
# unreferenced, and PC_REQUIRE_PASSKEY=1 re-arms every one of them unchanged for a client who
# wants that posture. WA_SESSION_SECRET is still minted at 4/10 for exactly that reason.
# --rehearse is still ACCEPTED so existing harnesses keep working, but it no longer stops early:
# there is no longer a human step for it to stop above.
fi

say "10/10 self-test"
# [SEC-FAILSTATE-PERCHECK-V1] THE FAILURE STATE IS PER-CHECK NOW, AND THE SUMMARY NAMES IT.
# `FAIL=$PC_FUNC_FAIL` seeded a COUNTER out of 8b/10 and the closing line printed that counter
# and nothing else. Two defects fell out of one line. (1) A transient 8b/10 failure -- and the
# console probe there RACED IAP propagation, so transient failures were real and common --
# was still counted here even after THIS step re-measured the same property and passed it. A
# later, better measurement could not outvote an earlier, worse one. (2) The operator read
# "1 CHECK FAILED" with no FAIL line anywhere above it. That is not a strict reading of a
# summary, it is a contradiction, and it is why he stopped believing the run.
# So: failures are carried BY NAME; a 10/10 check that re-measures an inherited property
# RETIRES it when it passes; and the closing summary prints every name it counts.
PC_FAIL_INH="$PC_FUNC_FAILED"   # 8b/10 ids, space separated -- ids never contain a space
PC_FAIL_NEW=""                  # failures recorded HERE, one already-formatted line each
FAIL=0
for _f in $PC_FAIL_INH; do FAIL=$((FAIL+1)); done
pc_fail_add() { # LINE -- record a failure BY NAME so the summary can reprint it
  PC_FAIL_NEW="${PC_FAIL_NEW}    - ${1}
"
  FAIL=$((FAIL+1))
}
# RETIREMENT, AND WHY IT IS NOT JUST A DECREMENT. This runs only from a 10/10 check that
# measures THE SAME PROPERTY the named 8b/10 check measured, against the same live surface,
# later. When that re-measurement passes, the earlier verdict is not merely outvoted, it is
# superseded -- and the retirement is PRINTED, because silently dropping a failure is how a
# summary starts lying in the other direction.
pc_retire() { # ID
  _pcr=""; _pcr_hit=0
  for _f in $PC_FAIL_INH; do
    if [ "$_f" = "$1" ]; then _pcr_hit=1; else _pcr="$_pcr $_f"; fi
  done
  [ "$_pcr_hit" -eq 1 ] || return 0
  PC_FAIL_INH="$_pcr"
  FAIL=$((FAIL-1))
  printf '  --   %-38s %s\n' "$1 RETIRED" "8b/10 failed it; re-measured here and it PASSES"
}
chk() { # name expected actual
  if [ "$2" = "$3" ]; then printf '  ok   %-38s %s\n' "$1" "$3"; return 0
  else printf '  FAIL %-38s got %s want %s\n' "$1" "$3" "$2"; pc_fail_add "$1: got $3, want $2"; return 1; fi
}
chk_in() {
  for _e in $2; do if [ "$_e" = "$3" ]; then printf '  ok   %-38s %s\n' "$1" "$3"; return 0; fi; done
  printf '  FAIL %-38s got %s want one of [%s]\n' "$1" "$3" "$2"; pc_fail_add "$1: got $3, want one of [$2]"; return 1
}
chk_has() {
  case "$3" in *"$2"*) printf '  ok   %-38s %s\n' "$1" "$2"; return 0 ;;
    *) printf '  FAIL %-38s %s not found\n' "$1" "$2"; pc_fail_add "$1: $2 not found"; return 1 ;; esac
}
# [SEC-SURFACE-SPLIT-V1] WHICH CONSOLE ASSERTION IS CORRECT DEPENDS ON WHETHER IAP WENT ON,
# AND BOTH BRANCHES ASSERT SOMETHING REAL. With IAP on, an anonymous caller never reaches the
# app, so asserting the app's redirect would FAIL every healthy install -- and asserting the
# STATUS CODE alone would pass on a console with no IAP at all, because the app answers 302
# too. The header is the discriminator; it is generated by IAP and by nothing else. The app's
# own guard is not left unproven: 8/10 asserted it against the live deployment in the moment
# before IAP was put in front of it, which is the only moment it is observable.
if [ "$PC_IAP_ON" = "1" ]; then
  # THIS IS THE RE-MEASUREMENT. Same surface, same header, same anonymous request as
  # FN.CONSOLE_IAP at 8b/10 -- just later, by which time IAP propagation is long finished.
  # A pass here retires that finding by name; it does not silently cancel a number.
  chk_has "console is behind IAP" "x-goog-iap-generated-response" "$(curl -s -D - -o /dev/null --max-time 30 "$CP_URL/harness" 2>/dev/null)" \
    && pc_retire FN.CONSOLE_IAP
  printf '  --   %-38s %s\n' "console passkey guard" "asserted at 8/10, before IAP went in front"
else
  chk_in  "console requires a session" "401" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$CP_URL/harness")"
  # [SEC-NOGATE-V1] This used to read the Location header and assert it named /gate. There is no
  # Location header any more -- the console answers 401 and serves the locked page AT the requested
  # URL -- so the check reads the BODY for that page's title instead. A redirect target was only
  # ever a proxy for "an anonymous caller gets the unlock page"; this asserts it directly.
  # [SEC-SELFTEST-NEEDLE-V1] THE NEEDLE IS THE LOCKED STAGE'S STRUCTURAL MARKER, NOT A BRAND WORD.
  # This grepped for a page TITLE, and it was wrong twice over. (1) There are two locked-stage
  # documents -- locked.html for the passkey posture, login.html for PC_REQUIRE_PASSKEY=0 -- and
  # this installer ships PC_REQUIRE_PASSKEY=0 unconditionally, so every install it produces serves
  # login.html, which does not contain that title at all. The check was RED on a working console on
  # any install where IAP did not come up, which is precisely the install whose self-test matters.
  # (2) A self-test that fails when somebody renames a brand word is a self-test people learn to
  # ignore, and this release makes the brand surface configurable. pc-locked-stage is on the card
  # element of BOTH documents: it asserts an anonymous caller gets the locked stage without
  # asserting which posture is deployed.
  chk_has "console serves the locked page" "pc-locked-stage" "$(curl -s --max-time 30 "$CP_URL/harness")"
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

# [SEC-LANE-POSTASSERT-V1] ZERO UNPREFIXED RESOURCES, ASSERTED RATHER THAN ASSUMED. A lane
# install must create only lane-named resources: one bare literal anywhere above -- a name
# typed without its lane prefix -- and a lane run quietly writes into the unprefixed
# namespace, which is exactly the class of defect the lane-literal gate in the generator
# hunts at cut time. This is the RUNTIME half: 1b/10 captured what the project held before
# anything was created; this re-lists the same four classes and requires every NEW name to
# carry the lane token. The token is matched ANYWHERE in the name, not against one exact
# shape, so a naming scheme that grows a suffix keeps passing while a dropped prefix still
# fails. An unlistable class is a FAILURE by name, never a silent pass. Written as a
# function so the logic can be lifted out and driven by tests.
pc_lane_postassert() {
  [ -n "$PC_LANE" ] || return 0
  _pl_bad=""
  _pl_scan() { # LABEL BEFORE-LISTING AFTER-LISTING AFTER-RC
    if [ "$4" -ne 0 ]; then _pl_bad="$_pl_bad
    - $1: could not re-list (exit $4), so nothing about this class is proven"
      return
    fi
    for _pl_n in $(pc_names "$3"); do
      pc_has "$_pl_n" "$2" && continue
      case "$_pl_n" in
        *"$PC_LANE"*) : ;;
        *) _pl_bad="$_pl_bad
    - $1 $_pl_n: NEW since 1b/10 and does NOT carry the lane token '$PC_LANE'" ;;
      esac
    done
  }
  _pl_q=$(gcloud run services list --project "$PROJECT" --region "$REGION" --format='value(metadata.name)' 2>/dev/null); _pl_rc=$?
  _pl_scan "Cloud Run service" "$PC_Q_RUN" "$_pl_q" "$_pl_rc"
  _pl_q=$(gcloud secrets list --project "$PROJECT" --format='value(name)' 2>/dev/null); _pl_rc=$?
  _pl_scan "secret" "$PC_Q_SEC" "$_pl_q" "$_pl_rc"
  _pl_q=$(gcloud iam service-accounts list --project "$PROJECT" --format='value(email)' 2>/dev/null); _pl_rc=$?
  _pl_scan "service account" "$PC_Q_SA" "$_pl_q" "$_pl_rc"
  if [ "$PC_Q_BKT_RC" -ne 0 ]; then
    _pl_bad="$_pl_bad
    - bucket: 1b/10 could not take the before-listing (exit $PC_Q_BKT_RC), so a new bucket cannot be told from an old one"
  else
    _pl_q=$(gcloud storage buckets list --project "$PROJECT" --format='value(name)' 2>/dev/null); _pl_rc=$?
    _pl_scan "bucket" "$PC_Q_BKT" "$_pl_q" "$_pl_rc"
  fi
  if [ -z "$_pl_bad" ]; then
    printf '  ok   %-38s %s\n' "lane assertion" "every resource this run created carries '$PC_LANE'"
  else
    printf '  FAIL %-38s %s\n' "lane assertion" "unprefixed or unprovable creations:"
    printf '%s\n' "$_pl_bad"
    pc_fail_add "lane assertion: a lane run must create only lane-named resources; the list above names each violation"
  fi
}
pc_lane_postassert
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
# [SEC-URL-UNCONDITIONAL-V1] PRINTED WHETHER OR NOT ANYTHING FAILED, AND THAT IS THE POINT.
# The only place the connector URL appeared with its /mcp path was the banner below, and the
# banner is inside `if [ "$FAIL" -eq 0 ]`. Step 8b/10 has a known race that can report a
# SPURIOUS failure, and one false red was therefore enough to suppress the single correct
# connector string in the whole run -- leaving the operator guessing the MCP URL across
# several rounds. A failed install still has to tell you what it built.
cat <<EOF
  THE TWO URLS, PRINTED UNCONDITIONALLY:

    console       ${CP_URL}/harness  (behind IAP -- sign in with $ACCT)
    MCP connector ${MC_URL}/mcp      (NOT behind IAP -- this is the connector endpoint)

  The /mcp path is part of the connector URL. The bare service URL is not a connector URL,
  and handing a connector the CONSOLE url is the mistake the two-service split exists to
  prevent. These lines are printed even when a check below failed, because a check that
  failed does not make these URLs wrong -- and 8b/10 is known to be able to fail falsely.
EOF
echo
if [ "$FAIL" -eq 0 ]; then
cat <<EOF
  INSTALL COMPLETE.

    console   ${CP_URL}/harness  (behind IAP -- sign in with $ACCT)
    MCP URL   ${MC_URL}/mcp      (NOT behind IAP -- this is the connector endpoint)

  TWO SERVICES, ONE IMAGE, AND THE URLS ARE NOT INTERCHANGEABLE. IAP on Cloud Run is one
  switch per service: the console needs it (it is how you reach the console before a passkey
  exists) and the MCP surface cannot have it (IAP consumes the Authorization header, so an
  MCP client would be refused at the edge). Giving a connector the console URL is the one
  mistake this arrangement exists to prevent.

  THIS INSTALL CALLS A MODEL, AND IT BILLS THIS PROJECT. The console chat and the memory
  embeddings call Vertex AI as the control plane's own service account. NOTHING HERE HOLDS
  AN API KEY and none is needed -- which is why the chat answers the moment you open it,
  and also why it is not free. Spend is ONE Firestore field, config/models.fleet_mode,
  which step 2c/10 set to work just now:
      work   keyless Vertex only. API-key transports are REFUSED, so a key left lying in
             Secret Manager cannot quietly start billing a card.
      home   no model call of any kind -- not the chat, not the reflect pass, not the
             embeddings. Memory still records; its search degrades to substring.
      dual   Vertex and API keys both.
  Unset, unreadable or unrecognised reads as home, so the failure direction is OFF.
  Approvals are signed with a Cloud KMS asymmetric key (EC_SIGN_P256_SHA256). The
  PRIVATE key is usable only by the control plane; the gated executor is given the PUBLIC
  key and nothing else, so it can verify an approval and cannot manufacture one. A
  compromised executor can refuse work or corrupt the record of it -- it cannot forge your
  consent. See the gx= note above for what is still project-wide and why.

  IDENTITY ENFORCEMENT IS ON (PC_SESSION_ENFORCE=1). A chat that presents no session key
  gets NO fleet tools -- only whoami, which explains itself. That is deliberate: this
  MCP connector is account-level, so without a key every chat on your account resolves
  to the same identity.

  So your next step is:  open ${CP_URL}/harness , sign in with $ACCT, and click the
  Session pastes control in the harness header. Mint a key for a strain and paste the block
  it gives you into a new chat. The key is shown ONCE -- only its hash is stored. Keys
  expire after 7 days (PC_KEY_TTL_DAYS); when one lapses the chat is told so and you mint a
  fresh paste.
  (There is no /pastes page any more, and this line used to send you to one. /jobs and
  /pastes both served the same 142KB gate document this release deletes, so both routes were
  removed rather than moved. The minter itself did not go anywhere: it lives on the harness,
  on the same /api/sessions/roles and /api/sessions/mint it always used.)

  To use this from an agent client that is not this console, point it at the Agent Plugins
  package written beside the release just now:

      ${HERE}/agent-plugin.local/

  The starter wiki was seeded at 6b/10: ${PC_WIKI_N} page(s) are listed in the index that was
  read back out of the lake, and ${PC_WIKI_RC} object(s) failed to land. If that second number
  is not 0, /wiki is incomplete and 6b/10 named every object it is missing -- that does not
  make anything else on this install wrong, and it is fixed by re-running this script. The
  pages live in the lake, not in the image: edit them at shared/wiki/pages/ and the console's
  Docs button serves what you wrote. A re-run keeps your edits.

  The data lake bucket IS provisioned now (5c/10) and the control plane was verified to be
  serving its name off the running revision. Two things are reported at the step that
  would have made them rather than restated here:

    the PCV1 vault    5e/10 created keyring ${PC_VKR} and key ${PC_VKEY}, and MINTED
                      shared/vault/master.kem if this machine had an ML-KEM capability. That
                      step said which way it went. Where master.kem was NOT minted the lake is
                      FAIL-CLOSED, not plaintext: every write outside the five cleartext
                      prefixes throws, and 5e/10 printed what is missing and how to finish it.

    the 7 git tools   git_read, git_list, git_log, git_diff, git_propose, git_propose_patch
                      and git_push ARE REGISTERED on this install. 5c/10 made the object
                      bucket gs://$PC_SOURCE_BUCKET and granted $CP_SA objectAdmin on it
                      alone; 6/10 set GIT_BUCKET and GIT_REPO_ID=$PC_GIT_REPO_ID on $MC_SVC,
                      which is the pair gittools.ts requires before it registers anything.
                      They are MCP tools, so they live on the MCP service; setting them on
                      the console does nothing. FIRESTORE_DATABASE is left UNSET on purpose
                      so they follow PC_FIRESTORE_DB to the database everything else already
                      uses -- setting it to something different is refused at startup rather
                      than serving you an empty repository. AND THE REPOSITORY IS NOT
                      EMPTY: 8b/10 committed this release tree to main over the same tool
                      surface an agent uses, then read it back with git_list and git_read
                      before it would let this line print. Ask an agent for a change --
                      branding is the worked example in the wiki -- and it will find the
                      code on its first call. Re-running this installer will NOT overwrite
                      what you have committed since: the seed asks git_list first and
                      writes nothing if the branch already has a tree.

EOF
else
  echo "  $FAIL CHECK(S) FAILED. The install is NOT good. Nothing above lies to you about that."
  echo "  EVERY ONE OF THEM, BY NAME -- a count with nothing to match it against is what made"
  echo "  the last run unreadable:"
  for _f in $PC_FAIL_INH; do
    echo "    - $_f (8b/10 functional self-test; not re-measured at 10/10, so it still stands)"
  done
  [ -n "$PC_FAIL_NEW" ] && printf '%s' "$PC_FAIL_NEW"
  pc_urls
  exit 1
fi
pc_urls

