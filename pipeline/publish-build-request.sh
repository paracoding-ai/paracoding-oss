#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# publish-build-request.sh -- [SEC-CI-EMIT-V1] THE SECOND HALF OF THE PUBLISHER.
#
# ============================================================================
# WHY THIS EXISTS AND WHY IT IS NOT IN git_push
# ============================================================================
# The build request consumed by pipeline/cloudbuild-dev.yaml and
# pipeline/cloudbuild-release-check.yaml is
#
#   {"commit":"<40 hex>","short":"<8 hex>","archive":"<gs:// .bundle>",
#    "sha256":"<64 hex of that bundle>","ref":"refs/heads/main"}
#
# `archive` and `sha256` name a single-commit git BUNDLE that is produced AFTER
# the push that moved main. `git bundle create` is not byte-reproducible, so the
# digest cannot be predicted at push time -- and step 1 of the dev build verifies
# that digest before it will extract anything. A guessed digest is a red build
# that proves nothing about the code.
#
# So the push publishes a REF-MOVED NOTICE and nothing more (see the
# [SEC-CI-EMIT-V1] block in control-plane/src/gittools.ts), and THE BUILD REQUEST
# IS PUBLISHED HERE -- by the only actor that can tell the truth about the
# archive, immediately after it has made one.
#
# THE INVARIANT THIS FILE ENFORCES: a build is never fired against an archive
# that does not exist or whose digest is wrong. It is enforced by OBSERVATION,
# not by trusting the producer: everything below is re-derived from the bytes
# that are actually in the bucket, downloaded again, after the upload.
#
# ============================================================================
# USAGE
# ============================================================================
#   publish-build-request.sh <40-hex-commit>     publish for a published bundle
#   publish-build-request.sh --selftest          prove the refusals, touch nothing
#
# Environment (all have working defaults for this fleet):
#   PC_CI_BUILD_TOPIC   projects/<p>/topics/<t>     where the build request goes
#   PC_CI_TREES         gs://<bucket>/<prefix>      where bundles are published
#   PC_CI_DRYRUN=1      do everything except the publish, and say so
#
# EXIT CODES -- distinct, because "why did it refuse" is the question at 2am:
#   0   PUBLISHED (or DRYRUN)     20  bad or missing argument
#   21  archive object missing    22  digest disagrees with the published bytes
#   23  bundle will not unbundle  24  bundle head is not the requested commit
#   25  sidecar digest missing    26  publish itself failed
#   27  SELFTEST FAILED -- a refusal path did not refuse, so nothing is published
set -uo pipefail

# [SEC-NODEFAULTPROJ-V1] NEITHER OF THESE MAY CARRY A BAKED DEFAULT, AND PARAMETERISING
# THE STRING WOULD NOT HAVE BEEN ENOUGH. Both used to default to a live resource in ONE
# operator's projects -- a Pub/Sub topic and a GCS prefix. A publisher that defaults to
# somebody else's topic does not fail, it SUCCEEDS against the wrong fleet, and the
# operator whose topic it is gets a build request they did not ask for. A rewritten
# default is still a default: the failure mode survives the rename and only the name
# changes. So there is no default. This is the shape src/runner/open-build-window.py
# already uses -- required, unset is fatal, and the message names what to set.
TOPIC="${PC_CI_BUILD_TOPIC:-}"
TREES="${PC_CI_TREES:-}"
# printf, NOT say(). say() is defined FORTY LINES BELOW this guard, so calling it here
# printed five "say: command not found" lines and no instruction -- the exit code was
# right and the ONLY thing that tells the operator what to set was destroyed. A refusal
# that cannot say why is the defect this guard exists to prevent, reintroduced by the
# guard itself. To stderr, because this is a refusal and not output.
if [ -z "$TOPIC" ] || [ -z "$TREES" ]; then
  printf '%s\n' \
    "PC_CI_BUILD_TOPIC and PC_CI_TREES are REQUIRED and have no defaults. Refusing to" \
    "run: this script PUBLISHES a build request and will not guess whose fleet to" \
    "publish into. Set them, e.g." \
    "  PC_CI_BUILD_TOPIC=projects/<your-project>/topics/<your-build-topic>" \
    "  PC_CI_TREES=gs://<your-bucket>/devdeploy/trees" >&2
  exit 20
fi
DRYRUN="${PC_CI_DRYRUN:-0}"
REF="refs/heads/main"

say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------------------
# THE ONE VERIFIER. The real run and the selftest call THIS SAME FUNCTION, which
# is the whole point: a selftest that exercises a copy of the logic proves
# nothing about the logic that runs.
#
#   $1 bundle file on disk   $2 the commit it must carry   $3 the digest it must have
# Prints a reason and returns 22/23/24 on refusal, 0 on proof.
# ---------------------------------------------------------------------------
verify_bundle() {
  vb_file="$1"; vb_oid="$2"; vb_sha="$3"
  vb_have="$(sha256sum "$vb_file" 2>/dev/null | awk '{print $1}')"
  if [ -z "$vb_have" ] || [ "$vb_have" != "$vb_sha" ]; then
    say "  REFUSE 22  digest disagrees: bytes are ${vb_have:-<unreadable>}, expected $vb_sha"
    return 22
  fi
  vb_dir="$(mktemp -d)"
  if ! git init -q -b import "$vb_dir" >/dev/null 2>&1; then
    say "  REFUSE 23  could not create a scratch repository"
    rm -rf "$vb_dir"; return 23
  fi
  if ! git -C "$vb_dir" -c transfer.fsckobjects=true bundle unbundle "$vb_file" \
        > "$vb_dir/heads.txt" 2>"$vb_dir/err.txt"; then
    say "  REFUSE 23  bundle does not unbundle: $(head -2 "$vb_dir/err.txt" | tr '\n' ' ')"
    rm -rf "$vb_dir"; return 23
  fi
  vb_head="$(awk 'NR==1{print $1}' "$vb_dir/heads.txt")"
  if [ "$vb_head" != "$vb_oid" ]; then
    say "  REFUSE 24  bundle advertises head $vb_head, not $vb_oid"
    rm -rf "$vb_dir"; return 24
  fi
  if ! git -C "$vb_dir" checkout -q --detach "$vb_oid" >/dev/null 2>&1; then
    say "  REFUSE 24  bundle does not contain commit $vb_oid"
    rm -rf "$vb_dir"; return 24
  fi
  vb_got="$(git -C "$vb_dir" rev-parse HEAD 2>/dev/null)"
  if [ "$vb_got" != "$vb_oid" ]; then
    say "  REFUSE 24  rev-parse HEAD is $vb_got, not $vb_oid"
    rm -rf "$vb_dir"; return 24
  fi
  if ! git -C "$vb_dir" fsck --no-dangling "$(git -C "$vb_dir" rev-parse 'HEAD^{tree}')" \
        >/dev/null 2>&1; then
    say "  REFUSE 24  tree is incomplete at $vb_oid"
    rm -rf "$vb_dir"; return 24
  fi
  rm -rf "$vb_dir"
  return 0
}

# ---------------------------------------------------------------------------
# THE NEGATIVE CONTROL, AND IT RUNS IN THE SAME JOB AS THE REAL CHECK.
# Three refusal paths, each driven through verify_bundle with a deliberately
# broken artifact built here from scratch. Every one must refuse WITH ITS OWN
# CODE, and the honest control must pass -- a verifier that refuses everything
# is as useless as one that refuses nothing. Pure local git; no network.
# ---------------------------------------------------------------------------
selftest() {
  st_fail=0
  st_dir="$(mktemp -d)"
  ( set -e
    git init -q -b main "$st_dir/src"
    git -C "$st_dir/src" config user.email selftest@invalid
    git -C "$st_dir/src" config user.name selftest
    printf 'selftest\n' > "$st_dir/src/f.txt"
    git -C "$st_dir/src" add f.txt
    GIT_AUTHOR_DATE='2020-01-01T00:00:00Z' GIT_COMMITTER_DATE='2020-01-01T00:00:00Z' \
      git -C "$st_dir/src" commit -q -m selftest
    git -C "$st_dir/src" bundle create "$st_dir/good.bundle" refs/heads/main
  ) >/dev/null 2>&1 || { say "SELFTEST could not build its fixture"; rm -rf "$st_dir"; return 27; }

  st_oid="$(git -C "$st_dir/src" rev-parse HEAD)"
  st_sha="$(sha256sum "$st_dir/good.bundle" | awk '{print $1}')"

  say "  control 0  honest bundle must PASS"
  verify_bundle "$st_dir/good.bundle" "$st_oid" "$st_sha" >/dev/null 2>&1
  st_rc=$?
  if [ "$st_rc" != "0" ]; then say "    NOT PROVEN: honest bundle refused with $st_rc"; st_fail=1
  else say "    ok  rc 0"; fi

  say "  control 1  wrong digest must refuse 22"
  verify_bundle "$st_dir/good.bundle" "$st_oid" \
    "0000000000000000000000000000000000000000000000000000000000000000" >/dev/null 2>&1
  st_rc=$?
  if [ "$st_rc" != "22" ]; then say "    NOT PROVEN: got $st_rc, want 22"; st_fail=1
  else say "    ok  rc 22"; fi

  say "  control 2  tampered bytes must refuse 23"
  cp "$st_dir/good.bundle" "$st_dir/bad.bundle"
  st_n=$(wc -c < "$st_dir/bad.bundle")
  printf 'X' | dd of="$st_dir/bad.bundle" bs=1 seek=$(( st_n - 12 )) conv=notrunc >/dev/null 2>&1
  st_bsha="$(sha256sum "$st_dir/bad.bundle" | awk '{print $1}')"
  verify_bundle "$st_dir/bad.bundle" "$st_oid" "$st_bsha" >/dev/null 2>&1
  st_rc=$?
  if [ "$st_rc" != "23" ]; then say "    NOT PROVEN: got $st_rc, want 23"; st_fail=1
  else say "    ok  rc 23"; fi

  say "  control 3  honest bundle, WRONG COMMIT must refuse 24"
  verify_bundle "$st_dir/good.bundle" \
    "1111111111111111111111111111111111111111" "$st_sha" >/dev/null 2>&1
  st_rc=$?
  if [ "$st_rc" != "24" ]; then say "    NOT PROVEN: got $st_rc, want 24"; st_fail=1
  else say "    ok  rc 24"; fi

  rm -rf "$st_dir"
  [ "$st_fail" = "0" ] && { say "  SELFTEST 4/4 -- the verifier can pass AND can refuse."; return 0; }
  say "  SELFTEST FAILED. Publishing nothing: a verifier that has not been shown to"
  say "  refuse cannot be trusted to have verified anything."
  return 27
}

# ---------------------------------------------------------------------------
main() {
  if [ "${1:-}" = "--selftest" ]; then
    say "=== publish-build-request.sh SELFTEST ==="
    selftest; exit $?
  fi
  COMMIT="${1:-}"
  case "$COMMIT" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) : ;;
    *) say "usage: publish-build-request.sh <40-hex-commit> | --selftest"; exit 20 ;;
  esac
  if [ "${#COMMIT}" != "40" ]; then
    say "commit must be exactly 40 lowercase hex, got ${#COMMIT} characters"; exit 20
  fi

  say "=============================================================="
  say " BUILD REQUEST for $COMMIT"
  say "=============================================================="
  say "  topic    $TOPIC"
  say "  trees    $TREES"

  # THE SELFTEST RUNS FIRST, ON EVERY REAL RUN. Not a flag someone remembers.
  say ""
  say "--- negative control -------------------------------------------------"
  if ! selftest; then exit 27; fi
  say ""

  ARCHIVE="$TREES/fleet-$COMMIT.bundle"
  WORK="$(mktemp -d)"
  say "--- re-download and re-derive ---------------------------------------"
  if ! gcloud storage cp "$ARCHIVE" "$WORK/f.bundle" >/dev/null 2>&1; then
    say "REFUSE 21  no such object: $ARCHIVE"
    say "           The bundle has not been published for this commit. Nothing is"
    say "           fired: a build request naming an archive that does not exist is"
    say "           a red build that proves nothing."
    rm -rf "$WORK"; exit 21
  fi
  if ! gcloud storage cat "$ARCHIVE.sha256" > "$WORK/side.txt" 2>/dev/null; then
    say "REFUSE 25  no published digest sidecar at $ARCHIVE.sha256"
    rm -rf "$WORK"; exit 25
  fi
  WANT="$(tr -dc '0-9a-f' < "$WORK/side.txt" | head -c 64)"
  if [ "${#WANT}" != "64" ]; then
    say "REFUSE 25  the sidecar does not hold a 64-hex digest"
    rm -rf "$WORK"; exit 25
  fi
  say "  archive  $ARCHIVE"
  say "  sidecar  $WANT"

  verify_bundle "$WORK/f.bundle" "$COMMIT" "$WANT"
  VRC=$?
  if [ "$VRC" != "0" ]; then rm -rf "$WORK"; exit $VRC; fi
  say "  VERIFIED the object in the bucket carries commit $COMMIT and hashes to the"
  say "           digest that will be put in the message."
  rm -rf "$WORK"

  MSG="{\"commit\":\"$COMMIT\",\"short\":\"$(printf '%s' "$COMMIT" | cut -c1-8)\",\"archive\":\"$ARCHIVE\",\"sha256\":\"$WANT\",\"ref\":\"$REF\"}"
  say ""
  say "--- the build request ------------------------------------------------"
  say "$MSG"
  if [ "$DRYRUN" = "1" ]; then
    say "PC_CI_DRYRUN=1 -- nothing published. Every check above still ran."
    exit 0
  fi
  if ! gcloud pubsub topics publish "$TOPIC" \
        --message="$MSG" --attribute=origin=publish-build-request.sh; then
    say "REFUSE 26  publish failed. The archive is fine; the message did not go."
    exit 26
  fi
  say "PUBLISHED  $TOPIC"
  exit 0
}

main "$@"
