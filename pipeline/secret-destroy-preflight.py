#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# ===================== [SECRET-DESTROY-PREFLIGHT-V1] =========================
# ANSWER ONE QUESTION: does ANYTHING that runs still REFERENCE this secret?
#
# WHY THIS EXISTS, MEASURED, NOT HYPOTHETICAL. On 2026-08-10 a gated job deleted
# Secret Manager secret `ad-free-key` in your-prod-project. Every check made
# beforehand was TRUE and every one of them was IRRELEVANT: no line of code reads
# AD_FREE_KEY, no deploy script sets it, a fresh dev project does not have it.
# Production went down about 70 minutes later. Cloud Run said exactly why:
#
#   Could not fetch secret "projects/your-prod-project/secrets/ad-free-key/
#   versions/latest" for environment variable "AD_FREE_KEY". Instance startup
#   will now abort: Permission 'secretmanager.versions.access' denied on
#   resource (or it may not exist).
#
# Warm instances kept serving the already-resolved value. The FIRST COLD START
# after the delete aborted, and so did every one after it.
#
# THE LESSON THIS FILE ENCODES: a secretKeyRef mount is a HARD BOOT DEPENDENCY
# resolved BY THE PLATFORM, whether or not any line of application code reads the
# variable. "Unused by the code" and "safe to delete" are DIFFERENT CLAIMS.
# Every check that blessed that delete answered "will something RE-CREATE it?".
# None answered "does anything currently REFERENCE it?". This answers that one.
#
# IT REFUSES BY DEFAULT. Referenced is a refusal. Could-not-tell is a refusal.
# An unhandled exception is a refusal. Only a COMPLETE enumeration that found
# nothing is a pass, because the failure mode of this check is a consumer kind
# nobody thought to enumerate -- so a kind that could not be reached makes the
# answer UNKNOWN, and UNKNOWN is not clean.
#
# EXIT CODES
#   0  PASS      every consumer kind enumerated, no reference found
#   2  REFUSE    at least one consumer references the secret
#   3  REFUSE    UNKNOWN -- a consumer kind could not be enumerated
#   4  REFUSE    usage or internal error
# Anything that is not 0 means DO NOT DELETE.
#
# WHAT IT LOOKS AT
#   run_services      EVERY revision of EVERY service, not just latest and not
#                     just the ones holding traffic -- a revision at 0% traffic
#                     that carries a --tag is reachable on its tag URL, cold
#                     starts on demand, and pins the secret exactly as hard.
#   run_jobs          execution template env and volumes.
#   cloudbuild        triggers: availableSecrets.secretManager[].versionName.
#   cloudscheduler    job bodies and headers.
#   cloudfunctions    gen1 and gen2 secretEnvironmentVariables / secretVolumes.
#   source_literals   the secret NAME as a string literal in the source tree.
#                     A boot mount is not the only way to depend on a secret:
#                     this fleet's control plane reads chat-key-claude,
#                     chat-key-gemini and anthropic-admin-key by NAME at RUNTIME
#                     over the Secret Manager REST API, with no mount anywhere.
#                     Deleting one of those does not abort a boot -- it breaks a
#                     feature later, which is harder to attribute, not easier.
#
# [SECRET-DESTROY-PREFLIGHT-V2] source_literals SCANS CODE, NOT PROSE, AND THAT
# CHANGE HAD TO BE MADE WITHOUT LOSING THE RUNTIME-READ DETECTION ABOVE.
#
# V1 matched the secret name ANYWHERE under --source-root, including comments.
# The consequence was not theoretical and it was not small: THIS FILE's own
# incident header names ad-free-key twice, and control-plane/src/index.ts names
# it twice more in the comment block that records the same outage. So the secret
# the whole check was WRITTEN ABOUT could never reach PASS, no matter how many
# revisions were retired -- and with --source-root omitted the kind is UNKNOWN,
# which is also a refusal. A check that cannot pass teaches people to bypass it.
#
# WHAT IT DOES NOW: each file is reduced to a CODE VIEW before matching, and the
# rule is chosen PER FILE TYPE rather than by one hand-rolled scanner:
#
#   .ts .tsx .js .jsx .mjs .cjs   comments blanked by collect-evidence.py's
#                                 blank_comments(), IMPORTED from beside this
#                                 file -- not copied. That function is already
#                                 the fleet's fixed, regex-literal-aware blanker
#                                 and carries four self-checks that turn a
#                                 desync into a refusal. A THIRD copy of that
#                                 scanner would drift exactly as the second one
#                                 did (it read a guard out of a comment for four
#                                 days), so there is no third copy.
#   .py .pyi                      comments blanked with the STDLIB tokenize
#                                 module -- the authoritative Python lexer, not
#                                 a regex. STRING LITERALS ARE KEPT, so a
#                                 docstring naming a secret still refuses. That
#                                 is deliberate: a Python string is how a secret
#                                 is named at runtime, and telling a docstring
#                                 from a runtime string is not worth the risk.
#   .md .markdown .rst .txt       DOCUMENTATION. Nothing in these executes, so a
#                                 name here is a mention, never a reference.
#                                 Reported under "MENTIONED IN PROSE" so a human
#                                 still sees it; never a finding.
#   everything else               CONSERVATIVE: the WHOLE FILE is treated as
#                                 code. Shell and YAML `#` are genuinely
#                                 ambiguous (shell only starts a comment at a
#                                 word boundary, YAML only after whitespace, and
#                                 both nest inside quoting), and Dockerfiles,
#                                 JSON and unknown types have no comment grammar
#                                 worth guessing at. This is stated rather than
#                                 silently assumed, exactly as the file-type
#                                 table above says: an unreliable distinction is
#                                 resolved TOWARDS REFUSAL, never towards PASS.
#
# ANY failure of a scanner -- blanker desync, tokenize error, the import not
# resolving -- falls back to CONSERVATIVE for that file and says which file and
# why. The fallback direction is a refusal, so a broken scanner can never buy a
# PASS; it can only cost a false refusal, which a human can read and overrule.
#
# [SECRET-DESTROY-PREFLIGHT-V3] source_literals WAS LANE-BLIND, AND THE BLINDNESS
# POINTED AT PASS.
#
# The LIVE kinds above are already lane-correct and were never the problem: they
# enumerate the whole PROJECT -- locations/- for Run services, jobs and functions,
# every Scheduler location, every trigger -- so a secret one lane is destroying and
# the OTHER lane still mounts comes back REFERENCED. Measured: an inventory in
# which the unprefixed lane mounts pc-<lane>-session-secret refuses, and an
# unrelated wa-session-secret beside it does not produce a false refusal, because
# the name is matched whole with "-" inside the boundary class.
#
# source_literals was the leg that broke. It looked for the EXPANDED name, and a
# lane-namespaced secret is never spelled expanded in source: every script writes
# pc-${PC_LP}session-secret and the shell expands it at run time. So the
# runtime-read detection this kind exists for -- the case where nothing MOUNTS the
# secret and something READS IT BY NAME -- silently stopped applying the moment a
# lane prefix was introduced. In this repository that was not hypothetical and it
# was ASYMMETRIC, which is worse than uniformly broken: destroying
# pc-session-secret refused on collect-evidence.py, which names it as a default,
# while destroying pc-dev-session-secret -- the SAME secret in the other lane --
# passed clean over the identical code.
#
# SO THE NAME IS ALSO LOOKED FOR IN ITS LANE-TEMPLATE SPELLINGS. From the secret
# name alone, with no --lane flag to get wrong, each interior segment is replaced
# by each lane-prefix template this fleet uses, and each template is also INSERTED
# at each boundary to cover the unprefixed lane. pc-dev-session-secret therefore
# also hunts pc-${PC_LP}session-secret; pc-session-secret also hunts it. A hit is
# a REFERENCE and refuses, exactly as an expanded hit does -- this REMOVES an
# exemption rather than creating a new class of unpassable check, since the
# unprefixed twin already refused on the same bytes.
#
# THE ESCAPE IS THE ONE THIS FILE ALREADY HAS: point --source-root at the tree that
# actually RUNS, not at the tree that installs. A generator that emits an installer
# is not a consumer, and the finding names the file and line so a human can see
# which it is in one look.
#
# EVERY KIND IS SCANNED TWICE: structurally, against the fields that are known to
# carry a secret reference, and TEXTUALLY over the raw JSON. The structural scan
# is precise; the textual scan is what survives a field shape nobody here has
# seen yet. The whole point of the outage was that the enumeration was wrong.
# =============================================================================
import sys, os, json, re, io, subprocess, tokenize, urllib.request, urllib.error, datetime
import importlib.util

PASS, REFUSE_REFERENCED, REFUSE_UNKNOWN, REFUSE_ERROR = 0, 2, 3, 4

RUN = "https://run.googleapis.com/v2"
SM = "https://secretmanager.googleapis.com/v1"
CB = "https://cloudbuild.googleapis.com/v1"
CS = "https://cloudscheduler.googleapis.com/v1"
CF = "https://cloudfunctions.googleapis.com/v2"

KINDS = ["run_services", "run_jobs", "cloudbuild", "cloudscheduler",
         "cloudfunctions", "source_literals"]


def short(name):
    """projects/P/secrets/N[/versions/V] -> N. Anything else is returned as-is."""
    if not isinstance(name, str):
        return ""
    m = re.search(r"secrets/([^/]+)", name)
    return m.group(1) if m else name


# [SECRET-DESTROY-PREFLIGHT-V3] The ways this fleet writes a lane prefix in source.
# ${PC_LP} is the shell one and carries its own trailing hyphen; ${PC_LANE} does not,
# so the hyphen is written beside it here.
LANE_TEMPLATES = ("${PC_LP}", "$PC_LP", "${PC_LANE}-", "$PC_LANE-")


def lane_spellings(secret):
    """The name as SOURCE would write it when the lane is not expanded yet.

    Two rules, both derived from the name alone so there is no --lane flag to pass
    wrong. REPLACE: an interior segment is the lane, so it becomes the template --
    pc-dev-session-secret gives pc-${PC_LP}session-secret. INSERT: the lane is
    EMPTY in this name, so the template sits at a boundary and expands to nothing --
    pc-session-secret gives pc-${PC_LP}session-secret too. Head and tail are both
    required to be non-empty, so nothing degenerates into a bare template that would
    match half the tree. Returns [(spelling, why)], the expanded name excluded."""
    segs = secret.split("-")
    out, seen = [], set()
    for tpl in LANE_TEMPLATES:
        for i in range(1, len(segs) - 1):
            head, tail = "-".join(segs[:i]) + "-", "-".join(segs[i + 1:])
            if head[:-1] and tail:
                out.append((head + tpl + tail,
                            "segment %s read as the lane and replaced by %s" % (segs[i], tpl)))
        for i in range(1, len(segs)):
            head, tail = "-".join(segs[:i]) + "-", "-".join(segs[i:])
            if head[:-1] and tail:
                out.append((head + tpl + tail,
                            "%s inserted for the UNPREFIXED lane, where it expands to nothing"
                            % tpl))
    uniq = []
    for sp, why in out:
        if sp == secret or sp in seen:
            continue
        seen.add(sp)
        uniq.append((sp, why))
    return uniq


def boundary_pat(name):
    """Whole-name match: deleting chat-key is not referenced by chat-key-claude."""
    return re.compile(r"(?<![A-Za-z0-9_.-])" + re.escape(name) + r"(?![A-Za-z0-9_.-])")


# ------------------------------------------------------------------ transport

def access_token():
    t = os.environ.get("CLOUDSDK_AUTH_ACCESS_TOKEN", "").strip()
    if t:
        return t
    try:
        p = subprocess.run(["gcloud", "auth", "print-access-token"],
                           capture_output=True, text=True, timeout=60)
        if p.returncode == 0 and p.stdout.strip():
            return p.stdout.strip()
    except Exception:
        pass
    req = urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/"
        "service-accounts/default/token", headers={"Metadata-Flavor": "Google"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))["access_token"]


def get_json(url, tok):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def get_all(url, tok, key):
    """Follow nextPageToken. Returns the concatenated list under `key`."""
    out, page = [], None
    while True:
        u = url + ((("&" if "?" in url else "?") + "pageToken=" + page) if page else "")
        doc = get_json(u, tok)
        out.extend(doc.get(key, []) or [])
        page = doc.get("nextPageToken")
        if not page:
            return out


# ------------------------------------------------------------------ collection

def collect(project, tok, source_root=None):
    """Build the inventory. Each kind is {ok, items} or {ok:false, error}.
    A kind NEVER raises out of here: an unreachable kind is a recorded failure,
    which the decision engine turns into UNKNOWN, which is a refusal."""
    inv = {"project": project,
           "captured_at": datetime.datetime.now(datetime.timezone.utc)
                          .strftime("%Y-%m-%dT%H:%M:%SZ"),
           "kinds": {}}

    def kind(name, fn):
        try:
            inv["kinds"][name] = {"ok": True, "items": fn()}
        except Exception as e:
            inv["kinds"][name] = {"ok": False, "error": "%s: %s"
                                  % (type(e).__name__, str(e)[:300])}

    def run_services():
        # locations/- covers EVERY region. A secret pinned by a service in a
        # region nobody remembered is the same outage as one in us-east1.
        svcs = get_all("%s/projects/%s/locations/-/services?pageSize=100"
                       % (RUN, project), tok, "services")
        items = []
        for s in svcs:
            # EVERY revision, not just latest and not just traffic holders.
            revs = get_all("%s/%s/revisions?pageSize=200" % (RUN, s["name"]),
                           tok, "revisions")
            items.append({"service": s, "revisions": revs})
        return items

    def run_jobs():
        return get_all("%s/projects/%s/locations/-/jobs?pageSize=100"
                       % (RUN, project), tok, "jobs")

    def cloudbuild():
        return get_all("%s/projects/%s/triggers?pageSize=100" % (CB, project),
                       tok, "triggers")

    def cloudscheduler():
        locs = get_all("%s/projects/%s/locations?pageSize=100" % (CS, project),
                       tok, "locations")
        out = []
        for l in locs:
            out.extend(get_all("%s/%s/jobs?pageSize=100" % (CS, l["name"]),
                               tok, "jobs"))
        return out

    def cloudfunctions():
        return get_all("%s/projects/%s/locations/-/functions?pageSize=100"
                       % (CF, project), tok, "functions")

    def source_literals():
        if not source_root:
            raise RuntimeError(
                "no --source-root given, so the source tree could not be "
                "scanned for the secret name as a string literal")
        files = []
        for root, dirs, names in os.walk(source_root):
            dirs[:] = [d for d in dirs
                       if d not in (".git", "node_modules", "dist", "__pycache__")]
            for n in names:
                p = os.path.join(root, n)
                try:
                    if os.path.getsize(p) > 8 * 1024 * 1024:
                        continue
                    with open(p, "r", encoding="utf-8", errors="ignore") as fh:
                        files.append({"path": os.path.relpath(p, source_root),
                                      "text": fh.read()})
                except Exception:
                    continue
        return files

    kind("run_services", run_services)
    kind("run_jobs", run_jobs)
    kind("cloudbuild", cloudbuild)
    kind("cloudscheduler", cloudscheduler)
    kind("cloudfunctions", cloudfunctions)
    kind("source_literals", source_literals)
    return inv


# ------------------------------------------------------------ the code view
# See [SECRET-DESTROY-PREFLIGHT-V2] in the header for why this exists and why
# the ambiguous cases resolve towards refusal.

JS_EXT = frozenset((".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"))
PY_EXT = frozenset((".py", ".pyi"))
DOC_EXT = frozenset((".md", ".markdown", ".rst", ".txt"))

VIEW_CODE, VIEW_PROSE, VIEW_CONSERVATIVE = "code", "prose", "conservative"

_BLANKER = {}


def js_blanker():
    """collect-evidence.py's blank_comments(), IMPORTED from beside this file.

    Not copied. route-audit.mjs's blankComments() has one port already, and that
    port drifted from the original for four days because it was kept in step by
    care alone. A second port would be a third scanner. Returns (fn, DesyncError)
    or (None, reason)."""
    if not _BLANKER:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "collect-evidence.py")
        try:
            spec = importlib.util.spec_from_file_location("_pc_collect_evidence", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _BLANKER["fn"] = mod.blank_comments
            _BLANKER["err"] = mod.BlankerDesync
            _BLANKER["why"] = ""
        except Exception as e:
            _BLANKER["fn"] = None
            _BLANKER["err"] = None
            _BLANKER["why"] = ("could not import blank_comments() from %s (%s: %s)"
                               % (path, type(e).__name__, str(e)[:160]))
    return _BLANKER["fn"], _BLANKER["err"], _BLANKER["why"]


def blank_python_comments(text):
    """Blank every COMMENT token to spaces using the stdlib tokenize module.

    Length is preserved and newlines are never overwritten, so every line number
    below still refers to the real file. STRING LITERALS ARE UNTOUCHED -- naming
    a secret in a Python string is a runtime read and must still be found.
    Raises on anything tokenize cannot lex, which the caller turns into the
    conservative view."""
    starts, off = [], 0
    for line in text.splitlines(keepends=True):
        starts.append(off)
        off += len(line)
    starts.append(off)
    a = list(text)
    for tok in tokenize.generate_tokens(io.StringIO(text).readline):
        if tok.type != tokenize.COMMENT:
            continue
        s = starts[tok.start[0] - 1] + tok.start[1]
        e = starts[tok.end[0] - 1] + tok.end[1]
        for j in range(s, min(e, len(a))):
            if a[j] != "\n":
                a[j] = " "
    out = "".join(a)
    if len(out) != len(text):
        raise RuntimeError("python comment blanking changed the file length")
    return out


def code_view(path, text):
    """(view, mode, why). Matching happens against `view`, never against `text`.

    A PROSE view is the empty string: nothing in a documentation file executes,
    so there is nothing there to reference a secret."""
    ext = os.path.splitext(path or "")[1].lower()
    if ext in DOC_EXT:
        return "", VIEW_PROSE, "documentation -- nothing in it executes"
    if ext in PY_EXT:
        try:
            return blank_python_comments(text), VIEW_CODE, "python comments blanked (tokenize); strings kept"
        except Exception as e:
            return text, VIEW_CONSERVATIVE, ("tokenize could not lex it (%s: %s), so the "
                                             "whole file is treated as code"
                                             % (type(e).__name__, str(e)[:120]))
    if ext in JS_EXT:
        fn, err, why = js_blanker()
        if fn is None:
            return text, VIEW_CONSERVATIVE, why
        try:
            return fn(text), VIEW_CODE, "js/ts comments blanked (collect-evidence.blank_comments)"
        except Exception as e:
            # BlankerDesync is the designed outcome on a file this scanner cannot
            # follow -- including a file with no comments at all, where treating
            # the whole file as code is not merely safe but exactly right.
            return text, VIEW_CONSERVATIVE, ("blank_comments refused (%s: %s), so the "
                                             "whole file is treated as code"
                                             % (type(e).__name__, str(e)[:120]))
    return text, VIEW_CONSERVATIVE, "no reliable comment grammar for this file type"


# ------------------------------------------------------------------ matching

def containers_of(obj):
    """Cloud Run puts containers in three different places depending on whether
    you are holding a Service (template.containers), a flat v2 Revision
    (containers at TOP LEVEL, no template) or a Job (template.template.
    containers). Getting this wrong reads as 'no references found', which is the
    exact way this check would fail silently."""
    out = []
    if not isinstance(obj, dict):
        return out
    if isinstance(obj.get("containers"), list):
        out.extend(obj["containers"])
    t = obj.get("template")
    if isinstance(t, dict):
        out.extend(containers_of(t))
    return out


def volumes_of(obj):
    out = []
    if not isinstance(obj, dict):
        return out
    if isinstance(obj.get("volumes"), list):
        out.extend(obj["volumes"])
    t = obj.get("template")
    if isinstance(t, dict):
        out.extend(volumes_of(t))
    return out


def structural_hits(obj, secret, where):
    """env[].valueSource.secretKeyRef.secret AND volumes[].secret.secret."""
    hits = []
    for c in containers_of(obj):
        for e in (c.get("env") or []):
            skr = ((e.get("valueSource") or {}).get("secretKeyRef") or {})
            if short(skr.get("secret", "")) == secret:
                hits.append({"where": where, "how": "env secretKeyRef",
                             "detail": "env %s -> secret %s (version %s)"
                             % (e.get("name"), secret, skr.get("version", "?"))})
    for v in volumes_of(obj):
        sec = v.get("secret") or {}
        if short(sec.get("secret", "")) == secret:
            hits.append({"where": where, "how": "volume secret mount",
                         "detail": "volume %s -> secret %s" % (v.get("name"), secret)})
    return hits


def textual_hits(obj, secret, where, how):
    """The backstop. Matches the name only on a real boundary so that deleting
    `chat-key` does not appear to be referenced by `chat-key-claude`."""
    try:
        blob = json.dumps(obj)
    except Exception:
        blob = str(obj)
    pat = boundary_pat(secret)
    m = pat.search(blob)
    if not m:
        return []
    s = max(0, m.start() - 70)
    return [{"where": where, "how": how,
             "detail": "raw match: ..." + blob[s:m.end() + 70] + "..."}]


def decide(inv, secret):
    """Returns (exit_code, findings, unknown_kinds, prose_mentions).

    prose_mentions is NOT a refusal. It is what the check deliberately declined
    to count -- printed so that the decision to ignore it is visible rather than
    invisible."""
    findings, unknown, prose = [], [], []
    kinds = inv.get("kinds", {})
    for k in KINDS:
        got = kinds.get(k)
        if not isinstance(got, dict) or not got.get("ok"):
            unknown.append("%s (%s)" % (k, (got or {}).get("error", "not collected")))
            continue
        items = got.get("items") or []

        if k == "run_services":
            for it in items:
                svc = it.get("service") or {}
                sname = (svc.get("name") or "?").split("/")[-1]
                traffic = {}
                for t in (svc.get("traffic") or []):
                    if t.get("revision"):
                        traffic.setdefault(t["revision"], []).append(
                            ("%d%%" % t["percent"]) if t.get("percent") else
                            ("tag:" + t.get("tag", "?")))
                findings += structural_hits(svc, secret, "run service %s (template)" % sname)
                for rev in (it.get("revisions") or []):
                    rn = (rev.get("name") or "?").split("/")[-1]
                    role = ", ".join(traffic.get(rn, [])) or "retained, no traffic and no tag"
                    findings += structural_hits(rev, secret,
                                                "run service %s revision %s [%s]" % (sname, rn, role))
                    findings += textual_hits(rev, secret,
                                             "run service %s revision %s [%s]" % (sname, rn, role),
                                             "raw scan")
        elif k == "run_jobs":
            for j in items:
                jn = (j.get("name") or "?").split("/")[-1]
                findings += structural_hits(j, secret, "run job %s" % jn)
                findings += textual_hits(j, secret, "run job %s" % jn, "raw scan")
        elif k == "source_literals":
            pat = boundary_pat(secret)
            # [SECRET-DESTROY-PREFLIGHT-V3] the same hunt, over the spellings source
            # uses before the lane is expanded. See the header for why PASS was the
            # wrong default here.
            lane_pats = [(sp, sw, boundary_pat(sp)) for sp, sw in lane_spellings(secret)]
            for f in items:
                text = f.get("text", "")
                if not (pat.search(text)
                        or any(lp.search(text) for _, _, lp in lane_pats)):
                    continue                    # cheap reject before any parsing
                path = f.get("path")
                view, mode, why = code_view(path, text)
                hits = [view.count(chr(10), 0, m.start()) + 1 for m in pat.finditer(view)]
                if hits:
                    findings.append({"where": "source %s" % path,
                                     "how": "secret name in source code (%s)" % mode,
                                     "detail": "line(s) %s -- %s"
                                               % (",".join(str(h) for h in hits[:12]), why)})
                elif pat.search(text):
                    prose.append({"where": "source %s" % path, "how": mode,
                                  "detail": "%d mention(s), none in code -- %s"
                                            % (len(pat.findall(text)), why)})
                for sp, sw, lp in lane_pats:
                    lhits = [view.count(chr(10), 0, m.start()) + 1 for m in lp.finditer(view)]
                    if not lhits:
                        continue
                    findings.append({"where": "source %s" % path,
                                     "how": "name BUILT FROM A LANE TEMPLATE in source (%s)" % mode,
                                     "detail": "%s at line(s) %s -- %s; %s"
                                               % (sp, ",".join(str(h) for h in lhits[:12]),
                                                  sw, why)})
        else:
            label = {"cloudbuild": "cloud build trigger",
                     "cloudscheduler": "scheduler job",
                     "cloudfunctions": "cloud function"}[k]
            for it in items:
                nm = (it.get("name") or "?").split("/")[-1]
                findings += structural_hits(it, secret, "%s %s" % (label, nm))
                findings += textual_hits(it, secret, "%s %s" % (label, nm), "raw scan")

    # De-duplicate: the structural and textual scans agree on purpose.
    seen, uniq = set(), []
    for f in findings:
        key = (f["where"], f["how"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(f)

    if uniq:
        return REFUSE_REFERENCED, uniq, unknown, prose
    if unknown:
        return REFUSE_UNKNOWN, uniq, unknown, prose
    return PASS, uniq, unknown, prose


# ------------------------------------------------------------------ entrypoint

def main(argv):
    args, opts = [], {}
    i = 1
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            if "=" in a:
                k, v = a[2:].split("=", 1)
            else:
                k, v = a[2:], (argv[i + 1] if i + 1 < len(argv) else "")
                i += 1
            opts[k] = v
        else:
            args.append(a)
        i += 1

    if len(args) != 1:
        sys.stderr.write(
            "usage: secret-destroy-preflight.py <secret-name> --project P\n"
            "       [--source-root DIR] [--inventory FILE] [--capture FILE]\n")
        return REFUSE_ERROR

    secret = short(args[0])
    project = opts.get("project") or os.environ.get("PC_PROJECT", "")

    try:
        if opts.get("inventory"):
            with open(opts["inventory"]) as fh:
                inv = json.load(fh)
        else:
            if not project:
                sys.stderr.write("REFUSE: --project is required for a live run\n")
                return REFUSE_ERROR
            tok = access_token()
            inv = collect(project, tok, opts.get("source-root"))
            if opts.get("capture"):
                with open(opts["capture"], "w") as fh:
                    json.dump(inv, fh)
        code, findings, unknown, prose = decide(inv, secret)
    except Exception as e:
        # An unhandled error is a REFUSAL, never a pass.
        sys.stderr.write("REFUSE: the preflight itself failed (%s: %s). "
                         "Could-not-check is not a pass.\n" % (type(e).__name__, str(e)[:400]))
        return REFUSE_ERROR

    print("SECRET-DESTROY-PREFLIGHT-V1  secret=%s  project=%s  captured=%s"
          % (secret, inv.get("project", "?"), inv.get("captured_at", "?")))
    _lsp = lane_spellings(secret)
    print("  source is hunted for the expanded name AND for %d lane-template spelling(s), "
          "e.g. %s" % (len(_lsp), ", ".join(sp for sp, _ in _lsp[:3]) or "(none derivable)"))
    for k in KINDS:
        g = (inv.get("kinds") or {}).get(k) or {}
        print("  kind %-16s %s" % (k, "ENUMERATED (%d)" % len(g.get("items") or [])
                                   if g.get("ok") else "UNREACHABLE"))
    if findings:
        print("\nREFERENCED BY %d PLACE(S):" % len(findings))
        for f in findings[:60]:
            print("  - %s | %s | %s" % (f["where"], f["how"], f["detail"][:160]))
        if len(findings) > 60:
            print("  ... and %d more" % (len(findings) - 60))
    if prose:
        print("\nMENTIONED IN PROSE, NOT COUNTED (%d) -- read them, then decide:" % len(prose))
        for p in prose[:60]:
            print("  - %s | %s | %s" % (p["where"], p["how"], p["detail"][:160]))
        if len(prose) > 60:
            print("  ... and %d more" % (len(prose) - 60))
    if unknown:
        print("\nCOULD NOT ENUMERATE:")
        for u in unknown:
            print("  - %s" % u)

    if code == REFUSE_REFERENCED:
        print("\nVERDICT: REFUSE -- this secret is REFERENCED. Deleting it aborts the "
              "next COLD START of every consumer above, whether or not any code reads "
              "the variable. Remove the reference FIRST, re-run this, then delete.")
    elif code == REFUSE_UNKNOWN:
        print("\nVERDICT: REFUSE -- UNKNOWN. No reference was found in what could be "
              "enumerated, but a consumer kind could not be reached, so 'no reference' "
              "has not been established. Unknown is not clean.")
    elif code == PASS:
        print("\nVERDICT: PASS -- every consumer kind was enumerated and none references "
              "this secret. It is deletable.")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
