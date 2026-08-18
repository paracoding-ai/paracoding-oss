#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""lockout-check.py -- the second way in, enforced by machine. [GCP-LOCKOUT-CHECK-V1]

deploy/LOCKOUT-CLASS.md names nine categories of change that DESTROY THE WAY BACK IN.
This file is that document's enforcement arm. It runs in two places:

  pre-push      over the diff of any commit touching control-plane/src/index.ts,
                gen.py's INSTALL literal, or pipeline/.
  pre-execute   over EVERY job body before execution, once the approval click is gone.

THE POINT OF THIS FILE IS TO KEEP THE CONTROLS WHILE DROPPING THE TAP.
Removing the human approval click does not weaken the class; it moves the class
from "a human reads every job" to "this checker reads every job, and only the nine
named categories reach a human". A refused job is ROUTED TO THE HUMAN PATH --
the second way in -- and is NEVER silently dropped. There is no `|| true` here and
there must never be one: a checker that fails open is a checker that is not there.

REFUSAL IS BY RULE ID, NOT BY VIBE. Each rule returns its own id so a refusal can be
argued with, tested, and -- when a rule is wrong -- corrected in one place. `--self-test`
drives 15 seeded bodies through the same entrypoint the executor calls: 9 that MUST be
refused by a NAMED rule, and 6 promotion-shaped bodies that MUST pass clean. A rule that
cannot refuse has not been shown to work, and a checker that refuses everything is a
different broken, not a working one -- so both directions are asserted.

Exit codes are the contract:
    0   the body is clean; the executor may run it without a human
    51  REFUSED -- at least one lockout rule matched; route to the human path
    2   called wrong (no body supplied)
    3   the self-test itself failed -- trust nothing this file says until it passes
"""

import argparse
import json
import os
import re
import sys

# ---------------------------------------------------------------------------
# THE NAMES COME FROM THE ENVIRONMENT, NOT FROM THIS FILE, AND THAT IS TWO FIXES AT ONCE.
#
# (1) ADOPTERS. A checker hardwired to one operator's service names protects that operator
#     and nobody else. Every install names its own surfaces, so the class is a SHAPE and the
#     names are CONFIGURATION. The installer writes these; this file reads them.
# (2) THE LEAK GATE. Spelling the operator's instance names here put five region literals
#     and six project-id literals into the repository and the cut REFUSED over this file.
#     The standing rule is remove the reference, never raise the ceiling.
#
# EMPTY IS NOT "ALLOW EVERYTHING". Each rule below states what it does when its list is
# unset, and none of them degrades to silence: the verb-based rules (secrets, kms, identity
# writes, env clobber, domain mappings, assertion, signer) do not need install-specific
# names at all and stay fully armed with no configuration whatsoever. Only LC1, which must
# know which service names are legitimate, needs the list -- and it says so out loud rather
# than passing quietly.
def _envlist(name):
    # SPLIT ON WHITESPACE AS WELL AS COMMAS, AND THAT IS NOT COSMETIC. `gcloud run deploy
    # --set-env-vars` is itself COMMA-DELIMITED, so a comma-separated value written the
    # obvious way is parsed by gcloud as three separate variables and the list arrives
    # truncated to its first element -- silently, because the remaining fragments look like
    # malformed assignments rather than an error. The installer therefore writes these
    # space-separated, and both forms are accepted here so a hand-configured install using
    # commas outside that context still works.
    return tuple(x for x in re.split(r"[,\s]+", os.environ.get(name, "").strip()) if x)

CP_SVC = os.environ.get("PC_LOCKOUT_CP_SVC", "")
MC_SVC = os.environ.get("PC_LOCKOUT_MC_SVC", "")
AUTH_SERVICES = tuple(x for x in (CP_SVC, MC_SVC) if x)

# Every Cloud Run service this install knowingly operates. A `run deploy` naming anything
# OUTSIDE this list is a service-rename shape (class 1/2) -- because on Cloud Run, deploying
# a name that does not exist CREATES it, and the console rename that follows is credential
# destruction, not a rename.
KNOWN_PROD_SERVICES = _envlist("PC_LOCKOUT_SERVICES") or AUTH_SERVICES

# Class 4. Defaults are the GENERIC names the installer creates. An install that renamed
# them sets PC_LOCKOUT_SECRETS. Note the deliberate prod/generator split some installs
# carry (an approval secret named without the pc- prefix): list BOTH spellings there, so a
# job written from generator names against prod is REFUSED rather than quietly wrong.
AUTH_SECRETS = _envlist("PC_LOCKOUT_SECRETS") or (
    "pc-session-secret",
    "pc-human-confirm-secret",
    "pc-webauthn-creds",
    "approval-mac-key",
    "pc-approval-mac-key",
)

# Class 5 + the lockout-ADJACENT vault keys. Destroying a version while
# APPROVAL_REQUIRE_SIGNED=1 makes every job unverifiable -> 403 -> not even the
# undo can run. The vault keyring is data-irreversible rather than lockout, but
# it gets identical handling: a human decides.
KMS_KEYRINGS = _envlist("PC_LOCKOUT_KEYRINGS") or ("approvals", "vault")

# Class 8. Server-side identity resolution for every chat. A bad write here
# changes WHO THE FLEET IS, and the measured fail-open (a row with no `exp` never
# expires) means a bad row can only be removed, never aged out.
IDENTITY_COLLECTIONS = ("strains", "session_keys")

# Class 6. The signer cannot be repaired from the console: APPROVAL_REQUIRE_SIGNED=0
# fixes the VERIFIER, not the SIGNER. Config first, code last.
SIGNER_TOKENS = (
    "APPROVAL_SIG_KEY_VERSION",
    "APPROVAL_SIG_KEY_VERSIONS",
    "APPROVAL_REQUIRE_SIGNED",
)

# Class 3. One bearer serves every chat; breaking it locks out every session at once.
OAUTH_TOKENS = (
    "mcp-oauth",
    "MCP_OAUTH",
    "OAUTH_CLIENT_ID",
    "oauth-client-secret",
)


def _norm(body):
    """Accept a shell string or a JSON job object and return one searchable string.

    The executor hands us whatever it is about to run. A dict is flattened rather
    than key-picked, because a rule that only inspects `command` is blind to the
    same token arriving via `args` or `env` -- and this checker is the last reader
    before execution.
    """
    if isinstance(body, (dict, list)):
        return json.dumps(body)
    return str(body)


# ---------------------------------------------------------------------------
# THE RULES. Each takes the normalised text and returns a reason string or None.
# Each is deliberately narrow: LOCKOUT-CLASS.md's closing line warns that a list
# which grows into "everything scary" becomes the rubber stamp again.
# ---------------------------------------------------------------------------

def rule_LC1_service_rename(t):
    """Class 1/2: a `run deploy` naming a service outside the known list.

    UNCONFIGURED IS A REFUSAL, NOT A PASS. With no known-service list there is no way to
    tell a deploy of an existing surface from one that CREATES a new name, and on Cloud Run
    deploying a name that does not exist creates it. Saying nothing here would be the
    checker's one silent failure mode, so it names the variable to set instead."""
    for m in re.finditer(r"run\s+deploy\s+([A-Za-z0-9][A-Za-z0-9_-]*)", t):
        name = m.group(1)
        if name.startswith("-"):
            continue
        if not KNOWN_PROD_SERVICES:
            return ("run deploy cannot be judged: no known-service list is configured. Set "
                    "PC_LOCKOUT_SERVICES to the comma-separated services this install operates")
        if name not in KNOWN_PROD_SERVICES:
            return "run deploy names '%s', which is not a known service -- this is a service-rename/create shape" % name
    return None


def rule_LC2_domain_mapping(t):
    """Class 2: the domain mapping is the operator's own control channel."""
    if re.search(r"domain[-_]mappings?", t):
        return "touches domain mappings -- severs the operator's own control channel"
    return None


def rule_LC3_oauth(t):
    """Class 3: the account-level bearer and MCP OAuth material."""
    for tok in OAUTH_TOKENS:
        if tok in t and re.search(r"(delete|destroy|update|create|add|set|replace)", t, re.I):
            return "mutates OAuth material (%s) -- one bearer serves every chat" % tok
    return None


def rule_LC4_auth_secrets(t):
    """Class 4: deleting/destroying/rotating any of the four auth-path secrets."""
    if not re.search(r"secrets?\s+(delete|update|create)|versions\s+(destroy|disable|add)", t):
        return None
    for s in AUTH_SECRETS:
        if re.search(r"(?<![A-Za-z0-9_-])%s(?![A-Za-z0-9_-])" % re.escape(s), t):
            return "mutates auth-path secret '%s' without a rehearsed migration" % s
    return None


def rule_LC5_kms(t):
    """Class 5 + adjacent: any kms mutation under the approval or vault keyrings."""
    if "kms" not in t:
        return None
    # `gcloud kms keys versions destroy ...` puts THREE words between `kms` and the
    # verb. An earlier form of this pattern allowed only one and therefore could not
    # refuse the single most dangerous body in the class -- caught by --self-test,
    # which is the entire reason the seeded cases assert by rule id.
    if not re.search(r"kms\s+(?:[a-z-]+\s+){0,3}(destroy|disable|delete|update|create|rotate|add)", t):
        return None
    for kr in KMS_KEYRINGS:
        if kr in t:
            return "kms mutation under keyring '%s' -- can make every job unverifiable, including the undo" % kr
    return None


def rule_LC6_signer(t):
    """Class 6: removing or re-pointing a variable the SIGNER reads."""
    for tok in SIGNER_TOKENS:
        if tok in t and re.search(r"(--set-env-vars|--remove-env-vars|--update-env-vars|unset|delete)", t):
            return "changes signer config token '%s' -- the signing path cannot be repaired from the console" % tok
    return None


def rule_LC7_require_assertion(t):
    """Class 7: arming PC_REQUIRE_ASSERTION with empty enrolment refuses every approval."""
    if "PC_REQUIRE_ASSERTION" in t:
        return "sets PC_REQUIRE_ASSERTION -- a one-way door until a credential is enrolled and the round trip is proven"
    return None


def rule_LC8_identity_writes(t):
    """Class 8: writes to the Firestore collections that decide who the fleet is."""
    if not re.search(r"firestore|documents|collection", t, re.I):
        return None
    for c in IDENTITY_COLLECTIONS:
        if re.search(r"(?<![A-Za-z0-9_-])%s(?![A-Za-z0-9_-])" % re.escape(c), t) and \
           re.search(r"(write|set|update|create|delete|patch|POST|PATCH|DELETE)", t):
            return "writes Firestore collection '%s' -- this changes WHO THE FLEET IS" % c
    return None


def rule_LC9_env_clobber(t):
    """Class 9: --set-env-vars / --set-secrets REPLACE the whole set on an auth surface.

    UNCONFIGURED IS A REFUSAL. Without the auth-surface names there is no way to tell a
    --set-* against a scratch service from one against the console, and the second silently
    drops every variable it does not restate."""
    if not re.search(r"--set-(env-vars|secrets)", t):
        return None
    if not AUTH_SERVICES:
        return ("a --set-* form cannot be judged: no auth surfaces are configured. Set "
                "PC_LOCKOUT_CP_SVC and PC_LOCKOUT_MC_SVC")
    for svc in AUTH_SERVICES:
        if svc in t:
            return "uses a --set-* form against auth surface '%s' -- --set-* replaces the whole set, --update-* merges" % svc
    return None


RULES = (
    ("LC1", rule_LC1_service_rename),
    ("LC2", rule_LC2_domain_mapping),
    ("LC3", rule_LC3_oauth),
    ("LC4", rule_LC4_auth_secrets),
    ("LC5", rule_LC5_kms),
    ("LC6", rule_LC6_signer),
    ("LC7", rule_LC7_require_assertion),
    ("LC8", rule_LC8_identity_writes),
    ("LC9", rule_LC9_env_clobber),
)


def check(body):
    """Return a list of (rule_id, reason). Empty list means clean.

    This is the single entrypoint the executor calls and the single entrypoint
    --self-test drives. There is deliberately no second, more forgiving path.
    """
    t = _norm(body)
    return [(rid, reason) for rid, fn in RULES for reason in (fn(t),) if reason]


# ---------------------------------------------------------------------------
# THE SELF-TEST. 9 must-refuse (one per rule, matched BY ID -- not merely
# "something refused") and 6 promotion-shaped must-pass.
# ---------------------------------------------------------------------------

# THE SEEDED BODIES ARE PARAMETERISED ON PURPOSE, AND THAT IS A LEAK-GATE REQUIREMENT
# RATHER THAN A STYLE CHOICE. An earlier version of this file spelled a real region, a
# real 40-hex commit and a real bucket path into these fixtures. The repository leak gate
# counts those as literals wherever they appear -- a test fixture is not exempt -- and the
# cut REFUSED with "NEW CONTAMINATION" over this file alone. The invariant is: remove the
# reference, never raise the ceiling. So the fixtures use shell-variable placeholders,
# which exercise every rule identically because not one of the nine rules matches on a
# region, a commit or a bucket name.
_R = "$REGION"
_P = "$PROJECT"
# NEUTRAL FIXTURE NAMES, FOR THE SAME TWO REASONS THE REAL NAMES LEFT THIS FILE: no
# operator identifiers in the repository, and a self-test that proves the RULES rather than
# one install's spelling. self_test() installs these as the configuration before it runs,
# so the seeded bodies and the rules agree without either naming a real service.
_FIX_CP = "cp-console"
_FIX_MC = "cp-mcp"
_FIX_GX = "gx-exec"

MUST_REFUSE = [
    ("LC1", "gcloud run deploy " + _FIX_CP + "-v2 --region=" + _R + " --project=" + _P),
    ("LC2", "gcloud beta run domain-mappings create --service=" + _FIX_MC + " --domain=mcp.example.invalid"),
    ("LC3", "gcloud secrets delete mcp-oauth --project=" + _P),
    ("LC4", "gcloud secrets versions destroy 3 --secret=pc-webauthn-creds --project=" + _P),
    ("LC5", "gcloud kms keys versions destroy 1 --key=approval-signing --keyring=approvals --location=" + _R),
    ("LC6", "gcloud run services update " + _FIX_GX + " --set-env-vars=APPROVAL_SIG_KEY_VERSIONS=2"),
    ("LC7", "gcloud run services update " + _FIX_GX + " --update-env-vars=PC_REQUIRE_ASSERTION=1"),
    ("LC8", {"method": "PATCH", "url": "https://firestore.googleapis.com/v1/projects/p/databases/d/documents/session_keys/abc"}),
    ("LC9", "gcloud run services update " + _FIX_CP + " --set-secrets=FOO=bar:latest"),
]

MUST_PASS = [
    "gcloud builds submit --no-source --config=pipeline/cloudbuild-prod.yaml --project=" + _P + " --substitutions=_COMMIT=$COMMIT",
    "gcloud run deploy " + _FIX_CP + " --source ./control-plane --region=" + _R + " --no-traffic --project=" + _P,
    "gcloud run services update-traffic " + _FIX_MC + " --to-revisions=" + _FIX_MC + "-00042-abc=100 --region=" + _R,
    "gcloud storage cp /workspace/marker.json gs://$BUCKET/deploys/$STAMP.json",
    "gcloud run services update " + _FIX_CP + " --update-env-vars=PC_ARCHIVE_DATASET=pc_archive --region=" + _R,
    "bash rollback.sh --forward",
]


def self_test():
    # INSTALL THE FIXTURE CONFIGURATION FIRST. The name-based rules read module-level
    # configuration that normally comes from the environment; the self-test supplies its own
    # so it exercises the RULES rather than whatever this host happens to be configured for,
    # and so a machine with no configuration at all still runs a meaningful test.
    global CP_SVC, MC_SVC, AUTH_SERVICES, KNOWN_PROD_SERVICES
    CP_SVC, MC_SVC = _FIX_CP, _FIX_MC
    AUTH_SERVICES = (_FIX_CP, _FIX_MC)
    KNOWN_PROD_SERVICES = (_FIX_CP, _FIX_MC, _FIX_GX)

    failures = []
    print("lockout-check --self-test  (9 must-refuse by rule id, 6 must-pass clean)")
    print("-" * 74)
    for want_id, body in MUST_REFUSE:
        hits = check(body)
        ids = [rid for rid, _ in hits]
        if want_id in ids:
            print("  ok      %s refused: %s" % (want_id, hits[ids.index(want_id)][1][:70]))
        else:
            print("  FAIL    %s NOT refused (got %s) :: %s" % (want_id, ids or "nothing", _norm(body)[:70]))
            failures.append(want_id)
    print("-" * 74)
    for body in MUST_PASS:
        hits = check(body)
        if hits:
            print("  FAIL    clean body refused by %s :: %s" % ([r for r, _ in hits], body[:60]))
            failures.append("clean:" + body[:30])
        else:
            print("  ok      clean: %s" % body[:64])
    print("-" * 74)
    total = len(MUST_REFUSE) + len(MUST_PASS)
    if failures:
        print("SELF-TEST FAILED  %d/%d  failures: %s" % (total - len(failures), total, failures))
        return 3
    print("SELF-TEST PASSED  %d/%d" % (total, total))
    return 0


def main():
    ap = argparse.ArgumentParser(description="Refuse lockout-class job bodies. See deploy/LOCKOUT-CLASS.md.")
    ap.add_argument("--self-test", action="store_true", help="drive the 15 seeded cases and exit")
    ap.add_argument("--body", help="job body as a string; omit to read stdin")
    a = ap.parse_args()

    if a.self_test:
        sys.exit(self_test())

    body = a.body if a.body is not None else sys.stdin.read()
    if not body.strip():
        print("lockout-check: no body supplied", file=sys.stderr)
        sys.exit(2)

    hits = check(body)
    if not hits:
        print("lockout-check: CLEAN")
        sys.exit(0)
    print("lockout-check: REFUSED -- route to the human path, do not drop")
    for rid, reason in hits:
        print("  %s  %s" % (rid, reason))
    sys.exit(51)


if __name__ == "__main__":
    main()
