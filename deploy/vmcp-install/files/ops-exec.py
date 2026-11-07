#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Paracoding ops-exec [OPS-EXEC-DAEMON-V2]: the loopback-only, token-gated root shell behind the
# control plane's vmcp_sudo tool (control-plane/src/mods/ops-exec.ts). Installed at /opt/ops-exec.py
# by install/vm-firstboot.sh, run as root by systemd/ops-exec.service.
#
# Protocol (unchanged from the original daemon, so the existing client works as is):
#   POST /   header X-Ops-Token: <contents of /opt/pc-ops-token>, body = a bash script
#            -> 200 {"exit": N, "stdout": "...", "stderr": "..."}   (exit 504 + "timeout" on timeout)
#            -> 403 "forbidden" when the token is missing, wrong, or the token file is empty
#   GET  /   -> 200 "ok" (health; no token needed, runs nothing)
#
# What changed from the 21-line original:
#   * ThreadingHTTPServer instead of HTTPServer. The original served ONE request at a time, so a
#     single long command blocked every other caller until it finished or hit the 900 s timeout
#     (production hung for 30+ minutes on 2026-11-03 this way).
#   * The token is compared in constant time (hmac.compare_digest).
#   * On timeout the whole process group is killed, not only the top-level bash, so a hung
#     grandchild cannot keep the request (and its thread) alive.
#   * The request body is size-capped and a bad Content-Length is a 400, not a crash.
#   * One log line per request (method, status, size, seconds) goes to the journal. The command
#     text is never logged: vmcp_sudo bodies can carry secrets.
import hmac
import http.server
import json
import os
import signal
import subprocess
import sys
import time

HOST = "127.0.0.1"  # loopback only; never make this configurable
PORT = int(os.environ.get("OPS_EXEC_PORT", "8022"))
TOKEN_FILE = os.environ.get("OPS_TOKEN_FILE", "/opt/pc-ops-token")
TIMEOUT = int(os.environ.get("OPS_EXEC_TIMEOUT", "900"))
MAX_BODY = 4 * 1024 * 1024
OUT_CAP, ERR_CAP = 300000, 80000


def _token():
    # Read on every request so a rotated token takes effect without a restart.
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def _run(script):
    try:
        p = subprocess.Popen(["/bin/bash", "-c", script], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True)
    except Exception as e:
        return {"exit": 500, "stdout": "", "stderr": "ops-exec could not start bash: %s" % e}
    try:
        so, se = p.communicate(timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except Exception:
            pass
        try:
            p.communicate(timeout=10)
        except Exception:
            pass
        return {"exit": 504, "stdout": "", "stderr": "timeout"}
    return {"exit": p.returncode,
            "stdout": so.decode("utf-8", "replace")[-OUT_CAP:],
            "stderr": se.decode("utf-8", "replace")[-ERR_CAP:]}


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "ops-exec/2"
    sys_version = ""

    def _send(self, code, body, ctype="text/plain; charset=utf-8"):
        b = body if isinstance(body, bytes) else body.encode("utf-8")
        self._code = code
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        t0 = time.time()
        want = _token()
        got = self.headers.get("X-Ops-Token", "")
        if not want or not hmac.compare_digest(got.encode("utf-8", "replace"), want.encode("utf-8")):
            self._send(403, "forbidden")
            return self._log(t0, 0)
        try:
            n = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self._send(400, "bad content-length")
            return self._log(t0, 0)
        if n < 0 or n > MAX_BODY:
            self._send(413, "body too large")
            return self._log(t0, 0)
        script = self.rfile.read(n).decode("utf-8", "replace")
        out = _run(script)
        self._send(200, json.dumps(out), "application/json")
        self._log(t0, n, out.get("exit"))

    def do_GET(self):
        self._send(200, "ok")

    def _log(self, t0, n, rc=None):
        sys.stderr.write("ops-exec %s %s body=%dB exit=%s %.1fs\n"
                         % (self.command, getattr(self, "_code", "?"), n, rc, time.time() - t0))
        sys.stderr.flush()

    def log_message(self, *a):
        pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    Server((HOST, PORT), Handler).serve_forever()
