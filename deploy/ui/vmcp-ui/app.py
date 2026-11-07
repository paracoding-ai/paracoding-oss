# SPDX-License-Identifier: Apache-2.0
"""
vmcp-ui -- the UI front. A router (reverse proxy) to the VM harness, protected by IAP.

Model (matches the fleet "two small Cloud Run routers" design):
  - VM UP     -> proxy every request straight to the harness on the VM (:8090), and
                 /gitlab* to GitLab (:80). SSE-safe streaming. The box serves everything.
  - VM DOWN   -> serve a small status/start page with a Start button. Click start -> the
                 VM boots -> the page polls and reloads -> the harness opens ("flowhood opens").
  - No allUsers, no public IP: IAP authenticates the human before Cloud Run is reached; the
    box additionally verifies the IAP assertion (PC_IAP_AUD). The VM is off at night -> cheap,
    and can't be attacked while it's off.
  - Picket edge sensor inline (detection-only), same pinned signatures as the MCP front.

Env: GCP_PROJECT, VM_ZONE, VM_NAME; HARNESS_UPSTREAM (default http://10.0.0.10:8090);
     GITLAB_UPSTREAM (default http://10.0.0.10:80); PICKET_MODE (detect|enforce);
     PROXY_TIMEOUT_SEC (default 3600); PORT (default 8080).
"""
import os, time, json, logging, collections
import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import StreamingResponse, JSONResponse, HTMLResponse
from starlette.routing import Route
import heuristics  # pinned mirror; see header

log = logging.getLogger("vmcp-ui"); logging.basicConfig(level=logging.INFO)

PROJECT = os.environ.get("GCP_PROJECT", "")
ZONE    = os.environ.get("VM_ZONE", "")
VM      = os.environ.get("VM_NAME", "")
HARNESS = os.environ.get("HARNESS_UPSTREAM", "http://10.0.0.10:8090").rstrip("/")
GITLAB  = os.environ.get("GITLAB_UPSTREAM", "http://10.0.0.10:80").rstrip("/")
MODE    = os.environ.get("PICKET_MODE", "detect")
TIMEOUT = float(os.environ.get("PROXY_TIMEOUT_SEC", "3600"))
META    = "http://metadata.google.internal/computeMetadata/v1"
CAPI    = "https://compute.googleapis.com/compute/v1"

HOP = {"connection","keep-alive","proxy-authenticate","proxy-authorization","te",
       "trailers","transfer-encoding","upgrade","host","content-length"}

_client = httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT, connect=10.0), follow_redirects=False)
_meta_client = httpx.AsyncClient(timeout=15.0)
_tok = {"v": "", "exp": 0.0}
_vm = {"status": "?", "at": 0.0}
_stats = {"requests": 0, "flags": 0, "would_block": 0}


async def gtoken():
    now = time.time()
    if _tok["v"] and now < _tok["exp"]:
        return _tok["v"]
    r = await _meta_client.get(META + "/instance/service-accounts/default/token",
                               headers={"Metadata-Flavor": "Google"})
    j = r.json()
    _tok["v"] = j["access_token"]
    _tok["exp"] = now + int(j.get("expires_in", 3000)) - 60
    return _tok["v"]


async def vm_status(force=False):
    now = time.time()
    if not force and _vm["at"] > now - 5:
        return _vm["status"]
    try:
        t = await gtoken()
        r = await _meta_client.get(
            CAPI + "/projects/" + PROJECT + "/zones/" + ZONE + "/instances/" + VM + "?fields=status",
            headers={"Authorization": "Bearer " + t})
        _vm["status"] = r.json().get("status", "ERR") if r.status_code == 200 else "ERR"
        _vm["at"] = now
    except Exception as e:
        log.warning("vm_status: %s", e)
    return _vm["status"]


async def vm_power(action):
    t = await gtoken()
    await _meta_client.post(
        CAPI + "/projects/" + PROJECT + "/zones/" + ZONE + "/instances/" + VM + "/" + action,
        headers={"Authorization": "Bearer " + t})


def iap_user(req):
    v = req.headers.get("x-goog-authenticated-user-email", "")
    return v.split(":")[-1] if v else ""


# ---- the VM's own routes (never proxied) --------------------------------------------------
async def healthz(req):
    return JSONResponse({"ok": True, "vm": VM})


async def ui_status(req):
    s = await vm_status()
    return JSONResponse({"status": s, "running": s == "RUNNING", "user": iap_user(req)})


async def ui_start(req):
    s = await vm_status(force=True)
    if s in ("RUNNING", "STAGING", "PROVISIONING"):
        return JSONResponse({"started": False, "status": s})
    await vm_power("start")
    return JSONResponse({"started": True, "status": await vm_status(force=True)})


async def ui_stop(req):
    s = await vm_status(force=True)
    if s in ("TERMINATED", "STOPPED", "STOPPING"):
        return JSONResponse({"stopped": False, "status": s})
    await vm_power("stop")
    return JSONResponse({"stopped": True, "status": await vm_status(force=True)})


STATUS_PAGE = """<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>Paracoding — Fleet</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
 background:#0b0f14;color:#e6edf5;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:460px;padding:36px;text-align:center}
h1{font-size:22px;margin:0 0 6px}
p{color:#8498ad;margin:6px 0 22px;font-size:14px}
button{font:600 15px system-ui;padding:12px 26px;border-radius:10px;border:1px solid #1d3b5c;
 background:#123a56;color:#e6edf5;cursor:pointer}
button:hover{background:#17496b} button:disabled{opacity:.5;cursor:default}
.msg{margin-top:16px;font-size:13px;color:#e3b341;min-height:1em}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#e3b341;margin-right:7px;vertical-align:middle}
</style></head><body>
<div class="card">
<h1><span class="dot" id="dot"></span>Fleet VM is <span id="st">stopped</span></h1>
<p>Start it to bring the harness, GitLab and the strains online.</p>
<button id="go">&#9654; Start the VM</button>
<div class="msg" id="msg"></div>
</div>
<script>
var $=function(s){return document.querySelector(s)};
async function poll(){
 try{var r=await fetch('/_ui/status',{cache:'no-store'});var j=await r.json();
  $('#st').textContent=(j.status||'?').toLowerCase();
  if(j.running){$('#msg').textContent='Harness is up — opening…';setTimeout(function(){location.reload()},1500);}
 }catch(e){}
}
$('#go').onclick=async function(){
 var b=$('#go');b.disabled=true;$('#msg').textContent='Starting… this takes about a minute.';
 try{await fetch('/_ui/start',{method:'POST'});}catch(e){}
 if(!window._iv)window._iv=setInterval(poll,4000);poll();
};
poll(); if(!window._iv)window._iv=setInterval(poll,6000);
</script></body></html>"""


async def router(req: Request):
    _stats["requests"] += 1
    _p = req.url.path
    if _p == "/__pktstate" or _p.startswith("/__pktstate/") or _p == "/__picket" or _p.startswith("/__picket/"):
        return JSONResponse({"error": "not found"}, status_code=404)  # internal edge/CP APIs, never proxied externally
    s = await vm_status()
    if s != "RUNNING":
        return HTMLResponse(STATUS_PAGE)

    path = req.url.path
    base = GITLAB if (path == "/gitlab" or path.startswith("/gitlab/")) else HARNESS
    body = await req.body()

    if body:
        try:
            hits = heuristics.scan(body.decode("utf-8", "ignore"))
        except Exception:
            hits = []
        if hits:
            _stats["flags"] += 1
            if heuristics.worst(hits) >= 3:
                _stats["would_block"] += 1
                log.info(json.dumps({"ev": "picket", "sev": "critical",
                                     "rules": [h["rule"] for h in hits], "path": path, "mode": MODE}))

    url = base + path + (("?" + req.url.query) if req.url.query else "")
    # [VMCP-UI-MULTIHEADER-V1] a list, not a dict: a dict keeps one value per header name.
    fwd = [(k, v) for k, v in req.headers.items() if k.lower() not in HOP and k.lower() != "cookie"]  # keeps x-goog-* for PC_IAP_AUD
    _ck = [v for k, v in req.headers.items() if k.lower() == "cookie"]
    if _ck:
        fwd.append(("cookie", "; ".join(_ck)))  # HTTP/2 may split Cookie into crumbs; rejoin per RFC 9113 8.2.3
    fwd.append(("host", req.headers.get("host", "")))  # preserve original Host (the LB did) so the box serves the right surface
    try:
        up = _client.build_request(req.method, url, headers=fwd, content=body if body else None)
        rr = await _client.send(up, stream=True)
    except Exception as e:
        log.info("harness not ready (%s) -> status page", e)
        return HTMLResponse(STATUS_PAGE)

    # [VMCP-UI-MULTIHEADER-V1] Copy upstream headers from the RAW list. The old dict comprehension over
    # httpx headers.items() comma-joined repeated headers, so GitLab's two Set-Cookie lines reached the
    # browser as ONE unparseable header: _gitlab_session was never stored and every OmniAuth click failed
    # with "Can't verify csrf token authenticity". Set-Cookie must never be folded (RFC 6265 3).
    async def gen():
        try:
            async for chunk in rr.aiter_raw():
                yield chunk
        finally:
            await rr.aclose()

    resp = StreamingResponse(gen(), status_code=rr.status_code)
    resp.raw_headers = [(k.lower(), v) for k, v in rr.headers.raw
                        if k.decode("latin-1").lower() not in HOP]
    return resp


_methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]
app = Starlette(routes=[
    Route("/healthz", healthz),
    Route("/_ui/status", ui_status),
    Route("/_ui/start", ui_start, methods=["POST", "GET"]),
    Route("/_ui/stop", ui_stop, methods=["POST"]),
    Route("/", router, methods=_methods),
    Route("/{path:path}", router, methods=_methods),
])
