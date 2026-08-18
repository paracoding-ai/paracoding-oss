#!/usr/bin/env python3
"""
smoke.py -- POST-INSTALL FUNCTIONAL SMOKE TEST for the paracoding v3 installer.

WHY THIS EXISTS. The rehearsal harness returned verdict 0 with steps 0/10-8/10
green on a release whose data-lake tools had no bucket, whose VM tools had no
instance, and which named a secret that was never created. It proved the
installer RUNS. It did not prove the installed system WORKS. This file is the
second half.

STRUCTURE, and it is deliberate:

    collect(...)  -> evidence dict   ONLY cloud reads. No judgement.
    judge(ev)     -> [Finding]       ONLY pure functions over evidence.
    selftest()                       seeds a defect into a COPY of the evidence
                                     for EVERY assertion and requires the verdict
                                     to flip. A check that cannot fail is worse
                                     than no check, so every check is made to fail
                                     before it is trusted.
    controls()                       extra negative controls where ONE seed is not
                                     enough to show a check discriminates, plus
                                     positive controls that must NOT turn red.

Because judge() is pure, selftest() mutates only in-memory JSON. It never writes
to any cloud project. Seeding a defect costs nothing and risks nothing.

THIS FILE IS THE JUDGE AND IT MAKES NO CALLS. It reads one JSON bundle off disk
and nothing else: the import list is copy, json, os, re, sys, traceback -- no
urllib, no socket, no subprocess, no http client of any kind. That is why url and
challenge parsing here is hand-rolled rather than imported. Every assertion is a
pure function of the bundle, so a defect can be seeded into a copy of it and the
verdict re-taken for free, and a reader can confirm the no-I/O property from the
imports instead of auditing every call site.

THREE STATUSES, AND NOT-EXERCISED IS NOT GREEN.

    PASS            asserted or exercised, and it held
    FAIL            asserted, and it did not hold
    NOT-EXERCISED   not run. Carries a reason. Counts as green ONLY if its id is
                    on UNEXERCISABLE below -- the reviewed, written-down list of
                    things that genuinely cannot run unattended. Anything that
                    drops out of "exercised" without being on that list is a
                    COVERAGE REGRESSION and exits 11.

EXERCISED vs ASSERTED. Stated per finding, never blurred:
    EXERCISED  a real call was made against the installed system
    ASSERTED   the backing resource was proven to exist, because the real call
               is unsafe or needs a human

EXIT CONTRACT. The install-phase codes are UNCHANGED and stay distinct:
    3   STEP-GENUINELY-FAILED        an installer step died
    0   COMPLETE-NEEDS-HUMAN-AT-9    install reached the boundary AND every
                                     exercisable functional assertion passed
    4   STOP-NOT-HONOURED            the installer ran past the 9/10 boundary
  new:
   10   FUNCTIONAL-FAILED            install reached the boundary, but the
                                     installed system does not do its job
   11   FUNCTIONAL-COVERAGE-LOST     an assertion did not run and is not on the
                                     reviewed unexercisable list, or selftest
                                     found a check that cannot fail
   12   FUNCTIONAL-EVIDENCE-MISSING  collect() could not gather an input

0 NOW MEANS BOTH. Before this file, 0 meant "the script exited 0". It now means
"the script exited 0 AND the thing it installed answers".

RESULTS ARE PUBLISHED UNCONDITIONALLY. main() wraps everything and writes the
report on every path including an abort, because a prior version exited before
writing anything and a whole run produced no artifact.

DIE() ONLY BOUNDS THE INSTALL PHASE. The installer's die() exits, so only one
step failure is obtainable per run. This phase runs AFTER the installer process
has exited, judges a static evidence bundle, and therefore reports ALL of its
assertions rather than stopping at the first.
"""
import copy
import json
import os
import re
import sys
import traceback

# The 34-byte constant is the PCV1 envelope overhead: a sealed object lists at
# plaintext + 34. EQUAL TO PLAINTEXT MEANS PLAINTEXT, and the encryption claim in
# the shipped README is then false. This single number is the headline check.
PCV1_OVERHEAD = 34

# Things that genuinely cannot run unattended. EVERY ENTRY IS A CONFESSION and is
# reprinted in the report. Adding an id here is a decision, not a convenience:
# it is the only way a NOT-EXERCISED finding is allowed to coexist with exit 0.
UNEXERCISABLE = {
    "F5.APPROVAL_ROUNDTRIP":
        "A real approval requires a human WebAuthn passkey with user presence. "
        "No signature is produced or verified end to end by this harness. What "
        "is asserted instead is that the key exists, that only the control plane "
        "can sign with it, and that the executor holds public-key read only.",
    "F2.BROWSER_TOOLS":
        "The browser/CDP tools need a workstation with a live CDP endpoint. The "
        "shipped README declares them unprovisioned by design.",
    "F1.MCP_WRITE_FILE_HANDLER":
        "Calling the MCP write_file handler needs a session key, and the 9/10 "
        "boundary sits ABOVE the pc-bootstrap-secret mint, so no key exists in an "
        "unattended rehearsal. The storage layer beneath it IS exercised (F1.4); "
        "the handler itself is not. Set PC_SMOKE_SESSION_KEY to promote this to "
        "EXERCISED.",
}

# Every registered tool must land in exactly one class. A tool that matches none
# is a COVERAGE HOLE and fails the run -- that is what makes this survive tool #37
# being added by someone who never reads this file.
TOOL_CLASSES = [
    ("lake",     {"write_file", "put_file", "read_file", "list_files"}),
    ("gitvault", {"git_read", "git_list", "git_log", "git_diff", "git_propose",
                  "git_propose_patch", "git_push"}),
    ("vm",       {"vm_status", "vm_start", "vm_stop", "vm_resize"}),
    # browser_eval added 2026-08-10 [SEC-DEVGATE-COLLECT-V1]. F2.1 FIRED EXACTLY AS
    # DESIGNED -- "1 tool(s) match no class: browser_eval" -- when the collector first
    # parsed the live tree. It is registered at index.ts:1605, inside the same
    # WS_CDP_PORT guard as the other three and behind PC_BROWSER_EVAL as well, and it
    # reaches the workstation Chrome through the identical harCdp() path. It is backed
    # by F2.BROWSER_TOOLS, which is already on the reviewed UNEXERCISABLE list. This is
    # the CLASSIFICATION the check exists to force, not a way of silencing it.
    ("browser",  {"browser_open", "browser_navigate", "browser_tabs", "browser_eval"}),
    ("memory",   {"create_entities", "add_observations", "create_relations",
                  "delete_entities", "delete_observations", "delete_relations",
                  "read_graph", "search_nodes", "open_nodes",
                  "log_history", "search_history", "read_history"}),
    # dev_api REMOVED 2026-08-12. The tool is deleted from index.ts, so no bundle
    # cut from this tree can register it. F2.1 computes registered_tools - known,
    # which makes this list a SUPERSET ALLOWLIST: a name left here can only make
    # the check weaker, never stronger. Verified by running the judge both ways
    # over the same bundles -- byte-identical report on a tree without dev_api,
    # and F2.1 PASS -> FAIL on a bundle where dev_api is registered.
    ("approval", {"stage_privileged_job", "list_pending_confirm", "run_command",
                  "gcp_api", "read_job_log"}),
    ("core",     {"whoami", "refresh", "append_journal", "read_journal",
                  "post_work_item", "list_work_items", "complete_work_item",
                  "cancel_work_item", "ask_agent", "list_my_messages",
                  "answer_message", "check_answer", "get_time", "run_roll",
                  "run_status", "cowork_prompt"}),
]

# Read with no `||` fallback anywhere in the expression => the code depends on the
# deployment to supply it. Plus DATA_LAKE_BUCKET, whose DEFAULT IS WRONG AND
# SILENT: it has no default and makes four lake tools no-op successfully.
#
# WS_VM AND WS_ZONE WERE REMOVED FROM THIS SET 2026-08-11 [SEC-VM-DECLARED-V1], AND
# THE REASON MATTERS MORE THAN THE EDIT. The text that used to stand here said they
# "default to a machine that does not exist, so the VM tools 404 on first call".
# THAT WAS FALSE AT THE SOURCE and it is the kind of false that costs a working
# control: a strain reading it would go and delete the guard. Measured at
# control-plane/src/index.ts blob 15f48771 (main 868d8749):
#
#   index.ts:3119-3120  const WS_VM  = process.env.WS_VM  || '';
#                       const WS_ZONE = process.env.WS_ZONE || '';   <- EMPTY STRING
#   index.ts:1666-1718  [SEC-VM-UNCONFIGURED-V1] wraps the registration of
#                       vm_status/vm_start/vm_stop/vm_resize in `if unset { log }
#                       else { register }` -- the four tools are WITHHELD, not
#                       pointed at a guess.
#   index.ts:3122       harVmUnset() names the missing variables, and
#   index.ts:3946-3948  /api/vm/status|start|stop each 503 on it.
#
# So an install that declares no workstation is a DECLARED STATE and the control is
# already fail-closed. Requiring the variables unconditionally asserted that every
# install must own a Compute instance, which is not true of the product and is not
# true of this project. What replaces it is NOT weaker: F2.3 now asserts the
# WITHHOLDING itself, which is a falsifiable property of the running system, where
# the old check only asserted that a string was non-empty.
ENV_ALWAYS_REQUIRED_CP = {"DATA_LAKE_BUCKET"}

# The four tools inside the [SEC-VM-UNCONFIGURED-V1] guard, and the three HTTP
# routes harVmUnset() refuses.
# [SEC-SSHTOOL-REMOVED-V1] ssh_executor used to be called out here as deliberately
# absent from this tuple -- registered outside the guard, addressing a target argument
# rather than the instance. It is not registered anywhere now. The note is kept only so
# the next reader does not go looking for the tool this comment used to warn them about.
VM_GUARDED_TOOLS = ("vm_status", "vm_start", "vm_stop", "vm_resize")
VM_GUARDED_ROUTES = ("GET /api/vm/status", "POST /api/vm/start", "POST /api/vm/stop")

# RFC 9728 section 3 fixes the protected-resource metadata well-known path. The
# resource's own path may be appended to it, which is why a prefix form is
# accepted and NOTHING ELSE is.
OAUTH_PR_PATH = "/.well-known/oauth-protected-resource"


class Finding(object):
    def __init__(self, fid, mode, requirement):
        self.id = fid
        self.mode = mode              # EXERCISED | ASSERTED
        self.requirement = requirement
        self.status = "NOT-EXERCISED"
        self.detail = ""
        # [SEC-DEVGATE-STARVED-V1] set by _starve() when this finding's INPUT was
        # REFUSED rather than read. render() reports those apart from the coverage
        # regressions: "nobody ran it" and "nobody could run it" have different
        # first moves, and only one of them is a defect in this tree.
        self.starved = False

    def ok(self, detail=""):
        self.status, self.detail = "PASS", detail
        return self

    def bad(self, detail=""):
        self.status, self.detail = "FAIL", detail
        return self

    def skip(self, detail=""):
        self.status, self.detail = "NOT-EXERCISED", detail
        return self

    def as_dict(self):
        return {"id": self.id, "mode": self.mode, "status": self.status,
                "requirement": self.requirement, "detail": self.detail}


def _env_of(revision):
    """Env map off a Cloud Run REVISION resource. Secret-backed vars are recorded
    as a marker, never as a value -- this file must never print a secret."""
    out = {}
    for c in (revision or {}).get("containers", []) or []:
        for e in c.get("env", []) or []:
            if "value" in e:
                out[e["name"]] = e["value"]
            else:
                out[e["name"]] = "<secret:%s>" % (
                    e.get("valueSource", {}).get("secretKeyRef", {}).get("secret", "?"))
    return out


# ---- [SEC-MCP401-RFC9728-V1] URL AND CHALLENGE PARSING ---------------------
# HAND-ROLLED ON PURPOSE. This file imports nothing that can perform I/O -- not
# urllib, not socket, not subprocess -- so that "the judge cannot call an API" is
# a property a reader can verify from the import list in eight seconds rather than
# by auditing call sites. Two small regexes cost less than that guarantee.
RE_ABS_URL = re.compile(r"^(?P<scheme>[A-Za-z][A-Za-z0-9+.\-]*)://(?P<host>[^/?#]+)(?P<path>[^?#]*)")
RE_AUTH_PARAM = re.compile(r"([A-Za-z0-9_.\-]+)\s*=\s*(?:\"([^\"]*)\"|([^,\s]+))")


def _split_url(u):
    """(scheme, host, path) with scheme and host lowercased. ('','','') when the
    string is not an ABSOLUTE url -- a relative resource_metadata is a defect, not
    something to be resolved helpfully."""
    m = RE_ABS_URL.match(str(u or "").strip())
    if not m:
        return "", "", ""
    return m.group("scheme").lower(), m.group("host").lower(), m.group("path") or ""


def _origin(u):
    sch, host, _ = _split_url(u)
    return (sch + "://" + host) if (sch and host) else ""


def _own_origins(ev, cpenv):
    """Every origin the EVIDENCE says is this server. Derived, never hardcoded: a
    hardcoded hostname would make the self-reference check pass on a bundle from a
    different install. Empty means the bundle cannot anchor the check at all, and
    F2.2 refuses rather than certifying a challenge it cannot place."""
    out = []
    for u in (ev.get("base_url"), ev.get("target_url"), cpenv.get("MCP_PUBLIC_URL")):
        o = _origin(u)
        if o and o not in out:
            out.append(o)
    return out


def _parse_challenge(hdr):
    """(scheme_lowercased, {param: value}) from a WWW-Authenticate header. Both the
    quoted and the token form of an auth-param are accepted (RFC 7235 s2.1); the
    SCHEME is taken from the first token and is never guessed from the params."""
    txt = str(hdr or "").strip()
    if not txt:
        return "", {}
    parts = txt.split(None, 1)
    params = {}
    for m in RE_AUTH_PARAM.finditer(parts[1] if len(parts) > 1 else ""):
        params[m.group(1).lower()] = m.group(2) if m.group(2) is not None else m.group(3)
    return parts[0].lower(), params


def _is_pr_path(path):
    """RFC 9728 s3: the well-known path, optionally with the resource's own path
    appended. /.well-known/oauth-authorization-server is a DIFFERENT document
    (RFC 8414) and must not satisfy this."""
    p = (str(path or "").rstrip("/")) or "/"
    return p == OAUTH_PR_PATH or p.startswith(OAUTH_PR_PATH + "/")


def _rfc9728_problems(doc, own_origins):
    """RFC 9728 s2 well-formedness of a protected-resource metadata document.
    Returns the list of problems; empty means well formed."""
    if not isinstance(doc, dict):
        return ["the metadata document is not a JSON object (got %s)"
                % type(doc).__name__]
    probs = []
    res = doc.get("resource")
    if not isinstance(res, str) or not res.strip():
        probs.append("'resource' is REQUIRED (RFC 9728 s2) and is absent or not a string")
    elif _split_url(res)[0] != "https":
        probs.append("'resource' %r is not an absolute https URL" % res[:120])
    elif own_origins and _origin(res) not in own_origins:
        probs.append("'resource' identifies %s, which is not this server (%s) -- the "
                     "document describes somebody else's resource"
                     % (_origin(res), ", ".join(own_origins)))
    servers = doc.get("authorization_servers")
    if servers is None:
        probs.append("'authorization_servers' is absent, so a client that reads this "
                     "document still has nowhere to go and the handshake dead-ends")
    elif not isinstance(servers, list) or not servers:
        probs.append("'authorization_servers' must be a NON-EMPTY array")
    else:
        bad = [x for x in servers
               if not isinstance(x, str) or _split_url(x)[0] != "https"]
        if bad:
            probs.append("%d authorization_servers entr(ies) are not absolute https "
                         "urls: %s" % (len(bad), ",".join(str(b)[:60] for b in bad[:3])))
    bms = doc.get("bearer_methods_supported")
    if bms is not None and (not isinstance(bms, list)
                            or any(not isinstance(x, str) for x in bms)):
        probs.append("'bearer_methods_supported' is present but is not an array of strings")
    return probs


def _live_tool_names(ev):
    """The tool roster the DEPLOYED server actually returned, or None when no
    tools/list in the bundle succeeded.

    source.registered_tools IS NOT A ROSTER and must never be used here. It is a
    regex over index.ts and reports every registerTool call site whether or not the
    guard around it registered anything at runtime -- so a source scan shows
    vm_start on an install that withholds it. Only a 200 from the live surface can
    answer 'was it registered'."""
    for key in ("mcp_tools_authed", "mcp_tools_list"):
        p = ev.get(key)
        if isinstance(p, dict) and p.get("_http") == 200 and isinstance(p.get("tools"), list):
            return {str(t) for t in p["tools"]}
    return None


def _vm_route_probes(ev):
    """{route -> probe} for the three /api/vm/* routes, restricted to the three this
    file knows about. Anything else in the field is ignored rather than judged."""
    raw = ev.get("vm_route_probes")
    if not isinstance(raw, dict):
        return {}
    return {r: raw[r] for r in VM_GUARDED_ROUTES
            if isinstance(raw.get(r), dict)}


# ---- [SEC-SURFACE-SMOKE-V1] ------------------------------------------------
# TWO SERVICES, ONE IMAGE. Everything below exists because the release now
# deploys the same image twice and PC_SURFACE tells each copy which half of the
# route table to register:
#
#   console  service paracoding-control-plane   PC_SURFACE=console   IAP ON
#            allUsers run.invoker REMOVED       63 routes
#   mcp      service paracoding-mcp             PC_SURFACE=mcp       IAP OFF
#            allUsers run.invoker GRANTED       25 routes
#
# Reading ONE service is now actively misleading: F1/F2/F3 would judge the
# console's environment for tools that only run on the mcp service, and vice
# versa. A green from a one-service read says nothing about the half it did not
# look at.
#
# THE STATUS CODE PROVES NOTHING. Both surfaces refuse an anonymous caller, so
# 401/403 is the same on a healthy split, on a broken split, and on a service
# nobody can invoke. Only the RESPONSE HEADERS discriminate, and a check that
# reads the code instead of the header is exactly how a completely unreachable
# /mcp passed for the life of the release. _shape() below is the whole point.
SINGLE_SERVICE_REASON = (
    "This install runs ONE service with PC_SURFACE unset, which is a supported "
    "mode and today's live behaviour: every route registers on one service and "
    "there is no second surface to compare against. The assertion is about the "
    "two-service split and genuinely does not apply. It is NOT-EXERCISED rather "
    "than PASS because nothing about the split was demonstrated. Note that this "
    "excuse is not blanket: F6.0 FAILS, and does not skip, the moment there is "
    "ANY positive evidence of a split (PC_SURFACE set, or a second surface in "
    "the bundle) without its matching half.")

ORG_POLICY_REASON = (
    "allUsers -> roles/run.invoker is REFUSED in this project by "
    "constraints/iam.allowedPolicyMemberDomains (domain-restricted sharing): "
    "'FAILED_PRECONDITION: One or more users named in the policy do not belong "
    "to a permitted customer'. The MCP service therefore answers a Google "
    "Frontend 403 before the container is ever reached, so the HEALTHY "
    "Express-shaped 401 on /mcp has NEVER BEEN OBSERVED ANYWHERE and this "
    "harness cannot observe it here. That is a property of the project, not a "
    "defect in the product -- and it is NOT-EXERCISED, never PASS. The refusal "
    "must be RECORDED in the evidence bundle to earn this excuse: an invoker "
    "binding that is simply missing, with no refusal captured, FAILS.")

UNEXERCISABLE.update({
    "F6.0.SURFACE_SPLIT_PRESENT":       SINGLE_SERVICE_REASON,
    "F6.1.SURFACE_ENV_DISTINCT":        SINGLE_SERVICE_REASON,
    "F6.2.CONSOLE_IS_IAP_FRONTED":      SINGLE_SERVICE_REASON,
    "F6.3.MCP_IS_NOT_IAP_FRONTED":      SINGLE_SERVICE_REASON + " " + ORG_POLICY_REASON,
    "F6.4.MCP_SERVES_MCP":              SINGLE_SERVICE_REASON + " " + ORG_POLICY_REASON,
    "F6.5.CONSOLE_WITHHOLDS_MCP":       SINGLE_SERVICE_REASON,
    "F6.6.ROOT_IS_CONSOLE_ONLY":        SINGLE_SERVICE_REASON + " " + ORG_POLICY_REASON,
    "F6.7.MCP_PUBLIC_INVOKER":          SINGLE_SERVICE_REASON + " " + ORG_POLICY_REASON,
    "F6.8.CONSOLE_INVOKER_NOT_PUBLIC":  SINGLE_SERVICE_REASON,
    "F6.9.REQUIRED_ENV_ON_BOTH":        SINGLE_SERVICE_REASON,
})

# The two service names the installer deploys. Only used to LABEL the report --
# every assertion reads the surface entry, never the name, so renaming a service
# cannot silently disable a check.
SURFACE_SERVICES = {"console": "paracoding-control-plane", "mcp": "paracoding-mcp"}

# Text that identifies the org-policy refusal in a captured error string. A
# refusal must be RECORDED to excuse a missing invoker binding; absence with no
# recorded refusal is a FAIL, which is what stops this from becoming a blanket.
ORG_POLICY_MARKERS = (
    "failed_precondition",
    "do not belong to a permitted customer",
    "allowedpolicymemberdomains",
    "domain restricted sharing",
    "organization policy",
)


def _hdrs(probe):
    """Headers of a probe, lowercased on both sides. Never the body."""
    return {str(k).lower(): str(v) for k, v in
            ((probe or {}).get("headers") or {}).items()}


def _shape(probe):
    """CLASSIFY A REFUSAL BY ITS HEADERS. The status code is deliberately the
    LAST thing consulted and can never on its own produce 'iap' or 'app'.

        iap         IAP is in front. x-goog-iap-generated-response: true is
                    generated by IAP and by nothing else.
        app         the container answered. Express identifies itself, and the
                    MCP challenge carries www-authenticate: Bearer
                    resource_metadata=. THIS IS THE HEALTHY SHAPE on /mcp.
        run-denied  Cloud Run's frontend refused the caller before the container
                    ran, so there is no Express header to find. This is what
                    domain-restricted sharing produces, and it must never be
                    read as either of the other two.
        none        no probe was captured at all.
        unknown     something answered that this file cannot classify. Never a
                    pass: an unrecognised shape is missing evidence.
    """
    if probe is None:
        return "none"
    h = _hdrs(probe)
    if h.get("x-goog-iap-generated-response", "").strip().lower() == "true":
        return "iap"
    if "express" in h.get("x-powered-by", "").lower():
        return "app"
    if "resource_metadata=" in h.get("www-authenticate", ""):
        return "app"
    if probe.get("_http") in (401, 403):
        return "run-denied"
    return "unknown"


def _surf(ev, name):
    return ((ev.get("surfaces") or {}).get(name) or {})


def _surf_env(ev, name):
    rev = _surf(ev, name).get("revision") or {}
    return _env_of(rev.get("template", rev))


def _invoker_refusal(surface):
    """The recorded org-policy refusal text, or '' if none was captured."""
    txt = str(surface.get("allusers_refusal") or "")
    low = txt.lower()
    return txt if any(mk in low for mk in ORG_POLICY_MARKERS) else ""


def _has_allusers_invoker(surface):
    for b in ((surface.get("run_iam") or {}).get("bindings") or []):
        if b.get("role") == "roles/run.invoker" and "allUsers" in (b.get("members") or []):
            return True
    return False


def _split_evidence(ev):
    """Is this a two-service install? Derived from EVIDENCE, never from a flag
    somebody remembered to set -- a forgotten flag would skip the whole of F6.

    Returns (mode, detail) where mode is:
        'split'   both surfaces are present in the bundle
        'half'    positive evidence of a split with a missing half -> FAIL
        'single'  no evidence of a split anywhere -> the supported one-service
                  mode, and the only case that may skip
    """
    s = ev.get("surfaces") or {}
    have_c, have_m = bool(s.get("console")), bool(s.get("mcp"))
    cp_surface = (_env_of((ev.get("cp_revision") or {}).get(
        "template", ev.get("cp_revision") or {})).get("PC_SURFACE") or "").strip()
    if have_c and have_m:
        return "split", "both surfaces in the bundle"
    if have_c or have_m or cp_surface:
        which = "console" if have_c else ("mcp" if have_m else "none")
        return "half", ("PC_SURFACE=%r on the control plane and surfaces present: "
                        "console=%s mcp=%s" % (cp_surface, have_c, have_m) +
                        " (positive evidence of a split, %s half only)" % which)
    if "cp" in _starved(ev):
        # [SEC-DEVGATE-STARVED-V1] PC_SURFACE was never READ, so "unset" is not a
        # fact this bundle establishes. The mode is still single -- there is no
        # second surface here to judge either -- but the reason printed against
        # ten reviewed skips must not claim a measurement nobody made.
        return "single", ("the control-plane revision read was REFUSED, so "
                          "PC_SURFACE was never read at all, and no second "
                          "surface is in the bundle either. This is the ABSENCE "
                          "of evidence about the split, not evidence of a "
                          "one-service install")
    return "single", "PC_SURFACE unset and no second surface in the bundle"


# --------------------------------------------------------------------------
# [SEC-DEVGATE-STARVED-V1] STARVED INPUT.
# "I WAS HANDED NOTHING" IS NOT "I MEASURED THIS AND IT IS WRONG".
# --------------------------------------------------------------------------
# WHAT HAPPENED. A gated job ran the collector as the WRONG IDENTITY -- urllib
# reached the metadata server and got the EXECUTOR service account while gcloud
# in the same shell used the injected approver token, because exec_server.py sets
# CLOUDSDK_AUTH_ACCESS_TOKEN and gcloud honours it where urllib does not. Every
# run.googleapis.com read answered 403, the collector exited 0, and THIS FILE
# rendered 21 confident reds over sections nobody had managed to read:
# F5.4 EXECUTOR_RP_ID_SET red while the executor carries PC_RP_ID, F1.1 and F3.1
# red while both are set, F5.3 skipped saying "both variables are unset" when both
# ARE set -- and F3.2 GREEN, "every deployed variable is read by the code", over
# two revisions with no environment in the bundle at all. A judge that cannot tell
# a refusal from a measurement is not a judge.
#
# THE DISCRIMINATOR IS PROVENANCE, NOT ABSENCE, AND GETTING THAT WRONG IN THE
# PERMISSIVE DIRECTION IS THE ONE OUTCOME THIS FILE EXISTS TO PREVENT. An absent
# key means one of two OPPOSITE things:
#
#   READ, AND ABSENT   the revision came back and the variable is not on it.
#                      That is a measured fact about the install and it stays FAIL.
#   REFUSED            the read that would have produced the revision never
#                      returned 200, so the bundle says NOTHING about the variable
#                      in either direction.
#
# So a section counts as starved only when BOTH of these hold, never on either:
#
#   1. THE BUNDLE RECORDS A REFUSAL. ev["service_reads"] carries the status of
#      every Cloud Run service read and at least one is not 200. That is POSITIVE
#      EVIDENCE written by the collector, in exactly the spirit of bucket_perms
#      {"measured": false} and of the org-policy refusal F6.7 demands before it
#      will excuse a missing invoker binding. It cannot be manufactured by an
#      absence: a bundle from a collector that never wrote service_reads carries
#      no refusal, so _starved() returns {} and EVERY finding is judged exactly as
#      it is today.
#   2. THE SECTION'S OWN WITNESS IS MISSING. cp_revision["name"],
#      gx_revision["name"] and base_url are written if and only if the read behind
#      them returned 200. Their PRESENCE proves the read came back and forces the
#      finding to be judged on its contents no matter what else was refused.
#
# Condition 2 alone is the permissive error -- it would turn every genuinely unset
# variable into a skip. Condition 1 alone would starve findings whose own read
# succeeded. Only the conjunction starves exactly what was refused, and every
# call site of _starve() is proven in conditional_skips() below.
def _refused_reads(ev):
    """Service reads the collector RECORDED as not-200. Never inferred from an
    absent key, and never from an absent field."""
    src = ev.get("service_reads")
    if not isinstance(src, dict):
        ref = ev.get("_collect_refused")
        src = ref.get("refused_reads") if isinstance(ref, dict) else None
    out = {}
    for name, r in sorted((src or {}).items()):
        if isinstance(r, dict) and r.get("_http") != 200:
            out[str(name)] = r
    return out


def _starved(ev):
    """section -> the sentence to print, for sections whose input was REFUSED.
    Empty whenever the bundle records no refusal, which is every bundle written
    before the collector carried service_reads."""
    refused = _refused_reads(ev)
    if not refused:
        return {}
    who = ", ".join("%s -> HTTP %s" % (n, refused[n].get("_http"))
                    for n in sorted(refused))
    out = {}
    if not (ev.get("cp_revision") or {}).get("name"):
        out["cp"] = ("the control-plane revision -- no revision name came back, "
                     "so its ENTIRE environment is missing from this bundle and "
                     "an unset variable is indistinguishable from an unread one")
    if not (ev.get("gx_revision") or {}).get("name"):
        out["gx"] = ("the gate-exec revision -- no revision name came back, so "
                     "its ENTIRE environment is missing from this bundle")
    if not ev.get("base_url"):
        out["app"] = ("the whole app section -- the service read carried no uri, "
                      "so collect_app never ran and roundtrip, mcp_tools_list, "
                      "mcp_tools_authed, oauth_protected_resource and "
                      "vm_route_probes are ABSENT rather than null")
    for k in list(out):
        out[k] = "REFUSED READ(S): %s. STARVED: %s." % (who, out[k])
    return out


def _starve(f, st, *sections):
    """Drive f to NOT-EXERCISED when any named section was REFUSED, and say so.
    Returns True when it did, so the caller's real judgement is skipped.

    THE TEXT IS DELIBERATELY THE SAME SHAPE AS F1.3's UNMEASURED BRANCH: it says
    NOT MEASURED, it says the id is NOT on the reviewed list, and it names the
    fix. A starved skip therefore reaches exit 0 by no path at all -- render()
    turns it into 12 FUNCTIONAL-EVIDENCE-MISSING and skipproof() proves it."""
    hit = [x for x in sections if x in st]
    if not hit:
        return False
    f.skip("NOT MEASURED, AND IT IS NOT UNEXERCISABLE. THE COLLECTION WAS "
           "REFUSED, so this assertion never ran and this bundle carries no "
           "claim about the deployment in either direction -- do not read it as "
           "a pass and do not read it as a defect. %s FIX THE IDENTITY THE "
           "COLLECTOR READS AS and collect again." % " ".join(st[x] for x in hit))
    f.starved = True
    return True


# --------------------------------------------------------------------------
# JUDGE -- pure. No I/O. Every branch reachable by mutating `ev` alone.
# --------------------------------------------------------------------------
def judge(ev):
    F = []
    st = _starved(ev)
    src = ev.get("source", {})
    cp_rev = ev.get("cp_revision", {})
    gx_rev = ev.get("gx_revision", {})
    cpenv = _env_of(cp_rev.get("template", cp_rev))
    gxenv = _env_of(gx_rev.get("template", gx_rev))

    # ---------------- F0  the readback is off the NEW revision ----------------
    f = Finding("F0.REVISION_IS_NEW", "EXERCISED",
                "Env is read off the revision the deploy just created, not the "
                "install log and not the service's older revision.")
    want = ev.get("cp_latest_created", "")
    got = cp_rev.get("name", "")
    if _starve(f, st, "cp"):
        pass
    elif not want or not got:
        f.skip("no revision name captured")
    elif got.split("/")[-1] != want.split("/")[-1]:
        f.bad("read %s but the deploy created %s -- this is the exact 'proved the "
              "old revision' error" % (got.split("/")[-1], want.split("/")[-1]))
    else:
        f.ok("revision %s" % got.split("/")[-1])
    F.append(f)

    # ---------------- F1  LAKE: config, bucket, permission, round-trip, seal ---
    bucket = cpenv.get("DATA_LAKE_BUCKET", "")
    f = Finding("F1.1.BUCKET_CONFIGURED", "ASSERTED",
                "DATA_LAKE_BUCKET is set on the new control-plane revision. "
                "index.ts:64 reads it with NO fallback, and index.ts:1254/1271/"
                "1287/1309 make write_file/put_file/read_file/list_files return a "
                "SUCCESSFUL tool result saying 'data lake not configured' when it "
                "is empty. The tools register, answer, and do nothing.")
    if _starve(f, st, "cp"):
        pass
    elif not bucket:
        f.bad("DATA_LAKE_BUCKET is UNSET. Four lake tools no-op and report success.")
    elif bucket.startswith("<secret:"):
        f.bad("DATA_LAKE_BUCKET is secret-backed; a bucket name is not a secret "
              "and this is almost certainly a misconfiguration")
    else:
        f.ok(bucket)
    F.append(f)

    f = Finding("F1.2.BUCKET_EXISTS", "ASSERTED",
                "The bucket DATA_LAKE_BUCKET names actually exists.")
    b = ev.get("bucket_get")
    if _starve(f, st, "cp"):
        pass
    elif not bucket:
        f.bad("no bucket configured, so nothing to look up")
    elif b is None:
        f.bad("buckets.get returned nothing for %s" % bucket)
    elif b.get("_http") != 200:
        f.bad("buckets.get %s -> HTTP %s" % (bucket, b.get("_http")))
    elif b.get("name") != bucket:
        f.bad("buckets.get returned %r for %r" % (b.get("name"), bucket))
    else:
        f.ok("gs://%s exists (%s)" % (bucket, b.get("location", "?")))
    F.append(f)

    f = Finding("F1.3.CP_CAN_READ_WRITE", "ASSERTED",
                "The control-plane service account holds objects.create AND "
                "objects.get on that bucket. Write-only would pass a write and "
                "fail every read back.")
    # [SEC-MCP401-RFC9728-V1] AN UNMEASURABLE PERMISSION SET MUST NOT RENDER AS A
    # MEASURED DENIAL. The collector (pipeline/collect-evidence.py, blob a0204872)
    # now writes permissions:null with measured:false and an unmeasured_reason
    # whenever it could not ask AS THE CONTROL PLANE -- and on an impersonation
    # failure it does not call testPermissions AT ALL, because calling it as the
    # BUILDER returns a real 200 describing the WRONG PRINCIPAL, which is the most
    # convincing wrong answer available.
    #
    # This line used to read .get("permissions", []) or [], which collapsed that
    # null into an empty set, so THREE DIFFERENT STATES rendered byte-identically
    # as FAIL "missing storage.objects.create,storage.objects.get": a measured
    # denial, an impersonation failure, and a testPermissions that never answered
    # 200. Measured over this file before the fix -- four input states produced
    # only TWO distinct renderings. That ambiguity is a specific, confident and
    # WRONG accusation against the control plane's IAM when the truth was that the
    # BUILD SA lacks serviceAccountTokenCreator, and it cost a wrong diagnosis.
    #
    # AN EMPTY LIST IS A POSITIVE CLAIM -- "asked, and holds nothing". NULL IS THE
    # ABSENCE OF A CLAIM. They are different findings with different fixes, so the
    # unmeasured state is a SKIP -- and F1.3 is deliberately NOT added to
    # UNEXERCISABLE. An unlisted skip is a coverage regression and forces exit 11,
    # which is the correct loud outcome for a control that could not be run. A skip
    # that is silently blessed is how a check stops being a check.
    #
    # `measured` is read with `is False`, never for truthiness: a bundle written
    # before the collector fix carries no such key at all, and must keep being
    # judged on its permission list rather than reclassified as unmeasured.
    bp = ev.get("bucket_perms") or {}
    praw = bp.get("permissions")
    perms = set(praw or [])
    # [SEC-DEVGATE-STARVED-V1] THE ORDER OF THESE THREE GUARDS IS THE FIX AND IT
    # IS NOT COSMETIC. `not bucket` used to be FIRST, and `bucket` is read off the
    # control-plane revision -- so on a bundle where THAT READ WAS REFUSED the
    # name is empty for a reason that has nothing to do with the lake, this branch
    # fired, and the loud unmeasured-skip the block above was written to produce
    # became UNREACHABLE. A confident "no bucket configured" replaced it, which is
    # exactly the ambiguity the permissions-is-null design was written to remove:
    # three input states rendering as one accusation again. A refusal is therefore
    # judged FIRST, because it is the only one of the three that says nothing
    # about the deployment at all.
    #
    # AND THE `not bucket` FAIL IS PRESERVED, IN SECOND PLACE, UNCHANGED. When the
    # revision WAS read and DATA_LAKE_BUCKET really is unset, that is a measured
    # fact about the install and it stays a red. Moving it BELOW the unmeasured
    # branch instead would have looked like the same fix and been a weakening: the
    # collector writes measured:false for the no-bucket case too, so a genuinely
    # unconfigured lake would have become a skip. REFUSED beats UNSET, UNSET beats
    # UNMEASURED, UNMEASURED beats a permission list.
    if _starve(f, st, "cp"):
        pass
    elif not bucket:
        f.bad("no bucket configured")
    elif praw is None or bp.get("measured") is False:
        f.skip("NOT MEASURED, AND IT IS NOT UNEXERCISABLE. testPermissions was "
               "never asked AS THE CONTROL PLANE, so there is no permission set "
               "to judge. permissions is null, not empty: an empty list means "
               "'asked and holds nothing'; null means 'never asked'. Reason: %s"
               % (bp.get("unmeasured_reason") or "not recorded"))
    else:
        need = {"storage.objects.create", "storage.objects.get"}
        missing = sorted(need - perms)
        if missing:
            f.bad("missing %s" % ",".join(missing))
        else:
            f.ok("create+get held")
    F.append(f)

    f = Finding("F1.4.ROUNDTRIP_BYTES", "EXERCISED",
                "An object written through the configured lake path reads back "
                "BYTE-IDENTICAL. Compares content, not status codes.")
    rt = ev.get("roundtrip")
    if _starve(f, st, "cp", "app"):
        pass
    elif rt is None:
        f.bad("no round-trip was performed -- there was no usable bucket")
    elif not rt.get("read_ok"):
        f.bad("wrote %s but could not read it back: %s"
              % (rt.get("path"), rt.get("error")))
    elif rt.get("sha_written") != rt.get("sha_read"):
        f.bad("BYTES DIFFER: wrote sha256 %s, read %s"
              % (rt.get("sha_written"), rt.get("sha_read")))
    else:
        f.ok("%d bytes, sha256 %s, identical" % (rt.get("plaintext_len", 0),
                                                 (rt.get("sha_written") or "")[:16]))
    F.append(f)

    # THE HEADLINE. A sealed object lists at plaintext + 34. Equal means PLAINTEXT.
    f = Finding("F1.5.SEALED_AT_REST", "EXERCISED",
                "The stored object is ENCRYPTED AT REST. A sealed object lists at "
                "plaintext + %d bytes. A listed size EQUAL to the plaintext size "
                "means the object is PLAINTEXT and the encryption claim in the "
                "shipped README is false." % PCV1_OVERHEAD)
    if _starve(f, st, "cp", "app"):
        pass
    elif rt is None:
        f.bad("no object was written, so encryption at rest was never demonstrated")
    else:
        n = rt.get("plaintext_len")
        stored = rt.get("stored_size")
        meta = rt.get("metadata") or {}
        if n is None or stored is None:
            f.bad("no stored size for %s" % rt.get("path"))
        elif stored == n:
            f.bad("PLAINTEXT: listed size %d == plaintext size %d. The object is "
                  "NOT sealed. This is the headline defect." % (stored, n))
        elif stored != n + PCV1_OVERHEAD:
            f.bad("listed size %d is neither plaintext (%d) nor sealed (%d) -- "
                  "the envelope is not the one this check knows about, so it "
                  "cannot certify encryption" % (stored, n, n + PCV1_OVERHEAD))
        elif "pcv1" not in {k.lower() for k in meta}:
            f.bad("size says sealed (%d == %d+%d) but the object carries no pcv1 "
                  "metadata; refusing to certify on size alone"
                  % (stored, n, PCV1_OVERHEAD))
        else:
            f.ok("sealed: %d == %d+%d, pcv1 metadata present"
                 % (stored, n, PCV1_OVERHEAD))
    F.append(f)

    f = Finding("F1.MCP_WRITE_FILE_HANDLER", "EXERCISED",
                "The MCP write_file handler itself round-trips through the "
                "control plane over HTTP.")
    mcp_rt = ev.get("mcp_roundtrip")
    if mcp_rt is None:
        f.skip(UNEXERCISABLE["F1.MCP_WRITE_FILE_HANDLER"])
    elif mcp_rt.get("sha_written") != mcp_rt.get("sha_read"):
        f.bad("MCP round-trip bytes differ")
    elif "not configured" in (mcp_rt.get("write_text") or ""):
        f.bad("write_file returned a SUCCESSFUL result saying %r -- this is the "
              "silent no-op, and a status-code check would have called it green"
              % mcp_rt.get("write_text"))
    else:
        f.ok("MCP write_file/read_file round-trip identical")
    F.append(f)

    # ---------------- F2  every registered tool reachable or backed -----------
    static = set(src.get("registered_tools", []) or [])
    f = Finding("F2.1.TOOLS_ALL_CLASSIFIED", "ASSERTED",
                "Every tool the source registers falls into a class this file "
                "knows how to back. An unclassified tool is a coverage hole, not "
                "a pass -- this is what makes the check survive tool #37.")
    known = set()
    for _n, s in TOOL_CLASSES:
        known |= s
    unclassified = sorted(static - known)
    if not static:
        f.bad("no registered tools parsed from source -- the parser is broken or "
              "the registration idiom moved; refusing to report on an empty set")
    elif unclassified:
        f.bad("%d tool(s) match no class: %s" % (len(unclassified),
                                                 ",".join(unclassified)))
    else:
        f.ok("%d registered tools, all classified" % len(static))
    F.append(f)

    # [SEC-MCP401-RFC9728-V1] THE OLD ASSERTION WAS FALSE AND ITS PASS WAS THE
    # DEFECT. It required a KEYLESS tools/list to return 200 with a whoami-only tool
    # array, and reported "POST /mcp tools/list -> HTTP 401" as a failure. Measured
    # in the bundle: that 401 carries x-powered-by: Express (so the APPLICATION
    # answered, not the ingress) and www-authenticate: Bearer resource_metadata=
    # "<this server>/.well-known/oauth-protected-resource" -- which is exactly what
    # the MCP authorization spec requires of a protected resource server (RFC 9728
    # s5.1). The old check called correct behaviour a defect, and would have called
    # a server that hands its tool list to anonymous callers a PASS.
    #
    # WHAT REPLACES IT IS STRICTLY STRONGER, NOT MERELY DIFFERENT. Every state the
    # old check failed on still fails: 403, 5xx and a connection failure are all
    # "not precisely 401". On top of that it now fails on states the old check
    # PASSED or ignored -- a keyless 200 with a tool array, a bare 401 with no
    # challenge, a challenge that is not Bearer, a challenge with no
    # resource_metadata, and a challenge whose resource_metadata names somebody
    # else's server. Each of those has a negative control in controls() below.
    f = Finding("F2.2.MCP_SURFACE_ANSWERS", "EXERCISED",
                "A KEYLESS POST /mcp tools/list is refused with PRECISELY 401 and "
                "an RFC 9728 challenge: WWW-Authenticate: Bearer carrying a "
                "resource_metadata parameter that names THIS server's own "
                "protected-resource metadata URL. 401 alone is not enough -- a "
                "bare 401 tells an MCP client nothing and the handshake cannot "
                "start -- and a 200 is worse than either, because it means the "
                "surface hands its tool list to an anonymous caller.")
    live = ev.get("mcp_tools_list")
    own = _own_origins(ev, cpenv)
    chal_url = ""
    if _starve(f, st, "app"):
        pass
    elif live is None:
        f.bad("no response from POST /mcp tools/list was captured at all")
    elif live.get("_http") is None:
        f.bad("POST /mcp tools/list never completed -- no HTTP status was obtained "
              "(connection failure). %s" % (live.get("error") or "no error recorded"))
    elif live.get("_http") != 401:
        f.bad("POST /mcp tools/list -> HTTP %s. A protected MCP resource server "
              "must answer an unauthenticated request with 401 and a challenge; "
              "%s is not that.%s"
              % (live.get("_http"), live.get("_http"),
                 (" It returned %d tool(s) to a caller holding no session key: %s"
                  % (len(live.get("tools") or []),
                     ",".join(sorted(live.get("tools") or [])[:6])))
                 if live.get("tools") else ""))
    else:
        scheme, params = _parse_challenge(_hdrs(live).get("www-authenticate"))
        rm = str(params.get("resource_metadata") or "").strip()
        sch, _host, path = _split_url(rm)
        if not scheme:
            f.bad("401 with NO WWW-Authenticate header. The status code is right "
                  "and the response is still useless: a client is told it is "
                  "unauthorized and nothing about where to authenticate.")
        elif scheme != "bearer":
            f.bad("WWW-Authenticate advertises the %r scheme, not Bearer" % scheme)
        elif not rm:
            f.bad("Bearer challenge carries no resource_metadata parameter, so "
                  "there is no discovery document to find (RFC 9728 s5.1)")
        elif sch != "https":
            f.bad("resource_metadata %r is not an absolute https URL" % rm[:120])
        elif not own:
            f.bad("REFUSING TO CERTIFY: the bundle records no url for this server "
                  "(base_url, target_url and MCP_PUBLIC_URL are all absent), so a "
                  "resource_metadata pointing ANYWHERE would look self-referential "
                  "and this check would be unfalsifiable")
        elif _origin(rm) not in own:
            f.bad("resource_metadata points at %s, which is NOT this server (%s). "
                  "A challenge naming a foreign metadata document sends every "
                  "client to somebody else's authorization server."
                  % (_origin(rm), ", ".join(own)))
        elif not _is_pr_path(path):
            f.bad("resource_metadata path is %r. RFC 9728 s3 fixes it at %s "
                  "(optionally with the resource's own path appended); %s is a "
                  "different document." % (path, OAUTH_PR_PATH, path or "an empty path"))
        else:
            chal_url = rm
            f.ok("precisely 401, and the challenge is a well-formed RFC 9728 "
                 "Bearer challenge naming this server: %s" % rm)
    F.append(f)

    # [SEC-VM-DECLARED-V1] THE OLD FAILURE MESSAGE ASSERTED A FALSE FACT ABOUT THE
    # CODE, WHICH IS A DEFECT IN ITS OWN RIGHT. It said index.ts:2910-2911 default
    # WS_VM to 'fleet-workstation' and WS_ZONE to 'us-central1-a' and that the tools
    # "silently use the defaults". Re-measured at control-plane/src/index.ts blob
    # 15f48771 (main 868d8749), the whole file read and the blob oid recomputed off
    # the bytes: BOTH default to the EMPTY STRING at index.ts:3119-3120, the
    # [SEC-VM-UNCONFIGURED-V1] guard at index.ts:1666-1718 WITHHOLDS vm_status /
    # vm_start / vm_stop / vm_resize from registration when either is empty, and
    # harVmUnset() (index.ts:3122) makes /api/vm/status, /api/vm/start and
    # /api/vm/stop answer 503. The control is correct and already fail-closed. A
    # strain acting on the old message would have deleted a working guard and
    # restored the guessed instance name it was written to remove.
    #
    # SO THE STATE IS DECLARED, NOT BROKEN, and the check now asserts the thing that
    # actually matters in BOTH directions. Unset must mean withheld; set must mean
    # backed. Neither half is satisfiable by a string being non-empty, which is all
    # the old check ever measured.
    f = Finding("F2.3.VM_TOOLS_BACKED", "ASSERTED",
                "A workstation is a DECLARED install option and this asserts the "
                "declaration is honoured. With WS_VM/WS_ZONE SET: the named "
                "instance resolves and the four VM tools are registered. With them "
                "UNSET: the four tools are WITHHELD from registration and "
                "/api/vm/status|start|stop answer 503. Declaring one variable and "
                "not the other is a misconfiguration either way.")
    inst = ev.get("vm_instance")
    vm = str(cpenv.get("WS_VM", "") or "").strip()
    zone = str(cpenv.get("WS_ZONE", "") or "").strip()
    roster = _live_tool_names(ev)
    probes = _vm_route_probes(ev)
    if _starve(f, st, "cp"):
        pass
    elif bool(vm) != bool(zone):
        f.bad("HALF-DECLARED: WS_VM=%r WS_ZONE=%r. The guard needs BOTH, so this "
              "install declares a workstation and still withholds every VM tool -- "
              "the operator gets neither the feature nor an error." % (vm, zone))
    elif vm and zone:
        absent = sorted(t for t in VM_GUARDED_TOOLS if roster is not None and t not in roster)
        if inst is None or inst.get("_http") != 200:
            f.bad("WS_VM=%s WS_ZONE=%s are declared but instance %s in %s does not "
                  "resolve (HTTP %s), so all four VM tools address a machine that "
                  "is not there" % (vm, zone, vm, zone, (inst or {}).get("_http")))
        elif absent:
            f.bad("instance %s exists and the tools are declared, but the live "
                  "surface does not register %s -- the guard is withholding on a "
                  "CONFIGURED install" % (vm, ",".join(absent)))
        else:
            f.ok("%s in %s exists, status %s%s"
                 % (vm, zone, inst.get("status"),
                    "" if roster is None
                    else "; all four VM tools present in the live roster"))
    else:
        # DECLARED NO-WORKSTATION. The assertion is the WITHHOLDING, and it is
        # judged only against what the RUNNING system returned. source
        # .registered_tools lists all four here whatever the guard did -- it is a
        # regex over index.ts -- so reading it would turn a working control into a
        # permanent red.
        leaked = sorted(t for t in VM_GUARDED_TOOLS if roster is not None and t in roster)
        answered = sorted("%s -> %s" % (r, (probes[r] or {}).get("_http"))
                          for r in probes if (probes[r] or {}).get("_http") != 503)
        have_routes = len(probes) == len(VM_GUARDED_ROUTES)
        if leaked:
            f.bad("THE GUARD DID NOT HOLD: no workstation is declared "
                  "(WS_VM and WS_ZONE both empty) and the live surface registers "
                  "%s anyway. vm_start/vm_stop/vm_resize STAGE an approval, so "
                  "this costs the operator a Face ID on an instance that does not "
                  "exist." % ",".join(leaked))
        elif answered:
            f.bad("no workstation is declared and the VM routes answer anyway: %s. "
                  "harVmUnset() should make each of them 503." % ", ".join(answered))
        elif roster is None and not have_routes:
            f.skip("NOT DEMONSTRATED, AND IT IS NOT UNEXERCISABLE. This install "
                   "declares no workstation (WS_VM and WS_ZONE both empty), which "
                   "is a supported state, and the correct assertion is that the "
                   "four VM tools are WITHHELD and the three routes 503. Neither "
                   "can be judged from this bundle: it carries no successful "
                   "tools/list (the keyless one is a 401 by design, which is what "
                   "F2.2 asserts) and no probe of the routes. Two fields close it, "
                   "both keyless or already-authenticated calls the collector is "
                   "making anyway: ev['mcp_tools_authed'] = {'_http':200, "
                   "'tools':[names]} from an authenticated tools/list, and "
                   "ev['vm_route_probes'] = {'GET /api/vm/status': {'_http':503}, "
                   "'POST /api/vm/start': {...}, 'POST /api/vm/stop': {...}}. "
                   "Either one alone promotes this to a real verdict. Do NOT put "
                   "this id on UNEXERCISABLE -- it is exercisable, and listing it "
                   "would buy a green for an assertion nobody ran.")
        else:
            f.ok("no workstation declared and the control holds: %s%s%s"
                 % ("" if roster is None else
                    "none of %s registered on the live surface" % ",".join(VM_GUARDED_TOOLS),
                    "; " if (roster is not None and have_routes) else "",
                    "" if not have_routes else
                    "all %d /api/vm/* routes answer 503" % len(probes)))
    F.append(f)

    # [SEC-DEVGATE-GITVAULT-V1] THIS FINDING ASSERTED THE WRONG THING AND ITS
    # REQUIREMENT TEXT DESCRIBED CODE THAT IS NOT THERE. Both are fixed here.
    #
    # THE ASSERTION. It read gitvault_bucket_get and called a 200 "the git vault is
    # backed". Bucket existence is not tool registration. gittools.ts
    # registerGitTools() requires GIT_REPO_ID *and* GIT_BUCKET and RETURNS [] --
    # all seven git tools withheld -- when either is unset, and the call site sits
    # in a try/catch that only console.error()s, so a broken require removes every
    # git tool while the service still answers 200 to everything else. The old
    # check could not see any of that, and on a lane with neither variable set it
    # resolved the LAKE bucket instead, found it, and reported the git vault
    # backed: a manufactured green over tools that were not registered at all.
    #
    # THE REQUIREMENT TEXT. It cited "index.ts:84 falls back to <project>-datalake".
    # NO SUCH FALLBACK EXISTS AT THIS COMMIT -- registerGitTools() has no fallback
    # of any kind. Requirement text that describes code which is gone is a defect
    # in a file whose whole job is to be believed, and it is the same class of
    # error as the WS_VM message [SEC-VM-DECLARED-V1] removed: a strain acting on
    # it would go looking for a default that is not there.
    #
    # WHAT THE COLLECTOR NOW SUPPLIES. gitvault_tools_configured records GIT_BUCKET
    # and GIT_REPO_ID off the surface that REGISTERS the tools (the MCP revision
    # where there is one, the control plane otherwise) plus the derived
    # `registered` boolean, and gitvault_bucket_channel says which name was
    # resolved and from where. When `registered` is true the bucket name IS
    # GIT_BUCKET by construction, so the two halves below cannot disagree.
    f = Finding("F2.4.GITVAULT_BUCKET_BACKED", "ASSERTED",
                "THE SEVEN GIT TOOLS ARE REGISTERED, and the bucket they are "
                "registered against exists. gittools.ts registerGitTools() "
                "requires GIT_REPO_ID AND GIT_BUCKET and returns [] -- withholding "
                "all seven -- when either is unset, and that call sits in a "
                "try/catch that only console.error()s, so a broken require deletes "
                "every git tool while the service still answers 200. 'The bucket "
                "exists' is NOT the claim 'the tools are registered', and a bucket "
                "resolved from anywhere other than GIT_BUCKET is not evidence "
                "about the git vault at all.")
    gv = ev.get("gitvault_bucket_get")
    gvname = ev.get("gitvault_bucket_name", "")
    gvc = ev.get("gitvault_tools_configured") or {}
    if _starve(f, st, "cp"):
        pass
    elif not gvc:
        f.bad("this bundle carries no gitvault_tools_configured, so whether "
              "registerGitTools() registered anything at all was NEVER MEASURED, "
              "and gs://%s existing does not answer it. The collector must record "
              "GIT_BUCKET and GIT_REPO_ID off the surface that registers the git "
              "tools." % (gvname or "?"))
    elif not gvc.get("registered"):
        f.bad("THE GIT TOOLS ARE NOT REGISTERED: %s unset on the surface that "
              "registers them, so registerGitTools() returns [] and all seven git "
              "tools are WITHHELD while the service keeps answering 200. No "
              "bucket, existing or not, can make this green. Bucket channel: %s"
              % (",".join(k for k in ("GIT_REPO_ID", "GIT_BUCKET")
                          if not gvc.get(k)) or "neither",
                 ev.get("gitvault_bucket_channel") or "not recorded"))
    elif not gvname:
        f.bad("both variables are set and yet no git-vault bucket name was "
              "resolved, so the collector and the code disagree about what "
              "GIT_BUCKET names")
    elif gv is None or gv.get("_http") != 200:
        f.bad("the seven git tools ARE registered, against gs://%s, and that "
              "bucket does not exist (HTTP %s) -- so every one of them throws at "
              "call time instead of reporting a misconfiguration"
              % (gvname, (gv or {}).get("_http")))
    else:
        f.ok("GIT_REPO_ID and GIT_BUCKET are both set, so all seven git tools "
             "register, and gs://%s exists. Channel: %s"
             % (gvname, ev.get("gitvault_bucket_channel") or "not recorded"))
    F.append(f)

    routes_ev = ev.get("routes") or {}
    f = Finding("F2.5.MCP_METADATA_ROUTE_PUBLIC", "ASSERTED",
                "The metadata URL the challenge advertises is a route THIS BUILD "
                "registers, and that route is PUBLIC. A server that advertises a "
                "path it does not serve sends every client to a 404; one that "
                "serves it behind the guard the client is trying to satisfy "
                "builds a discovery loop no client escapes.")
    reg = set(routes_ev.get("registered") or [])
    pub = set(routes_ev.get("public_routes") or [])
    if _starve(f, st, "app"):
        pass
    elif not chal_url:
        f.bad("F2.2 could not read a usable metadata URL out of the challenge, so "
              "there is no advertised path to back")
    elif not reg:
        f.bad("the evidence carries no route scan, so the advertised path cannot "
              "be matched against anything this build registers")
    else:
        key = "GET " + (_split_url(chal_url)[2].rstrip("/") or "/")
        if key not in reg:
            f.bad("the challenge advertises %s but this build registers no such "
                  "route. %d route(s) scanned." % (key, len(reg)))
        elif key not in pub:
            f.bad("%s is registered but GUARDED. RFC 9728 metadata must be "
                  "fetchable by an unauthenticated client; a client that must "
                  "already hold a token to learn how to get one is stuck."
                  % key)
        else:
            f.ok("%s is registered and public" % key)
    F.append(f)

    f = Finding("F2.6.MCP_METADATA_DOC_RFC9728", "EXERCISED",
                "The URL the challenge names actually SERVES a document to an "
                "unauthenticated GET, and that document is well formed per RFC "
                "9728 s2: an https 'resource' identifying this server, and a "
                "non-empty 'authorization_servers' array of https urls.")
    doc_ev = ev.get("oauth_protected_resource")
    if _starve(f, st, "app"):
        pass
    elif doc_ev is None:
        f.skip("NOT CAPTURED, AND IT IS NOT UNEXERCISABLE. This assertion needs one "
               "field the evidence bundle does not yet carry: "
               "ev['oauth_protected_resource'] = {'_http': <status>, '_url': <the "
               "url the challenge named>, 'body': <the parsed JSON document>}, "
               "obtained by ONE UNAUTHENTICATED GET of the resource_metadata URL "
               "F2.2 has already verified. That is a keyless GET against a route "
               "F2.5 has already proved is public, so it is entirely exercisable "
               "and MUST NOT be added to UNEXERCISABLE -- doing so would buy a "
               "green for an assertion nobody ran, which is the one thing this "
               "file exists to prevent. It belongs in pipeline/collect-evidence.py "
               "beside the mcp_tools_list probe.")
    elif doc_ev.get("_http") != 200:
        f.bad("GET %s -> HTTP %s. The server advertises this document in every 401 "
              "it issues and does not serve it."
              % (doc_ev.get("_url") or chal_url or OAUTH_PR_PATH, doc_ev.get("_http")))
    elif chal_url and doc_ev.get("_url") and _split_url(doc_ev["_url"]) != _split_url(chal_url):
        f.bad("the captured document came from %s but the challenge names %s -- a "
              "document fetched from a url nobody was sent to proves nothing about "
              "the url they were" % (doc_ev.get("_url"), chal_url))
    else:
        probs = _rfc9728_problems(doc_ev.get("body"), own)
        if probs:
            f.bad("%d RFC 9728 problem(s): %s" % (len(probs), "; ".join(probs)))
        else:
            body = doc_ev.get("body") or {}
            f.ok("served 200 and well formed: resource=%s authorization_servers=%s"
                 % (body.get("resource"),
                    ",".join(str(x) for x in (body.get("authorization_servers") or []))))
    F.append(f)

    f = Finding("F2.BROWSER_TOOLS", "EXERCISED",
                "The browser/CDP tools answer.")
    f.skip(UNEXERCISABLE["F2.BROWSER_TOOLS"])
    F.append(f)

    # ---------------- F3  env vars the code reads are actually set ------------
    # [SEC-VM-DECLARED-V1] WS_VM/WS_ZONE ARE NO LONGER REQUIRED UNCONDITIONALLY --
    # see the note on ENV_ALWAYS_REQUIRED_CP. They are PAIRED instead: an install
    # that names one and not the other is a misconfiguration in either direction,
    # and an install that names neither has declared no workstation and is complete.
    # This is not a relaxation of the file's contract: the property that used to be
    # (badly) approximated here is now asserted directly by F2.3, against the
    # running system rather than against a string's length.
    f = Finding("F3.1.CP_REQUIRED_ENV_SET", "ASSERTED",
                "Every variable index.ts reads WITHOUT a fallback, plus "
                "DATA_LAKE_BUCKET whose default is wrong-and-silent, is present on "
                "the NEW control-plane revision. WS_VM and WS_ZONE are required "
                "only as a PAIR and only when the install declares a workstation "
                "at all -- naming neither is a declared state, naming one is not.")
    req = set(src.get("cp_env_no_default", []) or []) | ENV_ALWAYS_REQUIRED_CP
    if str(cpenv.get("WS_VM", "") or "").strip() or str(cpenv.get("WS_ZONE", "") or "").strip():
        req |= {"WS_VM", "WS_ZONE"}
    req -= {"PORT", "K_SERVICE", "GOOGLE_CLOUD_PROJECT"}   # supplied by Cloud Run
    missing = sorted(r for r in req if not cpenv.get(r))
    if _starve(f, st, "cp"):
        pass
    elif not src.get("cp_env_no_default") and not cpenv:
        f.bad("no evidence: neither the source env scan nor the revision env "
              "was captured")
    elif missing:
        f.bad("%d unset on %s: %s" % (len(missing),
                                      cp_rev.get("name", "?").split("/")[-1],
                                      ",".join(missing)))
    else:
        f.ok("%d required variable(s) present" % len(req))
    F.append(f)

    f = Finding("F3.2.NO_ENV_SET_THAT_CODE_IGNORES", "ASSERTED",
                "The reverse direction. Every variable the installer SETS is one "
                "the code READS. A variable that is set and never read is a lie "
                "in the install -- it is how pc-webauthn-creds got named on "
                "gate-exec by a deploy while exec_server.py reads no such thing.")
    gx_reads = set(src.get("gx_env_read", []) or [])
    cp_reads = set(src.get("cp_env_read", []) or [])
    # BUILD_COMMIT added 2026-08-10 [SEC-DEVGATE-COLLECT-V1]. It is in the same class as
    # K_SERVICE: deployment metadata that is deliberately SET and deliberately NOT read
    # by application code. cloudbuild-dev.yaml step 2 stamps it from `git rev-parse HEAD`
    # of the verified bundle tree so that `run services describe` names the commit that
    # is serving. index.ts reads it nowhere -- verified by grep over the whole file --
    # so without this line the DEV PIPELINE ITSELF would fail F3.2 on every green build
    # and the promotion gate could never open. THIS DOES NOT WEAKEN THE CHECK FOR THE
    # CASE IT WAS WRITTEN FOR: gate-exec:PC_CREDS_SECRET still fails, because that one
    # is a variable the installer set BELIEVING something read it.
    infra = {"PORT", "K_SERVICE", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCP_REGION",
             "BUILD_COMMIT"}
    dead = sorted(["gate-exec:" + k for k in gxenv
                   if k not in gx_reads and k not in infra] +
                  ["control-plane:" + k for k in cpenv
                   if k not in cp_reads and k not in infra])
    # [SEC-DEVGATE-STARVED-V1] AND THIS ONE WAS A FALSE GREEN, NOT A FALSE RED,
    # WHICH IS WORSE THAN ANY OF THE 21 REDS BESIDE IT. `dead` is built by walking
    # cpenv and gxenv, so on a starved bundle BOTH maps are empty, nothing is
    # dead, and this assertion reported "every deployed variable is read by the
    # code" over two revisions nobody had read. Measured on a reconstruction of
    # the incident bundle: F3.2 PASS. The source scan guard below cannot catch it
    # -- the source tree is local and reads perfectly well while the cloud reads
    # are refused. Either revision being starved makes the set half a set, and
    # half a set is not the set this finding asserts over.
    if _starve(f, st, "cp", "gx"):
        pass
    elif not gx_reads and not cp_reads:
        f.bad("no evidence: the source env scan is empty")
    elif dead:
        f.bad("set on a deployed revision but read nowhere in the code: %s"
              % ",".join(dead))
    else:
        f.ok("every deployed variable is read by the code")
    F.append(f)

    f = Finding("F3.3.WEBAUTHN_CREDS_SECRET_EXISTS", "ASSERTED",
                "Every secret a deployed revision names actually exists. The "
                "installer wrote PC_CREDS_SECRET=.../pc-webauthn-creds onto "
                "gate-exec and never created that secret.")
    named = ev.get("named_secrets", {}) or {}
    absent = sorted(k for k, v in named.items() if not v)
    if _starve(f, st, "cp", "gx"):
        pass
    elif not named:
        f.bad("no secret existence evidence captured")
    elif absent:
        f.bad("named by a revision but does not exist: %s" % ",".join(absent))
    else:
        f.ok("%d named secret(s) all exist" % len(named))
    F.append(f)

    # ---------------- F4  Firestore indexes EXIST -----------------------------
    f = Finding("F4.1.INDEX_INVOCATIONS_COUNTED", "ASSERTED",
                "Count pc_index() INVOCATIONS, not grep hits. The string "
                "'indexes composite create' occurs exactly once in the installer "
                "-- inside the helper -- so grepping it returns 1 for any number "
                "of indexes.")
    n_inv = src.get("pc_index_invocations")
    n_grep = src.get("pc_index_grep_hits")
    if n_inv is None:
        f.bad("installer not parsed")
    elif n_inv < 1:
        f.bad("zero pc_index() call sites found -- the parser or the installer moved")
    else:
        f.ok("%s invocation(s); the naive grep would have said %s"
             % (n_inv, n_grep))
    F.append(f)

    f = Finding("F4.2.INDEXES_ACTUALLY_EXIST", "ASSERTED",
                "One live composite index exists per pc_index() invocation. The "
                "installer's own 'NOT MADE' line is indistinguishable between "
                "'already exists' and 'refused', so acceptance is not evidence -- "
                "existence is.")
    live_idx = ev.get("firestore_indexes")
    want = src.get("pc_index_specs", []) or []
    if live_idx is None:
        f.bad("could not list Firestore composite indexes")
    elif not want:
        f.bad("no pc_index specs parsed from the installer")
    else:
        have = set()
        for ix in live_idx:
            fields = tuple((fc.get("fieldPath"), (fc.get("order") or "").lower())
                           for fc in ix.get("fields", [])
                           if fc.get("fieldPath") != "__name__")
            have.add((ix.get("_collectionGroup"), (ix.get("queryScope") or "").upper(),
                      fields, ix.get("state")))
        missing = []
        for spec in want:
            key_fields = tuple((a, b.lower()) for a, b in spec["fields"])
            hit = [h for h in have
                   if h[0] == spec["collection"]
                   and h[1] == spec["scope"].upper()
                   and h[2] == key_fields]
            if not hit:
                missing.append("%s(%s)" % (spec["collection"],
                                           "+".join(a for a, _ in spec["fields"])))
            elif all(h[3] not in ("READY", "CREATING") for h in hit):
                missing.append("%s[state=%s]" % (spec["collection"],
                                                 ",".join(sorted({h[3] or "?" for h in hit}))))
        if missing:
            f.bad("%d of %d index(es) absent or not building: %s"
                  % (len(missing), len(want), ",".join(missing)))
        else:
            f.ok("all %d index(es) exist" % len(want))
    F.append(f)

    # ---------------- F5  approval path ---------------------------------------
    f = Finding("F5.1.KMS_KEY_EXISTS", "ASSERTED",
                "The approval signing key exists with the purpose and algorithm "
                "both the signer and the verifier hardcode.")
    key = ev.get("kms_key")
    if key is None or key.get("_http") != 200:
        f.bad("approval-signing key not found (HTTP %s)" % (key or {}).get("_http"))
    elif key.get("purpose") != "ASYMMETRIC_SIGN":
        f.bad("purpose is %s, not ASYMMETRIC_SIGN" % key.get("purpose"))
    else:
        alg = (key.get("versionTemplate") or {}).get("algorithm")
        if alg != "EC_SIGN_P256_SHA256":
            f.bad("algorithm is %s, not EC_SIGN_P256_SHA256" % alg)
        else:
            f.ok("ASYMMETRIC_SIGN / EC_SIGN_P256_SHA256")
    F.append(f)

    f = Finding("F5.2.EXECUTOR_CANNOT_SIGN", "ASSERTED",
                "On the KEY's own IAM policy: the control plane holds "
                "roles/cloudkms.signer, and the executor holds publicKeyViewer "
                "and NOTHING that can sign. The negative is asserted explicitly, "
                "because handing the verifier the minting key was the Stage A hole.")
    pol = ev.get("kms_key_iam")
    cp_sa = "serviceAccount:" + ev.get("cp_sa", "")
    gx_sa = "serviceAccount:" + ev.get("gx_sa", "")
    if _starve(f, st, "cp", "gx"):
        pass
    elif pol is None:
        f.bad("could not read the key IAM policy")
    else:
        roles_cp, roles_gx = set(), set()
        for b in pol.get("bindings", []) or []:
            mem = set(b.get("members", []) or [])
            if cp_sa in mem:
                roles_cp.add(b.get("role"))
            if gx_sa in mem:
                roles_gx.add(b.get("role"))
        signing = {"roles/cloudkms.signer", "roles/cloudkms.signerVerifier",
                   "roles/cloudkms.admin", "roles/cloudkms.cryptoKeyEncrypterDecrypter",
                   "roles/owner", "roles/editor"}
        bad_gx = sorted(roles_gx & signing)
        if bad_gx:
            f.bad("THE EXECUTOR CAN SIGN ITS OWN APPROVALS: it holds %s"
                  % ",".join(bad_gx))
        elif "roles/cloudkms.signer" not in roles_cp:
            f.bad("the control plane does NOT hold roles/cloudkms.signer, so it "
                  "cannot sign an approval at all (holds %s)"
                  % (",".join(sorted(roles_cp)) or "nothing"))
        elif "roles/cloudkms.publicKeyViewer" not in roles_gx:
            f.bad("the executor holds no publicKeyViewer, so it cannot VERIFY "
                  "(holds %s)" % (",".join(sorted(roles_gx)) or "nothing"))
        else:
            f.ok("cp=signer, gx=publicKeyViewer only")
    F.append(f)

    f = Finding("F5.3.SIG_KEY_VERSION_PAIRED", "ASSERTED",
                "The singular version the control plane signs with is a MEMBER of "
                "the allowlist the executor verifies against, read off BOTH new "
                "revisions. A mismatch 403s every approval including the job that "
                "would undo it.")
    sing = (cpenv.get("APPROVAL_SIG_KEY_VERSION") or "").strip()
    plural = [k.strip() for k in (gxenv.get("APPROVAL_SIG_KEY_VERSIONS") or "").split(",") if k.strip()]
    if _starve(f, st, "cp", "gx"):
        pass
    elif not sing and not plural:
        f.skip("Stage C signing is not configured on either revision; both "
               "variables are unset, so there is nothing to pair. This is the "
               "documented default and it is NOT a pass.")
    elif not sing:
        f.bad("the executor has an allowlist but the control plane has no signing "
              "version -- every approval will be unsigned and refused")
    elif not plural:
        f.bad("the control plane signs with %s but the executor has an EMPTY "
              "allowlist -- it will refuse every approval" % sing.split("/")[-1])
    elif sing not in plural:
        f.bad("singular %s is NOT in the executor allowlist %s"
              % (sing, plural))
    else:
        f.ok("version %s is a member of the allowlist" % sing.split("/")[-1])
    F.append(f)

    f = Finding("F5.4.EXECUTOR_RP_ID_SET", "ASSERTED",
                "gate-exec reads PC_RP_ID at exec_server.py:391 and :472 and "
                "DEFAULTS IT TO 'example.invalid'. Unset means the executor "
                "verifies passkey assertions against a relying party that is not "
                "the gate -- a silent wrong default, not an error.")
    rp = gxenv.get("PC_RP_ID", "")
    cp_host = cpenv.get("WA_RP_ID", "")
    if _starve(f, st, "gx"):
        pass
    elif not rp:
        f.bad("PC_RP_ID is UNSET on the executor; it will use 'example.invalid'")
    elif cp_host and rp != cp_host:
        f.bad("executor PC_RP_ID=%r but the gate is served at %r" % (rp, cp_host))
    else:
        f.ok(rp)
    F.append(f)

    f = Finding("F5.APPROVAL_ROUNDTRIP", "EXERCISED",
                "An approval is signed by the control plane and executed by the "
                "gated executor end to end.")
    f.skip(UNEXERCISABLE["F5.APPROVAL_ROUNDTRIP"])
    F.append(f)

    # ================= F6  [SEC-SURFACE-SMOKE-V1] THE TWO SURFACES =============
    # Read BOTH services. Judge each against what IT is supposed to be, never
    # against the other one's environment.
    mode, mode_detail = _split_evidence(ev)
    con, mc = _surf(ev, "console"), _surf(ev, "mcp")
    conenv, mcenv = _surf_env(ev, "console"), _surf_env(ev, "mcp")
    mc_refusal = _invoker_refusal(mc)

    def _skip_or(f, extra=""):
        """Single place where 'this install has no split' becomes NOT-EXERCISED.
        Never returns PASS. Anything other than the clean single-service case
        falls through to the caller's real judgement."""
        if mode == "single":
            f.skip(SINGLE_SERVICE_REASON + " (" + mode_detail + ")" + extra)
            return True
        return False

    f = Finding("F6.0.SURFACE_SPLIT_PRESENT", "ASSERTED",
                "Both halves of the split are in the evidence bundle. Reading one "
                "service and reporting on the other's tools is the failure this "
                "whole section exists to stop, so the bundle must carry BOTH "
                "revisions before any per-surface assertion means anything.")
    if mode == "split":
        f.ok("console=%s mcp=%s" % (con.get("service", SURFACE_SERVICES["console"]),
                                    mc.get("service", SURFACE_SERVICES["mcp"])))
    elif mode == "half":
        f.bad("HALF A SPLIT: %s. One service of a two-service release is missing "
              "from the bundle, so every per-surface assertion below would be "
              "judging the wrong environment. This is a FAIL, not a skip."
              % mode_detail)
    else:
        f.skip(SINGLE_SERVICE_REASON + " (" + mode_detail + ")")
    F.append(f)

    f = Finding("F6.1.SURFACE_ENV_DISTINCT", "ASSERTED",
                "PC_SURFACE is 'console' on the console revision and 'mcp' on the "
                "MCP revision. One image is deployed twice and this variable is "
                "the ONLY thing that differs; if both copies carry the same value "
                "the split has silently collapsed and one half of the route table "
                "is served by nothing at all.")
    if not _skip_or(f):
        cs = (conenv.get("PC_SURFACE") or "").strip().lower()
        ms = (mcenv.get("PC_SURFACE") or "").strip().lower()
        if not cs or not ms:
            f.bad("PC_SURFACE console=%r mcp=%r -- unset on a service means EVERY "
                  "route registers there, so the console would serve /mcp and the "
                  "public MCP service would serve the gate" % (cs, ms))
        elif cs == ms:
            f.bad("BOTH services carry PC_SURFACE=%r. The split has collapsed: the "
                  "other half of the route table is served by neither service."
                  % cs)
        elif cs != "console" or ms != "mcp":
            f.bad("surfaces are crossed: console revision says %r, mcp revision "
                  "says %r" % (cs, ms))
        else:
            f.ok("console=console, mcp=mcp")
    F.append(f)

    f = Finding("F6.2.CONSOLE_IS_IAP_FRONTED", "EXERCISED",
                "The console is behind IAP, proven BY THE RESPONSE HEADER. "
                "x-goog-iap-generated-response: true is generated by IAP and by "
                "nothing else. Both surfaces refuse an anonymous caller, so the "
                "status code is worthless here -- it is identical on a healthy "
                "console, a broken one, and one nobody can invoke.")
    if not _skip_or(f):
        sh = _shape(con.get("probe_root"))
        code = (con.get("probe_root") or {}).get("_http")
        if sh == "iap":
            f.ok("HTTP %s with x-goog-iap-generated-response: true -- IAP is at "
                 "the edge" % code)
        elif sh == "app":
            f.bad("HTTP %s carries Express headers and NO IAP header: the console "
                  "container is answering anonymous callers directly. IAP is NOT "
                  "in front of the bootstrap path." % code)
        elif sh == "run-denied":
            f.bad("HTTP %s with neither an IAP header nor an app header: Cloud Run "
                  "refused the caller before IAP or the container was reached, so "
                  "IAP is NOT PROVEN to be in front. A status code alone is not "
                  "evidence of protection." % code)
        elif sh == "none":
            f.bad("no probe of the console root was captured")
        else:
            f.bad("HTTP %s answered in a shape this file cannot classify; refusing "
                  "to certify IAP on an unrecognised response" % code)
    F.append(f)

    f = Finding("F6.3.MCP_IS_NOT_IAP_FRONTED", "EXERCISED",
                "The MCP service is NOT behind IAP. IAP consumes the Authorization "
                "header and an MCP client has no Google identity, so IAP here does "
                "not protect the service -- it makes it unusable. The IAP header "
                "must be ABSENT, and its absence is checked as a header, not "
                "inferred from a status code.")
    if not _skip_or(f):
        p = mc.get("probe_mcp") or mc.get("probe_root")
        sh = _shape(p)
        code = (p or {}).get("_http")
        if sh == "iap":
            f.bad("HTTP %s carries x-goog-iap-generated-response: true. IAP HAS "
                  "LEAKED ONTO THE MCP SERVICE and every MCP client is locked out. "
                  "This is exactly the defect that shipped, and a status-code "
                  "check would have called it green." % code)
        elif sh == "app":
            f.ok("HTTP %s, Express-shaped, no IAP header" % code)
        elif sh == "run-denied" and mc_refusal:
            f.skip(ORG_POLICY_REASON + " Recorded refusal: " + mc_refusal[:200])
        elif sh == "run-denied":
            f.bad("HTTP %s with no IAP header and no app header, and NO org-policy "
                  "refusal was recorded in the evidence. The service is refusing "
                  "before the container runs and nothing explains why -- that is "
                  "broken, not excused." % code)
        elif sh == "none":
            f.bad("no probe of the MCP service was captured")
        else:
            f.bad("HTTP %s answered in an unclassifiable shape" % code)
    F.append(f)

    f = Finding("F6.4.MCP_SERVES_MCP", "EXERCISED",
                "/mcp on the MCP service REACHES THE APP. The healthy answer is "
                "the container's own challenge -- x-powered-by: Express with "
                "www-authenticate: Bearer resource_metadata= -- not merely some "
                "4xx. An IAP-shaped or frontend-shaped refusal means the transport "
                "is unreachable no matter what the code says.")
    if not _skip_or(f):
        p = mc.get("probe_mcp")
        sh = _shape(p)
        code = (p or {}).get("_http")
        h = _hdrs(p)
        if sh == "iap":
            f.bad("HTTP %s is IAP-shaped: /mcp is COMPLETELY UNREACHABLE to every "
                  "MCP client. This is the defect that survived the life of the "
                  "release because a check read the status code." % code)
        elif sh == "app":
            if code == 200 or "resource_metadata=" in h.get("www-authenticate", ""):
                f.ok("HTTP %s from the app: %s" % (
                    code, h.get("www-authenticate", "x-powered-by: Express")[:80]))
            else:
                f.bad("HTTP %s reached the app but carries no MCP challenge "
                      "(www-authenticate: Bearer resource_metadata=), so the OAuth "
                      "discovery an MCP client needs is not being advertised" % code)
        elif sh == "run-denied" and mc_refusal:
            f.skip(ORG_POLICY_REASON + " Recorded refusal: " + mc_refusal[:200])
        elif sh == "run-denied":
            f.bad("HTTP %s refused at the Cloud Run frontend with no recorded "
                  "org-policy refusal to explain it" % code)
        elif sh == "none":
            f.bad("no probe of /mcp on the MCP service was captured")
        else:
            f.bad("HTTP %s answered in an unclassifiable shape" % code)
    F.append(f)

    f = Finding("F6.5.CONSOLE_WITHHOLDS_MCP", "ASSERTED",
                "The console does NOT serve /mcp. This is ASSERTED off the source "
                "route table and the boot log rather than probed, and deliberately "
                "so: IAP answers before the application does, so a probe of the "
                "console can never distinguish 'route withheld' from 'IAP refused' "
                "-- it returns the identical IAP 401 either way.")
    if not _skip_or(f):
        rmap = (ev.get("routes") or {}).get("map") or {}
        entries = rmap.get("entries") or {}
        withheld = con.get("routes_withheld")
        bad_keys = [k for k in ("POST /mcp", "GET /mcp")
                    if entries.get(k) not in ("mcp",)]
        if not entries:
            f.bad("no PC_SURFACE_MAP was parsed from the source, so nothing "
                  "certifies which surface /mcp belongs to")
        elif bad_keys:
            f.bad("PC_SURFACE_MAP puts %s on the console (or on 'both'); the "
                  "console would then serve the MCP transport from behind IAP, "
                  "where no MCP client can reach it"
                  % ",".join("%s=%r" % (k, entries.get(k)) for k in bad_keys))
        elif withheld is not None and int(withheld) < 1:
            f.bad("the console boot log reports %s route(s) withheld: the surface "
                  "wrapper registered everything, so /mcp is on the console too"
                  % withheld)
        else:
            f.ok("PC_SURFACE_MAP assigns POST /mcp and GET /mcp to the mcp surface"
                 + ("; console withheld %s route(s) at boot" % withheld
                    if withheld is not None else ""))
    F.append(f)

    f = Finding("F6.6.ROOT_IS_CONSOLE_ONLY", "EXERCISED",
                "GET / is console-only, so the MCP service 404s at its root AND "
                "THAT IS CORRECT, NOT A FAILURE. The 404 must come from the "
                "application -- an app-shaped 404 proves the route table split "
                "took effect. A 200 here would mean a console page is being served "
                "by the public, IAP-free service.")
    if not _skip_or(f):
        p = mc.get("probe_root")
        sh = _shape(p)
        code = (p or {}).get("_http")
        if sh == "app" and code == 404:
            f.ok("HTTP 404 from the app at the MCP root -- correct: GET / is "
                 "console-only and the MCP service does not register it")
        elif sh == "app" and code == 200:
            f.bad("HTTP 200 at the MCP root: a console page is being served by the "
                  "PUBLIC, IAP-FREE service. The route split did not take effect.")
        elif sh == "app":
            f.bad("HTTP %s from the app at the MCP root; expected a 404 from an "
                  "unregistered route" % code)
        elif sh == "iap":
            f.bad("HTTP %s is IAP-shaped at the MCP root: IAP is on the MCP "
                  "service" % code)
        elif sh == "run-denied" and mc_refusal:
            f.skip(ORG_POLICY_REASON + " Recorded refusal: " + mc_refusal[:200])
        elif sh == "run-denied":
            f.bad("HTTP %s refused at the frontend with no recorded org-policy "
                  "refusal" % code)
        elif sh == "none":
            f.bad("no probe of the MCP service root was captured")
        else:
            f.bad("HTTP %s answered in an unclassifiable shape" % code)
    F.append(f)

    f = Finding("F6.7.MCP_PUBLIC_INVOKER", "ASSERTED",
                "allUsers holds roles/run.invoker on the MCP service. Without it "
                "Cloud Run refuses every anonymous caller at the frontend and the "
                "MCP transport is unreachable regardless of what the application "
                "would have done. A MISSING binding with a RECORDED org-policy "
                "refusal is NOT-EXERCISED; a missing binding with no recorded "
                "reason is a FAIL.")
    if not _skip_or(f):
        if _has_allusers_invoker(mc):
            f.ok("allUsers -> roles/run.invoker present on %s"
                 % mc.get("service", SURFACE_SERVICES["mcp"]))
        elif mc_refusal:
            f.skip(ORG_POLICY_REASON + " Recorded refusal: " + mc_refusal[:200])
        else:
            f.bad("allUsers does NOT hold roles/run.invoker on the MCP service and "
                  "no org-policy refusal was recorded. Every MCP client gets a "
                  "Google Frontend 403 and nothing in the bundle explains it.")
    F.append(f)

    f = Finding("F6.8.CONSOLE_INVOKER_NOT_PUBLIC", "ASSERTED",
                "allUsers does NOT hold roles/run.invoker on the console. Enabling "
                "IAP revokes that binding as a side effect; if it is present again "
                "the console is reachable around IAP by anyone.")
    if not _skip_or(f):
        if _has_allusers_invoker(con):
            f.bad("allUsers HOLDS roles/run.invoker on the console service: the "
                  "bootstrap surface is publicly invokable and IAP is not the only "
                  "way in")
        elif not (con.get("run_iam") or {}).get("bindings"):
            f.bad("no run IAM policy captured for the console, so the negative "
                  "cannot be asserted -- an unread policy is not an absent binding")
        else:
            f.ok("allUsers absent from the console run.invoker bindings")
    F.append(f)

    f = Finding("F6.9.REQUIRED_ENV_ON_BOTH", "ASSERTED",
                "Every variable the code needs is present on BOTH revisions. One "
                "image serves both services, so a variable set on the console and "
                "forgotten on the MCP service breaks that half silently -- and "
                "F3.1, which reads the console alone, would never see it. This is "
                "the specific failure that reading one service produces.")
    if not _skip_or(f):
        req = set(src.get("cp_env_no_default", []) or []) | ENV_ALWAYS_REQUIRED_CP
        # [SEC-VM-DECLARED-V1] Same pairing rule as F3.1, applied across BOTH
        # surfaces: if EITHER copy declares a workstation, BOTH must, or the half
        # that does not withholds the VM tools while the half that does registers
        # them -- one image, two behaviours, and no error anywhere.
        if any(str(e.get(k, "") or "").strip()
               for e in (conenv, mcenv) for k in ("WS_VM", "WS_ZONE")):
            req |= {"WS_VM", "WS_ZONE"}
        req -= {"PORT", "K_SERVICE", "GOOGLE_CLOUD_PROJECT", "PC_IAP_AUD"}
        if not conenv and not mcenv:
            f.bad("neither surface revision carried any environment")
        else:
            gaps = []
            for name, envd in (("console", conenv), ("mcp", mcenv)):
                for r in sorted(req):
                    if not envd.get(r):
                        gaps.append("%s:%s" % (name, r))
            if gaps:
                f.bad("%d variable(s) missing from a surface that needs them: %s"
                      % (len(gaps), ",".join(gaps)))
            else:
                f.ok("%d required variable(s) present on both surfaces" % len(req))
    F.append(f)

    # ================= F7  THE ROUTE TABLE THE SPLIT IS BUILT ON ==============
    # route-audit.mjs runs as a BUILD STEP and hard-fails on a NEW public route.
    # It does NOT fail when a route DISAPPEARS: indenting one registration hides
    # it from a column-zero-anchored regex and the audit still exits 0. Worse, a
    # vanished PUBLIC route is printed as "now guarded (was public)" -- reported
    # as a security IMPROVEMENT. That cannot be fixed in the baseline, which is
    # inert data, and fixing it in the audit risks bricking the build. So it is
    # caught HERE instead, where a false positive costs a report and not a deploy.
    routes = ev.get("routes") or {}
    rbase = (ev.get("route_baseline") or {}).get("surface_split") or {}
    anch = routes.get("anchored") or {}
    tol = routes.get("tolerant") or {}
    rmap = routes.get("map") or {}

    f = Finding("F7.1.ROUTE_TABLE_UNCHANGED", "ASSERTED",
                "The route table still has the shape route-baseline.json records. "
                "route-audit.mjs exits 0 when a route VANISHES -- it only hard-"
                "fails on a NEW public route, a wildcard, or a missing connector "
                "route. A disappearance is caught here instead.")
    if not anch or not rbase:
        f.bad("no route scan or no recorded baseline counts in the evidence")
    else:
        diffs = []
        for k, label in (("total", "total"), ("guarded", "guarded"),
                         ("public", "public")):
            want, got = rbase.get("audit_visible_" + k, rbase.get(k)), anch.get(k)
            if k == "total":
                want = rbase.get("audit_visible_total")
            if want is not None and got is not None and want != got:
                diffs.append("%s %s->%s" % (label, want, got))
        if diffs:
            f.bad("the audit-visible route table MOVED: %s. route-audit.mjs would "
                  "still exit 0 for a disappearance." % ", ".join(diffs))
        else:
            f.ok("audit-visible %s/%s/%s matches the baseline"
                 % (anch.get("total"), anch.get("guarded"), anch.get("public")))
    F.append(f)

    f = Finding("F7.2.SURFACE_PARTITION_TOTAL", "ASSERTED",
                "PC_SURFACE_MAP partitions the whole table: every registered route "
                "names a surface, no map entry names a route that no longer "
                "exists, and console + mcp + both equals the recorded totals. A "
                "route on NEITHER service throws at boot; a DEAD map entry throws "
                "nowhere at all and is invisible to the build.")
    entries = rmap.get("entries") or {}
    if not entries:
        f.bad("PC_SURFACE_MAP was not parsed from the source")
    elif "registered" not in routes:
        # [SEC-ONE-SCANNER-V2] THE HALF-ANSWER USED TO PASS. unmapped and
        # dead_map_entries are derived from the ROUTE TABLE, which collect-evidence.py
        # no longer scans for itself -- it reads the table route-audit.mjs emits, and
        # when no table was emitted it OMITS every field derived from one. entries,
        # though, is parsed straight out of index.ts and is present either way. So
        # `routes.get("unmapped") or []` reads an unmeasured field as "none found",
        # and this assertion would have gone green on the surface counts alone while
        # certifying a partition nothing checked. ABSENT, NEVER PASSED.
        f.bad("PC_SURFACE_MAP parsed %d entries, but the evidence carries no route "
              "table (routes.registered is absent), so nothing can say whether those "
              "entries partition the routes actually registered. See "
              "routes.table_source for why the table is missing. The surface counts "
              "alone are NOT this assertion." % len(entries))
    else:
        n_con = sum(1 for v in entries.values() if v == "console")
        n_mcp = sum(1 for v in entries.values() if v == "mcp")
        n_both = sum(1 for v in entries.values() if v == "both")
        unmapped = routes.get("unmapped") or []
        deadmap = routes.get("dead_map_entries") or []
        probs = []
        if unmapped:
            probs.append("%d route(s) name no surface and would THROW at boot: %s"
                         % (len(unmapped), ",".join(sorted(unmapped)[:5])))
        if deadmap:
            probs.append("%d DEAD map entr(ies) -- named in PC_SURFACE_MAP with no "
                         "registration in the source: %s"
                         % (len(deadmap), ",".join(sorted(deadmap)[:5])))
        for label, want, got in (("console", rbase.get("console"), n_con),
                                 ("mcp", rbase.get("mcp"), n_mcp),
                                 ("both", rbase.get("both"), n_both)):
            if want is not None and want != got:
                probs.append("%s surface %s->%s" % (label, want, got))
        if probs:
            f.bad("; ".join(probs))
        else:
            f.ok("%d entries partition cleanly: console=%d mcp=%d both=%d"
                 % (len(entries), n_con, n_mcp, n_both))
    F.append(f)

    f = Finding("F7.3.AUDIT_SEES_EVERY_REGISTRATION", "ASSERTED",
                "Every route registration is VISIBLE to route-audit.mjs. Its regex "
                "is anchored at column zero, so a registration indented into an if "
                "or a try is scanned by nothing: its handler is never searched for "
                "a guard, and removing that guard would never be reported as a new "
                "public route. An invisible registration is a hole in the guard "
                "scanner, not merely a count that drifted.")
    if not anch or not tol:
        f.bad("the evidence carries no anchored/indent-tolerant comparison")
    elif anch.get("total") == tol.get("total"):
        f.ok("both scans find %s registrations; the audit has no blind spot"
             % anch.get("total"))
    else:
        hidden = routes.get("hidden") or []
        f.bad("the audit sees %s registrations but the source has %s. HIDDEN FROM "
              "THE GUARD SCANNER: %s. Each is indented out of reach of the "
              "column-zero regex, so route-audit.mjs never inspects its handler."
              % (anch.get("total"), tol.get("total"),
                 ",".join(sorted(hidden)) or "(not enumerated)"))
    F.append(f)

    return F


# --------------------------------------------------------------------------
# SEEDS -- one per assertion. Each returns a MUTATED COPY of the evidence that
# must make that finding FAIL. In-memory only; no cloud project is touched.
# --------------------------------------------------------------------------
def _cpenv_set(ev, k, v):
    for c in ev["cp_revision"]["template"]["containers"]:
        c["env"] = [e for e in c.get("env", []) if e["name"] != k]
        if v is not None:
            c["env"].append({"name": k, "value": v})
    return ev


def _gxenv_set(ev, k, v):
    for c in ev["gx_revision"]["template"]["containers"]:
        c["env"] = [e for e in c.get("env", []) if e["name"] != k]
        if v is not None:
            c["env"].append({"name": k, "value": v})
    return ev


def seeds():
    """id -> (description, mutator). The mutator must force that id to FAIL."""
    def s_rev(ev):
        # [SEC-DEVGATE-STARVED-V1] BOTH HALVES ARE SYNTHESISED, the way s_bytes
        # synthesises a round-trip. The old seed rewrote cp_revision["name"] alone,
        # so on a bundle whose service read was REFUSED -- where cp_latest_created
        # is empty -- the mutation produced "no revision name captured", a skip,
        # instead of the mismatch this seed names, and F0 was reported DEAD for a
        # check that is perfectly alive. A seed that only works on one shape of
        # bundle is a seed that stops proving anything the day the shape changes.
        ev["cp_latest_created"] = ("projects/p/l/r/s/x/revisions/fresh-00002-bbb")
        ev.setdefault("cp_revision", {})["name"] = (
            "projects/p/l/r/s/x/revisions/stale-00001-aaa")
        return ev

    def s_bucket_unset(ev):
        return _cpenv_set(ev, "DATA_LAKE_BUCKET", None)

    def s_bucket_missing(ev):
        ev["bucket_get"] = {"_http": 404}
        return ev

    def s_perm(ev):
        # This is ALSO the LEGACY bundle shape -- no `measured` key at all, which
        # is what every bundle written before collect-evidence.py blob a0204872
        # carries. Such a bundle must still be JUDGED on its permission list and
        # never reclassified as unmeasured, so this seed pins the pre-fix shape as
        # well as the defect. It covers the MEASURED denial only; the unmeasured
        # branch is carried by the three F1.3 controls in controls().
        ev["bucket_perms"] = {"permissions": ["storage.objects.create"]}
        return ev

    def s_bytes(ev):
        if not ev.get("roundtrip"):
            ev["roundtrip"] = {"plaintext_len": 1000}
        ev["roundtrip"].update({"read_ok": True, "sha_written": "a" * 64,
                                "sha_read": "b" * 64})
        return ev

    def s_plaintext(ev):
        # THE HEADLINE SEED. Listed size equal to plaintext size.
        if not ev.get("roundtrip"):
            ev["roundtrip"] = {"plaintext_len": 1000}
        n = ev["roundtrip"].get("plaintext_len") or 1000
        ev["roundtrip"].update({"read_ok": True, "plaintext_len": n,
                                "stored_size": n,
                                "sha_written": "c" * 64, "sha_read": "c" * 64})
        return ev

    def s_mcp_noop(ev):
        ev["mcp_roundtrip"] = {"sha_written": "d" * 64, "sha_read": "d" * 64,
                               "write_text": "data lake not configured "
                                             "(DATA_LAKE_BUCKET unset)"}
        return ev

    def s_newtool(ev):
        ev["source"]["registered_tools"] = list(
            ev["source"].get("registered_tools", [])) + ["quantum_teleport"]
        return ev

    def s_mcp_down(ev):
        ev["mcp_tools_list"] = {"_http": 503, "tools": []}
        return ev

    def s_vm(ev):
        # [SEC-VM-DECLARED-V1] The old seed just unset WS_VM, which proved only
        # that a string was empty. The DEFECT F2.3 now exists to catch is the guard
        # NOT HOLDING on a declared no-workstation install, so that is what is
        # seeded: both variables empty AND the running surface registering the four
        # tools anyway AND the three routes answering instead of 503. The evidence
        # is SYNTHESISED, exactly the way s_bytes synthesises a round-trip, so the
        # control bites on a bundle that carries neither field.
        _cpenv_set(ev, "WS_VM", None)
        _cpenv_set(ev, "WS_ZONE", None)
        ev["mcp_tools_authed"] = {"_http": 200,
                                  "tools": ["whoami"] + list(VM_GUARDED_TOOLS)}
        ev["vm_route_probes"] = {r: {"_http": 200} for r in VM_GUARDED_ROUTES}
        return ev

    def s_meta_route(ev):
        # The advertised metadata path registered but GUARDED: a discovery document
        # that requires the token it exists to help you obtain.
        r = ev.setdefault("routes", {})
        key = "GET " + OAUTH_PR_PATH
        r["registered"] = sorted(set(r.get("registered") or []) | {key})
        r["public_routes"] = sorted(set(r.get("public_routes") or []) - {key})
        return ev

    def s_meta_doc(ev):
        # SYNTHESISE the served document, then break it the way that matters: a
        # 200 with no authorization_servers dead-ends every client while looking
        # entirely healthy to a status-code check.
        base = str(ev.get("base_url") or "https://example.invalid").rstrip("/")
        ev["oauth_protected_resource"] = {
            "_http": 200, "_url": base + OAUTH_PR_PATH,
            "body": {"resource": base + "/mcp", "bearer_methods_supported": ["header"]}}
        return ev

    def s_gitvault(ev):
        ev["gitvault_bucket_get"] = {"_http": 404}
        return ev

    def s_env_missing(ev):
        # Remove a variable that is ACTUALLY PRESENT, chosen from the requirement
        # set itself. The old seed unset WS_ZONE, which stops being a required
        # variable the moment an install declares no workstation -- a seed pinned to
        # one name goes vacuous the day that name leaves the set, and a vacuous seed
        # still reports BITE if the finding was already failing.
        cur = _env_of((ev.get("cp_revision") or {}).get(
            "template", ev.get("cp_revision") or {}))
        req = ((set((ev.get("source") or {}).get("cp_env_no_default") or [])
                | ENV_ALWAYS_REQUIRED_CP)
               - {"PORT", "K_SERVICE", "GOOGLE_CLOUD_PROJECT"})
        present = sorted(r for r in req if cur.get(r))
        return _cpenv_set(ev, present[0] if present else "DATA_LAKE_BUCKET", None)

    def s_env_dead(ev):
        return _gxenv_set(ev, "PC_TOTALLY_IGNORED", "1")

    def s_secret(ev):
        ev["named_secrets"] = dict(ev.get("named_secrets") or {})
        ev["named_secrets"]["pc-webauthn-creds"] = False
        return ev

    def s_idx_count(ev):
        ev["source"]["pc_index_invocations"] = 0
        return ev

    def s_idx_absent(ev):
        ev["firestore_indexes"] = []
        return ev

    def s_kms_alg(ev):
        ev["kms_key"] = dict(ev.get("kms_key") or {"_http": 200,
                                                   "purpose": "ASYMMETRIC_SIGN"})
        ev["kms_key"]["versionTemplate"] = {"algorithm": "RSA_SIGN_PSS_2048_SHA256"}
        return ev

    def s_gx_can_sign(ev):
        # The Stage A hole, re-seeded: hand the verifier the minting key.
        ev["kms_key_iam"] = {"bindings": [
            {"role": "roles/cloudkms.signer",
             "members": ["serviceAccount:" + ev.get("cp_sa", ""),
                         "serviceAccount:" + ev.get("gx_sa", "")]},
            {"role": "roles/cloudkms.publicKeyViewer",
             "members": ["serviceAccount:" + ev.get("gx_sa", "")]}]}
        return ev

    def s_pairing(ev):
        _cpenv_set(ev, "APPROVAL_SIG_KEY_VERSION", "keyVersions/9")
        _gxenv_set(ev, "APPROVAL_SIG_KEY_VERSIONS", "keyVersions/1,keyVersions/2")
        return ev

    def s_rp(ev):
        return _gxenv_set(ev, "PC_RP_ID", None)

    # ---- [SEC-SURFACE-SMOKE-V1] seeds for the two-surface assertions ---------
    # Each SYNTHESISES a healthy two-service bundle first, exactly the way
    # s_bytes/s_plaintext synthesise a round-trip. That is what lets the selftest
    # prove these checks bite even when the run itself was a single-service
    # install and the real bundle carries no second surface at all.
    def _healthy_surfaces(ev):
        req = sorted((set(ev.get("source", {}).get("cp_env_no_default", []) or [])
                      | ENV_ALWAYS_REQUIRED_CP)
                     - {"PORT", "K_SERVICE", "GOOGLE_CLOUD_PROJECT", "PC_IAP_AUD"})

        def rev(surface):
            env = [{"name": r, "value": "set-" + r.lower()} for r in req]
            env.append({"name": "PC_SURFACE", "value": surface})
            return {"name": "revisions/%s-00001-aaa" % surface,
                    "template": {"containers": [{"env": env}]}}

        ev["surfaces"] = {
            "console": {
                "service": SURFACE_SERVICES["console"],
                "revision": rev("console"),
                "routes_withheld": 25,
                "run_iam": {"bindings": [
                    {"role": "roles/run.invoker",
                     "members": ["serviceAccount:service-1@gcp-sa-iap."
                                 "iam.gserviceaccount.com"]}]},
                "probe_root": {"_http": 302, "headers": {
                    "x-goog-iap-generated-response": "true"}},
            },
            "mcp": {
                "service": SURFACE_SERVICES["mcp"],
                "revision": rev("mcp"),
                "run_iam": {"bindings": [
                    {"role": "roles/run.invoker", "members": ["allUsers"]}]},
                "probe_root": {"_http": 404, "headers": {
                    "x-powered-by": "Express"}},
                "probe_mcp": {"_http": 401, "headers": {
                    "x-powered-by": "Express",
                    "www-authenticate": 'Bearer resource_metadata='
                                        '"https://mcp.example/.well-known/'
                                        'oauth-protected-resource"'}},
            },
        }
        return ev

    def _surfenv_set(ev, surface, k, v):
        for c in ev["surfaces"][surface]["revision"]["template"]["containers"]:
            c["env"] = [e for e in c.get("env", []) if e["name"] != k]
            if v is not None:
                c["env"].append({"name": k, "value": v})
        return ev

    def s_split_half(ev):
        # Positive evidence of a split with the MCP half missing. Must FAIL, not
        # skip -- a missing half is the whole defect this section was written for.
        _healthy_surfaces(ev)
        del ev["surfaces"]["mcp"]
        return ev

    def s_surface_collapsed(ev):
        # Both copies carry the same PC_SURFACE: one half of the table is served
        # by nothing, and a one-service read would never notice.
        _healthy_surfaces(ev)
        return _surfenv_set(ev, "mcp", "PC_SURFACE", "console")

    def s_console_not_iap(ev):
        # THE HEADER SEED. Same 401 family, app shape instead of IAP shape.
        _healthy_surfaces(ev)
        ev["surfaces"]["console"]["probe_root"] = {
            "_http": 401, "headers": {"x-powered-by": "Express",
                                      "www-authenticate": "Bearer resource_metadata=x"}}
        return ev

    def s_iap_leaked_onto_mcp(ev):
        # THE SHIPPED DEFECT, re-seeded: /mcp behind IAP. Note the status code is
        # a perfectly ordinary 401 -- only the header betrays it.
        _healthy_surfaces(ev)
        ev["surfaces"]["mcp"]["probe_mcp"] = {
            "_http": 401, "headers": {"x-goog-iap-generated-response": "true"}}
        ev["surfaces"]["mcp"]["probe_root"] = dict(ev["surfaces"]["mcp"]["probe_mcp"])
        return ev

    def s_mcp_no_challenge(ev):
        # Reaches the app but advertises no OAuth discovery: an MCP client cannot
        # complete a handshake, yet the status code looks healthy.
        _healthy_surfaces(ev)
        ev["surfaces"]["mcp"]["probe_mcp"] = {
            "_http": 401, "headers": {"x-powered-by": "Express"}}
        return ev

    def s_console_serves_mcp(ev):
        _healthy_surfaces(ev)
        ev.setdefault("routes", {}).setdefault("map", {}).setdefault("entries", {})
        ev["routes"]["map"]["entries"]["POST /mcp"] = "both"
        return ev

    def s_root_leaked(ev):
        # A console page served by the public, IAP-free service.
        _healthy_surfaces(ev)
        ev["surfaces"]["mcp"]["probe_root"] = {
            "_http": 200, "headers": {"x-powered-by": "Express"}}
        return ev

    def s_invoker_missing_unexplained(ev):
        # THE ANTI-BLANKET SEED. The org-policy excuse is earned by a RECORDED
        # refusal; a binding that is simply absent must FAIL, or the excuse would
        # quietly cover a genuinely broken service.
        _healthy_surfaces(ev)
        ev["surfaces"]["mcp"]["run_iam"] = {"bindings": []}
        ev["surfaces"]["mcp"].pop("allusers_refusal", None)
        return ev

    def s_console_public(ev):
        _healthy_surfaces(ev)
        ev["surfaces"]["console"]["run_iam"] = {"bindings": [
            {"role": "roles/run.invoker", "members": ["allUsers"]}]}
        return ev

    def s_env_missing_on_mcp_only(ev):
        # The exact bug the brief names: env judged on the console for a tool that
        # only runs on the mcp service. F3.1 reads the console and stays green.
        _healthy_surfaces(ev)
        return _surfenv_set(ev, "mcp", "DATA_LAKE_BUCKET", None)

    def s_route_vanished(ev):
        # Indent one registration into an if: 87/70/17 becomes 86/69/17 and the
        # real route-audit.mjs still exits 0.
        r = ev.setdefault("routes", {}).setdefault("anchored", {})
        r["total"] = (r.get("total") or 87) - 1
        r["guarded"] = (r.get("guarded") or 70) - 1
        return ev

    def s_dead_map_entry(ev):
        ev.setdefault("routes", {})["dead_map_entries"] = ["GET /api/ghost"]
        return ev

    def s_hidden_registration(ev):
        rr = ev.setdefault("routes", {})
        rr.setdefault("anchored", {})
        rr.setdefault("tolerant", {})
        rr["tolerant"]["total"] = (rr["anchored"].get("total") or 87) + 1
        rr["hidden"] = ["GET /api/hidden-by-indentation"]
        return ev

    return {
        "F0.REVISION_IS_NEW":              ("read a stale revision", s_rev),
        "F1.1.BUCKET_CONFIGURED":          ("DATA_LAKE_BUCKET unset", s_bucket_unset),
        "F1.2.BUCKET_EXISTS":              ("bucket 404", s_bucket_missing),
        "F1.3.CP_CAN_READ_WRITE":          ("write-only, no objects.get", s_perm),
        "F1.4.ROUNDTRIP_BYTES":            ("read-back bytes differ", s_bytes),
        "F1.5.SEALED_AT_REST":             ("stored size == plaintext size", s_plaintext),
        "F1.MCP_WRITE_FILE_HANDLER":       ("write_file succeeds saying 'not configured'", s_mcp_noop),
        "F2.1.TOOLS_ALL_CLASSIFIED":       ("a 37th, unclassified tool appears", s_newtool),
        "F2.2.MCP_SURFACE_ANSWERS":        ("/mcp returns 503", s_mcp_down),
        "F2.3.VM_TOOLS_BACKED":            ("no workstation declared and the four VM tools are registered anyway", s_vm),
        "F2.4.GITVAULT_BUCKET_BACKED":     ("git-vault bucket 404", s_gitvault),
        "F2.5.MCP_METADATA_ROUTE_PUBLIC":  ("the advertised metadata route is guarded", s_meta_route),
        "F2.6.MCP_METADATA_DOC_RFC9728":   ("the document is served but has no authorization_servers", s_meta_doc),
        "F3.1.CP_REQUIRED_ENV_SET":        ("a required env var unset", s_env_missing),
        "F3.2.NO_ENV_SET_THAT_CODE_IGNORES": ("a var set that no code reads", s_env_dead),
        "F3.3.WEBAUTHN_CREDS_SECRET_EXISTS": ("a named secret does not exist", s_secret),
        "F4.1.INDEX_INVOCATIONS_COUNTED":  ("zero pc_index() call sites", s_idx_count),
        "F4.2.INDEXES_ACTUALLY_EXIST":     ("no composite index exists", s_idx_absent),
        "F5.1.KMS_KEY_EXISTS":             ("wrong signing algorithm", s_kms_alg),
        "F5.2.EXECUTOR_CANNOT_SIGN":       ("executor granted cloudkms.signer", s_gx_can_sign),
        "F5.3.SIG_KEY_VERSION_PAIRED":     ("singular not in the allowlist", s_pairing),
        "F5.4.EXECUTOR_RP_ID_SET":         ("PC_RP_ID unset -> example.invalid", s_rp),
        "F6.0.SURFACE_SPLIT_PRESENT":      ("half a split: the mcp service is missing from the bundle", s_split_half),
        "F6.1.SURFACE_ENV_DISTINCT":       ("both services carry PC_SURFACE=console", s_surface_collapsed),
        "F6.2.CONSOLE_IS_IAP_FRONTED":     ("console answers Express-shaped -- IAP not in front", s_console_not_iap),
        "F6.3.MCP_IS_NOT_IAP_FRONTED":     ("IAP leaked onto the mcp service (same 401, IAP header)", s_iap_leaked_onto_mcp),
        "F6.4.MCP_SERVES_MCP":             ("/mcp answers IAP-shaped -- unreachable to every client", s_iap_leaked_onto_mcp),
        "F6.5.CONSOLE_WITHHOLDS_MCP":      ("PC_SURFACE_MAP puts POST /mcp on 'both'", s_console_serves_mcp),
        "F6.6.ROOT_IS_CONSOLE_ONLY":       ("mcp root answers 200 -- a console page on the public service", s_root_leaked),
        "F6.7.MCP_PUBLIC_INVOKER":         ("allUsers invoker absent with NO recorded org-policy refusal", s_invoker_missing_unexplained),
        "F6.8.CONSOLE_INVOKER_NOT_PUBLIC": ("allUsers granted run.invoker on the console", s_console_public),
        "F6.9.REQUIRED_ENV_ON_BOTH":       ("DATA_LAKE_BUCKET set on console, missing on mcp", s_env_missing_on_mcp_only),
        "F7.1.ROUTE_TABLE_UNCHANGED":      ("a route vanished: 87/70/17 -> 86/69/17", s_route_vanished),
        "F7.2.SURFACE_PARTITION_TOTAL":    ("a dead PC_SURFACE_MAP entry", s_dead_map_entry),
        "F7.3.AUDIT_SEES_EVERY_REGISTRATION": ("a registration indented out of the audit's reach", s_hidden_registration),
    }


def _mcp_probe(ev, http=401, wwwauth=None, tools=None, drop_wwwauth=False):
    """Rewrite the keyless tools/list probe in a COPY of the evidence. Used only by
    the negative controls below."""
    h = {"x-powered-by": "Express"}
    if not drop_wwwauth:
        base = str(ev.get("base_url") or "https://example.invalid").rstrip("/")
        h["www-authenticate"] = (wwwauth if wwwauth is not None
                                 else 'Bearer resource_metadata="%s%s"'
                                      % (base, OAUTH_PR_PATH))
    ev["mcp_tools_list"] = {"_http": http, "headers": h, "tools": list(tools or [])}
    return ev


def controls():
    """EXTRA NEGATIVE CONTROLS -- more than one per assertion.

    seeds() is one defect per finding, which is enough to prove a check is alive.
    It is NOT enough for a check whose whole job is to discriminate between several
    responses that all look similar: the point of the rewritten F2.2 is that a bare
    401, a 403, a 5xx, a connection failure, a keyless 200 and a challenge pointing
    at somebody else's server are SIX DIFFERENT WRONG ANSWERS, and a check that
    catches one of them and waves the rest through would still show 33/33 here.
    Each entry is (row label, finding id, description, mutator) and each must make
    that finding FAIL. An OPTIONAL fifth element names the EXACT status the
    mutation must produce instead, for a branch whose correct outcome is not a
    failure: F1.3's unmeasured path must render NOT-EXERCISED, and neither "must
    FAIL" nor the positive-control "must not FAIL" states that -- the latter would
    accept PASS, which for a permission set nobody measured is exactly the
    silently blessed green this file exists to prevent.

    A control whose finding was ALREADY failing on the real bundle is marked vacuous
    rather than counted: it proved nothing that run, and pretending otherwise is the
    same self-deception as a check that cannot fail."""
    B = lambda ev: str(ev.get("base_url") or "https://example.invalid").rstrip("/")

    def c_bare_401(ev):
        return _mcp_probe(ev, 401, drop_wwwauth=True)

    def c_403(ev):
        return _mcp_probe(ev, 403)

    def c_5xx(ev):
        return _mcp_probe(ev, 503)

    def c_conn_fail(ev):
        ev = _mcp_probe(ev, None)
        ev["mcp_tools_list"]["_http"] = None
        return ev

    def c_foreign_metadata(ev):
        return _mcp_probe(ev, 401, wwwauth='Bearer resource_metadata='
                          '"https://attacker.example%s"' % OAUTH_PR_PATH)

    def c_old_premise_200(ev):
        # THE OLD CHECK'S PASS STATE. A keyless tools/list that answers 200 with a
        # tool array used to be the REQUIREMENT; it must now be a failure, which is
        # the single clearest demonstration that the replacement is stronger and
        # not merely different.
        return _mcp_probe(ev, 200, tools=["whoami"])

    def c_wrong_wellknown(ev):
        return _mcp_probe(ev, 401, wwwauth='Bearer resource_metadata="%s'
                          '/.well-known/oauth-authorization-server"' % B(ev))

    def c_not_bearer(ev):
        return _mcp_probe(ev, 401, wwwauth='Basic realm="paracoding"')

    def c_no_rm_param(ev):
        return _mcp_probe(ev, 401, wwwauth='Bearer realm="paracoding"')

    def c_relative_rm(ev):
        return _mcp_probe(ev, 401,
                          wwwauth='Bearer resource_metadata="%s"' % OAUTH_PR_PATH)

    def c_no_self_anchor(ev):
        # Nothing in the bundle says where this server lives, so a challenge could
        # name anything. The check must REFUSE rather than certify.
        _mcp_probe(ev, 401)
        ev["base_url"] = ""
        ev["target_url"] = ""
        _cpenv_set(ev, "MCP_PUBLIC_URL", None)
        return ev

    def c_meta_route_absent(ev):
        # The challenge advertises a path this build does not register at all.
        _mcp_probe(ev, 401, wwwauth='Bearer resource_metadata="%s%s-typo"'
                   % (B(ev), OAUTH_PR_PATH))
        return ev

    def c_meta_doc_404(ev):
        ev["oauth_protected_resource"] = {"_http": 404, "_url": B(ev) + OAUTH_PR_PATH,
                                          "body": None}
        return ev

    def c_meta_doc_foreign_resource(ev):
        ev["oauth_protected_resource"] = {
            "_http": 200, "_url": B(ev) + OAUTH_PR_PATH,
            "body": {"resource": "https://attacker.example/mcp",
                     "authorization_servers": ["https://attacker.example"]}}
        return ev

    def c_meta_doc_wrong_url(ev):
        ev["oauth_protected_resource"] = {
            "_http": 200, "_url": "https://somewhere.else" + OAUTH_PR_PATH,
            "body": {"resource": B(ev) + "/mcp", "authorization_servers": [B(ev)]}}
        return ev

    def c_meta_doc_http_as(ev):
        ev["oauth_protected_resource"] = {
            "_http": 200, "_url": B(ev) + OAUTH_PR_PATH,
            "body": {"resource": B(ev) + "/mcp",
                     "authorization_servers": ["http://insecure.example"]}}
        return ev

    def c_vm_half_declared(ev):
        _cpenv_set(ev, "WS_VM", "some-box")
        _cpenv_set(ev, "WS_ZONE", None)
        return ev

    def c_vm_declared_no_instance(ev):
        _cpenv_set(ev, "WS_VM", "some-box")
        _cpenv_set(ev, "WS_ZONE", "us-east1-b")
        ev["vm_instance"] = {"_http": 404}
        return ev

    def c_vm_declared_but_withheld(ev):
        _cpenv_set(ev, "WS_VM", "some-box")
        _cpenv_set(ev, "WS_ZONE", "us-east1-b")
        ev["vm_instance"] = {"_http": 200, "status": "RUNNING"}
        ev["mcp_tools_authed"] = {"_http": 200, "tools": ["whoami", "vm_status"]}
        return ev

    def c_vm_tools_leak_only(ev):
        # Withholding fails on the TOOL half alone, with no route evidence at all.
        _cpenv_set(ev, "WS_VM", None)
        _cpenv_set(ev, "WS_ZONE", None)
        ev.pop("vm_route_probes", None)
        ev["mcp_tools_authed"] = {"_http": 200, "tools": ["whoami", "vm_resize"]}
        return ev

    def c_vm_routes_answer_only(ev):
        # ... and on the ROUTE half alone, with no roster at all.
        _cpenv_set(ev, "WS_VM", None)
        _cpenv_set(ev, "WS_ZONE", None)
        ev.pop("mcp_tools_authed", None)
        ev["vm_route_probes"] = {r: {"_http": 503} for r in VM_GUARDED_ROUTES}
        ev["vm_route_probes"]["POST /api/vm/start"] = {"_http": 200}
        return ev

    def c_vm_source_roster_ignored(ev):
        # THE ANTI-FALSE-RED CONTROL, AND THE ONLY ONE HERE THAT MUST *NOT* FAIL.
        # source.registered_tools always lists all four -- it is a regex over
        # index.ts and cannot see the runtime guard. If F2.3 ever reads it, this
        # bundle (no workstation, correct 503s, no tool leaked) turns red and the
        # next strain deletes a working control to clear it. Asserted as a POSITIVE.
        _cpenv_set(ev, "WS_VM", None)
        _cpenv_set(ev, "WS_ZONE", None)
        ev.setdefault("source", {})["registered_tools"] = sorted(
            set((ev.get("source") or {}).get("registered_tools") or [])
            | set(VM_GUARDED_TOOLS))
        ev.pop("mcp_tools_authed", None)
        ev["vm_route_probes"] = {r: {"_http": 503} for r in VM_GUARDED_ROUTES}
        return ev

    def c_env_ws_half(ev):
        # F3.1's own pairing rule: one of the two named is still missing evidence.
        _cpenv_set(ev, "WS_VM", "some-box")
        _cpenv_set(ev, "WS_ZONE", None)
        return ev

    def c_perm_unmeasured_null(ev):
        # THE NEW BRANCH, AND NOTHING ELSE IN THIS FILE REACHED IT. s_perm seeds a
        # MEASURED denial, so before this control the unmeasured path had never
        # been shown to do anything at all -- which is the same as not having it.
        ev["bucket_perms"] = {
            "permissions": None, "measured": False, "_http": None,
            "unmeasured_reason": "could not impersonate the control-plane SA, so "
                                 "testPermissions was never asked as it"}
        return ev

    def c_perm_unmeasured_flag(ev):
        # THE FLAG ALONE MUST BE ENOUGH. An empty list carrying measured:false is a
        # refusal the collector could not turn into an answer; reading the list
        # without the flag puts it straight back to "missing create,get". This is
        # the control that refuses the tempting simplification of the branch down
        # to `praw is None`.
        ev["bucket_perms"] = {
            "permissions": [], "measured": False, "_http": 403,
            "unmeasured_reason": "testPermissions -> HTTP 403, so no permission "
                                 "set was returned"}
        return ev

    def _make_read(ev, key, name):
        """SYNTHESISE A REVISION THAT WAS READ: a name (the witness _starved()
        requires) and a container to hold environment. Used by the two controls
        below, which have to build the exact state the starvation guards must NOT
        fire on -- a bundle where a read was refused AND this revision came back."""
        rev = ev.setdefault(key, {})
        rev["name"] = name
        tpl = rev.setdefault("template", {})
        if not tpl.get("containers"):
            tpl["containers"] = [{"env": []}]
        return ev

    def c_refused_but_cp_was_read(ev):
        # [SEC-DEVGATE-STARVED-V1] THE ANTI-PERMISSIVE CONTROL, AND IT IS THE ONE
        # THAT KEEPS THE WHOLE STARVATION MECHANISM HONEST. A refusal IS recorded
        # -- both service reads are 403 -- and the control-plane revision CAME BACK
        # ANYWAY. DATA_LAKE_BUCKET is then genuinely absent from a revision that
        # was read, which is a real defect and must stay a red. If _starved() is
        # ever loosened to fire on the recorded refusal alone, this control turns
        # into a skip and a real defect becomes invisible -- which is the exact
        # permissive failure the two-key rule exists to refuse.
        ev.setdefault("service_reads", {})
        for n in list(ev["service_reads"]) or ["probe"]:
            ev["service_reads"][n] = {"_http": 403, "_error": "CONTROL: refused"}
        ev["_collect_refused"] = {"reason": "CONTROL: a recorded refusal",
                                  "refused_reads": dict(ev["service_reads"]),
                                  "starved_sections": [], "exit": 2}
        _make_read(ev, "cp_revision", "revisions/control-cp-00001-aaa")
        _cpenv_set(ev, "DATA_LAKE_BUCKET", None)
        return ev

    def c_refused_but_gx_was_read(ev):
        # The same rule on the other revision, and on the finding the incident
        # made famous: PC_RP_ID absent from a gate-exec revision that WAS read is
        # a red, refusal recorded elsewhere or not.
        c_refused_but_cp_was_read(ev)
        _make_read(ev, "gx_revision", "revisions/control-gx-00001-aaa")
        _gxenv_set(ev, "PC_RP_ID", None)
        return ev

    def c_gitvault_tools_withheld(ev):
        # THE CONTROL THAT REFUSES THE OLD ASSERTION. The bucket is right there and
        # answers 200; GIT_REPO_ID is not set, so registerGitTools() returns [] and
        # the seven git tools do not exist on the running service. The finding this
        # replaced said gs://... exists and went green. It must now be red.
        ev["gitvault_tools_configured"] = {
            "GIT_BUCKET": "some-lane-source", "GIT_REPO_ID": None,
            "registered": False,
            "rule": "gittools.ts registerGitTools() returns [] unless both are set"}
        ev["gitvault_bucket_name"] = "some-lane-source"
        ev["gitvault_bucket_get"] = {"_http": 200, "name": "some-lane-source"}
        return ev

    def c_gitvault_unmeasured(ev):
        # NEITHER VARIABLE ANYWHERE, and the name therefore falls back to the LAKE
        # bucket -- which exists, which is exactly how this finding used to buy a
        # green for a vault nobody had looked at.
        ev["gitvault_tools_configured"] = {
            "GIT_BUCKET": None, "GIT_REPO_ID": None, "registered": False,
            "rule": "gittools.ts registerGitTools() returns [] unless both are set"}
        ev["gitvault_bucket_channel"] = ("fallback <project>-datalake -- NO "
                                         "GIT_BUCKET IS SET ANYWHERE")
        ev["gitvault_bucket_get"] = {"_http": 200, "name": ev.get(
            "gitvault_bucket_name") or "some-datalake"}
        return ev

    def c_gitvault_not_recorded(ev):
        # An older bundle that carries the bucket and nothing about registration.
        # "I did not measure whether the tools exist" may not render as backed.
        ev.pop("gitvault_tools_configured", None)
        ev["gitvault_bucket_get"] = {"_http": 200, "name": ev.get(
            "gitvault_bucket_name") or "some-datalake"}
        return ev

    def c_perm_measured_denial(ev):
        # THE OTHER HALF, AND THE ONE THAT KEEPS THE SKIP HONEST. An EMPTY list
        # that WAS measured is a real IAM finding and must still be a FAIL. If the
        # new branch is ever loosened to `if not perms: skip`, a genuine denial
        # silently becomes a skip -- this control is what refuses that.
        ev["bucket_perms"] = {"permissions": [], "measured": True, "_http": 200}
        return ev

    return [
        ("F2.2[bare-401-no-challenge]", "F2.2.MCP_SURFACE_ANSWERS",
         "401 with NO WWW-Authenticate header", c_bare_401),
        ("F2.2[403]", "F2.2.MCP_SURFACE_ANSWERS",
         "403 instead of 401, challenge otherwise correct", c_403),
        ("F2.2[5xx]", "F2.2.MCP_SURFACE_ANSWERS",
         "503 instead of 401", c_5xx),
        ("F2.2[connection-failure]", "F2.2.MCP_SURFACE_ANSWERS",
         "no HTTP status at all -- the request never completed", c_conn_fail),
        ("F2.2[foreign-resource_metadata]", "F2.2.MCP_SURFACE_ANSWERS",
         "challenge names attacker.example's metadata", c_foreign_metadata),
        ("F2.2[old-premise-200]", "F2.2.MCP_SURFACE_ANSWERS",
         "keyless 200 with a tool array -- the OLD check's PASS state", c_old_premise_200),
        ("F2.2[wrong-well-known]", "F2.2.MCP_SURFACE_ANSWERS",
         "resource_metadata names the RFC 8414 document instead", c_wrong_wellknown),
        ("F2.2[not-bearer]", "F2.2.MCP_SURFACE_ANSWERS",
         "the challenge advertises Basic, not Bearer", c_not_bearer),
        ("F2.2[no-resource_metadata]", "F2.2.MCP_SURFACE_ANSWERS",
         "Bearer challenge with no resource_metadata parameter", c_no_rm_param),
        ("F2.2[relative-url]", "F2.2.MCP_SURFACE_ANSWERS",
         "resource_metadata is a path, not an absolute url", c_relative_rm),
        ("F2.2[no-self-anchor]", "F2.2.MCP_SURFACE_ANSWERS",
         "nothing in the bundle says where this server is", c_no_self_anchor),
        ("F2.5[path-not-registered]", "F2.5.MCP_METADATA_ROUTE_PUBLIC",
         "the advertised path is registered nowhere in this build", c_meta_route_absent),
        ("F2.6[404]", "F2.6.MCP_METADATA_DOC_RFC9728",
         "the advertised document is not served", c_meta_doc_404),
        ("F2.6[foreign-resource]", "F2.6.MCP_METADATA_DOC_RFC9728",
         "the document identifies another server's resource", c_meta_doc_foreign_resource),
        ("F2.6[url-mismatch]", "F2.6.MCP_METADATA_DOC_RFC9728",
         "the document was fetched from a url nobody was sent to", c_meta_doc_wrong_url),
        ("F2.6[http-authorization_server]", "F2.6.MCP_METADATA_DOC_RFC9728",
         "authorization_servers carries a plaintext http url", c_meta_doc_http_as),
        ("F2.3[half-declared]", "F2.3.VM_TOOLS_BACKED",
         "WS_VM set, WS_ZONE unset", c_vm_half_declared),
        ("F2.3[declared-no-instance]", "F2.3.VM_TOOLS_BACKED",
         "both declared, the instance does not resolve", c_vm_declared_no_instance),
        ("F2.3[declared-but-withheld]", "F2.3.VM_TOOLS_BACKED",
         "both declared, instance up, tools missing from the live roster",
         c_vm_declared_but_withheld),
        ("F2.3[tools-leak-only]", "F2.3.VM_TOOLS_BACKED",
         "no workstation, a VM tool registered, no route evidence", c_vm_tools_leak_only),
        ("F2.3[routes-answer-only]", "F2.3.VM_TOOLS_BACKED",
         "no workstation, one route answers 200, no roster", c_vm_routes_answer_only),
        ("F3.1[ws-half-declared]", "F3.1.CP_REQUIRED_ENV_SET",
         "WS_VM declared without WS_ZONE", c_env_ws_half),
        ("F1.3[unmeasured-null]", "F1.3.CP_CAN_READ_WRITE",
         "permissions is null with measured:false -- must render NOT-EXERCISED, "
         "never a denial", c_perm_unmeasured_null, "NOT-EXERCISED"),
        ("F1.3[unmeasured-flag]", "F1.3.CP_CAN_READ_WRITE",
         "an EMPTY list carrying measured:false -- must render NOT-EXERCISED on "
         "the flag alone", c_perm_unmeasured_flag, "NOT-EXERCISED"),
        ("F1.3[measured-denial]", "F1.3.CP_CAN_READ_WRITE",
         "an EMPTY list that WAS measured is a real denial and must still FAIL",
         c_perm_measured_denial, "FAIL"),
        ("F1.1[refused-read-but-cp-came-back]", "F1.1.BUCKET_CONFIGURED",
         "a refusal IS recorded and the control-plane revision came back anyway, "
         "with DATA_LAKE_BUCKET genuinely absent from it -- a read absence is a "
         "defect and may NOT be excused as starvation", c_refused_but_cp_was_read),
        ("F3.1[refused-read-but-cp-came-back]", "F3.1.CP_REQUIRED_ENV_SET",
         "same bundle: a required variable missing from a revision that WAS read",
         c_refused_but_cp_was_read),
        ("F5.4[refused-read-but-gx-came-back]", "F5.4.EXECUTOR_RP_ID_SET",
         "a refusal IS recorded and the gate-exec revision came back anyway, with "
         "PC_RP_ID genuinely absent from it", c_refused_but_gx_was_read),
        ("F2.4[tools-withheld-bucket-fine]", "F2.4.GITVAULT_BUCKET_BACKED",
         "GIT_REPO_ID unset so registerGitTools() returns [] -- and the bucket "
         "answers 200, which is what the OLD assertion called backed",
         c_gitvault_tools_withheld),
        ("F2.4[no-git-env-anywhere]", "F2.4.GITVAULT_BUCKET_BACKED",
         "neither GIT_BUCKET nor GIT_REPO_ID is set anywhere and the name falls "
         "back to the LAKE bucket, which exists", c_gitvault_unmeasured),
        ("F2.4[registration-not-recorded]", "F2.4.GITVAULT_BUCKET_BACKED",
         "the bundle records the bucket but nothing about whether the seven tools "
         "registered", c_gitvault_not_recorded),
        ("F2.3[source-roster-ignored]!", "F2.3.VM_TOOLS_BACKED",
         "POSITIVE CONTROL: source.registered_tools lists all four and the runtime "
         "control holds -- F2.3 must NOT fail", c_vm_source_roster_ignored),
    ]


# Controls whose label ends in '!' assert the ABSENCE of a failure. They exist
# because a check that is too eager is as expensive as one that is too lax: a
# false red on a correct control is what sends the next strain to delete it.
def _is_positive_control(label):
    return str(label).endswith("!")


def selftest(ev):
    """Prove every check can fail. Returns (rows, n_dead) where a dead check is one
    whose seeded defect did NOT make it fail.

    Three kinds of row, all judged the same way and all against a DEEP COPY:
        seed      one per assertion, from seeds()
        control   the extra negative controls above, plus one positive control and
                  the expected-status controls that carry F1.3's unmeasured branch
        coverage  an assertion that has NO seed at all. That is an unproven check,
                  so it is reported as DEAD -- which is how the file survives
                  somebody adding finding #38 and no way to falsify it."""
    rows, dead = [], 0
    base_f = judge(ev)
    base = {f.id: f.status for f in base_f}
    # [SEC-DEVGATE-STARVED-V1] AN ASSERTION WHOSE INPUT WAS REFUSED CANNOT BE MADE
    # TO FAIL, AND THAT IS NOT A DEAD CHECK. Seeding a defect into a section the
    # collector never read changes nothing, so the finding stays NOT-EXERCISED and
    # every one of those rows used to be counted DEAD -- 9 of them on the incident
    # bundle -- which forced verdict 11 "a check could not fail" and sent the
    # reader hunting a regression in this file that was not there.
    #
    # THIS EXCUSE IS EARNED TWICE OVER, NOT ASSUMED. A row is excused only if the
    # finding was starved on the REAL bundle AND is STILL starved after the defect
    # was seeded into a copy of it. Both halves do work:
    #
    #   BEFORE  on any bundle with no refused read -- every green run, and every
    #           bundle any older collector ever wrote -- this set is EMPTY and not
    #           one row can be excused. A check that genuinely stopped biting is
    #           still DEAD and still exits 11. It also means that if _starved()
    #           were ever loosened to fire on a recorded refusal alone, the three
    #           refused-but-read controls in controls() would go DEAD on a healthy
    #           bundle rather than being quietly excused by the very bug they
    #           exist to catch.
    #   AFTER   a mutator that SYNTHESISES the read it needs -- those same
    #           controls build a revision and then remove a variable from it -- is
    #           judged normally even on a bundle whose real reads were refused,
    #           which is the whole point of them.
    base_starved = {f.id for f in base_f if getattr(f, "starved", False)}

    def _row(kind, label, fid, desc, mut, expect=None):
        after_f = judge(mut(copy.deepcopy(ev)))
        after = {f.id: f.status for f in after_f}
        starved_after = (fid in base_starved
                         and any(x.id == fid and getattr(x, "starved", False)
                                 for x in after_f))
        # `expect` names the EXACT status the mutation must produce. It defaults to
        # FAIL, which is what a negative control has always meant, so every row
        # that existed before this parameter is judged exactly as it was. A
        # POSITIVE control (label ending '!') asserts only the absence of a red and
        # therefore names no single status. A branch whose correct outcome is a
        # SKIP is served by neither: "must FAIL" is wrong, and "must not FAIL"
        # would accept PASS -- the one outcome an unmeasured control must never
        # reach. Such a row states its status outright.
        if expect is None and not _is_positive_control(label):
            expect = "FAIL"
        got = after.get(fid)
        bites = (got == expect) if expect is not None else (got != "FAIL")
        rows.append({"id": label, "fid": fid, "kind": kind, "seeded_defect": desc,
                     "status_before": base.get(fid), "status_after": got,
                     "expected": expect or "anything but FAIL",
                     "vacuous": expect is not None and base.get(fid) == expect,
                     "starved": starved_after,
                     "bites": bites})
        return bites or starved_after

    sd = seeds()
    for fid, (desc, mut) in sorted(sd.items()):
        if not _row("seed", fid, fid, desc, mut):
            dead += 1
    for entry in controls():
        label, fid, desc, mut = entry[:4]
        if not _row("control", label, fid, desc, mut,
                    entry[4] if len(entry) > 4 else None):
            dead += 1
    for f in base_f:
        if f.id in sd:
            continue
        # An assertion may legitimately have no seed ONLY if it is an unconditional
        # skip on the reviewed list -- there is no evidence to mutate. Anything else
        # is a check nobody proved could fail.
        if f.status == "NOT-EXERCISED" and f.id in UNEXERCISABLE:
            continue
        rows.append({"id": f.id + "[no-seed]", "fid": f.id, "kind": "coverage",
                     "seeded_defect": "NO SEED EXISTS FOR THIS ASSERTION -- nothing "
                                      "has ever proved it can fail",
                     "status_before": f.status, "status_after": f.status,
                     "vacuous": False, "bites": False})
        dead += 1
    return rows, dead


def conditional_skips():
    """[SEC-MCP401-RFC9728-V1] SKIPS THAT DEPEND ON THE EVIDENCE, NOT ON THE LIST.

    skipproof() walks the findings that actually came back NOT-EXERCISED on THIS
    bundle, so a branch that only skips on OTHER evidence is invisible to it.
    F1.3's unmeasured branch is exactly that: on a bundle where the permission set
    WAS measured it never fires, and nothing would ever prove that the skip it
    produces cannot be read as green. That is the same shape of hole as a check
    nobody proved could fail.

    Each entry is (finding id, row label, description, mutator). The mutator must
    drive that finding to NOT-EXERCISED in a COPY of the evidence."""
    def m_perms_unmeasured(ev):
        # [SEC-DEVGATE-STARVED-V1] THE PRECONDITION IS SYNTHESISED, the way
        # s_bytes() synthesises a round-trip. This branch needs a bundle in which
        # the control-plane revision WAS read and DOES name a bucket: on a starved
        # bundle F1.3 skips on the refusal guard that now sits above it, the
        # unmeasured branch is never reached, and this control would silently stop
        # testing the thing it names while still reporting OK.
        ev.pop("_collect_refused", None)
        ev.pop("service_reads", None)
        rev = ev.setdefault("cp_revision", {})
        if not rev.get("name"):
            rev["name"] = "revisions/skip-proof-probe-00001-aaa"
        tpl = rev.setdefault("template", {})
        if not tpl.get("containers"):
            tpl["containers"] = [{"env": []}]
        _cpenv_set(ev, "DATA_LAKE_BUCKET", "skip-proof-probe-bucket")
        ev["bucket_perms"] = {
            "permissions": None, "measured": False, "_http": None,
            "unmeasured_reason": "SKIP-PROOF PROBE: the collector could not ask "
                                 "testPermissions as the control plane"}
        return ev

    # [SEC-DEVGATE-STARVED-V1] EVERY _starve() CALL SITE, NOT ONE PER SECTION.
    # _starve() is a single helper shared by sixteen findings, and the failure it
    # invites is a MISKEYED CALL SITE: an app-only assertion keyed on the
    # control-plane read would go NOT-EXERCISED on a bundle whose own input was
    # read perfectly well, which is the permissive error -- a real defect becoming
    # a skip -- that this whole change exists to avoid. The table below IS the
    # section map, restated as a falsifiable claim: each row drives ONE section's
    # read to a refusal and requires that finding to go NOT-EXERCISED and to force
    # exit 12 in isolation. A finding starved by a section it does not depend on
    # would have to be listed here to pass, and listing it is a visible decision.
    def _m_starve(section):
        def m(ev):
            # A RECORDED refusal -- condition 1. Without it _starved() returns {}
            # and none of this fires, which is the property that keeps every older
            # bundle judged exactly as it is today.
            ev.setdefault("service_reads", {})["SKIP-PROOF-PROBE"] = {
                "_http": 403,
                "_error": "SKIP-PROOF PROBE: a recorded non-200 service read"}
            # ... and the section's witness removed -- condition 2.
            if section == "cp":
                ev["cp_revision"] = {"name": "", "template": {"containers": []}}
            elif section == "gx":
                ev["gx_revision"] = {"name": "", "template": {"containers": []}}
            elif section == "app":
                ev["base_url"] = ""
                ev["target_url"] = ""
            return ev
        return m

    starved_by = (
        ("cp", ("F0.REVISION_IS_NEW",
                "F1.1.BUCKET_CONFIGURED",
                "F1.2.BUCKET_EXISTS",
                "F1.3.CP_CAN_READ_WRITE",
                "F1.4.ROUNDTRIP_BYTES",
                "F1.5.SEALED_AT_REST",
                "F2.3.VM_TOOLS_BACKED",
                "F2.4.GITVAULT_BUCKET_BACKED",
                "F3.1.CP_REQUIRED_ENV_SET",
                "F3.2.NO_ENV_SET_THAT_CODE_IGNORES",
                "F3.3.WEBAUTHN_CREDS_SECRET_EXISTS",
                "F5.2.EXECUTOR_CANNOT_SIGN",
                "F5.3.SIG_KEY_VERSION_PAIRED")),
        ("gx", ("F3.2.NO_ENV_SET_THAT_CODE_IGNORES",
                "F3.3.WEBAUTHN_CREDS_SECRET_EXISTS",
                "F5.2.EXECUTOR_CANNOT_SIGN",
                "F5.3.SIG_KEY_VERSION_PAIRED",
                "F5.4.EXECUTOR_RP_ID_SET")),
        ("app", ("F1.4.ROUNDTRIP_BYTES",
                 "F1.5.SEALED_AT_REST",
                 "F2.2.MCP_SURFACE_ANSWERS",
                 "F2.5.MCP_METADATA_ROUTE_PUBLIC",
                 "F2.6.MCP_METADATA_DOC_RFC9728")),
    )

    out = [
        ("F1.3.CP_CAN_READ_WRITE", "F1.3.CP_CAN_READ_WRITE[if-unmeasured]",
         "the bucket permission set was never measured", m_perms_unmeasured, 11),
    ]
    for _section, _fids in starved_by:
        for _fid in _fids:
            out.append((_fid, "%s[if-%s-refused]" % (_fid, _section),
                        "the %s read was REFUSED, so this assertion had no input "
                        "at all" % _section, _m_starve(_section), 12))
    return out


def skipproof(ev, install_exit=20):
    """PROVE THAT A SKIPPED ASSERTION CANNOT RENDER AS GREEN.

    selftest() proves a check can FAIL. It says nothing about the other way a
    check stops protecting anything: quietly not running. A green that skipped
    assertions is not green, and that is the entire reason this file exists, so
    the property is PROVEN on every run rather than asserted in a comment.

    For every finding that came back NOT-EXERCISED, three things are checked:

        1. it is not counted in the PASS census
        2. the rendered report never prints it on a [PASS] line
        3. removing its id from UNEXERCISABLE forces exit 11

    (3) is the load-bearing one. It demonstrates that the reviewed list is the
    ONLY thing standing between a skip and a coverage regression -- so a skip
    that nobody reviewed cannot reach exit 0 by any path. Nothing is mutated
    beyond a dict entry that is restored in a finally.
    """
    rows = []
    base = judge(ev)
    # [SEC-DEVGATE-STARVED-V1] THE BUNDLE WITH THE COLLECTOR'S OWN REFUSAL RECORD
    # REMOVED, and nothing else touched. Used for ONE thing: the anti-vacuity
    # control at the bottom of this function, which asks whether the verdict MOVES
    # when a skip is dropped. A refusal recorded in the bundle holds render() at
    # 12 all by itself, so measuring that control against the refused bundle would
    # make it unfalsifiable for exactly the rows that need it most.
    clean = copy.deepcopy(ev)
    clean.pop("_collect_refused", None)
    clean.pop("service_reads", None)
    text, _ = render(base, [], 0, ev, install_exit)
    pass_ids = {x.id for x in base if x.status == "PASS"}
    lines = text.splitlines()
    for f in base:
        if f.status != "NOT-EXERCISED":
            continue
        as_pass = f.id in pass_ids
        drawn_pass = any(("[PASS" in ln) and (f.id in ln) for ln in lines)
        # [SEC-DEVGATE-STARVED-V1] ISOLATED, THE SAME WAY THE CONDITIONAL ROWS
        # BELOW ALREADY WERE. Measured over the whole set, an 11 here could come
        # from ANY unlisted skip on the bundle and proved nothing about this one --
        # and on a starved bundle it could not be reached at all, because 12
        # outranks it. With every OTHER skip dropped the code is attributable to
        # this id alone, which is what the property claims.
        only = [x for x in base if x.status != "NOT-EXERCISED" or x.id == f.id]
        # WHAT THIS SKIP MUST FORCE. A reviewed or unreviewed skip must force 11:
        # coverage was lost in this tree. A STARVED skip must force 12: its input
        # was refused, which is missing evidence and not a regression here. The one
        # code neither of them may reach is 0, and that is what is being proven.
        want = 12 if getattr(f, "starved", False) else 11
        saved = UNEXERCISABLE.pop(f.id, None)
        try:
            # Re-render the SAME findings. judge() must not be re-run here: it
            # reads UNEXERCISABLE to build a skip's reason text, so it would
            # KeyError on the very id under test. Only render()'s verdict is
            # being measured, and render reads the list defensively.
            _t, code_unlisted = render(only, [], 0, ev, install_exit)
        finally:
            if saved is not None:
                UNEXERCISABLE[f.id] = saved
        rows.append({"id": f.id,
                     "on_reviewed_list": saved is not None,
                     "counted_as_pass": as_pass,
                     "rendered_as_pass": drawn_pass,
                     "exit_if_unlisted": code_unlisted,
                     "expected_exit": want,
                     "ok": (not as_pass) and (not drawn_pass)
                           and code_unlisted == want})

    # CONDITIONAL SKIPS -- the branches that did NOT fire on this bundle.
    for entry in conditional_skips():
        fid, label, why, mut = entry[:4]
        # The exit code this branch must force in isolation. 11 for a skip that
        # lost coverage, 12 for one whose input was refused. See the loop above.
        want = entry[4] if len(entry) > 4 else 11
        ev2 = mut(copy.deepcopy(ev))
        found2 = judge(ev2)
        got = next((x.status for x in found2 if x.id == fid), None)
        text2, _c2 = render(found2, [], 0, ev2, install_exit)
        as_pass2 = any(x.id == fid and x.status == "PASS" for x in found2)
        drawn_pass2 = any(("[PASS" in ln) and (fid in ln)
                          for ln in text2.splitlines())
        # ISOLATE THE VERDICT. Other assertions may be unlisted skips on this same
        # bundle, so an 11 over the whole set would not be ATTRIBUTABLE to this
        # one. Rendered with every OTHER skip dropped, an 11 can only come from
        # here -- and with this one dropped as well the code MUST move, which is
        # the control that stops the isolation being vacuous.
        only = [x for x in found2 if x.status != "NOT-EXERCISED" or x.id == fid]
        _t, code_only = render(only, [], 0, ev2, install_exit)
        without = [x for x in found2 if x.status != "NOT-EXERCISED"]
        # ... AND THE ANTI-VACUITY HALF IS MEASURED AGAINST THE DE-REFUSED BUNDLE.
        # The subject of this control is the FINDING LIST: drop the skip and the
        # code must move. render() reads the bundle for one verdict-relevant thing,
        # the collector's recorded refusal, and that would pin the code at 12 no
        # matter which findings were passed -- turning "the code moves" into a
        # tautology for every starvation row. Nothing else differs between the two.
        _t, code_without = render(without, [], 0, clean, install_exit)
        rows.append({"id": label,
                     "on_reviewed_list": fid in UNEXERCISABLE,
                     "conditional_on": why,
                     "status_under_probe": got,
                     "counted_as_pass": as_pass2,
                     "rendered_as_pass": drawn_pass2,
                     "exit_if_unlisted": code_only,
                     "exit_without_it": code_without,
                     "expected_exit": want,
                     "ok": got == "NOT-EXERCISED" and (not as_pass2)
                           and (not drawn_pass2) and fid not in UNEXERCISABLE
                           and code_only == want and code_without != want})
    return rows


def render(findings, st_rows, st_dead, ev, install_exit, sp_rows=None):
    L = []
    W = L.append
    W("=" * 78)
    W("POST-INSTALL FUNCTIONAL SMOKE TEST")
    W("=" * 78)
    W("")
    W("This phase answers 'does the installed system do its job'. The install")
    W("phase above answers only 'did the script exit 0'. They are different")
    W("questions and a green on the first is not an answer to the second.")
    W("")
    W("DRIFT WITNESS (resolved, unpinned -- a WITNESS, NOT A GUARANTEE):")
    for k, v in sorted((ev.get("drift") or {}).items()):
        W("   %-28s %s" % (k, v))
    W("   The pip line in gate-exec/Dockerfile is UNPINNED. These versions make")
    W("   drift VISIBLE in every transcript. They do not prevent it, and they do")
    W("   not prove dev and prod resolved the same bytes.")
    W("   recipe pin checked this run: %s" % (ev.get("recipe_pin") or "NOT CHECKED"))
    W("   BUILD_COMMIT:                %s" % (ev.get("build_commit") or "unknown"))
    W("")
    W("-" * 78)
    W("SELF-TEST: CAN THESE CHECKS FAIL?")
    W("-" * 78)
    W("A check that cannot fail is worse than no check, so every assertion is run")
    W("a second time against evidence with a defect seeded into it, and is")
    W("required to flip to FAIL. Seeding is in-memory only; no project is mutated.")
    W("One seed per assertion, plus extra controls where one defect is not enough to")
    W("show a check DISCRIMINATES -- a few positive controls (marked !) that assert")
    W("a correct system must NOT turn red, and controls that name the exact status")
    W("required, for a branch whose correct outcome is a SKIP rather than a red. An")
    W("assertion with no seed at all")
    W("is reported DEAD: it is a check nobody has ever proved can fail.")
    W("")
    for r in st_rows:
        note = ("  (VACUOUS this run: the assertion was already FAIL before seeding)"
                if r.get("vacuous") else "")
        # [SEC-DEVGATE-STARVED-V1] STRV is NOT a weaker BITE. It says the seeded
        # defect could not reach the assertion because the assertion's INPUT was
        # refused, so this run proves nothing about that check in either direction.
        # It is excluded from BOTH sides of the ratio below rather than counted as
        # a pass, and the excuse requires a refusal recorded in the bundle.
        W("   %-4s %-34s %s%s" % ("BITE" if r["bites"]
                                  else ("STRV" if r.get("starved") else "DEAD"),
                                  r["id"], r["seeded_defect"], note))
    n_seed = sum(1 for r in st_rows if r.get("kind", "seed") == "seed")
    n_ctl = sum(1 for r in st_rows if r.get("kind") == "control")
    n_cov = sum(1 for r in st_rows if r.get("kind") == "coverage")
    n_vac = sum(1 for r in st_rows if r.get("vacuous"))
    n_strv = sum(1 for r in st_rows if r.get("starved"))
    W("")
    W("   %d/%d proved they can fail -- %d assertion seed(s), %d extra control(s)%s."
      % (len(st_rows) - st_dead - n_strv, len(st_rows) - n_strv, n_seed, n_ctl,
         ", %d assertion(s) with NO SEED" % n_cov if n_cov else ""))
    if n_strv:
        W("   %d control(s) were UNMEASURABLE: the assertion's INPUT was REFUSED by"
          % n_strv)
        W("   the collector, so the seeded defect never reached it. That is not a")
        W("   dead check -- it is an unread one -- and it is excluded from the")
        W("   ratio above rather than counted as proof of anything.")
    if n_vac:
        W("   %d control(s) were VACUOUS: their assertion was already failing on the"
          % n_vac)
        W("   real evidence, so flipping it to FAIL proved nothing this run.")
    if st_dead:
        W("   %d CHECK(S) DID NOT BITE. Those checks are worthless and this run is" % st_dead)
        W("   NOT a pass regardless of what they reported.")
    W("")
    W("-" * 78)
    W("SKIP-PROOF: CAN A SKIPPED ASSERTION RENDER AS GREEN?")
    W("-" * 78)
    W("selftest above proves a check can FAIL. This proves the other half: that a")
    W("check which did not RUN cannot be mistaken for one that passed. For every")
    W("NOT-EXERCISED finding -- it is absent from the PASS census, it is never")
    W("drawn on a [PASS] line, and unlisting it from UNEXERCISABLE forces exit 11.")
    W("The reviewed list is therefore the only thing between a skip and a coverage")
    W("regression, and an unreviewed skip can reach exit 0 by no path at all.")
    W("Rows marked [if-...] are CONDITIONAL skips: branches that did not fire on")
    W("this bundle, driven into NOT-EXERCISED in a copy of the evidence so the skip")
    W("they produce is proven the same way. Their exit-if-unlisted is measured with")
    W("every other skip removed, so the 11 is attributable to that branch alone.")
    W("")
    if not sp_rows:
        W("   (no NOT-EXERCISED findings this run)")
    for r in sp_rows or []:
        W("   %-4s %-34s pass-census=%s  drawn-as-PASS=%s  exit-if-unlisted=%s"
          % ("OK" if r["ok"] else "HOLE", r["id"],
             r["counted_as_pass"], r["rendered_as_pass"], r["exit_if_unlisted"]))
    sp_bad = [r for r in (sp_rows or []) if not r["ok"]]
    W("")
    W("   %d/%d skipped assertion(s) proved they cannot render as green."
      % (len(sp_rows or []) - len(sp_bad), len(sp_rows or [])))
    if sp_bad:
        W("   %d SKIP(S) COULD BE READ AS GREEN. That is the failure mode this file"
          % len(sp_bad))
        W("   was written to prevent, so this run is NOT a pass.")
    W("")
    W("-" * 78)
    W("FINDINGS")
    W("-" * 78)
    for f in findings:
        W("")
        W("[%s] %-34s (%s)" % (f.status.ljust(13), f.id, f.mode))
        for line in _wrap(f.requirement, 72):
            W("      " + line)
        if f.detail:
            for line in _wrap("-> " + f.detail, 72):
                W("      " + line)
    npass = sum(1 for f in findings if f.status == "PASS")
    nfail = sum(1 for f in findings if f.status == "FAIL")
    skipped = [f for f in findings if f.status == "NOT-EXERCISED"]
    # [SEC-DEVGATE-STARVED-V1] THREE KINDS OF SKIP, AND THEY ARE NOT THE SAME FACT.
    #   on the reviewed list  a confessed, argued-for gap
    #   starved               the collection was REFUSED and this assertion had no
    #                         input at all -- see _starve()
    #   neither               somebody removed coverage from this tree
    # Only the third is a COVERAGE REGRESSION. Counting the second as one buries
    # the actual news, "nothing was measured", under a headline about the harness
    # and sends the reader to devgate/ to hunt a regression that is not there.
    # Starved findings are NOT dropped from the census: they get their own block
    # below, named one by one, because an unmeasured thing has to be visible AS
    # unmeasured or this file has simply learned a new way to be quiet.
    starved = [f for f in skipped if getattr(f, "starved", False)]
    unlisted = [f for f in skipped if f.id not in UNEXERCISABLE
                and not getattr(f, "starved", False)]
    W("")
    W("-" * 78)
    W("CENSUS -- NOT-EXERCISED IS NOT GREEN")
    W("-" * 78)
    W("   PASS           %d" % npass)
    W("   FAIL           %d" % nfail)
    W("   NOT-EXERCISED  %d" % len(skipped))
    W("")
    W("   Exercised (a real call was made):")
    for f in findings:
        if f.mode == "EXERCISED" and f.status != "NOT-EXERCISED":
            W("      %s" % f.id)
    W("   Asserted (backing resource proven to exist; the call itself was not made):")
    for f in findings:
        if f.mode == "ASSERTED" and f.status != "NOT-EXERCISED":
            W("      %s" % f.id)
    W("   NOT EXERCISED, on the reviewed unexercisable list:")
    for f in skipped:
        if f.id in UNEXERCISABLE:
            W("      %s" % f.id)
            for line in _wrap(UNEXERCISABLE[f.id], 66):
                W("         " + line)
    if starved:
        W("   NOT EXERCISED BECAUSE THE COLLECTION WAS REFUSED -- NOTHING ABOUT")
        W("   THESE WAS MEASURED. They are not findings about the deployment in")
        W("   either direction, and they are not a coverage regression in this")
        W("   tree. The collector could not read the sections they assert over:")
        for f in starved:
            W("      %s" % f.id)
        for line in _wrap((ev.get("_collect_refused") or {}).get("reason")
                          or "one or more service reads did not return 200, so "
                             "the sections these assertions read carry no "
                             "measurement", 66):
            W("         " + line)
        for line in _wrap("CHECK FIRST: " + str(
                (ev.get("_collect_refused") or {}).get("what_to_check_first")
                or "the identity this collector ran as."), 66):
            W("         " + line)
    if unlisted:
        W("   NOT EXERCISED AND *NOT* ON THE LIST -- COVERAGE REGRESSION:")
        for f in unlisted:
            W("      %s  %s" % (f.id, f.detail))
    W("")

    if st_dead:
        code, name = 11, "FUNCTIONAL-COVERAGE-LOST (a check could not fail)"
    elif [r for r in (sp_rows or []) if not r["ok"]]:
        code, name = 11, "FUNCTIONAL-COVERAGE-LOST (a skip could read as green)"
    elif starved:
        # [SEC-DEVGATE-STARVED-V1] 12, NOT 11, AND THE ARGUMENT IS THE POINT.
        #
        # 11 means THIS TREE LOST COVERAGE: an assertion was removed, a check
        # stopped being able to fail, or a skip nobody reviewed appeared. Its first
        # move is "go and read devgate/". 12 already means precisely what happened
        # here, in this file's own exit contract: "collect() could not gather an
        # input. That is missing evidence -- not a pass, not a failure of the
        # product, and certainly not a reason to move traffic." Its first move is
        # "go and look at the identity the collector ran as", which is where the
        # fault actually was. Reporting a starved run as COVERAGE-LOST spends the
        # reader's attention in the wrong file, and the two codes were made
        # distinct precisely because they have different first moves.
        #
        # THE ALTERNATIVE WAS REFUSED. Adding these ids to UNEXERCISABLE would
        # also have cleared the 11 -- and would have bought a permanent green for
        # assertions nobody ran, on every future bundle, including the ones that
        # were collected perfectly. This file says so about F2.3 and F2.6 in their
        # own skip text and it is right; the list is for things that CANNOT run,
        # not for things that DID not.
        #
        # IT OUTRANKS 10 AND 11 BUT NOT THE JUDGE'S OWN SELF-CHECKS. A dead check
        # or a skip that could read as green is a defect in THIS FILE, and a judge
        # that cannot be trusted cannot be trusted to report "evidence missing"
        # either -- so those two keep the top of the order. Below them, nothing
        # measured cannot yield a meaningful 10 or 11. Nothing is hidden by the
        # promotion: whatever WAS measured and failed, and any genuine unlisted
        # skip, are both named in this verdict line and printed in full above.
        code = 12
        name = ("FUNCTIONAL-EVIDENCE-MISSING (THE COLLECTION WAS REFUSED: %d "
                "assertion(s) had no input at all: %s)"
                % (len(starved), ",".join(x.id for x in starved)))
        if unlisted:
            name += (" -- AND %d assertion(s) did not run and are not on the "
                     "reviewed list: %s"
                     % (len(unlisted), ",".join(x.id for x in unlisted)))
        if nfail:
            name += (" -- AND %d assertion(s) that WERE measured FAILED" % nfail)
    elif unlisted:
        # A LOST ASSERTION OUTRANKS A FAILED ONE and keeps exit 11, because a check
        # nobody ran is a claim nobody can make. But it must not HIDE the failures:
        # the verdict line names both, or a reader sees "coverage" and stops there.
        code, name = 11, ("FUNCTIONAL-COVERAGE-LOST (%d assertion(s) did not run: %s)"
                          % (len(unlisted), ",".join(x.id for x in unlisted)))
        if nfail:
            name += " -- AND %d assertion(s) FAILED" % nfail
    elif nfail:
        code, name = 10, "FUNCTIONAL-FAILED"
    elif _refused_reads(ev) or ev.get("_collect_refused"):
        # BELT AND BRACES, AND IT SHOULD NEVER FIRE. The collector recorded a
        # refused read and this judge attributed it to no assertion at all. With
        # the collector that writes service_reads that cannot happen -- a refused
        # service read always empties cp_revision, gx_revision or base_url, and
        # each of those is keyed by at least one finding -- but "should never
        # happen" is not a reason to let a refusal render green. It sits BELOW the
        # census branches on purpose: anything actually measured still gets its own
        # verdict, and this only ever replaces a 0.
        code, name = 12, ("FUNCTIONAL-EVIDENCE-MISSING (the collector RECORDED a "
                          "refused read and no assertion was attributed to it; "
                          "that disagreement is itself missing evidence)")
    elif install_exit == 20:
        code, name = 0, "COMPLETE-NEEDS-HUMAN-AT-9 (install AND function)"
    elif install_exit == 0:
        code, name = 4, "STOP-NOT-HONOURED"
    else:
        code, name = 3, "STEP-GENUINELY-FAILED"
    W("=" * 78)
    W("VERDICT %d  %s" % (code, name))
    W("   install phase exit=%s" % install_exit)
    W("   0 now requires BOTH: the installer reached the 9/10 boundary AND every")
    W("   exercisable functional assertion passed.")
    W("=" * 78)
    return "\n".join(L), code


def _wrap(s, w):
    out, cur = [], ""
    for word in str(s).split():
        if len(cur) + len(word) + 1 > w:
            out.append(cur)
            cur = word
        else:
            cur = (cur + " " + word).strip()
    if cur:
        out.append(cur)
    return out or [""]


def main(argv):
    ev_path = os.environ.get("SMOKE_EVIDENCE", "/workspace/evidence.json")
    out_path = os.environ.get("SMOKE_REPORT", "/workspace/smoke-report.txt")
    install_exit = int(os.environ.get("SMOKE_INSTALL_EXIT", "20"))
    text, code = "", 12
    try:
        with open(ev_path) as fh:
            ev = json.load(fh)
        findings = judge(ev)
        st_rows, st_dead = selftest(ev)
        sp_rows = skipproof(ev, install_exit)
        text, code = render(findings, st_rows, st_dead, ev, install_exit,
                            sp_rows)
    except Exception:
        # PUBLISH UNCONDITIONALLY. A prior version exited before writing anything
        # and a whole run produced no artifact. An abort is a result too.
        text = ("=" * 78 + "\nPOST-INSTALL FUNCTIONAL SMOKE TEST -- ABORTED\n"
                + "=" * 78 + "\n\nThe functional phase could not complete. This is"
                " NOT a pass and NOT a\nfailure of the product -- it is missing"
                " evidence.\n\n" + traceback.format_exc()
                + "\nVERDICT 12  FUNCTIONAL-EVIDENCE-MISSING\n")
        code = 12
    finally:
        try:
            with open(out_path, "w") as fh:
                fh.write(text or "(no output)")
        except Exception:
            pass
        sys.stdout.write(text or "(no output)")
        sys.stdout.write("\n")
        sys.stdout.flush()
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
