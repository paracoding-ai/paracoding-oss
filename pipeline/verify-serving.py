#!/usr/bin/env python3
"""
Verify the SERVING revision of Cloud Run services.

This script MUST NEVER read the SERVICE's spec.template and MUST NEVER parse 
the deploy message. A service whose traffic is pinned to tagged revisions keeps 
serving the old revision after a deploy reports success, so the deploy message 
and spec.template are both untrustworthy and only status.traffic filtered to 
percent greater than zero names the serving revision.

Instead, it reads the service's status.traffic filtered to percent > 0 to find 
the actual serving revision. It then reads that specific REVISION's 
status.imageDigest and spec.containers[0].env. Reading a revision's spec is 
correct and safe because a revision is immutable and we explicitly fetched its 
name from the active traffic assignments.

[SEC-PROMOTE-REVNAME-V1] FINDING THE SERVING REVISION IS NOT THE SAME AS FINDING
THE ONE YOU MEANT. This script used to answer "which revision is serving?" and
stop there, and every caller then read the answer as "the revision I just
promoted is serving". Those are different sentences. The digest and the env are
both blind to the difference: a rollback to an earlier revision of the SAME
commit, a second build of that commit, or a console click landing between the
traffic move and this re-read all present a MATCHING status.imageDigest and a
MATCHING BUILD_COMMIT under a DIFFERENT revision name, and the promotion gate
printed PROMOTED and CONFIRMED BY RE-READ over it.

So the caller must now say WHICH revision it means, with --expect-revision, and
this script refuses BY NAME with exit 67 when the serving revision is not that
one. --allow-any-revision is the explicit opt-out, spelled the way
--allow-any-env already is, because an expectation that can be silently omitted
is not an expectation -- that omission IS the defect being fixed.

NOTE WHAT DID NOT CHANGE. The serving revision is still read out of
status.traffic filtered to percent > 0 and out of nothing else. The expected
name is COMPARED against that reading, never substituted for it. Taking the
name from the deploy command's own message, or from status.traffic[0], is the
[SEC-UPGRADE-TRAFFIC0-V1] defect and this change adds no new path to it.

EXIT CODES. 0 pass; 1 an expectation was not met, or an input could not be read;
67 THE SERVING REVISION IS NOT THE ONE THE CALLER NAMED. 67 is kept distinct
because "the deployment looks wrong" and "traffic is on a revision nobody in
this build judged" send the reader to different pages of the runbook. Measured
at this commit before picking it: pipeline/promote-gate.sh owns 0, 50-57, 61 and
63-65; cloudbuild-dev.yaml's promote step owns 58, 59, 60 and 66; the collector
selftest owns 62; and 67 occurs nowhere under pipeline/.
"""

import argparse
import json
import subprocess
import sys


def run_json_command(cmd):
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        print(f"ERROR running {' '.join(cmd)}: {result.stderr}", file=sys.stderr)
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        print(f"ERROR parsing JSON: {e}", file=sys.stderr)
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True)
    parser.add_argument('--region', required=True)
    parser.add_argument('--service', action='append', required=True)
    parser.add_argument('--expect-image', required=True)
    parser.add_argument('--expect-env', action='append', default=[])
    parser.add_argument('--allow-any-env', action='store_true')
    parser.add_argument('--expect-revision')
    parser.add_argument('--allow-any-revision', action='store_true')
    args = parser.parse_args()

    if not args.expect_env and not args.allow_any_env:
        print("FAIL: no expectation supplied", file=sys.stderr)
        return 1

    # [SEC-PROMOTE-REVNAME-V1] THE NAME IS REQUIRED UNLESS IT IS DELIBERATELY WAIVED.
    # Optional-and-silent is what allowed the gate to confirm the wrong revision for
    # as long as it did: every caller already knows the revision it deployed, so a
    # caller that supplies no name is a caller that forgot, not a caller that meant
    # "any". Same shape as the --expect-env / --allow-any-env pair directly above.
    if not args.expect_revision and not args.allow_any_revision:
        print("FAIL: no revision expectation supplied -- pass --expect-revision REVISION "
              "(or --allow-any-revision to waive it deliberately)", file=sys.stderr)
        return 1

    # One name cannot expect two services. Refusing beats quietly testing the name
    # against whichever service happened to be listed first.
    if args.expect_revision and len(args.service) != 1:
        print("FAIL: --expect-revision names ONE revision but %d service(s) were given; "
              "run one service per invocation" % len(args.service), file=sys.stderr)
        return 1

    expect_env_dict = {}
    for env_str in args.expect_env:
        if '=' in env_str:
            key, val = env_str.split('=', 1)
            expect_env_dict[key] = val

    any_failure = False
    rev_mismatch = False

    for svc in args.service:
        # 1. Fetch service info to find serving revision
        svc_cmd = [
            'gcloud', 'run', 'services', 'describe', svc,
            '--project', args.project, '--region', args.region, '--format=json'
        ]
        svc_info = run_json_command(svc_cmd)
        if not svc_info:
            print(f"FAIL: {svc} (could not fetch service info)")
            any_failure = True
            continue

        traffic = svc_info.get('status', {}).get('traffic', [])
        serving_revs = [t for t in traffic if t.get('percent', 0) > 0]
        
        if len(serving_revs) != 1:
            print(f"FAIL: {svc} (expected exactly 1 serving revision with traffic, found {len(serving_revs)})")
            any_failure = True
            continue

        serving_rev_name = serving_revs[0].get('revisionName')
        if not serving_rev_name:
            print(f"FAIL: {svc} (serving revision has no revisionName)")
            any_failure = True
            continue

        # [SEC-PROMOTE-REVNAME-V1] BY NAME, AND AHEAD OF THE DIGEST AND THE ENV.
        # serving_rev_name came out of status.traffic above and out of nothing else;
        # this only asks whether that reading is the revision the caller named. It is
        # checked FIRST because the digest and the env can both match on a revision
        # the caller never meant, so a digest PASS reported ahead of this would be
        # true and misleading at the same time.
        if args.expect_revision and serving_rev_name != args.expect_revision:
            print(f"FAIL: {svc} (expected revision {args.expect_revision} to be serving, "
                  f"but {serving_rev_name} holds the traffic)")
            rev_mismatch = True
            any_failure = True
            continue

        # 2. Fetch revision info to verify digest and env
        rev_cmd = [
            'gcloud', 'run', 'revisions', 'describe', serving_rev_name,
            '--project', args.project, '--region', args.region, '--format=json'
        ]
        rev_info = run_json_command(rev_cmd)
        if not rev_info:
            print(f"FAIL: {svc} (could not fetch serving revision {serving_rev_name})")
            any_failure = True
            continue

        # The digest lives at status.imageDigest
        actual_image = rev_info.get('status', {}).get('imageDigest', '')
        
        if not actual_image:
            print(f"FAIL: {svc} @ {serving_rev_name} (empty status.imageDigest)")
            any_failure = True
            continue
        
        # Verify the digest using exact matching or strict prefix matching
        match = False
        if actual_image == args.expect_image:
            match = True
        elif len(args.expect_image) >= 12 and args.expect_image.startswith('sha256:'):
            if '@sha256:' in actual_image:
                digest_part = 'sha256:' + actual_image.split('@sha256:')[1]
            else:
                digest_part = actual_image
            
            if digest_part.startswith(args.expect_image):
                match = True

        if not match:
            print(f"FAIL: {svc} @ {serving_rev_name} (expected image {args.expect_image}, got {actual_image})")
            any_failure = True
            continue

        # The env lives at spec.containers[0].env
        containers = rev_info.get('spec', {}).get('containers', [])
        if not containers:
            print(f"FAIL: {svc} @ {serving_rev_name} (no containers found in spec)")
            any_failure = True
            continue

        container = containers[0]
        actual_env_list = container.get('env', [])
        actual_env_dict = {e['name']: e.get('value', '') for e in actual_env_list if 'name' in e}
        
        env_match = True
        for k, v in expect_env_dict.items():
            if actual_env_dict.get(k) != v:
                print(f"FAIL: {svc} @ {serving_rev_name} (expected env {k}={v}, got {actual_env_dict.get(k)})")
                env_match = False
                any_failure = True
                break
        
        if not env_match:
            continue

        print(f"PASS: {svc} @ {serving_rev_name}")

    # [SEC-PROMOTE-REVNAME-V1] 67 OUTRANKS 1. When traffic is sitting on a revision
    # the caller did not name, that is the first fact the reader needs; any other
    # complaint in this run is about a revision that should not have been read.
    if rev_mismatch:
        return 67
    return 1 if any_failure else 0


if __name__ == '__main__':
    sys.exit(main())
