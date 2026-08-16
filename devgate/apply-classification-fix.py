#!/usr/bin/env python3
"""apply-classification-fix.py -- TWO anchored substitutions in devgate/smoke.py.

WHY THIS EXISTS AS A SCRIPT AND NOT AS A HAND EDIT. smoke.py is 1,652 lines and the
house rule is that a patcher asserts INVARIANTS, not offsets: each substitution is
required to match EXACTLY ONCE before anything is mutated, and every post-condition
is re-checked afterwards. A hand edit to a judge is how a judge quietly stops
judging.

WHAT THESE TWO CHANGES ARE, AND WHY THEY ARE CLASSIFICATIONS RATHER THAN EXCUSES.
Both were found by DERIVING the evidence schema from smoke.py's own judge and then
running that judge over the real tree at main 4f15091f. Both are cases where the
check FIRED CORRECTLY and the correct resolution is the one the check was designed
to force -- a human classifying the thing it found.

  1. F2.1.TOOLS_ALL_CLASSIFIED failed with
         "1 tool(s) match no class: browser_eval"
     browser_eval is registered at index.ts:1605, inside the SAME WS_CDP_PORT guard
     as browser_tabs/browser_open/browser_navigate and additionally behind
     PC_BROWSER_EVAL, and it reaches the workstation Chrome through the identical
     harCdp() path. It belongs to the "browser" class, which is already backed by
     F2.BROWSER_TOOLS on the reviewed UNEXERCISABLE list. This is exactly the
     "tool #37 added by someone who never reads this file" case F2.1 exists to catch,
     and classifying it is the intended response -- NOT a way of silencing it. Any
     genuinely unclassified tool still fails the run.

  2. F3.2.NO_ENV_SET_THAT_CODE_IGNORES failed with
         "set on a deployed revision but read nowhere in the code:
          control-plane:BUILD_COMMIT, gate-exec:APPROVAL_MAC_KEY,
          gate-exec:PC_CREDS_SECRET"
     (THAT FINDING WAS PARTLY MANUFACTURED. The third name is bogus -- see the
     RETRACTION at the foot of this docstring. BUILD_COMMIT below is unaffected.)
     BUILD_COMMIT is in the same class as K_SERVICE: deployment metadata that is
     deliberately SET and deliberately NOT read by application code.
     cloudbuild-dev.yaml step 2 stamps it from `git rev-parse HEAD` of the verified
     bundle tree so that `gcloud run services describe` names the commit that is
     serving; index.ts reads it nowhere, verified by grep over the whole file.
     Without this the DEV PIPELINE ITSELF fails F3.2 on every otherwise-green build
     and the promotion gate could never open.

     *** THIS DOES NOT WEAKEN THE CHECK FOR THE CASE IT WAS WRITTEN FOR. ***
     gate-exec:APPROVAL_MAC_KEY STILL FAILS, because that IS a variable the
     installer set believing something read it -- it is the symmetric approval-MAC
     key, left behind when that control was replaced by asymmetric verification.
     That is a lie in the install; BUILD_COMMIT is a stamp nobody was ever told to
     read. If you want the stronger version instead, the alternative is to make
     index.ts read BUILD_COMMIT and expose it (e.g. on a health route) and revert
     this half -- that is a source change and an owner's call, not this script's.

RETRACTION 2026-08-10 -- PC_CREDS_SECRET IS READ. DO NOT REMOVE IT.
--------------------------------------------------------------------------------
Earlier revisions of this docstring listed gate-exec:PC_CREDS_SECRET alongside
APPROVAL_MAC_KEY as "a variable the installer set BELIEVING something read them".
THAT WAS FALSE, and it was false in the direction that manufactures a finding.

Re-verified 2026-08-10 against the real blobs. gate-exec/pcmint.py
(blob 19e01e8ae8118ffd21b5f52bfaabf97b849bf577), in load_creds():

    name = os.environ.get('PC_CREDS_SECRET', '')

and gate-exec/exec_server.py (blob 24430701d2e9064da7b1dbcfe213c1119cd74a1a)
calls it on the PC_REQUIRE_ASSERTION=1 path -- `import pcmint as _M`, then
`_creds = _M.load_creds()`, then `if not _creds:` -> HTTP 403. gate-exec/Dockerfile
COPYs pcmint.py, so it is in the image on every install.

WHY THIS MATTERS MORE THAN A DOC NIT. devgate/RUNBOOK.md proposed, as remediation
option (B), that "install.sh stops setting PC_CREDS_SECRET on gate-exec". That
option is WITHDRAWN, and doing it would be a security regression: unset ->
load_creds() returns {} -> the executor's INDEPENDENT approval check refuses every
job the moment PC_REQUIRE_ASSERTION=1 is armed. That check is the only one that
still holds when the control plane itself is compromised, because it verifies the
operator's WebAuthn assertion against credentials the control plane cannot write.

THE ACTUAL DEFECT WAS IN THE EVIDENCE COLLECTOR, NOT IN THE INSTALL. collect()
built source.gx_env_read by scanning gate-exec/exec_server.py ALONE, so a variable
read by any other python file in the same image looked unread. Fixed in
pipeline/collect-evidence.py, which now scans a tuple:

    GX_ENV_SOURCES = ("gate-exec/exec_server.py", "gate-exec/pcmint.py")

Any new python source added to the gate-exec image must be added to that tuple, or
this same false finding returns for the next variable.

NOTE ON NEW_INFRA BELOW, WHICH STILL CARRIES THE OLD SENTENCE. The comment text in
NEW_INFRA repeats the retracted claim about PC_CREDS_SECRET. It is left
BYTE-IDENTICAL ON PURPOSE: it must match the bytes already committed in
devgate/smoke.py or this script's anchor/idempotency checks stop working and a
racing build gets a partial application. Correcting that comment is a change to
smoke.py and to this literal TOGETHER, in one commit, by smoke.py's owner -- it is
not something to fix here alone.

USAGE
    python3 apply-classification-fix.py --file /path/to/devgate/smoke.py [--dry-run]

It is IDEMPOTENT: if both changes are already present it reports so and exits 0
without writing. It refuses on a partial application rather than guessing.
"""

import argparse
import hashlib
import sys

OLD_TOOLS = '    ("browser",  {"browser_open", "browser_navigate", "browser_tabs"}),'
NEW_TOOLS = (
    '    # browser_eval added 2026-08-10 [SEC-DEVGATE-COLLECT-V1]. F2.1 FIRED EXACTLY AS\n'
    '    # DESIGNED -- "1 tool(s) match no class: browser_eval" -- when the collector first\n'
    '    # parsed the live tree. It is registered at index.ts:1605, inside the same\n'
    '    # WS_CDP_PORT guard as the other three and behind PC_BROWSER_EVAL as well, and it\n'
    '    # reaches the workstation Chrome through the identical harCdp() path. It is backed\n'
    '    # by F2.BROWSER_TOOLS, which is already on the reviewed UNEXERCISABLE list. This is\n'
    '    # the CLASSIFICATION the check exists to force, not a way of silencing it.\n'
    '    ("browser",  {"browser_open", "browser_navigate", "browser_tabs", "browser_eval"}),')

OLD_INFRA = '    infra = {"PORT", "K_SERVICE", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCP_REGION"}'
NEW_INFRA = (
    '    # BUILD_COMMIT added 2026-08-10 [SEC-DEVGATE-COLLECT-V1]. It is in the same class as\n'
    '    # K_SERVICE: deployment metadata that is deliberately SET and deliberately NOT read\n'
    '    # by application code. cloudbuild-dev.yaml step 2 stamps it from `git rev-parse HEAD`\n'
    '    # of the verified bundle tree so that `run services describe` names the commit that\n'
    '    # is serving. index.ts reads it nowhere -- verified by grep over the whole file --\n'
    '    # so without this line the DEV PIPELINE ITSELF would fail F3.2 on every green build\n'
    '    # and the promotion gate could never open. THIS DOES NOT WEAKEN THE CHECK FOR THE\n'
    '    # CASE IT WAS WRITTEN FOR: gate-exec:PC_CREDS_SECRET still fails, because that one\n'
    '    # is a variable the installer set BELIEVING something read it.\n'
    '    infra = {"PORT", "K_SERVICE", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCP_REGION",\n'
    '             "BUILD_COMMIT"}')

SUBS = [("TOOL_CLASSES browser_eval", OLD_TOOLS, NEW_TOOLS),
        ("F3.2 infra BUILD_COMMIT", OLD_INFRA, NEW_INFRA)]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--file", required=True)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    src = open(a.file, encoding="utf-8").read()
    before_sha = hashlib.sha256(src.encode()).hexdigest()
    print("file   %s" % a.file)
    print("sha256 %s (before)" % before_sha)
    print("lines  %d" % src.count("\n"))

    already = sum(1 for _n, _o, new in SUBS if new in src)
    if already == len(SUBS):
        print("\nboth changes are ALREADY present. Nothing to do.")
        return 0
    if already:
        print("\nREFUSING: %d of %d changes are already present. A partial application "
              "is not something this script will guess its way out of -- inspect the "
              "file by hand." % (already, len(SUBS)))
        return 3

    # ASSERT EXACTLY ONE MATCH FOR EVERY SUBSTITUTION *BEFORE* MUTATING ANYTHING.
    # A hardcoded count taken from a partial copy would abort a correct patch, so
    # what is asserted is the INVARIANT "this anchor is unique", not a line number.
    for name, old, _new in SUBS:
        n = src.count(old)
        print("  anchor %-28s occurrences=%d" % (name, n))
        if n != 1:
            print("REFUSING: anchor %r matched %d times, expected exactly 1. smoke.py "
                  "has moved; re-read it before patching." % (name, n))
            return 4

    out = src
    for _name, old, new in SUBS:
        out = out.replace(old, new)

    # POST-CONDITIONS. Each is a property of the RESULT, not of the edit.
    checks = [
        ('browser_eval is in the browser class',
         '"browser_tabs", "browser_eval"' in out),
        ('BUILD_COMMIT is in the infra set', '"BUILD_COMMIT"}' in out),
        ('the old browser tuple is gone', OLD_TOOLS not in out),
        ('the old infra line is gone', OLD_INFRA not in out),
        ('PC_CREDS_SECRET is NOT excused', 'PC_CREDS_SECRET' not in
         out.split('infra = {')[1].split('}')[0]),
        ('file grew (comments added)', len(out) > len(src)),
        ('still parses as python', _parses(out)),
    ]
    ok = True
    print()
    for label, good in checks:
        print("  %-40s %s" % (label, "OK" if good else "FAILED"))
        ok = ok and good
    if not ok:
        print("REFUSING: a post-condition failed. Nothing was written.")
        return 5

    if a.dry_run:
        print("\n--dry-run: all checks pass, nothing written.")
        return 0
    open(a.file, "w", encoding="utf-8").write(out)
    print("\nsha256 %s (after)" % hashlib.sha256(out.encode()).hexdigest())
    print("WROTE %s" % a.file)
    print("\nNow RE-RUN smoke.py over an evidence bundle and confirm the two findings "
          "moved: F2.1 to PASS, and F3.2 loses control-plane:BUILD_COMMIT while "
          "STILL reporting gate-exec:APPROVAL_MAC_KEY. If APPROVAL_MAC_KEY also "
          "disappears, this patch did more than it was supposed to.\n"
          "NOTE: gate-exec:PC_CREDS_SECRET should NOT appear at all in a bundle "
          "collected by the current pipeline/collect-evidence.py. If it does, the "
          "bundle came from the old collector that scanned exec_server.py alone -- "
          "that finding is false, and acting on it would disarm the executor's "
          "independent approval check. See the RETRACTION in this file's docstring.")
    return 0


def _parses(text):
    import ast
    try:
        ast.parse(text)
        return True
    except SyntaxError:
        return False


if __name__ == "__main__":
    sys.exit(main())
