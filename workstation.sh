#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Paracoding -- create a workstation VM, on its own, long after install.sh finished.
#
#   bash workstation.sh               build it. No question, no flavour, no prompt.
#   bash workstation.sh --project P --region R
#
# WHY THIS EXISTS AS A SEPARATE SCRIPT: install.sh does not build a workstation at all, and
# most people do not want one on day one -- they wanted the MCP server and the git store.
# Coming back later should not mean re-running a 10-step installer over a live deployment.
#
# [WS-LINUX-ONLY-V1] THERE IS ONE FLAVOUR NOW AND IT IS LINUX. The Windows box is REMOVED --
# not deprecated, not hidden behind a flag. OPERATOR MEASUREMENT 2026-08-18, on a real
# corporate install: Cowork does not run on the Windows workstation, so the machine could not
# do the one job it existed for. A Linux VM was used instead and worked. Shipping a choice
# where one arm is known not to work is not optionality, it is a trap with a billing
# consequence -- Windows carried the larger disk of the two.
#
# THE PROMPT IS GONE WITH IT. A question with one possible answer is not a question; it is a
# stop. This script now builds the box when you run it, which is what running it meant.
#
# IT IS STILL SAFE TO RUN TWICE. Re-running when the instance already exists ADOPTS it and
# prints its details rather than failing or replacing it.
#
# AN EXISTING WINDOWS BOX IS NOT ORPHANED BY THIS. uninstall.sh still knows that instance
# name and still removes it, and the adopt path still recognises one and says what it found.
# Removing the name from the teardown sweep is how a machine keeps billing after an operator
# believes they have deleted everything.
#
# Written POSIX-safe on purpose, exactly like install.sh: macOS still ships bash 3.2.
set -u

PC_WS_ARG=""
PROJECT="${PC_PROJECT:-}"
REGION="${PC_REGION:-}"
pc_usage() {
  echo "usage: bash workstation.sh [--project PROJECT_ID] [--region REGION] [none|linux]"
  echo "  linux is the default and the only machine this builds; 'none' exits without creating one."
}
while [ $# -gt 0 ]; do
  case "$1" in
    --project)   [ $# -ge 2 ] || { pc_usage >&2; exit 2; }; PROJECT="$2"; shift 2 ;;
    --project=*) PROJECT="${1#--project=}"; shift ;;
    --region)    [ $# -ge 2 ] || { pc_usage >&2; exit 2; }; REGION="$2"; shift 2 ;;
    --region=*)  REGION="${1#--region=}"; shift ;;
    -h|--help)   pc_usage; exit 0 ;;
    none|linux) PC_WS_ARG="$1"; shift ;;
    windows) echo "windows: the Windows workstation was removed in [WS-LINUX-ONLY-V1] -- Cowork does not run on it." >&2
             echo "         Run with no argument to build the Linux box. An existing Windows VM is still removed by uninstall.sh." >&2
             exit 2 ;;
    *) echo "unknown argument: $1" >&2; pc_usage >&2; exit 2 ;;
  esac
done
HERE="$(cd "$(dirname "$0")" && pwd)"

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

  THIS MACHINE STOPS ITSELF AFTER 30 MINUTES IDLE, and it always has -- it is stated here
  because until [WS-WIN-IDLE-V49] nothing said so. /usr/local/bin/ws-idle.sh runs on a systemd timer every 5 minutes from 10 minutes
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
# is created with --no-address, so the ONLY route in is IAP TCP forwarding on 22 for SSH.
# [WS-LINUX-ONLY-V1] There is no longer any RDP path and no rule that opens one: the tcp:3389
# firewall rule lived inside the Windows arm and went with it. The rule above opens the NETWORK
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
# [WS-LINUX-ONLY-V1] ONE PORT AND ONE PROOF COMMAND. This used to default to 3389/RDP and
# override to 22/ssh for the non-Windows arm. With the Windows box removed the RDP default
# was unreachable code that would have printed a tunnel to a port nothing listens on if the
# guard above it ever went wrong -- a wrong instruction dressed as a helpful one, which is
# exactly what the old comment here warned about in the other direction.
PC_IAPT_PORT=22
PC_IAPT_TRY="gcloud compute ssh $WS_VM_NAME --zone $WS_VM_ZONE --project $PROJECT --tunnel-through-iap"
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
# [WS-LINUX-ONLY-V1] Unconditional now. This was wrapped in a non-Windows guard; with one
# kind of workstation the guard could only ever be true, and a condition that cannot be
# false is a reader's trap rather than a control.
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
}

# pc_workstation_create KIND
# Sets WS_VM_NAME and WS_VM_ZONE for the caller. Creates whatever is missing and ADOPTS
# whatever is already there; every prerequisite below (Cloud Router, Cloud NAT, the
# pc-workstation service account and its two IAM bindings, and the IAP-only SSH firewall
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
  # [WS-LINUX-ONLY-V1] The Windows arm is gone; the SUFFIXED NAME IS NOT. -linux stays in the
  # instance name even though it is now the only kind, because renaming it would orphan every
  # box already built: the tools address the VM by name, uninstall sweeps by name, and an
  # install that renames the machine it cannot see leaves a running VM billing forever. A
  # cosmetic suffix costs nothing; a rename costs somebody a hidden instance.
  case "$PC_WS_KIND" in
    linux)   WS_VM_NAME=paracoding-${PC_LP}${PC_TOK}workstation-linux ;;
    windows) die "pc_workstation_create: the Windows workstation was REMOVED in [WS-LINUX-ONLY-V1].
Measured on a real corporate install: Cowork does not run on it, so the machine could not do
the one job it existed for. Nothing here builds one. An existing Windows box is untouched by
this refusal and is still found and removed by uninstall.sh." ;;
    *)       die "pc_workstation_create: unknown kind '"'"'$PC_WS_KIND'"'"' (want linux)" ;;
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
    #   - 10 GB. A desktop environment plus Chrome does not fit. 50 GB pd-balanced below.
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
    # [WS-LINUX-ONLY-V1] EVERYTHING ABOVE THIS LINE IS SHARED SETUP and none of it was
    # Windows-specific: the instance-name lookup, the zone listing, the Cloud NAT + Cloud
    # Router, and the dedicated pc-workstation service account. There is one router
    # (paracoding-nat-router) and one NAT config (paracoding-nat) per region, which is why
    # removing the Windows arm cannot strand a second billed NAT gateway behind it. What
    # follows is the image, the access model and the provisioning script -- previously the
    # only three things that differed between the two, and now simply the only three.
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
# [SEC-CDP-TOKEN-SECRET-V1] TWO SOURCES, AND METADATA IS STILL NOT ONE OF THEM.
# The original rule here was "minted on the box and never transported", and its reason
# stands unchanged: instance metadata is returned IN FULL by compute.instances.get to
# anybody holding roles/compute.viewer, so a token there is a token handed to every
# reader in the project. Nothing below puts it in metadata -- metadata carries only the
# NAME of a secret.
# WHAT CHANGED AND WHY. The console has to hold this token now: the MCP browser tools
# call the bridge, so both ends need the same value, and "the operator reads it over a
# tunnel and pastes it" is a manual step that scales to nobody. So when install.sh has
# provisioned a Secret Manager secret and named it in pc-cdp-secret, the box reads the
# value from there. That is a transport, and it is an auditable one with its own IAM on
# a single secret, which is a different thing from broadcasting it to every project
# viewer. When no secret is named -- workstation.sh run on its own -- the old behaviour
# is exactly preserved: mint locally, never transport, operator reads it over the tunnel.
PC_CDP_SECRET=$(pc_ws_meta pc-cdp-secret 2>/dev/null || true)
if [ ! -s /opt/cdp-token ] && [ -n "$PC_CDP_SECRET" ]; then
  install -m 0640 -o root -g pc-cdp /dev/null /opt/cdp-token
  if gcloud secrets versions access latest --secret="$PC_CDP_SECRET" \
       > /opt/cdp-token 2>/dev/null && [ -s /opt/cdp-token ]; then
    chown root:pc-cdp /opt/cdp-token
    chmod 0640 /opt/cdp-token
    echo "read /opt/cdp-token from Secret Manager secret $PC_CDP_SECRET (root:pc-cdp 0640)."
  else
    # A FAILED FETCH MUST NOT LEAVE AN EMPTY TOKEN FILE. An empty file is not "no token",
    # it is a token of zero length that a constant-time compare could be asked about, and
    # the bridge would start holding it. Remove it and fall through to the local mint, so
    # the box ends up with a STRONG token that the console does not know rather than a
    # weak one that it does.
    rm -f /opt/cdp-token
    echo "could not read secret $PC_CDP_SECRET; falling back to a locally minted token."
  fi
fi
if [ ! -s /opt/cdp-token ]; then
  install -m 0640 -o root -g pc-cdp /dev/null /opt/cdp-token
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /opt/cdp-token
  chown root:pc-cdp /opt/cdp-token
  chmod 0640 /opt/cdp-token
  echo "minted /opt/cdp-token (root:pc-cdp 0640). It is NOT in instance metadata."
else
  echo "/opt/cdp-token already present, left alone"
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
# [SEC-CDP-NIC0-GATED-V1] LOOPBACK IS STILL THE DEFAULT AND STILL THE ANSWER WHEN
# NOTHING SAYS OTHERWISE. What changed is that the DENY rule the paragraph above
# calls for can now actually exist: install.sh step 9/10 creates a target-tagged
# DENY on tcp:8025 at priority 900 and an ALLOW at 800 whose SOURCE TAG is carried
# by the MCP service's Direct VPC egress. Where that pair is present, nic0 is
# reachable by the control plane and by nothing else, which is exactly the condition
# the loopback bind was standing in for.
#
# THE INSTALLER MEASURES; THIS FILE ONLY READS. The bridge's service account holds no
# compute permission, so it cannot check a firewall rule itself and does not pretend
# to. install.sh creates BOTH rules, reads BOTH back, and only then writes the
# instance metadata key below. So this value is a RECORD OF A MEASUREMENT taken by
# something that could take it, not a preference someone set.
#
# WHY THIS IS NOT THE ENVIRONMENT OVERRIDE THE OLD COMMENT REFUSED. That refusal was
# right and still is: an override is a slower way to get 0.0.0.0 back. This accepts
# exactly ONE literal, 'nic0', and resolves the address itself from the metadata
# server -- there is no spelling of this key that produces 0.0.0.0, a chosen
# interface, or any address the caller supplies. Anything else, absent, unreadable,
# or an nic0 lookup that fails, falls back to loopback and says which and why. It is
# also not writable by the thing loopback defends against: a page inside Chrome
# cannot set instance metadata.
def _pc_meta(key):
    try:
        rq = urllib.request.Request(
            'http://metadata.google.internal/computeMetadata/v1/' + key,
            headers={'Metadata-Flavor': 'Google'})
        with urllib.request.urlopen(rq, timeout=3) as r:
            return r.read().decode('utf-8', 'replace').strip()
    except Exception:
        return ''


def _pc_bind_host():
    want = _pc_meta('instance/attributes/pc-cdp-bind')
    if want != 'nic0':
        if want:
            sys.stderr.write('[cdp-bridge] pc-cdp-bind=%r is not the one accepted value '
                             "'nic0'; binding loopback\n" % want[:32])
        return '127.0.0.1'
    ip = _pc_meta('instance/network-interfaces/0/ip')
    if not ip:
        sys.stderr.write('[cdp-bridge] pc-cdp-bind=nic0 but nic0 has no address from the '
                         'metadata server; binding loopback\n')
        return '127.0.0.1'
    sys.stderr.write('[cdp-bridge] binding nic0 %s -- install.sh recorded that the '
                     'tcp:8025 DENY/ALLOW pair is in place\n' % ip)
    return ip


BIND_HOST = _pc_bind_host()


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
    # [WS-DISK-COST-V1] 100GB pd-balanced -> 50GB, AND THE REASON IS THE STANDING BILL.
    # A STOPPED instance still bills for its disk, every month, whether or not anyone ever
    # starts it -- so the boot disk is the one number on this command that costs money while
    # nothing is happening. At us-east1 list, pd-balanced is about $0.10/GB/month: the old
    # 100GB was roughly $10/month standing, this is roughly $5. The image plus XFCE, Chrome
    # and the Claude desktop app lands well under 20GB, so 50 is headroom rather than a
    # squeeze, and a boot disk can be grown later without recreating the instance -- it
    # cannot be shrunk, which is the asymmetry that makes the smaller default the right one.
    # PC_WS_DISK_GB overrides it for anyone who wants the old size back.
    PC_WS_DISK_GB="${PC_WS_DISK_GB:-50}"
    # [SEC-CDP-NIC0-GATED-V1] A NETWORK TAG, because a firewall rule cannot name an instance.
    # The tcp:8025 DENY/ALLOW pair install.sh creates is target-tagged, and this is the tag it
    # targets. It is set at create time rather than added later so there is never a window in
    # which the box is up and the DENY does not apply to it.
    PC_WS_NETTAG="pc-${PC_LP}${PC_TOK}cdp-host"
    PC_WS_NETTAG=$(printf '%s' "$PC_WS_NETTAG" | tr -cd '"'"'[:alnum:]-'"'"')
    # [SEC-CDP-TOKEN-SECRET-V1] SCOPES WIDEN TO cloud-platform AND THE AUTHORITY DOES NOT.
    # The box needs to read one Secret Manager secret. There is no per-API scope for Secret
    # Manager -- it is reachable only under cloud-platform -- so the narrow-looking triple
    # that was here could not express "and this one secret". A SCOPE IS A CEILING, NOT A
    # GRANT: what this VM can actually do is decided by the IAM held by $WS_SA, which is
    # logging writer, monitoring writer, and secretAccessor ON A SINGLE SECRET. Google's own
    # current guidance is exactly this -- cloud-platform plus a least-privilege service
    # account -- because the legacy scope list silently blocks calls in ways that read as
    # permission bugs. The old triple is what made devstorage.read_only look like a control;
    # it was a ceiling too.
    retry gcloud compute instances create "$WS_VM_NAME" --project "$PROJECT" \
      --zone "$WS_VM_ZONE" --machine-type e2-standard-4 \
      --image-family "$WS_IMG_FAMILY" --image-project ubuntu-os-cloud \
      --boot-disk-size "${PC_WS_DISK_GB}GB" --boot-disk-type pd-balanced \
      --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
      --metadata enable-oslogin=TRUE,pc-claude-ext-id="$PC_WS_EXT_ID",pc-claude-apt-repo="$PC_WS_CLAUDE_APT_REPO",pc-claude-apt-key="$PC_WS_CLAUDE_APT_KEY",pc-claude-apt-fpr="$PC_WS_CLAUDE_APT_FPR" \
      --metadata-from-file startup-script="$HERE/.ws-startup.sh" \
      --service-account "$WS_SA" \
      --tags "$PC_WS_NETTAG" \
      --scopes https://www.googleapis.com/auth/cloud-platform \
      $PC_WS_NET_FLAG \
      --quiet >/dev/null || PC_VMC_RC=$?
    gcloud compute instances describe "$WS_VM_NAME" --zone "$WS_VM_ZONE" --project "$PROJECT" \
      >/dev/null 2>&1 \
      || die "the workstation VM $WS_VM_NAME is still absent in $WS_VM_ZONE after a create
attempt (exit $PC_VMC_RC). The describe is the authority here, not the create status, because a
concurrent run makes create a 409 and that is success for our purposes."
    rm -f "$HERE/.ws-startup.sh"
    echo "  created $WS_VM_NAME in $WS_VM_ZONE ($WS_IMG_FAMILY, e2-standard-4,"
    echo "  ${PC_WS_DISK_GB} GB pd-balanced, Shielded VM, service account $WS_SA)"
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
  # ONE CALL SITE, AND IT DOMINATES BOTH PATHS ABOVE -- adopt and create
  # create. An ADOPTED instance needs this exactly as much as a new one: the binding lives on
  # the tunnel resource, not on the image, so a VM somebody else created is unreachable for
  # the same reason. Everything in it is describe-first / read-modify-write, so a second run
  # of this function costs two API calls and changes nothing.
  pc_ws_grant_access "$PC_WS_KIND"
}

command -v gcloud >/dev/null || die "gcloud not found. This script only talks to Google Cloud;
without gcloud there is nothing it can do."

# NOTHING THE MAIN INSTALL ALREADY KNOWS IS ASKED FOR AGAIN. The project comes from the
# gcloud config the installer was run under, and the region from gcloud's compute/region if
# one is set. Both can be overridden with a flag or an environment variable, and the project
# -- and only the project -- is PROMPTED FOR if it genuinely cannot be derived, because
# there is no safe default for "which of your Google Cloud projects".
if [ -z "$PROJECT" ]; then
  PROJECT=$(gcloud config get-value project 2>/dev/null | sed -n '1p' | tr -d '[:space:]')
  case "$PROJECT" in ""|"(unset)"|None|none) PROJECT="" ;; esac
  [ -n "$PROJECT" ] && echo "  project: $PROJECT (from gcloud config; override with --project)"
fi
while [ -z "$PROJECT" ]; do
  echo "  gcloud has no project configured and none was given."
  pc_drain_stdin
  printf '%s' '  Google Cloud project id: '
  read -r PROJECT < "$PC_TTY" 2>/dev/null || die "end of input, and there is no safe default
for which of your Google Cloud projects to build a VM in. Re-run with --project PROJECT_ID."
  PROJECT=$(printf '%s' "$PROJECT" | tr -d '[:space:]')
done
if [ -z "$REGION" ]; then
  REGION=$(gcloud config get-value compute/region 2>/dev/null | sed -n '1p' | tr -d '[:space:]')
  case "$REGION" in ""|"(unset)"|None|none) REGION="" ;; esac
  if [ -n "$REGION" ]; then
    echo "  region:  $REGION (from gcloud config compute/region; override with --region)"
  else
    # install.sh's own default when no region argument is given. Same value, deliberately,
    # so a workstation built later lands where the install did.
    REGION=us-east1
    echo "  region:  $REGION (install.sh's default; override with --region)"
  fi
fi
# The ZONE is never composed from the region -- pc_workstation_create LISTS the zones that
# are UP in $REGION and takes the first, because us-east1 has b, c and d and no a at all.

PC_WS_KIND="${PC_WS_ARG:-${PC_WS_KIND:-linux}}"
case "$PC_WS_KIND" in
  none|linux) : ;;
  *)  echo "unknown argument: $PC_WS_KIND (want none or linux)" >&2; exit 2 ;;
esac
# [WS-LINUX-ONLY-V1] NO PROMPT. There used to be a three-way question here whose default was
# `none` -- so the ordinary case was: run the script, read a screen of comparison text, and
# get nothing. That was defensible while there were two machines to choose between and one of
# them could bill you a 150 GB disk by accident. There is one machine now, so the question has
# one answer, and asking it would only be a way to fail to build the thing you asked for.
#
# `none` is KEPT as an explicit argument, not as a default. It is what a script passes to say
# "check my flags and my project resolution but create nothing", and dropping it would break
# any caller already doing that.
echo
echo "  Building the Linux workstation: Ubuntu LTS + XFCE + Chrome Remote Desktop."
echo "  No inbound port is opened and the box gets no public address. Chrome Remote Desktop"
echo "  needs a one-time registration code, which this script prints when it is done."
echo "  IT STOPS ITSELF AFTER 30 MINUTES IDLE -- a systemd timer, 6 consecutive quiet checks."
echo "  Hold it up for an unattended job with  sudo touch /run/ws-busy."
echo "  An idle-stop is not a spend cap: a STOPPED instance still bills for its 50 GB boot"
echo "  disk -- roughly \$5/month at list. That is the standing cost of having one at all."
echo
if [ "$PC_WS_KIND" = none ]; then
  echo "  none: nothing created, nothing billed. Re-run this script with no argument when you want one."
  exit 0
fi

# [SEC-INSTALL-TOKEN-V1] RECOVER THE INSTALL TOKEN BEFORE COMPOSING ANY NAME. This script
# runs long after install.sh did. A tokenized install's instance names carry the token as
# an infix right after the lane prefix, and composing without it would CREATE A SECOND
# BILLED VM beside the one the tools drive. The record is the pc-suffix label on the
# marker secret. PC_SUFFIX=<6 hex> in the environment overrides it; a marker that is
# absent, or that predates the token, means the unsuffixed legacy names; a describe that
# fails for any OTHER reason REFUSES, because could-not-read is not the same as legacy.
PC_MARK_SEC="pc-${PC_LP}install-marker"
if [ -n "${PC_SUFFIX:-}" ]; then
  case "$PC_SUFFIX" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) PC_TOK="${PC_SUFFIX}-"; echo "  install token: $PC_SUFFIX (from PC_SUFFIX in the environment)" ;;
    *) die "PC_SUFFIX must be exactly 6 lowercase hex characters, got: $PC_SUFFIX" ;;
  esac
else
  PC_TOK_OUT=$(gcloud secrets describe "$PC_MARK_SEC" --project "$PROJECT" --format='value(labels.pc-suffix)' 2>&1); PC_TOK_RC=$?
  if [ "$PC_TOK_RC" -eq 0 ]; then
    PC_TOK_LBL=$(printf '%s' "$PC_TOK_OUT" | tr -d '[:space:]')
    case "$PC_TOK_LBL" in
      "") PC_TOK="" ;;
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) PC_TOK="${PC_TOK_LBL}-"; echo "  install token: $PC_TOK_LBL (from the marker's pc-suffix label)" ;;
      *) die "the pc-suffix label on $PC_MARK_SEC is not 6 lowercase hex. Refusing to compose
an instance name from it. Read it yourself:
    gcloud secrets describe $PC_MARK_SEC --project $PROJECT --format='value(labels.pc-suffix)'" ;;
    esac
  elif printf '%s' "$PC_TOK_OUT" | grep -qiE 'not found|404|NOT_FOUND|does not exist'; then
    PC_TOK=""
  else
    die "could not read the marker secret $PC_MARK_SEC (describe exited $PC_TOK_RC), so this
script cannot tell whether this install's names carry a token. Refusing to guess, because a
wrong guess builds a SECOND billed VM. Fix the describe and re-run, or state the token
yourself with PC_SUFFIX=<6 hex> (it is the pc-suffix label on that secret)."
  fi
fi

say "workstation ($PC_WS_KIND) in $PROJECT / $REGION"
pc_workstation_create "$PC_WS_KIND"
# [GCP-WS-OPTIONAL-NOT-FATAL-V76] THE SAME REFUSAL IS FATAL *HERE* AND NOT IN install.sh, AND
# THE ASYMMETRY IS THE WHOLE POINT. In the installer the workstation is one optional component
# among ten steps, so a refusal degrades to `none` and the install finishes. THIS script exists
# for no other purpose than creating that machine: a refusal means it did nothing it was run to
# do, and reporting success would be a lie. It also cannot simply fall through -- WS_VM_NAME and
# WS_VM_ZONE are never assigned on the refused path, and the next line reads both.
if [ "${PC_WS_REFUSED:-0}" = 1 ]; then
  die "no workstation was created -- see the refusal above. Nothing was changed in $PROJECT by
this run. Fix the network (a Cloud NAT in $REGION) and run this again, or choose the linux
flavour, which can safely take an external IP because OS Login refuses password and key SSH."
fi
echo
echo "  WS_VM=$WS_VM_NAME  WS_ZONE=$WS_VM_ZONE"
echo
echo "  THE vm_* TOOLS POINT AT ONE MACHINE AT A TIME, and install.sh set that at 6/10 on"
echo "  BOTH of its services. THE vm_* TOOLS ARE MCP TOOLS: they are served by the MCP"
echo "  service, so re-pointing only the console leaves them driving the old machine. If"
echo "  you want them to act on THIS one, re-point BOTH -- these are the two service names"
echo "  install.sh creates; use yours if you renamed them:"
echo "    gcloud run services update paracoding-${PC_LP}${PC_TOK}mcp --region $REGION --project $PROJECT --update-env-vars WS_VM=$WS_VM_NAME,WS_ZONE=$WS_VM_ZONE"
echo "    gcloud run services update paracoding-${PC_LP}${PC_TOK}control-plane --region $REGION --project $PROJECT --update-env-vars WS_VM=$WS_VM_NAME,WS_ZONE=$WS_VM_ZONE"
echo "  The MCP one is the line that makes the tools move. The console carries the same"
echo "  pair so the two surfaces do not disagree about which machine this install owns."
echo "  (Running this script for BOTH flavours is supported and leaves both VMs in place;"
echo "  only one of them can be the WS_VM the tools drive.)"
