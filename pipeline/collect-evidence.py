#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""collect-evidence.py -- the COLLECT half that smoke.py has never had.

smoke.py (devgate/smoke.py) is a PURE JUDGE over an externally-produced
evidence.json. It has no collect() and it does not authenticate to the service.
This file is the missing half. It runs INSIDE AN UNGATED CLOUD BUILD STEP in the
dev project under the build service account's ADC and writes the evidence bundle
smoke.py judges.

    collect_source(tree)  ->  pure text parsing, no cloud, unit-testable
    collect_cloud(args)   ->  ONLY cloud reads, never judges
    main()                ->  merges and writes evidence.json UNCONDITIONALLY

===============================================================================
THE SCHEMA IS DERIVED FROM smoke.py's judge(), FIELD BY FIELD. NOT INVENTED.
===============================================================================
Every key below is read by a named assertion. References are to devgate/smoke.py.

  cp_latest_created        F0        service.latestCreatedRevision
  cp_revision              F0,F1,F3  MUST carry a "template" key -- see rev_wrap()
  gx_revision              F3,F5     same wrapper, same reason
  cp_sa / gx_sa            F5.2      revision.serviceAccount, matched as "serviceAccount:"+x
  source.registered_tools  F2.1      server.registerTool('<name>' call sites -- READ
                                     from the route table's `tools` key, not scanned
                                     here. [SEC-ONE-SCANNER-V3]; OMITTED, never [],
                                     when the table carries no `tools`.
  source.cp_env_read       F3.2      every process.env.X in index.ts
  source.cp_env_no_default F3.1      those with no fallback anywhere
  source.gx_env_read       F3.2      every os.environ read in EVERY gate-exec python
                                     source -- exec_server.py AND pcmint.py. See
                                     scan_env_py(); one-file scanning manufactured a
                                     permanent false finding.
  source.gx_env_sources    --        which files that scan actually read, so the
                                     scope of F3.2's reverse direction is auditable
                                     from the bundle instead of inferred
  source.pc_index_*        F4.1,F4.2 invocations, naive grep hits, and the specs
  bucket_get               F1.2      storage buckets.get           {_http,name,location}
  bucket_perms             F1.3      buckets iam/testPermissions
                                     {permissions:[...] | None, measured:bool,
                                      _http, unmeasured_reason}
                                     permissions is None -- NEVER [] -- when the
                                     answer could not be obtained. See the block
                                     that builds it: an empty list is a MEASURED
                                     DENIAL and must never be manufactured.
  roundtrip                F1.4,F1.5 {path,read_ok,error,sha_written,sha_read,
                                      plaintext_len,stored_size,metadata}
  mcp_roundtrip            F1.MCP    {sha_written,sha_read,write_text} or null
  mcp_tools_list           F2.2      {_http,tools:[names]}  KEYLESS -- and the
                                     token it carries is the INGRESS token, never
                                     the strain-bound one. See two_tokens() below.
  oauth_protected_resource F2.6      {_http,_url,body} -- ONE UNAUTHENTICATED GET
                                     of the url the WWW-Authenticate challenge
                                     NAMED. _url is what was actually fetched, so
                                     the judge can prove the document came from
                                     where the challenge pointed.
  mcp_tools_authed         F2.3      {_http,tools:[names]} -- an AUTHENTICATED
                                     tools/list, i.e. the live tool ROSTER. On
                                     failure the key is PRESENT carrying the real
                                     status and _refused_by, never omitted.
  vm_route_probes          F2.3      {"GET /api/vm/status":{_http}, ...} -- only
                                     routes whose HANDLER was actually reached.
                                     A waGate refusal is NOT a route answer and is
                                     recorded in vm_route_probes_unmeasured.
  vm_instance              F2.3      compute instances.get         {_http,status}
  gitvault_bucket_name/get F2.4      DATA_LAKE_BUCKET || <project>-datalake
  named_secrets            F3.3      {secret_name: bool}
  firestore_indexes        F4.2      [{_collectionGroup,queryScope,state,fields:[...]}]
  kms_key                  F5.1      {_http,purpose,versionTemplate:{algorithm}}
  kms_key_iam              F5.2      {bindings:[{role,members}]}
  surfaces                 F6        {console:{...},mcp:{...}} -- COLLECTED ONLY
                                     WHEN --mcp-service NAMES THE SECOND SURFACE.
                                     Omitted otherwise, which is what makes
                                     _split_evidence() return 'single' and F6 skip
  surfaces.mcp
    .allusers_refusal      F6.7      THE LITERAL gcloud STDERR install.sh 8/10 got
                                     when its allUsers -> roles/run.invoker grant
                                     was REFUSED, read back from the object named
                                     by --invoker-record. NOT INFERRED, and NEVER
                                     derived from an org-policy READ. ABSENT on
                                     every rejection path, and absent is an F6.7
                                     FAIL. See collect_invoker_record().
    .allusers_record       F6.7      that installer record, verbatim
    .allusers_record_channel         why there is, or is not, a refusal above
  routes                   F7,F2.5   {table_source,anchored,tolerant,hidden,map,
                                      unmapped,dead_map_entries,registered,
                                      public_routes}  -- REBUILT FROM
                                      route-audit.mjs's --emit-table OUTPUT, never
                                      scanned here [SEC-ONE-SCANNER-V2]. When no
                                      table was emitted, EVERY key derived from it
                                      is OMITTED and table_source says why. `map`
                                      survives regardless: PC_SURFACE_MAP is parsed
                                      from the source and has no JS counterpart.
  route_baseline           F7        control-plane/route-baseline.json verbatim
  drift / recipe_pin / build_commit  rendered in the report header

WHAT IS DELIBERATELY NOT FAKED. Where smoke.py lists something as UNEXERCISABLE
this file records it as ABSENT rather than inventing a value:
  F5.APPROVAL_ROUNDTRIP      no signature is produced. Nothing is written.
  F1.MCP_WRITE_FILE_HANDLER  mcp_roundtrip is null unless a session key is
                             actually obtained; it is NEVER synthesised.
A null is an honest absence and judge() renders it NOT-EXERCISED or FAIL. A
fabricated value would render as PASS, which is the failure this harness exists
to stop.

AND AN ERROR BODY IS NOT AN EMPTY RESULT SET. jbody() parses whatever came back,
including a 4xx error document, so `jbody(p).get("things", [])` turns a REFUSED
request into a confident empty list. That is the same failure wearing different
clothes -- a fabricated absence rather than a fabricated presence -- and it cost
this harness a permanent false "6 of 6 index(es) absent". Where a probe's status
decides whether the payload means anything, CHECK THE STATUS. See the Firestore
index read in collect_cloud().

===============================================================================
HOW A MACHINE AUTHENTICATES TO THE DEV CONTROL PLANE -- ALL MEASURED 2026-08-10
===============================================================================
LAYER 1 -- IAP. Dev HAS IAP ON (iapEnabled:true on the v2 service; an
  unauthenticated GET /wiki answers 302 to accounts.google.com carrying
  x-goog-iap-generated-response: true). A metadata-server ID token is REFUSED by
  IAP at EVERY audience tried -- base run url, tag run url, the IAP OAuth client
  id, and /projects/<num>/locations/<region>/services/<svc> -- all
  "401 Invalid IAP credentials: Invalid JWT audience."  This is NOT an IAM gap:
  the build SA already holds roles/iap.httpsResourceAccessor on the service.
  So the collector turns IAP OFF for the duration and restores it in a finally.
  DEV ONLY. It does not expose dev: the Cloud Run IAM policy has exactly one
  member (the build SA, roles/run.invoker) and no allUsers, so the invoker check
  remains the only way in, and it held throughout (wrong-audience tokens stayed
  401). THE RESTORE IS PROVED BY RE-READING, NEVER BY AN EXIT CODE.

LAYER 2 -- CLOUD RUN INVOKER. THE AUDIENCE TRAP, and it cost three builds:
      *** THE ID TOKEN AUDIENCE MUST BE THE BASE SERVICE URL, EVEN WHEN THE
          REQUEST GOES TO A REVISION ---TAG URL. ***
      aud=BASE url=BASE -> 200 | aud=BASE url=TAG -> 200  <-- USE THIS
      aud=TAG  url=BASE -> 401 | aud=TAG  url=TAG -> 401
  `gcloud auth print-identity-token --audiences=` silently produces nothing
  usable in a build step. Use the metadata server.

LAYER 3 -- THE APP'S OWN GATE. waSessionOk accepts a verified IAP identity on the
  approver allow-list, and with IAP off there is no IAP assertion to verify, so
  that branch is unreachable by construction. The remaining path is the
  service's OWN session format: gate_session = base64url(json) "."
  base64url(HMAC-SHA256(payload, WA_SESSION_SECRET)) over { u, exp }. Minted
  from Secret Manager. THE SECRET IS NEVER PRINTED AND NEVER ENTERS THE EVIDENCE.

OTHER MEASURED FACTS RELIED ON HERE
  * dev_api CANNOT read Cloud Logging (entries:list is POST-only and refused).
    `gcloud logging read` inside the step is the channel.
  * A `gcloud run deploy --source` log does NOT contain the Dockerfile step
    output. route-audit.mjs / blob-audit.mjs print inside the NESTED image build,
    which is REGIONAL (locations/us-east1/builds) and CLOUD_LOGGING_ONLY; its id
    is on the service at buildConfig.name and it is fetched with
    `gcloud builds log <id> --region=us-east1`.
  * A build that sets logsBucket has a fully readable log.

USAGE
    python3 collect-evidence.py --tree /workspace/work \
        --out /workspace/evidence.json
    python3 collect-evidence.py --tree . --source-only --out /tmp/src.json
        ^ pure parsers only, no cloud, no credentials, no mutation. This is the
          mode the parsers are unit-tested in, and they were: over the real tree
          they reproduce route-baseline.json's committed surface_split EXACTLY --
          84/69/15 audit-visible, PC_SURFACE_MAP 84 entries partitioning 61
          console / 23 mcp / 0 both, zero unmapped, zero dead map entries, zero
          hidden registrations -- and pc_index 6 invocations against 1 naive
          grep hit.
          THE ROUTE HALF OF THAT NOW NEEDS AN EMITTED TABLE [SEC-ONE-SCANNER-V2].
          Point PC_ROUTE_TABLE_JS at one, or accept that every route field is
          reported ABSENT with its reason:
              node control-plane/route-audit.mjs control-plane/src/index.ts \
                   control-plane/route-baseline.json --emit-table=/tmp/rt.json
              PC_ROUTE_TABLE_JS=/tmp/rt.json python3 pipeline/collect-evidence.py \
                   --tree . --source-only --out /tmp/src.json
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
# [CE-NOREDIRECT] urllib.parse is imported for http()'s location_host: a Location
# header may be relative, so the host it resolves to is computed with urljoin+urlsplit
# rather than read off the raw header. Importing the submodule explicitly -- `import
# urllib.error` does NOT bind urllib.parse, and the attribute access would raise at the
# first redirect, which is the one path that had no coverage.
import urllib.parse
import urllib.request

MD = "http://metadata.google.internal/computeMetadata/v1"

# The gate-exec image recipe the devgate harness is pinned to. RUNBOOK.md
# "HOW DRIFT GETS DETECTED": if this blob oid moves, the harness is lying.
RECIPE_PIN_PATH = "gate-exec/Dockerfile"
RECIPE_PIN_OID = "6c2b2c336cf463d64e234d7601ab7cc46e176fb5"

# EVERY PYTHON SOURCE THAT SHIPS IN THE GATE-EXEC IMAGE AND CAN READ THE
# ENVIRONMENT. F3.2's reverse direction -- "the revision SETS a variable the code
# never READS" -- is only as honest as this list is complete. gate-exec/Dockerfile
# COPYs all of these, so all of them are scanned. Removing an entry does not make a
# finding go away; it manufactures one. See scan_env_py().
#
# [CE-GX-ENV-SOURCES] THIS TUPLE NAMED TWO OF THE FOUR FILES THE IMAGE ACTUALLY
# CARRIES, AND scan_env_py()'s OWN DOCSTRING HAD ALREADY WRITTEN DOWN WHY THAT IS THE
# defect THAT MANUFACTURES FINDINGS. Measured in this tree, not recalled:
# gate-exec/Dockerfile COPYs FOUR python sources -- exec_server.py (line 52), the
# executor's assertion verifier (53), pcmint.py (54) and lockout_check.py (58). The
# tuple named two.
#
# WHAT THE MISSING FILE READS, counted with a grep over the real blob:
# gate-exec/lockout_check.py reads PC_LOCKOUT_CP_SVC and PC_LOCKOUT_MC_SVC directly
# at lines 65 and 66, and PC_LOCKOUT_SERVICES, PC_LOCKOUT_SECRETS and
# PC_LOCKOUT_KEYRINGS through the _envlist() wrapper at lines 73, 79 and 91.
# gate-exec/exec_server.py:1603 `import lockout_check as _lc` is the caller, on the
# PC_GUARDRAILS=1 path. So five variables that ARE read were invisible to the scan,
# and F3.2 was free to report every one of them as "set on a deployed revision but
# read nowhere in the code".
#
# ACTING ON THAT FINDING BREAKS THE EXECUTOR, WHICH IS WHY THIS IS NOT COSMETIC.
# lockout_check.py states in its own header that the service-name rule is the one
# rule that NEEDS its list and "says so out loud rather than passing quietly";
# deleting the variables the finding names is exactly the PC_CREDS_SECRET near-miss
# the docstring below already recounts, one rung more expensive. A harness that
# invents a finding teaches its readers to delete things.
#
# DERIVED FROM THE DOCKERFILE, NOT FROM MEMORY. Every `COPY <name>.py` line in
# gate-exec/Dockerfile belongs here. The assertion verifier reads NO environment
# variable today -- grep 'os.environ' over it returns zero hits, measured -- and is listed
# anyway, because the honest scope of the claim is "the python in the image", not
# "the files that looked interesting when someone last checked".
#
# DELIBERATELY NOT DONE: this is not auto-derived by parsing the Dockerfile at run
# time. RECIPE_PIN_OID above hashes that same Dockerfile and the result is printed in
# the report as MATCHED or DRIFTED, so a COPY line added without a matching entry here
# shows up as drift a human reads. That is weaker than an assertion and is stated as
# what it is: smoke.py:2962 PRINTS recipe_pin and no finding asserts it. A scanner
# that read its own scope out of the file it is also policing would make even that
# much invisible, so the list stays literal and reviewed.
GX_ENV_SOURCES = ("gate-exec/exec_server.py", "gate-exec/pcwebauthn.py",
                  "gate-exec/pcmint.py", "gate-exec/lockout_check.py")

# Variables that ARE read by index.ts but whose absence is a documented, correct
# state rather than a broken install. EVERY ENTRY IS A CONFESSION, copied into the
# evidence bundle so it travels with the result -- the same discipline as
# smoke.py's UNEXERCISABLE dict. Adding a name here is a decision, not a
# convenience: it removes a variable from F3.1's required set.
ENV_OPTIONAL_REVIEWED = {
    "ANTHROPIC_API_KEY":
        "index.ts:3186 `const env = provider === 'gemini' ? process.env.GEMINI_API_KEY "
        ": process.env.ANTHROPIC_API_KEY;` then :3187 `if (env) return env;` -- the "
        "value is TESTED immediately and falls through to Secret Manager and then to a "
        "literal. An unset key is the documented state and /api/keys/status reports it "
        "as key_present:false. The mechanical rule flags it; the code does not depend "
        "on it.",
    "GEMINI_API_KEY":
        "Same expression and same fallthrough as ANTHROPIC_API_KEY at index.ts:3186-3190.",
}


# ---------------------------------------------------------------- primitives
def sh(cmd, timeout=300):
    """Run a shell command. Returns (rc, stdout, stderr). NEVER raises: a probe
    that cannot be taken must be RECORDED, not thrown, or the judge cannot see it."""
    try:
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except Exception as e:
        return 255, "", str(e)[:2000]


def md_get(path, params=""):
    req = urllib.request.Request(MD + path + params,
                                 headers={"Metadata-Flavor": "Google"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8").strip()


def md_identity(audience):
    """AN ID TOKEN FOR WHATEVER SERVICE ACCOUNT THIS PROCESS IS RUNNING AS, WITH THE
    FALLBACK THIS PIPELINE ALREADY DOCUMENTS.

    [CE-MD-IDENTITY] THE METADATA IDENTITY ENDPOINT IS NOT SERVED IN EVERY RUNTIME
    THIS COLLECTOR RUNS IN, AND WHEN IT IS ABSENT EVERY SMOKE TOKEN FAILS TO MINT.
    Reported from a real Cloud Build step: /instance/service-accounts/default/email
    answers 200 with the build service account's address, while
    /instance/service-accounts/default/identity?audience=<url> answers 404 with a body
    complaining that a user-specified service account is needed -- which the email
    endpoint on the line above has just disproved. The endpoint is simply not present
    on that runtime. THAT 404 IS NOT A MEASUREMENT THIS FILE TOOK; it is the reported
    symptom this function exists to survive, and it is recorded as such rather than
    dressed up as something re-observed here.

    WHAT IS VERIFIABLE IN THIS TREE, and is what the fallback is built from:
      * pipeline/cloudbuild-dev.yaml:599 mints the smoke identity with exactly
        `gcloud auth print-identity-token --impersonate-service-account=<sa>
        --audiences=<aud> --include-email`. That is the pipeline's own documented
        channel, not a new invention, and its comment above records that
        --include-email is NOT optional: without it the token carries no email claim
        and oaStrainFromOidc's sa_email lookup can never match.
      * The BARE form is NOT a substitute, and the header of this file already says
        so: "gcloud auth print-identity-token --audiences= silently produces nothing
        usable in a build step."

    METADATA IS TRIED FIRST AND KEPT AS THE FAST PATH. On Cloud Run, where this
    collector also runs, the endpoint is present and answers, and impersonation there
    would need a role the runtime does not otherwise require. The fallback is only
    ever reached after the direct read has actually failed.

    IT RAISES RATHER THAN RETURNING SOMEBODY ELSE'S TOKEN, and that is the whole
    safety argument. ingress_id_token()'s contract is a token that passes Cloud Run
    ingress and resolves to NO strain. A token minted from some other principal would
    clear ingress and then RESOLVE, turning F2.2 -- whose assertion is PRECISELY 401 --
    green for the wrong reason, which is a false pass on the one check that proves the
    server challenges anonymous callers. No token is the honest answer, and the caller
    records the refusal.

    NO SHELL. The argument vector goes to subprocess directly rather than through
    sh(), so a service-account email or an audience carrying shell metacharacters
    cannot become a command. This is the one place in this file that deliberately does
    not reuse sh().

    DELIBERATELY NOT DONE: no caching, and no attempt to guess a service account when
    the email endpoint is also unreachable. If metadata cannot say who we are, this
    raises rather than picking a name."""
    try:
        return md_get("/instance/service-accounts/default/identity",
                      "?audience=" + audience)
    except Exception as md_err:
        sa = md_get("/instance/service-accounts/default/email")
        try:
            p = subprocess.run(
                ["gcloud", "auth", "print-identity-token",
                 "--impersonate-service-account=" + sa,
                 "--audiences=" + audience,
                 "--include-email"],
                capture_output=True, text=True, timeout=120)
            rc, out, err = p.returncode, p.stdout, p.stderr
        except Exception as e:
            rc, out, err = 255, "", str(e)[:2000]
        tok = (out or "").strip()
        if rc != 0 or not tok:
            raise RuntimeError(
                "no ID token for audience %s -- the metadata identity endpoint "
                "failed (%s) and impersonating %s exited %s: %s"
                % (audience, md_err, sa, rc, (err or "").strip()[:400]))
        return tok


def id_token(audience):
    """Metadata-server ID token. THE AUDIENCE MUST BE THE BASE SERVICE URL --
    see the header. Not gcloud: --audiences= produced nothing usable in a step.

    [SEC-SMOKE-IDENTITY-V1] PC_SMOKE_ID_TOKEN OVERRIDES THE METADATA IDENTITY, AND
    WITHOUT IT F1.4/F1.5 CANNOT PASS. The metadata `default` identity in a Cloud
    Build step is the BUILD service account. pcResolveIdentity() resolves the OAuth
    bearer FIRST and returns null -- a 401 -- unless oaStrainFromOidc() maps that
    bearer's email to an ACTIVE strains document carrying a matching sa_email. The
    build SA is deliberately NOT such a principal: it is the Cloud Build builder
    identity, and binding it would hand a fleet role to every build in the project.
    The pipeline therefore impersonates a DEDICATED smoke service account and passes
    its ID token here.

    THE AUDIENCE IS STILL THE BASE SERVICE URL, even though the probes go to the
    revision TAG url. oaStrainFromOidc pins the audience to MCP_PUBLIC_URL, which is
    the base, and accepts only that or that + "/mcp". A tag url is neither.

    UNSET == THE OLD BEHAVIOUR, DELIBERATELY. If impersonation fails the pipeline
    leaves this unset rather than substituting the builder's token, so F1.4/F1.5 fail
    HONESTLY at 401 instead of being made green by a principal that should never have
    held the role."""
    ov = os.environ.get("PC_SMOKE_ID_TOKEN", "").strip()
    if ov:
        return ov
    # [CE-MD-IDENTITY] md_identity(), not a bare md_get: the metadata identity
    # endpoint 404s in at least one runtime this collector is launched from, and
    # md_identity() falls back to the impersonation channel cloudbuild-dev.yaml:599
    # already uses. The PC_SMOKE_ID_TOKEN override above still wins outright, so this
    # path is only reached when the pipeline could not mint one for us.
    return md_identity(audience)


def ingress_id_token(audience):
    """THE INGRESS TOKEN: ALWAYS the metadata default identity, NEVER
    PC_SMOKE_ID_TOKEN, even when that variable is set.

    *** THIS EXISTS BECAUSE F2.2 AND F2.3 WERE ABOUT TO BECOME MUTUALLY
    EXCLUSIVE, AND THE COLLISION IS INVISIBLE UNTIL THE DAY IT LANDS. ***

    POST /mcp tools/list carries NO arguments, so it can never present a session
    key (index.ts:6412 -- listing is a deliberate carve-out and stays open). The
    ONLY thing that makes that call authenticated is the OAuth bearer, resolved by
    oaStrainFromOidc (index.ts:6268): it accepts a Google ID token whose aud is
    MCP_PUBLIC_URL, whose email is a service account, and which matches an ACTIVE
    strains document by sa_email.

    So "the keyless tools/list" and "the authenticated tools/list" ARE THE SAME
    HTTP REQUEST. They differ only by WHICH TOKEN is in the Authorization header:

      metadata default (the build SA)  -> no strains row  -> 401 + RFC 9728
                                          challenge          <- F2.2 asserts this
      PC_SMOKE_ID_TOKEN (the smoke SA) -> strains/devgate-smoke, status active
                                       -> 200 + tool roster  <- F2.3 needs this

    Before this split, ev["mcp_tools_list"] was sent with id_token(), which RETURNS
    PC_SMOKE_ID_TOKEN WHEN IT IS SET. That is fine today only because the smoke SA
    cannot yet reach the app. The moment the two pending grants land, the very same
    probe starts answering 200 and F2.2 -- which requires PRECISELY 401 -- FLIPS TO
    RED, reporting a compliant server as broken for the second time. Measured
    2026-08-11 against the rehearsal lane: strains/devgate-smoke exists with
    sa_email pc-<lane>-devgate-smoke@<project>.iam.gserviceaccount.com and
    status "active", so the resolution WILL succeed as soon as the token can be
    minted and the request can reach Express.

    The keyless probe therefore pins the identity that must NOT resolve. A token is
    still required: the dev service has no allUsers invoker (domain-restricted
    sharing forbids it), so a tokenless request is refused by the Cloud Run INGRESS
    and never reaches the application that would have issued the challenge.

    [CE-MD-IDENTITY] THE FALLBACK KEEPS THE PIN, IT DOES NOT WEAKEN IT. md_identity()
    falls back to impersonating THE SAME principal metadata would have described --
    it reads /instance/service-accounts/default/email and impersonates that -- so the
    identity this function promises is unchanged whichever channel answers. It raises
    rather than substituting any other principal, because a token from a DIFFERENT
    service account would clear ingress, then RESOLVE against a strains row, and turn
    F2.2's "must be exactly 401" green on a server that had merely admitted a
    stranger."""
    return md_identity(audience)


_AT = {}


def access_token():
    """THE OAUTH TOKEN FOR EVERY GOOGLE API READ HERE, AND THE IDENTITY IT CARRIES
    IS THE CAUSE UNDERNEATH [SEC-COLLECTOR-STARVED-V1].

    A GATED JOB HAS TWO IDENTITIES IN ONE SHELL, AND THE CHOICE WAS INVISIBLE.
    gate-exec/exec_server.py builds the child environment as

        env = dict(os.environ)
        env["CLOUDSDK_AUTH_ACCESS_TOKEN"] = access_token   # the approver's token

    and then runs the approved script with subprocess.run(["bash", f.name],
    env=env). gcloud HONOURS that variable, so every gcloud line in a staged job
    runs AS THE APPROVING HUMAN. urllib does not, so this function's metadata read
    resolved to the EXECUTOR SERVICE ACCOUNT, which holds datastore.user and
    logging.logWriter and nothing that can read Cloud Run, Storage, KMS or Secret
    Manager. That is the whole reason a gcloud readback in the same job described
    three healthy services minutes after this collector had been refused by every
    one of them and exited 0 over the wreckage.

    THE FIX IS AN ORDER, NOT AN IAM GRANT. shared/deploy/lane-fetch.py already
    solves this exact problem for its KMS decapsulate by shelling out to
    `gcloud auth print-access-token`. Doing the same here makes the collector read
    with the SAME identity as the gcloud calls beside it -- including the IAP
    toggle in collect_app, which was already running as the approver while these
    reads were not. The alternative -- granting the executor SA standing read
    roles on Run, Storage, KMS and Secret Manager project-wide -- buys the same
    reads with a permanent, unattended capability to enumerate every secret and
    key in the project. This is strictly smaller: a token the approver already
    holds, for the length of one job they approved.

    NOTHING CHANGES IN CLOUD BUILD. No CLOUDSDK_AUTH_ACCESS_TOKEN exists in a
    build step, and gcloud's ADC there is the BUILD service account, which is also
    exactly what the metadata default returns. Same principal by either route.

    THE METADATA FALLBACK IS KEPT so a container without gcloud still collects,
    and THE CHANNEL IS RECORDED rather than inferred, because "which identity did
    this read use" is the first question any refusal raises and this file has had
    no answer to it.
    """
    if _AT.get("token"):
        return _AT["token"]
    injected = os.environ.get("CLOUDSDK_AUTH_ACCESS_TOKEN", "").strip()
    if injected:
        _AT["channel"] = ("CLOUDSDK_AUTH_ACCESS_TOKEN -- the approver token the "
                          "gate executor injected into this job")
        _AT["token"] = injected
        return _AT["token"]
    rc, out, err = sh("gcloud auth print-access-token", timeout=60)
    tok = (out or "").strip()
    if rc == 0 and tok:
        _AT["channel"] = "gcloud auth print-access-token"
        _AT["token"] = tok
        return _AT["token"]
    _AT["channel"] = ("metadata default -- gcloud printed no token (rc=%d, %s). "
                      "IN A GATED JOB THIS IS THE EXECUTOR SERVICE ACCOUNT, not "
                      "the approver, and it can read almost nothing."
                      % (rc, (err or "").strip()[:120]))
    _AT["token"] = json.loads(
        md_get("/instance/service-accounts/default/token"))["access_token"]
    return _AT["token"]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """REFUSE EVERY REDIRECT. Returning None from redirect_request() makes
    HTTPRedirectHandler decline to build the follow-up request; the handler chain
    then falls through to HTTPDefaultErrorHandler and the 3xx arrives in http()'s
    EXISTING HTTPError branch carrying its own status, its own headers and its own
    body. No new branch, no new shape -- the response that was already being thrown
    away simply stops being thrown away."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def http(method, url, token=None, cookie=None, body=None, timeout=120,
         extra_headers=None):
    """Every probe is RECORDED, never raised. Returns smoke.py's probe shape:
    {_http, _url, headers, body}. _shape() classifies a refusal BY ITS HEADERS,
    so the headers must survive into the bundle.

    *** [CE-NOREDIRECT] THIS FUNCTION MUST NOT FOLLOW REDIRECTS. FOLLOWING THEM DID
    NOT LOSE EVIDENCE -- IT FORGED IT. ***

    urllib.request.urlopen() uses the DEFAULT opener, and the default opener follows
    3xx. IAP answers an unauthenticated browser-shaped GET with a 302 to
    accounts.google.com carrying x-goog-iap-generated-response: true -- which is
    precisely the proof F6.2.CONSOLE_IS_IAP_FRONTED asks for. urlopen discarded that
    response, chased the Location, and this function recorded the SIGN-IN PAGE's 200
    and the SIGN-IN PAGE's headers. Worse, it returned "_url": url -- the url we
    ASKED for, never the one that answered -- so accounts.google.com's headers landed
    in the bundle UNDER THE CLOUD RUN URL with nothing anywhere recording that a hop
    had happened. That is not a gap in the evidence; it is a fabricated observation of
    a host we never probed.

    WHY THE FAILURE LOOKED UNRELATED TO REDIRECTS. smoke.py's _shape() then saw no
    x-goog-iap-generated-response, no x-powered-by and a 200, and returned "unknown"
    -- and an unrecognised shape is never a pass. So F6.2 failed with "answered in a
    shape this file cannot classify" regardless of the IAP toggle, because
    collect_surfaces() runs before collect_app() ever touches it. The judge has ALWAYS
    modelled health here as the 302: its own healthy-surface fixture seeds this probe
    as {"_http": 302, headers: {"x-goog-iap-generated-response": "true"}}. Only the
    collector could not produce one.

    NO PROBE IN THIS FILE NEEDS A FOLLOW, and that was checked rather than assumed.
    Every caller was read: the googleapis.com REST reads (run, storage, firestore,
    compute, cloudkms, secretmanager) answer 200 or a JSON error directly; the MCP
    surface answers its own Express 401 with www-authenticate; and F2.6's "follow the
    challenge" is done by EXPLICIT CODE that parses resource_metadata out of the
    WWW-Authenticate header and issues a SECOND http() call -- it is not, and never
    was, an HTTP redirect. NOT VERIFIED BY RE-RUNNING THE PIPELINE: this is a reading
    of the call sites in this file, not a byte-comparison of old and new bundles.

    REPRODUCED LOCALLY BEFORE THIS WAS CHANGED, and stated as exactly what it is: a
    local http server, NOT the live console. Serving a 302 with
    x-goog-iap-generated-response: true and a Location to a page that answers 200 with
    a content-security-policy header, the OLD default-opener path recorded
    `_http: 200`, NO iap header, the second page's csp header, and `_url` still naming
    the FIRST url. The new path records `_http: 302`, the iap header, and
    location_host. refusal_layer() over those two probes returns "cloud-run-ingress
    (no application header came back)" and "iap (...refused BEFORE the container)"
    respectively -- confidently wrong, then right.

    A REDIRECT IS NOW RECORDED RATHER THAN CHASED. location and location_host are
    added when a Location header comes back, so the next surprise of this shape is
    visible in the bundle instead of invisible inside it.

    EVERY EXISTING FIELD KEEPS ITS NAME AND ITS MEANING. _url is now the url that
    ACTUALLY ANSWERED rather than the one requested -- with redirects refused the two
    are always equal, which is exactly the point: the field can no longer lie.

    DELIBERATELY NOT DONE: no opt-in follow parameter. A caller that wants the target
    of a redirect can read location and call http() again, which puts the second
    request in the bundle as its own probe."""
    data = None
    hdrs = {}
    if token:
        hdrs["Authorization"] = "Bearer " + token
    if cookie:
        hdrs["Cookie"] = cookie
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        hdrs.setdefault("Content-Type", "application/json")
    for k, v in (extra_headers or {}).items():
        hdrs[k] = v
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)

    def rec(code, answered_url, headers, text):
        h = {k.lower(): v for k, v in (headers or {}).items()}
        out = {"_http": code, "_url": answered_url or url, "headers": h,
               "body": text, "_url_requested": url, "_redirects_followed": 0}
        if h.get("location"):
            # RECORDED, NEVER CHASED. The host is split out because that is the fact
            # that mattered and was missing: a Location pointing at a sign-in host is
            # the signature of an identity proxy in front of the service.
            out["location"] = h["location"]
            out["location_host"] = urllib.parse.urlsplit(
                urllib.parse.urljoin(url, h["location"])).netloc
        return out

    try:
        with _OPENER.open(req, timeout=timeout) as r:
            return rec(r.status, getattr(r, "url", url) or url, r.headers,
                       r.read().decode("utf-8", "replace")[:40000])
    except urllib.error.HTTPError as e:
        return rec(e.code, getattr(e, "url", url) or url, e.headers or {},
                   e.read().decode("utf-8", "replace")[:40000])
    except Exception as e:                       # DNS, TLS, timeout
        return {"_http": None, "_url": url, "headers": {}, "body": "",
                "_error": str(e)[:600], "_url_requested": url,
                "_redirects_followed": 0}


def jbody(probe):
    """Parse a probe body as JSON, or None.

    IT PARSES ERROR BODIES TOO, AND THAT IS THE TRAP. A Google API refusal is a
    perfectly well-formed JSON document -- {"error":{"code":400,...}} -- so this
    returns a dict for a FAILED request just as it does for a successful one, and
    `jbody(p).get("things", [])` then reports "none" where the truth is "we were
    refused". Callers whose assertion depends on the payload being real must gate
    on probe["_http"], not on this returning something."""
    try:
        return json.loads((probe or {}).get("body") or "")
    except Exception:
        return None


def git_blob_oid(data):
    """git's own blob hash, so the recipe pin is checked the way git states it."""
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


# ==========================================================================
# SOURCE SCANNERS -- PURE. No cloud, no credentials, no clock. Every one is
# exercised by --source-only against the real tree.
# ==========================================================================
# --------------------------------------------------------------------------
# THE COMMENT BLANKER IS GONE, AND THAT IS [SEC-ONE-SCANNER] FINISHED.
#
# [SEC-ONE-SCANNER-V3] 2026-08-13. What stood here was a python port of
# control-plane/route-audit.mjs's blankComments(): REGEX_OK_KEYWORDS,
# _regex_can_start(), _blank_comments_full(), _stray_comment_openers(),
# blank_comments() and its four self-checks, and the BlankerDesync refusal they
# raised. Roughly 250 lines serving exactly one caller, scan_tools(), which is
# deleted with them.
#
# THE PORT'S OWN NOTE SAID HOW TO END IT, AND THIS IS THAT ENDING VERBATIM: "have
# route-audit.mjs emit the registerTool list alongside the route table -- it
# already holds CODE, the blanked source -- and delete this too." It does now, as
# the `tools` key, and this is deleted. NOTHING IS DROPPED, ONE THING IS
# INHERITED: the protection against PROSE naming registerTool still exists, it
# just lives where the blanked view is already computed and already guarded by
# four self-checks, instead of being re-implemented here in another language.
#
# WHY IT COULD NOT SIMPLY BE LEFT ALONE. It had been an UNVERIFIED port since
# js_cross_check was deleted -- its own note said so -- and this exact algorithm
# had ALREADY drifted once in this file: written from the
# pre-[SEC-ROUTE-BLANKER-REGEX-V2] blanker, it read the guard token oaBearerRole
# out of PROSE and made smoke F7.1 a guaranteed false red for four days from
# f68f7a36. A second implementation is not a second opinion, it is a disagreement
# nobody arbitrates. Three copies of this scanner family have existed in the
# fleet -- control-plane/gen-baseline.py, scan_routes() here, and this blanker.
# There are now none outside route-audit.mjs.
#
# MEASURED BEFORE DELETING, at head 8a0e5e08 over control-plane/src/index.ts blob
# 60f0798a: this blanker's scan_tools() and route-audit.mjs's new `tools` emission
# yield the SAME 45 names -- delta zero, list-equal including order. Blanked and
# raw scanning also still agree at 45, so nothing in index.ts today even depends
# on the blanking. It was deleted on a measurement, not on an argument.


# --------------------------------------------------------------------------
# [SEC-ONE-SCANNER-V2] 2026-08-13. THERE IS ONE ROUTE SCANNER AND IT IS NOT IN
# THIS FILE. THIS READS THE TABLE route-audit.mjs EMITS.
#
# WHAT WAS HERE AND WHY IT WAS WRONG. RE_ROUTE_ANCHORED, RE_ROUTE_ANYWHERE, the
# GUARDS list, js_route_table() and scan_routes() were a SECOND IMPLEMENTATION,
# in python, of control-plane/route-audit.mjs's route scanner: the same
# algorithm, in a different language, producing the same verdicts for the same
# gate. It drifted the way ports drift. Written against the
# pre-[SEC-ROUTE-BLANKER-REGEX-V2] blanker, it read the guard token oaBearerRole
# out of a COMMENT describing the NEXT route and called POST /api/jobs/fire
# guarded, reporting 85/70/15 where route-audit.mjs reported 85/69/16 -- and
# smoke F7.1, which compares these counts to route-baseline.json, called that
# route drift on every run from f68f7a36 for four days. The route table had not
# moved. Its sibling port control-plane/gen-baseline.py had the SAME defect from
# the SAME cause (84/70/14 against 84/69/15) and was deleted at 1eb65ef5; see
# oss/gen.py [SEC-ONE-SCANNER-V1]. This was the second one. There is no third.
#
# WHY THE PREVIOUS FIX WAS NOT ENOUGH. [SEC-ROUTE-F71-REPORT-V1] answered the
# drift by porting the fix and adding a machine cross-check of the two full
# tables. That was the right emergency repair: it made a silent disagreement
# loud. It was the wrong steady state, because it kept TWO implementations and
# made their disagreement the failure mode. A cross-check between two copies of
# an algorithm is a discipline mechanism with a machine attached; deleting one
# copy removes the thing the discipline was protecting against.
#
# THE RULING WAS "DELETE THE PORT, SHELL OUT TO route-audit.mjs --emit-table".
# IT CANNOT SHELL OUT, and pretending otherwise would have shipped a
# FileNotFoundError into the one build step that matters. route-audit.mjs is
# node; this file runs in gcr.io/google.com/cloudsdktool/cloud-sdk:slim, which
# has python3 and NO node -- pipeline/cloudbuild-dev.yaml says so at the
# route-table step. The mechanism that honours the ruling is the one the
# cross-check already built:
#
#   cloudbuild-dev.yaml step `route-table`, on node:24-slim, runs
#     node route-audit.mjs src/index.ts route-baseline.json \
#          --emit-table=/workspace/route-table-js.json
#   and /workspace is what survives between steps. The table crosses the runtime
#   boundary AS A FILE. That is the whole mechanism, and it is not a workaround:
#   --emit-table writes BEFORE the wildcard / connector / hidden / baseline
#   checks, so even a build that is about to go red leaves a true table behind.
#
# A MISSING TABLE IS A REFUSAL, NOT A FALLBACK. There is no scanner left to fall
# back to and there must never be one again. If the file is absent, empty,
# unparseable, structurally wrong, or describes a DIFFERENT index.ts, then every
# field derived from it is OMITTED FROM THE BUNDLE -- not zeroed, not defaulted,
# not carried over from a previous build -- and routes.table_source carries
# ran:false and the verbatim reason. smoke.py already renders an absent
# `anchored`, `tolerant` or `registered` as a FAIL, which is the correct verdict:
# nothing measured the route table this build. ABSENT, NEVER PASSED -- the same
# words cloudbuild-dev.yaml's skip path already uses.
#
# AND AN OLD BUNDLE IS AN ABSENCE, NOT A CRASH. A tree whose route-audit.mjs
# predates --emit-table ignores the flag, writes nothing AND EXITS 0; the yaml
# tells that case apart by grepping for the flag literal and skips the emit. A
# tree whose route-audit.mjs has --emit-table but predates this commit emits a
# table with no `hidden` and no `source_sha256`. Both are recorded as ABSENT with
# the reason, per field, and neither is refused for a capability its tree never
# had. What is refused is guessing.
#
# THE TABLE IS THE CONTRACT; THE COUNTS ARE A CONVENIENCE. Every field below is
# rebuilt from `table` -- method, path, guarded -- row by row. The emitted
# total/guarded/public are recorded and CHECKED against the rows, never used in
# their place: two readers can agree on 84/69/15 and disagree about WHICH route
# is public, and that is the exact failure that makes a count comparison feel
# safe while being worthless.
#
# WHAT DELIBERATELY DOES NOT CHANGE.
#   * The SHAPE of every field smoke.py reads. anchored{total,guarded,public},
#     tolerant{total}, hidden[], map.entries{}, unmapped[], dead_map_entries[],
#     registered[], public_routes[] are byte-identical in structure to what
#     scan_routes() returned. Only their PROVENANCE changed.
#   * parse_surface_map(). PC_SURFACE_MAP is a TypeScript object literal that
#     route-audit.mjs does not read at all, so parsing it here is not a port of
#     anything -- it is the only reader there is. It is also why `map.entries`
#     survives a missing table: it is honestly measured either way, and claiming
#     it was not parsed would be a lie in the bundle.
#   * blank_comments() and its self-checks, for scan_tools() only. THAT LINE IS
#     NO LONGER TRUE, and it is struck rather than deleted so a reader who has
#     seen it can tell "finished" from "stopped being reported":
#     [SEC-ONE-SCANNER-V3] deleted the blanker AND scan_tools(), and the tool
#     names arrive as the table's `tools` key beside the routes. See the tombstone
#     where the scanners used to be.
#   * route-audit.mjs's exit code is still not consulted here, and cannot be: it
#     exits 1 on a BASELINE violation, which is a fact about route-baseline.json
#     and not about the table. Turning that into a red build is the yaml's job
#     and the yaml does it.
#
# GONE WITH THE PORT, ON PURPOSE:
#   raw_anchored_total / raw_vs_blanked_agree  a second count of THIS FILE's
#       scan, taken without blanking, whose only job was to catch this file's
#       blanker changing a route verdict. With no scan here there is nothing for
#       it to be a second opinion about, and keeping it means keeping a route
#       regex -- which is keeping the port behind a smaller name.
#   js_cross_check  a diff between two implementations. There is one.
#       table_source replaces it: same question ("did the JS table reach us, and
#       how?"), one implementation.
#   PC_ROUTE_TABLE_REQUIRED  it existed to escalate "the port is UNVERIFIED" into
#       a refusal. There is no port to verify. Absence is now always a refusal to
#       report, so an env var that switches that on is a switch for honesty.
ROUTE_TABLE_JS_ENV = "PC_ROUTE_TABLE_JS"
ROUTE_TABLE_JS_DEFAULT = "/workspace/route-table-js.json"

# Bumped when the EMITTED shape gains a field this file reads. Recorded in the
# bundle beside what was actually found, so "the table is old" and "the table is
# broken" are never confused for one another by a human reading the evidence.
ROUTE_TABLE_KEYS_REQUIRED = ("table",)
ROUTE_TABLE_KEYS_OPTIONAL = ("hidden", "source_sha256", "tools")


def route_table_path():
    """The one path, resolved the one way. PC_ROUTE_TABLE_JS names it; otherwise
    the pipeline's /workspace default. There is deliberately no search list: a
    reader that tries several places reports the wrong one when it guesses."""
    return (os.environ.get(ROUTE_TABLE_JS_ENV) or "").strip() or ROUTE_TABLE_JS_DEFAULT


def read_route_table(path=None, index_ts=None):
    """(table, path, why_absent).

    Exactly one of table / why_absent is None. ABSENT, EMPTY, UNPARSEABLE,
    STRUCTURALLY WRONG and WRONG-SOURCE are five different refusals and each one
    says which it was, because "no route table" and "a route table for some other
    file" need different fixes from whoever reads this bundle.

    IT NEVER FALLS BACK TO SCANNING, and it never falls back to running node
    either -- the old js_route_table() did, and that path only ever ran on a
    developer's workstation, so the pipeline's behaviour was decided by code the
    pipeline could not execute. One path, exercised everywhere."""
    path = path or route_table_path()
    named = bool((os.environ.get(ROUTE_TABLE_JS_ENV) or "").strip())
    whence = " (named by %s)" % ROUTE_TABLE_JS_ENV if named else " (the default)"

    if not os.path.exists(path):
        return None, path, (
            "NO ROUTE TABLE at %s%s. route-audit.mjs is the only route scanner and "
            "it left nothing here, so nothing measured this tree's routes. Either "
            "the route-table build step did not run, or this tree's route-audit.mjs "
            "predates --emit-table and the step skipped on purpose. No route field "
            "is reported and none is guessed." % (path, whence))
    try:
        size = os.path.getsize(path)
    except OSError as e:
        return None, path, ("the route table at %s%s cannot be stat'd: %s"
                            % (path, whence, e))
    if size == 0:
        return None, path, (
            "the route table at %s%s is EMPTY (0 bytes). An emit that produced no "
            "bytes is a broken emit, not a route table with nothing in it -- "
            "index.ts registers routes. Refusing to report." % (path, whence))
    try:
        with open(path, "r", encoding="utf-8") as fh:
            tbl = json.load(fh)
    except Exception as e:
        return None, path, (
            "the route table at %s%s (%d bytes) is not readable JSON: %s: %s"
            % (path, whence, size, type(e).__name__, e))
    if not isinstance(tbl, dict):
        return None, path, ("the route table at %s%s parsed to %s, not an object"
                            % (path, whence, type(tbl).__name__))
    rows = tbl.get("table")
    if not isinstance(rows, list):
        return None, path, (
            "the file at %s%s is JSON but carries no `table` list (keys: %s). "
            "`table` IS the contract; the counts are a convenience and are not a "
            "substitute for it." % (path, whence, ",".join(sorted(tbl)) or "none"))
    if not rows:
        return None, path, (
            "%s%s carries an EMPTY `table`. index.ts registers routes, so zero rows "
            "is a broken emit and not a measurement." % (path, whence))
    for i, r in enumerate(rows):
        if (not isinstance(r, dict) or not isinstance(r.get("method"), str)
                or not isinstance(r.get("path"), str)
                or not isinstance(r.get("guarded"), bool)):
            return None, path, (
                "row %d of %s%s is not {method:str, path:str, guarded:bool}: %.200r. "
                "A row whose guarded verdict is missing or not a boolean cannot be "
                "read as public OR guarded, and defaulting it either way invents a "
                "security verdict." % (i, path, whence, r))
    # THE COUNTS ARE CHECKED AGAINST THE ROWS, NEVER TRUSTED IN PLACE OF THEM. A
    # disagreement here means the emitter is broken, and an emitter that
    # miscounts its own table is not one whose table can be believed.
    n_g = sum(1 for r in rows if r["guarded"])
    for label, emitted, counted in (("total", tbl.get("total"), len(rows)),
                                    ("guarded", tbl.get("guarded"), n_g),
                                    ("public", tbl.get("public"), len(rows) - n_g)):
        if emitted is not None and emitted != counted:
            return None, path, (
                "%s%s is internally inconsistent: it says %s=%s and its own rows say "
                "%s. The emitter is broken; its table cannot be believed."
                % (path, whence, label, emitted, counted))
    # THE TABLE MUST BE ABOUT THE FILE WE WERE HANDED. With the port gone there is
    # no second reading of index.ts to disagree with a stale or foreign table, and
    # a table for the WRONG index.ts is worse than no table: it is a confident
    # wrong answer that every downstream check would render green.
    if index_ts is not None and tbl.get("source_sha256"):
        got = hashlib.sha256(index_ts.encode("utf-8")).hexdigest()
        if got != tbl.get("source_sha256"):
            return None, path, (
                "the route table at %s%s was cut from a DIFFERENT source: it records "
                "source_sha256 %s for %r and this collector's index.ts hashes to %s. "
                "A table for another file is worse than none. Refusing."
                % (path, whence, tbl.get("source_sha256"), tbl.get("source"), got))
    return tbl, path, None


def route_facts(index_ts, tree=None):
    """(routes_section, tools).

    The bundle's `routes` section, REBUILT FROM route-audit.mjs's emitted table,
    and -- from THE SAME read of that table -- the registerTool list that becomes
    source.registered_tools. Two callers of read_route_table() would be two
    chances to disagree about which table this build measured, and disagreeing
    with itself is the failure this whole ruling exists to remove, so there is one
    read and it is here. `tools` is None when the table did not carry the key;
    collect_source() then OMITS registered_tools rather than reporting [].

    What each key answers, and which assertion reads it (devgate/smoke.py):

      table_source  --      provenance and, when there is none, the refusal
      anchored      F7.1    what route-audit.mjs sees      {total,guarded,public}
      tolerant      F7.3    anchored + registrations it CANNOT see
      hidden        F7.3    those registrations, enumerated
      map.entries   F7.2    PC_SURFACE_MAP, parsed here -- see below
                    F6.5    and the only thing certifying /mcp's surface
      unmapped      F7.2    registered, on no surface -- THROWS at boot
      dead_map_entries F7.2 mapped, not registered -- throws nowhere, invisible
      registered    F2.5    every route, guarded or not
      public_routes F2.5    the ones with no guard in the handler

    Returned alongside, not a key of this section:
      tools         F2.1    registerTool call sites, scanned by route-audit.mjs
                            over ITS blanked view -- this file no longer has one

    `tree` is accepted and unused. It is kept in the signature because
    collect_source() passes it and because a future reader will ask whether this
    function can reach the tree: it can, and it deliberately does not. Reaching
    the tree is how a second scanner gets written.

    THE ASYMMETRY IN WHAT SURVIVES A MISSING TABLE IS DELIBERATE. `map` is parsed
    from index_ts, has no counterpart in route-audit.mjs, and is therefore still
    honestly measured when no table arrived -- reporting it as unparsed would be a
    lie. Everything the table decides is omitted. That does leave F7.2 holding
    entries it cannot check against a route list, which is why smoke.py's F7.2 now
    requires `registered` to be present before it judges the partition."""
    facts = {"map": {"entries": parse_surface_map(index_ts)},
             # THE KEY IS KEPT AND KEPT TRUTHFUL. A bundle reader who has seen the
             # old text must be able to tell that it no longer applies -- and a key
             # that simply vanishes leaves them unable to tell "fixed" from
             # "stopped being reported". Same discipline the old text itself used.
             "blanker_defect":
                 "MOOT 2026-08-13 [SEC-ONE-SCANNER-V2]. NO BLANKER DECIDES ANY ROUTE "
                 "VERDICT IN THIS BUNDLE. THE OLD TEXT SAID: this file's port of "
                 "route-audit.mjs's blankComments() had no regex-literal awareness, so "
                 "it read the guard token oaBearerRole out of PROSE and called "
                 "POST /api/jobs/fire guarded -- 85/70/15 against route-audit.mjs's "
                 "85/69/16, which smoke F7.1 reported as route drift for four days from "
                 "f68f7a36. [SEC-ROUTE-F71-REPORT-V1] closed it by porting the fix and "
                 "cross-checking the two full tables. THAT IS ALSO GONE: the port is "
                 "deleted and every route field here is rebuilt from the table "
                 "route-audit.mjs emitted with --emit-table. See routes.table_source "
                 "for which file that was and what is known about it. AND AS OF "
                 "[SEC-ONE-SCANNER-V3] THERE IS NO COMMENT BLANKER IN "
                 "collect-evidence.py AT ALL: its last caller, scan_tools(), is "
                 "deleted too and the registerTool names come from this same table's "
                 "`tools` key. No blanker in this file decides ANYTHING.",
             }

    tbl, path, why = read_route_table(index_ts=index_ts)
    if tbl is None:
        facts["table_source"] = {
            "ran": False,
            "path": path,
            "why": why,
            "fallback": "NONE, BY DESIGN [SEC-ONE-SCANNER-V2]. This file has no route "
                        "scanner to fall back to. Every route field except `map` is "
                        "ABSENT from this bundle and none of them is defaulted, "
                        "zeroed, or carried over. smoke.py F7.1/F7.2/F7.3/F2.5 read "
                        "an absent field as a FAIL, which is the correct verdict: "
                        "nothing measured the routes on this build. THE SAME IS "
                        "NOW TRUE OF source.registered_tools "
                        "[SEC-ONE-SCANNER-V3]: the tool names ride in this table "
                        "too, so no table means no tool list either, the key is "
                        "omitted rather than emptied, and F2.1 fails on the empty "
                        "set it reads. One missing file, one honest absence.",
        }
        return facts, None

    rows = tbl["table"]
    keys = sorted(r["method"] + " " + r["path"] for r in rows)
    guarded_n = sum(1 for r in rows if r["guarded"])
    facts["anchored"] = {"total": len(rows), "guarded": guarded_n,
                         "public": len(rows) - guarded_n}
    facts["registered"] = keys
    facts["public_routes"] = sorted(r["method"] + " " + r["path"]
                                    for r in rows if not r["guarded"])

    registered, mapped = set(keys), set(facts["map"]["entries"])
    facts["unmapped"] = sorted(registered - mapped)
    facts["dead_map_entries"] = sorted(mapped - registered)

    src = {"ran": True, "path": path, "how": "route-audit.mjs --emit-table",
           "source": tbl.get("source"),
           "emitted_counts": {"total": tbl.get("total"), "guarded": tbl.get("guarded"),
                              "public": tbl.get("public")},
           "note": tbl.get("note")}

    # PER-FIELD ABSENCE, because a table emitted by an OLDER route-audit.mjs is a
    # real and correct state and must not brick that commit. `hidden` missing is
    # NOT the same fact as hidden == [], and only an explicit key test can tell
    # them apart -- `tbl.get("hidden") or []` would silently report a tree with
    # invisible registrations as having none, which is F7.3 passing on nothing.
    if isinstance(tbl.get("hidden"), list):
        facts["hidden"] = [str(h) for h in tbl["hidden"]]
        facts["tolerant"] = {"total": len(rows) + len(facts["hidden"])}
    else:
        src["hidden"] = (
            "ABSENT -- this tree's route-audit.mjs emits a table with no `hidden` "
            "key, so it predates [SEC-ONE-SCANNER-V2]. `hidden` and `tolerant` are "
            "omitted and smoke F7.3 reports that it has no anchored/tolerant "
            "comparison. NOT inferred from the audit having exited 0: that is an "
            "inference across two build steps, not a measurement.")

    if tbl.get("source_sha256"):
        src["source_sha256"] = {
            "emitted": tbl["source_sha256"],
            "collector": hashlib.sha256(index_ts.encode("utf-8")).hexdigest(),
            "match": True,   # read_route_table() refuses the table otherwise
        }
    else:
        src["source_sha256"] = (
            "ABSENT -- this tree's route-audit.mjs emits no source_sha256, so nothing "
            "ties this table to the index.ts scanned here beyond both steps running "
            "in the same /workspace. The route fields below are reported; this is "
            "what is NOT known about them.")
    # `tools` JOINS THE PER-FIELD ABSENCE HANDLING FOR THE SAME REASON `hidden`
    # DID, AND THE FAIL-CLOSED PATH IS SHORTER THAN IT LOOKS. A tree whose
    # route-audit.mjs emits a table but no `tools` is a real and correct state --
    # it predates [SEC-ONE-SCANNER-V3] -- and must not be refused for a capability
    # it never had. So the key is DROPPED, never defaulted: collect_source() omits
    # source.registered_tools entirely, smoke F2.1 reads it as the empty set
    # through its own .get(..., []), and its first branch -- "no registered tools
    # parsed from source ... refusing to report on an empty set" -- FAILS the run.
    # An absence that turns into a red is the only kind worth having here. Note
    # what is NOT done: `tbl.get("tools") or []` would report a tree whose tools
    # were never scanned as a tree with no tools, which is F2.1 passing on nothing
    # if that branch is ever softened.
    if isinstance(tbl.get("tools"), list):
        tools = [str(t) for t in tbl["tools"]]
    else:
        tools = None
        src["tools"] = (
            "ABSENT -- this tree's route-audit.mjs predates the tools emission "
            "[SEC-ONE-SCANNER-V3]: it emits a table with no `tools` key, and this "
            "file no longer carries the registerTool scanner that used to fill the "
            "gap. source.registered_tools is OMITTED from this bundle -- not [], "
            "not carried over -- so smoke F2.1 refuses on the empty set. NOT "
            "inferred from the audit having exited 0: that is an inference across "
            "two build steps, not a measurement.")
    facts["table_source"] = src
    return facts, tools


def parse_surface_map(index_ts):
    """PC_SURFACE_MAP is a plain TS object literal at column zero (index.ts:186).
    Keys are exactly METHOD + one space + the path string as registered; values are
    console | mcp | both."""
    m = re.search(r"^const PC_SURFACE_MAP\b[^=]*=\s*\{", index_ts, re.M)
    if not m:
        return {}
    end = index_ts.find("\n};", m.end())
    if end < 0:
        return {}
    out = {}
    for em in re.finditer(
            r"['\"]([A-Z]+ [^'\"]+)['\"]\s*:\s*['\"](console|mcp|both)['\"]",
            index_ts[m.end():end]):
        out[em.group(1)] = em.group(2)
    return out


# [SEC-ONE-SCANNER-V3] RE_REGISTER_TOOL AND scan_tools() STOOD HERE. The tool
# names now arrive in route-audit.mjs's emitted table as `tools`, read by
# route_facts() from the same table read that feeds the route facts, and the
# pattern that finds them is the CHARACTER EQUIVALENT of the RE_REGISTER_TOOL
# deleted here -- both are registerTool\(\s*['"]([A-Za-z0-9_]+)['"] . The caveat
# scan_tools()'s docstring carried is not lost either; it is emitted, in the
# table's own `note`: the git_* tools do NOT appear in that list and that is
# CORRECT. gittools.js registers them at runtime through registerGitTools(), not
# at a literal call site in index.ts, so no scan of the SOURCE can see them.
# F2.1 only fails on tools that are present and unclassified; absence is not what
# it checks.


# EVERY control-plane TYPESCRIPT SOURCE THE IMAGE LOADS AND THAT CAN READ THE
# ENVIRONMENT. index.ts is NOT the whole program: index.ts:1724 does
# require("./gittools.js") and :1725 calls registerGitTools(), and gittools.ts
# reads GIT_REPO_ID and GIT_BUCKET itself. Scanning index.ts alone reports both as
# SET-BUT-READ-NOWHERE, which is F3.2's exact false-positive shape and the same
# defect scan_env_py() was widened to fix for PC_CREDS_SECRET: the harness invents
# a finding and somebody deletes a working thing. A MISSING FILE IS RECORDED,
# NEVER FATAL -- an older tree has no gittools.ts and must still collect.
CP_ENV_SOURCES_EXTRA = ("control-plane/src/gittools.ts",)

# NAMES NO REGEX OVER ANY FILE CAN SEE, BECAUSE THE LOOKUP IS INDEXED RATHER THAN
# DOTTED. EVERY ENTRY IS A CONFESSION -- the same discipline as
# ENV_OPTIONAL_REVIEWED -- and the dict is copied into the bundle so it travels
# with the result instead of living only here.
ENV_READ_DYNAMIC = {
    "PC_CI_TOPIC":
        "gittools.ts ciEnv(name) is String(process.env[name] || '').trim(), an "
        "INDEXED lookup, so the NAME never appears beside process.env anywhere in "
        "the source and no regex over any file can find it. "
        "ciPublishRefMoved() calls ciEnv('PC_CI_TOPIC') and returns "
        "DISABLED_NO_TOPIC when it is empty: it IS read, and it IS optional.",
    "PC_CI_PUBLISH_SA":
        "The same ciEnv() indirection in ciPublishRefMoved(). Empty means publish "
        "as the revision's own metadata identity instead of impersonating.",
}

RE_ENV_TS = re.compile(r"process\.env\.([A-Za-z_][A-Za-z0-9_]*)")


def scan_env_ts(index_ts):
    """(all_read, no_default).

    THE RULE, in smoke.py's own words: "Read with no `||` fallback anywhere in the
    expression => the code depends on the deployment to supply it." Three fallback
    forms are recognised mechanically, because all three mean the same thing to a
    reader and only the first is spelled `||`:

        process.env.X || 'default'      logical-or default
        process.env.X ?? 'default'      nullish default
        process.env.X ? a : b           tested in a ternary condition

    A name is REQUIRED only if NO occurrence carries any of them. The stricter
    "any occurrence lacks a fallback" reading was MEASURED against the real
    index.ts and produced GATE_EXEC_URL as required, purely because one of its two
    reads (index.ts:438) is a bare capture that :1855 already defaults. That is a
    false positive, and a false positive here BLOCKS A CORRECT DEPLOY. Fail-closed
    is right; crying wolf is not, because a check that fires on a healthy tree gets
    switched off.

    ENV_OPTIONAL_REVIEWED removes the residue this rule cannot see: a value
    captured and then tested on the NEXT line. Every entry carries its reason."""
    occ = {}
    for m in RE_ENV_TS.finditer(index_ts):
        tail = index_ts[m.end():m.end() + 60]
        occ.setdefault(m.group(1), []).append(
            bool(re.match(r"\s*(\|\||\?\?|\?[^?.])", tail)))
    return (sorted(occ),
            sorted(n for n, v in occ.items()
                   if not any(v) and n not in ENV_OPTIONAL_REVIEWED))


def scan_env_ts_many(sources):
    """scan_env_ts over SEVERAL sources, unioned by the SAME rule it applies
    inside one file: a name is required only if NO occurrence ANYWHERE carries a
    fallback. Taking the union of the per-file "required" sets would be wrong --
    a name read bare in one file and defaulted in another would come back
    required, which is the false positive that blocks a correct deploy."""
    reads, nodef, has_fallback = set(), set(), set()
    for text in sources:
        r, n = scan_env_ts(text)
        reads.update(r)
        nodef.update(n)
        has_fallback.update(set(r) - set(n))
    return sorted(reads), sorted(nodef - has_fallback)


# [CE-ENV-HELPERS-PY] AN IN-IMAGE HELPER THAT WRAPS AN ENVIRONMENT READ MOVES THE
# NAME OFF THE os.environ LINE AND ONTO THE CALL SITE, AND THIS SCANNER WENT BLIND
# EXACTLY WHEN THE CODE GOT TIDIER. The two spellings below are the only ones the old
# pattern knew, so a variable read through a one-line wrapper looked, to F3.2, exactly
# like a variable nothing reads -- which is the direction that INVENTS findings.
#
# MEASURED IN THIS TREE, by reading the file rather than remembering it.
# gate-exec/lockout_check.py:55 defines
#
#     def _envlist(name):
#         return tuple(x for x in re.split(r"[,\s]+", os.environ.get(name, "").strip()) if x)
#
# where `name` is a PARAMETER, so no regex over that line can ever yield a variable
# name. It is called THREE times, each with a quoted literal: _envlist(
# "PC_LOCKOUT_SERVICES") at :73, _envlist("PC_LOCKOUT_SECRETS") at :79 and
# _envlist("PC_LOCKOUT_KEYRINGS") at :91. Run over that file the old pattern resolves
# TWO names (PC_LOCKOUT_CP_SVC, PC_LOCKOUT_MC_SVC at :65-66) and misses THREE.
#
# THIS IS THE OTHER HALF OF [CE-GX-ENV-SOURCES] AND MUST NOT SHIP WITHOUT IT. Adding
# lockout_check.py to GX_ENV_SOURCES alone would clear the two direct reads and leave
# the three wrapped ones still reported as set-but-read-nowhere: a HALF fix, which is
# worse than none, because the surviving third of a finding reads as newly credible
# now that two of its five names have gone away.
#
# ONLY A QUOTED LITERAL AT THE CALL SITE COUNTS, AND THAT BOUNDARY IS THE POINT.
# Matching bare identifiers, or strings anywhere near a helper name, would add names
# to gx_env_read that nothing reads -- and a name wrongly in the READ set HIDES a
# genuinely dead variable, which is this check's other job. A name reached through an
# indirection no literal can resolve does not belong in a looser regex; it belongs in
# a confession dict like ENV_READ_DYNAMIC, with its reason written down.
#
# DELIBERATELY NOT DONE: no AST pass, no call-graph. This is a lexical scanner over
# source that may have been cut on another day by another version of this file, and it
# must keep working on a tree it cannot import. The cost is that a helper added later
# is invisible until its name is added here, which is why the tuple is a reviewed
# literal and not a heuristic.
ENV_HELPERS_PY = ("_envlist",)

RE_ENV_PY = re.compile(
    r"(?:os\.environ\.get\(|os\.environ\[|(?:%s)\()"
    r"\s*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]"
    % "|".join(re.escape(h) for h in ENV_HELPERS_PY))


def scan_env_py(*sources):
    """Every variable the gate-exec image reads, under either spelling, across ALL
    of the python sources handed to it. F3.2 uses this for THE REVERSE DIRECTION: a
    variable a revision SETS that the code never READS is a lie in the install.

    *** IT MUST BE GIVEN EVERY PYTHON SOURCE IN THE IMAGE, NOT JUST exec_server.py.
    *** This scan used to be handed exec_server.py alone, and an earlier version of
    this docstring asserted, as its worked example, that PC_CREDS_SECRET is written
    onto gate-exec and "exec_server.py has never read" it. THAT CLAIM WAS FALSE IN
    THE DIRECTION THAT MANUFACTURES FINDINGS. gate-exec/pcmint.py load_creds() does

        name = os.environ.get('PC_CREDS_SECRET', '')

    and exec_server.py calls it -- `import pcmint as _M` then `_M.load_creds()` --
    on the PC_REQUIRE_ASSERTION=1 path, which is the executor's INDEPENDENT
    approval check -- a facility of the executor's own release, shipped disarmed
    -- verifying against credentials the control plane cannot write.
    gate-exec/Dockerfile COPYs
    pcmint.py, so it is in the image on every install.

    Consequence of scanning one file: F3.2 reported PC_CREDS_SECRET as
    set-but-unread on EVERY install, permanently, and that false finding was very
    nearly acted on by REMOVING the variable -- which makes load_creds() return
    {}, which exec_server.py treats as refuse-to-approve. The "cleanup" would have
    broken the executor's independent approval check outright.

    Verified before this was changed, against the real blobs: 'PC_CREDS_SECRET'
    occurs ZERO times in gate-exec/exec_server.py and ONCE in gate-exec/pcmint.py.

    A harness that invents a finding costs more than one that misses a finding: it
    teaches its readers to delete things."""
    out = set()
    for src in sources:
        for m in RE_ENV_PY.finditer(src):
            out.add(m.group(1))
    return sorted(out)


def scan_install(install_sh):
    """(invocations, naive_grep_hits, specs).

    F4.1's whole point: 'indexes composite create' occurs EXACTLY ONCE in the
    installer -- inside the pc_index helper -- so grepping it returns 1 for any
    number of indexes. Two indexes stayed missing through an audit that read the
    file carefully. COUNT THE CALL SITES. Measured on the validated tree: 6
    invocations, 1 grep hit. The work_items spec carries THREE fields, so the field
    list is parsed to exhaustion rather than assumed to be a pair."""
    specs, n_inv = [], 0
    for ln in install_sh.split("\n"):
        s = ln.strip()
        if not s.startswith("pc_index "):
            continue
        parts = s.split()
        if len(parts) < 4:
            continue
        n_inv += 1
        fields = []
        for tok in parts[3:]:
            if "," not in tok:
                break
            fp, order = tok.split(",", 1)
            fields.append([fp, order])
        specs.append({"collection": parts[1], "scope": parts[2], "fields": fields})
    grep_hits = sum(1 for ln in install_sh.split("\n")
                    if "indexes composite create" in ln)
    return n_inv, grep_hits, specs


def collect_source(tree):
    """All of the above over a checked-out tree. Pure: no cloud, no credentials."""
    def rd(p):
        with open(os.path.join(tree, p), "r", encoding="utf-8") as fh:
            return fh.read()

    index_ts = rd("control-plane/src/index.ts")
    cp_texts, cp_names, cp_absent = [index_ts], ["control-plane/src/index.ts"], []
    for _p in CP_ENV_SOURCES_EXTRA:
        try:
            cp_texts.append(rd(_p))
            cp_names.append(_p)
        except OSError:
            cp_absent.append(_p)
    cp_read, cp_nodef = scan_env_ts_many(cp_texts)
    # The dynamic names are ADDED TO "read" ONLY. They are never added to
    # "no_default": ciEnv() carries its own || fallback, so requiring them of every
    # install would be a new false positive in the opposite direction.
    cp_read = sorted(set(cp_read) | set(ENV_READ_DYNAMIC))
    # THE TRIPWIRE THAT KEEPS ENV_READ_DYNAMIC FROM GOING STALE SILENTLY. Any
    # scanned file containing an INDEXED process.env lookup is named in the bundle,
    # so a NEW file that starts reading the environment that way is visible in the
    # evidence rather than quietly unscannable.
    cp_indexed = [n for n, t in zip(cp_names, cp_texts) if "process.env[" in t]
    n_inv, n_grep, specs = scan_install(rd("oss/release/install.sh"))

    with open(os.path.join(tree, RECIPE_PIN_PATH), "rb") as fh:
        got = git_blob_oid(fh.read())

    # ONE READ OF THE ROUTE TABLE, TWO SECTIONS FED FROM IT. `tools` is None when
    # that table carried no tool list, and registered_tools is then OMITTED -- an
    # absent key, never an empty one. This file's own rule for bucket_perms says
    # why in one line: an empty list is a MEASURED answer and must never be
    # manufactured. routes.table_source.tools carries the reason it is missing.
    routes, tools = route_facts(index_ts, tree)
    source = {}
    if tools is not None:
        source["registered_tools"] = tools
    source.update({
        "cp_env_read": cp_read,
        "cp_env_no_default": cp_nodef,
        # EVERY gate-exec python source, not just exec_server.py. Missing one
        # does not soften F3.2 -- it invents a set-but-unread finding for every
        # variable only that file reads. See scan_env_py().
        "gx_env_read": scan_env_py(*[rd(p) for p in GX_ENV_SOURCES]),
        "gx_env_sources": list(GX_ENV_SOURCES),
        # WHICH FILES F3.2's FORWARD DIRECTION ACTUALLY READ, so the scope of
        # the claim is auditable from the bundle rather than inferred from
        # this file. Same reason gx_env_sources exists.
        "cp_env_sources": cp_names,
        "cp_env_sources_absent": cp_absent,
        "cp_env_indexed_sources": cp_indexed,
        "cp_env_dynamic": ENV_READ_DYNAMIC,
        "pc_index_invocations": n_inv,
        "pc_index_grep_hits": n_grep,
        "pc_index_specs": specs,
        "env_optional_reviewed": ENV_OPTIONAL_REVIEWED,
    })

    return {
        "source": source,
        "routes": routes,
        "route_baseline": json.loads(rd("control-plane/route-baseline.json")),
        "recipe_pin": "%s blob %s %s" % (
            RECIPE_PIN_PATH, got,
            "MATCHED" if got == RECIPE_PIN_OID else "DRIFTED -- expected "
            + RECIPE_PIN_OID),
    }


# ==========================================================================
# THE SESSION -- LAYER 3. The service's OWN format. NEVER PRINTS THE SECRET.
# ==========================================================================
def mint_gate_session(project, secret_name="pc-session-secret", user="operator",
                      ttl_ms=3600000):
    """gate_session = base64url(json) "." base64url(HMAC-SHA256(payload, secret)).

    waSessionOk() re-parses this payload and re-HMACs it, so the JSON spelling only
    has to be self-consistent: it reads `exp` and ignores any other field.

    THE SECRET IS READ, USED, AND DROPPED. It is never returned, never logged and
    never written into the evidence bundle -- only the boolean fact that a cookie
    was minted."""
    rc, out, err = sh("gcloud secrets versions access latest --secret=%s --project=%s"
                      % (secret_name, project))
    if rc != 0 or not out:
        return None, "secret read failed (rc=%d)" % rc

    # [DEVGATE-SECRET-NEWLINE-V1] THE TRAILING NEWLINE THAT BECAME PART OF THE HMAC KEY.
    # `gcloud secrets versions access` prints the payload AND A TRAILING NEWLINE, and
    # this was THE ONE SITE IN THIS FILE THAT FED sh()'s STDOUT INTO A CREDENTIAL
    # WITHOUT STRIPPING IT. Counted, not assumed -- all eight sh() call sites were
    # read: the two access-token readers do `tok = (out or "").strip()` and
    # `out.strip()`, id_token()'s override does `os.environ.get(...).strip()`, and the
    # remaining four consume LOG or VERSION text line by line, where a trailing newline
    # cannot change a value. Only this line did `hmac.new(out.encode(), ...)` on raw
    # stdout. So the key was `secret + "\n"`, the signature could never match
    # the one waSessionOk() recomputes over WA_SESSION_SECRET, and every console route
    # answered 401.
    #
    # IT WAS INVISIBLE BECAUSE THE FAILURE HAD THE WRONG SHAPE. This function SUCCEEDED:
    # it returned a syntactically perfect cookie and the bundle recorded
    # gate_session_minted: true, so the evidence said the gate session was fine while
    # the console routes it authenticates all came back 401. A minted-but-unusable
    # credential reads as an authorisation problem, which is what sends the reader to
    # IAM and to IAP instead of to one missing .strip().
    #
    # WHY STRIPPING IS SAFE HERE AND THE FIX IS NOT "TRY BOTH". Cloud Run injects a
    # mounted secret's bytes VERBATIM, so IF the stored payload genuinely ended in a
    # newline the service's WA_SESSION_SECRET would contain it and the stripped key
    # would be the wrong one. That is a real hazard and it is handled by RECORDING
    # rather than by guessing: the collector reports whether stripping changed anything,
    # so a run where it did AND the console still refuses has the fact it needs sitting
    # in the bundle instead of being reasoned about afterwards.
    #
    # DELIBERATELY NOT DONE: this does not mint a second cookie with the raw form and
    # probe which one the service accepts. That needs a verify callback this function
    # does not have and a caller that supplies one; adding a probe inside a minter would
    # also put a network round trip into a pure credential builder. The measurement
    # below is what makes the omission safe to leave.
    secret = out.strip()
    payload = json.dumps({"u": user,
                          "exp": int(time.time() * 1000) + ttl_ms},
                         separators=(",", ":")).encode()
    pl = base64.urlsafe_b64encode(payload).rstrip(b"=")
    sig = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), pl, hashlib.sha256).digest()).rstrip(b"=")
    note = None
    if secret != out:
        note = ("the secret read carried %d trailing/leading whitespace byte(s), which "
                "were STRIPPED before HMAC. If the console still refuses the cookie, "
                "the stored payload may genuinely contain them and the service's "
                "WA_SESSION_SECRET would then include them too."
                % (len(out) - len(secret)))
    return "gate_session=" + (pl + b"." + sig).decode(), note


def mcp_call(url, tool, args, key=None, timeout=90, token=None):
    """One MCP tools/call over the stateless POST /mcp transport.

    *** token IS NOT OPTIONAL IN PRACTICE AND OMITTING IT COST A NIGHT. ***
    [SEC-DEVGATE-403-V1] 2026-08-11. This function used to send NO Authorization
    header at all, on the reasoning that the `agent` session key is the credential.
    It is not the only one. The dev control plane's Cloud Run IAM policy grants
    roles/run.invoker to exactly two principals and has no allUsers, so an
    unauthenticated request is refused BY CLOUD RUN, at the ingress, and never
    reaches Express. That is where F1.4's "403" came from: not bucket IAM, not KMS,
    not the vault seal -- the request never got into the process that would have
    touched the lake.

    THE PROOF WAS ALREADY SITTING IN THE BUNDLE, as a natural experiment nobody
    read. Same URL, same method, same path, one variable:
      mcp_tools_list  http(..., token=tok)  -> 401 WITH x-powered-by: Express and
                                               www-authenticate: Bearer  (the APP)
      mcp_call        http(...)  no token   -> 403, no app headers    (CLOUD RUN)
    A status code with no headers beside it cannot tell you which layer refused,
    which is why the caller now records both legs' headers -- see collect_app()."""
    return http("POST", url + "/mcp", timeout=timeout, token=token,
                extra_headers={"Accept": "application/json, text/event-stream"},
                body={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": tool,
                                 "arguments": dict(args, **({"agent": key} if key
                                                            else {}))}})


def sse_frames(text):
    """Every complete Server-Sent Event in `text`, as (event_name, data_string).

    WHATWG HTML 9.2 "Interpreting an event stream", implemented rather than
    approximated. Events are separated by a BLANK line; within one event each
    `data:` field contributes a LINE and the values are joined with a NEWLINE; a
    single leading space after the colon is stripped and only one; a line
    starting with ":" is a comment; and CR, LF and CRLF are all terminators.

    A regex for `data: (.*)` gets three of those four wrong, which is why this is
    a parser and not a one-liner."""
    out, name, data = [], "", []
    for raw in re.split(r"\r\n|\r|\n", text or ""):
        if raw == "":
            if name or data:
                out.append((name, "\n".join(data)))
            name, data = "", []
            continue
        if raw.startswith(":"):
            continue
        if ":" in raw:
            field, val = raw.split(":", 1)
            if val[:1] == " ":
                val = val[1:]
        else:
            field, val = raw, ""
        if field == "data":
            data.append(val)
        elif field == "event":
            name = val
    if name or data:                       # a stream that ended without its blank line
        out.append((name, "\n".join(data)))
    return out


def ctype_of(probe):
    for k, v in ((probe or {}).get("headers") or {}).items():
        if k.lower() == "content-type":
            return str(v).lower()
    return ""


def mcp_json(probe):
    """The JSON-RPC message out of a POST /mcp response -- SSE OR plain JSON.

    *** POST /mcp ANSWERS text/event-stream AND A BARE json.loads YIELDS NOTHING. ***
    [SEC-DEVGATE-SSE-V1] MEASURED. The legacy era is served by
    @modelcontextprotocol/sdk 1.29.0's StreamableHTTPServerTransport, which writes
    an `event: message` line, then a `data:` line carrying the whole JSON-RPC
    message, then a BLANK line. The modern era's tools/call returns
    `sse:` frames explicitly (mcp2026.ts, the tools/call branch). jbody() is a bare
    json.loads, so it returned None for EVERY SUCCESSFUL MCP CALL and mcp_text()
    then yielded "". The damage that did was not subtle:
      * sha_read was e3b0c442..., the sha256 of the EMPTY STRING;
      * w_ok = 200 and "not configured" not in mcp_text(wp) was VACUOUSLY TRUE
        over "", so the bundle reported write_ok:true about a write that provably
        did not land;
      * mcp_tools_authed.tools was [] on a 200 carrying 1076 bytes of roster, which
        makes F2.3 pass VACUOUSLY today and would make it FALSELY RED on any
        install that declares a workstation.

    BOTH content types are handled because BOTH are really emitted: mcp2026.ts's
    errResponse() and its tools/list use application/json, tools/call uses SSE, and
    the legacy transport uses SSE throughout. Returns None when nothing parses --
    and None must FAIL a check, never pass one."""
    p = probe or {}
    body = p.get("body") or ""
    if ("text/event-stream" in ctype_of(p)
            or body.lstrip()[:6] in ("event:", "data: ", "data:{")):
        best = None
        for _name, data in sse_frames(body):
            if not data.strip():
                continue
            try:
                msg = json.loads(data)
            except Exception:
                continue
            if not isinstance(msg, dict) or ("result" not in msg and "error" not in msg):
                continue
            if msg.get("id") == 1:          # the id this collector always sends
                return msg
            if best is None:
                best = msg
        return best
    try:
        msg = json.loads(body)
    except Exception:
        return None
    return msg if isinstance(msg, dict) else None


def mcp_result(probe):
    """(result_object, why_not) for one MCP call. NEVER guesses from an absence.

    THE WHOLE POINT IS THAT "" IS NOT AN ANSWER. The old gate was
    `_http == 200 and "not configured" not in mcp_text(p)`, which is true over the
    EMPTY STRING -- so it could not fail, and it certified a write that never
    happened. A check that cannot fail is worse than no check, so the result is now
    DEMANDED: a 200 whose body does not parse, carries a JSON-RPC error, carries no
    result object, or is flagged isError, is a FAILURE with a named reason."""
    p = probe or {}
    if p.get("_http") != 200:
        return None, "HTTP %s" % p.get("_http")
    msg = mcp_json(p)
    if msg is None:
        return None, ("the 200 body did not parse as an MCP message (content-type "
                      "%r, %d bytes)" % (ctype_of(p) or "<none>", len(p.get("body") or "")))
    if "error" in msg:
        return None, "JSON-RPC error %s" % (json.dumps(msg.get("error"))[:300])
    res = msg.get("result")
    if not isinstance(res, dict):
        return None, "the message carried no result object"
    if res.get("isError"):
        return None, ("the tool answered isError:true saying %r"
                      % ("".join(c.get("text", "") for c in (res.get("content") or [])
                                 if isinstance(c, dict))[:300]))
    return res, None


def write_leg_ok(probe):
    """THE WRITE LEG'S SUCCESS PREDICATE, IN EXACTLY ONE PLACE.

    It lives in a function rather than inline in collect_app() so that --selftest
    drives THE SAME BYTES the build runs, instead of a paraphrase that can drift
    away from the thing it claims to test.

    Three independent conjuncts, and each one can fail on its own:
      * a genuinely PARSED result object -- not a status code, not an absence;
      * NON-EMPTY text -- this is the anti-vacuity clause. Without it the whole
        expression is true over "", which is what shipped;
      * the "not configured" silent-no-op phrase absent from text that really exists.
    """
    res, _why = mcp_result(probe)
    text = mcp_text(probe)
    return res is not None and bool(text.strip()) and "not configured" not in text


def _legacy_write_leg_ok(probe):
    """THE DEFECT ITSELF, KEPT AS A CONTROL. Do not call this from collection.

    This is the predicate that shipped. sse_selftest() asserts that it ACCEPTS an
    empty 200 while write_leg_ok() REFUSES the same input -- so the control is known
    to bite rather than asserted to. If this ever stops accepting that input the
    self-test fails loudly instead of going quietly green on a control that has
    stopped discriminating."""
    return (probe.get("_http") == 200
            and "not configured" not in mcp_text(probe))


def leg_fault(probe, why):
    """Why one leg failed, naming a LAYER only when a layer actually refused.

    refusal_layer() applied to a 200 described a SUCCESS as "refused by
    application" -- measured in a real bundle. Nobody refused a 200; whatever went
    wrong is in the payload, so it is reported as a payload fault and no layer is
    invented for it."""
    p = probe or {}
    if p.get("_http") == 200:
        return "HTTP 200 but %s" % (why or "the result was unusable")
    return "HTTP %s refused by %s" % (p.get("_http"), refusal_layer(p))


def refusal_layer(probe):
    """WHICH LAYER SAID NO. A bare status code is not a diagnosis.

    Cloud Run's ingress refusal and the application's own refusal are both 4xx and
    they mean opposite things -- one is an IAM/identity problem outside the app, the
    other is the app working correctly. They are told apart by a header ONLY THE
    APPLICATION CAN HAVE SET. A header both layers emit is not evidence, and reading
    one as though it were is [DEVGATE-REFUSAL-LAYER-V1] below."""
    h = {k.lower(): v for k, v in (probe or {}).get("headers", {}).items()}
    if not h:
        return "no-response"

    # [DEVGATE-REFUSAL-LAYER-V1] www-authenticate WAS IN THE APPLICATION TEST, AND IT
    # IS NOT AN APPLICATION MARKER. Cloud Run's own ingress refusal sets
    # `WWW-Authenticate: Bearer` too, so a request rejected AT THE INGRESS -- one that
    # never reached the container -- was reported as "application (Express answered)":
    # the exact inverse of the truth, printed with confidence, in the one field whose
    # entire job is telling those two apart. The empty JSON body is the other half of
    # the tell: an ingress or IAP refusal has an html body, jbody() returns None, and
    # the caller prints `{}`. A `401 {}` from a route whose handler returns
    # {"error":...} was always evidence that the handler never ran.
    #
    # THIS IS THE SAME FAMILY AS smoke.py's "a refusal is not an absence", AND THE TWO
    # ARE DISTINGUISHED BY WHAT THE HEADER CARRIES, NOT BY WHETHER IT IS PRESENT.
    # Verified by reading devgate/smoke.py:427 _shape(), which got this right and is
    # the model here:
    #
    #   BARE  `www-authenticate: Bearer`              -- either layer can emit it.
    #                                                    Proves NOTHING about who.
    #   `www-authenticate: Bearer resource_metadata=` -- RFC 9728. Only the
    #                                                    application knows its own
    #                                                    protected-resource metadata
    #                                                    url; the ingress has no such
    #                                                    document to advertise.
    #
    # _shape() therefore tests `"resource_metadata=" in h["www-authenticate"]` and
    # NEVER the bare presence of the key -- which is why the healthy MCP 401, the case
    # that made www-authenticate look like a good marker in the first place, still
    # classifies as the application under the stricter rule.
    #
    # ORDER IS MOST-SPECIFIC FIRST, AND A POSITIVE MARKER IS NOW REQUIRED BEFORE
    # CLAIMING THE APP ANSWERED. Silence is no longer read as agreement.
    if "x-goog-iap-generated-response" in h:
        return ("iap (Identity-Aware Proxy refused the request BEFORE the container; "
                "the body is IAP's html, not the application's JSON)")

    # Positive evidence the container answered. Express sets x-powered-by unless it is
    # explicitly disabled; this app also sets a CSP report-only header and CORS
    # headers on its own responses. resource_metadata= is the RFC 9728 discriminator
    # described above -- the app's own challenge, never the ingress's.
    app = ("x-powered-by" in h
           or "content-security-policy-report-only" in h
           or "access-control-allow-methods" in h
           or "access-control-allow-headers" in h
           or "resource_metadata=" in str(h.get("www-authenticate", "")))
    if app:
        return "application (Express answered)"

    if "google frontend" in str(h.get("server", "")).lower():
        return ("cloud-run-ingress (Google Frontend answered and NO application "
                "header came back; the request did not reach the container -- check "
                "roles/run.invoker for the calling identity on this service)")

    if "www-authenticate" in h:
        # AMBIGUOUS ON PURPOSE RATHER THAN GUESSED. Both layers emit a bare Bearer
        # challenge and nothing else here separates them; saying so is worth more
        # than a coin flip dressed as a diagnosis.
        #
        # THE WORDING IS LOAD-BEARING AND MUST NOT CONTAIN "ingress":
        # probe_oauth_pr() branches on `"ingress" in refusal_layer(p)` to decide
        # whether to re-issue the request with the ingress token, and it LABELS that
        # second leg "the keyless leg was refused by the ingress". An indeterminate
        # result must not be allowed to write that sentence into the bundle as fact.
        return ("indeterminate (a bare www-authenticate challenge with no application "
                "header and no Google Frontend marker; a bare Bearer challenge alone "
                "cannot say which layer refused)")

    return ("cloud-run-ingress (no application header came back; the request did "
            "not reach the container)")


def mcp_text(probe):
    """The text content of an MCP result, or "".

    IT RETURNS "" FOR BOTH "no text" AND "could not parse", so "" IS NOT EVIDENCE
    ABOUT THE CALL and no check may be built on its absence alone. Ask mcp_result()
    which of the two happened. This is the exact distinction whose loss made
    write_ok true over a write that never landed."""
    try:
        return "".join(c.get("text", "")
                       for c in mcp_json(probe)["result"]["content"]
                       if c.get("type") == "text")
    except Exception:
        return ""


# --------------------------------------------------------------------------
# [SEC-MCP401-RFC9728-V1] THE THREE FIELDS THE PURE JUDGE ASKS FOR.
# devgate/smoke.py reads the evidence bundle and never calls an API, so an
# assertion whose input is absent is NOT-EXERCISED -- and an unlisted
# NOT-EXERCISED forces exit 11, which OUTRANKS the exit 10 a real failure earns.
# Absence is therefore louder than failure, which is why each probe below
# RECORDS ITS FAILURE rather than omitting its key.
# --------------------------------------------------------------------------
RE_AUTH_PARAM = re.compile(r"([A-Za-z0-9_.\-]+)\s*=\s*(?:\"([^\"]*)\"|([^,\s]+))")


def parse_challenge(hdr):
    """(scheme_lowercased, {param: value}) from a WWW-Authenticate header.

    Both the quoted and the bare-token form of an auth-param are accepted (RFC
    7235 s2.1). The SCHEME is the first token and is never guessed from the
    params -- a header that carries resource_metadata under some OTHER scheme is
    not a Bearer challenge, and smoke.py's F2.2 refuses it. This mirrors
    smoke.py's _parse_challenge so the collector follows exactly the url the
    judge will later hold it to."""
    txt = str(hdr or "").strip()
    if not txt:
        return "", {}
    parts = txt.split(None, 1)
    params = {}
    for m in RE_AUTH_PARAM.finditer(parts[1] if len(parts) > 1 else ""):
        params[m.group(1).lower()] = (m.group(2) if m.group(2) is not None
                                      else m.group(3))
    return parts[0].lower(), params


def probe_oauth_pr(keyless, base, ingress_tok):
    """F2.6: ONE UNAUTHENTICATED GET of the metadata url the challenge NAMED.

    THE URL IS TAKEN FROM THE CHALLENGE, NOT CONSTRUCTED. That is the whole
    point of the assertion: smoke.py compares _url against the resource_metadata
    it parsed out of the same 401 and refuses a document fetched from anywhere
    else, because a document served from a convenient url proves nothing about
    the url clients are actually sent to. Note the challenge names oaPubBase(),
    i.e. MCP_PUBLIC_URL -- the BASE service url -- even when this probe ran
    against a revision TAG url, so this GET deliberately leaves the tag behind.

    UNAUTHENTICATED MEANS NO MCP CREDENTIAL. It is attempted with NO Authorization
    header at all first, which is the true statement of the property. In dev that
    is refused by the Cloud Run ingress rather than the app (no allUsers invoker),
    and a 403 recorded from the ingress would be a FALSE RED against a server that
    serves the document perfectly well. So on an ingress refusal it retries with
    the INGRESS token only -- transport admission, still no session key and still
    no strain-bound identity -- and records which leg produced the answer in
    _auth. The app cannot tell the difference: nothing in oaPrMeta() reads the
    caller."""
    out = {"_http": None, "_url": None, "body": None,
           "_challenge": None, "_url_source": None, "_auth": None}
    hdrs = {k.lower(): v for k, v in (keyless or {}).get("headers", {}).items()}
    raw = hdrs.get("www-authenticate")
    out["_challenge"] = raw
    scheme, params = parse_challenge(raw)
    rm = str(params.get("resource_metadata") or "").strip()
    if rm:
        url, src = rm, "challenge"
    else:
        # NO usable challenge. F2.2 already fails loudly for that reason, so the
        # conventional path is measured instead of leaving F2.6 unexercised --
        # an ABSENT field would force exit 11 and MASK the exit 10 F2.2 earned.
        # It is labelled, never passed off as challenge-derived.
        url = str(base or "").rstrip("/") + "/.well-known/oauth-protected-resource"
        src = ("fallback: the %s response carried no usable resource_metadata "
               "(scheme=%r), so this is the CONVENTIONAL path and NOT a url this "
               "server actually advertised"
               % ((keyless or {}).get("_http"), scheme))
    out["_url"], out["_url_source"] = url, src

    p = http("GET", url)
    out["_auth"] = "none (no Authorization header)"
    if p.get("_http") in (401, 403) and "ingress" in refusal_layer(p):
        p2 = http("GET", url, token=ingress_tok)
        out["_auth_first_leg"] = {"_http": p.get("_http"),
                                  "refused_by": refusal_layer(p)}
        p = p2
        out["_auth"] = ("cloud-run INGRESS token only (no session key, no "
                        "strain-bound identity). The keyless leg was refused by "
                        "the ingress and never reached the application.")
    out["_http"] = p.get("_http")
    out["body"] = jbody(p)
    out["_refused_by"] = None if p.get("_http") == 200 else refusal_layer(p)
    if p.get("_http") == 200 and out["body"] is None:
        out["_parse_error"] = ("200 but the body is not JSON: %r"
                               % (p.get("body") or "")[:200])
    return out


def probe_tools_authed(target, tok, tok_channel):
    """F2.3: an AUTHENTICATED tools/list -- the roster the RUNNING server admits.

    THE ONLY CHANNEL THAT CAN AUTHENTICATE THIS CALL IS THE OIDC BEARER. tools/list
    carries no arguments, so the `agent` session key has nowhere to live (mcp_call
    puts it in params.arguments); index.ts:6412 makes listing an explicit carve-out
    from key enforcement, and identity comes from oaStrainFromOidc alone.

    IT IS RECORDED EVEN WHEN IT FAILS, AND THAT IS THE REQUIREMENT. Omitting the
    key on failure would make F2.3 NOT-EXERCISED (exit 11, which outranks a real
    failure's exit 10) and would hide a measured refusal behind an absence. A
    non-200 record is harmless to the judge -- _live_tool_names() accepts a roster
    only from a 200 -- so the failure is visible without ever being mistaken for
    an empty tool list."""
    p = http("POST", target + "/mcp", token=tok,
             extra_headers={"Accept": "application/json, text/event-stream"},
             body={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    tools = [t["name"] for t in
             (((mcp_json(p) or {}).get("result") or {}).get("tools") or [])
             if t.get("name")]
    out = {"_http": p.get("_http"), "tools": tools,
           "headers": p.get("headers", {}), "_identity_channel": tok_channel}
    if p.get("_http") != 200:
        out["_refused_by"] = refusal_layer(p)
        out["_error"] = (
            "AUTHENTICATED tools/list did not answer 200, so this bundle carries "
            "NO live tool roster and F2.3 must fall back to vm_route_probes. "
            "HTTP %s, refused by %s, identity channel %s. This is recorded rather "
            "than omitted on purpose: an absent key is NOT-EXERCISED (exit 11) "
            "and would outrank any real failure in the same run."
            % (p.get("_http"), refusal_layer(p), tok_channel))
    return out


def probe_vm_routes(target, tok, cookie):
    """F2.3: the three /api/vm/* routes, and ONLY the ones actually reached.

    ({route: {_http}}, {route: {_http, why}}) -- measured, and unmeasured.

    *** A waGate REFUSAL IS NOT A ROUTE ANSWER. *** All three routes are wrapped in
    waGate (index.ts:3946-3948), which answers 403 "unlock the gate first" BEFORE
    the handler runs, and the harVmUnset() 503 this assertion is about is emitted
    INSIDE the handler. So a probe without a valid gate session can only ever see
    403 -- and smoke.py treats any non-503 as proof the route "answered anyway",
    which would be a FALSE RED manufactured by our own missing cookie. That is
    exactly the class of defect the bucket_perms sentinel below was fixed for, so
    it is not reintroduced here: a route we could not reach is reported as
    UNMEASURED and is kept out of the measured map entirely."""
    got, unmeasured = {}, {}
    for route in ("GET /api/vm/status", "POST /api/vm/start", "POST /api/vm/stop"):
        method, path = route.split(" ", 1)
        p = http(method, target + path, token=tok, cookie=cookie,
                 body={} if method == "POST" else None)
        code, layer = p.get("_http"), refusal_layer(p)
        gate_refused = (code == 403
                        and "unlock the gate" in str(p.get("body") or "").lower())
        if gate_refused or "ingress" in layer:
            unmeasured[route] = {
                "_http": code, "refused_by": layer,
                "why": ("the request never reached the route handler -- it was "
                        "stopped by %s. harVmUnset()'s 503 is emitted INSIDE the "
                        "handler, so this says nothing about whether the VM guard "
                        "holds, and recording it as a route answer would "
                        "manufacture a false failure."
                        % ("waGate (no console session)" if gate_refused
                           else "the Cloud Run ingress"))}
        else:
            got[route] = {"_http": code, "refused_by": None if code == 503 else layer}
    return got, unmeasured


# ==========================================================================
# CLOUD READS. Never judges. A failed probe is RECORDED, never raised.
# ==========================================================================
def rev_wrap(rev):
    """WRAP A v2 REVISION IN A "template" KEY. THIS IS NOT COSMETIC.

    judge() reads cp_rev.get("template", cp_rev) and tolerates either shape, but
    seeds() _cpenv_set()/_gxenv_set() (smoke.py:1116-1129) index
    ev["cp_revision"]["template"]["containers"] UNCONDITIONALLY. A flat v2 revision
    -- which is what run.googleapis.com/v2 returns, with `containers` at top level
    -- therefore raises KeyError inside selftest(), main() takes its except branch,
    and A PERFECTLY HEALTHY DEPLOYMENT REPORTS VERDICT 12
    FUNCTIONAL-EVIDENCE-MISSING. Measured by reading the judge against the resource."""
    rev = rev or {}
    return {"name": rev.get("name", ""),
            "template": {"containers": rev.get("containers", []) or []},
            "serviceAccount": rev.get("serviceAccount", "")}


def env_of(rev):
    """The same rule smoke.py's _env_of uses, so collector and judge agree on what a
    revision's environment IS. Secret-backed vars become a MARKER; this file never
    records a secret value."""
    out = {}
    for c in (rev or {}).get("template", rev or {}).get("containers", []) or []:
        for e in c.get("env", []) or []:
            if "value" in e:
                out[e["name"]] = e["value"]
            else:
                out[e["name"]] = "<secret:%s>" % (
                    e.get("valueSource", {}).get("secretKeyRef", {}).get("secret", "?"))
    return out


def named_secret_names(*envmaps):
    """Every secret name a revision NAMES, under either spelling:
      * a secret-backed env var        -> valueSource.secretKeyRef.secret
      * a value that is a secret PATH  -> projects/<p>/secrets/<name>
    The second spelling is the one that matters: install.sh 7/10 writes
    PC_CREDS_SECRET=projects/$PROJECT/secrets/<the executor's credential store>
    onto gate-exec as a plain VALUE. A scan that looked only at secretKeyRef would
    see nothing at all.

    NOTE, because these two are easy to confuse: F3.3 asks "does the secret this
    revision NAMES exist?" and it is a real question about the install. F3.2 asks
    "does anything READ this variable?" and for PC_CREDS_SECRET the answer is YES,
    in gate-exec/pcmint.py -- see scan_env_py()."""
    out = set()
    for env in envmaps:
        for v in (env or {}).values():
            v = str(v or "")
            if v.startswith("<secret:") and v.endswith(">"):
                out.add(v[8:-1])
            m = re.search(r"projects/[^/]+/secrets/([A-Za-z0-9_-]+)", v)
            if m:
                out.add(m.group(1))
    out.discard("?")
    return sorted(out)


def drift_witness():
    """RUNBOOK.md: the pip line in gate-exec/Dockerfile is UNPINNED, so the same
    recipe yields different bytes over time in dev and in prod INDEPENDENTLY. This
    block makes drift VISIBLE in every transcript. It is a WITNESS, NOT A
    GUARANTEE, and the report says so."""
    d = {}
    _, out, _ = sh("python3 -VV")
    d["python"] = (out or "").strip().split("\n")[0]
    _, out, _ = sh("pip3 list --format=freeze 2>/dev/null || pip list --format=freeze")
    have = {}
    for ln in (out or "").splitlines():
        if "==" in ln:
            k, v = ln.split("==", 1)
            have[k.strip().lower()] = v.strip()
    for want in ("flask", "cryptography", "google-cloud-firestore",
                 "google-cloud-storage"):
        d[want] = have.get(want, "ABSENT")
    return d


def collect_cloud(a, ev):
    at = access_token()
    ev["access_token_channel"] = _AT.get("channel", "")
    P, R = a.project, a.region
    # THE STATUS OF EVERY SERVICE READ IS RECORDED. It used to be thrown away by
    # `jbody(...) or {}`, and jbody() PARSES ERROR BODIES -- so a 403 became an
    # empty service, an empty service became an empty revision, and an empty
    # revision became "the variable is unset" in five separate findings about a
    # deployment nobody had managed to read. See starvation_report().
    ev["service_reads"] = {}

    def runsvc(name):
        p = http("GET", "https://run.googleapis.com/v2/projects/%s/locations/"
                 "%s/services/%s" % (P, R, name), token=at)
        ev["service_reads"][name] = {"_http": p.get("_http"),
                                     "_error": p.get("_error")}
        # NOT jbody(p) or {} -- a refusal is not a service with no configuration.
        return (jbody(p) or {}) if p.get("_http") == 200 else {}

    def runrev(full):
        return jbody(http("GET", "https://run.googleapis.com/v2/" + full,
                          token=at)) or {} if full else {}

    # ---- F0: the revision the deploy JUST created, never the serving one -------
    cp_svc = runsvc(a.service)
    ev["cp_latest_created"] = cp_svc.get("latestCreatedRevision", "")
    ev["cp_revision"] = rev_wrap(runrev(ev["cp_latest_created"]))
    ev["cp_sa"] = ev["cp_revision"].get("serviceAccount", "")
    ev["iap_enabled_before"] = cp_svc.get("iapEnabled")
    ev["traffic_before"] = [{"revision": t.get("revision"), "percent": t.get("percent"),
                             "tag": t.get("tag")} for t in cp_svc.get("traffic", [])]

    gx_svc = runsvc(a.gate_exec)
    ev["gx_revision"] = rev_wrap(runrev(gx_svc.get("latestCreatedRevision", "")))
    ev["gx_sa"] = ev["gx_revision"].get("serviceAccount", "")

    cpenv, gxenv = env_of(ev["cp_revision"]), env_of(ev["gx_revision"])

    base = cp_svc.get("uri") or ""
    target = base
    for t in cp_svc.get("trafficStatuses", []) or []:
        if a.tag and t.get("tag") == a.tag and t.get("uri"):
            target = t["uri"]
            ev["target_revision"] = t.get("revision")
    ev["base_url"], ev["target_url"] = base, target

    # ---- the nested image build: where route-audit.mjs ACTUALLY printed --------
    nested = (cp_svc.get("buildConfig") or {}).get("name", "").split("/")[-1]
    ev["nested_image_build_id"] = nested
    if nested and not a.skip_logs:
        rc, out, err = sh("gcloud builds log %s --region=%s --project=%s"
                          % (nested, R, P), timeout=240)
        log = out if rc == 0 else (out + err)
        ev["nested_image_build_log_bytes"] = len(log)
        ev["route_audit_stdout"] = "\n".join(
            l for l in log.splitlines()
            if "ROUTE AUDIT" in l
            or l.strip().startswith(("total routes", "guarded", "public", "no ")))
        ev["blob_audit_stdout"] = "\n".join(l for l in log.splitlines()
                                            if "BLOB AUDIT" in l)

    # ---- F1.2 / F1.3: the lake bucket and who can actually read it -------------
    bucket = cpenv.get("DATA_LAKE_BUCKET", "")
    ev["bucket_get"] = None
    # None, not [] -- see the block below. This default is reached when no bucket is
    # configured at all, which is the emptiest "we did not measure" there is.
    ev["bucket_perms"] = {"permissions": None, "measured": False, "_http": None,
                          "unmeasured_reason": "no DATA_LAKE_BUCKET is configured, "
                                               "so there was nothing to ask about"}
    if bucket and not bucket.startswith("<secret:"):
        p = http("GET", "https://storage.googleapis.com/storage/v1/b/" + bucket,
                 token=at)
        b = jbody(p) or {}
        ev["bucket_get"] = {"_http": p.get("_http"), "name": b.get("name"),
                            "location": b.get("location")}
        # F1.3 asks about THE CONTROL PLANE's permissions, not the builder's.
        # testPermissions answers for THE CALLER, so the caller must BE the control
        # plane.
        #
        # *** AN UNMEASURABLE RESULT MUST BE IMPOSSIBLE TO READ AS A MEASURED
        # DENIAL. THIS CODE USED TO MAKE THEM IDENTICAL, AND IT COST A WRONG
        # DIAGNOSIS. ***
        #
        # The old form was:
        #     "permissions": [] if chan == "IMPERSONATION-FAILED" else (...)
        # An EMPTY LIST is a positive claim: "we asked, as the control plane, and it
        # holds none of these." That is a genuine IAM finding and it reads as one.
        # Emitting the same empty list when we could not ask AT ALL makes the two
        # states byte-identical in the field the judge actually reads, so F1.3
        # printed "missing storage.objects.create,storage.objects.get" -- a specific,
        # confident, WRONG accusation against the control plane's IAM -- when the
        # truth was that the BUILD SA lacks serviceAccountTokenCreator. The
        # bucket_perms_channel breadcrumb was already there and nobody read it,
        # because the primary field looked like an answer.
        #
        # permissions is now None whenever the question was not answered, and None
        # is not a list of things you do not have. The same rule is applied one
        # layer down: a testPermissions call that does not return 200 did not
        # measure a denial either, and manufacturing [] from a refusal would
        # reintroduce the identical defect under a different cause.
        qs = "&".join("permissions=storage.objects." + x
                      for x in ("create", "get", "list", "delete"))
        tok, chan, why = at, "builder-adc", ""
        if ev["cp_sa"]:
            rc, out, err = sh("gcloud auth print-access-token "
                              "--impersonate-service-account=%s" % ev["cp_sa"])
            if rc == 0 and out.strip():
                tok, chan = out.strip(), "impersonated:" + ev["cp_sa"]
            else:
                chan = "IMPERSONATION-FAILED"
                why = ("could not impersonate %s (rc=%d), so F1.3 WAS NOT MEASURED. "
                       "The permission list is None -- NOT an empty list -- because "
                       "an empty list would assert that the control plane was asked "
                       "and holds nothing, which is a different and much more "
                       "alarming claim than 'we could not ask'. Reporting the "
                       "BUILDER's access here would be worse still. Fix: grant the "
                       "build SA roles/iam.serviceAccountTokenCreator on %s."
                       % (ev["cp_sa"], rc, ev["cp_sa"]))
        if chan == "IMPERSONATION-FAILED":
            # NOT CALLED AT ALL. Calling it as the builder would produce a real
            # 200 describing the WRONG PRINCIPAL, which is the most convincing
            # wrong answer available.
            ev["bucket_perms"] = {"permissions": None, "measured": False,
                                  "_http": None, "unmeasured_reason": why}
        else:
            pp = http("GET", "https://storage.googleapis.com/storage/v1/b/%s/iam/"
                      "testPermissions?%s" % (bucket, qs), token=tok)
            if pp.get("_http") != 200:
                ev["bucket_perms"] = {
                    "permissions": None, "measured": False,
                    "_http": pp.get("_http"),
                    "unmeasured_reason": (
                        "testPermissions as %s -> HTTP %s, so no permission set was "
                        "returned and F1.3 WAS NOT MEASURED. permissions is None "
                        "rather than [] so this refusal cannot be read as 'the "
                        "control plane holds nothing'." % (chan, pp.get("_http")))}
            else:
                ev["bucket_perms"] = {
                    "permissions": (jbody(pp) or {}).get("permissions", []) or [],
                    "measured": True, "_http": 200}
        ev["bucket_perms_channel"] = chan
        if why:
            ev["bucket_perms_error"] = why

    # ---- F2.3: the VM the five VM tools point at ------------------------------
    vm, zone = cpenv.get("WS_VM", ""), cpenv.get("WS_ZONE", "")
    ev["vm_instance"] = None
    if vm and zone:
        vp = http("GET", "https://compute.googleapis.com/compute/v1/projects/%s/zones/"
                  "%s/instances/%s" % (P, zone, vm), token=at)
        ev["vm_instance"] = {"_http": vp.get("_http"),
                             "status": (jbody(vp) or {}).get("status")}

    # ---- F4.2: the indexes must EXIST. Acceptance is not evidence. ------------
    #
    # *** NO pageSize ON THIS URL. THE API REFUSES IT. *** MEASURED against the
    # live dev database:
    #   GET .../collectionGroups/-/indexes?pageSize=300
    #       -> 400 INVALID_ARGUMENT "Invalid page size. Only 0 is supported."
    #   GET .../collectionGroups/-/indexes
    #       -> 200, six indexes, all state READY
    # firestore.googleapis.com is the endpoint that refuses the parameter. The
    # Secret Manager list below takes ?pageSize=300 and answers 200 -- measured --
    # so do NOT "tidy" that one to match this one.
    #
    # WHY THIS WAS INVISIBLE FOR SO LONG, and it is the part worth remembering:
    # jbody() PARSES THE ERROR BODY. The 400 came back as a well-formed JSON error
    # document, so `idx` was a dict rather than None, `.get("indexes", [])` was [],
    # and F4.2 reported "6 of 6 index(es) absent" -- a census failure the promotion
    # gate refuses on -- over six indexes that were all READY. The parameter is
    # gone AND the status now decides: a refusal is recorded as MISSING EVIDENCE,
    # never as an empty index set.
    fdb = cpenv.get("PC_FIRESTORE_DB", a.firestore_db)
    ip = http("GET", "https://firestore.googleapis.com/v1/projects/%s/databases/%s/"
              "collectionGroups/-/indexes" % (P, fdb), token=at)
    idx = jbody(ip) if ip.get("_http") == 200 else None
    if idx is None:
        ev["firestore_indexes"] = None
        ev["firestore_indexes_error"] = (
            "indexes list -> HTTP %s. Recorded as ABSENT EVIDENCE, never as an "
            "empty index set: a refused request says nothing about which indexes "
            "exist." % ip.get("_http"))
    else:
        out = []
        for ix in idx.get("indexes", []) or []:
            # The collection group lives only in the resource name; the judge matches
            # on a "_collectionGroup" key, so it is lifted here, not re-parsed there.
            m = re.search(r"/collectionGroups/([^/]+)/indexes/", ix.get("name", ""))
            out.append({"_collectionGroup": m.group(1) if m else "",
                        "queryScope": ix.get("queryScope"), "state": ix.get("state"),
                        "fields": ix.get("fields", [])})
        ev["firestore_indexes"] = out

    # ---- F5.1 / F5.2: the approval key, and that the VERIFIER cannot sign -----
    # THE KEY IS READ OFF THE DEPLOYMENT WHEN THE DEPLOYMENT NAMES IT. --keyring
    # defaults to the un-namespaced fleet name, and install.sh namespaces the keyring
    # per lane (paracoding-<lane>-approvals). In a single-project layout the default
    # therefore resolves to ANOTHER LANE'S KEY: F5.1/F5.2 would return a healthy read
    # of a key this deployment does not sign with, and the lane's own key would go
    # unmeasured while the report said PASS. Deriving it from
    # APPROVAL_SIG_KEY_VERSION -- the variable the control plane actually signs with
    # -- measures the key in use instead of the key someone expected. Only a value
    # carrying a full resource path is trusted; anything shorter falls through to the
    # flags, which is exactly today's behaviour.
    kn = "projects/%s/locations/%s/keyRings/%s/cryptoKeys/%s" % (P, R, a.keyring, a.key)
    ev["kms_key_channel"] = "--keyring/--key"
    _kv = (cpenv.get("APPROVAL_SIG_KEY_VERSION") or "").strip()
    if "/keyRings/" in _kv and "/cryptoKeys/" in _kv:
        _head = _kv.split("/cryptoKeyVersions/")[0]
        if _head.startswith("projects/") and _head.count("/") == 7:
            kn = _head
            ev["kms_key_channel"] = ("APPROVAL_SIG_KEY_VERSION on the deployed "
                                     "revision")
    kp = http("GET", "https://cloudkms.googleapis.com/v1/" + kn, token=at)
    kb = jbody(kp) or {}
    ev["kms_key"] = {"_http": kp.get("_http"), "purpose": kb.get("purpose"),
                     "versionTemplate": kb.get("versionTemplate")}
    ev["kms_key_iam"] = jbody(http("GET", "https://cloudkms.googleapis.com/v1/" + kn
                                   + ":getIamPolicy", token=at))

    # ---- F3.3: every secret a revision NAMES must exist -----------------------
    # ?pageSize=300 IS CORRECT HERE and is deliberately not matched to the
    # Firestore call above: secretmanager.googleapis.com accepts it and answers
    # 200. Measured. Two different APIs, two different answers.
    want = named_secret_names(cpenv, gxenv)
    sp = http("GET", "https://secretmanager.googleapis.com/v1/projects/%s/secrets"
              "?pageSize=300" % P, token=at)
    have = {s.get("name", "").split("/")[-1]
            for s in (jbody(sp) or {}).get("secrets", []) or []}
    ev["named_secrets"] = {n: (n in have) for n in want}
    ev["named_secrets_channel"] = (
        "secretmanager list -> %d secret(s)" % len(have) if sp.get("_http") == 200
        else "secretmanager list FAILED HTTP %s -- every name below reads as absent, "
             "so F3.3 fails on a read error rather than on a missing secret. That is "
             "fail-closed, and this line is how a reader tells the two apart."
             % sp.get("_http"))
    # THE SURFACE READ HAPPENS HERE, NOT IN collect_app, AND THE ORDER IS THE POINT.
    # collect_app toggles IAP OFF around its probes; F6.2 asserts that the console is
    # IAP-fronted and reads the header IAP generates. Probing the console inside that
    # window would measure a console with IAP deliberately removed and report the
    # removal as the defect.
    try:
        collect_surfaces(a, ev, at, base, a.lake or bucket)
    except Exception:
        import traceback
        ev["surfaces_error"] = traceback.format_exc()[:2000]

    # ---- F2.4: the GIT bucket. NOT the lake bucket. ---------------------------
    # THIS ASSERTION DID NOT TOUCH THE GIT VAULT AT ALL AND WOULD HAVE RETURNED A
    # MANUFACTURED GREEN. The name was `a.lake or DATA_LAKE_BUCKET or
    # <project>-datalake` -- three ways of naming the DATA LAKE, none of which is
    # the bucket the git tools use. gittools.ts registerGitTools() reads
    # GIT_REPO_ID and GIT_BUCKET and RETURNS [] unless BOTH are non-empty, with no
    # fallback of any kind; the requirement text on smoke.py's F2.4 still cites an
    # index.ts fallback to <project>-datalake that does not exist at this commit.
    # install.sh:1487/3951 sets GIT_BUCKET=<project>-<lane>-source and GIT_REPO_ID
    # on the MCP SERVICE ONLY, which is why the console environment can never
    # supply it and why the surface revision is read here.
    #
    # THE HISTORICAL ORDER IS PRESERVED BELOW GIT_BUCKET, so a deployment that
    # genuinely has no git tools configured resolves exactly what it resolved
    # before and F2.4 says exactly what it said before.
    _mcp_rev = ((ev.get("surfaces") or {}).get("mcp") or {}).get("revision") or {}
    _gitenv = dict(cpenv)
    _gitenv.update(env_of(_mcp_rev))
    _gitbucket = (_gitenv.get("GIT_BUCKET") or "").strip()
    _gitrepo = (_gitenv.get("GIT_REPO_ID") or "").strip()
    gvname = _gitbucket or a.lake or bucket or (P + "-datalake")
    ev["gitvault_bucket_channel"] = (
        "GIT_BUCKET on the surface that registers the git tools" if _gitbucket else
        ("--lake -- NO GIT_BUCKET IS SET ANYWHERE, so this is the LAKE bucket and "
         "it is not evidence about the git vault" if a.lake else
         ("DATA_LAKE_BUCKET on the revision -- NO GIT_BUCKET IS SET ANYWHERE, so "
          "this is the LAKE bucket and it is not evidence about the git vault"
          if bucket else "fallback <project>-datalake -- NO GIT_BUCKET IS SET "
                         "ANYWHERE and nothing about the git vault was measured")))
    ev["gitvault_bucket_name"] = gvname
    # BOTH VARIABLES OR NO TOOLS. Recorded so a reader can tell "the bucket exists"
    # from "the seven git tools are actually registered", which are not the same
    # claim and which F2.4 as written cannot distinguish.
    ev["gitvault_tools_configured"] = {
        "GIT_BUCKET": _gitbucket or None,
        "GIT_REPO_ID": _gitrepo or None,
        "registered": bool(_gitbucket and _gitrepo),
        "rule": "gittools.ts registerGitTools() returns [] -- all seven tools "
                "withheld -- unless GIT_REPO_ID and GIT_BUCKET are BOTH non-empty."}
    gp = http("GET", "https://storage.googleapis.com/storage/v1/b/" + gvname, token=at)
    ev["gitvault_bucket_get"] = {"_http": gp.get("_http"),
                                 "name": (jbody(gp) or {}).get("name")}

    return cpenv, base, target


def collect_surfaces(a, ev, at, console_uri, lake=""):
    """[SEC-LANE-ADDRESSABLE-V1] THE SECOND SURFACE, WITHOUT WHICH F6 CANNOT BE
    JUDGED AT ALL -- AND THE GAP IS A FAIL, NOT A SKIP.

    smoke.py:_split_evidence() reads ev["surfaces"] and PC_SURFACE on the control
    plane. Nothing in this collector has ever written ev["surfaces"], so on any
    install where install.sh set PC_SURFACE=console -- which is EVERY two-service
    install it produces -- _split_evidence returns "half" and F6.0 FAILS. The judge
    is right to fail: half a split judged as a whole is the exact defect F6 exists
    to catch. The collector was the half that was missing.

    OFF BY DEFAULT. --mcp-service is empty unless a caller names the second
    surface, so a single-service install collects exactly what it always did and
    F6 skips exactly as it always did.

    EVERY PROBE HERE IS ANONYMOUS AND READ-ONLY. F6.2/F6.3/F6.4/F6.6 classify a
    refusal BY ITS HEADERS, and an authenticated probe destroys the very thing they
    read: a token gets the caller past the Cloud Run frontend and past IAP, so the
    header that says which one answered never appears. No token is sent, nothing is
    written, and no IAM is changed.

    WHAT IS NOT COLLECTED, AND SAID OUT LOUD RATHER THAN FAKED:
      * routes_withheld -- it is printed by the console container at boot and lives
        in the image build log, not in any API. Left absent; F6.5 treats absent as
        "not reported" and judges on PC_SURFACE_MAP instead.
      * allusers_refusal -- the org-policy refusal text is produced by ATTEMPTING the
        allUsers binding, which is a WRITE. A read-only collector cannot honestly
        produce it, and it must NEVER be derived from an org-policy READ: a policy
        that forbids the binding is not evidence that the binding was attempted, and
        excusing F6.7 on it would certify a transport nobody can use. So the INSTALLER
        records its own outcome -- install.sh 8/10, [SEC-INVOKER-RECORD-V1] -- and
        collect_invoker_record() below reads that record back and carries the LITERAL
        gcloud stderr across unchanged. THIS FILE CLASSIFIES NOTHING: smoke.py matches
        ORG_POLICY_MARKERS itself, so a refusal that is not the org-policy refusal
        still fails F6.7. Every rejection path leaves allusers_refusal ABSENT."""
    mc_name = (a.mcp_service or "").strip()
    ev["surfaces_channel"] = ("--mcp-service " + mc_name if mc_name else
                              "no second surface was named (--mcp-service is empty), "
                              "so ev.surfaces is omitted and F6 judges this as a "
                              "single-service install")
    if not mc_name:
        return
    P, R = a.project, a.region

    def svc(name):
        return jbody(http("GET", "https://run.googleapis.com/v2/projects/%s/locations/"
                          "%s/services/%s" % (P, R, name), token=at)) or {}

    def rev(full):
        return jbody(http("GET", "https://run.googleapis.com/v2/" + full,
                          token=at)) or {} if full else {}

    def iam(name):
        return jbody(http("GET", "https://run.googleapis.com/v2/projects/%s/locations/"
                          "%s/services/%s:getIamPolicy" % (P, R, name), token=at)) or {}

    def hdr(pr):
        return {"_http": pr.get("_http"), "_url": pr.get("_url"),
                "headers": pr.get("headers") or {}}

    mc_svc = svc(mc_name)
    mc_uri = mc_svc.get("uri") or ""
    ev["surfaces"] = {
        "console": {
            "service": a.service,
            "revision": rev_wrap(rev(ev.get("cp_latest_created", ""))),
            "run_iam": iam(a.service),
            "probe_root": hdr(http("GET", console_uri)) if console_uri else None,
        },
        "mcp": {
            "service": mc_name,
            "revision": rev_wrap(rev(mc_svc.get("latestCreatedRevision", ""))),
            "run_iam": iam(mc_name),
            "probe_root": hdr(http("GET", mc_uri)) if mc_uri else None,
            "probe_mcp": hdr(http("POST", mc_uri + "/mcp",
                                  body={"jsonrpc": "2.0", "id": 1,
                                        "method": "tools/list", "params": {}},
                                  extra_headers={"Accept": "application/json, "
                                                           "text/event-stream"}))
                         if mc_uri else None,
            "uri": mc_uri,
        },
    }
    collect_invoker_record(ev, mc_name, lake,
                           getattr(a, "invoker_record", ""), at)


def collect_invoker_record(ev, mc_name, lake, rec_path, at):
    """[SEC-INVOKER-RECORD-V1] READ BACK THE ONE F6 FACT NO READ CAN PRODUCE.

    smoke.py F6.7 asks whether allUsers holds roles/run.invoker on the MCP service,
    and it ALREADY excuses a missing binding when the bundle carries an org-policy
    refusal: _invoker_refusal() reads surfaces.mcp.allusers_refusal and matches it
    against ORG_POLICY_MARKERS. NOTHING HAD EVER WRITTEN THAT KEY, so in an org with
    constraints/iam.allowedPolicyMemberDomains F6.7 failed on every run and no amount
    of collecting could change it -- the refusal is the stderr of a WRITE, and this
    file does not write. install.sh 8/10 now records its own outcome to the object
    --invoker-record names, and this reads it back.

    IT IS A COURIER, NOT A JUDGE. The literal gcloud text crosses unchanged and
    smoke.py decides whether it is an org-policy refusal. A refusal matching no marker
    still FAILS F6.7, which is what stops "refused" from becoming a blanket excuse.

    EVERY REJECTION PATH LEAVES allusers_refusal ABSENT, AND ABSENT IS A FAIL.
    No bucket, no path, a missing object, a non-200, an unparseable body, a record
    naming a DIFFERENT service, a "granted" outcome, or an empty stderr: each writes a
    channel sentence and NO refusal. An unread record is not a refusal, and an absent
    record is not an excuse."""
    mcp = (ev.get("surfaces") or {}).get("mcp")
    if not isinstance(mcp, dict):
        return

    def no(why):
        mcp["allusers_record_channel"] = "NO REFUSAL RECORDED: " + why

    lake = (lake or "").strip()
    rec_path = (rec_path or "").strip()
    if not lake or lake.startswith("<secret:") or not rec_path:
        no("no lake bucket or record path resolved for this collection, so nothing "
           "was looked up. F6.7 judges on the live IAM binding alone.")
        return
    url = ("https://storage.googleapis.com/storage/v1/b/%s/o/%s?alt=media"
           % (lake, urllib.request.quote(rec_path, safe="")))
    pr = http("GET", url, token=at)
    mcp["allusers_record_source"] = {"_http": pr.get("_http"), "_url": url}
    # GATED ON THE STATUS, NOT ON THE PAYLOAD. A 404 from the JSON API is a perfectly
    # well-formed JSON error document, so parsing first would turn "no record" into a
    # dict and every field below into a confident None. See jbody()'s docstring.
    if pr.get("_http") != 200:
        no("gs://%s/%s -> HTTP %s. An unread record is not an absent refusal, and it "
           "is not an excuse either." % (lake, rec_path, pr.get("_http")))
        return
    try:
        rec = json.loads(pr.get("body") or "")
    except Exception:
        rec = None
    if not isinstance(rec, dict):
        no("gs://%s/%s answered 200 but did not parse as a JSON object"
           % (lake, rec_path))
        return
    mcp["allusers_record"] = rec
    got = str(rec.get("service") or "")
    if got != mc_name:
        no("the record names service %r and this collection read %r -- a record about "
           "another service excuses nothing about this one" % (got, mc_name))
        return
    outcome = str(rec.get("outcome") or "")
    err = str(rec.get("gcloud_stderr") or "")
    if not outcome.startswith("refused") or not err.strip():
        no("the installer recorded outcome %r carrying %d byte(s) of gcloud stderr. "
           "Only a REFUSAL that carries its literal stderr can excuse a missing "
           "binding; 'granted' is judged on the live IAM policy like any other run."
           % (outcome, len(err)))
        return
    mcp["allusers_refusal"] = err
    mcp["allusers_record_channel"] = (
        "gs://%s/%s -- installer outcome %r at %s, %d byte(s) of LITERAL gcloud stderr "
        "carried verbatim into surfaces.mcp.allusers_refusal for smoke.py to classify "
        "against ORG_POLICY_MARKERS"
        % (lake, rec_path, outcome, rec.get("at"), len(err)))


def collect_app(a, ev, cpenv, base, target):
    """Everything that needs the app to ANSWER. IAP is toggled off around this and
    restored in the finally, AND THE RESTORE IS CONFIRMED BY RE-READING."""
    P, R = a.project, a.region
    # ---- WHICH SURFACE SERVES WHICH ROUTE, READ OFF PC_SURFACE_MAP ------------
    # index.ts:222 PC_SURFACE_MAP is the partition, and it is NOT symmetrical:
    #   POST /mcp, GET /mcp, DELETE /mcp, POST /mcp/:token          -> mcp
    #   GET /.well-known/oauth-protected-resource (and /mcp)        -> mcp
    #   GET /api/vm/status, POST /api/vm/start, POST /api/vm/stop   -> console
    #   POST /api/sessions/mint, POST /api/sessions/revoke          -> console
    #
    # EVERY MCP PROBE BELOW WENT TO `target`, WHICH IS THE CONSOLE. On the
    # two-service install install.sh actually produces, the console does not
    # register /mcp at all -- that is precisely what F6.5 asserts -- so F2.2, F2.3,
    # F2.6 and F1.MCP_WRITE_FILE_HANDLER were probing a surface that cannot answer
    # them and COULD NEVER HAVE PASSED, however complete the rest of the bundle
    # was. On a ONE-service install mcp_uri is empty, every url below is `target`
    # and every token below is the same token, byte for byte what it was.
    mcp_uri = ((ev.get("surfaces") or {}).get("mcp") or {}).get("uri") or ""
    mcp_target = mcp_uri or target
    # THE AUDIENCE FOLLOWS THE SURFACE TOO. oaStrainFromOidc pins the accepted
    # audience to MCP_PUBLIC_URL, which install.sh:3951 sets to the MCP service
    # url; a token minted for the console base is refused by the surface that has
    # to accept it.
    mcp_aud = (cpenv.get("MCP_PUBLIC_URL") or "").strip() or mcp_target
    ev["surface_routing"] = {
        "console": target, "mcp": mcp_target, "mcp_audience": mcp_aud,
        "split": bool(mcp_uri and mcp_uri != target),
        "why": "PC_SURFACE_MAP at index.ts:222 puts /mcp and the RFC 9728 metadata "
               "document on the mcp surface and /api/vm/* and /api/sessions/* on "
               "the console."}
    svc_url = ("https://run.googleapis.com/v2/projects/%s/locations/%s/services/%s"
               % (P, R, a.service))
    ev["config_changes"] = []
    ev["roundtrip"] = None
    ev["mcp_roundtrip"] = None
    ev["mcp_tools_list"] = None
    ev["oauth_protected_resource"] = None
    ev["mcp_tools_authed"] = None
    ev["vm_route_probes"] = None

    # *** THE TOGGLE IS PROJECT-FENCED. *** Disabling IAP is a real config change on
    # a real service, and the block below has always described itself as "DEV ONLY.
    # Never prod." while being fenced by nothing at all. In the single-project layout
    # a dev LANE lives in the production project, so "which project am I in" no
    # longer answers "is this safe" -- and the wrong answer takes IAP off a service
    # in the prod project for the length of the probe window.
    #
    # --iap-toggle-projects DEFAULTS TO THE PROJECT THE COLLECTOR HAS ALWAYS RUN IN,
    # so today's pipeline is bit-for-bit unchanged. Anywhere else the toggle does not
    # happen and the bundle SAYS SO, which turns a silent config change into a
    # recorded refusal. The consequence is not hidden: with IAP still in front,
    # F1.4/F1.5/F2.2 answer against IAP and are judged on what they actually saw.
    allowed = [x.strip() for x in (a.iap_toggle_projects or "").split(",") if x.strip()]
    iap_fenced = a.iap_toggle and P not in allowed
    if iap_fenced:
        ev["iap_toggle_refused"] = (
            "the IAP toggle was NOT performed: project %s is not in "
            "--iap-toggle-projects (%s). Disabling IAP is a live config change and "
            "this collector will not make one outside the projects it was told it "
            "may touch. Probes below ran with IAP still in front." % (P, allowed))
    if a.iap_toggle and not iap_fenced:
        rc, _, _ = sh("gcloud beta run services update %s --region=%s --project=%s "
                      "--no-iap --quiet" % (a.service, R, P), timeout=420)
        ev["config_changes"].append({
            "what": "iapEnabled true -> false on the dev control plane",
            "why": "IAP refuses EVERY machine ID-token audience here (four measured, "
                   "all 401 Invalid JWT audience) and it is NOT an IAM gap -- the "
                   "build SA already holds roles/iap.httpsResourceAccessor.",
            "restore": "gcloud beta run services update %s --region=%s --project=%s "
                       "--iap --quiet" % (a.service, R, P),
            "exposure": "none: the Cloud Run IAM policy has exactly one member "
                        "(the build service account, roles/run.invoker) and no "
                        "allUsers, so the invoker check remains the only way in and "
                        "it holds.",
            "disable_rc": rc,
            "scope": "DEV ONLY. Never prod. Never a shipped default."})

        # [DEVGATE-IAP-PROPAGATION-V1] WAIT ON THE OBSERVABLE CONDITION, DO NOT GUESS
        # AT A DURATION. What stood here was a literal time.sleep(30).
        #
        # THE TWO CLOCKS ARE NOT THE SAME CLOCK. `gcloud beta run services update
        # --no-iap` returns when the Cloud Run CONFIG has been written; the Google
        # Frontend stops enforcing IAP some unbounded time later. A fixed sleep
        # followed by probes that depend on the change having landed is a race BY
        # CONSTRUCTION -- and when it loses, every console probe below is refused by a
        # layer no field in the bundle names, surfacing far downstream as F1.4/F1.5
        # with `HTTP 401 {}`. The empty body is IAP's own html, which jbody() cannot
        # parse; see [DEVGATE-REFUSAL-LAYER-V1], which is the same accident read from
        # the other end.
        #
        # THIRTY SECONDS WAS NEVER A MEASUREMENT. This file records no observation that
        # propagation completes within 30s, and none is invented here: the defect is
        # not that the number was too small, it is that ANY number is a guess about
        # somebody else's control plane. The condition is directly observable, so it is
        # observed.
        #
        # THE PROBE IS UNAUTHENTICATED ON PURPOSE. It needs no identity to answer the
        # only question being asked. IAP brands its own refusals with
        # x-goog-iap-generated-response, so the DISAPPEARANCE of that header is the
        # signal. Cloud Run's own refusal -- a 401/403 with no IAP header -- means IAP
        # is out of the path, which is exactly the state the probes below require.
        # This depends on http() no longer chasing the 302 that carries that header:
        # under the old following opener this loop would have read the sign-in page's
        # headers and declared IAP gone on the first attempt. See [CE-NOREDIRECT].
        #
        # RECORDED EITHER WAY, INCLUDING THE TIMEOUT. When the console assertions fail,
        # "IAP was still in front" is the single most useful line in the bundle, so it
        # is never silent and never inferred from a missing key.
        #
        # DELIBERATELY NOT DONE: no refusal to continue on timeout. The collector's
        # contract is to RECORD what it saw, not to abort; the probes below still run
        # and are judged on what they actually met, with this field saying what that
        # was.
        _iap_t0 = time.time()
        _iap_deadline = _iap_t0 + 240
        _iap_off_after = None
        while time.time() < _iap_deadline:
            _ph = {k.lower(): v
                   for k, v in (http("GET", base) or {}).get("headers", {}).items()}
            if "x-goog-iap-generated-response" not in _ph:
                _iap_off_after = round(time.time() - _iap_t0, 1)
                break
            time.sleep(5)
        ev["iap_disable_propagation_s"] = _iap_off_after
        if _iap_off_after is None:
            ev["iap_disable_never_propagated"] = (
                "IAP was STILL branding responses with x-goog-iap-generated-response "
                "240s after --no-iap returned rc=%s. Every console probe below ran "
                "with IAP in front of the service, so their refusals say nothing "
                "about the application." % rc)

    try:
        tok = id_token(base)          # BASE URL AUDIENCE. Never the tag URL.
        # THE INGRESS TOKEN IS A SECOND, DELIBERATELY WEAKER IDENTITY. It admits a
        # request past Cloud Run and resolves to NO strain, which is precisely what
        # the keyless assertion needs. See ingress_id_token(): without this split,
        # F2.2 (must be 401) and F2.3 (needs 200) become the same request and
        # cannot both hold.
        # TWO TOKENS ON A SPLIT INSTALL, ONE ON A SINGLE-SERVICE ONE. tok stays
        # the CONSOLE token because /api/sessions/mint, /api/sessions/revoke and
        # the three /api/vm/* routes are console routes; tok_mcp carries the
        # audience the MCP surface will accept. The ingress token is minted for
        # the MCP SERVICE URL, which is what Cloud Run's frontend checks, while
        # tok_mcp carries MCP_PUBLIC_URL, which is what the application checks.
        tok_mcp = tok if mcp_aud == base else id_token(mcp_aud)
        ing = ingress_id_token(mcp_target)
        ev["id_token_channel"] = (
            "PC_SMOKE_ID_TOKEN (a dedicated smoke service account)"
            if os.environ.get("PC_SMOKE_ID_TOKEN", "").strip()
            else "metadata default (the BUILD service account -- no strain binds it)")
        ev["ingress_token_channel"] = ("metadata default (the BUILD service "
                                       "account) -- pinned, never PC_SMOKE_ID_TOKEN")
        ck, cknote = mint_gate_session(P, a.session_secret)
        ev["gate_session_minted"] = bool(ck)
        # [DEVGATE-SECRET-NEWLINE-V1] THE SECOND SLOT IS NO LONGER ALWAYS AN ERROR, so
        # it is no longer always FILED as one. mint_gate_session() now returns a NOTE
        # alongside a cookie it did mint -- the whitespace it stripped out of the secret
        # before HMACing. Writing that into gate_session_error would report a healthy
        # mint as a failure, which is the same class of lie the strip itself fixed.
        if cknote:
            ev["gate_session_note" if ck else "gate_session_error"] = cknote

        # F2.2: the surface must ANSWER. tools/list needs no key; with
        # PC_SESSION_ENFORCE=1 a keyless list is `whoami` only, and that is the
        # documented expected shape -- the assertion is that it answers.
        lp = http("POST", mcp_target + "/mcp", token=ing,
                  extra_headers={"Accept": "application/json, text/event-stream"},
                  body={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        ev["mcp_tools_list"] = {
            "_http": lp.get("_http"), "headers": lp.get("headers", {}),
            "_identity_channel": ev["ingress_token_channel"],
            "tools": [t["name"] for t in
                      (((mcp_json(lp) or {}).get("result") or {}).get("tools") or [])
                      if t.get("name")]}

        # ---- F2.6: follow the challenge to the metadata document --------------
        ev["oauth_protected_resource"] = probe_oauth_pr(lp, mcp_target, ing)

        # ---- F2.3: the live roster, and the three fail-closed VM routes -------
        # EITHER ONE ALONE promotes F2.3 from NOT-EXERCISED to a real verdict, so
        # both are collected: the roster needs an IAM grant that is still pending,
        # the routes need only the gate session this collector already mints.
        ev["mcp_tools_authed"] = probe_tools_authed(mcp_target, tok_mcp,
                                                    ev["id_token_channel"])
        _vm_got, _vm_un = probe_vm_routes(target, tok, ck)
        ev["vm_route_probes"] = _vm_got
        if _vm_un:
            ev["vm_route_probes_unmeasured"] = _vm_un

        # ---- F1.4 / F1.5 / F1.MCP: THE SEALED ROUND TRIP ----------------------
        # IT MUST GO THROUGH THE CONTROL PLANE. Only harWriteLake() (index.ts:4590)
        # seals: it PCV1-encrypts and sets pcv1/pcv1_ct metadata. A raw
        # `gcloud storage cp` would store PLAINTEXT, and F1.5 would then report
        # "listed size == plaintext size -- the headline defect" over an object THIS
        # COLLECTOR wrote in the clear. That is a FALSE RED, so it is not done.
        # No key => roundtrip stays null => F1.4/F1.5 FAIL honestly. Never faked.
        key = os.environ.get("PC_SMOKE_SESSION_KEY", "").strip()
        chan = "PC_SMOKE_SESSION_KEY"
        minted = None
        if not key and ck and a.mint_session_key:
            mp = http("POST", target + "/api/sessions/mint", token=tok, cookie=ck,
                      body={"role": a.smoke_role,
                            "label": "devgate smoke (auto, revoked in finally)"})
            mj = jbody(mp) or {}
            if mp.get("_http") == 200 and mj.get("key"):
                key, chan, minted = mj["key"], "minted via POST /api/sessions/mint", mj["key"]
            else:
                ev["session_key_mint_error"] = ("POST /api/sessions/mint -> HTTP %s %s"
                                                % (mp.get("_http"), str(mj)[:200]))
        ev["roundtrip_channel"] = chan if key else "NONE"
        if not key:
            ev["roundtrip_note"] = (
                "No session key was obtained, so NO round-trip was performed and "
                "roundtrip/mcp_roundtrip are null. F1.4 and F1.5 will FAIL. That is "
                "correct and deliberate: the only writer that SEALS is the control "
                "plane's harWriteLake(), so a round-trip done any other way would "
                "prove the opposite of what F1.5 asserts.")
        try:
            if key:
                path = a.probe_path
                blob = "devgate smoke probe %s\n%s" % (ev.get("collected_at", ""),
                                                       "x" * 1024)
                # token=tok is load-bearing: without it Cloud Run refuses at the
                # ingress and neither leg reaches the lake. See mcp_call().
                wp = mcp_call(mcp_target, "write_file",
                              {"path": path, "content": blob}, key, token=tok_mcp)
                rp = mcp_call(mcp_target, "read_file", {"path": path}, key,
                              token=tok_mcp)
                rres, rwhy = mcp_result(rp)
                wres, wwhy = mcp_result(wp)
                rtext = mcp_text(rp)
                # read_file prepends a banner and a blank line; compare the payload.
                back = rtext.split("\n\n", 1)[1] if "\n\n" in rtext else rtext
                op = http("GET", "https://storage.googleapis.com/storage/v1/b/%s/o/%s"
                          % (cpenv.get("DATA_LAKE_BUCKET", ""),
                             urllib.request.quote(path, safe="")),
                          token=access_token())
                ob = jbody(op) or {}
                # THE WRITE LEG WAS DISCARDED AND THAT IS HOW "wrote X but could
                # not read it back" got printed about an object that was never
                # written. Both legs are recorded now, with the layer that refused.
                # *** GATED ON A GENUINELY PARSED RESULT, NOT ON AN ABSENCE. ***
                # The old form was `_http == 200 and "not configured" not in
                # mcp_text(wp)`, and mcp_text() returned "" for every successful
                # call because the body is SSE -- so the condition was VACUOUSLY
                # TRUE and reported write_ok:true about an object that 404'd.
                # Each conjunct below can fail on its own, and the non-empty text
                # requirement is what makes an unparseable or empty 200 a FAILURE
                # instead of a pass.
                wtext = mcp_text(wp)
                w_ok = write_leg_ok(wp)
                r_ok = rres is not None and bool(rtext.strip())
                if w_ok and r_ok:
                    err = None
                elif not w_ok:
                    err = ("the WRITE leg failed first: POST /mcp write_file -> %s. "
                           "Nothing was written, so the read and the stored size "
                           "below are consequences, not findings."
                           % leg_fault(wp, wwhy or ("the result carried no text; "
                                                    "an empty result is not a "
                                                    "successful write")))
                else:
                    err = ("the write succeeded and the READ leg failed: POST /mcp "
                           "read_file -> %s"
                           % leg_fault(rp, rwhy or "the result carried no text"))
                ev["roundtrip"] = {
                    "path": path,
                    "read_ok": r_ok,
                    "write_ok": w_ok,
                    "write_http": wp.get("_http"),
                    "write_headers": wp.get("headers", {}),
                    "write_refused_by": (None if w_ok or wp.get("_http") == 200
                                         else refusal_layer(wp)),
                    "write_fault": None if w_ok else (wwhy or "the result carried no text"),
                    "read_http": rp.get("_http"),
                    "read_headers": rp.get("headers", {}),
                    "read_refused_by": (None if r_ok or rp.get("_http") == 200
                                        else refusal_layer(rp)),
                    "read_fault": None if r_ok else (rwhy or "the result carried no text"),
                    "error": err,
                    "sha_written": hashlib.sha256(blob.encode()).hexdigest(),
                    # NEVER hash a read that did not happen. This field was
                    # e3b0c442... -- the sha256 of "" -- on every build, which is
                    # a claim about bytes nobody ever received.
                    "sha_read": (hashlib.sha256(back.encode()).hexdigest()
                                 if r_ok else None),
                    "plaintext_len": len(blob.encode()),
                    "stored_size": int(ob["size"]) if ob.get("size") is not None else None,
                    "metadata": ob.get("metadata") or {}}
                ev["mcp_roundtrip"] = {"sha_written": ev["roundtrip"]["sha_written"],
                                       "sha_read": ev["roundtrip"]["sha_read"],
                                       "write_parsed": wres is not None,
                                       "write_fault": wwhy,
                                       "write_text": wtext}
        finally:
            if minted:
                # A minted credential that outlives the build is a standing key nobody
                # asked for. Revocation is RECORDED so a failure to revoke is visible.
                #
                # [SEC-DEVGATE-REVOKE-V1] 2026-08-11. IT WAS RECORDED AND NOBODY READ
                # IT. This posted {"key": <the key>}; POST /api/sessions/revoke reads
                # body.id and requires >= 6 characters, so every call returned
                # 400 "id prefix too short" and revoked NOTHING. Measured in
                # evidence-4e88ec01...json: session_key_revoked = 400. Every dev build
                # since this landed has therefore left a LIVE fleet-builder session
                # key behind, valid for PC_KEY_TTL_DAYS (7 in dev), with no record of
                # which keys are outstanding.
                # The id is the Firestore document id, and /api/sessions/mint stores
                # the key under oaTokHash(key) = sha256(key) hex -- so the id is
                # derived here rather than guessed, and the RESPONSE BODY is recorded
                # too, because {ok:true, revoked:0} is a failure that a 200 hides.
                rv = http("POST", target + "/api/sessions/revoke", token=tok,
                          cookie=ck,
                          body={"id": hashlib.sha256(minted.encode()).hexdigest()})
                rvb = jbody(rv) or {}
                ev["session_key_revoked"] = rv.get("_http")
                ev["session_key_revoked_count"] = rvb.get("revoked")
                ev["session_key_revoke_ok"] = (rv.get("_http") == 200
                                               and rvb.get("revoked") == 1)
    finally:
        if a.iap_toggle and not iap_fenced:
            sh("gcloud beta run services update %s --region=%s --project=%s --iap "
               "--quiet" % (a.service, R, P), timeout=420)
            after = jbody(http("GET", svc_url, token=access_token())) or {}
            ev["iap_enabled_after_restore"] = after.get("iapEnabled")
            ev["traffic_after_restore"] = [
                {"revision": t.get("revision"), "percent": t.get("percent"),
                 "tag": t.get("tag")} for t in after.get("traffic", [])]
            # RESTORE IS PROVED BY RE-READING, NEVER BY THE EXIT CODE OF THE RESTORE
            # COMMAND. An unauthenticated probe must be refused by IAP again, and it
            # is identified by the header IAP alone generates.
            up = http("GET", target + "/wiki")
            ev["probe_unauth_after_restore"] = {
                "_http": up.get("_http"),
                "headers": {k: v for k, v in (up.get("headers") or {}).items()
                            if k.startswith("x-goog") or k == "x-powered-by"}}
            ev["iap_restore_confirmed"] = bool(
                after.get("iapEnabled") is True
                and (up.get("headers") or {}).get(
                    "x-goog-iap-generated-response", "").lower() == "true")




# ==========================================================================
# [SEC-DEVGATE-SSE-V1] THE SELF-TEST FOR THE MCP RESPONSE PARSER.
# PURE: no cloud, no credentials, no clock. `--selftest` runs it and exits 3 on
# any failure, so the build can demand it before believing a single MCP field in
# the bundle.
#
# IT PROVES BOTH DIRECTIONS ON PURPOSE. Proving only that a good payload parses
# would leave exactly the hole this fix exists to close: the old collector was
# "green" on every build precisely because its check could not fail. So the
# NEGATIVE half asserts that an empty, truncated, errored or unparseable response
# makes the check FAIL -- and control N1 additionally asserts that the OLD
# predicate ACCEPTS the very input the new one refuses, which is what makes it a
# control that bites rather than a control that is merely present.
# ==========================================================================
def _p(body, ctype="text/event-stream; charset=utf-8", http=200):
    return {"_http": http, "_url": "https://x/mcp",
            "headers": {"content-type": ctype, "x-powered-by": "Express"},
            "body": body}


def _sse(obj_text, rid=1, comment=False, crlf=False, eid=None):
    lines = []
    if comment:
        lines.append(": keep-alive")
    lines.append("event: message")
    if eid is not None:
        lines.append("id: %s" % eid)
    for ln in obj_text.split("\n"):
        lines.append("data: %s" % ln)
    text = "\n".join(lines) + "\n\n"
    return text.replace("\n", "\r\n") if crlf else text


ROSTER = ('{"jsonrpc":"2.0","id":1,"result":{"tools":['
          '{"name":"whoami","description":"w","inputSchema":{}},'
          '{"name":"read_file","description":"r","inputSchema":{}},'
          '{"name":"write_file","description":"w","inputSchema":{}}]}}')
# THE PATH IN THIS FIXTURE IS A PLACEHOLDER AND MUST STAY ONE.
# [SEC-REPOLEAK-RATCHET-V1] write_leg_ok() reads exactly three things -- a
# genuinely parsed result object, NON-EMPTY text, and the absence of the
# "not configured" silent-no-op phrase -- and the path is none of them. Naming
# the real lane path here proved NOTHING extra about the parser and pushed the
# repository's "internal lake path" count one OVER its recorded ceiling, which
# correctly refused a release cut. Removing the reference is the fix; raising a
# ceiling to accommodate a test fixture is a ratchet running backwards. The
# real path stays where it belongs: the --probe-path default, which is the one
# occurrence that actually decides where the live probe writes. DO NOT RESTORE
# IT HERE.
WROTE = ('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text",'
         '"text":"wrote <lane>/_probe-fixture.txt (1042 bytes)"}]}}')


def sse_selftest():
    rows = []

    def chk(name, kind, cond, detail=""):
        rows.append((name, kind, bool(cond), detail))

    def roster(p):
        return {t["name"] for t in
                (((mcp_json(p) or {}).get("result") or {}).get("tools") or [])
                if t.get("name")}

    want = {"whoami", "read_file", "write_file"}

    # ---------------- POSITIVE: a real payload must PARSE ----------------------
    chk("P1 sse tools/list yields the roster", "POSITIVE",
        roster(_p(_sse(ROSTER))) == want, str(sorted(roster(_p(_sse(ROSTER))))))
    chk("P2 sse tools/call yields the text and PASSES the write gate", "POSITIVE",
        mcp_text(_p(_sse(WROTE))).startswith("wrote <lane>/")
        and write_leg_ok(_p(_sse(WROTE))), repr(mcp_text(_p(_sse(WROTE)))[:60]))
    chk("P3 plain application/json still parses (the modern era uses it)",
        "POSITIVE", roster(_p(ROSTER, ctype="application/json; charset=utf-8")) == want)
    chk("P4 a multi-line data field is folded with newlines", "POSITIVE",
        mcp_json(_p(_sse('{"jsonrpc":"2.0","id":1,\n"result":{"content":[]}}')))
        is not None)
    chk("P5 CRLF + an id: field + a leading comment all parse", "POSITIVE",
        roster(_p(_sse(ROSTER, comment=True, crlf=True, eid="7"))) == want)
    chk("P6 the frame whose id matches the request wins", "POSITIVE",
        mcp_text(_p(_sse('{"jsonrpc":"2.0","id":9,"result":{"content":'
                         '[{"type":"text","text":"WRONG"}]}}') + _sse(WROTE)))
        .startswith("wrote"), "id-1 frame selected over the id-9 frame")

    # ---------------- NEGATIVE: these must FAIL, not pass ----------------------
    empty = _p("")
    chk("N1 an EMPTY 200 body FAILS the write gate", "NEGATIVE",
        write_leg_ok(empty) is False, "write_leg_ok=%s" % write_leg_ok(empty))
    chk("N1b ... and the OLD predicate ACCEPTS that same input (control bites)",
        "CONTROL", _legacy_write_leg_ok(empty) is True,
        "the shipped defect is reproduced, so N1 is a real discrimination")
    chk("N2 valid JSON that is not a JSON-RPC response is refused", "NEGATIVE",
        mcp_result(_p('{"hello":1}', ctype="application/json"))[0] is None)
    chk("N3 an SSE frame carrying malformed JSON is refused", "NEGATIVE",
        mcp_json(_p(_sse('{"jsonrpc":"2.0","id":1,"result":{'))) is None)
    chk("N4 a JSON-RPC error frame is refused", "NEGATIVE",
        mcp_result(_p(_sse('{"jsonrpc":"2.0","id":1,"error":'
                           '{"code":-32602,"message":"Unknown tool: write_file"}}')))[0]
        is None)
    chk("N5 isError:true is refused even though the HTTP status is 200", "NEGATIVE",
        write_leg_ok(_p(_sse('{"jsonrpc":"2.0","id":1,"result":{"isError":true,'
                             '"content":[{"type":"text","text":"denied"}]}}')))
        is False)
    chk("N6 the silent no-op phrase is caught in text that REALLY EXISTS", "NEGATIVE",
        write_leg_ok(_p(_sse('{"jsonrpc":"2.0","id":1,"result":{"content":'
                             '[{"type":"text","text":"lake not configured"}]}}')))
        is False)
    chk("N7 a 200 with whitespace-only text FAILS the write gate", "NEGATIVE",
        write_leg_ok(_p(_sse('{"jsonrpc":"2.0","id":1,"result":{"content":'
                             '[{"type":"text","text":"   "}]}}'))) is False)
    chk("N8 a non-200 is refused whatever its body says", "NEGATIVE",
        write_leg_ok(_p(_sse(WROTE), http=403)) is False)

    bad = [r for r in rows if not r[2]]
    print("MCP/SSE PARSER SELF-TEST -- %d control(s), %d failed"
          % (len(rows), len(bad)))
    for name, kind, ok, detail in rows:
        print("  %-4s %-8s %-62s %s" % ("ok" if ok else "FAIL", kind, name, detail))
    if bad:
        print("\nSELF-TEST FAILED. The MCP response parser or one of its controls is\n"
              "broken, so NO MCP field in this bundle may be believed -- including a\n"
              "green one. Refusing.")
        return 3
    print("\nBOTH DIRECTIONS HOLD: a real SSE payload parses and yields the roster,\n"
          "and an empty, truncated, errored or unparseable body makes the check FAIL\n"
          "rather than pass. N1b confirms the old predicate accepted what the new one\n"
          "refuses, so the negative control discriminates.")
    return 0


def starvation_report(ev):
    """THE COLLECTOR MUST NOT HAND THE JUDGE A BUNDLE IT CANNOT JUDGE AND CALL
    THAT SUCCESS. Returns a refusal dict, or None when nothing is starved.

    MEASURED, by running main() against a stubbed cloud in which every
    run.googleapis.com read answers 403: exit 0, no _collect_aborted, and a
    bundle whose only structurally complete section is `surfaces` (console 4
    keys, mcp 6 keys). Everything else is an empty shell, and the whole app
    section -- roundtrip, mcp_roundtrip, mcp_tools_list, mcp_tools_authed,
    oauth_protected_resource, vm_route_probes -- is ABSENT, because base is ""
    and main() takes the _no_service_uri branch instead of calling collect_app.
    smoke.py then returned 11 with 21 FAIL, including F1.1, F3.1, F5.4 and
    "Stage C signing is not configured on EITHER revision" -- four confident
    accusations against variables that were set on the deployed services.

    THIS DOES NOT JUDGE AND IT SOFTENS NOTHING. It fires only where a read did
    NOT return 200, which is the one state in which an absent value says
    nothing at all about the deployment. Where the reads succeeded and a
    variable really is unset, every finding is reached exactly as before.
    """
    bad = dict((n, r) for n, r in sorted((ev.get("service_reads") or {}).items())
               if r.get("_http") != 200)
    if not bad:
        return None
    starved = []
    if not (ev.get("cp_revision") or {}).get("name"):
        starved.append("cp_revision -- the control-plane environment, and with it "
                       "F1.1 BUCKET_CONFIGURED, F3.1 CP_REQUIRED_ENV_SET, F5.3 "
                       "SIG_KEY_VERSION_PAIRED and F6.9 REQUIRED_ENV_ON_BOTH")
    if not (ev.get("gx_revision") or {}).get("name"):
        starved.append("gx_revision -- the executor environment, and with it F5.3 "
                       "SIG_KEY_VERSION_PAIRED and F5.4 EXECUTOR_RP_ID_SET")
    if not ev.get("base_url"):
        starved.append("the WHOLE app section -- roundtrip, mcp_roundtrip, "
                       "mcp_tools_list, mcp_tools_authed, "
                       "oauth_protected_resource and vm_route_probes: the service "
                       "read carried no uri, so collect_app never ran and those "
                       "keys are absent from this bundle rather than null")
    return {"reason": "one or more Cloud Run service reads did not return 200, so "
                      "the sections named below carry NO MEASUREMENT. An assertion "
                      "over an absence is not a finding about the deployment, and "
                      "this collector will not exit 0 over one.",
            "refused_reads": bad,
            "starved_sections": starved,
            "what_to_check_first": "the identity this process runs as. gcloud in a "
                                   "gated job carries the approving human's token "
                                   "while python3 reaches the metadata server and "
                                   "is the EXECUTOR service account -- so a gcloud "
                                   "readback in the same job can succeed against "
                                   "services this collector cannot read at all.",
            "exit": 2}


def main(argv):
    p = argparse.ArgumentParser()
    # [SEC-NODEFAULTPROJ-V1] NO DEFAULT PROJECT. This defaulted to one operator's live
    # dev project, so a collector run with the flag omitted probed, and reported on, a
    # stranger's deployment. A parameterised wrong default is still a wrong default, so
    # the default is gone rather than renamed. Every caller in this repository already
    # passes --project explicitly (pipeline/cloudbuild-dev.yaml step 5a), so nothing in
    # this fleet's pipeline changes.
    p.add_argument("--project", default="")
    p.add_argument("--region", default="us-east1")
    p.add_argument("--service", default="paracoding-control-plane")
    p.add_argument("--gate-exec", default="paracoding-gate-exec")
    # THE SECOND SURFACE. Empty means "this install runs one service", which is what
    # every caller has meant so far. Naming it turns F6 from a skip into a judgement.
    p.add_argument("--mcp-service", default="")
    # THE LAKE BUCKET, WHEN IT CANNOT BE DERIVED. Empty keeps the historical order:
    # DATA_LAKE_BUCKET off the revision, then <project>-datalake. Set it when a lane
    # shares a project with another lane and that fallback would name the neighbour.
    p.add_argument("--lake", default="")
    # WHERE THIS COLLECTOR MAY TURN IAP OFF. See collect_app. The default is the one
    # project it has ever run in, so nothing that is green today changes.
    # [SEC-NODEFAULTPROJ-V1] EMPTY MEANS NEVER-TOGGLE-ANYWHERE, AND THAT IS THE ONLY SAFE
    # DEFAULT FOR A SHIPPED TREE. This flag is the fence around the one thing this
    # collector does that CHANGES a deployment: it turns IAP OFF around its probes. Its
    # default was a live project id, so an adopter who ran the collector with the flag
    # omitted carried a fence that named somebody else's project -- and the moment they
    # ran it against a project with that id they would have taken IAP off it. Empty makes
    # `allowed` an empty list, so iap_fenced is true for every project and the toggle is
    # refused everywhere until an operator names their own. pipeline/cloudbuild-dev.yaml
    # now passes ${_DEV_PROJECT} explicitly, so THIS fleet's behaviour is unchanged.
    p.add_argument("--iap-toggle-projects", default="")
    p.add_argument("--tag", default="")
    p.add_argument("--tree", default="/workspace/work")
    # [SEC-NODEFAULTPROJ-V1] NOT A PROJECT ID, AND STILL ONE OPERATOR'S LIVE RESOURCE.
    # This defaulted to a named Firestore database instance that exists in exactly one
    # fleet. No BANNED pattern matches it -- it is the brand string plus twelve hex --
    # which is precisely why it survived every gate and had to be found by reading the
    # defaults rather than by grepping for known literals. The value is normally read off
    # the deployed revision's PC_FIRESTORE_DB (see fdb above) and the flag is only the
    # fallback, so empty is fail-soft. cloudbuild-dev.yaml passes ${_FIRESTORE_DB}
    # explicitly, so THIS fleet's behaviour is unchanged.
    p.add_argument("--firestore-db", default="")
    p.add_argument("--keyring", default="paracoding-approvals")
    p.add_argument("--key", default="approval-signing")
    p.add_argument("--session-secret", default="pc-session-secret")
    p.add_argument("--smoke-role", default="fleet-builder")
    # WHERE THE F1.4/F1.5 ROUND-TRIP PROBE IS WRITTEN. A FLAG WITH A DEFAULT THAT
    # WORKS ON A FRESH LAKE. This was a hardcoded literal 1,600 lines down naming
    # ONE FLEET'S OWN PRIVATE STATE LANE -- the only fleet-specific value in this
    # file that was not already a flag, so every install the collector was pointed
    # at got that lane's name written into its lake.
    #
    # THE DEFAULT IS CONSTRAINED, NOT A MATTER OF TASTE. Measured against
    # control-plane/src/index.ts:
    #   * resolveKey(path, me, 'write') REFUSES the nine LAKE_EXEC_PREFIXES
    #     (shared/deploy/ shared/harness/ shared/passkey/ shared/mcp-oauth/ shared/vault/
    #     shared/security/ shared/runner/ shared/gate-exec/ shared/reaper/). A probe under any of them makes F1.4/F1.5 red on an ACL refusal
    #     instead of on anything to do with encryption.
    #   * VAULT_CLEARTEXT_PREFIXES -- the first FIVE of those -- are stored PLAINTEXT
    #     BY DESIGN. A probe there lists at exactly the plaintext size, which is the
    #     precise condition F1.5 calls "the headline defect". It would INVERT the
    #     assertion and report a correctly-sealing lake as broken.
    #   * shared/state/ is outside BOTH lists: writable by every role (resolveKey's
    #     own refusal text names it as unaffected) and sealed by harWriteLake.
    # It needs no install-time provisioning: GCS has no directories, so writing the
    # object creates the prefix. A fresh install.sh creates only shared/vault/ and
    # shared/wiki/, and both are wrong here -- vault is cleartext AND write-denied,
    # wiki is the console's documentation rather than a scratch pad. Overriding this
    # is therefore never REQUIRED to make the collector work; it is there so a
    # deployment with its own convention can follow it.
    p.add_argument("--probe-path", default="shared/state/devgate/_smoke-probe.txt")
    # [SEC-INVOKER-RECORD-V1] WHERE install.sh 8/10 RECORDS ITS OWN allUsers ->
    # roles/run.invoker OUTCOME -- the ONLY input to F6.7 that is not a read, because
    # the org-policy refusal only exists as the stderr of the write the installer
    # attempted. THE PREFIX IS THE SECURITY PROPERTY, NOT A CONVENTION: the default
    # sits under one of the nine LAKE_EXEC_PREFIXES resolveKey() REFUSES tool-surface
    # writes under, so no agent holding the lake tools can plant a refusal and buy
    # itself a green on F6.7 -- whereas the probe path above is deliberately under the
    # prefix every role may write, and would be exactly that hole. It is also not one
    # of the five VAULT_CLEARTEXT_PREFIXES. Repointing this at a writable prefix is a
    # real downgrade, which is why it is a flag with a safe default rather than a
    # literal nobody can see.
    p.add_argument("--invoker-record",
                   default="shared/security/devgate/allusers-invoker.json")
    p.add_argument("--out", default="/workspace/evidence.json")
    p.add_argument("--selftest", action="store_true",
                   help="run the pure MCP/SSE parser controls and exit; no cloud, "
                        "no credentials. Exit 3 if any control fails.")
    p.add_argument("--source-only", action="store_true",
                   help="pure parsers only: no cloud, no credentials, no mutation")
    p.add_argument("--skip-logs", action="store_true")
    p.add_argument("--no-iap-toggle", dest="iap_toggle", action="store_false")
    p.add_argument("--no-mint-session-key", dest="mint_session_key",
                   action="store_false")
    p.set_defaults(iap_toggle=True, mint_session_key=True)
    a = p.parse_args(argv[1:])

    if a.selftest:
        return sse_selftest()

    ev = {"collected_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
          "collector": "pipeline/collect-evidence.py",
          "project": a.project, "region": a.region, "service_name": a.service}
    rc = 0
    try:
        ev.update(collect_source(a.tree))
        bc = os.path.join(os.path.dirname(a.out) or "/workspace", "BUILD_COMMIT")
        if os.path.exists(bc):
            ev["build_commit"] = open(bc).read().strip()
        if not a.source_only:
            ev["drift"] = drift_witness()
            cpenv, base, target = collect_cloud(a, ev)
            if base:
                collect_app(a, ev, cpenv, base, target)
            else:
                ev["_no_service_uri"] = ("the service has no uri, so no app probe was "
                                         "possible")
            # AFTER the app probe, so a bundle that is merely thin is not refused
            # while one that is starved always is. rc 2 is distinct from the rc 1
            # an exception earns: 1 means the collector DIED, 2 means it ran and
            # has nothing to hand over.
            _starved = starvation_report(ev)
            if _starved:
                ev["_collect_refused"] = _starved
                rc = 2
    except Exception:
        # PUBLISH UNCONDITIONALLY. A collector that dies before writing turns a
        # diagnosable failure into no artifact at all.
        import traceback
        ev["_collect_aborted"] = traceback.format_exc()[:4000]
        rc = 1
    finally:
        with open(a.out, "w") as f:
            json.dump(ev, f, indent=1, sort_keys=True, default=str)
        print("wrote %s (%d bytes) aborted=%s refused=%s rc=%d"
              % (a.out, os.path.getsize(a.out), "_collect_aborted" in ev,
                 "_collect_refused" in ev, rc))
        if "_collect_refused" in ev:
            print("COLLECTION REFUSED. " + ev["_collect_refused"]["reason"])
            for _line in ev["_collect_refused"]["starved_sections"]:
                print("  starved: " + _line)
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv))
