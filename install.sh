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
case "${1:-}" in
  --rehearse|--stop-before-passkey) PC_REHEARSE=1; shift ;;
  --plan) PC_PLAN=1; shift ;;
esac
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
PROJECT="${1:-}"
REGION="${2:-us-east1}"
[ -n "$PROJECT" ] || { echo "usage: bash install.sh [--rehearse|--plan] PROJECT_ID [REGION]"; exit 2; }
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
# @@PC_SHARED_BEGIN:PC_COMMON@@
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

# [GCP-WS-OPTIONAL-NOT-FATAL-V76] A REFUSAL THAT IS NOT A FAILURE OF THE INSTALL.
# die() is right for "this deployment is not safe to continue building". It is WRONG for
# "one optional component cannot be built safely", which is a different sentence and used to
# be spelled the same way -- an unbuildable workstation aborted the whole run at 5d/10 with
# every earlier step's resources already created. pc_ws_warn() prints the identical text to
# stderr with the same !! marker, so nothing about the WARNING is quieter or easier to miss,
# and then RETURNS. It deliberately does NOT emit ##PCSTEP FAIL: the step did not fail, it
# declined, and a machine-readable FAIL on a step that goes on to complete is a lie to
# whatever is parsing this transcript.
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
PC_IAM_TOK=$(gcloud auth print-access-token 2>/dev/null)
PC_BODY=$(printf '%s' "$PC_NEED" | python3 -c 'import sys,json;print(json.dumps({"permissions":sys.stdin.read().split()}))' 2>/dev/null)
PC_HAVE=""
if [ -n "$PC_IAM_TOK" ] && [ -n "$PC_BODY" ]; then
  PC_HAVE=$(curl -sS -m 30 -X POST -H "Authorization: Bearer $PC_IAM_TOK" -H "Content-Type: application/json" -d "$PC_BODY" "https://cloudresourcemanager.googleapis.com/v1/projects/$PROJECT:testIamPermissions" 2>/dev/null | python3 -c 'import sys,json;print(" ".join(json.load(sys.stdin).get("permissions",[])))' 2>/dev/null)
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
retry gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com logging.googleapis.com \
  compute.googleapis.com cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
  cloudkms.googleapis.com iap.googleapis.com aiplatform.googleapis.com \
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
PC_RELEASE="b76080a9d36c836bdc86c2314adebb67c55784d9"
PC_VERSION="8.4"
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
  } >&2
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
if pc_has "$PC_MARK_SEC" "$PC_Q_SEC"; then
  PC_MARK=$(gcloud secrets versions access latest --secret="$PC_MARK_SEC" --project "$PROJECT" 2>/dev/null); PC_MARK_RC=$?
  if [ "$PC_MARK_RC" -ne 0 ]; then
    PC_MARK_STATE=unreadable
  else
    PC_MARK=$(printf '%s' "$PC_MARK" | tr -d '[:space:]')
    case "$PC_MARK" in
      "") PC_MARK_STATE=unreadable ;;
      *[!0-9a-f]*) PC_MARK_STATE=unreadable ;;
      *) PC_MARK_STATE=present ;;
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
if [ "$PC_MARK_STATE" = present ] && [ "$PC_MARK" = "$PC_RELEASE" ] && [ "$PC_TOK" = "$PC_TOK_MARKED" ]; then
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
  pc_refuse "PC_LANE IS EMPTY AND THIS PROJECT ALREADY CARRIES THE UNPREFIXED INSTALL.
The resources listed above have no lane prefix, so continuing would re-run over the live
unprefixed deployment: adopt its lake bucket, adopt its database, adopt its keyring, and
redeploy its services. If you meant a lane, set it and re-run:
    PC_LANE=<your-lane> bash install.sh $PROJECT $REGION
If the unprefixed install is exactly what you mean to operate on, say so explicitly:
    PC_EMPTY_LANE_OK=1 bash install.sh $PROJECT $REGION
Every other guard in this step still applies after that."
fi

if [ "$PC_MARK_STATE" = unreadable ]; then
  pc_refuse "THE VERSION MARKER IS PRESENT AND UNREADABLE, WHICH IS NOT THE SAME AS ABSENT.
Secret $PC_MARK_SEC exists in $PROJECT but its latest version could not be read, or does
not hold a release id. This installer cannot tell what is deployed here, and an installer
that cannot tell refuses instead of guessing.
Read it yourself and decide:
    gcloud secrets versions access latest --secret=$PC_MARK_SEC --project $PROJECT"
fi
if [ "$PC_MARK_STATE" = present ] && [ "$PC_MARK" != "$PC_RELEASE" ]; then
  pc_refuse "VERSION SKEW. THIS PROJECT ALREADY HOLDS A DIFFERENT RELEASE.
    installed here : $PC_MARK
    this installer : $PC_RELEASE
    lane prefix    : '${PC_LP}'
Re-running over it would redeploy the services, adopt the lake bucket, adopt the database
and adopt the keyring, and print success while doing it. What that costs depends entirely
on which direction this is, and THIS INSTALLER CANNOT TELL: two release ids are not
ordered, so 'newer over older' and 'older over newer' look identical from here. It
therefore refuses BOTH rather than guessing, which is the only answer that cannot silently
downgrade a live install.
If you mean to upgrade, say so where the project can see it -- set the marker to this
release yourself, having read what changed between them, and re-run:
    printf %s $PC_RELEASE | gcloud secrets versions add $PC_MARK_SEC --data-file=- --project $PROJECT"
fi
if [ "$PC_MARK_STATE" = absent ] && [ -n "$PC_OURS" ]; then
  if [ "$PC_ADOPT_UNMARKED" = 1 ]; then
    echo "  PC_ADOPT_UNMARKED=1: adopting the unmarked resources listed above ON YOUR SAY-SO."
  else
    pc_refuse "THIS LANE ALREADY HAS RESOURCES AND NO VERSION MARKER.
The resources listed above are here, and secret $PC_MARK_SEC is not. Two things produce
that and they are not the same:
  * an OLDER RELEASE is installed -- every release before this one wrote no marker, so
    its absence beside live resources is what an older install looks like; or
  * an earlier run of THIS release died before it could write the marker.
Either way this run would ADOPT them, and adoption of a lake bucket, a database or a
keyring is a decision, not a status line. Decide it deliberately:
    PC_ADOPT_UNMARKED=1 bash install.sh $PROJECT $REGION
and if you did not expect anything to be here, check PC_LANE first -- it is currently
'${PC_LANE}', and an empty or misspelled lane runs the PROD path."
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
  pc_confirm_word share "  Those belong to a DIFFERENT install in the same project.
  Sharing one project across lanes is supported and this run will not touch them, but
  they share the project's quotas, its Artifact Registry repository and its staging
  buckets, and an uninstall of either lane has to leave the other alone.
  If the lane prefix above is not what you intended, answer anything else and set PC_LANE.
  Type the word share to continue: "
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
  elif [ "$PC_REHEARSE" = 1 ]; then
    pc_refuse "A REHEARSAL WOULD ADOPT THE RESOURCES ABOVE AND A REHEARSAL RUNS WITH NOBODY
PRESENT TO CONSENT. Run interactively, or state the consent in the environment:
    PC_ADOPT=1 bash install.sh --rehearse $PROJECT $REGION"
  else
    pc_confirm_word adopt "  Adopting them re-runs this install over what they already hold. Type the word adopt to continue: "
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
  pc_plan_sa "pc-${PC_LP}${PC_TOK}build@" " (the CI build identity)"
  pc_plan_sa "pc-${PC_LP}${PC_TOK}workstation@" " (only if 5d/10 builds a workstation -- an interactive choice)"
  pc_plan_sec "$PC_SEC_SESSION" ""
  pc_plan_sec "$PC_SEC_CONFIRM" ""
  pc_plan_sec "$PC_SEC_CREDS" ""
  pc_plan_sec "$PC_SEC_BOOT" " (a NEW version is minted either way; removed again at 9/10)"
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
  echo "  services; the workstation VM is an interactive choice at 5d/10 and its answer can"
  echo "  be no; the git seed at 8b/10 writes ONLY if branch main is empty."
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
if [ "$PC_MARK_STATE" != present ]; then
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
  printf '%s' "$PC_RELEASE" | gcloud secrets versions add "$PC_MARK_SEC" --data-file=- --project "$PROJECT" >/dev/null 2>&1 || die "could not record release $PC_RELEASE in $PC_MARK_SEC.
Refusing to continue unrecorded: the next run would then see live resources with no marker
and have to refuse, which is a worse place to leave this project than stopping here."
  echo "  recorded release $PC_RELEASE in $PC_MARK_SEC"
else
  echo "  re-run of the SAME release ($PC_RELEASE) -- the marker already says so"
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

say "3/10 service accounts (three, least privilege)"
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
# [SEC-SOURCE-BUCKET-V1] THE SECOND BUCKET, AND IT IS NOT OPTIONAL PLUMBING. The 7 git tools
# (git_read, git_list, git_log, git_diff, git_propose, git_propose_patch, git_push) store their
# objects in a bucket named by GIT_BUCKET, and until now this installer created NO such bucket.
# Adopters hand-created one and ran about five commands before git worked at all. It is made
# HERE, beside the lake, because the two are one storage step and separating them is what caused
# the omission to go unnoticed.
#
# OBJECT VERSIONING IS ON, and that is the difference between this and the lake. A git object
# store that can lose a write loses history, and history is the only thing it holds. Public
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
uniform bucket-level access, public access prevented and object versioning ON, grant
roles/storage.objectAdmin on it to
$CP_SA, and set GIT_BUCKET to its name on $MC_SVC yourself."
  echo "  created gs://$PC_SOURCE_BUCKET in $REGION"
fi
# Re-asserted on every run, including an adopted bucket, for the same reason the lake is:
# a bucket somebody made by hand may not carry these, and finding that out later is worse.
retry gcloud storage buckets update "gs://$PC_SOURCE_BUCKET" --project "$PROJECT" \
  --uniform-bucket-level-access --public-access-prevention --versioning >/dev/null \
  || die "could not enforce uniform bucket-level access, public access prevention and object
versioning on gs://$PC_SOURCE_BUCKET. Refusing to use a git object store whose access model or
durability is unknown."
# THE SAME BUCKET-SCOPED ROLE THE LAKE GETS, AND FOR THE SAME REASON. $CP_SA is the identity
# BOTH Cloud Run services run as, so this one grant covers the console and the MCP service --
# and the git tools are served by the MCP service. Never the project-wide storage role.
retry gcloud storage buckets add-iam-policy-binding "gs://$PC_SOURCE_BUCKET" --project "$PROJECT" \
  --member="serviceAccount:$CP_SA" --role=roles/storage.objectAdmin --condition=None >/dev/null \
  || die "could not grant roles/storage.objectAdmin on gs://$PC_SOURCE_BUCKET to $CP_SA."
echo "  source/git bucket gs://$PC_SOURCE_BUCKET -- versioning ON, public access PREVENTED"
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
retry gcloud storage buckets update "gs://$PC_EXEC_BUCKET" --project "$PROJECT" --uniform-bucket-level-access --public-access-prevention >/dev/null || die "could not enforce uniform bucket-level access and public access prevention on
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

say "5d/10 workstation VM (optional: none / linux / windows, default none)"
# @@PC_SHARED_BEGIN:WS_LIB@@
# ================================================================================
# [SEC-WSVM-ONEBODY-V1] THE WORKSTATION LIBRARY. ONE DEFINITION, TWO EMITTED SCRIPTS.
#
# Everything below is generated from a SINGLE constant in gen.py and inlined verbatim
# into BOTH install.sh (step 5d) and the standalone workstation.sh. It is inlined rather
# than sourced on purpose: install.sh must work with nothing beside it, so it cannot depend
# on a second file that an adopter may not have downloaded. Inlining from one source keeps
# the "no second copy to drift" property that a shared file would give, without the runtime
# dependency that a shared file would add. DO NOT EDIT ONE COPY.
# ================================================================================

# pc_ws_flavour_of NAME ZONE -> prints linux | windows | unknown
# Reads the LICENCES on the instance's boot disk, which is what actually says which OS is on
# it. A name is not evidence: the pre-rename instances were called paracoding-workstation
# whichever flavour they were, and believing the name is precisely how the old adopt path
# handed a Linux box to an operator who asked for Windows.
# [SEC-WSVM-EXTID-V1] THE CLAUDE CHROME EXTENSION ID, AS A DEFAULT AND NOT A HARDCODE.
# Published listing: chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn.
# It is written onto the instance as the pc-claude-ext-id METADATA VALUE, so the startup
# scripts below are unchanged: they still read that key, still require exactly 32 chars a-p,
# and still skip-and-log rather than guess. Override with PC_CLAUDE_EXT_ID=<id>, or set
# PC_CLAUDE_EXT_ID= (empty) to ship the machine with NOTHING force-installed. Using ${VAR-d}
# and not ${VAR:-d} is what makes an EXPLICITLY EMPTY override survive as empty.
PC_WS_EXT_ID="${PC_CLAUDE_EXT_ID-fcoeoabgfenejglbffodgkkbkcdhcgfn}"
# [SEC-WSCLAUDE-PIN-V1] THE CLAUDE DESKTOP APP, ACTUALLY PREINSTALLED, BY THE SAME MECHANISM.
# MEASURED BEFORE THIS CHANGE: the two startup scripts below have read pc-claude-deb-url and
# pc-claude-win-url since they were written, and NOTHING in the emitted tree ever SET either
# key -- so both paths silently took the documented fallback and the operator got Claude Code
# plus a claude.ai app window on Linux and a claude.ai app window on Windows. The request was
# for the app. The mechanism to deliver it already existed one line above: PC_WS_EXT_ID pins
# a default and writes it into instance metadata. These do exactly that and nothing new.
#
# THE URLS ARE ANTHROPIC'S OWN AND WERE READ OFF ANTHROPIC'S OWN DOCUMENTATION, NOT GUESSED.
# Linux: the apt repository, signing key and key fingerprint published at
# code.claude.com/docs/en/desktop-linux, corroborated by the help centre article
# support.claude.com/en/articles/10065433-install-claude-desktop. The repository is the right
# unit to pin because it is VERSIONLESS and it keeps updating; a pool .deb URL carries a
# version in its filename, so pinning one would 404 the week after this release -- which is
# the "wrong URL is worse than a documented fallback" failure, just delayed.
# Windows: the versionless setup redirect published on Anthropic's own download page,
# claude.com/download. It is fetched through Get-PcVerified, which REFUSES anything whose
# Authenticode subject does not contain "Anthropic", so a URL that ever stops being Anthropic
# fails CLOSED into the same fallback rather than installing a stranger's binary.
#
# EVERY ONE IS A DEFAULT, NOT A HARDCODE. Override with PC_CLAUDE_APT_REPO / PC_CLAUDE_APT_KEY
# / PC_CLAUDE_APT_FPR / PC_CLAUDE_WIN_URL, or set any of them EMPTY to ship the machine with
# that path disabled and take the fallback deliberately. ${VAR-d} rather than ${VAR:-d} is
# what makes an explicitly empty override survive as empty -- the same reason it is used
# above. pc-claude-deb-url is UNTOUCHED and still wins over the repository when it is set, so
# an operator who pins their own package keeps doing exactly what they did before.
PC_WS_CLAUDE_APT_REPO="${PC_CLAUDE_APT_REPO-https://downloads.claude.ai/claude-desktop/apt/stable}"
PC_WS_CLAUDE_APT_KEY="${PC_CLAUDE_APT_KEY-https://downloads.claude.ai/claude-desktop/key.asc}"
PC_WS_CLAUDE_APT_FPR="${PC_CLAUDE_APT_FPR-31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE}"
PC_WS_CLAUDE_WIN_URL="${PC_CLAUDE_WIN_URL-https://claude.ai/api/desktop/win32/x64/setup/latest/redirect}"

pc_ws_flavour_of() {
  _pc_lic=$(gcloud compute instances describe "$1" --zone "$2" --project "$PROJECT" \
    --format='value(disks[0].licenses)' 2>/dev/null | tr '[:upper:]' '[:lower:]')
  case "$_pc_lic" in
    *windows*) printf '%s\n' windows ;;
    "")        printf '%s\n' unknown ;;
    *)         printf '%s\n' linux ;;
  esac
}

# pc_ws_access_banner KIND -- how to actually reach the machine. Called from three places
# (install.sh's unconditional footer, the adopt path, and workstation.sh) and defined once,
# because three copies of a set of connection commands is three chances to print a stale one.
pc_ws_access_banner() {
PC_WS_KIND="$1"
if [ "$PC_WS_KIND" = windows ]; then
cat <<EOF

  WORKSTATION CREATED: WINDOWS (${WS_IMG_FAMILY:-windows server}, Desktop Experience)
  ${WS_VM_NAME:-the workstation} in ${WS_VM_ZONE:-its zone}.

  It has NO EXTERNAL IP. RDP is reachable ONLY through IAP TCP forwarding -- the firewall
  rule allows tcp:3389 from 35.235.240.0/20, which is IAP's range, and from nowhere else.
  Two commands, in this order, and THE FIRST ONE IS MANUAL ON PURPOSE:

    gcloud compute reset-windows-password ${WS_VM_NAME:-WORKSTATION} \\
      --zone ${WS_VM_ZONE:-ZONE} --project ${PROJECT} --user paracoding

    gcloud compute start-iap-tunnel ${WS_VM_NAME:-WORKSTATION} 3389 \\
      --local-host-port=localhost:13389 --zone ${WS_VM_ZONE:-ZONE} --project ${PROJECT}

  Then point an RDP client at localhost:13389 and log in as paracoding with the password the
  first command printed. THAT FIRST COMMAND CANNOT BE RUN FOR YOU: it mints a new
  administrator password and prints it in cleartext, so an installer that ran it would leave
  a working administrator credential in this terminal and in every log that captured it.
  Provisioning log on the VM: C:\\ProgramData\\paracoding\\ws-setup.log -- the provisioning
  run finishes with the line WS-SETUP-DONE, and the idle-stop below appends to the same file
  afterwards, so WS-SETUP-DONE is a line IN that log and not the last line of it.

  [WS-WIN-IDLE-V49] THIS MACHINE STOPS ITSELF AFTER 30 MINUTES IDLE, AND HERE IS THE OFF
  SWITCH. A scheduled task (PcWsIdleStop) checks every 5 minutes from 10 minutes after boot;
  six consecutive checks with NO Active RDP or console session and CPU under 25% run
  Stop-Computer, which takes the instance to TERMINATED so it stops billing for compute. Any
  activity resets the count to zero -- it is 30 minutes of CONTINUOUS quiet, not 30 minutes
  of quiet on average. A DISCONNECTED RDP session is NOT activity, so closing the RDP window
  and leaving a long job running is the one case you must say something about:

    suspend it (elevated PowerShell on the VM, BEFORE you disconnect):
      New-Item -ItemType File -Force -Path C:\\ProgramData\\paracoding\\ws-busy
    resume it:
      Remove-Item -Force C:\\ProgramData\\paracoding\\ws-busy
    turn it off entirely -- the box then runs, and bills, until you stop it:
      Disable-ScheduledTask -TaskName PcWsIdleStop     (Enable- puts it back)

  The marker is checked FIRST, before anything is measured, so it holds the machine up
  whatever the sessions and the CPU say. Every decision it takes is a line in that log.
EOF
else
cat <<EOF

  WORKSTATION CREATED: LINUX (${WS_VM_NAME:-the workstation} in ${WS_VM_ZONE:-its zone}).
  It is provisioning its remote desktop in the background. The Chrome Remote
  Desktop host CANNOT be registered for you -- the authorisation code is minted against your
  Google account, in your browser, and expires in minutes. Do it by hand, once:

    https://remotedesktop.google.com/headless   -> Begin, Next, Authorize, copy the
    Debian Linux command, then SSH to ${WS_VM_NAME:-the workstation} and paste it there.
      gcloud compute ssh ${WS_VM_NAME:-WORKSTATION} --zone ${WS_VM_ZONE:-ZONE} --tunnel-through-iap
    Then connect at  https://remotedesktop.google.com/access
    Provisioning log on the VM: /var/log/paracoding-ws-setup.log (ends WS-SETUP-DONE)

  [WS-WIN-IDLE-V49] THIS MACHINE STOPS ITSELF AFTER 30 MINUTES IDLE, and it always has --
  it is stated here because the Windows flavour now does the same and neither used to say
  so. /usr/local/bin/ws-idle.sh runs on a systemd timer every 5 minutes from 10 minutes
  after boot; six consecutive checks with no logged-in session and load under 1 run
  \`shutdown -h now\`, and any activity resets the count to zero. Hold it up for an
  unattended job with the busy marker, which is checked before anything is measured:
    sudo touch /run/ws-busy     and    sudo rm -f /run/ws-busy
  Turn it off entirely (the box then runs, and bills, until you stop it):
    sudo systemctl disable --now ws-idle.timer

  THE BROWSER BRIDGE IS ON THIS BOX, AND IT IS NOT ON ANY NETWORK. The startup script
  installs a token-gated DevTools bridge on 127.0.0.1:8025 in front of a Chrome whose
  debugging port is 127.0.0.1:9222. Neither is published, no firewall rule was opened for
  either, and the box has no external IP. Reach it over the tunnel you already have:

    gcloud compute ssh ${WS_VM_NAME:-WORKSTATION} --zone ${WS_VM_ZONE:-ZONE} \\
      --tunnel-through-iap -- -L 8025:127.0.0.1:8025
    then:  curl -H "X-Cdp-Token: \$(gcloud compute ssh ... --command 'sudo cat /opt/cdp-token')" \\
             -d '{"method":"Target.getTargets"}' http://127.0.0.1:8025/rpc

  Eight CDP methods are permitted and the origin allowlist in /opt/cdp-policy.json starts
  EMPTY, so out of the box it drives nothing and tells you which origin it refused. Name
  the sites automation may touch and restart cdp-bridge.

  WHY THE MCP BROWSER TOOLS ARE STILL WITHHELD, STATED PLAINLY: index.ts registers
  browser_tabs / browser_open / browser_navigate only when WS_CDP_PORT is set, and it
  reaches the bridge at the VM's INTERNAL IP. Cloud Run has no path to a 10.x address
  without Direct VPC egress, and this installer configures none and opens no firewall
  rule. Setting WS_CDP_PORT here would register three tools that fail on their first
  call, which is the exact failure this release withholds them to avoid. To connect
  them, give the MCP service VPC egress and set the pair yourself:

    gcloud run services update MCP-SERVICE --region REGION --project PROJECT \\
      --network default --subnet default --vpc-egress private-ranges-only \\
      --update-env-vars WS_CDP_PORT=8025 --update-secrets CDP_TOKEN=...

  and change the bind in /opt/cdp-bridge.py from 127.0.0.1 to this instance's nic0
  address at the same time -- a loopback listener is not reachable from Cloud Run, and
  that is the point of it.
EOF
fi
# [SEC-WSVM-IAPGRANT-V1] EVERY COMMAND ABOVE GOES THROUGH IAP, so this banner must not be the
# last word when the grant that authorises IAP could not be made. THREE STATES, NOT TWO, and
# the third is why this is not a plain else: UNSET means the grant has not been attempted yet
# -- this banner is also printed from the adopt path, which reaches it before
# pc_ws_grant_access runs -- and inventing a warning there would be a false alarm printed on
# a healthy install. Only a MEASURED failure speaks.
if [ "${PC_WS_IAPT_OK:-}" = "0" ]; then
  echo
  echo "  !! THOSE COMMANDS WILL NOT WORK AS THINGS STAND. The IAP tunnel permission could"
  echo "  !! not be granted during this run, and every connection route to this VM goes"
  echo "  !! through IAP. Scroll up to the IAP TUNNEL ACCESS block: it names the exact"
  echo "  !! command an owner must run. Until that is done this machine is billing and"
  echo "  !! unreachable, and re-running the connection commands will not change it."
fi
}

# pc_ws_grant_access KIND -- THE PERMISSION THAT MAKES THE COMMANDS IN THAT BANNER WORK.
#
# [SEC-WSVM-IAPGRANT-V1] THE DEFECT THIS CLOSES, AND WHY NOBODY EVER SAW IT. Both flavours
# are created with --no-address, so the ONLY route in is IAP TCP forwarding -- 3389 for RDP
# on Windows, 22 for SSH on Linux. The firewall rule above opens that path at the NETWORK
# layer and grants nobody permission to USE it. That permission is
# iap.tunnelInstances.accessViaIAP, it is carried by exactly one predefined role, and this
# installer never granted it to anybody. It worked anyway for the only person who had run
# it, because they installed as project Owner and a basic role carries it. Install with
# LESS -- Compute Admin plus the five project permissions 0/10 actually checks for is enough
# to create every resource in this function -- and you get a VM that is created, billed,
# correctly firewalled, printed instructions for, and answers:
#   ERROR: (gcloud.compute.start-iap-tunnel) Error while connecting [4033: Not authorized]
# with nothing in the release explaining why. An installer that produces a system only its
# author can reach has not produced a working system.
#
# THE PRINCIPAL IS THE PERSON AT THE KEYBOARD, WORKED OUT RATHER THAN ASSUMED. The tunnel is
# opened by gcloud on the OPERATOR'S OWN machine -- start-iap-tunnel for RDP, ssh
# --tunnel-through-iap for Linux -- so IAP authorises it against the ACTIVE gcloud account,
# which is the account running this script. It is NOT pc-workstation: that is the VM's own
# identity and a VM does not tunnel to itself. It is NOT the control plane either -- its
# vm_* tools call start, stop, describe and resize, and none of those goes through IAP.
# Granting either would be a binding held by nobody who needs it.
#
# THE SCOPE IS THIS ONE INSTANCE, WHICH IS THE NARROWEST THE API OFFERS AND IS NOT SOMETHING
# GCLOUD CAN DO. IAP tunnel access is an IAM policy on the tunnel resource
# projects/PROJECT/iap_tunnel/zones/ZONE/instances/VM, so what is granted here is
# reachability to THIS workstation and to nothing else in the project -- not every VM, not a
# bastion somebody adds next year. No gcloud command reaches that resource: gcloud iap web
# add-iam-policy-binding accepts app-engine, backend-services, forwarding-rule and cloud-run
# ONLY, and gcloud iap tcp dest-groups addresses destination groups rather than Compute
# instances. The IAP v1 REST surface is the real interface, and curl and python3 are both
# hard prerequisites checked at the top of this script, so this costs no new dependency and
# uses the same shape 0/10 already uses to ask Google what this account may do.
#
# READ, MERGE, WRITE, AND CARRY THE ETAG -- because setIamPolicy REPLACES the whole policy.
# A blind write would silently drop every other binding on the resource, and the etag turns
# a concurrent change into a refused write instead of a lost one.
#
# THEN VERIFIED BY ASKING GOOGLE, NOT BY READING AN EXIT CODE. testIamPermissions on the
# same resource answers whether this account may NOW open a tunnel to THIS instance, which
# is the exact property the operator is about to depend on. A write that returned 200 for a
# resource path Google resolved to something else passes an exit-code check and fails this
# one, which is the whole reason this check exists rather than a status test.
#
# AND WHEN IT CANNOT BE DONE IT SAYS SO AND NAMES THE COMMAND. This installer may hold
# setIamPolicy on the project and not on the tunnel resource, or run where an organization
# policy refuses the member. Silence is the worst outcome available here: it hands somebody
# an hourly bill and a machine they cannot open. It does NOT quietly widen to a project-wide
# grant instead -- widening the blast radius without being asked is not a fallback, it is a
# different decision, and it is the operator's to make.
pc_ws_grant_access() {
PC_WSGA_KIND="$1"
PC_WS_IAPT_OK=0
PC_IAPT_ROLE=roles/iap.tunnelResourceAccessor
PC_IAPT_RES="projects/$PROJECT/iap_tunnel/zones/$WS_VM_ZONE/instances/$WS_VM_NAME"
PC_IAPT_URL="https://iap.googleapis.com/v1/$PC_IAPT_RES"
# THE PORT AND THE PROOF COMMAND BOTH FOLLOW THE FLAVOUR. Printing the Windows tunnel line
# under a Linux box would hand somebody a local port below 1024 and a tunnel to a machine
# they log into with ssh, which is a wrong instruction dressed as a helpful one.
PC_IAPT_PORT=3389
PC_IAPT_TRY="gcloud compute start-iap-tunnel $WS_VM_NAME 3389 --local-host-port=localhost:13389 --zone $WS_VM_ZONE --project $PROJECT"
if [ "$PC_WSGA_KIND" != windows ]; then
  PC_IAPT_PORT=22
  PC_IAPT_TRY="gcloud compute ssh $WS_VM_NAME --zone $WS_VM_ZONE --project $PROJECT --tunnel-through-iap"
fi
# THE PRINCIPAL TYPE MUST MATCH THE IDENTITY. An IAM member is TYPE:EMAIL and Google refuses
# a mismatched pair outright rather than ignoring it -- the same rule 8/10 follows for the
# console binding, and it is spelled out again here because this function also runs from
# workstation.sh, which never computes an account of its own.
PC_IAPT_ACCT=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)
case "$PC_IAPT_ACCT" in
  "")                   PC_IAPT_MEMBER="" ;;
  *gserviceaccount.com) PC_IAPT_MEMBER="serviceAccount:$PC_IAPT_ACCT" ;;
  *)                    PC_IAPT_MEMBER="user:$PC_IAPT_ACCT" ;;
esac
PC_IAPT_WHY=""
PC_IAPT_SET=""
PC_IAPT_TOK=$(gcloud auth print-access-token 2>/dev/null)
if [ -z "$PC_IAPT_MEMBER" ]; then
  PC_IAPT_WHY="gcloud reports no ACTIVE account, so there is no principal to grant it to."
elif [ -z "$PC_IAPT_TOK" ]; then
  PC_IAPT_WHY="no access token could be minted (gcloud auth print-access-token said nothing)."
else
  PC_IAPT_CUR=$(curl -sS -m 30 -X POST -H "Authorization: Bearer $PC_IAPT_TOK" -H "Content-Type: application/json" -d '{}' "$PC_IAPT_URL:getIamPolicy" 2>/dev/null)
  # AN ABSENT POLICY IS THE NORMAL FRESH CASE and comes back as {} with no etag; an ERROR
  # object is NOT that and must never be merged into, because a merge that starts from an
  # error body writes a policy containing only our binding and erases whatever was there.
  PC_IAPT_BODY=$(PC_IAPT_POL="${PC_IAPT_CUR:-}" PC_IAPT_M="$PC_IAPT_MEMBER" PC_IAPT_R="$PC_IAPT_ROLE" python3 - <<'PC_IAPT_MERGE_EOF'
import json, os, sys
raw = os.environ.get("PC_IAPT_POL") or ""
try:
    pol = json.loads(raw) if raw.strip() else {}
except Exception:
    sys.exit(3)
if not isinstance(pol, dict) or "error" in pol:
    sys.exit(3)
member = os.environ["PC_IAPT_M"]
role = os.environ["PC_IAPT_R"]
out = {}
if pol.get("etag"):
    out["etag"] = pol["etag"]
bindings, found = [], False
for b in pol.get("bindings") or []:
    if not isinstance(b, dict):
        sys.exit(3)
    b = dict(b)
    if b.get("role") == role and not b.get("condition"):
        members = list(b.get("members") or [])
        if member not in members:
            members.append(member)
        b["members"] = members
        found = True
    bindings.append(b)
if not found:
    bindings.append({"role": role, "members": [member]})
out["bindings"] = bindings
sys.stdout.write(json.dumps({"policy": out}))
PC_IAPT_MERGE_EOF
) || PC_IAPT_BODY=""
  if [ -z "$PC_IAPT_BODY" ]; then
    PC_IAPT_WHY="the current IAM policy on that tunnel resource could not be read or parsed."
    PC_IAPT_SET="${PC_IAPT_CUR:-}"
  else
    PC_IAPT_SET=$(curl -sS -m 30 -X POST -H "Authorization: Bearer $PC_IAPT_TOK" -H "Content-Type: application/json" -d "$PC_IAPT_BODY" "$PC_IAPT_URL:setIamPolicy" 2>/dev/null)
    # IAM IS EVENTUALLY CONSISTENT, so a single immediate probe would report a false NO on a
    # grant that is perfectly fine thirty seconds later -- and this block's whole value is
    # that its NO is trustworthy. Bounded, and it stops the instant the answer is yes.
    PC_IAPT_N=0
    while [ "$PC_IAPT_N" -lt 5 ]; do
      PC_IAPT_CHK=$(curl -sS -m 30 -X POST -H "Authorization: Bearer $PC_IAPT_TOK" -H "Content-Type: application/json" -d '{"permissions":["iap.tunnelInstances.accessViaIAP"]}' "$PC_IAPT_URL:testIamPermissions" 2>/dev/null)
      # THE ERROR ARM IS FIRST AND THAT ORDERING IS LOAD-BEARING. A denial message can quote
      # the permission it denied, so a bare substring test for the permission name would read
      # a refusal as a success. An error body is never a yes, whatever text it contains.
      case "${PC_IAPT_CHK:-}" in
        *'"error"'*)     : ;;
        *accessViaIAP*)  PC_WS_IAPT_OK=1; break ;;
      esac
      PC_IAPT_N=$((PC_IAPT_N+1))
      [ "$PC_IAPT_N" -lt 5 ] && sleep $((PC_IAPT_N*3))
    done
    [ "$PC_WS_IAPT_OK" = 1 ] || PC_IAPT_WHY="IAP still reports that $PC_IAPT_ACCT may NOT open a tunnel to this instance after the grant was written."
  fi
fi
echo
if [ "$PC_WS_IAPT_OK" = 1 ]; then
  echo "  IAP TUNNEL ACCESS: $PC_IAPT_MEMBER now holds $PC_IAPT_ROLE"
  echo "  ON THIS ONE INSTANCE ONLY -- $PC_IAPT_RES"
  echo "  -- not on the project, so it grants reachability to this workstation and to no"
  echo "  other VM. This line is a MEASUREMENT: IAP was asked whether that account may open"
  echo "  a tunnel to this instance and answered yes. It is not the exit code of a write."
else
  echo "  !! IAP TUNNEL ACCESS WAS NOT GRANTED, AND WITHOUT IT THIS VM IS UNREACHABLE."
  echo "  !! $PC_IAPT_WHY"
  if [ -n "$PC_IAPT_SET" ]; then
    echo "  !! what the IAP API said:"
    echo "  !!   $PC_IAPT_SET" | cut -c1-500
  fi
  echo "  !!"
  echo "  !! THE VM EXISTS AND IS BILLING. It has no external address and its only ingress is"
  echo "  !! IAP TCP forwarding on port $PC_IAPT_PORT, so until the role below is held by the"
  echo "  !! account you tunnel with, every connection command this script printed will fail"
  echo "  !! with: Error while connecting [4033: Not authorized]. That is a PERMISSION error"
  echo "  !! and no amount of retrying, re-imaging or firewall editing will change it."
  echo "  !!"
  echo "  !! THE NARROW FIX, ONE INSTANCE, which is what this script tried and could not do."
  echo "  !! There is no gcloud command for it; the IAP REST surface is the only interface,"
  echo "  !! or use the IAP page in the console, SSH and TCP Resources tab, tick this VM and"
  echo "  !! add the principal with the IAP-Secured Tunnel User role."
  echo "  !!"
  echo "  !! THE FIX A PROJECT OWNER CAN RUN AS ONE LINE. It is WIDER than the above -- it"
  echo "  !! covers every VM in $PROJECT, not just this one -- and it is not run for you"
  echo "  !! precisely because widening the blast radius is your decision and not this"
  echo "  !! script's:"
  echo "  !!   gcloud projects add-iam-policy-binding $PROJECT --member=${PC_IAPT_MEMBER:-user:YOUR_EMAIL} --role=roles/iap.tunnelResourceAccessor --condition=None"
  echo "  !!"
  echo "  !! Then check it took, rather than assuming: re-run this script, or"
  echo "  !!   $PC_IAPT_TRY"
fi
# ---- the Linux sibling: OS LOGIN, which has the identical shape and the identical cause ----
# [SEC-WSVM-IAPGRANT-V1] The tunnel gets you a TCP connection to port 22. It does not get you
# a LOGIN. This instance is created with enable-oslogin=TRUE, which makes sshd refuse
# password and key authentication and defer to IAM instead -- so the account that opens the
# tunnel also needs an OS Login role, and Owner carries that too. Same defect, same flavour
# of invisibility, one line further down the connection.
#
# PROJECT LEVEL, AND THAT IS NOT THIS SCRIPT BEING LAZY. Google's OS Login setup guide states
# the grant level as "On the Project or instance", and then: "If a user requires SSH access
# from Google Cloud console or Google Cloud CLI, you must grant these roles at the project
# level." gcloud compute ssh IS the CLI, and it is the command every banner in this file
# prints, so an instance-scoped binding here would be a narrower grant that does not work.
# THE NON-ADMIN ROLE IS CHOSEN DELIBERATELY. roles/compute.osLogin is a normal user with no
# sudo; roles/compute.osAdminLogin is root on every VM in the project. The Chrome Remote
# Desktop registration these banners walk you through needs neither, so the smaller one is
# granted and the one command in this release that DOES need sudo is named below rather than
# paid for by everybody.
if [ "$PC_WSGA_KIND" != windows ]; then
  PC_OSL_RC=0
  if [ -n "$PC_IAPT_MEMBER" ]; then
    retry gcloud projects add-iam-policy-binding "$PROJECT" --member="$PC_IAPT_MEMBER" --role=roles/compute.osLogin --condition=None >/dev/null 2>&1 || PC_OSL_RC=$?
  else
    PC_OSL_RC=1
  fi
  echo
  if [ "$PC_OSL_RC" = 0 ]; then
    echo "  OS LOGIN: $PC_IAPT_MEMBER now holds roles/compute.osLogin on $PROJECT."
    echo "  The tunnel gets you to port 22; this is what lets you log IN once you are there."
    echo "  It is project level because Google requires that for CLI SSH, and it is the"
    echo "  NON-ADMIN role: no sudo. The one command in this release that needs sudo is the"
    echo "  CDP bridge token read, and for that grant yourself roles/compute.osAdminLogin."
  else
    echo "  !! OS LOGIN ROLE NOT GRANTED (exit $PC_OSL_RC). This box has enable-oslogin=TRUE,"
    echo "  !! so sshd refuses passwords and keys and asks IAM instead. Even with the tunnel"
    echo "  !! working, gcloud compute ssh will connect and then be refused at login."
    echo "  !! An owner fixes it with:"
    echo "  !!   gcloud projects add-iam-policy-binding $PROJECT --member=${PC_IAPT_MEMBER:-user:YOUR_EMAIL} --role=roles/compute.osLogin --condition=None"
    echo "  !! (use roles/compute.osAdminLogin instead if you want sudo on the box)"
  fi
fi
}

# pc_workstation_create KIND
# Sets WS_VM_NAME and WS_VM_ZONE for the caller. Creates whatever is missing and ADOPTS
# whatever is already there; every prerequisite below (Cloud Router, Cloud NAT, the
# pc-workstation service account and its two IAM bindings, and the IAP-only RDP firewall
# rule) is describe-first / create-if-absent, so a second run of this function costs a
# handful of describes and changes nothing. Needs: PROJECT, REGION, HERE, die, retry.
pc_workstation_create() {
PC_WS_KIND="$1"
PC_WS_REFUSED=0
  # [SEC-WSVM-PERFLAVOUR-V1] ONE INSTANCE NAME PER FLAVOUR, AND THAT IS A BUG FIX.
  # There used to be a single name, paracoding-workstation, for both flavours. Two things
  # followed from that and both were wrong. First, you could never have a Linux box and a
  # Windows box at the same time. Second -- and this is the defect -- the adopt path was
  # FLAVOUR-BLIND: asking for windows on a project that already had a Linux
  # paracoding-workstation adopted the LINUX box, created nothing, and then printed the
  # Windows next-steps for a machine that has no RDP on it. Separate names remove the
  # collision entirely, so the adopt path can no longer adopt the wrong operating system.
  case "$PC_WS_KIND" in
    windows) WS_VM_NAME=paracoding-${PC_LP}${PC_TOK}workstation-win ;;
    linux)   WS_VM_NAME=paracoding-${PC_LP}${PC_TOK}workstation-linux ;;
    *)       die "pc_workstation_create: unknown flavour '"'"'$PC_WS_KIND'"'"' (want linux or windows)" ;;
  esac
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
  if [ -z "$WS_VM_ZONE" ]; then
    # BACK-COMPAT, AND IT IS FLAVOUR-CHECKED. Installs cut before the rename above created a
    # single instance literally named paracoding-workstation. Ignoring it would bill a SECOND
    # machine for the same person; adopting it blind is the exact defect the rename fixes. So
    # it is adopted ONLY when the licences on its boot disk say it runs the OS being asked
    # for. "unknown" never matches, so a describe we could not read is never adopted either.
    PC_LEGACY_RC=0
    PC_LEGACY=$(gcloud compute instances list --project "$PROJECT" \
      --filter="name=(paracoding-${PC_LP}workstation)" --format='value(zone)' 2>/dev/null) || PC_LEGACY_RC=$?
    [ "$PC_LEGACY_RC" -eq 0 ] || die "could not list the Compute Engine instances in $PROJECT
(exit $PC_LEGACY_RC) while looking for a pre-rename paracoding-workstation. Refusing to
continue for the same reason as above: a failed list is not an empty list, and treating it as
one creates a second billed VM."
    PC_LEGACY_ZONE=$(printf '%s\n' "$PC_LEGACY" | sed -n '1p' | sed 's#.*/##')
    if [ -n "$PC_LEGACY_ZONE" ]; then
      PC_LEGACY_KIND=$(pc_ws_flavour_of "paracoding-${PC_LP}workstation" "$PC_LEGACY_ZONE")
      if [ "$PC_LEGACY_KIND" = "$PC_WS_KIND" ]; then
        echo "  found the pre-rename instance paracoding-${PC_LP}workstation in $PC_LEGACY_ZONE and it"
        echo "  reports as a $PC_LEGACY_KIND machine, so it is ADOPTED rather than duplicated."
        WS_VM_NAME=paracoding-${PC_LP}workstation
        WS_VM_ZONE="$PC_LEGACY_ZONE"
      else
        echo "  NOTE: this project has a pre-rename instance named paracoding-${PC_LP}workstation in"
        echo "  $PC_LEGACY_ZONE, and it reports as a $PC_LEGACY_KIND machine, not $PC_WS_KIND."
        echo "  It is NOT adopted, NOT re-imaged and NOT deleted. $WS_VM_NAME is created"
        echo "  alongside it. If you do not want two, delete the old one yourself."
      fi
    fi
  fi
  if [ -n "$WS_VM_ZONE" ]; then
    # ADOPT. Re-running this for a flavour that already exists is a NO-OP BY DESIGN: nothing
    # is created, nothing is re-imaged, nothing is destroyed. The details are printed because
    # "it already exists" with no further information is indistinguishable from "it did
    # nothing and will not say why".
    echo "  ADOPTING the existing instance $WS_VM_NAME in $WS_VM_ZONE -- nothing created,"
    echo "  nothing re-imaged, nothing destroyed."
    PC_ADOPT_INFO=$(gcloud compute instances describe "$WS_VM_NAME" --zone "$WS_VM_ZONE" \
      --project "$PROJECT" \
      --format='value(status,machineType.basename(),disks[0].diskSizeGb)' 2>/dev/null || true)
    [ -n "$PC_ADOPT_INFO" ] && echo "  status / machine type / boot disk GB: $PC_ADOPT_INFO"
    PC_ADOPT_KIND=$(pc_ws_flavour_of "$WS_VM_NAME" "$WS_VM_ZONE")
    echo "  it reports as a $PC_ADOPT_KIND machine."
    if [ "$PC_ADOPT_KIND" != unknown ] && [ "$PC_ADOPT_KIND" != "$PC_WS_KIND" ]; then
      echo "  !! THAT IS NOT THE FLAVOUR YOU ASKED FOR ($PC_WS_KIND). It was NOT re-imaged:"
      echo "  !! re-imaging an existing machine from an installer destroys whatever is on it,"
      echo "  !! and that decision is yours. Delete it and re-run if that is what you want."
    fi
    WS_IMG_FAMILY=""
    pc_ws_access_banner "$PC_WS_KIND"
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
region, or create the workstation yourself and set WS_VM and WS_ZONE on
${CP_SVC:-the paracoding-control-plane service}."
    # [SEC-WSVM-USABLE-V1] WHAT THIS USED TO CREATE WAS NOT A WORKSTATION. It was
    # e2-standard-2 / debian-12 / no --boot-disk-* at all (so the 10 GB family default) /
    # --no-address --no-service-account --no-scopes. Four separate defects, and together they
    # made the machine unusable rather than merely austere:
    #   - DEBIAN. The Claude desktop app does not run on it. Ubuntu LTS below.
    #   - 10 GB. A desktop environment plus Chrome does not fit. 100 GB pd-balanced below.
    #   - 2 vCPU / 8 GB. A desktop plus a browser needs more. e2-standard-4 below.
    #   - NO EGRESS AT ALL. --no-address with no Cloud NAT means the box cannot apt-get
    #     anything, so it could never have installed the desktop it was missing anyway. That
    #     is the defect that made the other three unfixable from inside the machine.
    #
    # THE EGRESS DECISION, STATED RATHER THAN IMPLIED: we still refuse to put a public IP on
    # this box by default, because an external IP publishes port 22 to the internet. Instead
    # we provision Cloud NAT + a Cloud Router in $REGION -- outbound only, nothing inbound,
    # and Chrome Remote Desktop is an outbound-only protocol so it needs no ingress and no
    # firewall rule. If NAT cannot be provisioned (commonly: this project has no `default`
    # VPC network) we FALL BACK to an ephemeral external IP and SAY SO LOUDLY below, because
    # a machine with no egress is worse than a machine with a documented exposure -- but OS
    # Login stays enforced either way, which is what actually keeps port 22 shut.
    PC_WS_NET_FLAG="--no-address"
    PC_WS_EGRESS="cloud-nat"
    PC_WS_NET=default
    PC_NAT_RTR=paracoding-nat-router
    PC_NAT_CFG=paracoding-nat
    if gcloud compute networks describe "$PC_WS_NET" --project "$PROJECT" >/dev/null 2>&1; then
      gcloud compute routers describe "$PC_NAT_RTR" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 \
        || retry gcloud compute routers create "$PC_NAT_RTR" --network "$PC_WS_NET" \
             --region "$REGION" --project "$PROJECT" --quiet >/dev/null 2>&1 || true
      gcloud compute routers nats describe "$PC_NAT_CFG" --router "$PC_NAT_RTR" \
        --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 \
        || retry gcloud compute routers nats create "$PC_NAT_CFG" --router "$PC_NAT_RTR" \
             --region "$REGION" --project "$PROJECT" --auto-allocate-nat-external-ips \
             --nat-all-subnet-ip-ranges --quiet >/dev/null 2>&1 || true
      gcloud compute routers nats describe "$PC_NAT_CFG" --router "$PC_NAT_RTR" \
        --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || PC_WS_EGRESS=""
    else
      PC_WS_EGRESS=""
    fi
    if [ -z "$PC_WS_EGRESS" ]; then
      # Omitting --no-address entirely is what asks for an ephemeral external IP; an empty
      # --address= would be a second way of spelling the same thing and a worse one to
      # word-split. This expands to nothing at all.
      PC_WS_NET_FLAG=""
      PC_WS_EGRESS="external-ip"
    fi
    # A DEDICATED SERVICE ACCOUNT, NOT THE COMPUTE DEFAULT. The compute default SA is a
    # project-wide credential that anyone with a shell on the box can mint tokens from. This
    # one holds logWriter and metricWriter and nothing else, and the scopes are narrowed to
    # match, so a compromised workstation can write logs and read images -- not touch the lake,
    # the secrets or the control plane.
    WS_SA="pc-${PC_LP}${PC_TOK}workstation@${PROJECT}.iam.gserviceaccount.com"
    gcloud iam service-accounts describe "$WS_SA" --project "$PROJECT" >/dev/null 2>&1 \
      || retry gcloud iam service-accounts create "pc-${PC_LP}${PC_TOK}workstation" \
           --display-name "workstation" --project "$PROJECT" >/dev/null
    retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$WS_SA" \
      --role=roles/logging.logWriter --condition=None >/dev/null
    retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$WS_SA" \
      --role=roles/monitoring.metricWriter --condition=None >/dev/null
    # [SEC-WSVM-WINDOWS-V1] THE WINDOWS ALTERNATIVE STARTS HERE, AND NOTE WHAT IS *ABOVE*
    # THIS LINE: the instance-name lookup, the zone listing, the Cloud NAT + Cloud Router and
    # the dedicated pc-workstation service account are ALL SHARED, deliberately. The NAT was
    # NOT duplicated for Windows -- there is one router (paracoding-nat-router) and one NAT
    # config (paracoding-nat) per region no matter which flavour is chosen, so switching
    # flavours cannot leave a second billed NAT gateway behind. Only the image, the ACCESS
    # MODEL and the provisioning script differ below.
    if [ "$PC_WS_KIND" = windows ]; then
    # EGRESS IS A HARD REQUIREMENT HERE AND THE EXTERNAL-IP FALLBACK IS *REFUSED*.
    # The Linux path above may fall back to an ephemeral external IP when no Cloud NAT can be
    # provisioned; that is defensible there because OS Login refuses password and key SSH, so
    # the exposed port is not an authentication surface. NONE OF THAT IS TRUE ON WINDOWS. The
    # auto-created "default" VPC ships a rule named default-allow-rdp permitting tcp:3389
    # from 0.0.0.0/0 to every instance in the network, and Windows authenticates RDP with a
    # PASSWORD. An external IP here is therefore not a documented trade-off, it is a
    # password-guessable administrator login on the public internet from first boot. Die.
    if [ "$PC_WS_EGRESS" != cloud-nat ]; then
      # [GCP-WS-OPTIONAL-NOT-FATAL-V76] THE REFUSAL IS RIGHT; KILLING THE INSTALL OVER IT IS
      # NOT. This used to `die`, which aborted the ENTIRE install at 5d/10 -- after Firestore,
      # the service accounts, the secrets, the URLs, the KMS keys and all three buckets had
      # been created -- because an OPTIONAL component could not be built safely. The workstation
      # is optional by construction: `none` is the documented default and the banner below says
      # nothing else in this install depends on it. An optional step that can fail the whole run
      # is a defect regardless of how correct its reasoning is.
      # WHAT IS UNCHANGED: the VM is still NOT created, and the external-IP fallback is still
      # REFUSED. Windows authenticates RDP with a password and the default VPC allows tcp:3389
      # from 0.0.0.0/0, so an external IP here is a password-guessable administrator login on
      # the public internet. That judgement stands; only the blast radius changes.
      pc_ws_warn "refusing to create the WINDOWS workstation without Cloud NAT.
No usable Cloud NAT could be provisioned in $REGION, and the only other way to give this VM
egress is an external IP. On Linux that is a trade-off worth printing; on Windows it is an
open RDP port -- the auto-created 'default' VPC contains default-allow-rdp, which allows
tcp:3389 from 0.0.0.0/0, and RDP authenticates with a password. Fix the network (create a
Cloud NAT in $REGION and re-run), or choose PC_WS_KIND=linux, which can safely take an
external IP because OS Login refuses password and key SSH.
THE INSTALL IS CONTINUING WITHOUT A WORKSTATION. Nothing else depends on it; the four vm_*
tools will not work until you add one. Re-run workstation.sh, or this installer with
PC_WS_KIND=..., once the network is fixed."
      PC_WS_REFUSED=1
      return 0
    fi
    # RDP OVER IAP TCP FORWARDING, AND NOTHING ELSE. The instance keeps --no-address, so the
    # ONLY route to 3389 is Google's IAP forwarder, which authenticates the operator against
    # IAM before a single packet reaches the VM. 35.235.240.0/20 IS IAP'S OWN SOURCE RANGE
    # and it is the only source this rule accepts; the rule is further narrowed to instances
    # carrying our tag, so it cannot accidentally expose anything else in the project.
    # IF YOU ARE EVER TEMPTED TO WIDEN THIS TO 0.0.0.0/0 TO "JUST GET IN": that is the
    # mistake this comment exists to stop, and it is not a smaller mistake than it looks.
    PC_RDP_TAG=paracoding-rdp-iap
    PC_RDP_FW=paracoding-allow-rdp-iap
    gcloud compute firewall-rules describe "$PC_RDP_FW" --project "$PROJECT" >/dev/null 2>&1 \
      || retry gcloud compute firewall-rules create "$PC_RDP_FW" --project "$PROJECT" \
           --network "$PC_WS_NET" --direction INGRESS --action allow --rules tcp:3389 \
           --source-ranges 35.235.240.0/20 --target-tags "$PC_RDP_TAG" --priority 1000 \
           --description "RDP to tagged workstations from IAP TCP forwarding ONLY" \
           --quiet >/dev/null 2>&1 || true
    gcloud compute firewall-rules describe "$PC_RDP_FW" --project "$PROJECT" >/dev/null 2>&1 \
      || die "the firewall rule $PC_RDP_FW is still absent after a create attempt. Refusing to
continue: without it IAP TCP forwarding cannot reach 3389 and this workstation would be
created, billed, and impossible to log in to. The describe is the authority here and not the
create status, because a concurrent run makes create a 409 and that is success for us."
    # A PRE-EXISTING default-allow-rdp IS NOT OURS AND IS NOT DELETED HERE -- other instances
    # in this project may be relying on it, and an installer that silently removes a firewall
    # rule it did not create is a worse citizen than one that names it. It is checked and
    # reported below, because it is the one rule that would undo everything above the moment
    # anything in this project gets an external IP.
    PC_RDP_WORLD=""
    gcloud compute firewall-rules describe default-allow-rdp --project "$PROJECT" \
      --format='value(sourceRanges.list())' 2>/dev/null | grep -q '0\.0\.0\.0/0' \
      && PC_RDP_WORLD=1
    # WINDOWS SERVER WITH DESKTOP EXPERIENCE, RESOLVED NOT ASSUMED -- exactly the discipline
    # the Ubuntu path uses, for exactly the same reason. Image families ARE retired (
    # windows-2012-r2 is gone) and which one is newest changes every couple of years, so a
    # hardcoded family is a create that fails with a message about images rather than about
    # this line. Take the first the project can actually describe, newest first. The -core
    # families are DELIBERATELY ABSENT: Server Core has no desktop, and a desktop is the
    # entire point of this VM -- silently landing on Core would reproduce the exact defect
    # (a workstation you cannot look at) that this whole step was rewritten to fix.
    WS_IMG_FAMILY=""
    for _f in windows-2025 windows-2022 windows-2019 windows-2016; do
      if gcloud compute images describe-from-family "$_f" --project windows-cloud \
           >/dev/null 2>&1; then WS_IMG_FAMILY="$_f"; break; fi
    done
    [ -n "$WS_IMG_FAMILY" ] || die "no Windows Server Desktop Experience image family
(windows-2025, windows-2022, windows-2019, windows-2016) could be resolved from the
windows-cloud image project. Refusing to guess a family name and refusing to fall back to a
Server Core family: Core has no desktop, and a workstation you cannot see is not a
workstation. Check that the Compute Engine API is enabled on $PROJECT."
    # THE PROVISIONING SCRIPT. windows-startup-script-ps1 is run by the Google guest agent on
    # EVERY boot, so it MUST be idempotent -- it stamps a version marker and returns at once
    # on a re-run, the same contract as the Linux startup script. Written to a file and
    # attached with --metadata-from-file so the PowerShell never has to survive a second
    # round of shell quoting; the delimiter is QUOTED, so every $ below belongs to PowerShell.
    cat > "$HERE/.ws-startup.ps1" <<'PC_WS_PS1_EOF'
# Paracoding Windows workstation provisioning (windows-startup-script-ps1).
# IDEMPOTENT BY CONTRACT: this runs on every boot. Stamp, then return.
$ErrorActionPreference = 'Continue'
$PcRoot  = 'C:\ProgramData\paracoding'
$PcStamp = Join-Path $PcRoot 'ws-setup.v1'
$PcLog   = Join-Path $PcRoot 'ws-setup.log'
New-Item -ItemType Directory -Force -Path $PcRoot | Out-Null
function Write-PcLog([string]$Message) {
  Add-Content -Path $PcLog -Value ("{0} {1}" -f (Get-Date).ToUniversalTime().ToString('s'), $Message)
}
Write-PcLog "== paracoding ws-setup starting"
if (Test-Path $PcStamp) {
  Write-PcLog "already provisioned; nothing to do"
  Add-Content -Path $PcLog -Value "WS-SETUP-DONE"
  exit 0
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# NOTHING FETCHED FROM THE NETWORK IS EXECUTED UNVERIFIED. Every installer below is pulled
# over https from the VENDOR'S OWN host and its AUTHENTICODE SIGNATURE is checked before it
# runs: the status must be Valid and the signing subject must contain the expected publisher.
# The usual Windows shortcut -- `iwr https://... | iex`, which is how Chocolatey bootstraps
# itself -- is deliberately NOT used here: it executes whatever arrives, with no signature to
# check at all, which is the Windows spelling of `curl | sh`.
function Get-PcVerified([string]$Url, [string]$Dest, [string]$Publisher) {
  try {
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -TimeoutSec 900
  } catch {
    Write-PcLog ("DOWNLOAD FAILED {0}: {1}" -f $Url, $_.Exception.Message)
    return $false
  }
  if (-not (Test-Path $Dest)) { Write-PcLog ("DOWNLOAD FAILED {0}: no file written" -f $Url); return $false }
  $sig = Get-AuthenticodeSignature -FilePath $Dest
  if ($sig.Status -ne 'Valid') {
    Write-PcLog ("REFUSED {0}: Authenticode status is {1}, not Valid" -f $Dest, $sig.Status)
    Remove-Item -Force $Dest -ErrorAction SilentlyContinue
    return $false
  }
  $subject = ''
  if ($sig.SignerCertificate) { $subject = [string]$sig.SignerCertificate.Subject }
  if ($subject -notmatch [regex]::Escape($Publisher)) {
    Write-PcLog ("REFUSED {0}: signed by '{1}', wanted a subject containing '{2}'" -f $Dest, $subject, $Publisher)
    Remove-Item -Force $Dest -ErrorAction SilentlyContinue
    return $false
  }
  Write-PcLog ("verified {0}: signed by {1}" -f $Dest, $subject)
  return $true
}
function Get-PcMetadata([string]$Key) {
  try {
    $u = "http://metadata.google.internal/computeMetadata/v1/instance/attributes/" + $Key
    return [string](Invoke-RestMethod -Uri $u -Headers @{'Metadata-Flavor' = 'Google'} -TimeoutSec 10)
  } catch {
    return ''
  }
}

# RDP: ASSERTED, NOT ASSUMED. The Google Windows images ship with it enabled, but this costs
# nothing and turns "the image changed" into a no-op instead of a lockout. This is the HOST
# firewall; the VPC rule that actually decides who can reach 3389 is the IAP-scoped one the
# installer created, and that one allows 35.235.240.0/20 and nothing else.
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' `
  -Name 'fDenyTSConnections' -Value 0 -ErrorAction SilentlyContinue
Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue

# GOOGLE CHROME, from Google's own enterprise MSI over https, signature checked above.
$PcChromeExe = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $PcChromeExe)) {
  $msi = Join-Path $env:TEMP 'pc-chrome.msi'
  if (Get-PcVerified 'https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi' $msi 'Google LLC') {
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $msi, '/qn', '/norestart') -Wait -PassThru
    Write-PcLog ("google chrome: msiexec exit {0}" -f $p.ExitCode)
  } else {
    Write-PcLog "SKIPPED google chrome: the installer could not be downloaded or verified"
  }
  Remove-Item -Force $msi -ErrorAction SilentlyContinue
} else {
  Write-PcLog "google chrome already present"
}

# THE CLAUDE DESKTOP APP -- THE SAME JUDGEMENT CALL, AND THE SAME ANSWER, AS THE LINUX PATH.
# [SEC-WSCLAUDE-PIN-V1] THIS PARAGRAPH USED TO SAY "Anthropic publishes no stable, guessable
# Windows installer URL", and the code below was correct given that premise. The premise is
# false: Anthropic's own download page, claude.com/download, publishes a VERSIONLESS setup
# redirect, and the installer now writes it onto the instance as pc-claude-win-url. NOT ONE
# LINE OF THE LOGIC BELOW CHANGED -- it still reads that key, still requires https, and still
# hands the download to Get-PcVerified, which REFUSES any file whose Authenticode subject
# does not contain "Anthropic". That refusal is what makes pinning a URL safe: if the
# endpoint ever stops serving an Anthropic-signed binary this path fails CLOSED and takes the
# fallback. It is still a METADATA value precisely so nobody has to cut a new release to
# change it, and an operator who sets pc-claude-win-url themselves still overrides the pin.
# With no URL, or one that fails, we do NOT guess -- we create a dedicated Chrome app window
# for claude.ai and SAY SO, so this log never claims an install that did not happen.
$PcClaudeOk = $false
$PcClaudeUrl = (Get-PcMetadata 'pc-claude-win-url').Trim()
if ($PcClaudeUrl -and $PcClaudeUrl.StartsWith('https://')) {
  $exe = Join-Path $env:TEMP 'pc-claude-setup.exe'
  if (Get-PcVerified $PcClaudeUrl $exe 'Anthropic') {
    $p = Start-Process -FilePath $exe -ArgumentList @('/S') -Wait -PassThru
    Write-PcLog ("claude desktop installer exit {0}" -f $p.ExitCode)
    if ($p.ExitCode -eq 0) { $PcClaudeOk = $true }
  }
  Remove-Item -Force $exe -ErrorAction SilentlyContinue
} elseif ($PcClaudeUrl) {
  Write-PcLog "REFUSED pc-claude-win-url: it is not an https URL"
}
if (-not $PcClaudeOk) {
  Write-PcLog "no Claude desktop installer ran; creating a Chrome app window for claude.ai instead"
  if (Test-Path $PcChromeExe) {
    $lnk = 'C:\Users\Public\Desktop\Claude.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath = $PcChromeExe
    $sc.Arguments = '--app=https://claude.ai/'
    $sc.IconLocation = $PcChromeExe
    $sc.Description = 'Claude, in a dedicated app window'
    $sc.Save()
    Write-PcLog ("created {0}" -f $lnk)
  } else {
    Write-PcLog "SKIPPED the Claude shortcut: chrome is not installed"
  }
}

# THE CLAUDE CHROME EXTENSION, FORCE-INSTALLED BY CHROME'S OWN POLICY MECHANISM -- NOT
# SIDELOADED. ExtensionInstallForcelist under HKLM SOFTWARE Policies Google Chrome is how an
# enterprise pins an extension: Chrome fetches it from the Web Store itself, verifies the
# publisher signature, keeps it updated and refuses to let it be disabled. Downloading a .crx
# and dropping it in a directory bypasses every one of those properties, so we do not.
#
# THE EXTENSION ID IS NOT HARDCODED, AND THAT IS A SECURITY DECISION, NOT LAZINESS. An
# extension id IS a capability: whoever owns that id gets code running in this operator's
# browser, on whatever pages the extension requests. The real published id of Anthropic's
# Chrome extension could NOT be established from an authoritative source when this was
# written, and a wrong id here would silently force-install A STRANGER'S EXTENSION on every
# workstation this installer ever creates -- unremovable, because that is what forcelist
# means. So the id comes from instance metadata, it is validated to be exactly 32 characters
# in a-p (the only alphabet a Chrome extension id uses), and WHEN IT IS UNSET THIS BLOCK
# DOES NOTHING AND SAYS SO IN THE LOG. Set it with:
#   gcloud compute instances add-metadata NAME --zone ZONE --metadata pc-claude-ext-id=ID
$PcExtId = (Get-PcMetadata 'pc-claude-ext-id').Trim().ToLower()
if (-not $PcExtId) {
  Write-PcLog "SKIPPED the Claude chrome extension: instance metadata pc-claude-ext-id is unset, and this script will not guess an extension id"
} elseif ($PcExtId -notmatch '^[a-p]{32}$') {
  Write-PcLog ("REFUSED pc-claude-ext-id '{0}': a chrome extension id is exactly 32 characters a-p" -f $PcExtId)
} else {
  $PcPolKey = 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'
  $PcEntry  = $PcExtId + ';https://clients2.google.com/service/update2/crx'
  New-Item -Path $PcPolKey -Force | Out-Null
  $PcHave = $false
  $PcMax  = 0
  $PcProps = Get-ItemProperty -Path $PcPolKey -ErrorAction SilentlyContinue
  if ($PcProps) {
    foreach ($p in $PcProps.PSObject.Properties) {
      if ($p.Name -match '^[0-9]+$') {
        if ([int]$p.Name -gt $PcMax) { $PcMax = [int]$p.Name }
        if ([string]$p.Value -eq $PcEntry) { $PcHave = $true }
      }
    }
  }
  if ($PcHave) {
    Write-PcLog "claude chrome extension policy already present; nothing to do"
  } else {
    New-ItemProperty -Path $PcPolKey -Name ([string]($PcMax + 1)) -Value $PcEntry -PropertyType String -Force | Out-Null
    Write-PcLog ("force-installed the claude chrome extension by policy: {0} = {1}" -f ($PcMax + 1), $PcEntry)
  }
}

# [WS-WIN-IDLE-V49] THE IDLE STOP. MEASURED: THIS BOX HAD NONE AND THE LINUX ONE HAS HAD ONE
# ALL ALONG. linux-startup.sh installs ws-idle.sh plus a ws-idle.timer (OnBootSec=10min,
# OnUnitActiveSec=5min) that stops that machine after 30 minutes of quiet. Searching this
# script for idle, shutdown or Stop-Computer before this block returned NOTHING, and neither
# flavour's description said so -- so an operator who had used the Linux box provisioned a
# Windows one, assumed the same behaviour, and was only saved from an all-night bill by
# stopping it by hand. The assumption was reasonable; the silence was the defect.
#
# THE SEMANTICS ARE THE LINUX ONES, NOT AN APPROXIMATION OF THEM: a check every 5 minutes
# starting 10 minutes after boot, SIX CONSECUTIVE idle checks before anything happens, a busy
# marker that overrides everything, and a counter that RESETS TO ZERO on any activity rather
# than decaying. 6 x 5 = 30 minutes of CONTINUOUS quiet. A decaying counter would eventually
# stop a machine that is used for one minute in every twenty-five, which is a machine in use.
$PcIdleScript = Join-Path $PcRoot 'ws-idle.ps1'
$PcIdleTask   = 'PcWsIdleStop'
$PcIdleBusy   = Join-Path $PcRoot 'ws-busy'
# A SINGLE-QUOTED HERE-STRING: PowerShell expands NOTHING between @' and '@, so every $ below
# belongs to ws-idle.ps1 and none of it is read by this script.
$PcIdleBody = @'
# Paracoding workstation idle-stop check. [WS-WIN-IDLE-V49]
# Installed by the workstation startup script and run by the scheduled task PcWsIdleStop
# every 5 minutes, first run 10 minutes after boot. SIX consecutive idle runs = 30 minutes of
# continuous quiet, and then this machine stops itself. Any activity resets the count to 0.
$ErrorActionPreference = 'Continue'
$PcRoot  = 'C:\ProgramData\paracoding'
$PcLog   = Join-Path $PcRoot 'ws-setup.log'
$PcBusy  = Join-Path $PcRoot 'ws-busy'
$PcState = Join-Path $PcRoot 'ws-idle-count'
$PcLimit = 6
# THE CPU THRESHOLD IS THE LINUX TEST'S ARITHMETIC RESTATED, NOT A GUESS. The Linux check is
# `load < 1` -- fewer than one runnable task on average. This VM is created as an
# e2-standard-4, so ONE of its four vCPUs saturated is 25% of the machine, and 25 is that
# same statement in the units Windows reports. A parked Windows desktop with Chrome open
# measures single digits; a build, an installer or a test run measures far more than 25.
$PcCpuMax = 25

function Write-PcIdleLog([string]$Message) {
  Add-Content -Path $PcLog -Value ("{0} ws-idle {1}" -f (Get-Date).ToUniversalTime().ToString('s'), $Message)
}

# THE COUNTER IS BOOT-SCOPED, BECAUSE ITS LINUX ORIGINAL IS AND THIS DIRECTORY IS NOT.
# /run is tmpfs, so /run/ws-idle-count is empty after every boot. C:\ProgramData survives a
# reboot, so a machine that stopped itself holding 6 would come back up still holding 6 and
# stop again at its first check -- a workstation nobody can start. The file therefore records
# the boot it was written under, and a count from any other boot reads as 0.
# AND IT HAS A SECOND SOURCE, BECAUSE ONE SOURCE HERE IS A SINGLE POINT OF FAILURE FOR THE
# WHOLE FEATURE. If the boot identifier could not be read at all, every run would disagree
# with the file it just wrote, the count would never get past 1, and this machine would never
# stop -- silently, and looking exactly like a machine nobody had left running. So when the
# CIM call fails the boot instant is DERIVED: wall clock now minus milliseconds since boot,
# rounded to the minute to absorb sampling jitter. Same value all through one boot, a
# different one after the next.
$PcBoot = ''
try { $PcBoot = [string]((Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.Ticks) } catch { $PcBoot = '' }
if ($PcBoot -eq '') {
  try { $PcBoot = 't' + [string]([long]((Get-Date).AddMilliseconds(-1 * [Environment]::TickCount64).Ticks / 600000000)) } catch { $PcBoot = 'unknown' }
}
$PcCount = 0
$PcWas   = ''
if (Test-Path $PcState) {
  $PcF = @((([string](Get-Content -Path $PcState -TotalCount 1)) -split '\s+') | Where-Object { $_ -ne '' })
  if ($PcF.Count -ge 2 -and $PcF[0] -eq $PcBoot) {
    try { $PcCount = [int]$PcF[1] } catch { $PcCount = 0 }
    if ($PcF.Count -ge 3) { $PcWas = [string]$PcF[2] }
  }
}
# The third field is WHY the last run decided what it decided. It exists so a transition is
# logged ONCE instead of every five minutes forever: a line per tick would make this the
# largest file on the disk within a month, and no line at all would make a box that never
# stops silent about the reason.
function Set-PcIdleState([int]$N, [string]$Reason) {
  Set-Content -Path $PcState -Value ("{0} {1} {2}" -f $PcBoot, $N, $Reason) -Encoding ASCII
}

# BUSY OVERRIDE, FIRST, BEFORE ANYTHING IS MEASURED. An unattended job can hold no session
# and little CPU and still be the entire reason this machine is running; the marker is how an
# operator says so, and it is the same escape hatch as /run/ws-busy on the Linux box.
if (Test-Path $PcBusy) {
  if ($PcWas -ne 'busy') { Write-PcIdleLog ("{0} exists: idle-stop suspended, counter reset to 0" -f $PcBusy) }
  Set-PcIdleState 0 'busy'
  exit 0
}

# SESSION TEST -- EXACTLY WHICH qwinsta ROWS ARE COUNTED AND WHY. qwinsta (a.k.a.
# `query session`) prints a header and one row per session. On a box like this one:
#   services   id 0      Disc     the session Windows services live in. Never a person.
#   console    id 1      Conn     the console sitting at the sign-in screen. Nobody is on it.
#   rdp-tcp    id 65536  Listen   the listener that ACCEPTS RDP. Not a session anyone is in.
#   rdp-tcp#N  id N      Active   somebody is signed in over RDP right now. THIS is activity.
#   console    id 1      Active   somebody is signed in at the console. THIS is activity.
#   (no name)  id N      Disc     an RDP session whose window was closed. NOT activity -- the
#                                 operator has gone home, and a job they left behind is what
#                                 the busy marker above is for.
# So: state Active, and session id NOT 0. Id 0 is excluded explicitly because `services` is
# reported Active on some builds and it is never a human.
# THE COLUMNS ARE NOT SPLIT POSITIONALLY. SESSIONNAME and USERNAME are both blank on some
# rows, so a fixed-width or nth-field parse reads the wrong column on exactly the rows that
# matter. Instead each row is tokenised on whitespace, the FIRST all-digits token is the ID,
# and the token after it is the STATE. The header row carries no all-digits token, so the
# same rule skips it without special-casing its text.
$PcSeen   = $false
$PcActive = $false
$PcQ = @()
try { $PcQ = @(& qwinsta.exe 2>$null) } catch { $PcQ = @() }
foreach ($PcLine in $PcQ) {
  $PcT = @((([string]$PcLine).TrimStart('>', ' ') -split '\s+') | Where-Object { $_ -ne '' })
  $PcI = -1
  for ($n = 0; $n -lt $PcT.Count; $n++) { if ($PcT[$n] -match '^\d+$') { $PcI = $n; break } }
  if ($PcI -lt 1 -or ($PcI + 1) -ge $PcT.Count) { continue }
  $PcSeen = $true
  if ([int]$PcT[$PcI] -ne 0 -and $PcT[$PcI + 1] -eq 'Active') { $PcActive = $true }
}

# CPU, FROM A CLASS WHOSE NAMES ARE INVARIANT. Get-Counter takes a LOCALISED counter path and
# would break on a non-English image; WMI class and property names never translate. One
# sample is coarse, and that is acceptable here precisely because six consecutive samples are
# required: a spurious high reading only resets the counter, and a spurious low one cannot
# stop anything on its own.
$PcCpu = -1
try {
  $PcPerf = @(Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop)
  if ($PcPerf.Count -ge 1) { $PcCpu = [int]$PcPerf[0].PercentProcessorTime }
} catch { $PcCpu = -1 }
if ($PcCpu -lt 0) {
  try {
    $PcAvg = (Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Measure-Object -Property LoadPercentage -Average).Average
    if ($null -ne $PcAvg) { $PcCpu = [int]$PcAvg }
  } catch { $PcCpu = -1 }
}

# AN UNMEASURABLE ANSWER IS TREATED AS ACTIVITY, IN BOTH DIRECTIONS. If qwinsta produced no
# parseable row, or neither CPU source answered, this run is NOT idle and the counter resets.
# That is the same direction the Linux script fails in, and it is the right one: the cost of
# being wrong here is an hour of compute, and the cost of being wrong the other way is a
# machine that stops in the middle of somebody's work because a counter could not be read.
$PcReason = 'idle'
if (-not $PcSeen)             { $PcReason = 'nosessiondata' }
elseif ($PcActive)            { $PcReason = 'session' }
elseif ($PcCpu -lt 0)         { $PcReason = 'nocpudata' }
elseif ($PcCpu -ge $PcCpuMax) { $PcReason = 'cpu' }
if ($PcReason -ne 'idle') {
  if ($PcWas -ne $PcReason) { Write-PcIdleLog ("not idle ({0}, cpu {1}%): counter reset to 0" -f $PcReason, $PcCpu) }
  Set-PcIdleState 0 $PcReason
  exit 0
}
$PcCount = $PcCount + 1
Set-PcIdleState $PcCount 'idle'
if ($PcCount -le $PcLimit) {
  Write-PcIdleLog ("idle interval {0} of {1}: no Active session, cpu {2}% under {3}%" -f $PcCount, $PcLimit, $PcCpu, $PcCpuMax)
}
if ($PcCount -gt $PcLimit -and (($PcCount - $PcLimit) % 12) -eq 0) {
  Write-PcIdleLog ("STILL RUNNING {0} checks past the first Stop-Computer: something is refusing the shutdown, and this machine is billing" -f ($PcCount - $PcLimit))
}
if ($PcCount -ge $PcLimit) {
  # Stop-Computer, NOT a logoff or a session disconnect. Ending a session leaves the INSTANCE
  # RUNNING, and a running instance is what Compute Engine bills for -- whether or not anybody
  # is signed in. Only a clean guest shutdown takes the instance to TERMINATED, where it bills
  # for its disk alone. A logoff would make this file look like it worked and change the bill
  # by nothing, which is the failure this whole check exists to stop.
  # -Force so an application with an unsaved buffer cannot veto it, exactly as `shutdown -h
  # now` cannot be vetoed on the Linux box. The supported way to say "not now" is the busy
  # marker at the top of this file, which is checked before anything else.
  Write-PcIdleLog ("{0} consecutive idle checks at 5 minutes each = 30 minutes idle; stopping this computer" -f $PcLimit)
  Stop-Computer -Force
}
'@
Set-Content -Path $PcIdleScript -Value $PcIdleBody -Encoding ASCII
# THE TASK IS REGISTERED FROM XML, NOT BUILT FROM New-ScheduledTaskTrigger. What is wanted is
# one boot trigger with a 10-minute delay AND a 5-minute repetition, and the cmdlet route
# reaches that only by assigning a Repetition object taken off a second, throwaway trigger --
# a construction whose behaviour has differed across Windows versions. The XML is what the
# Task Scheduler actually stores, it says all three things in one place, and it is the same
# document Export-ScheduledTask round-trips. RUNS AS S-1-5-18 (SYSTEM), which is a service
# account that needs no password and is signed in whether or not a human is: a task that ran
# as the operator would not run when the machine is empty, which is the only time it matters.
$PcIdleXml = @'
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>paracoding</Author>
    <Description>Idle stop: six consecutive idle 5-minute checks (30 minutes) shut this workstation down. Create C:\ProgramData\paracoding\ws-busy to suspend it.</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT10M</Delay>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\ProgramData\paracoding\ws-idle.ps1"</Arguments>
    </Exec>
  </Actions>
</Task>
'@
# IDEMPOTENT: -Force replaces a task of the same name rather than failing on the second run,
# which is the same contract the rest of this script keeps. schtasks.exe is the fallback and
# not the first choice -- it is present on every Windows there is, so a machine whose
# ScheduledTasks module is missing still gets the task. The XML file it needs is written
# UTF-16, which is what its declaration says and what schtasks expects.
$PcIdleOk = $false
try {
  Register-ScheduledTask -TaskName $PcIdleTask -Xml $PcIdleXml -Force -ErrorAction Stop | Out-Null
  $PcIdleOk = $true
} catch {
  Write-PcLog ("Register-ScheduledTask failed ({0}); falling back to schtasks.exe" -f $_.Exception.Message)
  try {
    $PcIdleXmlFile = Join-Path $PcRoot 'ws-idle-task.xml'
    Set-Content -Path $PcIdleXmlFile -Value $PcIdleXml -Encoding Unicode
    & schtasks.exe /Create /TN $PcIdleTask /XML $PcIdleXmlFile /F | Out-Null
    if ($LASTEXITCODE -eq 0) { $PcIdleOk = $true }
  } catch {
    Write-PcLog ("schtasks.exe also failed: {0}" -f $_.Exception.Message)
  }
}
# VERIFIED BY ASKING THE TASK SCHEDULER, NOT BY READING AN EXIT CODE, because the whole point
# of this block is that an idle-stop nobody installed looks exactly like one that works until
# the bill arrives.
$PcIdleThere = $false
try { if (Get-ScheduledTask -TaskName $PcIdleTask -ErrorAction Stop) { $PcIdleThere = $true } } catch {
  & schtasks.exe /Query /TN $PcIdleTask > $null 2>&1
  if ($LASTEXITCODE -eq 0) { $PcIdleThere = $true }
}
if ($PcIdleThere) {
  Write-PcLog ("idle-stop installed: {0} runs {1} every 5 minutes from boot+10min; 6 idle checks (30 min) stop this VM. Suspend with {2}" -f $PcIdleTask, $PcIdleScript, $PcIdleBusy)
} else {
  Write-PcLog ("WARNING: THE IDLE-STOP IS NOT INSTALLED (registered={0}). This machine will run, and bill, until somebody stops it by hand." -f $PcIdleOk)
}

New-Item -ItemType File -Force -Path $PcStamp | Out-Null
Write-PcLog "== finished"
Add-Content -Path $PcLog -Value "WS-SETUP-DONE"
PC_WS_PS1_EOF
    chmod 0600 "$HERE/.ws-startup.ps1"
    # NO enable-oslogin HERE, AND THAT IS NOT AN OMISSION. OS Login is a Linux-guest feature;
    # setting it on a Windows instance does nothing at all, and leaving it on the create line
    # would imply a protection this box does not have. What protects this box is that it has
    # NO EXTERNAL IP and that 3389 is reachable only from IAP's range, both above.
    # 150 GB rather than the Linux path's 100: a Windows Server image plus updates plus
    # Chrome plus the app is a much larger floor, and an out-of-space workstation is exactly
    # the class of defect this step was rewritten to stop shipping.
    PC_VMC_RC=0
    retry gcloud compute instances create "$WS_VM_NAME" --project "$PROJECT" \
      --zone "$WS_VM_ZONE" --machine-type e2-standard-4 \
      --image-family "$WS_IMG_FAMILY" --image-project windows-cloud \
      --boot-disk-size 150GB --boot-disk-type pd-balanced \
      --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
      --tags "$PC_RDP_TAG" \
      --metadata pc-claude-ext-id="$PC_WS_EXT_ID",pc-claude-win-url="$PC_WS_CLAUDE_WIN_URL" \
      --metadata-from-file windows-startup-script-ps1="$HERE/.ws-startup.ps1" \
      --service-account "$WS_SA" \
      --scopes https://www.googleapis.com/auth/logging.write,https://www.googleapis.com/auth/monitoring.write,https://www.googleapis.com/auth/devstorage.read_only \
      $PC_WS_NET_FLAG \
      --quiet >/dev/null || PC_VMC_RC=$?
    gcloud compute instances describe "$WS_VM_NAME" --zone "$WS_VM_ZONE" --project "$PROJECT" \
      >/dev/null 2>&1 \
      || die "the workstation VM $WS_VM_NAME is still absent in $WS_VM_ZONE after a create
attempt (exit $PC_VMC_RC). The describe is the authority here, not the create status, because a
concurrent run makes create a 409 and that is success for our purposes."
    rm -f "$HERE/.ws-startup.ps1"
    echo "  created $WS_VM_NAME in $WS_VM_ZONE (WINDOWS: $WS_IMG_FAMILY, e2-standard-4,"
    echo "  150 GB pd-balanced, Shielded VM, service account $WS_SA)"
    echo "  NO EXTERNAL IP. Egress is via the SAME Cloud NAT the linux path uses"
    echo "  ($PC_NAT_CFG on router $PC_NAT_RTR in $REGION) -- outbound only."
    echo "  RDP INGRESS IS IAP-ONLY: firewall rule $PC_RDP_FW allows tcp:3389 from"
    echo "  35.235.240.0/20 (IAP TCP forwarding) to instances tagged $PC_RDP_TAG, and from"
    echo "  nowhere else. 3389 is NOT open to the internet and must never be."
    if [ -n "$PC_RDP_WORLD" ]; then
      echo "  !! HEADS UP: this project ALSO has the auto-created firewall rule"
      echo "  !! default-allow-rdp, which permits tcp:3389 from 0.0.0.0/0 to every instance"
      echo "  !! in the network. It does not expose THIS VM, because this VM has no external"
      echo "  !! address -- but it would expose any Windows instance that ever gets one. It"
      echo "  !! was NOT deleted here because it is not ours and something else may use it."
      echo "  !! To remove it once you are sure:"
      echo "  !!   gcloud compute firewall-rules delete default-allow-rdp --project $PROJECT"
    fi
    echo
    echo "  A STARTUP SCRIPT IS PROVISIONING THIS BOX RIGHT NOW, IN THE BACKGROUND. It"
    echo "  installs Google Chrome and the Claude desktop app, it verifies the Authenticode"
    echo "  signature of everything it downloads before running it, and it is idempotent."
    echo "  It logs to C:\\ProgramData\\paracoding\\ws-setup.log on the VM and the"
    echo "  provisioning run finishes with the line WS-SETUP-DONE. Give it about fifteen"
    echo "  minutes. The idle-stop below writes to the SAME log afterwards, so WS-SETUP-DONE"
    echo "  is a line in it and not the last line of it."
    echo
    # [WS-WIN-IDLE-V49] SAID HERE AS WELL AS IN THE ACCESS BANNER, because this is the only
    # output a workstation.sh create ever prints -- that script does not reach the banner.
    # The measured failure: the operator was told what this box installs and nothing about
    # what it costs, assumed the Linux box's idle-stop applied, and left one running.
    echo "  IT STOPS ITSELF AFTER 30 MINUTES IDLE, AND THIS IS HOW TO STOP IT DOING THAT."
    echo "  The same startup script installs a scheduled task, PcWsIdleStop, that checks"
    echo "  every 5 minutes from 10 minutes after boot. Six consecutive checks with no"
    echo "  Active RDP or console session and CPU under 25% run Stop-Computer, which takes"
    echo "  the instance to TERMINATED and stops the compute charge. Any activity resets the"
    echo "  count. A DISCONNECTED RDP session is NOT activity, so before you close the RDP"
    echo "  window on a long unattended job, hold the box up with the busy marker:"
    echo "    New-Item -ItemType File -Force -Path C:\\ProgramData\\paracoding\\ws-busy"
    echo "    Remove-Item -Force C:\\ProgramData\\paracoding\\ws-busy      (release it)"
    echo "  Or turn the whole thing off, and pay for every hour this VM exists:"
    echo "    Disable-ScheduledTask -TaskName PcWsIdleStop"
    echo
    echo "  THE FIRST PASSWORD IS MANUAL AND CANNOT BE AUTOMATED SAFELY. Windows has no"
    echo "  equivalent of OS Login here: you log in with a username and a password, and the"
    echo "  only way to get the first one is the command below, which MINTS A NEW"
    echo "  ADMINISTRATOR PASSWORD AND PRINTS IT IN CLEARTEXT. An installer that ran it for"
    echo "  you would write a working administrator credential into this terminal, your"
    echo "  scrollback and your CI logs, where it would live forever. So you run it, once,"
    echo "  when you are ready:"
    echo "    1. mint the password (prints it -- keep it somewhere safe):"
    echo "         gcloud compute reset-windows-password $WS_VM_NAME \\"
    echo "           --zone $WS_VM_ZONE --project $PROJECT --user paracoding"
    echo "    2. open the IAP tunnel and LEAVE IT RUNNING in its own terminal:"
    echo "         gcloud compute start-iap-tunnel $WS_VM_NAME 3389 \\"
    echo "           --local-host-port=localhost:13389 --zone $WS_VM_ZONE --project $PROJECT"
    echo "    3. point any RDP client at   localhost:13389   and log in as paracoding."
    echo "       (Windows: mstsc /v:localhost:13389 -- macOS: Microsoft Remote Desktop)"
    echo "    4. the desktop may be up before the software is; if Chrome or Claude is"
    echo "       missing, wait for WS-SETUP-DONE in the log above."
    else
    # UBUNTU LTS, RESOLVED NOT ASSUMED. Image family names are renamed between releases and a
    # family that does not exist fails the create with a message about images, not about this
    # line. Take the first of these that the project can actually describe.
    WS_IMG_FAMILY=""
    for _f in ubuntu-2404-lts-amd64 ubuntu-2204-lts; do
      if gcloud compute images describe-from-family "$_f" --project ubuntu-os-cloud \
           >/dev/null 2>&1; then WS_IMG_FAMILY="$_f"; break; fi
    done
    [ -n "$WS_IMG_FAMILY" ] || die "no Ubuntu LTS image family (ubuntu-2404-lts-amd64,
ubuntu-2204-lts) could be resolved from ubuntu-os-cloud. Refusing to fall back to Debian: the
Claude desktop app does not run on it, and a workstation you cannot use is the defect this step
was rewritten to fix."
    # [SEC-WSDESKTOP-V1] THE DESKTOP, THE BROWSER, CHROME REMOTE DESKTOP AND THE CLAUDE APP.
    # None of these existed before -- the installer created a bare headless box and the
    # operator had nothing to connect to. Written to a file and passed with
    # --metadata-from-file so nothing has to survive a second round of shell quoting.
    # The delimiter is QUOTED, so this body is emitted literally: every $ below belongs to the
    # startup script, not to install.sh.
    cat > "$HERE/.ws-startup.sh" <<'PC_WS_STARTUP_EOF'
#!/usr/bin/env bash
# Paracoding workstation provisioning. IDEMPOTENT: it stamps a version marker and returns
# immediately on a re-run, so a VM reset or a metadata re-apply costs nothing.
set -u
PC_WS_STAMP=/var/lib/paracoding/ws-setup.v1
LOG=/var/log/paracoding-ws-setup.log
mkdir -p /var/lib/paracoding
exec >>"$LOG" 2>&1
echo "== paracoding ws-setup $(date -u +%FT%TZ)"
if [ -f "$PC_WS_STAMP" ]; then echo "already provisioned; nothing to do"; echo "WS-SETUP-DONE"; exit 0; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -y || true
apt-get install -y --no-install-recommends ca-certificates curl gnupg xfce4 xfce4-terminal \
  dbus-x11 xscreensaver desktop-base policykit-1 fonts-liberation libu2f-udev xdg-utils || true

# GOOGLE CHROME, FROM GOOGLE'S APT REPO, WITH THE KEY PINNED RATHER THAN PIPED. The key is
# fetched to a dearmoured keyring file, its fingerprint is CHECKED against the published one,
# and the repo line names that keyring with signed-by= so it can sign nothing else on this box.
# `curl ... | apt-key add -` -- the thing this deliberately is not -- trusts whatever arrives
# for every repository at once.
CHROME_FPR="EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796"
install -d -m 0755 /usr/share/keyrings
if [ ! -s /usr/share/keyrings/google-chrome.gpg ]; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /tmp/goog.pub || true
  if [ -s /tmp/goog.pub ]; then
    GOT=$(gpg --show-keys --with-colons --fingerprint /tmp/goog.pub 2>/dev/null | awk -F: '/^fpr:/{print $10; exit}')
    if [ "$GOT" = "$CHROME_FPR" ]; then
      gpg --dearmor < /tmp/goog.pub > /usr/share/keyrings/google-chrome.gpg
      chmod 0644 /usr/share/keyrings/google-chrome.gpg
    else
      echo "REFUSED: google signing key fingerprint was $GOT, wanted $CHROME_FPR"
    fi
  fi
  rm -f /tmp/goog.pub
fi
if [ -s /usr/share/keyrings/google-chrome.gpg ]; then
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -y || true
  apt-get install -y google-chrome-stable || true
else
  echo "SKIPPED google-chrome: no verified signing key"
fi

# CHROME REMOTE DESKTOP HOST. Installed from Google's own signed .deb over https; apt resolves
# its dependencies because it is given a path, not a name.
if ! dpkg -s chrome-remote-desktop >/dev/null 2>&1; then
  curl -fsSL https://dl.google.com/linux/direct/chrome-remote-desktop_current_amd64.deb \
    -o /tmp/crd.deb && apt-get install -y /tmp/crd.deb || echo "SKIPPED chrome-remote-desktop: download or install failed"
  rm -f /tmp/crd.deb
fi
# CRD needs to be told which session to start. Without this it registers and then shows a
# black screen, which is the single commonest way a headless CRD install looks broken.
if [ ! -f /etc/chrome-remote-desktop-session ]; then
  echo "exec /etc/X11/Xsession /usr/bin/xfce4-session" > /etc/chrome-remote-desktop-session
  chmod 0644 /etc/chrome-remote-desktop-session
fi
# OS Login usernames are not known until somebody logs in, so the host cannot be registered
# from here even in principle -- the operator runs the one-time --code= command themselves.
# Make sure whoever logs in can: the chrome-remote-desktop group must exist and OS Login users
# are added to it on first login by the line below.
getent group chrome-remote-desktop >/dev/null || groupadd chrome-remote-desktop
cat > /etc/profile.d/99-paracoding-crd.sh <<'PC_PROF_EOF'
# add the interactive user to the CRD group on first login; CRD refuses to start otherwise
if [ -n "${USER:-}" ] && getent group chrome-remote-desktop >/dev/null; then
  id -nG "$USER" 2>/dev/null | tr ' ' '\n' | grep -qx chrome-remote-desktop \
    || sudo -n usermod -aG chrome-remote-desktop "$USER" 2>/dev/null || true
fi
PC_PROF_EOF
chmod 0644 /etc/profile.d/99-paracoding-crd.sh

# THE CLAUDE DESKTOP APP. THREE PATHS, TRIED IN THIS ORDER, AND THE LOG ALWAYS NAMES THE ONE
# THAT RAN.
#   1. pc-claude-deb-url  -- an explicit package URL, used verbatim. UNCHANGED, and still
#      first, so an operator who pinned their own package keeps getting exactly it.
#   2. pc-claude-apt-repo -- [SEC-WSCLAUDE-PIN-V1] Anthropic's own apt repository, which the
#      installer now pins a default for. This is the path that closes the operator request:
#      before it, neither key was ever SET by anything in the release, so every machine
#      silently took path 3 and the app was never installed at all.
#   3. Claude Code plus a dedicated Chrome app window for claude.ai -- the honest fallback,
#      taken when 1 and 2 are absent or FAIL, and announced as such.
# THE REPOSITORY IS PINNED, NOT A .deb, AND THAT IS THE WHOLE POINT: a pool filename carries a
# version, so a pinned .deb URL 404s as soon as Anthropic publishes the next build, whereas
# the repository is versionless and delivers updates through apt-get upgrade afterwards.
# NOTHING IS TRUSTED BECAUSE IT IS A DEFAULT. The signing key must carry the fingerprint
# pinned in pc-claude-apt-fpr or this path REFUSES and falls through -- an unpinned key is
# verified by nothing, and "we downloaded a key and then trusted it" is not verification.
# apt itself then enforces that signature on every package via signed-by. If any step fails
# the repository entry and the keyring are REMOVED again, so a half-registered repository
# never survives to break the operator's next apt-get upgrade.
pc_ws_meta() {
  curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true
}
pc_ws_is_https() {
  case "${1:-}" in https://*) return 0 ;; *) return 1 ;; esac
}
CLAUDE_DEB_URL=$(pc_ws_meta pc-claude-deb-url)
CLAUDE_APT_REPO=$(pc_ws_meta pc-claude-apt-repo)
CLAUDE_APT_KEY=$(pc_ws_meta pc-claude-apt-key)
CLAUDE_APT_FPR=$(pc_ws_meta pc-claude-apt-fpr)
CLAUDE_KEYRING=/usr/share/keyrings/claude-desktop-archive-keyring.asc
CLAUDE_APT_LIST=/etc/apt/sources.list.d/claude-desktop.list
CLAUDE_OK=0
if [ -n "${CLAUDE_DEB_URL:-}" ]; then
  case "$CLAUDE_DEB_URL" in
    https://*) curl -fsSL "$CLAUDE_DEB_URL" -o /tmp/claude.deb && apt-get install -y /tmp/claude.deb && CLAUDE_OK=1 ;;
    *) echo "REFUSED pc-claude-deb-url: not https" ;;
  esac
  rm -f /tmp/claude.deb
  [ "$CLAUDE_OK" -eq 1 ] && echo "claude desktop installed from pc-claude-deb-url"
fi
if [ "$CLAUDE_OK" -eq 0 ] && [ -n "${CLAUDE_APT_REPO:-}" ] && [ -n "${CLAUDE_APT_KEY:-}" ]; then
  if ! pc_ws_is_https "$CLAUDE_APT_REPO" || ! pc_ws_is_https "$CLAUDE_APT_KEY"; then
    echo "REFUSED pc-claude-apt-repo/pc-claude-apt-key: both must be https URLs"
  elif [ -z "${CLAUDE_APT_FPR:-}" ]; then
    echo "REFUSED the Claude apt repository: pc-claude-apt-fpr is unset, and a signing key that is not pinned to a fingerprint is verified by nothing"
  else
    command -v gpg >/dev/null 2>&1 || apt-get install -y gnupg >/dev/null 2>&1 || true
    if ! command -v gpg >/dev/null 2>&1; then
      echo "SKIPPED the Claude apt repository: gpg is unavailable, so the signing key fingerprint could not be checked"
    elif ! curl -fsSL "$CLAUDE_APT_KEY" -o "$CLAUDE_KEYRING"; then
      echo "SKIPPED the Claude apt repository: the signing key could not be downloaded"
      rm -f "$CLAUDE_KEYRING"
    elif ! gpg --show-keys --with-colons "$CLAUDE_KEYRING" 2>/dev/null | awk -F: '$1 == "fpr" { print $10 }' | grep -qx "$CLAUDE_APT_FPR"; then
      echo "REFUSED the Claude apt signing key: it does not carry the fingerprint pinned in pc-claude-apt-fpr"
      rm -f "$CLAUDE_KEYRING"
    else
      chmod 0644 "$CLAUDE_KEYRING"
      echo "deb [arch=amd64,arm64 signed-by=$CLAUDE_KEYRING] $CLAUDE_APT_REPO stable main" > "$CLAUDE_APT_LIST"
      chmod 0644 "$CLAUDE_APT_LIST"
      if apt-get update -y >/dev/null 2>&1 && apt-get install -y claude-desktop; then
        CLAUDE_OK=1
        echo "claude desktop installed from the Anthropic apt repository; updates arrive with apt-get upgrade"
      else
        echo "SKIPPED claude desktop: the Anthropic apt repository verified but the package did not install"
        rm -f "$CLAUDE_KEYRING" "$CLAUDE_APT_LIST"
        apt-get update -y >/dev/null 2>&1 || true
      fi
    fi
  fi
fi
if [ "$CLAUDE_OK" -eq 0 ]; then
  echo "the Claude desktop app was NOT installed on this machine; on this box 'Claude' means Claude Code plus a Chrome app window for claude.ai"
  curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh \
    && bash /tmp/claude-install.sh </dev/null && echo "claude code installed" \
    || echo "SKIPPED claude code: installer unavailable"
  rm -f /tmp/claude-install.sh
  if [ -x /usr/bin/google-chrome-stable ]; then
    cat > /usr/share/applications/claude.desktop <<'PC_DESK_EOF'
[Desktop Entry]
Type=Application
Name=Claude
Comment=Claude, in a dedicated app window
Exec=/usr/local/bin/pc-chrome --app=https://claude.ai/
Icon=google-chrome
Categories=Network;Development;
PC_DESK_EOF
    chmod 0644 /usr/share/applications/claude.desktop
  fi
fi

# THE CLAUDE CHROME EXTENSION, FORCE-INSTALLED BY CHROME'S OWN POLICY MECHANISM -- the Linux
# spelling of exactly what the Windows startup script does. Chrome reads managed policy from
# JSON files in /etc/opt/chrome/policy/managed/ at start-up, so ExtensionInstallForcelist
# there makes Chrome fetch the extension from the Web Store itself, verify its signature and
# keep it updated. Sideloading a .crx would bypass all three, so we do not.
# THE ID IS NOT HARDCODED AND WILL NOT BE GUESSED -- see the identical paragraph in the
# Windows script. An extension id is a capability; a wrong one force-installs a stranger's
# code into this browser. It comes from instance metadata, it is validated to be exactly 32
# characters in a-p, and when it is unset this block does nothing and says so.
PC_EXT_ID=$(curl -fsS -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/attributes/pc-claude-ext-id' 2>/dev/null || true)
PC_EXT_ID=$(printf '%s' "${PC_EXT_ID:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
if [ -z "$PC_EXT_ID" ]; then
  echo "SKIPPED the Claude chrome extension: instance metadata pc-claude-ext-id is unset, and this script will not guess an extension id"
elif printf '%s' "$PC_EXT_ID" | grep -qE '^[a-p]{32}$'; then
  install -d -m 0755 /etc/opt/chrome/policy/managed
  cat > /etc/opt/chrome/policy/managed/paracoding-claude.json <<PC_EXTPOL_EOF
{"ExtensionInstallForcelist": ["$PC_EXT_ID;https://clients2.google.com/service/update2/crx"]}
PC_EXTPOL_EOF
  chmod 0644 /etc/opt/chrome/policy/managed/paracoding-claude.json
  echo "force-installed the claude chrome extension by policy: $PC_EXT_ID"
else
  echo "REFUSED pc-claude-ext-id: a chrome extension id is exactly 32 characters a-p"
fi

# ============================================ [SEC-CDP-LOOPBACK-V1] THE CDP BRIDGE
# THE THING THE CLOSING BANNER USED TO ADMIT WAS MISSING. index.ts withholds browser_tabs,
# browser_open and browser_navigate unless WS_CDP_PORT is set, because they reach the
# workstation Chrome through a DevTools bridge that no installer provisioned. This
# provisions it. It is the fleet's own bridge -- workstation/linux-startup.sh, blob
# c97f2a92 -- reused verbatim except for the bind, and it carries its own --self-test,
# which is run below and whose result is logged.
#
# WHAT IS ON THE WIRE: NOTHING. Chrome's DevTools port is 127.0.0.1:9222 and the bridge is
# 127.0.0.1:8025. No port is published on any interface, NO FIREWALL RULE IS OPENED for
# either of them, and the box still has no external IP. The bridge is reached over the
# tunnel that already exists for this machine:
#
#   gcloud compute ssh VM --zone ZONE --tunnel-through-iap -- -L 8025:127.0.0.1:8025
#
# THE TOKEN IS MINTED HERE AND NEVER TRANSPORTED. It is 32 bytes of urandom written to
# /opt/cdp-token as root:pc-cdp 0640 -- not instance metadata, which
# `compute.instances.get` returns in full to anybody holding roles/compute.viewer, and not
# a value this installer carries to the box. The operator reads it over the same tunnel.
# It is minted ONLY IF ABSENT, so a re-run never invalidates a tunnel somebody is using.
#
# EVERY CHROME LAUNCH GOES THROUGH pc-chrome, because Chrome opens a debugging port only on
# the FIRST launch of the process. A Chrome started another way first means the bridge
# answers 502 until Chrome is fully restarted -- that is the known sharp edge, and it is why
# the wrappers below shadow /usr/bin on PATH and in XDG_DATA_DIRS rather than asking nicely.
cat >/usr/local/bin/pc-chrome <<'PC_CHROME_EOF'
#!/bin/sh
exec /usr/bin/google-chrome-stable \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 "$@"
PC_CHROME_EOF
chmod 0755 /usr/local/bin/pc-chrome
# /usr/local/bin precedes /usr/bin on the default PATH, and /usr/local/share precedes
# /usr/share in the default XDG_DATA_DIRS, so a shell launch and a menu launch both land
# on the wrapper without touching a single package-owned file.
ln -sf /usr/local/bin/pc-chrome /usr/local/bin/google-chrome-stable
ln -sf /usr/local/bin/pc-chrome /usr/local/bin/google-chrome
install -d -m 0755 /usr/local/share/applications
cat > /usr/local/share/applications/google-chrome.desktop <<'PC_CHROMEDESK_EOF'
[Desktop Entry]
Type=Application
Name=Google Chrome
Comment=Google Chrome, with the DevTools bridge port open on loopback
Exec=/usr/local/bin/pc-chrome %U
Icon=google-chrome
Categories=Network;WebBrowser;
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
PC_CHROMEDESK_EOF
chmod 0644 /usr/local/share/applications/google-chrome.desktop
id -u pc-cdp >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin pc-cdp
if [ ! -s /opt/cdp-token ]; then
  install -m 0640 -o root -g pc-cdp /dev/null /opt/cdp-token
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /opt/cdp-token
  chown root:pc-cdp /opt/cdp-token
  chmod 0640 /opt/cdp-token
  echo "minted /opt/cdp-token (root:pc-cdp 0640). It is NOT in instance metadata."
else
  echo "/opt/cdp-token already exists, left alone"
fi
# ---------------------------------------------------------------- CDP bridge :8025
# Backend browser driving rather than scraping. The control plane already has the
# other half: harCdp() posts to http://<workstation-ip>:8025.
#
# It forwards to the DESKTOP Chrome on 127.0.0.1:9222 -- the browser the human is
# signed into, launched through pc-chrome. There is no separate automation
# browser and that is deliberate: a fresh profile has no sessions, so driving it
# would be scraping with extra steps.
# [WP3-BRIDGE-SPLICE-V1] Fail-closed origin policy for the bridge. origin_allow is
# EMPTY, so out of the box the bridge drives NOTHING and says why. Name the
# sites automation may touch here; the deny list is enforced regardless.
#
# Seeded ONLY IF ABSENT. The startup script re-runs on every boot and an
# unconditional write would silently revert the operator's allowlist.
if [ ! -f /opt/cdp-policy.json ]; then
  cat >/opt/cdp-policy.json <<'JSONEOF'
{
  "origin_allow": [],
  "origin_deny": [
    "accounts.google.com",
    "myaccount.google.com",
    "console.cloud.google.com",
    "admin.google.com",
    "login.microsoftonline.com",
    "github.com/settings",
    "mail.google.com"
  ],
  "max_result_bytes": 65536,
  "eval_timeout_ms": 15000
}
JSONEOF
  chmod 0644 /opt/cdp-policy.json
fi
# [SEC-CDP-LOOPBACK-V1] PROVENANCE. This body is REUSED, not written here: it is the
# bridge from workstation/linux-startup.sh at blob c97f2a92, verbatim, with exactly
# one behavioural change -- the bind, below -- and its self-test changed with it.
# It carries its own `--self-test`, which the release runs; run it on the box with
#   sudo -u pc-cdp python3 /opt/cdp-bridge.py --self-test
# It replaces the /json/*-forwarding bridge, which could not serve the control
# plane's RPC and bound 0.0.0.0:8025. This one holds the websocket itself, which
# is what makes an 8-method DevTools allowlist enforceable.
#
# [SEC-CDP-LOOPBACK-V1] ONE DELIBERATE DIVERGENCE FROM THE FLEET COPY: THE BIND.
# The fleet box binds its nic0 address and is protected by a target-tagged DENY at
# priority 900 on tcp:8022,8025 with an ALLOW at 800 for the control plane's egress
# range. THIS INSTALLER OPENS NO FIREWALL RULE AT ALL. Without that DENY, an nic0
# bind is reachable by every VM in the project through the default network's own
# default-allow-internal (priority 65534, tcp 0-65535, source 10.128.0.0/9) -- which
# is exactly the exposure the fleet's DENY rule exists to subtract. So this copy binds
# 127.0.0.1 and publishes nothing. It is reached over the tunnel that already exists:
#     gcloud compute ssh VM --zone ZONE --tunnel-through-iap -- -L 8025:127.0.0.1:8025
# Chrome's own 9222 is loopback too, and no rule is opened for either port.
cat >/opt/cdp-bridge.py <<'PYEOF'
#!/usr/bin/env python3
"""Token-gated narrow RPC bridge to the desktop Chrome's DevTools Protocol.

REPLACES the /json/*-forwarding bridge. That bridge could not serve the control
plane at all: harCdp() posts /tabs, /open, /navigate, /eval, none of which are
in the old ALLOW tuple, and it sends no token header, so every call died at the
403 before the path check ever ran.

DESIGN: the bridge HOLDS the websocket. The control plane speaks a narrow HTTP
RPC and never sees a CDP websocket URL. That is deliberate -- a websocket proxy
cannot enforce a method allowlist without parsing the CDP frames it relays, and
if it parses them it is this program with extra steps. Holding the socket here
is what makes METHOD_ALLOW and ORIGIN_ALLOW enforceable.

Chrome listens on 127.0.0.1:9222 and is not reachable from the network. It
drives the SIGNED-IN browser: that is the intent, so every mutation primitive
below is bounded by an explicit allowlist rather than by profile isolation.

Pure Python 3 stdlib. The RFC6455 client is hand-rolled because the VM has no
websocket package and adding one is a supply-chain edge for 60 lines of code.
"""
import base64
import hmac
import json
import os
import socket
import struct
import sys
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

# [SEC-CDP-SPLIT-V1]. This service has its OWN secret and its OWN header name.
# It used to read /opt/ops-token and check X-Ops-Token -- the same credential
# that gates ops-exec, which runs `bash -lc` as root. Two problems, both fatal
# once the split lands: the systemd unit runs this as the unprivileged pc-cdp
# user, which cannot read /opt/ops-token (0600 root) at all; and the control
# plane sends X-Cdp-Token, so every browser_* call would 403 here.
TOKEN_PATH = '/opt/cdp-token'
TOKEN_HEADER = 'X-Cdp-Token'

TOKEN = ''
try:
    TOKEN = open(TOKEN_PATH).read().strip()
except Exception:
    pass

CHROME = 'http://127.0.0.1:9222'
BIND_PORT = int(os.environ.get('CDP_BRIDGE_PORT', '8025'))
POLICY_PATH = os.environ.get('CDP_POLICY', '/opt/cdp-policy.json')

# ---------------------------------------------------------------- bind address
# The fleet copy of this file resolves nic0 from the metadata server, because on
# that deployment the control plane reaches the bridge over Direct VPC egress and
# a target-tagged DENY/ALLOW pair decides who else may. THIS DEPLOYMENT HAS NO SUCH
# RULE, and the installer that ships this script opens none.
#
# 0.0.0.0 was the original bug: it publishes on every interface. nic0 would be the
# fix ONLY where a DENY rule subtracts default-allow-internal (priority 65534, tcp
# 0-65535, source 10.128.0.0/9, no target tags), which already covers this subnet.
# With no such rule, nic0 here means "every VM in the project may open the bridge",
# and an ALLOW rule cannot subtract on GCP. So this copy binds LOOPBACK and publishes
# NOTHING on any network. It is reached over the tunnel that already exists:
#
#   gcloud compute ssh VM --zone ZONE --tunnel-through-iap -- -L 8025:127.0.0.1:8025
#
# THERE IS NO ENVIRONMENT OVERRIDE, for the same reason there was none before: an
# override is a slower way to get 0.0.0.0 back. This is a CONSTANT, so it cannot be
# widened by configuration, by metadata, or by a caller.
#
# THE OBJECTION THE FLEET COPY RAISES AGAINST LOOPBACK IS ANSWERED, NOT IGNORED. A
# page rendered inside the very Chrome this bridge drives is a local process and can
# therefore reach a loopback listener. What stands between it and the bridge is the
# TOKEN, which it does not have, and which is the same thing that stands between any
# caller and the bridge on either bind. An nic0 bind with no DENY rule would not fix
# that page and would add every other VM in the project to the same set.
BIND_HOST = '127.0.0.1'


# ---------------------------------------------------------------- method allowlist
# Every CDP method the control plane may invoke, named explicitly. A method not
# on this tuple is refused at the bridge with 403 regardless of who asks.
# Rationale per domain:
#   Target.*      - enumerate and create tabs. No Target.attachToBrowserTarget:
#                   that yields the browser-level session, which reaches
#                   Browser.close, Target.createBrowserContext and the whole
#                   profile. Page-level sessions only.
#   Page.navigate - the address bar. Page.captureScreenshot is a read.
#   Runtime.evaluate - the actual eval primitive.
# Deliberately ABSENT and never to be added without re-review:
#   Network.*     (Network.getAllCookies / getCookies exports the human's
#                  session cookies over HTTP -- this is the single worst method
#                  in the protocol for this deployment)
#   Storage.*     (getCookies, same problem; clearDataForOrigin destroys state)
#   Browser.*     (Browser.close, Browser.setDownloadBehavior -> arbitrary
#                  file write to the workstation disk)
#   Fetch.* / Network.setRequestInterception (silent request rewriting)
#   Input.*       (synthesised trust: Input.dispatchKeyEvent produces events
#                  that carry isTrusted=true and defeat page-side heuristics)
#   Page.setDownloadBehavior, Page.addScriptToEvaluateOnNewDocument
#                 (persistent injection that outlives the RPC call)
#   DOM.*, Debugger.*, Profiler.*, HeapProfiler.*, IO.*
METHOD_ALLOW = (
    'Target.getTargets',
    'Target.createTarget',
    'Target.closeTarget',
    'Target.activateTarget',
    'Page.navigate',
    'Page.reload',
    'Page.captureScreenshot',
    'Runtime.evaluate',
)

# Methods that mutate or read page content and therefore must pass the origin
# check. Target.getTargets is a bare enumeration and is exempt.
ORIGIN_CHECKED = (
    'Runtime.evaluate',
    'Page.navigate',
    'Page.reload',
    'Page.captureScreenshot',
)

DEFAULT_POLICY = {
    # Empty allow list == deny every origin. Fail CLOSED. An operator who wants
    # browser automation names the sites it may touch; there is no "*" default
    # because the browser holds live sessions for everything the human uses.
    'origin_allow': [],
    # Origins that may never be driven even if some future edit widens
    # origin_allow. Belt and braces for the accounts that own everything else.
    'origin_deny': [
        'accounts.google.com',
        'myaccount.google.com',
        'console.cloud.google.com',
        'admin.google.com',
        'login.microsoftonline.com',
        'github.com/settings',
        'mail.google.com',
    ],
    # Cap on returned value size so a compromised page cannot use the RPC
    # response as a bulk exfiltration channel in one call.
    'max_result_bytes': 65536,
    'eval_timeout_ms': 15000,
}


def load_policy():
    p = dict(DEFAULT_POLICY)
    try:
        with open(POLICY_PATH) as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            for k in DEFAULT_POLICY:
                if k in raw:
                    p[k] = raw[k]
    except Exception:
        pass
    return p


def origin_of(url):
    try:
        u = urllib.parse.urlparse(url or '')
        if not u.scheme or not u.netloc:
            return ''
        return u.scheme + '://' + u.netloc
    except Exception:
        return ''


def host_path(url):
    try:
        u = urllib.parse.urlparse(url or '')
        return (u.netloc or '') + (u.path or '')
    except Exception:
        return ''


def origin_permitted(url, policy):
    """Return (ok, reason). Deny beats allow. Empty allow list denies all."""
    o = origin_of(url)
    if not o:
        return (False, 'unparseable or non-http url')
    if not o.startswith('https://'):
        # http:// and file:// and chrome:// are all out. file:// in particular
        # would let Runtime.evaluate read the workstation disk via fetch().
        return (False, 'only https origins may be driven')
    hp = host_path(url)
    for d in policy.get('origin_deny') or []:
        if hp == d or hp.startswith(d + '/') or hp.startswith(d + '?') or o == 'https://' + d:
            return (False, 'origin on deny list: ' + str(d))
    allow = policy.get('origin_allow') or []
    if not allow:
        return (False, 'origin_allow is empty; bridge fails closed. '
                       'add the site to ' + POLICY_PATH)
    host = urllib.parse.urlparse(url).netloc
    for a in allow:
        a = str(a)
        if host == a:
            return (True, '')
        if a.startswith('*.') and host.endswith(a[1:]):
            return (True, '')
    return (False, 'origin not in origin_allow: ' + o)


# ---------------------------------------------------------------- CDP http helpers
def chrome_get(path):
    with urllib.request.urlopen(CHROME + path, timeout=10) as r:
        return json.loads(r.read().decode())


def chrome_put(path):
    req = urllib.request.Request(CHROME + path, method='PUT')
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.read().decode()


# ---------------------------------------------------------------- minimal ws client
class WSError(Exception):
    pass


class WS(object):
    """Blocking RFC6455 client, text frames only, no extensions, no fragmentation
    on send. Enough for one CDP request/response round trip and no more."""

    def __init__(self, url, timeout=20.0):
        u = urllib.parse.urlparse(url)
        if u.scheme != 'ws':
            raise WSError('refusing non-ws scheme: ' + str(u.scheme))
        host = u.hostname or '127.0.0.1'
        if host not in ('127.0.0.1', 'localhost', '::1'):
            raise WSError('refusing off-loopback debugger url: ' + host)
        port = u.port or 80
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self.buf = b''
        key = base64.b64encode(os.urandom(16)).decode()
        target = u.path + (('?' + u.query) if u.query else '')
        lines = [
            'GET ' + target + ' HTTP/1.1',
            'Host: ' + host + ':' + str(port),
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: ' + key,
            'Sec-WebSocket-Version: 13',
            '', '']
        self.sock.sendall('\r\n'.join(lines).encode())
        head = self._read_until(b'\r\n\r\n')
        if b' 101 ' not in head.split(b'\r\n')[0]:
            raise WSError('websocket upgrade refused: '
                          + head.split(b'\r\n')[0].decode('latin-1'))

    def _read_until(self, marker):
        while marker not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WSError('socket closed during handshake')
            self.buf += chunk
        i = self.buf.index(marker) + len(marker)
        head, self.buf = self.buf[:i], self.buf[i:]
        return head

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise WSError('socket closed')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send_text(self, s):
        payload = s.encode('utf-8')
        n = len(payload)
        header = bytearray()
        header.append(0x81)                      # FIN + text
        if n < 126:
            header.append(0x80 | n)              # MASK + len
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack('>H', n)
        else:
            header.append(0x80 | 127)
            header += struct.pack('>Q', n)
        mask = os.urandom(4)
        header += mask
        masked = bytearray(payload)
        for i in range(n):
            masked[i] ^= mask[i % 4]
        self.sock.sendall(bytes(header) + bytes(masked))

    def recv_text(self, cap):
        """Reassemble one message. Control frames are consumed and skipped."""
        parts = []
        total = 0
        while True:
            b0, b1 = self._recv_exact(2)
            fin = b0 & 0x80
            opcode = b0 & 0x0F
            masked = b1 & 0x80
            ln = b1 & 0x7F
            if ln == 126:
                ln = struct.unpack('>H', self._recv_exact(2))[0]
            elif ln == 127:
                ln = struct.unpack('>Q', self._recv_exact(8))[0]
            if ln > cap:
                raise WSError('frame exceeds cap (' + str(ln) + ' > ' + str(cap) + ')')
            if masked:
                self._recv_exact(4)
            data = self._recv_exact(ln) if ln else b''
            if opcode == 0x8:
                raise WSError('peer closed')
            if opcode in (0x9, 0xA):
                continue
            parts.append(data)
            total += len(data)
            if total > cap:
                raise WSError('message exceeds cap')
            if fin:
                break
        return b''.join(parts).decode('utf-8', 'replace')

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def cdp_call(ws_url, method, params, timeout_ms, cap):
    """One request, wait for the matching id, discard unsolicited events."""
    ws = WS(ws_url, timeout=max(2.0, timeout_ms / 1000.0 + 5.0))
    try:
        mid = int(time.time() * 1000) % 2147483647
        ws.send_text(json.dumps({'id': mid, 'method': method, 'params': params or {}}))
        deadline = time.time() + (timeout_ms / 1000.0) + 5.0
        while time.time() < deadline:
            msg = ws.recv_text(cap * 4)
            try:
                obj = json.loads(msg)
            except Exception:
                continue
            if obj.get('id') == mid:
                return obj
        raise WSError('timed out waiting for CDP response')
    finally:
        ws.close()


def page_targets():
    try:
        rows = chrome_get('/json/list')
    except Exception as e:
        raise WSError('chrome unreachable: ' + type(e).__name__)
    return [t for t in rows if t.get('type') == 'page']


def pick_target(target_id):
    ts = page_targets()
    if not ts:
        return (None, 'no page targets open')
    if target_id:
        for t in ts:
            if t.get('id') == target_id:
                return (t, '')
        return (None, 'no such targetId')
    return (ts[0], '')


# ---------------------------------------------------------------- http server
class H(BaseHTTPRequestHandler):
    server_version = 'pc-cdp-bridge'
    sys_version = ''

    def _s(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        try:
            self.wfile.write(b)
        except Exception:
            pass

    def _authed(self):
        # X-Cdp-Token, NOT X-Ops-Token. [SEC-CDP-SPLIT-V1] gave this service its
        # own secret in /opt/cdp-token; an ops token presented here does nothing,
        # and this token does not buy bash -lc as root on :8022.
        #
        # Constant time. A plain != leaks the token a byte at a time to anyone
        # who can measure the response, and on a shared VPC that is anyone.
        got = self.headers.get(TOKEN_HEADER, '') or ''
        if not TOKEN:
            return False
        return hmac.compare_digest(got.encode(), TOKEN.encode())

    def do_GET(self):
        # /healthz is BEHIND the token. An unauthenticated 200 confirms to any
        # scanner on the VPC that a CDP bridge lives here, which is the one bit
        # an attacker most wants before spending a token guess.
        if not self._authed():
            return self._s(403, {'error': 'denied'})
        if self.path == '/healthz':
            return self._s(200, {'ok': True, 'chrome': self._chrome_up(),
                                 'methods': list(METHOD_ALLOW)})
        return self._s(404, {'error': 'not found'})

    def _chrome_up(self):
        try:
            chrome_get('/json/version')
            return True
        except Exception:
            return False

    def do_POST(self):
        if not self._authed():
            return self._s(403, {'error': 'denied'})
        if self.path != '/rpc':
            return self._s(404, {'error': 'not found',
                                 'hint': 'the only endpoint is POST /rpc'})
        try:
            n = int(self.headers.get('Content-Length', '0') or '0')
        except Exception:
            n = 0
        if n > 1048576:
            return self._s(413, {'error': 'request too large'})
        try:
            body = json.loads(self.rfile.read(n) or b'{}')
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        return self._rpc(body)

    def _rpc(self, body):
        policy = load_policy()
        method = str(body.get('method') or '')
        params = body.get('params')
        if not isinstance(params, dict):
            params = {}
        target_id = body.get('targetId')
        target_id = str(target_id) if target_id else ''

        if method not in METHOD_ALLOW:
            return self._s(403, {'ok': False, 'error': 'method not allowed',
                                 'method': method, 'allowed': list(METHOD_ALLOW)})

        cap = int(policy.get('max_result_bytes') or 65536)
        tmo = int(policy.get('eval_timeout_ms') or 15000)

        # Target.getTargets is answered from the HTTP discovery surface: it needs
        # no websocket and no origin check, and it is the only enumeration the
        # control plane gets.
        if method == 'Target.getTargets':
            try:
                ts = page_targets()
            except Exception as e:
                return self._s(502, {'ok': False, 'error': str(e)[:200],
                                     'hint': 'is Chrome running? it launches via pc-chrome'})
            out = []
            for t in ts:
                url = t.get('url') or ''
                ok, why = origin_permitted(url, policy)
                out.append({'targetId': t.get('id'), 'title': t.get('title'),
                            'url': url, 'drivable': ok,
                            'reason': '' if ok else why})
            return self._s(200, {'ok': True, 'targets': out})

        # Target.createTarget: a NEW tab. The url must clear the origin check
        # before the tab exists, otherwise browser_open is a way to make an
        # allowed-origin check moot by first navigating somewhere else.
        if method == 'Target.createTarget':
            url = str(params.get('url') or '')
            ok, why = origin_permitted(url, policy)
            if not ok:
                return self._s(403, {'ok': False, 'error': 'origin refused',
                                     'url': url, 'reason': why})
            try:
                t = chrome_get('/json/new?' + urllib.parse.quote(url, safe=''))
            except Exception:
                try:
                    raw = chrome_put('/json/new?' + urllib.parse.quote(url, safe=''))
                    t = json.loads(raw)
                except Exception as e:
                    return self._s(502, {'ok': False, 'error': str(e)[:200]})
            return self._s(200, {'ok': True, 'targetId': t.get('id'),
                                 'url': t.get('url')})

        if method == 'Target.closeTarget':
            tid = target_id or str(params.get('targetId') or '')
            if not tid:
                return self._s(400, {'ok': False, 'error': 'targetId required'})
            try:
                chrome_get('/json/close/' + urllib.parse.quote(tid, safe=''))
            except Exception as e:
                return self._s(502, {'ok': False, 'error': str(e)[:200]})
            return self._s(200, {'ok': True, 'closed': tid})

        # Everything below needs a live page session.
        try:
            t, why = pick_target(target_id)
        except Exception as e:
            return self._s(502, {'ok': False, 'error': str(e)[:200],
                                 'hint': 'is Chrome running? it launches via pc-chrome'})
        if not t:
            return self._s(409, {'ok': False, 'error': why})

        cur_url = t.get('url') or ''
        if method in ORIGIN_CHECKED:
            ok, r1 = origin_permitted(cur_url, policy)
            if not ok:
                return self._s(403, {'ok': False, 'error': 'origin refused',
                                     'tabUrl': cur_url, 'reason': r1,
                                     'note': 'the TAB the call would act on is not drivable'})
        if method in ('Page.navigate',):
            dest = str(params.get('url') or '')
            ok, r2 = origin_permitted(dest, policy)
            if not ok:
                return self._s(403, {'ok': False, 'error': 'origin refused',
                                     'url': dest, 'reason': r2})

        ws_url = t.get('webSocketDebuggerUrl') or ''
        if not ws_url:
            return self._s(502, {'ok': False, 'error': 'target has no debugger url'})

        if method == 'Runtime.evaluate':
            expr = params.get('expression')
            if not isinstance(expr, str) or not expr:
                return self._s(400, {'ok': False, 'error': 'expression required'})
            params = {
                'expression': expr,
                'returnByValue': True,
                'awaitPromise': bool(params.get('awaitPromise', True)),
                'timeout': tmo,
                # NOT userGesture:true. That flag unlocks autoplay, popups and
                # several permission prompts that browsers gate on real user
                # intent, and nothing here is real user intent.
                'userGesture': False,
                'allowUnsafeEvalBlockedByCSP': False,
            }

        try:
            resp = cdp_call(ws_url, method, params, tmo, cap)
        except WSError as e:
            return self._s(502, {'ok': False, 'error': 'cdp: ' + str(e)[:200]})
        except Exception as e:
            return self._s(502, {'ok': False,
                                 'error': 'cdp: ' + type(e).__name__ + ': ' + str(e)[:180]})

        if 'error' in resp:
            return self._s(200, {'ok': False, 'cdpError': resp.get('error')})
        result = resp.get('result')
        blob = json.dumps(result)
        truncated = False
        if len(blob) > cap:
            blob = blob[:cap]
            truncated = True
            result = {'truncated': True, 'preview': blob}
        return self._s(200, {'ok': True, 'method': method,
                             'targetId': t.get('id'), 'tabUrl': cur_url,
                             'result': result, 'truncated': truncated})

    def log_message(self, *a):
        pass


def main():
    if '--self-test' in sys.argv:
        return selftest()
    sys.stderr.write('cdp-bridge: binding %s:%d (loopback only; reach it over the '
                     'IAP tunnel)\n' % (BIND_HOST, BIND_PORT))
    HTTPServer((BIND_HOST, BIND_PORT), H).serve_forever()


def selftest():
    fails = []

    def chk(name, cond):
        if not cond:
            fails.append(name)

    p = dict(DEFAULT_POLICY)
    p['origin_allow'] = ['example.com', '*.corp.example']

    chk('empty allow denies', origin_permitted('https://x.test/', DEFAULT_POLICY)[0] is False)
    chk('allowed host', origin_permitted('https://example.com/a', p)[0] is True)
    chk('wildcard sub', origin_permitted('https://a.corp.example/x', p)[0] is True)
    chk('wildcard not bare', origin_permitted('https://corpxexample/x', p)[0] is False)
    chk('other host denied', origin_permitted('https://evil.test/', p)[0] is False)
    chk('http denied', origin_permitted('http://example.com/', p)[0] is False)
    chk('file denied', origin_permitted('file:///etc/passwd', p)[0] is False)
    chk('chrome denied', origin_permitted('chrome://settings', p)[0] is False)
    chk('empty denied', origin_permitted('', p)[0] is False)

    p2 = dict(p)
    p2['origin_allow'] = ['accounts.google.com', 'example.com']
    chk('deny beats allow', origin_permitted('https://accounts.google.com/x', p2)[0] is False)
    chk('deny path prefix', origin_permitted('https://github.com/settings/tokens', p2)[0] is False)

    chk('no Network domain', not any(m.startswith('Network.') for m in METHOD_ALLOW))
    chk('no Storage domain', not any(m.startswith('Storage.') for m in METHOD_ALLOW))
    chk('no Browser domain', not any(m.startswith('Browser.') for m in METHOD_ALLOW))
    chk('no Input domain', not any(m.startswith('Input.') for m in METHOD_ALLOW))
    chk('no Fetch domain', not any(m.startswith('Fetch.') for m in METHOD_ALLOW))
    chk('no attachToBrowserTarget', 'Target.attachToBrowserTarget' not in METHOD_ALLOW)
    chk('no addScriptToEvaluateOnNewDocument',
        'Page.addScriptToEvaluateOnNewDocument' not in METHOD_ALLOW)
    chk('eval present', 'Runtime.evaluate' in METHOD_ALLOW)
    chk('origin checked covers eval', 'Runtime.evaluate' in ORIGIN_CHECKED)
    chk('origin checked covers navigate', 'Page.navigate' in ORIGIN_CHECKED)

    # ---- bind. The original of this block asserted the BUG -- it accepted
    #      BIND_HOST == '0.0.0.0' and passed precisely because that was the default.
    #      A green self-test that certifies the defect is worse than no self-test.
    #      [SEC-CDP-LOOPBACK-V1] These assert THIS deployment's bind: loopback, a
    #      constant, unreachable from any network and unwidenable by configuration.
    chk('bind is loopback', BIND_HOST == '127.0.0.1')
    chk('bind is not a wildcard', BIND_HOST not in ('0.0.0.0', '::', ''))
    chk('bind is not routable off this box',
        BIND_HOST.startswith('127.') and BIND_HOST != '0.0.0.0')
    # The env override is gone. Setting it must change nothing. Prove it rather
    # than assert it, because "we removed the override" is exactly the kind of
    # claim that quietly stops being true.
    _saved = os.environ.get('CDP_BRIDGE_HOST')
    os.environ['CDP_BRIDGE_HOST'] = '0.0.0.0'
    try:
        chk('CDP_BRIDGE_HOST cannot reintroduce a wildcard bind', BIND_HOST == '127.0.0.1')
    finally:
        if _saved is None:
            os.environ.pop('CDP_BRIDGE_HOST', None)
        else:
            os.environ['CDP_BRIDGE_HOST'] = _saved
    chk('no metadata-resolved bind survives', 'resolve_bind' not in globals())
    chk('chrome is on loopback too', CHROME.startswith('http://127.0.0.1:'))

    # ---- the credential split. [SEC-CDP-SPLIT-V1] gives this service its own
    # secret and its own header; the control plane's harCdp() sends X-Cdp-Token.
    chk('own token file, not the root-RCE one', TOKEN_PATH == '/opt/cdp-token')
    chk('own header, not X-Ops-Token', TOKEN_HEADER == 'X-Cdp-Token')
    chk('origin_of', origin_of('https://a.b/c?d=e') == 'https://a.b')
    chk('host_path', host_path('https://a.b/c?d') == 'a.b/c')

    if fails:
        sys.stdout.write('SELF-TEST FAIL: ' + ', '.join(fails) + '\n')
        return 1
    sys.stdout.write('SELF-TEST OK (' + str(len(METHOD_ALLOW)) + ' methods allowed, '
                     'bound to ' + BIND_HOST + ' only, no 0.0.0.0 and no network '
                     'listener)\n')
    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
PYEOF
cat >/etc/systemd/system/cdp-bridge.service <<'EOF'
[Unit]
Description=Paracoding CDP bridge
After=network-online.target
[Service]
ExecStart=/usr/bin/python3 /opt/cdp-bridge.py
Restart=always
RestartSec=5
# [SEC-CDP-SPLIT-V1] NOT root. The bridge needs exactly two things: bind 8025 and
# connect to 127.0.0.1:9222. Neither needs privilege. If the bridge is taken over,
# the attacker is pc-cdp -- no ops token, no root, no home directory, no shell.
User=pc-cdp
Group=pc-cdp
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
MemoryDenyWriteExecute=yes
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now cdp-bridge \
  || echo "SKIPPED cdp-bridge: systemd refused to start it"
# RUN ITS OWN SELF-TEST AND LOG WHAT IT SAID. The bridge asserts its method allowlist, its
# token file and header, and -- the assertion that matters here -- that it binds loopback
# and that nothing can widen that. A bridge that started is not the same fact as a bridge
# that is correct, and only one of the two is worth writing down.
if python3 /opt/cdp-bridge.py --self-test; then
  echo "cdp-bridge self-test OK"
else
  echo "WARNING: cdp-bridge SELF-TEST FAILED -- the browser bridge is NOT trustworthy on"
  echo "this box. It is left running only so the failure is visible; do not point anything"
  echo "at it until the lines above are explained."
fi
echo "CDP bridge: 127.0.0.1:8025 -> Chrome 127.0.0.1:9222. Nothing is published on any"
echo "network and no firewall rule was opened. Reach it over the IAP tunnel:"
echo "  gcloud compute ssh THIS-VM --zone ZONE --tunnel-through-iap -- -L 8025:127.0.0.1:8025"
echo "Token: sudo cat /opt/cdp-token   Policy: /opt/cdp-policy.json (origin_allow is EMPTY"
echo "on purpose -- out of the box the bridge drives nothing and says why)."

: > "$PC_WS_STAMP"
echo "== finished $(date -u +%FT%TZ)"
echo "WS-SETUP-DONE"
PC_WS_STARTUP_EOF
    chmod 0600 "$HERE/.ws-startup.sh"
    PC_VMC_RC=0
    retry gcloud compute instances create "$WS_VM_NAME" --project "$PROJECT" \
      --zone "$WS_VM_ZONE" --machine-type e2-standard-4 \
      --image-family "$WS_IMG_FAMILY" --image-project ubuntu-os-cloud \
      --boot-disk-size 100GB --boot-disk-type pd-balanced \
      --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
      --metadata enable-oslogin=TRUE,pc-claude-ext-id="$PC_WS_EXT_ID",pc-claude-apt-repo="$PC_WS_CLAUDE_APT_REPO",pc-claude-apt-key="$PC_WS_CLAUDE_APT_KEY",pc-claude-apt-fpr="$PC_WS_CLAUDE_APT_FPR" \
      --metadata-from-file startup-script="$HERE/.ws-startup.sh" \
      --service-account "$WS_SA" \
      --scopes https://www.googleapis.com/auth/logging.write,https://www.googleapis.com/auth/monitoring.write,https://www.googleapis.com/auth/devstorage.read_only \
      $PC_WS_NET_FLAG \
      --quiet >/dev/null || PC_VMC_RC=$?
    gcloud compute instances describe "$WS_VM_NAME" --zone "$WS_VM_ZONE" --project "$PROJECT" \
      >/dev/null 2>&1 \
      || die "the workstation VM $WS_VM_NAME is still absent in $WS_VM_ZONE after a create
attempt (exit $PC_VMC_RC). The describe is the authority here, not the create status, because a
concurrent run makes create a 409 and that is success for our purposes."
    rm -f "$HERE/.ws-startup.sh"
    echo "  created $WS_VM_NAME in $WS_VM_ZONE ($WS_IMG_FAMILY, e2-standard-4,"
    echo "  100 GB pd-balanced, Shielded VM, service account $WS_SA)"
    if [ "$PC_WS_EGRESS" = cloud-nat ]; then
      echo "  NO EXTERNAL IP. Egress is via Cloud NAT ($PC_NAT_CFG on router $PC_NAT_RTR in"
      echo "  $REGION) -- outbound only, nothing inbound, no firewall rule opened."
    else
      echo "  !! NO CLOUD NAT COULD BE PROVISIONED (this project has no usable 'default' VPC"
      echo "  !! network in $REGION), so this VM was given an EPHEMERAL EXTERNAL IP instead."
      echo "  !! THE TRADE-OFF, SAID PLAINLY: the box now has a public address. OS Login is"
      echo "  !! still enforced so password/key SSH is refused, but the address is reachable."
      echo "  !! It was given egress anyway because with none it cannot install the desktop,"
      echo "  !! the browser or the Claude app, and is useless. To close it: create a Cloud"
      echo "  !! NAT on the subnet in $REGION, then"
      echo "  !!   gcloud compute instances delete-access-config $WS_VM_NAME --zone $WS_VM_ZONE"
    fi
    echo "  OS Login is enforced. Reach it with:"
    echo "    gcloud compute ssh $WS_VM_NAME --zone $WS_VM_ZONE --tunnel-through-iap"
    echo
    echo "  A STARTUP SCRIPT IS PROVISIONING THE REMOTE DESKTOP RIGHT NOW, IN THE BACKGROUND."
    echo "  It installs XFCE, Google Chrome, the Chrome Remote Desktop host and the Claude"
    echo "  desktop app, and it is idempotent -- it logs to /var/log/paracoding-ws-setup.log on"
    echo "  the VM and re-running it changes nothing. Give it about ten minutes."
    echo
    # [WS-WIN-IDLE-V49] Stated at create time on THIS side too. It has always been true here;
    # it was never printed, which is half of why the Windows box was assumed to do the same.
    echo "  IT STOPS ITSELF AFTER 30 MINUTES IDLE. ws-idle.timer runs ws-idle.sh every 5"
    echo "  minutes from 10 minutes after boot; 6 consecutive checks with nobody logged in"
    echo "  and load under 1 run shutdown -h now, and any activity resets the count. Hold it"
    echo "  up for an unattended job with  sudo touch /run/ws-busy  (rm to release), or turn"
    echo "  it off with  sudo systemctl disable --now ws-idle.timer  and pay by the hour."
    echo
    echo "  THE LAST STEP IS MANUAL AND CANNOT BE AUTOMATED. Chrome Remote Desktop registers a"
    echo "  host with a ONE-TIME authorisation code that is minted against YOUR Google account"
    echo "  in YOUR browser; no service account and no installer can mint it for you, and it"
    echo "  expires in minutes. So you do this part by hand, once:"
    echo "    1. open   https://remotedesktop.google.com/headless"
    echo "    2. click Begin -> Next -> Authorize, and COPY the Debian Linux command it shows"
    echo "    3. SSH to the VM:"
    echo "         gcloud compute ssh $WS_VM_NAME --zone $WS_VM_ZONE --tunnel-through-iap"
    echo "    4. wait for /var/log/paracoding-ws-setup.log to end with WS-SETUP-DONE"
    echo "    5. PASTE that command there and run it. It asks you to set a 6-digit PIN."
    echo "    6. open   https://remotedesktop.google.com/access   and connect."
    fi
  fi
  # ONE CALL SITE, AND IT DOMINATES ALL THREE PATHS ABOVE -- adopt, windows create and linux
  # create. An ADOPTED instance needs this exactly as much as a new one: the binding lives on
  # the tunnel resource, not on the image, so a VM somebody else created is unreachable for
  # the same reason. Everything in it is describe-first / read-modify-write, so a second run
  # of this function costs two API calls and changes nothing.
  pc_ws_grant_access "$PC_WS_KIND"
}
# @@PC_SHARED_END:WS_LIB@@
# [SEC-WSVM-OPTIN-V1] vm_status, vm_start, vm_stop and vm_resize act on a Compute
# Engine instance named by WS_VM in zone WS_ZONE -- index.ts:2910-2911 and :1493-1494, which
# carry a built-in default name and zone. No instance was ever created and neither variable was
# ever set, so four tools registered and then failed against a machine nobody made.
# [SEC-SSHTOOL-REMOVED-V1] ssh_executor USED TO BE DISCLAIMED HERE AND NO LONGER EXISTS.
# It is worth one line so nobody re-adds it looking for a way onto this VM: it never was one.
# It read NEITHER WS_VM NOR WS_ZONE, took its target as a tool argument, and needed a private
# key no installer has ever created. This instance is --no-address with OS Login enforced and
# Cloud Run has no route to it, so the tool could not have reached this machine even fully
# configured. THE WAY ONTO THIS BOX IS `gcloud compute ssh --tunnel-through-iap`, from the
# operator's own machine, which is what 5d/10 prints and what workstation.sh is built around.
# It is opt-in and it defaults to NO, because a running VM bills by the hour and most adopters
# do not want one.
# --rehearse MUST NOT PROMPT. An unattended rehearsal has to reach the 9/10 boundary with no
# human, and this script has exactly ONE prompt in it -- the ENTER after the passkey, below the
# boundary, which a rehearsal never reaches. Keep it that way: the answer is taken from
# PC_WANT_VM when it is set, and under --rehearse an unset PC_WANT_VM answers NO without asking.
# Setting PC_WANT_VM=y is also how CI rehearses the create path.
# [SEC-WSVM-KIND-V1] THREE-WAY NOW, NOT YES/NO, AND THE THIRD OPTION EXISTS BECAUSE THE
# FIRST ONE FAILED ON THE DAY. The Linux workstation is a headless Ubuntu box that only
# becomes usable after XFCE, Chrome, the Chrome Remote Desktop host AND a manual one-time
# registration code have all come up; when one of those does not, there is no screen and no
# fallback. Windows Server with Desktop Experience has the remote-desktop half BUILT IN --
# RDP is part of the OS -- so the thing that broke cannot break the same way. Neither is
# "the right one": the operator picks, per install, and both are still OPTIONAL and the
# default is still NONE, because a running VM bills by the hour whichever OS it runs.
#
# PC_WANT_VM=y IS STILL HONOURED AND STILL MEANS LINUX. Existing CI, existing docs and
# existing muscle memory keep working unchanged. PC_WS_KIND is the new explicit knob and it
# WINS when both are set, so there is exactly one answer and no way to set two.
# --rehearse MUST NOT PROMPT -- unchanged, it answers NONE without asking.
PC_WS_KIND="${PC_WS_KIND-}"
PC_WANT_VM="${PC_WANT_VM-}"
if [ -z "$PC_WS_KIND" ]; then
  case "$PC_WANT_VM" in
    y|Y|yes|YES|Yes) PC_WS_KIND=linux ;;
    n|N|no|NO|No)    PC_WS_KIND=none ;;
  esac
fi
if [ -z "$PC_WS_KIND" ]; then
  if [ "$PC_REHEARSE" = 1 ]; then
    PC_WS_KIND=none
    echo "  --rehearse: answering NONE without asking, so this run needs no human."
    echo "  Set PC_WS_KIND=linux or PC_WS_KIND=windows to rehearse a create path instead."
  else
    echo "  A workstation VM is what makes the vm_* tools work, and it is where you would run"
    echo "  the Claude desktop app. Two flavours. THEY DIFFER IN HOW YOU GET A SCREEN, AND"
    echo "  BOTH NOW STOP THEMSELVES AFTER 30 MINUTES IDLE -- [WS-WIN-IDLE-V49], because"
    echo "  until this release only the linux one did and nothing said so:"
    echo "    linux    Ubuntu LTS + XFCE + Chrome Remote Desktop. No inbound port at all and"
    echo "             nothing to open, but CRD needs a manual one-time registration code and"
    echo "             a headless CRD install has several ways to come up blank."
    echo "             IDLE-STOPS: yes, after 30 minutes -- a systemd timer, every 5 minutes"
    echo "             from boot+10min, 6 consecutive quiet checks then shutdown -h now."
    echo "             Hold it up for an unattended job with  sudo touch /run/ws-busy."
    echo "    windows  Windows Server, Desktop Experience. RDP is part of the OS, so there is"
    echo "             less to go wrong -- and it STILL gets no public address: RDP is reached"
    echo "             through IAP TCP forwarding only, never 3389 open to the internet. The"
    echo "             first Administrator password has to be reset by hand before you log in."
    echo "             IDLE-STOPS: yes, after 30 minutes -- a scheduled task on the same"
    echo "             schedule, 6 consecutive checks with no Active session and CPU under"
    echo "             25%, then Stop-Computer. A DISCONNECTED RDP session does not count as"
    echo "             activity; hold the box up with C:\\ProgramData\\paracoding\\ws-busy."
    echo "    none     no VM. Nothing created, nothing billed. This is the default."
    echo "  An idle-stop is not a spend cap: a machine you leave BUSY bills for every hour,"
    echo "  and a stopped instance still bills for its 150 GB (windows) / 100 GB disk."
    # [SEC-STDIN-DRAIN-V1] pc_ask_choice drains the buffered ENTERs from the slow 1/10 step
    # before it asks, so this answer is the operator's and not the terminal queue's. An
    # unrecognised answer RE-PROMPTS rather than being guessed at.
    pc_ask_choice none 'none linux windows' \
      '  Workstation VM? [none/linux/windows] (ENTER for none): '
    PC_WS_KIND="$PC_CHOICE"
  fi
fi
# PC_WANT_VM is derived from here down, so every existing test of it below still reads true.
case "$PC_WS_KIND" in
  linux|windows) PC_WANT_VM=y ;;
  *)             PC_WS_KIND=none; PC_WANT_VM=n ;;
esac
PC_VM_ENV=""
if [ "$PC_WANT_VM" = n ]; then
  echo "  no VM. WS_VM and WS_ZONE are left UNSET, and unset is not the same as harmless:"
  echo "  vm_status, vm_start, vm_stop and vm_resize STILL REGISTER and will fail against"
  echo "  the built-in default name in us-central1-a. Those four tools will not work."
  echo "  Re-run with PC_WS_KIND=linux or PC_WS_KIND=windows to add one later; nothing"
  echo "  else in this install depends on it."
else
  # [SEC-WSVM-ONEBODY-V1] DELEGATED, NOT DUPLICATED. Everything that decides a name,
  # lists a zone, provisions the Cloud NAT, the service account and the IAP firewall
  # rule, and creates the instance, now lives in ONE shell function, pc_workstation_create,
  # which is emitted from a SINGLE definition in the generator into BOTH this file and the
  # standalone workstation.sh. There is no runtime dependency between the two scripts:
  # install.sh carries its own inlined copy of the function body and works with
  # workstation.sh absent. Two hand-maintained copies of VM creation logic is the drift
  # this fleet has already been burned by, so there is exactly one.
  pc_workstation_create "$PC_WS_KIND"
  if [ "${PC_WS_REFUSED:-0}" = 1 ]; then
    # The flavour was refused for a stated safety reason. Fall back to the documented default
    # rather than to a half-configured VM: WS_VM_NAME and WS_VM_ZONE were never assigned, and
    # reading them under `set -u` would abort the install a second way.
    PC_WS_KIND=none; PC_WANT_VM=n; PC_VM_ENV=""
    echo "  no workstation was created (see the refusal above). WS_VM and WS_ZONE stay UNSET,"
    echo "  so vm_status, vm_start, vm_stop and vm_resize will register and fail. Nothing else"
    echo "  in this install depends on them, and the install is continuing."
  else
  PC_VM_ENV=",WS_VM=$WS_VM_NAME,WS_ZONE=$WS_VM_ZONE"
  echo "  WS_VM=$WS_VM_NAME WS_ZONE=$WS_VM_ZONE will be set on BOTH $CP_SVC and $MC_SVC"
  echo "  at 6/10. The vm_* tools are MCP tools, so $MC_SVC is the one that drives them."
  fi
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
retry gcloud run deploy "$CP_SVC" --source "$HERE/control-plane" --region "$REGION" --project "$PROJECT" \
  --service-account "$CP_SA" --allow-unauthenticated --clear-base-image --quiet \
  --set-env-vars "PC_SURFACE=console,PC_AUTO_APPROVE=$PC_AUTO_APPROVE,PC_GUARDRAILS=$PC_GUARDRAILS,WA_RP_ID=$CP_HOST,WA_RP_ORIGIN=https://$CP_HOST,MCP_PUBLIC_URL=$MC_URL,PC_CONSOLE_URL=https://$CP_HOST,OAUTH_DEFAULT_ROLE=fleet-onboarder,PC_FIRESTORE_DB=$FSDB,PC_IAP_AUD=/projects/$PROJNUM/locations/$REGION/services/$CP_SVC,PC_REQUIRE_PASSKEY=1,PC_SESSION_ENFORCE=1,PC_KEY_TTL_DAYS=7,PC_TOOLS_ENFORCE=1,WA_APPROVER_EMAILS=$ACCT,WA_SESSION_MIN=240,DATA_LAKE_BUCKET=$PC_LAKE_BUCKET,PC_EXEC_BUCKET=$PC_EXEC_BUCKET,GCP_PROJECT=$PROJECT,GCP_REGION=$REGION$PC_VM_ENV$PC_GIT_ENV$PC_VAULT_ENV" \
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
  --set-env-vars "PC_SURFACE=mcp,PC_AUTO_APPROVE=$PC_AUTO_APPROVE,PC_GUARDRAILS=$PC_GUARDRAILS,WA_RP_ID=$CP_HOST,WA_RP_ORIGIN=https://$CP_HOST,MCP_PUBLIC_URL=$MC_URL,PC_CONSOLE_URL=https://$CP_HOST,PC_IAP_AUD=/projects/$PROJNUM/locations/$REGION/services/$CP_SVC,OAUTH_DEFAULT_ROLE=fleet-onboarder,PC_FIRESTORE_DB=$FSDB,PC_REQUIRE_PASSKEY=1,PC_SESSION_ENFORCE=1,PC_KEY_TTL_DAYS=7,PC_TOOLS_ENFORCE=1,WA_APPROVER_EMAILS=$ACCT,WA_SESSION_MIN=240,DATA_LAKE_BUCKET=$PC_LAKE_BUCKET,PC_EXEC_BUCKET=$PC_EXEC_BUCKET,GCP_PROJECT=$PROJECT,GCP_REGION=$REGION$PC_VM_ENV$PC_GIT_ENV$PC_VAULT_ENV" \
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
  pc_wiki_put pages/the-workstation.md 1
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
    say "  WARNING: could not mint a token to seed the allowed-account list; add the addresses in Settings."
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
      say "  allowed accounts: $ACCT$PC_EXTRA_EMAILS"
    else
      say "  WARNING: could not seed the allowed-account list ($PC_ALLOW_OUT); add the addresses in Settings."
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
    "FN.VM_TOOLS": "vm_status/vm_start/vm_stop/vm_resize need a workstation instance. 5d/10 "
                   "says whether one was made; vm_start/stop/resize also spend an approval.",
    "FN.BROWSER_TOOLS": "browser_open/navigate/tabs need a live CDP endpoint on a running box. "
                        "5d/10 now PROVISIONS one -- a token-gated DevTools bridge on the "
                        "workstation's LOOPBACK address, in front of a Chrome whose debugging "
                        "port is also loopback -- but it is deliberately not on any network and "
                        "this installer opens no firewall rule for it, so the control plane "
                        "cannot reach it and index.ts therefore withholds these three tools. "
                        "Reachable over the IAP tunnel from the operator's own machine; 5d/10 "
                        "prints the command. Nothing here can drive it, so nothing here claims "
                        "to have.",
}

KNOWN = ("whoami read_graph search_nodes open_nodes list_work_items read_journal "
         "list_pending_confirm read_file list_files read_history search_history get_time "
         "read_job_log run_status vm_status list_my_messages check_answer browser_tabs "
         "create_entities create_relations add_observations delete_entities "
         "delete_observations delete_relations append_journal post_work_item "
         "complete_work_item cancel_work_item log_history write_file put_file "
         "answer_message ask_agent refresh stage_privileged_job run_command "
         "gcp_api run_roll vm_start vm_stop vm_resize browser_open "
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
                "registered: " + " ".join(gitseen) + ". registerGitTools() registers all seven "
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
                "not all seven git tools are registered, which FN.TOOL_CENSUS has already "
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
                _sf = []
                for _r, _ds, _fs2 in os.walk(_seed_here):
                    _ds[:] = sorted(_d for _d in _ds
                                    if _d not in PC_SEED_SKIP and not _d.startswith("."))
                    for _fn in sorted(_fs2):
                        if _fn.startswith("."):
                            continue
                        _p = os.path.join(_r, _fn)
                        try:
                            _txt = open(_p, encoding="utf-8").read()
                        except Exception:
                            continue
                        _sf.append((os.path.relpath(_p, _seed_here).replace(os.sep, "/"), _txt))
                _sf.sort()

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
                    if _s[0] == "propose":
                        st, f = call("git_propose", {"branch": "main", "files": _s[1],
                                                     "message": _smsg})
                    else:
                        st, f = call("git_propose_patch", {"branch": "main", "patch": _s[2],
                                                           "message": _smsg})
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
                                              "commit_oid": _sj.get("commitOid")})
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
PC_BUILD_SA_ID="pc-${PC_LP}${PC_TOK}build"
PC_BUILD_SA="${PC_BUILD_SA_ID}@${PROJECT}.iam.gserviceaccount.com"
if gcloud iam service-accounts describe "$PC_BUILD_SA" --project "$PROJECT" >/dev/null 2>&1; then
  echo "  adopting $PC_BUILD_SA"
else
  retry gcloud iam service-accounts create "$PC_BUILD_SA_ID" --project "$PROJECT" --display-name="paracoding ${PC_LP}CI build identity" >/dev/null || die "could not create the CI build identity $PC_BUILD_SA"
  echo "  created $PC_BUILD_SA"
fi
for _pc_svc in "$CP_SVC" "$MC_SVC" "$GX_SVC"; do
  retry gcloud run services add-iam-policy-binding "$_pc_svc" --region "$REGION" --project "$PROJECT" --member="serviceAccount:$PC_BUILD_SA" --role=roles/run.developer --condition=None >/dev/null || die "could not grant roles/run.developer on $_pc_svc to $PC_BUILD_SA"
done
echo "  $PC_BUILD_SA -> roles/run.developer on $CP_SVC, $MC_SVC and $GX_SVC ONLY"
# Without this a deploy fails with a permission error naming the RUNTIME account, which reads
# like a defect in the runtime account rather than a missing grant on the builder.
for _pc_rsa in "$CP_SA" "$GX_SA"; do
  retry gcloud iam service-accounts add-iam-policy-binding "$_pc_rsa" --project "$PROJECT" --member="serviceAccount:$PC_BUILD_SA" --role=roles/iam.serviceAccountUser --condition=None >/dev/null || die "could not grant roles/iam.serviceAccountUser on $_pc_rsa to $PC_BUILD_SA"
done
echo "  $PC_BUILD_SA -> roles/iam.serviceAccountUser on $CP_SA and $GX_SA ONLY"
retry gcloud storage buckets add-iam-policy-binding "gs://$PC_STAGE_BUCKET" --project "$PROJECT" --member="serviceAccount:$PC_BUILD_SA" --role=roles/storage.objectViewer --condition=None >/dev/null || die "could not grant the CI build identity read on gs://$PC_STAGE_BUCKET"
echo "  $PC_BUILD_SA -> roles/storage.objectViewer on gs://$PC_STAGE_BUCKET ONLY"
# THE TRIGGER IS NOT CREATED HERE AND THIS SAYS SO RATHER THAN LEAVING YOU TO FIND OUT.
# A Cloud Build trigger builds a SOURCE ARCHIVE. The notice this lane publishes carries no
# archive, for the reason recorded at 5c/10, and this tree ships no producer that makes one.
# Emitting a trigger anyway would produce a pipeline that looks complete and dies at its
# first step on every push, which is worse than a gap you can see.
PC_CI_SUBS='_COMMIT=$(body.message.data.commit),_ARCHIVE=$(body.message.data.archive),_SHA256=$(body.message.data.sha256)'
echo
echo "  TO FINISH THE PIPELINE, one command, after you have a producer that publishes the"
echo "  four-key build request {commit, short, archive, sha256, ref} to $PC_CI_TOPIC_ID:"
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
# SETTING PC_AR_REPO2 EMPTY DROPS IT FROM THE LIST, for an adopter who has no such
# repository. That is a clean opt-out and not a silent one: the loop below prints the name
# and package list of every repository it touches, before it touches it. Note the default
# below is written ${PC_AR_REPO2-fleet} and NOT ${PC_AR_REPO2:-fleet}, unlike every other
# default in this step. With the colon an explicit PC_AR_REPO2= would be treated as UNSET
# and silently fall back to the default -- i.e. the documented opt-out would not opt out,
# which is the exact class of quietly-ignored setting this file refuses everywhere else.
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
PC_AR_REPO2="${PC_AR_REPO2-fleet}"
PC_AR_REPO2_PKGS="${PC_AR_REPO2_PKGS:-control-plane}"
PC_KEEP_COUNT="${PC_KEEP_COUNT:-50}"
PC_UNTAGGED_DAYS="${PC_UNTAGGED_DAYS:-90}"
PC_STAGE_AGE_DAYS="${PC_STAGE_AGE_DAYS:-30}"
PC_RET_DIR="$HERE/.retention"
mkdir -p "$PC_RET_DIR" || die "could not create $PC_RET_DIR"
PC_CB_BUCKET="${PROJECT}_cloudbuild"
# THE GUARD THAT MATTERS MORE THAN THE POLICY. The data lake holds agent memory and the wiki;
# the source bucket IS the git object store and carries versioning. An age rule on either of
# those is not a storage saving, it is data loss. They are named here and compared by value,
# so a future edit that points the loop at the wrong variable stops the install instead.
for _pc_lb in "$PC_CB_BUCKET" "$PC_STAGE_BUCKET"; do
  for _pc_nb in "$PC_LAKE_BUCKET" "$PC_SOURCE_BUCKET"; do
    if [ "$_pc_lb" = "$_pc_nb" ]; then die "REFUSING: the lifecycle target gs://$_pc_lb is a DATA bucket, not a staging bucket. No age rule is going anywhere near the data lake or the git object store."; fi
  done
done
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
# [SEC-LANELIT-BOOTSECRET-V1] THE SECRET IS NAMED BY $PC_SEC_BOOT ON ALL FOUR LINES, AND THE
# MINT IS CHECKED. These three used to say the UNPREFIXED name while $CP_SA and $CP_SVC beside
# them were lane-correct, so a lane install granted the wrong lane read on the bootstrap
# secret and wired this console to its value -- one shared pre-passkey credential across two
# lanes, on the path used to reach the gate BEFORE any passkey exists.
# THE MINT IS NOW CHECKED rather than left to carry on. This script runs set -u and NOT set -e
# on purpose (the 10/10 self-test reports every failing check by name and the uninstaller's
# blind-spot machinery is built on `X=$(...); RC=$?`; set -e would abort at the first of
# either), so nothing global stops a failed create -- the status is taken here instead. The
# temp file is removed BEFORE the die: a bootstrap value left on disk is the same defect.
PC_BOOT_RC=0
gcloud secrets describe "$PC_SEC_BOOT" --project "$PROJECT" >/dev/null 2>&1 \
  && retry gcloud secrets versions add "$PC_SEC_BOOT" --data-file="$HERE/.b.tmp" --project "$PROJECT" >/dev/null \
  || retry gcloud secrets create "$PC_SEC_BOOT" --replication-policy=automatic --data-file="$HERE/.b.tmp" --project "$PROJECT" >/dev/null || PC_BOOT_RC=$?
python3 -c "import os;os.remove('$HERE/.b.tmp')"
[ "$PC_BOOT_RC" -eq 0 ] || die "could not mint the bootstrap secret $PC_SEC_BOOT (exit $PC_BOOT_RC).
Stopping here on purpose: the two steps below grant $CP_SA read on it and point this console at
it, and running them against a secret this install did not create is how one lane ends up
reading another lane's bootstrap value."
retry gcloud secrets add-iam-policy-binding "$PC_SEC_BOOT" --member="serviceAccount:$CP_SA" \
  --role=roles/secretmanager.secretAccessor --project "$PROJECT" >/dev/null \
  || die "could not grant $CP_SA secretAccessor on $PC_SEC_BOOT. Without it the console cannot
read the value the setup link below carries, so the gate would refuse every registration."
retry gcloud run services update "$CP_SVC" --region "$REGION" --project "$PROJECT" \
  --update-secrets "WA_BOOTSTRAP_SECRET=${PC_SEC_BOOT}:latest" >/dev/null \
  || die "could not set WA_BOOTSTRAP_SECRET on $CP_SVC from $PC_SEC_BOOT."
cat <<EOF

  Open this on a device with Face ID, Touch ID, or a security key:

      ${CP_URL}/harness?setup=${BOOT}

  Register your passkey. Until you do, nothing privileged can run -- including anything
  that would fix a bad install. When you are done, come back here and type the word
  continue -- an ENTER on its own will not do, deliberately, because a stray one used to
  close this window before anybody had registered anything.

EOF
# [SEC-STDIN-DRAIN-V1] THE PROMPT THAT COST AN OPERATOR A COMPLETE REINSTALL. It used to be
# a bare `read _ignored || true`: no drain, no validation, and `|| true` so even EOF walked on.
# An ENTER pressed during 1/10 or 6/10 sat in the terminal queue for minutes and then satisfied
# this read the instant it was reached -- and the very next command below REMOVES
# WA_BOOTSTRAP_SECRET, which closes the ?setup= registration window permanently. Now the
# buffered newlines are DRAINED FIRST and the literal word `continue` is REQUIRED; a bare
# newline re-prompts, forever. The secret is not touched until that word is typed.
pc_confirm_word continue \
  '  when your passkey is registered, type the word continue and press ENTER: '
retry gcloud run services update "$CP_SVC" --region "$REGION" --project "$PROJECT" \
  --remove-secrets WA_BOOTSTRAP_SECRET >/dev/null 2>&1
echo "  bootstrap window closed"

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
  chk_has "console serves the locked page" "The Autoclave" "$(curl -s --max-time 30 "$CP_URL/harness")"
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
# [SEC-WSVM-KIND-V1] WHICH FLAVOUR WAS BUILT, AND ITS NEXT COMMANDS, PRINTED HERE FOR THE
# SAME REASON THE URLS ARE: this is OUTSIDE `if [ "$FAIL" -eq 0 ]`. A run that created a
# Windows box and then tripped a spurious 8b/10 check still created a Windows box, and the
# operator still needs the two commands that make it reachable.
if [ -n "$PC_VM_ENV" ]; then
pc_ws_access_banner "$PC_WS_KIND"
fi
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

  So your next step is:  open ${CP_URL}/pastes , mint a key for a strain, and paste the
  block it gives you into a new chat. The key is shown ONCE -- only its hash is stored.
  Keys expire after 7 days (PC_KEY_TTL_DAYS); when one lapses the chat is told so and
  you mint a fresh paste.

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
  serving its name off the running revision. Three things are reported at the step that
  would have made them rather than restated here:

    the PCV1 vault    5e/10 created keyring ${PC_VKR} and key ${PC_VKEY}, and MINTED
                      shared/vault/master.kem if this machine had an ML-KEM capability. That
                      step said which way it went. Where master.kem was NOT minted the lake is
                      FAIL-CLOSED, not plaintext: every write outside the five cleartext
                      prefixes throws, and 5e/10 printed what is missing and how to finish it.
    the browser tools 5d/10 now installs the CDP bridge on the workstation, on LOOPBACK
                      only: 127.0.0.1:8025 in front of a Chrome debugging port on
                      127.0.0.1:9222, token-gated, eight CDP methods, and an origin
                      allowlist that starts EMPTY. Nothing is published on any network and
                      no firewall rule was opened for either port -- you reach it over the
                      IAP tunnel, and 5d/10 printed the command. The MCP browser tools stay
                      WITHHELD, and that is not an oversight: they address the box by its
                      internal IP, Cloud Run has no route to a 10.x address here, and
                      registering them would give you three tools that fail on first call.

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

  The VM tools depend on the answer you gave at 5d/10; that step said which way it went.
EOF
else
  echo "  $FAIL CHECK(S) FAILED. The install is NOT good. Nothing above lies to you about that."
  echo "  EVERY ONE OF THEM, BY NAME -- a count with nothing to match it against is what made"
  echo "  the last run unreadable:"
  for _f in $PC_FAIL_INH; do
    echo "    - $_f (8b/10 functional self-test; not re-measured at 10/10, so it still stands)"
  done
  [ -n "$PC_FAIL_NEW" ] && printf '%s' "$PC_FAIL_NEW"
  exit 1
fi
