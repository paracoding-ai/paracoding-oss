# SPDX-License-Identifier: Apache-2.0
"""
vmcp-mcp -- the MCP edge front. A streaming reverse proxy in front of the MCP server on
the VM (control-plane :8090) carrying the Picket edge sensor inline.

Picket v2 (auth-aware auto-ban; the post-LB rebuild of the old fleet-recidive/Cloud-Armor
fail2ban):
  - Transparent proxy: forwards every method/path/header/body to MCP_UPSTREAM and streams
    the response (SSE-safe). The MCP server on the box keeps doing the real auth.
  - Content signatures (heuristics.py) are ALERT-ONLY: scanned and logged/counted, never a
    ban trigger. They fire on legitimate tool traffic (e.g. pi.tool_coercion on any call
    naming gcloud/run_command), so they must never gate the path.
  - Auto-ban keys on SCANNER BEHAVIOUR, not content. A request the box REJECTED
    (401/403/404) earns tracking ONLY if the client is not allow-listed:
      * probe-path rejections (/.env, /.git, /admin, ...) feed a strike stream;
      * every rejected path feeds a distinct-rejected-path counter (path-scan fingerprint).
    STRIKES probe hits OR PATHSCAN_DISTINCT distinct rejected paths in WINDOW -> ban.
    A legit client hammering ONE real path (even if transiently 401'd) trips neither, and
    any authenticated (2xx/3xx) response never accrues anything -> the live connector /
    operator lifeline cannot be banned, by construction.
  - Ban for BAN_TTL; repeat offenders (>= PERMANENT_AFTER bans) -> permanent. Enforcement
    (PICKET_MODE=enforce) blocks ONLY already-banned clients (429/403 pre-forward). detect
    mode never blocks.

Env:
  MCP_UPSTREAM            VM MCP base url (default http://10.0.0.10:8090)
  PICKET_MODE             detect | enforce                   (default detect)
  PICKET_STRIKES          probe-path strikes -> ban           (default 5)
  PICKET_WINDOW_SEC       strike window                       (default 600)
  PICKET_BAN_TTL_SEC      ban duration                        (default 900)
  PICKET_PERMANENT_AFTER  repeat bans -> permanent            (default 3)
  PICKET_PATHSCAN_DISTINCT distinct rejected paths -> ban     (default 8)
  PICKET_ALLOW            extra never-ban CIDRs/IPs, comma    (default "")
  PICKET_PROBE_EXTRA      extra probe path substrings, comma  (default "")
  PICKET_SCAN_BODY        scan body for alert signatures 1|0  (default 1)
  PROXY_TIMEOUT_SEC       upstream timeout                    (default 3600)
  PORT                    listen port                         (default 8080)
"""
import os, time, json, logging, collections, ipaddress, asyncio
import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import StreamingResponse, JSONResponse
from starlette.routing import Route

log = logging.getLogger("vmcp-mcp")
logging.basicConfig(level=logging.INFO)

UPSTREAM   = os.environ.get("MCP_UPSTREAM", "http://10.0.0.10:8090").rstrip("/")
MODE       = os.environ.get("PICKET_MODE", "detect")
STRIKES    = int(os.environ.get("PICKET_STRIKES", "5"))
WINDOW     = int(os.environ.get("PICKET_WINDOW_SEC", "600"))
BAN_TTL    = int(os.environ.get("PICKET_BAN_TTL_SEC", "900"))
PERM_AFTER = int(os.environ.get("PICKET_PERMANENT_AFTER", "3"))
PATHSCAN_N = int(os.environ.get("PICKET_PATHSCAN_DISTINCT", "8"))
SCAN_BODY  = os.environ.get("PICKET_SCAN_BODY", "1") == "1"
TIMEOUT    = float(os.environ.get("PROXY_TIMEOUT_SEC", "3600"))
PIN        = "paracoding-security@2d4ff3db"
PERMANENT  = 4102444800.0
# Trailing XFF hops the infra (GFE) appends; the real client is that many from the right.
# Cloud Run direct ingress appends the true client IP last, so 0 = take rightmost (spoof-proof:
# any client-supplied XFF lands to the LEFT of the GFE-appended value). Tunable without code.
XFF_TRUST  = int(os.environ.get("PICKET_XFF_TRUST", "0"))
# Shared+persistent ban state lives on the control plane (picket.bans in Postgres), reached at
# STATE_BASE/__pktstate/*. The edge polls the banlist into a cache and reports its ban decisions,
# so a ban applies across ALL edge instances and survives edge restarts. If the state service is
# unreachable the edge silently falls back to its own in-memory bans (no lifeline impact).
STATE_ON      = os.environ.get("PICKET_STATE", "on") == "on"
STATE_BASE    = (os.environ.get("PICKET_STATE_URL", "") or UPSTREAM).rstrip("/")
STATE_REFRESH = int(os.environ.get("PICKET_STATE_REFRESH_SEC", "20"))

import heuristics

# never-ban: loopback + RFC1918 + GCP internal + "this network" 0.0.0.0/8 (the MCP connector's
# own lifeline requests arrive as 0.0.0.0) + operator-configured.
_ALLOW_NETS = [ipaddress.ip_network(c) for c in
               ["0.0.0.0/8", "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
                "::1/128", "::/128", "fd00::/8"]]
for _c in (os.environ.get("PICKET_ALLOW", "") or "").split(","):
    _c = _c.strip()
    if _c:
        try: _ALLOW_NETS.append(ipaddress.ip_network(_c, strict=False))
        except Exception: log.warning("bad PICKET_ALLOW entry: %s", _c)

_PROBES = ["/.env", "/.git", "/.aws", "/.ssh", "/wp-", "/wp-login", "/xmlrpc.php",
           "/phpmyadmin", "/pma", "/adminer", "/.well-known/security", "/actuator",
           "/server-status", "/vendor/", "/config.json", "/config.php", "/.vscode",
           "/.ds_store", "/backup", "/dump.sql", "/.htaccess", "/boaform", "/cgi-bin/",
           "/solr/", "/struts", "/jenkins", "/manager/html"]
for _p in (os.environ.get("PICKET_PROBE_EXTRA", "") or "").split(","):
    _p = _p.strip()
    if _p: _PROBES.append(_p.lower())

HOP = {"connection","keep-alive","proxy-authenticate","proxy-authorization","te",
       "trailers","transfer-encoding","upgrade","host","content-length"}

_started = time.time()
_stats = {"requests": 0, "flags": 0, "sig_critical": 0, "strikes": 0,
          "bans": 0, "permabans": 0, "blocked": 0, "banned_hits": 0}
_probe_hits = collections.defaultdict(list)
_seen_paths = collections.defaultdict(dict)
_bans = {}                                    # local per-instance (fast path + fallback)
_shared_bans = {}                             # cid -> until, polled from the control plane (shared)
_poll_started = False                         # lazy-start guard for the banlist poller
_ban_count = collections.defaultdict(int)
_client = httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT, connect=10.0), follow_redirects=False)


def _cid(req):
    # Spoof-resistant: trust ONLY the GFE-appended value from the right. A client can prepend
    # arbitrary X-Forwarded-For entries, but they land left of the IP the front end appends, so
    # the rightmost (minus XFF_TRUST infra hops) is the one value the client cannot forge.
    xff = req.headers.get("x-forwarded-for", "")
    parts = [p.strip() for p in xff.split(",") if p.strip()] if xff else []
    if parts:
        idx = len(parts) - 1 - XFF_TRUST
        if idx < 0:
            idx = 0
        return parts[idx]
    return req.client.host if req.client else "?"


def _allowlisted(cid):
    try:
        ip = ipaddress.ip_address(cid)
    except ValueError:
        return False
    return any(ip in n for n in _ALLOW_NETS)


def _is_probe(path):
    p = (path or "").lower()
    return any(tok in p for tok in _PROBES)


def _banned_until(cid):
    now = time.time()
    vals = []
    u = _bans.get(cid)
    if u and (u == PERMANENT or u > now):
        vals.append(u)
    elif u:
        _bans.pop(cid, None)
    s = _shared_bans.get(cid)
    if s and (s == PERMANENT or s > now):
        vals.append(s)
    if not vals:
        return 0
    return PERMANENT if PERMANENT in vals else max(vals)


def _ban(cid, now):
    _ban_count[cid] += 1
    if _ban_count[cid] >= PERM_AFTER:
        _bans[cid] = PERMANENT
        _stats["permabans"] += 1
        perm = True
    else:
        _bans[cid] = now + BAN_TTL
        perm = False
    _stats["bans"] += 1
    log.info(json.dumps({"ev": "picket.ban", "cid": cid, "permanent": perm,
                         "count": _ban_count[cid], "mode": MODE}))


def _record_scanner_event(cid, path, now):
    if _allowlisted(cid):
        return False
    sp = {pp: t for pp, t in _seen_paths[cid].items() if t > now - WINDOW}
    sp[path] = now
    _seen_paths[cid] = sp
    xs = [t for t in _probe_hits[cid] if t > now - WINDOW]
    if _is_probe(path):
        xs.append(now)
        _probe_hits[cid] = xs
        _stats["strikes"] += 1
    if len(xs) >= STRIKES or len(sp) >= PATHSCAN_N:
        _ban(cid, now)
        return True
    return False


async def _report_ban(cid):
    try:
        await _client.post(STATE_BASE + "/__pktstate/ban", json={"cid": cid, "reason": "picket-edge"}, timeout=10.0)
    except Exception:
        pass


async def _poll_bans():
    while True:
        try:
            r = await _client.get(STATE_BASE + "/__pktstate/bans", timeout=10.0)
            if r.status_code == 200:
                nb = {}
                for b in (r.json().get("bans") or []):
                    c = b.get("cid")
                    if not c:
                        continue
                    nb[c] = PERMANENT if b.get("permanent") else float(b.get("until") or 0)
                _shared_bans.clear()
                _shared_bans.update(nb)
        except Exception:
            pass  # keep last cache; in-memory bans remain the fallback
        await asyncio.sleep(STATE_REFRESH)


async def whoami(req):
    # Ops aid: shows the raw XFF chain and which entry Picket keys on (for tuning XFF_TRUST
    # and diagnosing bans). No upstream call; reveals nothing the caller didn't send.
    xff = req.headers.get("x-forwarded-for", "")
    parts = [p.strip() for p in xff.split(",") if p.strip()] if xff else []
    cid = _cid(req)
    return JSONResponse({"xff": xff, "parts": parts, "xff_trust": XFF_TRUST,
                         "client_host": req.client.host if req.client else None,
                         "chosen_cid": cid, "allowlisted": _allowlisted(cid)})


async def health(req):
    return JSONResponse({"ok": True, "mode": MODE, "upstream": UPSTREAM, "pinned": PIN})


async def stats(req):
    now = time.time()
    return JSONResponse({**_stats, "since": _started, "mode": MODE,
                         "active_bans": sum(1 for u in _bans.values() if u == PERMANENT or u > now),
                         "permanent": sum(1 for u in _bans.values() if u == PERMANENT)})


async def bans(req):
    now = time.time()
    out = [{"cid": c, "until": ("permanent" if u == PERMANENT else int(u)),
            "count": _ban_count.get(c, 0)}
           for c, u in _bans.items() if u == PERMANENT or u > now]
    return JSONResponse({"bans": out, "count": len(out)})


async def proxy(req: Request):
    global _poll_started
    if STATE_ON and not _poll_started:
        _poll_started = True
        try:
            asyncio.create_task(_poll_bans())
        except RuntimeError:
            _poll_started = False
    _stats["requests"] += 1
    cid = _cid(req)
    now = time.time()

    bu = _banned_until(cid)
    if bu:
        _stats["banned_hits"] += 1
        if MODE == "enforce":
            _stats["blocked"] += 1
            if bu == PERMANENT:
                return JSONResponse({"error": "banned by picket edge"}, status_code=403)
            return JSONResponse({"error": "rate-limited by picket edge"}, status_code=429,
                                headers={"Retry-After": str(max(1, int(bu - now)))})

    body = await req.body()

    if SCAN_BODY and body:
        try:
            hits = heuristics.scan(body.decode("utf-8", "ignore"))
        except Exception:
            hits = []
        if hits:
            _stats["flags"] += 1
            sev = heuristics.worst(hits)
            if sev >= 3:
                _stats["sig_critical"] += 1
            log.info(json.dumps({"ev": "picket.flag", "sev": sev, "cid": cid,
                                 "rules": [h["rule"] for h in hits], "path": req.url.path}))

    url = UPSTREAM + req.url.path + (("?" + req.url.query) if req.url.query else "")
    fwd = {k: v for k, v in req.headers.items() if k.lower() not in HOP}
    fwd["host"] = req.headers.get("host", "")
    up = _client.build_request(req.method, url, headers=fwd, content=body if body else None)
    try:
        rr = await _client.send(up, stream=True)
    except Exception as e:
        log.warning("upstream error: %s", e)
        return JSONResponse({"error": "mcp upstream unreachable"}, status_code=502)

    if rr.status_code in (401, 403, 404):
        if _record_scanner_event(cid, req.url.path, now) and STATE_ON:
            asyncio.create_task(_report_ban(cid))

    out_headers = {k: v for k, v in rr.headers.items() if k.lower() not in HOP}

    async def body_stream():
        try:
            async for chunk in rr.aiter_raw():
                yield chunk
        finally:
            await rr.aclose()

    return StreamingResponse(body_stream(), status_code=rr.status_code, headers=out_headers,
                             media_type=rr.headers.get("content-type"))


async def pktstate_guard(req):
    # /__pktstate/* is the control plane's INTERNAL ban-state API, reached by this edge directly
    # over the private VPC. It must never be proxied from the public internet, so refuse it here.
    return JSONResponse({"error": "not found"}, status_code=404)


_methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]
app = Starlette(routes=[
    Route("/__picket/health", health),
    Route("/__picket/whoami", whoami),
    Route("/__picket/stats", stats),
    Route("/__picket/bans", bans),
    Route("/__pktstate", pktstate_guard, methods=_methods),
    Route("/__pktstate/{path:path}", pktstate_guard, methods=_methods),
    Route("/", proxy, methods=_methods),
    Route("/{path:path}", proxy, methods=_methods),
])
