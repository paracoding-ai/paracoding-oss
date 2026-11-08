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
# This used to be   BIND_HOST = os.environ.get('CDP_BRIDGE_HOST', '0.0.0.0')
# and that default was the whole bug. 0.0.0.0 publishes :8025 on EVERY interface:
# the VPC NIC (which is the one the control plane actually reaches, so this
# cannot be 127.0.0.1 either), loopback -- reachable by any local process,
# INCLUDING a page rendered in the very Chrome this bridge drives, which is the
# machine a hostile page is already running on -- and docker0, reachable by every
# container on the box, because linux-startup.sh installs docker-ce.
#
# So: resolve nic0's internal address from the metadata server at start-up and
# bind THAT ONE ADDRESS. Nothing is hardcoded, and there is no env override,
# because an override is just a slower way to get 0.0.0.0 back.
#
# If it cannot be resolved we EXIT NON-ZERO. We do not fall back. systemd's
# Restart=always retries, and a bridge that is down is strictly better than a
# bridge that is open: no listener beats a wide listener.
#
# This is the same resolution WP2 [WP2-NETBIND-V1] performs for ops-exec on
# :8022. It lives HERE for the bridge because this file replaces the bridge body
# in linux-startup.sh wholesale, so a patcher-side edit of the old body would be
# overwritten -- which is exactly how the 0.0.0.0 bind came back.
_MD_IP_URL = ('http://metadata.google.internal/computeMetadata/v1/'
              'instance/network-interfaces/0/ip')


def _md_nic0_ip():
    req = urllib.request.Request(_MD_IP_URL, headers={'Metadata-Flavor': 'Google'})
    return urllib.request.urlopen(req, timeout=5).read().decode().strip()


def resolve_bind(fetch=None, attempts=30, delay=2.0, sleep=None):
    """Return this VM's primary internal address, or exit non-zero trying.

    ~30 attempts, 2s apart: the metadata server can lag the first seconds of
    boot, and systemd starts us on network-online.target which is not a promise
    that DHCP has settled. It NEVER returns a wildcard address and it NEVER
    returns a fallback -- the only two outcomes are a real nic0 address or
    SystemExit(1).
    """
    fetch = fetch or _md_nic0_ip
    sleep = sleep or time.sleep
    last = ''
    for _ in range(attempts):
        try:
            ip = fetch()
            socket.inet_aton(ip)
            if ip in ('0.0.0.0', ''):
                raise ValueError('metadata returned a wildcard address')
            return ip
        except Exception as e:
            last = type(e).__name__ + ': ' + str(e)[:120]
            sleep(delay)
    sys.stderr.write(
        'cdp-bridge: could not resolve this instance\'s nic0 internal address from '
        'the metadata server after %d attempts (%s). REFUSING to bind: falling back '
        'to 0.0.0.0 would publish the DevTools bridge on loopback and docker0. '
        'Exiting non-zero; systemd will retry.\n' % (attempts, last))
    raise SystemExit(1)


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

# [CDP-INPUT-OPTIN-V1] browser_click/browser_type/browser_key need these three. They are NOT in
# METHOD_ALLOW: they are admitted per request only when the policy file says allow_input: true,
# and they are origin-checked like every other page-touching method.
INPUT_METHODS = (
    'Input.dispatchMouseEvent',
    'Input.dispatchKeyEvent',
    'Input.insertText',
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
    # [CDP-OPEN-DEFAULT-V1] OPEN BY DEFAULT, LOCKDOWN BY CHOICE (operator decision 2026-11-08).
    # This drives the operator's own desktop Chrome, so every site is drivable out of the box:
    # origin_allow ["*"] means any host, origin_deny is empty, and click/type/key work.
    # To lock it down, write /opt/cdp-policy.json with an explicit origin_allow list (exact host
    # or "*.domain"), add hosts to origin_deny (deny always beats allow), and/or set
    # allow_input / allow_http to false. Edits apply on the next request; no restart.
    'origin_allow': ['*'],
    'origin_deny': [],
    # Cap on returned eval/read value size (bulk-read guard); screenshots have their own cap.
    'max_result_bytes': 65536,
    'eval_timeout_ms': 15000,
    # [CDP-INPUT-OPTIN-V1] synthesised input (Input.*). Origin-checked like navigate/eval.
    'allow_input': True,
    # [CDP-SCREENSHOT-CAP-V1] a screenshot is a PNG, not text: it gets its own ceiling.
    'screenshot_max_bytes': 8388608,
    # Plain http:// sites. file://, chrome:// and other non-web schemes are never driven:
    # file:// would let Runtime.evaluate read this VM's disk.
    'allow_http': True,
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
    """Return (ok, reason). Deny beats allow. "*" in origin_allow allows every host;
    an EMPTY allow list denies all (the explicit lockdown)."""
    o = origin_of(url)
    if not o:
        return (False, 'unparseable or non-http url')
    if not (o.startswith('https://') or (o.startswith('http://') and policy.get('allow_http') is True)):
        # file://, chrome:// and every other non-web scheme are always out: file:// in
        # particular would let Runtime.evaluate read this VM's disk via fetch(). Plain http://
        # is allowed unless the policy sets allow_http false.
        return (False, 'only web origins may be driven' + ('' if policy.get('allow_http') is True else ' (http:// is off: allow_http false)'))
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
        if a == '*' or host == a:
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

        allowed = METHOD_ALLOW + (INPUT_METHODS if policy.get('allow_input') is True else ())
        if method not in allowed:
            hint = ('set "allow_input": true in ' + POLICY_PATH + ' to permit synthesised input'
                    if method in INPUT_METHODS else '')
            return self._s(403, {'ok': False, 'error': 'method not allowed',
                                 'method': method, 'allowed': list(allowed), 'hint': hint})

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
            # [CDP-CLOSE-PUT-V1] current Chrome expects PUT on the /json/* endpoints (createTarget
            # already uses PUT for /json/new); GET is kept only as a fallback for older builds.
            try:
                try:
                    chrome_put('/json/close/' + urllib.parse.quote(tid, safe=''))
                except Exception:
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
        if method in ORIGIN_CHECKED or method in INPUT_METHODS:
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

        if method == 'Page.captureScreenshot':
            cap = int(policy.get('screenshot_max_bytes') or 8388608)
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
    addr = resolve_bind()
    sys.stderr.write('cdp-bridge: binding %s:%d (nic0, from the metadata server)\n'
                     % (addr, BIND_PORT))
    HTTPServer((addr, BIND_PORT), H).serve_forever()


def selftest():
    fails = []

    def chk(name, cond):
        if not cond:
            fails.append(name)

    p = dict(DEFAULT_POLICY)
    p['origin_allow'] = ['example.com', '*.corp.example']
    p['allow_http'] = False

    chk('default allows any https site', origin_permitted('https://x.test/', DEFAULT_POLICY)[0] is True)
    chk('default allows http', origin_permitted('http://x.test/', DEFAULT_POLICY)[0] is True)
    chk('default still refuses file://', origin_permitted('file:///etc/passwd', DEFAULT_POLICY)[0] is False)
    chk('explicit empty allow denies (lockdown)', origin_permitted('https://x.test/', dict(DEFAULT_POLICY, origin_allow=[]))[0] is False)
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
    p2['origin_deny'] = ['accounts.google.com', 'github.com/settings']  # an operator's lockdown list
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

    # ---- bind. This block used to read
    #        chk('bind default documented',
    #            BIND_HOST in ('0.0.0.0', os.environ.get('CDP_BRIDGE_HOST', '')))
    #      which ASSERTED THE BUG: it passed precisely because the default bind
    #      was 0.0.0.0. A green self-test that certifies the defect is worse than
    #      no self-test. These assert the fixed behaviour instead.
    noop = lambda _d: None
    chk('resolve_bind returns the nic0 address',
        resolve_bind(fetch=lambda: '10.142.0.7', attempts=1, sleep=noop) == '10.142.0.7')

    tries = []

    def boom():
        tries.append(1)
        raise IOError('metadata server unreachable')

    try:
        resolve_bind(fetch=boom, sleep=noop)
        chk('unresolvable address exits', False)
    except SystemExit as e:
        chk('unresolvable address exits NON-ZERO', e.code == 1)
    chk('retries 30 times before giving up', len(tries) == 30)
    chk('retry delay is 2s', resolve_bind.__defaults__[2] == 2.0)

    try:
        resolve_bind(fetch=lambda: '0.0.0.0', attempts=2, sleep=noop)
        chk('a wildcard from metadata is refused', False)
    except SystemExit as e:
        chk('a wildcard from metadata is refused, non-zero', e.code == 1)

    chk('no 0.0.0.0 in any default argument of the bind path',
        not any(str(d) == '0.0.0.0' for d in (resolve_bind.__defaults__ or ())))
    chk('no BIND_HOST global survives', 'BIND_HOST' not in globals())
    # The env override is gone, so setting it must change nothing. Prove it.
    _saved = os.environ.get('CDP_BRIDGE_HOST')
    os.environ['CDP_BRIDGE_HOST'] = '0.0.0.0'
    try:
        chk('CDP_BRIDGE_HOST cannot reintroduce a wildcard bind',
            resolve_bind(fetch=lambda: '10.142.0.7', attempts=1, sleep=noop)
            == '10.142.0.7')
    finally:
        if _saved is None:
            os.environ.pop('CDP_BRIDGE_HOST', None)
        else:
            os.environ['CDP_BRIDGE_HOST'] = _saved

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
                     'bind resolved from the metadata server, no 0.0.0.0 fallback)\n')
    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
